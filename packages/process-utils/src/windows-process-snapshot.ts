import { realpathSync } from "node:fs";
import { spawnPortableOutputProcess } from "./index.js";
import {
  POWERSHELL_NONINTERACTIVE_ARGS,
  resolvePowerShellExecutable,
} from "./windows-system-tools.js";

export interface WindowsProcessSnapshotEntry {
  pid: number;
  parentPid: number;
  executablePath: string | null;
  commandLine: string | null;
  creationDate: string | null;
}

export interface WindowsCommandRequest {
  command: string;
  args: string[];
}

export interface WindowsCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type WindowsCommandRunner = (
  request: WindowsCommandRequest,
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<WindowsCommandResult>;

export type WindowsProcessEnumerationErrorReason =
  | "timeout"
  | "exit"
  | "parse"
  | "spawn";

export class WindowsProcessEnumerationError extends Error {
  readonly reason: WindowsProcessEnumerationErrorReason;

  constructor(reason: WindowsProcessEnumerationErrorReason, message: string) {
    super(message);
    this.name = "WindowsProcessEnumerationError";
    this.reason = reason;
  }
}

export const WINDOWS_PROCESS_ENUM_TIMEOUT_MS = 10_000;

const WINDOWS_PROCESS_PROJECTION =
  "ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null }}}";

function buildWindowsProcessScript(filter: string | null): string {
  const source =
    filter === null
      ? "Get-CimInstance Win32_Process"
      : `Get-CimInstance Win32_Process -Filter "${filter}"`;
  return `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${source} | Select-Object ${WINDOWS_PROCESS_PROJECTION} | ConvertTo-Json -Compress`;
}

export function buildWindowsProcessEnumRequest(
  env: NodeJS.ProcessEnv = process.env,
): WindowsCommandRequest {
  return {
    command: resolvePowerShellExecutable(env),
    args: [
      ...POWERSHELL_NONINTERACTIVE_ARGS,
      "-Command",
      buildWindowsProcessScript(null),
    ],
  };
}

function buildWindowsProcessQueryRequest(
  pid: number,
  env: NodeJS.ProcessEnv,
): WindowsCommandRequest {
  return {
    command: resolvePowerShellExecutable(env),
    args: [
      ...POWERSHELL_NONINTERACTIVE_ARGS,
      "-Command",
      buildWindowsProcessScript(`ProcessId = ${pid}`),
    ],
  };
}

function describeWindowsCommand(request: WindowsCommandRequest): string {
  return `${request.command} ${request.args.join(" ")}`.slice(0, 400);
}

export const defaultWindowsCommandRunner: WindowsCommandRunner = (
  request,
  options,
) =>
  new Promise<WindowsCommandResult>((resolveRun, rejectRun) => {
    const child = spawnPortableOutputProcess({
      command: request.command,
      args: request.args,
      env: options.env,
      platform: "win32",
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const claim = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const timer = setTimeout(() => {
      if (!claim()) {
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {}
      rejectRun(
        new WindowsProcessEnumerationError(
          "timeout",
          `${describeWindowsCommand(request)} timed out after ${options.timeoutMs}ms`,
        ),
      );
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      if (claim()) {
        rejectRun(error);
      }
    });
    child.once("exit", (exitCode) => {
      if (!claim()) {
        return;
      }
      resolveRun({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
      });
    });
  });

async function runWindowsCommand(args: {
  runner: WindowsCommandRunner;
  request: WindowsCommandRequest;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<WindowsCommandResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: WindowsCommandResult;
  try {
    result = await Promise.race([
      args.runner(args.request, { timeoutMs: args.timeoutMs, env: args.env }),
      new Promise<WindowsCommandResult>((_resolveRace, rejectRace) => {
        timer = setTimeout(() => {
          rejectRace(
            new WindowsProcessEnumerationError(
              "timeout",
              `${describeWindowsCommand(args.request)} timed out after ${args.timeoutMs}ms`,
            ),
          );
        }, args.timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof WindowsProcessEnumerationError) {
      throw error;
    }
    throw new WindowsProcessEnumerationError(
      "spawn",
      `${describeWindowsCommand(args.request)} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
  if (result.exitCode !== 0) {
    throw new WindowsProcessEnumerationError(
      "exit",
      `${describeWindowsCommand(args.request)} exited with ${result.exitCode}: ${result.stderr.slice(0, 400)}`,
    );
  }
  return result;
}

function readCimString(
  record: Record<string, unknown>,
  names: string[],
): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return null;
}

export function parseWindowsProcessSnapshot(
  stdout: string,
): WindowsProcessSnapshotEntry[] {
  const trimmed = stdout.replace(/^\uFEFF/u, "").trim();
  if (trimmed === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new WindowsProcessEnumerationError(
      "parse",
      `Unable to parse Get-CimInstance Win32_Process output as JSON: ${trimmed.slice(0, 200)}`,
    );
  }
  if (parsed === null || parsed === undefined) {
    return [];
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const entries: WindowsProcessSnapshotEntry[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record: Record<string, unknown> = { ...item };
    const pid = Number(record.ProcessId ?? record.processId);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const parentRaw = Number(
      record.ParentProcessId ?? record.parentProcessId ?? 0,
    );
    entries.push({
      pid,
      parentPid: Number.isInteger(parentRaw) && parentRaw >= 0 ? parentRaw : 0,
      executablePath: readCimString(record, [
        "ExecutablePath",
        "executablePath",
      ]),
      commandLine: readCimString(record, ["CommandLine", "commandLine"]),
      creationDate: readCimString(record, ["CreationDate", "creationDate"]),
    });
  }
  return entries;
}

const trackedSweepRoots = new Map<number, string>();

export function registerSweepRootProcess(args: {
  pid: number;
  cwd: string;
}): void {
  if (Number.isInteger(args.pid) && args.pid > 0 && args.cwd !== "") {
    trackedSweepRoots.set(args.pid, args.cwd);
  }
}

export function unregisterSweepRootProcess(pid: number): void {
  trackedSweepRoots.delete(pid);
}

export function clearSweepRootProcesses(): void {
  trackedSweepRoots.clear();
}

export async function takeWindowsProcessSnapshot(
  args: {
    runner?: WindowsCommandRunner;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<WindowsProcessSnapshotEntry[]> {
  const env = args.env ?? process.env;
  const result = await runWindowsCommand({
    runner: args.runner ?? defaultWindowsCommandRunner,
    request: buildWindowsProcessEnumRequest(env),
    timeoutMs: args.timeoutMs ?? WINDOWS_PROCESS_ENUM_TIMEOUT_MS,
    env,
  });
  const snapshot = parseWindowsProcessSnapshot(result.stdout);
  const livePids = new Set(snapshot.map((entry) => entry.pid));
  for (const pid of [...trackedSweepRoots.keys()]) {
    if (!livePids.has(pid)) {
      trackedSweepRoots.delete(pid);
    }
  }
  return snapshot;
}

export async function queryWindowsProcess(
  pid: number,
  args: {
    runner?: WindowsCommandRunner;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<WindowsProcessSnapshotEntry | null> {
  const env = args.env ?? process.env;
  const result = await runWindowsCommand({
    runner: args.runner ?? defaultWindowsCommandRunner,
    request: buildWindowsProcessQueryRequest(pid, env),
    timeoutMs: args.timeoutMs ?? WINDOWS_PROCESS_ENUM_TIMEOUT_MS,
    env,
  });
  return parseWindowsProcessSnapshot(result.stdout)[0] ?? null;
}

function canonicalizeWindowsPath(value: string): string {
  let rest = value.replace(/\//gu, "\\");
  let prefix = "";
  if (/^\\\\\?\\UNC\\/iu.test(rest)) {
    prefix = "\\\\";
    rest = rest.slice(8);
  } else if (/^\\\\\?\\/iu.test(rest)) {
    rest = rest.slice(4);
  } else if (rest.startsWith("\\\\")) {
    prefix = "\\\\";
    rest = rest.slice(2);
  }
  rest = rest.replace(/\\+/gu, "\\");
  if (rest.length > 1 && rest.endsWith("\\") && !/^[A-Za-z]:\\$/u.test(rest)) {
    rest = rest.replace(/\\+$/u, "");
  }
  if (rest === "") {
    return prefix === "" ? "\\" : prefix;
  }
  return `${prefix}${rest}`.toLowerCase();
}

const WINDOWS_SHORT_NAME_SEGMENT_PATTERN = /~\d+(?=[\\/]|$)/u;

function expandWindowsShortPath(value: string): string {
  if (!WINDOWS_SHORT_NAME_SEGMENT_PATTERN.test(value)) {
    return value;
  }
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

export function isWindowsPathUnderDirectory(
  candidate: string,
  directory: string,
): boolean {
  const canonicalCandidate = canonicalizeWindowsPath(candidate);
  const canonicalDirectory = canonicalizeWindowsPath(directory);
  if (canonicalCandidate === canonicalDirectory) {
    return true;
  }
  const directoryPrefix = canonicalDirectory.endsWith("\\")
    ? canonicalDirectory
    : `${canonicalDirectory}\\`;
  return canonicalCandidate.startsWith(directoryPrefix);
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;

function extractWindowsPathCandidates(commandLine: string): string[] {
  const candidates: string[] = [];
  const tokenPattern = /"([^"]+)"|(\S+)/gu;
  let match: RegExpExecArray | null = tokenPattern.exec(commandLine);
  while (match !== null) {
    const token = (match[1] ?? match[2] ?? "").replace(/[,;]+$/u, "");
    if (
      token !== "" &&
      (WINDOWS_ABSOLUTE_PATH_PATTERN.test(token) || token.startsWith("\\\\"))
    ) {
      candidates.push(token);
    }
    match = tokenPattern.exec(commandLine);
  }
  return candidates;
}

export type WindowsSweepMatchEvidence =
  | "spawn-registry"
  | "executable-path"
  | "command-line"
  | "descendant";

export interface WindowsProcessMatch {
  pid: number;
  cwd: string;
  approximateCwd: true;
  matchEvidence: WindowsSweepMatchEvidence;
  creationDate: string | null;
}

export interface MatchWindowsProcessesUnderDirectoryArgs {
  snapshot: WindowsProcessSnapshotEntry[];
  directory: string;
  trackedRoots?: ReadonlyMap<number, string>;
  selfPid?: number;
  canonicalizePath?: (value: string) => string;
}

function matchWindowsProcessPath(args: {
  entry: WindowsProcessSnapshotEntry;
  directory: string;
  canonicalize: (value: string) => string;
}): { path: string; evidence: WindowsSweepMatchEvidence } | null {
  if (
    args.entry.executablePath !== null &&
    isWindowsPathUnderDirectory(
      args.canonicalize(args.entry.executablePath),
      args.directory,
    )
  ) {
    return { path: args.entry.executablePath, evidence: "executable-path" };
  }
  if (args.entry.commandLine !== null) {
    for (const candidate of extractWindowsPathCandidates(
      args.entry.commandLine,
    )) {
      if (
        isWindowsPathUnderDirectory(
          args.canonicalize(candidate),
          args.directory,
        )
      ) {
        return { path: candidate, evidence: "command-line" };
      }
    }
  }
  return null;
}

export function matchWindowsProcessesUnderDirectory(
  args: MatchWindowsProcessesUnderDirectoryArgs,
): WindowsProcessMatch[] {
  const trackedRoots = args.trackedRoots ?? trackedSweepRoots;
  const canonicalizePath = args.canonicalizePath ?? expandWindowsShortPath;
  const canonicalCache = new Map<string, string>();
  const canonicalize = (value: string): string => {
    const cached = canonicalCache.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const canonical = canonicalizePath(value);
    canonicalCache.set(value, canonical);
    return canonical;
  };
  const directory = canonicalize(args.directory);
  const byPid = new Map<number, WindowsProcessSnapshotEntry>();
  const childrenByParent = new Map<number, number[]>();
  for (const entry of args.snapshot) {
    byPid.set(entry.pid, entry);
    const siblings = childrenByParent.get(entry.parentPid) ?? [];
    siblings.push(entry.pid);
    childrenByParent.set(entry.parentPid, siblings);
  }
  const evidenceByPid = new Map<
    number,
    { cwd: string; evidence: WindowsSweepMatchEvidence }
  >();
  for (const [pid, rootCwd] of trackedRoots) {
    if (pid === args.selfPid) {
      continue;
    }
    if (isWindowsPathUnderDirectory(canonicalize(rootCwd), directory)) {
      evidenceByPid.set(pid, { cwd: rootCwd, evidence: "spawn-registry" });
    }
  }
  for (const entry of args.snapshot) {
    if (entry.pid === args.selfPid || evidenceByPid.has(entry.pid)) {
      continue;
    }
    const match = matchWindowsProcessPath({ entry, directory, canonicalize });
    if (match !== null) {
      evidenceByPid.set(entry.pid, {
        cwd: match.path,
        evidence: match.evidence,
      });
    }
  }
  const queue = [...evidenceByPid.keys()];
  const queued = new Set<number>(queue);
  while (queue.length > 0) {
    const pid = queue.pop();
    if (pid === undefined) {
      continue;
    }
    const inherited = evidenceByPid.get(pid);
    if (inherited === undefined) {
      continue;
    }
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (childPid === args.selfPid || queued.has(childPid)) {
        continue;
      }
      queued.add(childPid);
      const child = byPid.get(childPid);
      const own =
        child === undefined
          ? null
          : matchWindowsProcessPath({ entry: child, directory, canonicalize });
      evidenceByPid.set(
        childPid,
        own === null
          ? { cwd: inherited.cwd, evidence: "descendant" }
          : { cwd: own.path, evidence: own.evidence },
      );
      queue.push(childPid);
    }
  }
  const results: WindowsProcessMatch[] = [];
  for (const [pid, match] of evidenceByPid) {
    const entry = byPid.get(pid);
    if (entry === undefined) {
      continue;
    }
    results.push({
      pid,
      cwd: match.cwd,
      approximateCwd: true,
      matchEvidence: match.evidence,
      creationDate: entry.creationDate,
    });
  }
  return results;
}
