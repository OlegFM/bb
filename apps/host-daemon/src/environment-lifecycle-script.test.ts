import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  queryWindowsProcess,
  resolveWindowsSystemToolPath,
  spawnPortableProcess,
} from "@bb/process-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSetupScriptCommand,
  buildTeardownScriptCommand,
  resolveLifecycleScript,
  runSetupScript,
  runTeardownScript,
} from "./environment-lifecycle-script.js";

const directories: string[] = [];
const spawnedWindowsPids: number[] = [];

function trackWindowsPid(pid: number): void {
  if (Number.isSafeInteger(pid) && pid > 0) {
    spawnedWindowsPids.push(pid);
  }
}

function isWindowsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function forceKillWindowsPid(pid: number): Promise<void> {
  await new Promise((resolveKill) => {
    const kill = spawnPortableProcess({
      command: resolveWindowsSystemToolPath("taskkill.exe", process.env),
      args: ["/PID", String(pid), "/F"],
      platform: "win32",
      stdio: "ignore",
    });
    kill.once("error", () => resolveKill(undefined));
    kill.once("exit", () => resolveKill(undefined));
  });
}

async function workspace(
  kind: "setup" | "teardown",
  script: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-core-hooks-"));
  directories.push(directory);
  await writeFile(join(directory, `.bb-env-${kind}.sh`), script);
  return directory;
}

async function powerShellWorkspace(
  kind: "setup" | "teardown",
  script: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-core-hooks-"));
  directories.push(directory);
  await writeFile(join(directory, `.bb-env-${kind}.ps1`), script);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const pids = spawnedWindowsPids.splice(0);
  if (process.platform === "win32") {
    for (const pid of pids) {
      if (isWindowsPidAlive(pid)) {
        await forceKillWindowsPid(pid);
      }
    }
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "core environment scripts",
  () => {
    it("runs in the environment directory and streams stdout and stderr", async () => {
      const workspacePath = await workspace(
        "setup",
        "pwd > marker\nprintf 'first\\rsecond\\n'\necho stderr >&2\n",
      );
      const output: string[] = [];
      await runSetupScript({
        workspacePath,
        timeoutMs: 5000,
        onProgress: (entry) => output.push(entry.text),
      });
      expect(
        (await readFile(join(workspacePath, "marker"), "utf8")).trim(),
      ).toBe(await realpath(workspacePath));
      expect(output).toContain("second");
      expect(output).toContain("stderr");
      expect(output).toContain("Running .bb-env-setup.sh");
    });

    it("surfaces output before setup failure", async () => {
      const workspacePath = await workspace(
        "setup",
        "echo failed-details >&2\nexit 7\n",
      );
      const output: string[] = [];
      await expect(
        runSetupScript({
          workspacePath,
          timeoutMs: 5000,
          onProgress: (entry) => output.push(entry.text),
        }),
      ).rejects.toThrow("exit code 7");
      expect(output).toContain("failed-details");
    });

    it.each(["setup", "teardown"] as const)(
      "enforces the %s timeout",
      async (kind) => {
        const workspacePath = await workspace(
          kind,
          "echo before-timeout\nsleep 120\n",
        );
        const output: string[] = [];
        const run = kind === "setup" ? runSetupScript : runTeardownScript;
        const result = run({
          workspacePath,
          timeoutMs: 100,
          onProgress: (entry) => output.push(entry.text),
        });
        if (kind === "setup")
          await expect(result).rejects.toThrow("timed out after 100ms");
        else {
          await expect(result).resolves.toEqual({ ran: true });
          expect(output.join("\n")).toContain("timed out after 100ms");
        }
      },
    );

    it("reports teardown failure without rejecting removal", async () => {
      const workspacePath = await workspace(
        "teardown",
        "echo teardown-details\nexit 9\n",
      );
      const output: string[] = [];
      await expect(
        runTeardownScript({
          workspacePath,
          timeoutMs: 5000,
          onProgress: (entry) => output.push(entry.text),
        }),
      ).resolves.toEqual({ ran: true });
      expect(output.join("\n")).toContain("exit code 9");
      expect(output).toContain("teardown-details");
    });

    it("cancels a running setup before returning to cleanup", async () => {
      const workspacePath = await workspace(
        "setup",
        "echo started\nsleep 120\n",
      );
      const controller = new AbortController();
      await expect(
        runSetupScript({
          workspacePath,
          timeoutMs: 5000,
          signal: controller.signal,
          onProgress: (entry) => {
            if (entry.text === "started") controller.abort();
          },
        }),
      ).rejects.toThrow("cancelled");
    });

    it("skips absent scripts", async () => {
      const workspacePath = await workspace("setup", "exit 0\n");
      await expect(
        runTeardownScript({ workspacePath, timeoutMs: 5000 }),
      ).resolves.toEqual({ ran: false });
    });
  },
);

describe("windows environment scripts", () => {
  it("fails setup when only the POSIX hook exists on Windows", async () => {
    const workspacePath = await workspace("setup", "exit 0\n");
    const output: string[] = [];

    await expect(
      runSetupScript({
        workspacePath,
        timeoutMs: 5_000,
        platform: "win32",
        onProgress: (entry) => output.push(entry.text),
      }),
    ).rejects.toThrow(
      ".bb-env-setup.sh is a POSIX shell script; on Windows bb runs .bb-env-setup.ps1 instead (pwsh.exe or powershell.exe)",
    );
    expect(output).toEqual([".bb-env-setup.sh failed"]);
  });

  it("reports a POSIX-only teardown on Windows without blocking removal", async () => {
    const workspacePath = await workspace("teardown", "exit 0\n");
    const output: string[] = [];

    await expect(
      runTeardownScript({
        workspacePath,
        timeoutMs: 5_000,
        platform: "win32",
        onProgress: (entry) => output.push(entry.text),
      }),
    ).resolves.toEqual({ ran: true });
    expect(output.join("\n")).toContain(
      ".bb-env-teardown.sh is a POSIX shell script; on Windows bb runs .bb-env-teardown.ps1 instead (pwsh.exe or powershell.exe)",
    );
  });

  it("prefers the PowerShell hook when both hooks exist", async () => {
    const workspacePath = await workspace("setup", "exit 0\n");
    await writeFile(join(workspacePath, ".bb-env-setup.ps1"), "exit 0\r\n");

    await expect(
      resolveLifecycleScript({
        kind: "setup",
        platform: "win32",
        workspacePath,
      }),
    ).resolves.toEqual({
      scriptPath: join(workspacePath, ".bb-env-setup.ps1"),
      scriptName: ".bb-env-setup.ps1",
      posixOnly: false,
    });
    await expect(
      resolveLifecycleScript({
        kind: "setup",
        platform: "linux",
        workspacePath,
      }),
    ).resolves.toEqual({
      scriptPath: join(workspacePath, ".bb-env-setup.sh"),
      scriptName: ".bb-env-setup.sh",
      posixOnly: false,
    });
  });

  it("builds a non-interactive PowerShell -File command", () => {
    const command = buildSetupScriptCommand({
      env: {
        Path: "C:\\Windows\\System32",
        ProgramFiles: "C:\\Program Files",
        SystemRoot: "C:\\Windows",
      },
      platform: "win32",
      scriptPath: "C:\\ws\\.bb-env-setup.ps1",
    });

    expect(command.command.toLowerCase()).toMatch(/(pwsh|powershell)\.exe$/u);
    expect(command.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\ws\\.bb-env-setup.ps1",
    ]);
    expect(command.text).toMatch(
      /^(pwsh|powershell) -File \.bb-env-setup\.ps1$/u,
    );
  });

  it("builds the teardown command and refuses a POSIX teardown hook", () => {
    const command = buildTeardownScriptCommand({
      env: {
        Path: "C:\\Windows\\System32",
        ProgramFiles: "C:\\Program Files",
        SystemRoot: "C:\\Windows",
      },
      platform: "win32",
      scriptPath: "C:\\ws\\.bb-env-teardown.ps1",
    });

    expect(command.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\ws\\.bb-env-teardown.ps1",
    ]);
    expect(command.text).toMatch(
      /^(pwsh|powershell) -File \.bb-env-teardown\.ps1$/u,
    );
    expect(() =>
      buildTeardownScriptCommand({
        env: { SystemRoot: "C:\\Windows" },
        platform: "win32",
        scriptPath: "C:\\ws\\.bb-env-teardown.sh",
      }),
    ).toThrow(
      ".bb-env-teardown.sh is a POSIX shell script; on Windows bb runs .bb-env-teardown.ps1 instead (pwsh.exe or powershell.exe)",
    );
  });

  it.runIf(process.platform === "win32")(
    "streams PowerShell hook output",
    async () => {
      const workspacePath = await powerShellWorkspace(
        "setup",
        [
          'Write-Output "first"',
          'Write-Output "second"',
          '[Console]::Error.WriteLine("third")',
          "exit 0",
          "",
        ].join("\r\n"),
      );
      const output: string[] = [];

      await expect(
        runSetupScript({
          workspacePath,
          timeoutMs: 60_000,
          onProgress: (entry) => {
            if (entry.type === "output") output.push(entry.text);
          },
        }),
      ).resolves.toMatchObject({ ran: true, exitCode: 0 });

      expect(output).toHaveLength(3);
      expect(output).toEqual(
        expect.arrayContaining(["first", "second", "third"]),
      );
      expect(output.indexOf("first")).toBeLessThan(output.indexOf("second"));
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "times out a sleeping PowerShell hook",
    async () => {
      const workspacePath = await powerShellWorkspace(
        "setup",
        "Start-Sleep -Seconds 30\r\n",
      );

      await expect(
        runSetupScript({ workspacePath, timeoutMs: 1_000 }),
      ).rejects.toThrow("timed out after 1000ms");
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "reports the exit code of a failing PowerShell hook",
    async () => {
      const workspacePath = await powerShellWorkspace(
        "setup",
        ['Write-Output "before"', "exit 3", ""].join("\r\n"),
      );

      await expect(
        runSetupScript({ workspacePath, timeoutMs: 60_000 }),
      ).rejects.toThrow("Setup script failed with exit code 3");
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "cancels a PowerShell hook and leaves no descendant",
    async () => {
      const workspacePath = await powerShellWorkspace(
        "setup",
        [
          'Write-Output ("hook-pid=" + $PID)',
          `& '${process.execPath}' (Join-Path $PSScriptRoot 'spawn-descendant.mjs') (Join-Path $PSScriptRoot 'pids.txt')`,
          "",
        ].join("\r\n"),
      );
      await writeFile(
        join(workspacePath, "spawn-descendant.mjs"),
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync, writeSync } from "node:fs";',
          'const detached = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], {',
          "  detached: true,",
          '  stdio: "ignore",',
          "});",
          "detached.unref();",
          "writeFileSync(process.argv[2], `${process.pid} ${detached.pid}`);",
          'writeSync(1, "descendants-ready\\n");',
          "setTimeout(() => {}, 600000);",
          "",
        ].join("\n"),
      );
      const pidPath = join(workspacePath, "pids.txt");
      const controller = new AbortController();
      const descendants: number[] = [];
      let recording: Promise<void> | null = null;
      const recordDescendants = (): Promise<void> => {
        recording ??= (async () => {
          let recorded: string;
          try {
            recorded = await readFile(pidPath, "utf8");
          } catch {
            recording = null;
            return;
          }
          for (const value of recorded.split(" ")) {
            const pid = Number.parseInt(value, 10);
            descendants.push(pid);
            trackWindowsPid(pid);
          }
        })();
        return recording;
      };

      try {
        await expect(
          runSetupScript({
            workspacePath,
            timeoutMs: 30_000,
            signal: controller.signal,
            onProgress: (entry) => {
              const hookPid = /^hook-pid=(\d+)$/u.exec(entry.text)?.[1];
              if (hookPid !== undefined) {
                trackWindowsPid(Number.parseInt(hookPid, 10));
              }
              if (entry.text === "descendants-ready") {
                void recordDescendants();
                controller.abort();
              }
            },
          }),
        ).rejects.toThrow("cancelled");

        await recordDescendants();
        expect(descendants).toHaveLength(2);
        expect(descendants.every(Number.isSafeInteger)).toBe(true);
        await expect(
          queryWindowsProcess(descendants[0] ?? 0),
        ).resolves.toBeNull();
        await expect(
          queryWindowsProcess(descendants[1] ?? 0),
        ).resolves.toBeNull();
      } finally {
        await recordDescendants();
        for (const pid of descendants) {
          if (!Number.isSafeInteger(pid) || pid <= 0) {
            continue;
          }
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    },
    120_000,
  );
});
