import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnPiRpcChild, type PiRpcSpawn } from "./rpc-child.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeBinDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-pi-launch-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(directory: string, name: string): string {
  const filePath = join(directory, name);
  writeFileSync(filePath, "@echo off\n");
  try {
    chmodSync(filePath, 0o755);
  } catch {}
  return filePath;
}

function recordingSpawn(): {
  calls: { command: string; args: readonly string[]; options: object }[];
  spawnImpl: PiRpcSpawn;
} {
  const calls: { command: string; args: readonly string[]; options: object }[] =
    [];
  return {
    calls,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return spawn(
        process.execPath,
        ["-e", "setTimeout(() => process.exit(0), 50);"],
        { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
      );
    },
  };
}

function childCallbacks() {
  return {
    onEvent: () => undefined,
    onChannelMessage: () => undefined,
    onExit: () => undefined,
    recordThreadId: null,
  };
}

describe("spawnPiRpcChild", () => {
  it("spawns the win32-resolved launcher with a hidden console", async () => {
    const binDirectory = makeBinDirectory();
    const exePath = writeExecutable(binDirectory, "pi.exe");
    const { calls, spawnImpl } = recordingSpawn();

    const child = await spawnPiRpcChild({
      cwd: process.cwd(),
      env: { Path: binDirectory, PATHEXT: ".EXE;.CMD" },
      args: ["--mode", "rpc"],
      platform: "win32",
      spawnImpl,
      ...childCallbacks(),
    });

    try {
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe(exePath);
      expect(calls[0]?.args).toEqual(["--mode", "rpc"]);
      expect(calls[0]?.options).toMatchObject({ windowsHide: true });
    } finally {
      child.kill();
      await child.waitForExit();
    }
  });

  it("keeps the posix launch bare and passes no windowsHide key", async () => {
    const { calls, spawnImpl } = recordingSpawn();

    const child = await spawnPiRpcChild({
      cwd: process.cwd(),
      env: {},
      args: ["--mode", "rpc"],
      platform: "linux",
      spawnImpl,
      ...childCallbacks(),
    });

    try {
      expect(calls[0]?.command).toBe("pi");
      expect(calls[0]?.args).toEqual(["--mode", "rpc"]);
      expect(calls[0]?.options).not.toHaveProperty("windowsHide");
    } finally {
      child.kill();
      await child.waitForExit();
    }
  });

  it("refuses to spawn when Windows cannot resolve the launcher", async () => {
    const binDirectory = makeBinDirectory();
    const { calls, spawnImpl } = recordingSpawn();

    await expect(
      spawnPiRpcChild({
        cwd: process.cwd(),
        env: { Path: binDirectory, PATHEXT: ".EXE;.CMD" },
        args: ["--mode", "rpc"],
        platform: "win32",
        spawnImpl,
        ...childCallbacks(),
      }),
    ).rejects.toThrow("Command pi was not found on Path");
    expect(calls).toHaveLength(0);
  });
});
