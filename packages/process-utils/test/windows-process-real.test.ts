import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSweepRootProcesses,
  defaultWindowsCommandRunner,
  matchWindowsProcessesUnderDirectory,
  resolveWindowsSystemToolPath,
  spawnPortablePipedProcess,
  takeWindowsProcessSnapshot,
  terminateProcessTree,
  type SkippedProcessEvent,
  type WindowsCommandRunner,
} from "../src/index.js";

const win32Only = process.platform === "win32";
const PID_RECYCLE_ITERATIONS = 300;

const PARENT_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", detached: true });',
  "child.unref();",
  "process.stdout.write(`child_pid=${child.pid}\\n`);",
  "setTimeout(() => {}, 600000);",
].join("\n");

const strayPids: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return true;
}

async function startTree(): Promise<{
  child: ReturnType<typeof spawnPortablePipedProcess>;
  grandchildPid: number;
}> {
  const child = spawnPortablePipedProcess({
    command: process.execPath,
    args: ["-e", PARENT_SCRIPT],
  });
  const [chunk] = await once(child.stdout, "data");
  const grandchildPid = Number(
    /child_pid=(\d+)/u.exec(String(chunk))?.[1] ?? "",
  );
  expect(Number.isSafeInteger(grandchildPid)).toBe(true);
  strayPids.push(grandchildPid);
  return { child, grandchildPid };
}

function spawnSleeper(args: string[], cwd: string): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: "ignore",
    windowsHide: true,
  });
  if (child.pid !== undefined) {
    strayPids.push(child.pid);
  }
  return child;
}

async function recyclePids(iterations: number): Promise<void> {
  const cmdPath = resolveWindowsSystemToolPath("cmd.exe");
  for (let index = 0; index < iterations; index += 1) {
    const child = spawn(cmdPath, ["/d", "/c", "exit", "0"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "exit");
  }
}

afterEach(() => {
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  clearSweepRootProcesses();
});

describe("terminateProcessTree against real Windows processes", () => {
  it.runIf(win32Only)(
    "kills the grandchild and reports it",
    async () => {
      const { child, grandchildPid } = await startTree();

      const result = await terminateProcessTree({
        child,
        graceMs: 5_000,
        platform: "win32",
      });

      expect(result.leaderExited).toBe(true);
      expect(result.descendantsKilled).toContain(grandchildPid);
      expect(result.descendantsSkipped).toEqual([]);
      await expect(waitUntilGone(grandchildPid, 5_000)).resolves.toBe(true);
    },
    30_000,
  );

  it.runIf(win32Only)(
    "skips a descendant whose recorded CreationDate no longer matches",
    async () => {
      const { child, grandchildPid } = await startTree();
      let enumerations = 0;
      const runner: WindowsCommandRunner = async (request, options) => {
        const result = await defaultWindowsCommandRunner(request, options);
        if (request.command.toLowerCase().endsWith("taskkill.exe")) {
          return result;
        }
        enumerations += 1;
        if (enumerations !== 1) {
          return result;
        }
        const parsed: unknown = JSON.parse(
          result.stdout.replace(/^\uFEFF/u, ""),
        );
        if (!Array.isArray(parsed)) {
          return result;
        }
        const entries: Record<string, unknown>[] = parsed.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null,
        );
        for (const entry of entries) {
          if (entry.ProcessId === grandchildPid) {
            entry.CreationDate = "1999-01-01T00:00:00.0000000+00:00";
          }
        }
        return { ...result, stdout: JSON.stringify(entries) };
      };

      const result = await terminateProcessTree({
        child,
        graceMs: 5_000,
        platform: "win32",
        runner,
      });

      expect(result.descendantsKilled).not.toContain(grandchildPid);
      expect(result.descendantsSkipped).toEqual([
        {
          pid: grandchildPid,
          reason: "pid-reused",
          expectedCreationDate: "1999-01-01T00:00:00.0000000+00:00",
          observedCreationDate: expect.stringMatching(/^\d{4}-/u),
        },
      ]);
      expect(isAlive(grandchildPid)).toBe(true);
    },
    30_000,
  );

  it.runIf(win32Only)(
    "leaves unrelated processes alive while PIDs are recycled under a tree kill",
    async () => {
      const unrelated = spawnSleeper(
        ["-e", "setTimeout(() => {}, 600000)"],
        process.cwd(),
      );
      const unrelatedPid = unrelated.pid ?? 0;
      expect(Number.isSafeInteger(unrelatedPid)).toBe(true);
      const { child, grandchildPid } = await startTree();
      const leaderPid = child.pid ?? 0;
      const skipped: SkippedProcessEvent[] = [];

      const [result] = await Promise.all([
        terminateProcessTree({
          child,
          graceMs: 5_000,
          platform: "win32",
          onSkippedProcess: (event) => {
            skipped.push(event);
          },
        }),
        recyclePids(PID_RECYCLE_ITERATIONS),
      ]);

      const unrelatedAlive = isAlive(unrelatedPid);
      process.stdout.write(
        `PID_REUSE_EVIDENCE ${JSON.stringify({
          leaderPid,
          grandchildPid,
          unrelatedPid,
          unrelatedAlive,
          recycleIterations: PID_RECYCLE_ITERATIONS,
          leaderExited: result.leaderExited,
          descendantsKilled: result.descendantsKilled,
          descendantsSkipped: result.descendantsSkipped,
          skipped,
        })}\n`,
      );

      expect(unrelatedAlive).toBe(true);
      expect(result.leaderExited).toBe(true);
      await expect(waitUntilGone(leaderPid, 5_000)).resolves.toBe(true);
      await expect(waitUntilGone(grandchildPid, 5_000)).resolves.toBe(true);
      expect(skipped).toEqual(result.descendantsSkipped);
      unrelated.kill();
    },
    180_000,
  );
});

describe("Windows process enumeration against real processes", () => {
  it.runIf(win32Only)(
    "documents an under-match and an over-match",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "bb-enum-demo-"));
      const underMatch = spawnSleeper(
        ["-e", "setTimeout(() => {}, 60000)"],
        directory,
      );
      const overMatch = spawnSleeper(
        [
          "-e",
          `process.env.BB_ENUM_DEMO_DIRECTORY = ${JSON.stringify(directory)}; setTimeout(() => {}, 60000)`,
        ],
        process.cwd(),
      );
      await delay(1_000);

      const startedAt = Date.now();
      const snapshot = await takeWindowsProcessSnapshot();
      const enumerationMs = Date.now() - startedAt;
      const matches = matchWindowsProcessesUnderDirectory({
        snapshot,
        directory,
      });
      const underMatchEntry = matches.find(
        (match) => match.pid === underMatch.pid,
      );
      const overMatchEntry = matches.find(
        (match) => match.pid === overMatch.pid,
      );

      process.stdout.write(
        `ENUMERATION_EVIDENCE ${JSON.stringify({
          directory,
          enumerationMs,
          underMatchPid: underMatch.pid,
          underMatchMissed: underMatchEntry === undefined,
          overMatchPid: overMatch.pid,
          overMatchEvidence: overMatchEntry?.matchEvidence ?? null,
          matchedPids: matches.map((match) => match.pid),
        })}\n`,
      );

      expect(underMatchEntry).toBeUndefined();
      expect(overMatchEntry?.matchEvidence).toBe("command-line");
      expect(overMatchEntry?.approximateCwd).toBe(true);

      underMatch.kill();
      overMatch.kill();
      await Promise.all([once(underMatch, "exit"), once(overMatch, "exit")]);
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    },
    60_000,
  );
});
