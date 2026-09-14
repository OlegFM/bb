import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { basename, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import { assignIfDefined } from "@bb/config/objects";
import {
  assignPathEnv,
  readWindowsEnvValue,
  resolvePowerShellExecutable,
  resolveWindowsSystemToolPath,
  spawnPortableOutputProcess,
  splitWindowsPathList,
  terminateProcessTree,
} from "@bb/process-utils";

interface ResolveLocalBbExecutablePathOptions {
  cliExecutablePath?: string;
  cliRuntimePath?: string;
  platform?: NodeJS.Platform;
}

interface PrepareRuntimeShellEnvOptions {
  bbExecutableDirectory: string;
  bbExecutablePath?: string;
  hostDaemonPort?: number;
  serverUrl: string;
  inheritedPath?: string;
  platform?: NodeJS.Platform;
}

interface ResolveUserShellPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: SpawnUserShellEnv;
  spawnUserShellEnv?: SpawnUserShellEnv;
  timeoutMs?: number;
}

export interface SpawnUserShellEnvArgs {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface UserShellEnvSpawnResult {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
}

export type SpawnUserShellEnv = (
  args: SpawnUserShellEnvArgs,
) => Promise<UserShellEnvSpawnResult>;

const SHELL_ENV_START_MARKER = "__BB_SHELL_ENV_START__";
const SHELL_ENV_END_MARKER = "__BB_SHELL_ENV_END__";
const SHELL_ENV_COMMAND = [
  `printf '%s\\n' ${SHELL_ENV_START_MARKER}`,
  "env",
  `printf '%s\\n' ${SHELL_ENV_END_MARKER}`,
].join("; ");
const USER_SHELL_ENV_TIMEOUT_MS = 3_000;
const USER_SHELL_ENV_FORCE_KILL_AFTER_MS = 1_000;
const POWERSHELL_SHELL_ENV_COMMAND = [
  `Write-Output '${SHELL_ENV_START_MARKER}'`,
  "Get-ChildItem Env: | ForEach-Object { Write-Output ($_.Name + '=' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_.Value))) }",
  `Write-Output '${SHELL_ENV_END_MARKER}'`,
].join("; ");
const BASE64_VALUE_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
const REGISTRY_PATH_ROW_PATTERN = /^\s+Path\s+(REG_EXPAND_SZ|REG_SZ)\s+(.*)$/iu;
const REGISTRY_EXPANDABLE_VALUE_TYPE = "REG_EXPAND_SZ";
const WINDOWS_MACHINE_ENVIRONMENT_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const WINDOWS_USER_ENVIRONMENT_KEY = "HKCU\\Environment";
const WINDOWS_REGISTRY_QUERY_TIMEOUT_MS = 5_000;
const WINDOWS_USER_SHELL_ENV_TIMEOUT_MS = 8_000;
const WINDOWS_PROBE_TERMINATION_GRACE_MS = 1_000;

function getDefaultCliExecutablePath(platform: NodeJS.Platform): string {
  return fileURLToPath(
    new URL(`../../cli/bin/${bbExecutableFileName(platform)}`, import.meta.url),
  );
}

function getDefaultCliRuntimePath(): string {
  return fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
}

function getErrorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

async function resolveCliEntryPath(
  cliExecutablePath: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const cliEntryPath = resolve(cliExecutablePath);

  try {
    const stats = await fs.stat(cliEntryPath);
    if (!stats.isFile()) {
      throw new Error(`Resolved bb CLI entry is not a file: ${cliEntryPath}`);
    }
    if (platform !== "win32") {
      try {
        await fs.access(cliEntryPath, fsConstants.X_OK);
      } catch (error) {
        if (getErrorCode(error) === "EACCES") {
          throw new Error(
            `Resolved bb CLI entry is not executable: ${cliEntryPath}. Build @bb/cli before starting the host daemon.`,
          );
        }
        throw error;
      }
    }
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new Error(
        `Missing built bb CLI entry at ${cliEntryPath}. Build @bb/cli before starting the host daemon.`,
      );
    }
    throw error;
  }

  return cliEntryPath;
}

async function requireCliRuntimePath(cliRuntimePath: string): Promise<void> {
  const resolvedCliRuntimePath = resolve(cliRuntimePath);

  try {
    const stats = await fs.stat(resolvedCliRuntimePath);
    if (!stats.isFile()) {
      throw new Error(
        `Resolved bb CLI runtime is not a file: ${resolvedCliRuntimePath}`,
      );
    }
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new Error(
        `Missing built bb CLI runtime at ${resolvedCliRuntimePath}. Build @bb/cli before starting the host daemon.`,
      );
    }
    throw error;
  }
}

function prependPath(
  executableDirectoryPath: string,
  inheritedPath?: string,
): string {
  return inheritedPath
    ? `${executableDirectoryPath}${delimiter}${inheritedPath}`
    : executableDirectoryPath;
}

function defaultSpawnUserShellEnv(
  args: SpawnUserShellEnvArgs,
): Promise<UserShellEnvSpawnResult> {
  return new Promise<UserShellEnvSpawnResult>((resolveSpawn) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;

    function clearTimeouts(args?: { keepForceKillTimeout?: boolean }): void {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (!args?.keepForceKillTimeout && forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = undefined;
      }
    }

    function settle(
      result: UserShellEnvSpawnResult,
      args?: { keepForceKillTimeout?: boolean },
    ): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeouts(args);
      resolveSpawn(result);
    }

    function forceKillChildAfterDelay(): void {
      if (forceKillTimeout) {
        return;
      }
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, USER_SHELL_ENV_FORCE_KILL_AFTER_MS);
      forceKillTimeout.unref();
    }

    function terminateChild(): void {
      child.kill("SIGTERM");
      forceKillChildAfterDelay();
    }

    try {
      child = spawn(args.command, args.args, {
        env: args.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({
        error: error instanceof Error ? error : new Error(String(error)),
        signal: null,
        status: null,
        stderr,
        stdout,
      });
      return;
    }

    timeout = setTimeout(() => {
      terminateChild();
      settle(
        {
          error: new Error(
            `Shell env probe timed out after ${args.timeoutMs}ms`,
          ),
          signal: "SIGTERM",
          status: null,
          stderr,
          stdout,
        },
        { keepForceKillTimeout: true },
      );
    }, args.timeoutMs);
    timeout.unref();

    if (!child.stdout || !child.stderr) {
      terminateChild();
      settle(
        {
          error: new Error("Shell env probe did not attach stdout and stderr"),
          signal: null,
          status: null,
          stderr,
          stdout,
        },
        { keepForceKillTimeout: true },
      );
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        clearTimeouts();
        return;
      }
      settle({
        error,
        signal: null,
        status: null,
        stderr,
        stdout,
      });
    });
    child.on("close", (status, signal) => {
      if (settled) {
        clearTimeouts();
        return;
      }
      settle({
        signal,
        status,
        stderr,
        stdout,
      });
    });
  });
}

function resolveUserShellCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  if (platform === "win32") {
    return null;
  }
  const configuredShell = env.SHELL?.trim();
  if (configuredShell && configuredShell.length > 0) {
    return configuredShell;
  }
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

function userShellEnvArgSets(shell: string): string[][] {
  const shellName = basename(shell);
  if (shellName === "sh" || shellName === "dash") {
    return [["-lc", SHELL_ENV_COMMAND]];
  }
  return [
    ["-ilc", SHELL_ENV_COMMAND],
    ["-lc", SHELL_ENV_COMMAND],
  ];
}

function parsePathFromUserShellEnv(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/u);
  const startIndex = lines.findIndex(
    (line) => line.trim() === SHELL_ENV_START_MARKER,
  );
  if (startIndex === -1) {
    return null;
  }
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trim() === SHELL_ENV_END_MARKER,
  );
  if (endIndex === -1) {
    return null;
  }

  for (const line of lines.slice(startIndex + 1, endIndex)) {
    if (!line.startsWith("PATH=")) {
      continue;
    }
    const pathValue = line.slice("PATH=".length).trim();
    return pathValue.length > 0 ? pathValue : null;
  }
  return null;
}

function defaultSpawnWindowsCommand(
  args: SpawnUserShellEnvArgs,
): Promise<UserShellEnvSpawnResult> {
  return new Promise<UserShellEnvSpawnResult>((resolveSpawn) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    function settle(result: UserShellEnvSpawnResult): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      resolveSpawn(result);
    }

    let child: ReturnType<typeof spawnPortableOutputProcess>;
    try {
      child = spawnPortableOutputProcess({
        command: args.command,
        args: args.args,
        env: args.env,
        platform: "win32",
      });
    } catch (error) {
      settle({
        error: error instanceof Error ? error : new Error(String(error)),
        signal: null,
        status: null,
        stderr,
        stdout,
      });
      return;
    }

    timeout = setTimeout(() => {
      void terminateProcessTree({
        child,
        graceMs: WINDOWS_PROBE_TERMINATION_GRACE_MS,
        platform: "win32",
      }).catch(() => undefined);
      settle({
        error: new Error(`Shell env probe timed out after ${args.timeoutMs}ms`),
        signal: null,
        status: null,
        stderr,
        stdout,
      });
    }, args.timeoutMs);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle({ error, signal: null, status: null, stderr, stdout });
    });
    child.on("close", (status, signal) => {
      settle({ signal, status, stderr, stdout });
    });
  });
}

function expandWindowsEnvReferences(
  value: string,
  env: NodeJS.ProcessEnv,
): string {
  return value.replace(/%([^%]+)%/gu, (match, name: string) => {
    return readWindowsEnvValue(env, name) ?? match;
  });
}

interface RegistryPathRow {
  expandable: boolean;
  value: string;
}

function parseRegistryPathRow(stdout: string): RegistryPathRow | null {
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(REGISTRY_PATH_ROW_PATTERN);
    if (match === null) {
      continue;
    }
    const value = match[2]?.trim() ?? "";
    if (value.length === 0) {
      return null;
    }
    return {
      expandable:
        match[1]?.toUpperCase() ===
        REGISTRY_EXPANDABLE_VALUE_TYPE.toUpperCase(),
      value,
    };
  }
  return null;
}

export async function readWindowsRegistryPath(args: {
  env: NodeJS.ProcessEnv;
  runCommand?: SpawnUserShellEnv;
}): Promise<string | null> {
  const runCommand = args.runCommand ?? defaultSpawnWindowsCommand;
  const regExecutablePath = resolveWindowsSystemToolPath("reg.exe", args.env);
  const results = await Promise.all(
    [WINDOWS_MACHINE_ENVIRONMENT_KEY, WINDOWS_USER_ENVIRONMENT_KEY].map((key) =>
      runCommand({
        command: regExecutablePath,
        args: ["query", key, "/v", "Path"],
        env: args.env,
        timeoutMs: WINDOWS_REGISTRY_QUERY_TIMEOUT_MS,
      }),
    ),
  );

  const entries: string[] = [];
  for (const result of results) {
    if (
      result.error !== undefined ||
      result.signal !== null ||
      result.status !== 0
    ) {
      continue;
    }
    const row = parseRegistryPathRow(result.stdout);
    if (row === null) {
      continue;
    }
    entries.push(
      ...splitWindowsPathList(
        row.expandable
          ? expandWindowsEnvReferences(row.value, args.env)
          : row.value,
      ),
    );
  }
  return entries.length > 0 ? entries.join(";") : null;
}

function findLastMarkerIndex(lines: string[], marker: string): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() === marker) {
      return index;
    }
  }
  return -1;
}

function parseWindowsPathFromUserShellEnv(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/u);
  const startIndex = findLastMarkerIndex(lines, SHELL_ENV_START_MARKER);
  if (startIndex === -1) {
    return null;
  }
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trim() === SHELL_ENV_END_MARKER,
  );
  if (endIndex === -1) {
    return null;
  }

  for (const line of lines.slice(startIndex + 1, endIndex)) {
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (line.slice(0, separator).toLowerCase() !== "path") {
      continue;
    }
    const encoded = line.slice(separator + 1).trim();
    if (!BASE64_VALUE_PATTERN.test(encoded) || encoded.length % 4 !== 0) {
      continue;
    }
    const pathValue = Buffer.from(encoded, "base64").toString("utf8").trim();
    if (pathValue.length > 0) {
      return pathValue;
    }
  }
  return null;
}

async function resolveWindowsUserShellPath(
  options: ResolveUserShellPathOptions,
  env: NodeJS.ProcessEnv,
  previousPath: string | null,
): Promise<string | null> {
  const registryPath = await readWindowsRegistryPath({
    env,
    ...(options.runCommand === undefined
      ? {}
      : { runCommand: options.runCommand }),
  });

  const spawnUserShellEnv =
    options.spawnUserShellEnv ?? defaultSpawnWindowsCommand;
  const probeResult = await spawnUserShellEnv({
    command: resolvePowerShellExecutable(env),
    args: ["-NoLogo", "-Command", POWERSHELL_SHELL_ENV_COMMAND],
    env:
      registryPath === null
        ? env
        : assignPathEnv({ env, path: registryPath, platform: "win32" }),
    timeoutMs: options.timeoutMs ?? WINDOWS_USER_SHELL_ENV_TIMEOUT_MS,
  });
  const probedPath =
    probeResult.error === undefined &&
    probeResult.signal === null &&
    probeResult.status === 0
      ? parseWindowsPathFromUserShellEnv(probeResult.stdout)
      : null;
  if (probedPath !== null) {
    return probedPath;
  }
  if (registryPath !== null) {
    return registryPath;
  }
  if (previousPath !== null) {
    return previousPath;
  }

  const inheritedPath = readWindowsEnvValue(env, "Path")?.trim();
  return inheritedPath !== undefined && inheritedPath.length > 0
    ? inheritedPath
    : null;
}

export async function resolveUserShellPath(
  options: ResolveUserShellPathOptions = {},
): Promise<string | null> {
  return resolveUserShellPathWithPrevious(options, null);
}

async function resolveUserShellPathWithPrevious(
  options: ResolveUserShellPathOptions,
  previousPath: string | null,
): Promise<string | null> {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) === "win32") {
    return resolveWindowsUserShellPath(options, env, previousPath);
  }
  const shell = resolveUserShellCommand(
    env,
    options.platform ?? process.platform,
  );
  if (!shell) {
    return null;
  }

  const spawnUserShellEnv =
    options.spawnUserShellEnv ?? defaultSpawnUserShellEnv;
  const shellArgSets = userShellEnvArgSets(shell);
  for (const [index, shellArgs] of shellArgSets.entries()) {
    const result = await spawnUserShellEnv({
      command: shell,
      args: shellArgs,
      env,
      timeoutMs: options.timeoutMs ?? USER_SHELL_ENV_TIMEOUT_MS,
    });
    if (
      result.error !== undefined ||
      result.signal !== null ||
      result.status !== 0
    ) {
      if (index === 0 && previousPath !== null) {
        return previousPath;
      }
      continue;
    }
    const path = parsePathFromUserShellEnv(result.stdout);
    if (path !== null) {
      return path;
    }
    if (index === 0 && previousPath !== null) {
      return previousPath;
    }
  }

  return null;
}

export function createUserShellPathResolver(
  options: ResolveUserShellPathOptions = {},
): () => Promise<string | null> {
  let previousPath: string | null = null;
  return async () => {
    const path = await resolveUserShellPathWithPrevious(options, previousPath);
    if (path !== null) previousPath = path;
    return path;
  };
}

export async function resolveLocalBbExecutablePath(
  options: ResolveLocalBbExecutablePathOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const resolvedCliExecutablePath =
    options.cliExecutablePath ?? getDefaultCliExecutablePath(platform);
  const cliEntryPath = await resolveCliEntryPath(
    resolvedCliExecutablePath,
    platform,
  );
  const cliRuntimePath =
    options.cliRuntimePath ??
    (options.cliExecutablePath === undefined
      ? getDefaultCliRuntimePath()
      : undefined);
  if (cliRuntimePath !== undefined) {
    await requireCliRuntimePath(cliRuntimePath);
  }
  return cliEntryPath;
}

function bbExecutableFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "bb.cmd" : "bb";
}

export function resolveBbExecutablePathInDirectory(
  bbExecutableDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolve(bbExecutableDirectory, bbExecutableFileName(platform));
}

export function prepareRuntimeShellEnv(
  options: PrepareRuntimeShellEnvOptions,
): NonNullable<AgentRuntimeOptions["shellEnv"]> {
  const bbExecutablePath =
    options.bbExecutablePath ??
    resolveBbExecutablePathInDirectory(
      options.bbExecutableDirectory,
      options.platform ?? process.platform,
    );
  const shellEnv: NonNullable<AgentRuntimeOptions["shellEnv"]> = {
    PATH: prependPath(
      options.bbExecutableDirectory,
      options.inheritedPath ?? process.env.PATH,
    ),
    BB_CLI: bbExecutablePath,
    BB_SERVER_URL: options.serverUrl,
  };
  assignIfDefined({
    key: "BB_HOST_DAEMON_PORT",
    target: shellEnv,
    value:
      options.hostDaemonPort === undefined
        ? undefined
        : String(options.hostDaemonPort),
  });
  return shellEnv;
}
