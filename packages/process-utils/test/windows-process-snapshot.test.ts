import { afterEach, describe, expect, it } from "vitest";
import {
  buildWindowsProcessEnumRequest,
  clearSweepRootProcesses,
  isWindowsPathUnderDirectory,
  matchWindowsProcessesUnderDirectory,
  parseWindowsProcessSnapshot,
  queryWindowsProcess,
  registerSweepRootProcess,
  takeWindowsProcessSnapshot,
  unregisterSweepRootProcess,
  WINDOWS_PROCESS_ENUM_TIMEOUT_MS,
  WindowsProcessEnumerationError,
  type WindowsCommandRequest,
  type WindowsCommandResult,
  type WindowsCommandRunner,
} from "../src/index.js";

const CREATED_AT = "2026-09-14T09:00:00.0000000+00:00";
const SWEEP_DIRECTORY = "C:\\work\\bb";
const WINDOWS_ENV: NodeJS.ProcessEnv = {
  Path: "C:\\nowhere",
  SystemRoot: "C:\\Windows",
};

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

const CIM_SAMPLE = JSON.stringify([
  cimProcess(4, 0, { CreationDate: null }),
  cimProcess(624, 4, {
    ExecutablePath: "C:\\Windows\\System32\\services.exe",
    CommandLine: "C:\\Windows\\system32\\services.exe",
  }),
  cimProcess(1234, 624, {
    ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
    CommandLine:
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\bb\\scripts\\start-bb.mjs"',
  }),
  cimProcess(4242, 1234, {
    ExecutablePath: "C:\\work\\bb\\tools\\agent.exe",
    CommandLine: '"C:\\work\\bb\\tools\\agent.exe" --workspace C:\\work\\bb',
  }),
  cimProcess(4243, 4242, {
    ExecutablePath: "C:\\Windows\\System32\\cmd.exe",
    CommandLine: "cmd.exe /d /c build",
  }),
]);

function okResult(stdout: string): WindowsCommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fixedRunner(
  results: WindowsCommandResult[],
  requests: WindowsCommandRequest[] = [],
): WindowsCommandRunner {
  let index = 0;
  return async (request) => {
    requests.push(request);
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result === undefined) {
      throw new Error("no result configured");
    }
    return result;
  };
}

afterEach(() => {
  clearSweepRootProcesses();
});

describe("buildWindowsProcessEnumRequest", () => {
  it("runs PowerShell non-interactively and projects CreationDate", () => {
    const request = buildWindowsProcessEnumRequest(WINDOWS_ENV);
    expect(request.command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(request.args.slice(0, 5)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
    ]);
    expect(request.args[5]).toBe("-Command");
    expect(request.args[6]).toContain("Get-CimInstance Win32_Process");
    expect(request.args[6]).toContain("CreationDate");
    expect(request.args[6]).toContain("ConvertTo-Json -Compress");
  });

  it("pins the default enumeration timeout", () => {
    expect(WINDOWS_PROCESS_ENUM_TIMEOUT_MS).toBe(10_000);
  });
});

describe("parseWindowsProcessSnapshot", () => {
  it("parses a realistic payload including CreationDate", () => {
    const snapshot = parseWindowsProcessSnapshot(CIM_SAMPLE);
    expect(snapshot).toHaveLength(5);
    expect(snapshot[0]).toEqual({
      pid: 4,
      parentPid: 0,
      executablePath: null,
      commandLine: null,
      creationDate: null,
    });
    expect(snapshot[3]).toEqual({
      pid: 4242,
      parentPid: 1234,
      executablePath: "C:\\work\\bb\\tools\\agent.exe",
      commandLine: '"C:\\work\\bb\\tools\\agent.exe" --workspace C:\\work\\bb',
      creationDate: CREATED_AT,
    });
  });

  it("wraps a single object payload", () => {
    expect(
      parseWindowsProcessSnapshot(JSON.stringify(cimProcess(9, 1))),
    ).toEqual([
      {
        pid: 9,
        parentPid: 1,
        executablePath: null,
        commandLine: null,
        creationDate: CREATED_AT,
      },
    ]);
  });

  it("tolerates a leading byte-order mark and empty payloads", () => {
    expect(
      parseWindowsProcessSnapshot(
        `\uFEFF${JSON.stringify([cimProcess(9, 1)])}`,
      ),
    ).toHaveLength(1);
    expect(parseWindowsProcessSnapshot("")).toEqual([]);
    expect(parseWindowsProcessSnapshot("   \r\n")).toEqual([]);
    expect(parseWindowsProcessSnapshot("null")).toEqual([]);
  });

  it("skips entries without a usable process id", () => {
    expect(
      parseWindowsProcessSnapshot(
        JSON.stringify([
          { ProcessId: null },
          { ProcessId: 0 },
          cimProcess(7, 1),
        ]),
      ),
    ).toHaveLength(1);
  });

  it("throws on output that is not JSON", () => {
    expect(() =>
      parseWindowsProcessSnapshot("Get-CimInstance : denied"),
    ).toThrow(WindowsProcessEnumerationError);
  });
});

describe("takeWindowsProcessSnapshot", () => {
  it("returns the parsed snapshot", async () => {
    await expect(
      takeWindowsProcessSnapshot({
        runner: fixedRunner([okResult(CIM_SAMPLE)]),
        env: WINDOWS_ENV,
      }),
    ).resolves.toHaveLength(5);
  });

  it("rejects instead of returning an empty list when the probe hangs", async () => {
    const hangingRunner: WindowsCommandRunner = () => new Promise(() => {});
    await expect(
      takeWindowsProcessSnapshot({
        runner: hangingRunner,
        timeoutMs: 20,
        env: WINDOWS_ENV,
      }),
    ).rejects.toMatchObject({
      name: "WindowsProcessEnumerationError",
      reason: "timeout",
    });
  });

  it("rejects on a non-zero exit code", async () => {
    await expect(
      takeWindowsProcessSnapshot({
        runner: fixedRunner([{ stdout: "", stderr: "denied", exitCode: 1 }]),
        env: WINDOWS_ENV,
      }),
    ).rejects.toMatchObject({ reason: "exit" });
  });

  it("rejects when the probe cannot start", async () => {
    const failingRunner: WindowsCommandRunner = async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    await expect(
      takeWindowsProcessSnapshot({ runner: failingRunner, env: WINDOWS_ENV }),
    ).rejects.toMatchObject({ reason: "spawn" });
  });

  it("rejects when the output cannot be parsed", async () => {
    await expect(
      takeWindowsProcessSnapshot({
        runner: fixedRunner([okResult("not json")]),
        env: WINDOWS_ENV,
      }),
    ).rejects.toMatchObject({ reason: "parse" });
  });

  it("prunes spawn-registry entries whose pid is gone", async () => {
    registerSweepRootProcess({ pid: 4242, cwd: SWEEP_DIRECTORY });
    registerSweepRootProcess({ pid: 99999, cwd: SWEEP_DIRECTORY });
    const snapshot = await takeWindowsProcessSnapshot({
      runner: fixedRunner([okResult(CIM_SAMPLE)]),
      env: WINDOWS_ENV,
    });
    const matches = matchWindowsProcessesUnderDirectory({
      snapshot,
      directory: SWEEP_DIRECTORY,
    });
    expect(matches.map((match) => match.pid)).not.toContain(99999);
  });
});

describe("queryWindowsProcess", () => {
  it("filters on the process id and returns null when absent", async () => {
    const requests: WindowsCommandRequest[] = [];
    await expect(
      queryWindowsProcess(4242, {
        runner: fixedRunner(
          [okResult(JSON.stringify(cimProcess(4242, 1234)))],
          requests,
        ),
        env: WINDOWS_ENV,
      }),
    ).resolves.toMatchObject({ pid: 4242, creationDate: CREATED_AT });
    expect(requests[0]?.args.at(-1)).toContain('-Filter "ProcessId = 4242"');
    await expect(
      queryWindowsProcess(4242, {
        runner: fixedRunner([okResult("")]),
        env: WINDOWS_ENV,
      }),
    ).resolves.toBeNull();
  });
});

describe("isWindowsPathUnderDirectory", () => {
  it.each([
    ["C:\\work\\bb\\tools\\agent.exe", "C:\\work\\bb", true],
    ["C:/work/bb/tools/agent.exe", "C:\\work\\bb", true],
    ["c:\\WORK\\bb", "C:\\work\\bb", true],
    ["C:\\work\\bb", "C:\\work\\bb\\", true],
    ["C:\\work\\bb-other\\x.exe", "C:\\work\\bb", false],
    ["\\\\?\\C:\\work\\bb\\agent.exe", "C:\\work\\bb", true],
    ["\\\\server\\share\\job.exe", "\\\\server\\share", true],
    ["\\\\?\\UNC\\server\\share\\job.exe", "\\\\server\\share", true],
    ["C:\\proyectos\\diseño\\app.exe", "C:\\proyectos\\diseño", true],
    ["C:\\work\\bb", "C:\\", true],
    ["D:\\other\\x.exe", "C:\\work", false],
  ])("compares %s against %s as %s", (candidate, directory, expected) => {
    expect(isWindowsPathUnderDirectory(candidate, directory)).toBe(expected);
  });
});

describe("matchWindowsProcessesUnderDirectory", () => {
  it("reports how each match was reached and carries CreationDate", () => {
    const snapshot = parseWindowsProcessSnapshot(CIM_SAMPLE);
    const matches = matchWindowsProcessesUnderDirectory({
      snapshot,
      directory: SWEEP_DIRECTORY,
    });
    const byPid = new Map(matches.map((match) => [match.pid, match]));
    expect(byPid.get(1234)).toEqual({
      pid: 1234,
      cwd: "C:\\work\\bb\\scripts\\start-bb.mjs",
      approximateCwd: true,
      matchEvidence: "command-line",
      creationDate: CREATED_AT,
    });
    expect(byPid.get(4242)?.matchEvidence).toBe("executable-path");
    expect(byPid.get(4243)?.matchEvidence).toBe("descendant");
    expect(byPid.get(624)).toBeUndefined();
  });

  it("matches processes the current runtime registered itself", () => {
    registerSweepRootProcess({ pid: 4243, cwd: "C:\\work\\bb\\worktree" });
    const matches = matchWindowsProcessesUnderDirectory({
      snapshot: parseWindowsProcessSnapshot(CIM_SAMPLE),
      directory: SWEEP_DIRECTORY,
    });
    expect(matches.find((match) => match.pid === 4243)?.matchEvidence).toBe(
      "spawn-registry",
    );
    unregisterSweepRootProcess(4243);
    expect(
      matchWindowsProcessesUnderDirectory({
        snapshot: parseWindowsProcessSnapshot(CIM_SAMPLE),
        directory: SWEEP_DIRECTORY,
      }).find((match) => match.pid === 4243)?.matchEvidence,
    ).toBe("descendant");
  });

  it("excludes the sweeping process and everything below it", () => {
    const matches = matchWindowsProcessesUnderDirectory({
      snapshot: parseWindowsProcessSnapshot(CIM_SAMPLE),
      directory: SWEEP_DIRECTORY,
      selfPid: 4242,
    });
    expect(matches.map((match) => match.pid).sort()).toEqual([1234]);
  });

  it("leaves unrelated processes alone", () => {
    expect(
      matchWindowsProcessesUnderDirectory({
        snapshot: parseWindowsProcessSnapshot(CIM_SAMPLE),
        directory: "C:\\elsewhere",
      }),
    ).toEqual([]);
  });
});
