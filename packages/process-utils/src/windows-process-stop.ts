import { killProcessGroup, type ProcessWithCwd } from "./index.js";
import {
  defaultWindowsCommandRunner,
  matchWindowsProcessesUnderDirectory,
  takeWindowsProcessSnapshot,
  WINDOWS_PROCESS_ENUM_TIMEOUT_MS,
  type WindowsCommandRequest,
  type WindowsCommandRunner,
  type WindowsProcessSnapshotEntry,
} from "./windows-process-snapshot.js";
import { resolveWindowsSystemToolPath } from "./windows-system-tools.js";

const CHILD_EXIT_POLL_MS = 25;
const WINDOWS_SWEEP_MAX_ROUNDS = 5;
const WINDOWS_SWEEP_SETTLE_MS = 50;
const TASKKILL_NOT_FOUND_EXIT_CODE = 128;

export interface SkippedProcessEvent {
  pid: number;
  reason: "pid-reused";
  expectedCreationDate: string | null;
  observedCreationDate: string | null;
}

export interface TerminateProcessTreeResult {
  leaderExited: boolean;
  descendantsKilled: number[];
  descendantsSkipped: SkippedProcessEvent[];
}

export interface TerminateProcessTreeChild {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface TerminateProcessTreeArgs {
  child: TerminateProcessTreeChild;
  graceMs: number;
  platform?: NodeJS.Platform;
  runner?: WindowsCommandRunner;
  env?: NodeJS.ProcessEnv;
  onSkippedProcess?: (event: SkippedProcessEvent) => void;
}

function hasChildExited(child: TerminateProcessTreeChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForChildExit(
  child: TerminateProcessTreeChild,
  graceMs: number,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (!hasChildExited(child)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(CHILD_EXIT_POLL_MS);
  }
  return true;
}

function buildTaskkillRequest(
  pid: number,
  mode: "tree" | "force",
  env: NodeJS.ProcessEnv,
): WindowsCommandRequest {
  return {
    command: resolveWindowsSystemToolPath("taskkill.exe", env),
    args: ["/PID", String(pid), mode === "tree" ? "/T" : "/F"],
  };
}

function collectDescendantCreationDates(
  snapshot: WindowsProcessSnapshotEntry[],
  rootPid: number,
): Map<number, string | null> {
  const childrenByParent = new Map<number, number[]>();
  const byPid = new Map<number, WindowsProcessSnapshotEntry>();
  for (const entry of snapshot) {
    byPid.set(entry.pid, entry);
    const siblings = childrenByParent.get(entry.parentPid) ?? [];
    siblings.push(entry.pid);
    childrenByParent.set(entry.parentPid, siblings);
  }
  const descendants = new Map<number, string | null>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.pop();
    if (pid === undefined) {
      continue;
    }
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (childPid === rootPid || descendants.has(childPid)) {
        continue;
      }
      descendants.set(childPid, byPid.get(childPid)?.creationDate ?? null);
      queue.push(childPid);
    }
  }
  return descendants;
}

async function runTaskkill(args: {
  runner: WindowsCommandRunner;
  pid: number;
  mode: "tree" | "force";
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<boolean> {
  try {
    const result = await args.runner(
      buildTaskkillRequest(args.pid, args.mode, args.env),
      { timeoutMs: args.timeoutMs, env: args.env },
    );
    return (
      result.exitCode === 0 || result.exitCode === TASKKILL_NOT_FOUND_EXIT_CODE
    );
  } catch {
    return false;
  }
}

export async function terminateProcessTree(
  args: TerminateProcessTreeArgs,
): Promise<TerminateProcessTreeResult> {
  const platform = args.platform ?? process.platform;
  if (platform !== "win32") {
    killProcessGroup({ child: args.child, signal: "SIGKILL", platform });
    return {
      leaderExited: await waitForChildExit(args.child, args.graceMs),
      descendantsKilled: [],
      descendantsSkipped: [],
    };
  }
  const env = args.env ?? process.env;
  const runner = args.runner ?? defaultWindowsCommandRunner;
  const timeoutMs = WINDOWS_PROCESS_ENUM_TIMEOUT_MS;
  const leaderPid = args.child.pid;
  if (leaderPid === undefined) {
    return {
      leaderExited: hasChildExited(args.child),
      descendantsKilled: [],
      descendantsSkipped: [],
    };
  }
  const before = await takeWindowsProcessSnapshot({ runner, timeoutMs, env });
  const descendants = collectDescendantCreationDates(before, leaderPid);
  await runTaskkill({ runner, pid: leaderPid, mode: "tree", env, timeoutMs });
  const leaderExited = await waitForChildExit(args.child, args.graceMs);
  if (!leaderExited) {
    args.child.kill("SIGKILL");
  }
  const after = await takeWindowsProcessSnapshot({ runner, timeoutMs, env });
  const observedByPid = new Map(
    after.map((entry) => [entry.pid, entry.creationDate]),
  );
  const descendantsKilled: number[] = [];
  const descendantsSkipped: SkippedProcessEvent[] = [];
  for (const [pid, expectedCreationDate] of descendants) {
    if (!observedByPid.has(pid)) {
      continue;
    }
    const observedCreationDate = observedByPid.get(pid) ?? null;
    if (observedCreationDate !== expectedCreationDate) {
      const event: SkippedProcessEvent = {
        pid,
        reason: "pid-reused",
        expectedCreationDate,
        observedCreationDate,
      };
      descendantsSkipped.push(event);
      args.onSkippedProcess?.(event);
      continue;
    }
    if (await runTaskkill({ runner, pid, mode: "force", env, timeoutMs })) {
      descendantsKilled.push(pid);
    }
  }
  return {
    leaderExited: hasChildExited(args.child),
    descendantsKilled,
    descendantsSkipped,
  };
}

export async function listWindowsProcessesWithCwdUnder(args: {
  directory: string;
  runner: WindowsCommandRunner | undefined;
  env: NodeJS.ProcessEnv | undefined;
  timeoutMs: number | undefined;
  selfPid: number;
}): Promise<ProcessWithCwd[]> {
  const env = args.env ?? process.env;
  const snapshot = await takeWindowsProcessSnapshot({
    runner: args.runner ?? defaultWindowsCommandRunner,
    timeoutMs: args.timeoutMs ?? WINDOWS_PROCESS_ENUM_TIMEOUT_MS,
    env,
  });
  return matchWindowsProcessesUnderDirectory({
    snapshot,
    directory: args.directory,
    selfPid: args.selfPid,
  });
}

export async function killWindowsProcessesWithCwdUnder(args: {
  directory: string;
  runner: WindowsCommandRunner | undefined;
  env: NodeJS.ProcessEnv | undefined;
  timeoutMs: number | undefined;
  selfPid: number;
  onSkippedProcess: ((event: SkippedProcessEvent) => void) | undefined;
}): Promise<ProcessWithCwd[]> {
  const env = args.env ?? process.env;
  const runner = args.runner ?? defaultWindowsCommandRunner;
  const timeoutMs = args.timeoutMs ?? WINDOWS_PROCESS_ENUM_TIMEOUT_MS;
  const killed = new Map<number, ProcessWithCwd>();
  for (let round = 0; round < WINDOWS_SWEEP_MAX_ROUNDS; round += 1) {
    const snapshot = await takeWindowsProcessSnapshot({
      runner,
      timeoutMs,
      env,
    });
    const targets = matchWindowsProcessesUnderDirectory({
      snapshot,
      directory: args.directory,
      selfPid: args.selfPid,
    });
    if (targets.length === 0) {
      break;
    }
    const verification = await takeWindowsProcessSnapshot({
      runner,
      timeoutMs,
      env,
    });
    const observedByPid = new Map(
      verification.map((entry) => [entry.pid, entry.creationDate]),
    );
    for (const target of targets) {
      if (!observedByPid.has(target.pid)) {
        continue;
      }
      const observedCreationDate = observedByPid.get(target.pid) ?? null;
      if (observedCreationDate !== target.creationDate) {
        args.onSkippedProcess?.({
          pid: target.pid,
          reason: "pid-reused",
          expectedCreationDate: target.creationDate,
          observedCreationDate,
        });
        continue;
      }
      if (
        await runTaskkill({
          runner,
          pid: target.pid,
          mode: "force",
          env,
          timeoutMs,
        })
      ) {
        killed.set(target.pid, {
          pid: target.pid,
          cwd: target.cwd,
          approximateCwd: true,
          matchEvidence: target.matchEvidence,
        });
      }
    }
    await delay(WINDOWS_SWEEP_SETTLE_MS);
  }
  return [...killed.values()];
}
