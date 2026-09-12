import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DevInstanceConfig } from "@bb/config/runtime";
import {
  spawnPortableOutputProcess,
  spawnPortableProcess,
} from "@bb/process-utils";
import { readRunningPid, writePidFile } from "./pid-file.js";

export type DevAppCommand =
  | "current"
  | "env"
  | "help"
  | "logs"
  | "status"
  | "stop";

export type DevAppLogTarget = "desktop" | "dev";

export interface DevAppArgs {
  command: DevAppCommand;
  desktop: boolean;
  logTarget: DevAppLogTarget;
  open: boolean;
  powershell: boolean;
}

export type DevAppEnvShell = "posix" | "powershell";

export interface DevAppPaths {
  desktopLogPath: string;
  desktopPidPath: string;
  desktopUserDataDir: string;
  devLogPath: string;
  devPidPath: string;
  logRoot: string;
}

export type DevAppProcessState = "running" | "stopped";

export interface DevAppStatusArgs {
  branch: string;
  config: DevInstanceConfig;
  desktopState: DevAppProcessState;
  devState: DevAppProcessState;
  execPath: string;
  nodeAbi: string;
  nodeVersion: string;
  paths: DevAppPaths;
}

export const DEV_SERVER_READY_PATTERN = /Host daemon started/u;

export const DEV_FAILURE_PATTERNS: readonly RegExp[] = [
  /port .* is unavailable/u,
  /ELIFECYCLE/u,
  /ERROR {2}run failed/u,
  /^\[session-host\] /mu,
];

export const DEV_SERVER_READY_TIMEOUT_MS = 90_000;
export const DESKTOP_READY_TIMEOUT_MS = 120_000;

export function desktopReadyPattern(appPort: number): RegExp {
  return new RegExp(
    `@bb/desktop: app http://localhost:${appPort}(?![0-9])`,
    "u",
  );
}

function parseLogTarget(word: string | undefined): DevAppLogTarget {
  if (word === undefined || word === "dev") {
    return "dev";
  }
  if (word === "desktop") {
    return "desktop";
  }
  throw new Error(`Unknown log target: ${word}`);
}

export function parseDevAppArgs(argv: readonly string[]): DevAppArgs {
  const flags = { desktop: false, open: false, powershell: false };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--desktop") {
      flags.desktop = true;
    } else if (arg === "--open") {
      flags.open = true;
    } else if (arg === "--powershell") {
      flags.powershell = true;
    } else {
      positional.push(arg);
    }
  }
  const [commandWord = "help", ...rest] = positional;
  if (commandWord === "logs") {
    const [targetWord, ...extra] = rest;
    if (extra.length > 0) {
      throw new Error(`Unexpected arguments: ${extra.join(" ")}`);
    }
    return { ...flags, command: "logs", logTarget: parseLogTarget(targetWord) };
  }
  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
  }
  switch (commandWord) {
    case "current":
    case "env":
    case "status":
    case "stop":
      return { ...flags, command: commandWord, logTarget: "dev" };
    case "help":
    case "-h":
    case "--help":
      return { ...flags, command: "help", logTarget: "dev" };
    default:
      throw new Error(`Unknown command: ${commandWord}`);
  }
}

export function formatDevAppEnv(
  config: DevInstanceConfig,
  shell: DevAppEnvShell,
): string {
  const assignments: Array<[string, string]> = [
    ["BB_SERVER_URL", config.serverUrl],
    ["BB_HOST_DAEMON_PORT", String(config.ports.hostDaemonPort)],
    ["BB_PROJECT_ID", "proj_personal"],
  ];
  const removals = ["BB_THREAD_ID", "BB_ENVIRONMENT_ID", "BB_THREAD_STORAGE"];
  if (shell === "powershell") {
    return [
      ...assignments.map(([key, value]) => `$env:${key} = "${value}"`),
      ...removals.map(
        (key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`,
      ),
    ].join("\n");
  }
  return [
    ...assignments.map(([key, value]) => `export ${key}=${value}`),
    ...removals.map((key) => `unset ${key}`),
  ].join("\n");
}

export function resolveDevAppPaths(
  config: DevInstanceConfig,
  env: NodeJS.ProcessEnv,
): DevAppPaths {
  const logRoot = join(config.dataDir, "dev-app");
  const pidRoot = join(config.dataDir, "dev-supervisors");
  const configuredUserDataDir = env.BB_DESKTOP_USER_DATA_DIR?.trim();
  return {
    desktopLogPath: join(logRoot, "desktop.log"),
    desktopPidPath: join(pidRoot, "dev-app-desktop.pid"),
    desktopUserDataDir:
      configuredUserDataDir !== undefined && configuredUserDataDir.length > 0
        ? configuredUserDataDir
        : join(config.dataDir, "desktop"),
    devLogPath: join(logRoot, "dev.log"),
    devPidPath: join(pidRoot, "dev-app-dev.pid"),
    logRoot,
  };
}

export function assertDesktopNodeRuntime(args: {
  execPath: string;
  version: string;
}): void {
  const match = /^v?(\d+)\.(\d+)\./u.exec(args.version);
  const major = match ? Number(match[1]) : Number.NaN;
  const minor = match ? Number(match[2]) : Number.NaN;
  if (major !== 22 || minor < 19) {
    throw new Error(
      `pnpm dev:desktop needs Node 22.19 or newer on the 22 line (see .nvmrc); current ${args.version} at ${args.execPath}`,
    );
  }
}

export function resolveOpenUrlCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function formatDevAppStatus(args: DevAppStatusArgs): string {
  return [
    `Repo: ${args.config.repoRoot}`,
    `Branch: ${args.branch}`,
    `Node: ${args.nodeVersion} (ABI ${args.nodeAbi}) at ${args.execPath}`,
    `Instance: ${args.config.instanceId}`,
    `Data dir: ${args.config.dataDir}`,
    `App: http://localhost:${args.config.ports.appPort}`,
    `Server: ${args.config.serverUrl}`,
    `Host daemon: http://127.0.0.1:${args.config.ports.hostDaemonPort}`,
    `Desktop user data: ${args.paths.desktopUserDataDir}`,
    `Dev session: ${args.devState}`,
    `Desktop session: ${args.desktopState}`,
    `Logs: ${args.paths.devLogPath}, ${args.paths.desktopLogPath}`,
  ].join("\n");
}

export interface StartLoggedProcessArgs {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  pidPath: string;
  platform: NodeJS.Platform;
  windowsSessionHost?: { command: string; args: string[] };
}

export interface WaitForLogPatternArgs {
  description: string;
  failurePatterns: readonly RegExp[];
  isAlive?: () => Promise<boolean>;
  logPath: string;
  pollIntervalMs?: number;
  readyPattern: RegExp;
  timeoutMs: number;
}

const STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function finishStartedProcess(args: {
  child: ReturnType<typeof spawnPortableProcess>;
  command: string;
  pidPath: string;
}): Promise<number> {
  const pid = await new Promise<number>((resolvePromise, rejectPromise) => {
    args.child.once("error", rejectPromise);
    args.child.once("spawn", () => {
      args.child.off("error", rejectPromise);
      args.child.on("error", () => {});
      resolvePromise(args.child.pid ?? -1);
    });
  });
  if (pid <= 0) {
    throw new Error(`Failed to start ${args.command}`);
  }
  args.child.unref();
  await writePidFile({ pid, pidPath: args.pidPath });
  return pid;
}

export async function startLoggedProcess(
  request: StartLoggedProcessArgs,
): Promise<number> {
  if (request.platform === "win32") {
    if (request.windowsSessionHost === undefined) {
      throw new Error("windowsSessionHost is required on win32");
    }
    await mkdir(dirname(request.logPath), { recursive: true });
    await rm(request.logPath, { force: true });
    const child = spawnPortableProcess({
      args: [
        ...request.windowsSessionHost.args,
        request.logPath,
        request.command,
        ...request.args,
      ],
      command: request.windowsSessionHost.command,
      cwd: request.cwd,
      detached: true,
      env: request.env,
      stdio: "ignore",
      windowsHide: true,
    });
    return finishStartedProcess({
      child,
      command: request.windowsSessionHost.command,
      pidPath: request.pidPath,
    });
  }
  await mkdir(dirname(request.logPath), { recursive: true });
  await rm(request.logPath, { force: true });
  const logHandle = await open(request.logPath, "a");
  try {
    const child = spawnPortableProcess({
      args: request.args,
      command: request.command,
      cwd: request.cwd,
      detached: true,
      env: request.env,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      windowsHide: true,
    });
    return await finishStartedProcess({
      child,
      command: request.command,
      pidPath: request.pidPath,
    });
  } finally {
    await logHandle.close();
  }
}

export async function appendSessionHostFailure(args: {
  logPath: string;
  message: string;
}): Promise<void> {
  const line = `\n[session-host] ${args.message}\n`;
  try {
    await appendFile(args.logPath, line, "utf8");
  } catch {
    process.stderr.write(line);
  }
}

export async function runSessionHost(request: {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}): Promise<number> {
  let logHandle: Awaited<ReturnType<typeof open>>;
  try {
    await mkdir(dirname(request.logPath), { recursive: true });
    logHandle = await open(request.logPath, "a");
  } catch (error) {
    await appendSessionHostFailure({
      logPath: request.logPath,
      message: describeError(error),
    });
    return 1;
  }
  let child: ReturnType<typeof spawnPortableProcess>;
  try {
    child = spawnPortableProcess({
      args: request.args,
      command: request.command,
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      windowsHide: true,
    });
  } catch (error) {
    await logHandle.close();
    await appendSessionHostFailure({
      logPath: request.logPath,
      message: describeError(error),
    });
    return 1;
  }
  const exitCode = new Promise<number>((resolvePromise) => {
    child.once("error", (error) => {
      void appendSessionHostFailure({
        logPath: request.logPath,
        message: error.message,
      }).then(() => {
        resolvePromise(1);
      });
    });
    child.once("exit", (code, signal) => {
      resolvePromise(signal !== null ? 1 : (code ?? 1));
    });
  });
  await logHandle.close();
  return exitCode;
}

export async function waitForLogPattern(
  args: WaitForLogPatternArgs,
): Promise<void> {
  const deadline = Date.now() + args.timeoutMs;
  const pollIntervalMs = args.pollIntervalMs ?? 1_000;
  while (Date.now() <= deadline) {
    let text = "";
    try {
      text = await readFile(args.logPath, "utf8");
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
    if (args.readyPattern.test(text)) {
      return;
    }
    if (args.failurePatterns.some((pattern) => pattern.test(text))) {
      throw new Error(
        `${args.description} failed to start; see ${args.logPath}`,
      );
    }
    if (args.isAlive !== undefined && !(await args.isAlive())) {
      throw new Error(
        `${args.description} exited before it was ready; see ${args.logPath}`,
      );
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Timed out after ${args.timeoutMs} ms waiting for ${args.description}; see ${args.logPath}`,
  );
}

export async function readTrackedProcessState(args: {
  pidPath: string;
  serviceName: string;
}): Promise<DevAppProcessState> {
  try {
    await readRunningPid(args);
    return "running";
  } catch {
    return "stopped";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ESRCH")) {
      return false;
    }
    return true;
  }
}

async function waitForProcessGone(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(STOP_POLL_MS);
  }
  return !isProcessAlive(pid);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    if (!isErrnoCode(error, "ESRCH")) {
      throw error;
    }
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isErrnoCode(error, "ESRCH")) {
      throw error;
    }
  }
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnPortableOutputProcess({
      args: ["/PID", String(pid), "/T", "/F"],
      command: "taskkill.exe",
      cwd: process.cwd(),
      env: process.env,
    });
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", rejectPromise);
    child.once("exit", () => resolvePromise());
  });
}

async function stopWindowsProcessTree(pid: number): Promise<boolean> {
  await runTaskkill(pid);
  return waitForProcessGone(pid, STOP_GRACE_MS);
}

async function stopPosixProcessGroup(pid: number): Promise<boolean> {
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGone(pid, STOP_GRACE_MS)) {
    return true;
  }
  signalProcessGroup(pid, "SIGKILL");
  return waitForProcessGone(pid, STOP_GRACE_MS);
}

export async function stopTrackedProcess(args: {
  pidPath: string;
  platform: NodeJS.Platform;
  serviceName: string;
}): Promise<"not-running" | "stopped"> {
  let pid: number;
  try {
    pid = await readRunningPid({
      pidPath: args.pidPath,
      serviceName: args.serviceName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.startsWith("No running ") ||
      message.startsWith("Stale PID file") ||
      message.startsWith("Invalid PID file")
    ) {
      return "not-running";
    }
    throw error;
  }
  const gone =
    args.platform === "win32"
      ? await stopWindowsProcessTree(pid)
      : await stopPosixProcessGroup(pid);
  if (!gone) {
    throw new Error(
      `${args.serviceName} (pid ${pid}) is still running after stop; see ${args.pidPath}`,
    );
  }
  await rm(args.pidPath, { force: true });
  return "stopped";
}

async function readLogFileFrom(args: {
  logPath: string;
  offset: number;
  write: (chunk: string) => void;
}): Promise<number> {
  let handle;
  try {
    handle = await open(args.logPath, "r");
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return args.offset;
  }
  try {
    const { size } = await handle.stat();
    const start = size < args.offset ? 0 : args.offset;
    if (size <= start) {
      return start;
    }
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    args.write(buffer.toString("utf8"));
    return size;
  } finally {
    await handle.close();
  }
}

export async function followLogFile(args: {
  logPath: string;
  pollIntervalMs?: number;
  signal: AbortSignal;
  write: (chunk: string) => void;
}): Promise<void> {
  const pollIntervalMs = args.pollIntervalMs ?? 500;
  let offset = 0;
  while (!args.signal.aborted) {
    offset = await readLogFileFrom({
      logPath: args.logPath,
      offset,
      write: args.write,
    });
    await sleep(pollIntervalMs);
  }
  await readLogFileFrom({ logPath: args.logPath, offset, write: args.write });
}
