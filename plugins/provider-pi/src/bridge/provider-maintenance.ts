import { execFile } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type ProviderHealthResult,
  type ProviderInstallationCommand,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  experimental_commandOutput as commandOutput,
  experimental_compareVersions as compareVersions,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_npmCommand as npmCommand,
  experimental_npmGlobalInstallCommand as npmGlobalInstallCommand,
  experimental_npmGlobalInstallSource as npmGlobalInstallSource,
  experimental_npmLatestVersion as npmLatestVersion,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_versionFrom as versionFrom,
} from "@get-bb/plugin-sdk/provider-bridge";
import { resolvePiLaunch } from "./rpc-child.js";

const execFileAsync = promisify(execFile);
export const PI_MINIMUM_SUPPORTED_VERSION = "0.84.0";
export const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent";
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const INSTALL_GATE_TTL_MS = 30_000;
const PI_INSTALL_UNAVAILABLE_REASON =
  "bb needs bun or npm on Path to install Pi on Windows. Install Node.js or Bun, then reload.";

type PiVersionProbe =
  | { version: string; failure: null }
  | { version: null; failure: string };

interface PiMaintenanceOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

interface PiMaintenanceContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

function maintenanceContext(
  options: PiMaintenanceOptions,
): PiMaintenanceContext {
  return {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
  };
}

function bunCommand(): string {
  return "bun";
}

function bunGlobalInstallCommand(
  npmPackage: string,
): ProviderInstallationCommand {
  const command = bunCommand();
  const args = ["add", "-g", `${npmPackage}@latest`];
  return { command, args, displayCommand: formatCommand(command, args) };
}

function firstOutputLine(output: string | null): string | null {
  return (
    output
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function pathIsInside(child: string, parent: string): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function expandHomePath(value: string): string {
  const home = os.homedir();
  if (value.startsWith("$HOME/")) return path.join(home, value.slice(6));
  if (value.startsWith("${HOME}/")) return path.join(home, value.slice(8));
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

async function shellExecTarget(executablePath: string): Promise<string | null> {
  const handle = await open(executablePath, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const buffer = Buffer.alloc(8_192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const source = buffer.subarray(0, bytesRead).toString("utf8");
    if (!source.startsWith("#!")) return null;
    for (const line of source.split(/\r?\n/u)) {
      const match = line.match(/^\s*exec\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u);
      const target = match?.[1] ?? match?.[2] ?? match?.[3];
      if (target !== undefined) return expandHomePath(target);
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function isBunManagedPi(
  executablePath: string | null,
  context: PiMaintenanceContext,
): Promise<boolean> {
  if (executablePath === null) return false;
  const bunBin = firstOutputLine(
    await commandOutput(bunCommand(), ["pm", "bin", "-g"], context),
  );
  if (bunBin === null) return false;
  if (pathIsInside(executablePath, bunBin)) return true;
  const bunPi = path.join(
    bunBin,
    context.platform === "win32" ? "pi.exe" : "pi",
  );
  const [resolvedExecutable, resolvedBunPi] = await Promise.all([
    realpath(executablePath).catch(() => null),
    realpath(bunPi).catch(() => null),
  ]);
  if (
    resolvedExecutable !== null &&
    (pathIsInside(resolvedExecutable, bunBin) ||
      resolvedExecutable === resolvedBunPi)
  ) {
    return true;
  }
  const delegatedTarget = await shellExecTarget(executablePath);
  if (delegatedTarget === null) return false;
  if (path.resolve(delegatedTarget) === path.resolve(bunPi)) return true;
  const resolvedDelegatedTarget = await realpath(delegatedTarget).catch(
    () => null,
  );
  return (
    resolvedDelegatedTarget !== null &&
    resolvedDelegatedTarget === resolvedBunPi
  );
}

async function piGlobalInstallCommand(
  executablePath: string | null,
  context: PiMaintenanceContext,
): Promise<ProviderInstallationCommand | null> {
  if (await isBunManagedPi(executablePath, context)) {
    return bunGlobalInstallCommand(PI_NPM_PACKAGE);
  }
  if (context.platform !== "win32") {
    return npmGlobalInstallCommand(PI_NPM_PACKAGE, context.platform);
  }
  const npm = npmCommand(context.platform);
  return (await commandOutput(npm, ["--version"], context)) === null
    ? null
    : npmGlobalInstallCommand(PI_NPM_PACKAGE, context.platform);
}

export async function probePiVersion(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiVersionProbe> {
  const launch = resolvePiLaunch(env);
  const display = formatCommand(launch.command, [...launch.args, "--version"]);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      launch.command,
      [...launch.args, "--version"],
      {
        timeout: VERSION_PROBE_TIMEOUT_MS,
      },
    ));
  } catch (error) {
    return {
      version: null,
      failure: `\`${display}\` ${describePiVersionProbeFailure(error)}`,
    };
  }
  const version = versionFrom(stdout);
  return version === null
    ? { version: null, failure: `\`${display}\` printed no version` }
    : { version, failure: null };
}

export function describePiVersionProbeFailure(error: unknown): string {
  const failed =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown; killed?: unknown; signal?: unknown })
      : null;
  if (failed?.killed === true) {
    return `timed out after ${VERSION_PROBE_TIMEOUT_MS / 1000} s`;
  }
  if (typeof failed?.signal === "string") {
    return `was stopped by ${failed.signal} before it answered`;
  }
  if (failed?.code !== undefined && failed.code !== null) {
    return `exited with ${String(failed.code)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function getPiProviderInstallationStatus(
  options: PiMaintenanceOptions = {},
): Promise<ProviderInstallationStatus> {
  const context = maintenanceContext(options);
  const launch = resolvePiLaunch(context.env);
  const [resolvedExecutable, probe, latestVersion, npmGlobal] =
    await Promise.all([
      resolveExecutablePath(launch.command, context),
      probePiVersion(context.env),
      npmLatestVersion(PI_NPM_PACKAGE, context),
      probeNpmGlobalPackage(PI_NPM_PACKAGE, context),
    ]);
  const currentVersion = probe.version;
  const installed = resolvedExecutable !== null || currentVersion !== null;
  const needsUpdate =
    installed &&
    currentVersion !== null &&
    latestVersion !== null &&
    compareVersions(latestVersion, currentVersion) > 0;
  const versionUnsupported =
    installed &&
    currentVersion !== null &&
    compareVersions(currentVersion, PI_MINIMUM_SUPPORTED_VERSION) < 0;
  const wantedAction = !installed
    ? "install"
    : needsUpdate || versionUnsupported
      ? "update"
      : null;
  const installCommand =
    wantedAction === null
      ? null
      : await piGlobalInstallCommand(resolvedExecutable, context);
  const installAction: ProviderInstallationStatus["installAction"] =
    wantedAction === null || installCommand === null
      ? null
      : {
          kind: wantedAction,
          label: wantedAction === "install" ? "Install" : "Update",
          command: installCommand.displayCommand,
        };

  return {
    executableName: "pi",
    executablePath: resolvedExecutable,
    installed,
    installSource: npmGlobalInstallSource({
      installed,
      executablePath: resolvedExecutable,
      npmBin: npmGlobal.npmBin,
      platform: context.platform,
    }),
    currentVersion,
    latestVersion,
    minimumSupportedVersion: PI_MINIMUM_SUPPORTED_VERSION,
    npmPackageName: PI_NPM_PACKAGE,
    npmGlobalPackageVersion: npmGlobal.npmGlobalPackageVersion,
    installAction,
    installUnavailableReason:
      wantedAction !== null && installCommand === null
        ? PI_INSTALL_UNAVAILABLE_REASON
        : null,
    needsUpdate,
    versionUnsupported,
  };
}

export async function getPiProviderInstallationRun(
  action: "install" | "update",
  options: PiMaintenanceOptions = {},
): Promise<ProviderInstallationRunResult> {
  const context = maintenanceContext(options);
  const status = await getPiProviderInstallationStatus(options);
  const command =
    status.installAction?.kind !== action
      ? null
      : await piGlobalInstallCommand(status.executablePath, context);
  if (command === null) {
    return {
      available: false,
      message:
        status.installUnavailableReason ??
        `Pi ${action} is no longer available on this host.`,
    };
  }
  return {
    available: true,
    command,
    verification: installationVerification(status, action),
  };
}

export function piHealthResult(
  status:
    | "ready"
    | "not_installed"
    | "unauthenticated"
    | "unsupported_version"
    | "unknown",
  args: {
    installedVersion?: string | null;
    statusMessage?: string | null;
  } = {},
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: null,
      planLabel: null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: PI_MINIMUM_SUPPORTED_VERSION,
      canInstall: true,
      canUpdate: status !== "not_installed",
      loginCommand: "pi",
    },
  };
}

export type PiInstallGate =
  | { ok: true; installedVersion: string }
  | {
      ok: false;
      status: "not_installed" | "unsupported_version" | "unknown";
      statusMessage: string | null;
      result: ProviderHealthResult;
    };

const INSTALL_GUIDANCE = `Install ${PI_NPM_PACKAGE} ${PI_MINIMUM_SUPPORTED_VERSION} or newer: ${npmGlobalInstallCommand(PI_NPM_PACKAGE).displayCommand}`;

async function probePiInstallGate(): Promise<PiInstallGate> {
  const launch = resolvePiLaunch(process.env);
  if ((await resolveExecutablePath(launch.command)) === null) {
    return {
      ok: false,
      status: "not_installed",
      statusMessage: null,
      result: piHealthResult("not_installed"),
    };
  }
  const probe = await probePiVersion();
  if (probe.version === null) {
    const statusMessage = `Could not determine the pi version: ${probe.failure}. ${INSTALL_GUIDANCE}`;
    return {
      ok: false,
      status: "unknown",
      statusMessage,
      result: piHealthResult("unknown", { statusMessage }),
    };
  }
  const installedVersion = probe.version;
  if (compareVersions(installedVersion, PI_MINIMUM_SUPPORTED_VERSION) < 0) {
    const statusMessage = `Pi ${installedVersion} is older than the supported minimum ${PI_MINIMUM_SUPPORTED_VERSION}. ${INSTALL_GUIDANCE}`;
    return {
      ok: false,
      status: "unsupported_version",
      statusMessage,
      result: piHealthResult("unsupported_version", {
        installedVersion,
        statusMessage,
      }),
    };
  }
  return { ok: true, installedVersion };
}

const installGateMemo = new Map<
  string,
  { expiresAt: number; gate: Promise<PiInstallGate> }
>();

export function getPiInstallGate(): Promise<PiInstallGate> {
  const launch = resolvePiLaunch(process.env);
  const key = JSON.stringify([launch.command, launch.args]);
  const now = Date.now();
  const cached = installGateMemo.get(key);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.gate;
  }
  const gate = probePiInstallGate();
  installGateMemo.set(key, { expiresAt: now + INSTALL_GATE_TTL_MS, gate });
  gate.catch(() => {
    if (installGateMemo.get(key)?.gate === gate) installGateMemo.delete(key);
  });
  return gate;
}

export function resetPiInstallGateForTests(): void {
  installGateMemo.clear();
}

export const __testing = { piGlobalInstallCommand };
