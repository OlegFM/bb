import { describe, expect, it } from "vitest";
import { runCommandCapture, SpawnPlanUnavailableError } from "../src/index.js";

describe("runCommandCapture", () => {
  it("captures stdout and stderr and reports a clean exit", async () => {
    const result = await runCommandCapture({
      command: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.spawnError).toBeNull();
  });

  it("reports a non-zero exit code", async () => {
    const result = await runCommandCapture({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it(
    "times out and kills the child",
    async () => {
      const result = await runCommandCapture({
        command: process.execPath,
        args: ["-e", "setTimeout(()=>{}, 60000)"],
        timeoutMs: 300,
      });
      expect(result.timedOut).toBe(true);
      expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
    },
    process.platform === "win32" ? 15000 : 5000,
  );

  it("caps captured output at maxBytes and marks it truncated", async () => {
    const result = await runCommandCapture({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(200000))"],
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  });

  it("kills the child once the cap is hit", async () => {
    const result = await runCommandCapture({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(1025)); setTimeout(() => {}, 60000)",
      ],
      timeoutMs: 20000,
      maxBytes: 1024,
    });
    expect(result.truncated).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 15000);

  it.runIf(process.platform === "win32")(
    "rejects with SpawnPlanUnavailableError for a command not found on Path",
    async () => {
      await expect(
        runCommandCapture({
          command: "definitely-missing-tool-xyz",
          args: [],
          timeoutMs: 5000,
        }),
      ).rejects.toMatchObject({
        reason: "not_found",
      });
      await expect(
        runCommandCapture({
          command: "definitely-missing-tool-xyz",
          args: [],
          timeoutMs: 5000,
        }),
      ).rejects.toBeInstanceOf(SpawnPlanUnavailableError);
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolves with a spawnError for a command not found on POSIX",
    async () => {
      const result = await runCommandCapture({
        command: "definitely-missing-tool-xyz",
        args: [],
        timeoutMs: 5000,
      });
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.truncated).toBe(false);
      expect(result.spawnError).toContain("ENOENT");
    },
  );
});
