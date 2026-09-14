import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSweepRootProcesses,
  killProcessesWithCwdUnder,
  listProcessesWithCwdUnder,
  stopProcessGroupLeaderFirst,
  terminateProcessTree,
  type SkippedProcessEvent,
  type TerminateProcessTreeChild,
  type WindowsCommandRequest,
  type WindowsCommandRunner,
} from "../src/index.js";

const CREATED_AT = "2026-09-14T09:00:00.0000000+00:00";
const REUSED_AT = "2026-09-14T09:30:00.0000000+00:00";
const PREDATES_LEADER_AT = "2026-09-14T08:00:00.0000000+00:00";
const TASKKILL_NOT_FOUND_EXIT_CODE = 128;
const SWEEP_DIRECTORY = "C:\\work\\bb";
const WINDOWS_ENV: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows" };

function cimProcess(
  pid: number,
  parentPid: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ProcessId: pid,
    ParentProcessId: parentPid,
    ExecutablePath: null,
    CommandLine: null,
    CreationDate: CREATED_AT,
    ...extra,
  };
}

interface FakeChild {
  child: TerminateProcessTreeChild;
  signals: NodeJS.Signals[];
}

function createFakeChild(pid: number | undefined, exited = false): FakeChild {
  const signals: NodeJS.Signals[] = [];
  const child: TerminateProcessTreeChild = {
    pid,
    exitCode: exited ? 0 : null,
    signalCode: null,
    kill(signal?: NodeJS.Signals) {
      const sent = signal ?? "SIGTERM";
      signals.push(sent);
      child.signalCode = sent;
      return true;
    },
  };
  return { child, signals };
}

function isTaskkill(request: WindowsCommandRequest): boolean {
  return request.command.toLowerCase().endsWith("taskkill.exe");
}

function createFakeRunner(snapshots: Array<Record<string, unknown>[]>): {
  requests: WindowsCommandRequest[];
  runner: WindowsCommandRunner;
} {
  const requests: WindowsCommandRequest[] = [];
  let index = 0;
  const runner: WindowsCommandRunner = async (request) => {
    requests.push(request);
    if (isTaskkill(request)) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    const entries = snapshots[Math.min(index, snapshots.length - 1)] ?? [];
    index += 1;
    return { stdout: JSON.stringify(entries), stderr: "", exitCode: 0 };
  };
  return { requests, runner };
}

function taskkillArgs(requests: WindowsCommandRequest[]): string[][] {
  return requests.filter(isTaskkill).map((request) => request.args);
}

afterEach(() => {
  clearSweepRootProcesses();
});

describe("terminateProcessTree on win32", () => {
  it("asks the tree to close, force-kills the leader through the handle, then the descendants", async () => {
    const leader = createFakeChild(1000);
    const tree = [
      cimProcess(1000, 1),
      cimProcess(1001, 1000),
      cimProcess(1002, 1001),
    ];
    const { requests, runner } = createFakeRunner([tree, tree]);

    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });

    expect(taskkillArgs(requests)).toEqual([
      ["/PID", "1000", "/T"],
      ["/PID", "1001", "/F"],
      ["/PID", "1002", "/F"],
    ]);
    expect(requests.filter(isTaskkill)[0]?.command).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(leader.signals).toEqual(["SIGKILL"]);
    expect(result.descendantsKilled.sort()).toEqual([1001, 1002]);
    expect(result.descendantsSkipped).toEqual([]);
    expect(result.leaderExited).toBe(true);
  });

  it("never signals a leader that already exited", async () => {
    const leader = createFakeChild(1000, true);
    const { requests, runner } = createFakeRunner([
      [cimProcess(1000, 1), cimProcess(1001, 1000)],
      [cimProcess(1001, 1000)],
    ]);

    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });

    expect(leader.signals).toEqual([]);
    expect(taskkillArgs(requests)).toEqual([["/PID", "1001", "/F"]]);
    expect(result.leaderExited).toBe(true);
  });

  it("never kills a descendant candidate that predates the leader", async () => {
    const leader = createFakeChild(1000);
    const tree = [
      cimProcess(1000, 1),
      cimProcess(1001, 1000, { CreationDate: PREDATES_LEADER_AT }),
      cimProcess(1002, 1000),
    ];
    const { requests, runner } = createFakeRunner([tree, tree]);

    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });

    expect(taskkillArgs(requests)).toEqual([
      ["/PID", "1000", "/T"],
      ["/PID", "1002", "/F"],
    ]);
    expect(result.descendantsKilled).toEqual([1002]);
    expect(result.descendantsSkipped).toEqual([]);
  });

  it("never kills the children of a descendant candidate that predates the leader", async () => {
    const leader = createFakeChild(1000);
    const tree = [
      cimProcess(1000, 1),
      cimProcess(2000, 1000, { CreationDate: PREDATES_LEADER_AT }),
      cimProcess(2001, 2000, { CreationDate: REUSED_AT }),
      cimProcess(1001, 1000, { CreationDate: REUSED_AT }),
    ];
    const { requests, runner } = createFakeRunner([tree, tree]);

    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });

    expect(taskkillArgs(requests)).toEqual([
      ["/PID", "1000", "/T"],
      ["/PID", "1001", "/F"],
    ]);
    expect(result.descendantsKilled).toEqual([1001]);
    expect(result.descendantsSkipped).toEqual([]);
  });

  it("keeps the leader kill when only the second snapshot fails", async () => {
    const leader = createFakeChild(1000);
    const requests: WindowsCommandRequest[] = [];
    const tree = [cimProcess(1000, 1), cimProcess(1001, 1000)];
    let enumerations = 0;
    const runner: WindowsCommandRunner = async (request) => {
      requests.push(request);
      if (isTaskkill(request)) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      enumerations += 1;
      return enumerations === 1
        ? { stdout: JSON.stringify(tree), stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "denied", exitCode: 1 };
    };

    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });

    expect(taskkillArgs(requests)).toEqual([["/PID", "1000", "/T"]]);
    expect(leader.signals).toEqual(["SIGKILL"]);
    expect(result.leaderExited).toBe(true);
    expect(result.descendantsKilled).toEqual([]);
    expect(result.descendantsSkipped).toEqual([]);
    expect(result.enumerationError?.reason).toBe("exit");
  });

  it("reports no kill when taskkill cannot find the descendant", async () => {
    const leader = createFakeChild(1000);
    const skipped: SkippedProcessEvent[] = [];
    const tree = [cimProcess(1000, 1), cimProcess(1001, 1000)];
    const runner: WindowsCommandRunner = async (request) => {
      if (isTaskkill(request)) {
        return request.args.includes("/F")
          ? {
              stdout: "",
              stderr: "not found",
              exitCode: TASKKILL_NOT_FOUND_EXIT_CODE,
            }
          : { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: JSON.stringify(tree), stderr: "", exitCode: 0 };
    };

    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
      onSkippedProcess: (event) => skipped.push(event),
    });

    expect(result.descendantsKilled).toEqual([]);
    expect(result.descendantsSkipped).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("skips and reports a descendant whose CreationDate changed", async () => {
    const leader = createFakeChild(1000);
    const skipped: SkippedProcessEvent[] = [];
    const { requests, runner } = createFakeRunner([
      [cimProcess(1000, 1), cimProcess(1001, 1000), cimProcess(1002, 1000)],
      [
        cimProcess(1001, 1000, { CreationDate: REUSED_AT }),
        cimProcess(1002, 1000),
      ],
    ]);

    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
      onSkippedProcess: (event) => skipped.push(event),
    });

    expect(taskkillArgs(requests)).toEqual([
      ["/PID", "1000", "/T"],
      ["/PID", "1002", "/F"],
    ]);
    expect(result.descendantsKilled).toEqual([1002]);
    expect(result.descendantsSkipped).toEqual([
      {
        pid: 1001,
        reason: "pid-reused",
        expectedCreationDate: CREATED_AT,
        observedCreationDate: REUSED_AT,
      },
    ]);
    expect(skipped).toEqual(result.descendantsSkipped);
  });

  it("ignores a failing tree request and reports enumeration failures instead of rejecting", async () => {
    const leader = createFakeChild(1000);
    const failingTaskkill: WindowsCommandRunner = async (request) =>
      isTaskkill(request)
        ? { stdout: "", stderr: "denied", exitCode: 1 }
        : {
            stdout: JSON.stringify([cimProcess(1000, 1)]),
            stderr: "",
            exitCode: 0,
          };
    await expect(
      terminateProcessTree({
        child: leader.child,
        graceMs: 30,
        platform: "win32",
        runner: failingTaskkill,
        env: WINDOWS_ENV,
      }),
    ).resolves.toMatchObject({ descendantsKilled: [], enumerationError: null });

    const stranded = createFakeChild(1000);
    const brokenRequests: WindowsCommandRequest[] = [];
    const brokenEnumeration: WindowsCommandRunner = async (request) => {
      brokenRequests.push(request);
      return isTaskkill(request)
        ? { stdout: "", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "denied", exitCode: 1 };
    };

    const result = await terminateProcessTree({
      child: stranded.child,
      graceMs: 30,
      platform: "win32",
      runner: brokenEnumeration,
      env: WINDOWS_ENV,
    });

    expect(taskkillArgs(brokenRequests)).toEqual([["/PID", "1000", "/T"]]);
    expect(stranded.signals).toEqual(["SIGKILL"]);
    expect(result.leaderExited).toBe(true);
    expect(result.descendantsKilled).toEqual([]);
    expect(result.descendantsSkipped).toEqual([]);
    expect(result.enumerationError?.reason).toBe("exit");
  });
});

describe("terminateProcessTree on posix", () => {
  it("kills the group and reports only the leader", async () => {
    const leader = createFakeChild(undefined);
    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "linux",
    });
    expect(leader.signals).toEqual(["SIGKILL"]);
    expect(result).toEqual({
      leaderExited: true,
      descendantsKilled: [],
      descendantsSkipped: [],
      enumerationError: null,
    });
  });
});

describe("stopProcessGroupLeaderFirst on win32", () => {
  it("delegates to terminateProcessTree with the leader timeout as the grace", async () => {
    const leader = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      {
        stdio: "ignore",
      },
    );
    const leaderPid = leader.pid ?? 0;
    const { requests, runner } = createFakeRunner([
      [cimProcess(leaderPid, 1), cimProcess(leaderPid + 1, leaderPid)],
      [cimProcess(leaderPid + 1, leaderPid)],
    ]);
    const exited = new Promise<void>((resolve) => {
      leader.once("exit", () => resolve());
    });

    await stopProcessGroupLeaderFirst({
      child: leader,
      timeoutMs: 30,
      killGraceMs: 10,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });
    await exited;

    expect(taskkillArgs(requests)).toEqual([
      ["/PID", String(leaderPid), "/T"],
      ["/PID", String(leaderPid + 1), "/F"],
    ]);
    expect(leader.signalCode).toBe("SIGKILL");
  });
});

describe("listProcessesWithCwdUnder on win32", () => {
  it("enumerates and matches instead of returning an empty list", async () => {
    const { runner } = createFakeRunner([
      [
        cimProcess(1234, 1, {
          ExecutablePath: "C:\\work\\bb\\tools\\agent.exe",
        }),
        cimProcess(1235, 1234),
      ],
    ]);
    const matches = await listProcessesWithCwdUnder({
      directory: SWEEP_DIRECTORY,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });
    expect(matches.map((match) => match.pid).sort()).toEqual([1234, 1235]);
    expect(matches.every((match) => match.approximateCwd === true)).toBe(true);
  });

  it("propagates enumeration failures", async () => {
    const brokenRunner: WindowsCommandRunner = async () => ({
      stdout: "",
      stderr: "denied",
      exitCode: 1,
    });
    await expect(
      listProcessesWithCwdUnder({
        directory: SWEEP_DIRECTORY,
        platform: "win32",
        runner: brokenRunner,
        env: WINDOWS_ENV,
      }),
    ).rejects.toMatchObject({ reason: "exit" });
  });
});

describe("killProcessesWithCwdUnder on win32", () => {
  it("lists command-line matches but force-kills only path-anchored ones", async () => {
    const tree = [
      cimProcess(2000, 1, {
        ExecutablePath: "C:\\tools\\editor.exe",
        CommandLine: '"C:\\tools\\editor.exe" "C:\\work\\bb\\src"',
      }),
      cimProcess(2001, 2000, { ExecutablePath: "C:\\tools\\helper.exe" }),
      cimProcess(3000, 1, { ExecutablePath: "C:\\work\\bb\\tools\\agent.exe" }),
      cimProcess(3001, 3000, { ExecutablePath: "C:\\tools\\helper.exe" }),
    ];

    const listed = await listProcessesWithCwdUnder({
      directory: SWEEP_DIRECTORY,
      platform: "win32",
      runner: createFakeRunner([tree]).runner,
      env: WINDOWS_ENV,
    });
    expect(listed.map((entry) => entry.pid).sort()).toEqual([
      2000, 2001, 3000, 3001,
    ]);

    const { requests, runner } = createFakeRunner([tree, tree, []]);
    const killed = await killProcessesWithCwdUnder({
      directory: SWEEP_DIRECTORY,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });

    expect(killed.map((entry) => entry.pid).sort()).toEqual([3000, 3001]);
    expect(taskkillArgs(requests)).toEqual([
      ["/PID", "3000", "/F"],
      ["/PID", "3001", "/F"],
    ]);
  });

  it("verifies CreationDate against a fresh snapshot before each kill round", async () => {
    const skipped: SkippedProcessEvent[] = [];
    const first = [
      cimProcess(1234, 1, { ExecutablePath: "C:\\work\\bb\\tools\\agent.exe" }),
      cimProcess(1235, 1, { ExecutablePath: "C:\\work\\bb\\tools\\other.exe" }),
    ];
    const verification = [
      cimProcess(1234, 1, {
        ExecutablePath: "C:\\work\\bb\\tools\\agent.exe",
        CreationDate: REUSED_AT,
      }),
      cimProcess(1235, 1, { ExecutablePath: "C:\\work\\bb\\tools\\other.exe" }),
    ];
    const { requests, runner } = createFakeRunner([first, verification, []]);

    const killed = await killProcessesWithCwdUnder({
      directory: SWEEP_DIRECTORY,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
      onSkippedProcess: (event) => skipped.push(event),
    });

    expect(taskkillArgs(requests)).toEqual([["/PID", "1235", "/F"]]);
    expect(killed.map((entry) => entry.pid)).toEqual([1235]);
    expect(skipped).toEqual([
      {
        pid: 1234,
        reason: "pid-reused",
        expectedCreationDate: CREATED_AT,
        observedCreationDate: REUSED_AT,
      },
    ]);
  });

  it("stops once a round finds nothing and propagates enumeration failures", async () => {
    const { requests, runner } = createFakeRunner([[]]);
    await expect(
      killProcessesWithCwdUnder({
        directory: SWEEP_DIRECTORY,
        platform: "win32",
        runner,
        env: WINDOWS_ENV,
      }),
    ).resolves.toEqual([]);
    expect(taskkillArgs(requests)).toEqual([]);

    const brokenRunner: WindowsCommandRunner = async () => {
      throw new Error("spawn ENOENT");
    };
    await expect(
      killProcessesWithCwdUnder({
        directory: SWEEP_DIRECTORY,
        platform: "win32",
        runner: brokenRunner,
        env: WINDOWS_ENV,
      }),
    ).rejects.toMatchObject({ reason: "spawn" });
  });
});
