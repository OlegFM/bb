import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { posix as posixPath, win32 as win32Path } from "node:path";
import { promisify } from "node:util";
import { resolveExecutable, resolveSpawnPlan } from "@bb/process-utils";
import { z } from "zod";
import type {
  ProviderInstallationCommand,
  ProviderInstallationSource,
  ProviderInstallationStatus,
  ProviderInstallationVerification,
} from "../provider-maintenance.js";

const execFileAsync = promisify(execFile);

const CLI_PROBE_TIMEOUT_MS = 5_000;
const INSTALLATION_CHECK_TIMEOUT_MS = 15_000;

export interface KitPlatformOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

async function windowsSpawnPlan(
  command: string,
  args: readonly string[],
  options: KitPlatformOptions,
) {
  return resolveSpawnPlan({
    command,
    args,
    env: options.env ?? process.env,
    platform: "win32",
  });
}

function windowsExecEnv(
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  return env === undefined ? undefined : { ...process.env, ...env };
}

export async function resolveExecutablePath(
  command: string,
  options: KitPlatformOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    return resolveExecutable({ command, env, platform });
  }
  if (posixPath.isAbsolute(command)) {
    try {
      await access(command, fsConstants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("which", [command], {
      timeout: CLI_PROBE_TIMEOUT_MS,
      env: options.env,
    });
    return (
      stdout
        .split(/\r?\n/u)
        .find((line) => line.trim())
        ?.trim() ?? null
    );
  } catch {
    return null;
  }
}

export async function commandOutput(
  command: string,
  args: readonly string[],
  options: KitPlatformOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    try {
      const { stdout, stderr } = await execFileAsync(command, [...args], {
        timeout: INSTALLATION_CHECK_TIMEOUT_MS,
        env: options.env,
      });
      return `${stdout}\n${stderr}`.trim();
    } catch {
      return null;
    }
  }
  const plan = await windowsSpawnPlan(command, args, options);
  if (plan === null) {
    return null;
  }
  try {
    const { stdout, stderr } = await execFileAsync(plan.command, plan.args, {
      timeout: INSTALLATION_CHECK_TIMEOUT_MS,
      windowsHide: true,
      env: windowsExecEnv(options.env),
    });
    return `${stdout}\n${stderr}`.trim();
  } catch {
    return null;
  }
}

export function versionFrom(value: string | null): string | null {
  return (
    value?.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u)?.[1] ?? null
  );
}

export async function readCliVersion(
  command: string,
  options: KitPlatformOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    try {
      const { stdout, stderr } = await execFileAsync(command, ["--version"], {
        timeout: CLI_PROBE_TIMEOUT_MS,
        env: options.env,
      });
      return (
        `${stdout}\n${stderr}`.match(
          /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u,
        )?.[0] ?? null
      );
    } catch {
      return null;
    }
  }
  const plan = await windowsSpawnPlan(command, ["--version"], options);
  if (plan === null) {
    return null;
  }
  try {
    const { stdout, stderr } = await execFileAsync(plan.command, plan.args, {
      timeout: CLI_PROBE_TIMEOUT_MS,
      windowsHide: true,
      env: windowsExecEnv(options.env),
    });
    return (
      `${stdout}\n${stderr}`.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u)?.[0] ??
      null
    );
  } catch {
    return null;
  }
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u);
    return match === null
      ? { core: [0, 0, 0], prerelease: null }
      : {
          core: [Number(match[1]), Number(match[2]), Number(match[3])],
          prerelease: match[4] ?? null,
        };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta !== 0) return delta;
  }
  if (a.prerelease === null && b.prerelease !== null) return 1;
  if (a.prerelease !== null && b.prerelease === null) return -1;
  if (a.prerelease !== null && b.prerelease !== null) {
    return a.prerelease.localeCompare(b.prerelease);
  }
  return 0;
}

export function npmCommand(): string {
  return "npm";
}

export function formatCommand(
  command: string,
  args: readonly string[],
): string {
  return [command, ...args]
    .map((part) =>
      /^[A-Za-z0-9_./:@+-]+$/u.test(part)
        ? part
        : `'${part.replace(/'/gu, "'\\''")}'`,
    )
    .join(" ");
}

export function npmGlobalInstallCommand(
  npmPackage: string,
): ProviderInstallationCommand {
  const command = npmCommand();
  const args = ["install", "-g", `${npmPackage}@latest`];
  return { command, args, displayCommand: formatCommand(command, args) };
}

export async function npmLatestVersion(
  npmPackage: string,
  options: KitPlatformOptions = {},
): Promise<string | null> {
  return versionFrom(
    await commandOutput(npmCommand(), ["view", npmPackage, "version"], options),
  );
}

export interface NpmGlobalPackageProbe {
  npmBin: string | null;
  npmGlobalPackageVersion: string | null;
}

export async function probeNpmGlobalPackage(
  npmPackage: string,
  options: KitPlatformOptions = {},
): Promise<NpmGlobalPackageProbe> {
  const platform = options.platform ?? process.platform;
  const npm = npmCommand();
  const [prefixOutput, listOutput] = await Promise.all([
    commandOutput(npm, ["prefix", "-g"], options),
    commandOutput(
      npm,
      ["list", "-g", npmPackage, "--depth=0", "--json"],
      options,
    ),
  ]);
  const npmPrefix = firstLine(prefixOutput);
  return {
    npmBin:
      npmPrefix === null
        ? null
        : platform === "win32"
          ? npmPrefix
          : posixPath.join(npmPrefix, "bin"),
    npmGlobalPackageVersion: npmGlobalPackageVersion(listOutput, npmPackage),
  };
}

function firstLine(value: string | null): string | null {
  return (
    value
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function npmGlobalPackageVersion(
  value: string | null,
  npmPackage: string,
): string | null {
  if (value === null) return null;
  try {
    const parsed = z
      .object({
        dependencies: z
          .record(z.string(), z.object({ version: z.string().min(1) }))
          .default({}),
      })
      .safeParse(JSON.parse(value));
    return parsed.success
      ? (parsed.data.dependencies[npmPackage]?.version ?? null)
      : null;
  } catch {
    return null;
  }
}

function pathIsInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform,
): boolean {
  const platformPath = platform === "win32" ? win32Path : posixPath;
  const normalize = (value: string) =>
    platform === "win32" ? value.toLowerCase() : value;
  const relativePath = platformPath.relative(
    normalize(platformPath.resolve(parent)),
    normalize(platformPath.resolve(child)),
  );
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !platformPath.isAbsolute(relativePath))
  );
}

export function npmGlobalInstallSource(args: {
  installed: boolean;
  executablePath: string | null;
  npmBin: string | null;
  platform?: NodeJS.Platform;
}): ProviderInstallationSource {
  const platform = args.platform ?? process.platform;
  return !args.installed
    ? "notInstalled"
    : args.executablePath !== null &&
        args.npmBin !== null &&
        pathIsInside(args.executablePath, args.npmBin, platform)
      ? "npmGlobal"
      : "external";
}

export function installationVerification(
  status: Pick<ProviderInstallationStatus, "currentVersion" | "latestVersion">,
  action: "install" | "update",
): ProviderInstallationVerification {
  return action === "install"
    ? { kind: "installed" }
    : status.latestVersion !== null
      ? { kind: "version_at_least", version: status.latestVersion }
      : {
          kind: "version_changed",
          previousVersion: status.currentVersion ?? "unknown",
        };
}

export function downloadedInstallerCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): ProviderInstallationCommand | null {
  if (platform === "win32") {
    return null;
  }
  const script = [
    'tmp=$(mktemp "${TMPDIR:-/tmp}/provider-installation.XXXXXX")',
    "trap 'rm -f \"$tmp\"' EXIT",
    `curl -fsSL ${url} -o "$tmp"`,
    'bash "$tmp"',
  ].join(" && ");
  return { command: "sh", args: ["-c", script], displayCommand: script };
}

export function installerUnavailableReason(
  displayName: string,
  url: string,
): string {
  return `bb cannot run the ${displayName} shell installer on Windows. Install ${displayName} from ${url}, then reload.`;
}

export function clampPercent(value: number): number {
  return Math.min(
    100,
    Math.max(0, Math.round(Number.isFinite(value) ? value : 0)),
  );
}
