export * from "./plugin-process-paths.js";
export * from "./resolve-executable.js";
export * from "./windows-process-snapshot.js";
export * from "./windows-process-stop.js";
export * from "./windows-system-tools.js";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Readable, Writable } from "node:stream";
import crossSpawn from "cross-spawn";
import {
  registerSweepRootProcess,
  unregisterSweepRootProcess,
  type WindowsCommandRunner,
  type WindowsSweepMatchEvidence,
} from "./windows-process-snapshot.js";
import {
  killWindowsProcessesWithCwdUnder,
  listWindowsProcessesWithCwdUnder,
  terminateProcessTree,
  type SkippedProcessEvent,
} from "./windows-process-stop.js";

interface PortableSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  stdio?: StdioOptions;
  windowsHide?: boolean;
}

export type PortableChildProcess = ChildProcess;

interface PortablePipedSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

interface PortablePipedChildProcess extends PortableChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

interface PortableOutputChildProcess extends PortableChildProcess {
  stdin: null;
  stdout: Readable;
  stderr: Readable;
}

interface KillProcessGroupArgs {
  child: {
    pid?: number | undefined;
    kill: (signal: NodeJS.Signals) => unknown;
  };
  platform?: NodeJS.Platform;
  signal: NodeJS.Signals;
}

interface StopProcessGroupLeaderFirstArgs {
  child: ChildProcess;
  timeoutMs: number;
  killGraceMs: number;
  platform?: NodeJS.Platform;
  runner?: WindowsCommandRunner;
  env?: NodeJS.ProcessEnv;
  onSkippedProcess?: (event: SkippedProcessEvent) => void;
}

export interface ProcessWithCwd {
  pid: number;
  cwd: string;
  approximateCwd?: true;
  matchEvidence?: WindowsSweepMatchEvidence;
}

interface ListProcessesWithCwdUnderArgs {
  directory: string;
  platform?: NodeJS.Platform;
  runner?: WindowsCommandRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface KillProcessesWithCwdUnderArgs {
  directory: string;
  graceMs?: number;
  platform?: NodeJS.Platform;
  runner?: WindowsCommandRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onSkippedProcess?: (event: SkippedProcessEvent) => void;
}

interface ResolveContainedPathArgs {
  rootPath: string;
  candidatePath: string;
}

export interface SanitizeInheritedChildProcessEnvArgs {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  shellPath?: string;
}

export interface AssignPathEnvArgs {
  env: NodeJS.ProcessEnv;
  path: string;
  platform?: NodeJS.Platform;
}

type SafeProcessDiagnosticKind = "startupFailure" | "uncaughtException";

interface SafeProcessDiagnosticsOptions {
  logsDir: string;
  processName: string;
}

interface WriteSafeProcessDiagnosticReportArgs extends SafeProcessDiagnosticsOptions {
  kind: SafeProcessDiagnosticKind;
  error: unknown;
  now?: () => Date;
  createReportId?: () => string;
}

const MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH = 8;
const MAX_DIAGNOSTIC_AGGREGATE_ERRORS = 8;

interface SafeProcessDiagnosticError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SafeProcessDiagnosticError;
  errors?: SafeProcessDiagnosticError[];
  errorsTruncated?: number;
  truncationReason?: "cycle" | "depth";
}

interface SafeProcessDiagnosticReport {
  diagnosticVersion: 1;
  kind: SafeProcessDiagnosticKind;
  processName: string;
  occurredAt: string;
  pid: number;
  runtime: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    execPath: string;
  };
  error: SafeProcessDiagnosticError;
}

type UncaughtExceptionMonitorHandler = (
  error: Error,
  origin: NodeJS.UncaughtExceptionOrigin,
) => void;

export function spawnPortableProcess(
  request: PortableSpawnRequest,
): PortableChildProcess {
  const platform = request.platform ?? process.platform;
  const child = crossSpawn(request.command, request.args, {
    cwd: request.cwd,
    detached: request.detached,
    env: request.env,
    stdio: request.stdio,
    windowsHide:
      platform === "win32"
        ? (request.windowsHide ?? true)
        : request.windowsHide,
  });
  const cwd = request.cwd;
  const pid = child.pid;
  if (platform === "win32" && cwd !== undefined && pid !== undefined) {
    registerSweepRootProcess({ pid, cwd });
    child.once("exit", () => unregisterSweepRootProcess(pid));
  }
  return child;
}

function assertPortablePipedProcess(
  child: PortableChildProcess,
): asserts child is PortablePipedChildProcess {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Portable child process did not attach piped stdio");
  }
}

function assertPortableOutputProcess(
  child: PortableChildProcess,
): asserts child is PortableOutputChildProcess {
  if (child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Portable child process did not attach output-only stdio");
  }
}

export function spawnPortablePipedProcess(
  request: PortablePipedSpawnRequest,
): PortablePipedChildProcess {
  const child = spawnPortableProcess({
    ...request,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assertPortablePipedProcess(child);
  return child;
}

export function spawnPortableOutputProcess(
  request: PortablePipedSpawnRequest,
): PortableOutputChildProcess {
  const child = spawnPortableProcess({
    ...request,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assertPortableOutputProcess(child);
  return child;
}

export function supportsProcessGroups(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

export function killProcessGroup(args: KillProcessGroupArgs): void {
  if (
    supportsProcessGroups(args.platform ?? process.platform) &&
    args.child.pid !== undefined
  ) {
    try {
      process.kill(-args.child.pid, args.signal);
      return;
    } catch {}
  }
  args.child.kill(args.signal);
}

export function isProcessGroupAlive(
  child: {
    pid?: number | undefined;
  },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!supportsProcessGroups(platform) || child.pid === undefined) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

const PROCESS_GROUP_EXIT_POLL_MS = 100;

export function stopProcessGroupLeaderFirst(
  args: StopProcessGroupLeaderFirstArgs,
): Promise<void> {
  const { child, timeoutMs, killGraceMs } = args;
  if ((args.platform ?? process.platform) === "win32") {
    return terminateProcessTree({
      child,
      graceMs: timeoutMs,
      platform: "win32",
      ...(args.runner !== undefined ? { runner: args.runner } : {}),
      ...(args.env !== undefined ? { env: args.env } : {}),
      ...(args.onSkippedProcess !== undefined
        ? { onSkippedProcess: args.onSkippedProcess }
        : {}),
    }).then(() => undefined);
  }
  if (hasChildExited(child) && !isProcessGroupAlive(child)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveStop) => {
    let settled = false;
    let hardTimer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(softTimer);
      if (hardTimer !== undefined) {
        clearTimeout(hardTimer);
      }
      if (poll !== undefined) {
        clearInterval(poll);
      }
      resolveStop();
    };
    const groupGone = (): boolean =>
      hasChildExited(child) && !isProcessGroupAlive(child);
    const softTimer = setTimeout(() => {
      if (groupGone()) {
        finish();
        return;
      }
      killProcessGroup({ child, signal: "SIGKILL" });
      if (killGraceMs <= 0) {
        finish();
        return;
      }
      hardTimer = setTimeout(finish, killGraceMs);
    }, timeoutMs);

    const stopSurvivingMembers = (): void => {
      if (!isProcessGroupAlive(child)) {
        finish();
        return;
      }
      killProcessGroup({ child, signal: "SIGTERM" });
      poll = setInterval(() => {
        if (!isProcessGroupAlive(child)) {
          finish();
        }
      }, PROCESS_GROUP_EXIT_POLL_MS);
    };

    if (hasChildExited(child)) {
      stopSurvivingMembers();
      return;
    }
    child.once("exit", stopSurvivingMembers);
    child.kill("SIGTERM");
  });
}

function isPathUnderDirectory(candidate: string, directory: string): boolean {
  const normalized = candidate.endsWith(" (deleted)")
    ? candidate.slice(0, -" (deleted)".length)
    : candidate;
  return (
    normalized === directory || normalized.startsWith(`${directory}${sep}`)
  );
}

async function listLinuxProcessCwds(): Promise<ProcessWithCwd[]> {
  const entries = await readdir("/proc");
  const results: ProcessWithCwd[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) {
        return;
      }
      try {
        const cwd = await readlink(`/proc/${entry}/cwd`);
        results.push({ pid: Number(entry), cwd });
      } catch {}
    }),
  );
  return results;
}

async function listLsofProcessCwds(): Promise<ProcessWithCwd[]> {
  const child = spawnPortableOutputProcess({
    command: "lsof",
    args: ["-a", "-d", "cwd", "-F", "pn", "-w", "-n"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.resume();
  await new Promise<void>((resolveExit) => {
    child.once("error", () => resolveExit());
    child.once("exit", () => resolveExit());
  });
  const results: ProcessWithCwd[] = [];
  let pid: number | null = null;
  for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n") && pid !== null) {
      results.push({ pid, cwd: line.slice(1) });
    }
  }
  return results;
}

async function resolveSweepDirectory(
  directory: string,
): Promise<string | null> {
  const resolved = resolve(directory);
  let parent = dirname(resolved);
  try {
    parent = await realpath(parent);
  } catch {}
  const canonical = join(parent, basename(resolved));
  try {
    if ((await lstat(canonical)).isSymbolicLink()) {
      return null;
    }
  } catch {}
  return canonical;
}

export async function listProcessesWithCwdUnder(
  args: ListProcessesWithCwdUnderArgs,
): Promise<ProcessWithCwd[]> {
  if ((args.platform ?? process.platform) === "win32") {
    return listWindowsProcessesWithCwdUnder({
      directory: args.directory,
      runner: args.runner,
      env: args.env,
      timeoutMs: args.timeoutMs,
      selfPid: process.pid,
    });
  }
  const directory = await resolveSweepDirectory(args.directory);
  if (directory === null) {
    return [];
  }
  const all =
    process.platform === "linux"
      ? await listLinuxProcessCwds()
      : await listLsofProcessCwds();
  return all.filter(
    (entry) =>
      entry.pid !== process.pid && isPathUnderDirectory(entry.cwd, directory),
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const MAX_CWD_SWEEP_ROUNDS = 5;

function signalProcesses(
  targets: ProcessWithCwd[],
  signal: NodeJS.Signals,
  signalled: Map<number, ProcessWithCwd>,
): void {
  for (const target of targets) {
    try {
      process.kill(target.pid, signal);
      signalled.set(target.pid, target);
    } catch {}
  }
}

export async function killProcessesWithCwdUnder(
  args: KillProcessesWithCwdUnderArgs,
): Promise<ProcessWithCwd[]> {
  if ((args.platform ?? process.platform) === "win32") {
    return killWindowsProcessesWithCwdUnder({
      directory: args.directory,
      runner: args.runner,
      env: args.env,
      timeoutMs: args.timeoutMs,
      selfPid: process.pid,
      onSkippedProcess: args.onSkippedProcess,
    });
  }
  const graceMs = args.graceMs ?? 2000;
  const signalled = new Map<number, ProcessWithCwd>();
  for (let round = 0; round < MAX_CWD_SWEEP_ROUNDS; round += 1) {
    const targets = await listProcessesWithCwdUnder({
      directory: args.directory,
    });
    if (targets.length === 0) {
      break;
    }
    signalProcesses(targets, "SIGTERM", signalled);
    const deadline = Date.now() + graceMs;
    while (
      Date.now() < deadline &&
      targets.some((target) => isProcessAlive(target.pid))
    ) {
      await delay(50);
    }
    const survivors = await listProcessesWithCwdUnder({
      directory: args.directory,
    });
    if (survivors.length === 0) {
      break;
    }
    signalProcesses(survivors, "SIGKILL", signalled);
    await delay(50);
  }
  return Array.from(signalled.values());
}

export function resolveContainedPath(
  args: ResolveContainedPathArgs,
): string | null {
  const resolvedRootPath = resolve(args.rootPath);
  const resolvedCandidatePath = resolve(args.candidatePath);
  const relativePath = relative(resolvedRootPath, resolvedCandidatePath);

  if (relativePath === "") {
    return null;
  }

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }

  return resolvedCandidatePath;
}

const WINDOWS_PATH_ENV_KEY_PATTERN = /^path$/iu;

export function sanitizeInheritedChildProcessEnv(
  args: SanitizeInheritedChildProcessEnvArgs,
): NodeJS.ProcessEnv {
  const platform = args.platform ?? process.platform;
  const dropPathVariants = platform === "win32" && args.shellPath !== undefined;
  const sanitizedEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(args.env)) {
    if (value === undefined) {
      continue;
    }
    if (key === "NODE_ENV" || key.startsWith("BB_")) {
      continue;
    }
    if (dropPathVariants && WINDOWS_PATH_ENV_KEY_PATTERN.test(key)) {
      continue;
    }
    sanitizedEnv[key] = value;
  }
  if (args.shellPath !== undefined) {
    if (platform === "win32") {
      sanitizedEnv.Path = args.shellPath;
      return sanitizedEnv;
    }
    sanitizedEnv.PATH = args.shellPath;
  }
  return sanitizedEnv;
}

export function assignPathEnv(args: AssignPathEnvArgs): NodeJS.ProcessEnv {
  const platform = args.platform ?? process.platform;
  if (platform !== "win32") {
    return { ...args.env, PATH: args.path };
  }
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(args.env)) {
    if (value === undefined || WINDOWS_PATH_ENV_KEY_PATTERN.test(key)) {
      continue;
    }
    childEnv[key] = value;
  }
  childEnv.Path = args.path;
  return childEnv;
}

const NPM_SCRIPT_POLICY_ENV_KEYS: ReadonlySet<string> = new Set([
  "npm_config_allow_scripts",
  "npm_config_ignore_scripts",
  "npm_config_foreground_scripts",
]);

export function omitNpmScriptPolicyEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (NPM_SCRIPT_POLICY_ENV_KEYS.has(key.toLowerCase())) continue;
    childEnv[key] = value;
  }
  return childEnv;
}

function createCurrentDiagnosticDate(): Date {
  return new Date();
}

function sanitizeDiagnosticFilenamePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return sanitized.length > 0 ? sanitized : "process";
}

function formatDiagnosticTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function createTruncatedDiagnosticError(
  truncationReason: "cycle" | "depth",
): SafeProcessDiagnosticError {
  return {
    name: "TruncatedErrorCause",
    message:
      truncationReason === "cycle"
        ? "Error cause serialization stopped because the cause chain contains a cycle"
        : `Error cause serialization stopped at the maximum depth of ${MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH}`,
    truncationReason,
  };
}

function serializeDiagnosticError(
  error: unknown,
  seenErrors: Set<Error> = new Set(),
  depth = 0,
): SafeProcessDiagnosticError {
  if (error instanceof Error) {
    if (seenErrors.has(error)) {
      return createTruncatedDiagnosticError("cycle");
    }
    if (depth >= MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH) {
      return createTruncatedDiagnosticError("depth");
    }
    seenErrors.add(error);

    const serialized: SafeProcessDiagnosticError = {
      name: error.name,
      message: error.message,
    };
    if (error.stack !== undefined) {
      serialized.stack = error.stack;
    }
    if ("code" in error && typeof error.code === "string") {
      serialized.code = error.code;
    }
    if (error.cause !== undefined) {
      serialized.cause = serializeDiagnosticError(
        error.cause,
        seenErrors,
        depth + 1,
      );
    }
    if (error instanceof AggregateError) {
      const aggregateErrors = error.errors.slice(
        0,
        MAX_DIAGNOSTIC_AGGREGATE_ERRORS,
      );
      serialized.errors = aggregateErrors.map((aggregateError) =>
        serializeDiagnosticError(aggregateError, seenErrors, depth + 1),
      );
      const errorsTruncated = error.errors.length - aggregateErrors.length;
      if (errorsTruncated > 0) {
        serialized.errorsTruncated = errorsTruncated;
      }
    }
    seenErrors.delete(error);
    return serialized;
  }

  return {
    name: "NonError",
    message: String(error),
  };
}

export function writeSafeProcessDiagnosticReport(
  args: WriteSafeProcessDiagnosticReportArgs,
): string {
  mkdirSync(args.logsDir, { recursive: true });
  const occurredAt = (args.now ?? createCurrentDiagnosticDate)();
  const reportId = sanitizeDiagnosticFilenamePart(
    (args.createReportId ?? randomUUID)(),
  );
  const processName = sanitizeDiagnosticFilenamePart(args.processName);
  const reportPath = join(
    args.logsDir,
    `process-${processName}-${args.kind}-${formatDiagnosticTimestamp(
      occurredAt,
    )}-${reportId}.json`,
  );
  const report: SafeProcessDiagnosticReport = {
    diagnosticVersion: 1,
    kind: args.kind,
    processName: args.processName,
    occurredAt: occurredAt.toISOString(),
    pid: process.pid,
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
    },
    error: serializeDiagnosticError(args.error),
  };

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
  });
  return reportPath;
}

export function installSafeProcessDiagnostics(
  options: SafeProcessDiagnosticsOptions,
): () => void {
  mkdirSync(options.logsDir, { recursive: true });
  const handleUncaughtExceptionMonitor: UncaughtExceptionMonitorHandler = (
    error,
  ) => {
    try {
      writeSafeProcessDiagnosticReport({
        ...options,
        kind: "uncaughtException",
        error,
      });
    } catch {}
  };

  process.on("uncaughtExceptionMonitor", handleUncaughtExceptionMonitor);

  return () => {
    process.off("uncaughtExceptionMonitor", handleUncaughtExceptionMonitor);
  };
}
