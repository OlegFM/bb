import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAcpAgentConnection,
  resolveAcpAgentLaunch,
  type AcpAgentSpawn,
} from "./agent-connection.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeBinDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-acp-launch-"));
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
  spawnImpl: AcpAgentSpawn;
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
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    },
  };
}

describe("resolveAcpAgentLaunch", () => {
  it("resolves a bare agent name through Path and PATHEXT on win32", async () => {
    const binDirectory = makeBinDirectory();
    const exePath = writeExecutable(binDirectory, "cursor-agent.exe");

    await expect(
      resolveAcpAgentLaunch({
        command: "cursor-agent",
        args: ["--acp"],
        env: { Path: binDirectory, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
      }),
    ).resolves.toEqual({ command: exePath, args: ["--acp"] });
  });

  it("is the identity on a posix platform", async () => {
    await expect(
      resolveAcpAgentLaunch({
        command: "cursor-agent",
        args: ["--acp"],
        env: {},
        platform: "linux",
      }),
    ).resolves.toEqual({ command: "cursor-agent", args: ["--acp"] });
  });

  it("reports an unresolvable Windows agent instead of spawning it", async () => {
    const binDirectory = makeBinDirectory();

    await expect(
      resolveAcpAgentLaunch({
        command: "cursor-agent",
        args: [],
        env: { Path: binDirectory, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
      }),
    ).rejects.toThrow("Command cursor-agent was not found on Path");
  });
});

describe("createAcpAgentConnection spawn options", () => {
  it("hides the console window on win32", async () => {
    const { calls, spawnImpl } = recordingSpawn();
    const connection = createAcpAgentConnection({
      recordThreadId: null,
      command: "C:\\Agents\\cursor-agent.exe",
      args: ["--acp"],
      cwd: process.cwd(),
      env: process.env,
      platform: "win32",
      spawnImpl,
      onNotification() {},
      onRequest() {},
      onExit() {},
    });

    try {
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe("C:\\Agents\\cursor-agent.exe");
      expect(calls[0]?.args).toEqual(["--acp"]);
      expect(calls[0]?.options).toMatchObject({ windowsHide: true });
    } finally {
      connection.kill();
    }
  });

  it("passes no windowsHide key on a posix platform", async () => {
    const { calls, spawnImpl } = recordingSpawn();
    const connection = createAcpAgentConnection({
      recordThreadId: null,
      command: "cursor-agent",
      args: ["--acp"],
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
      spawnImpl,
      onNotification() {},
      onRequest() {},
      onExit() {},
    });

    try {
      expect(calls[0]?.command).toBe("cursor-agent");
      expect(calls[0]?.options).not.toHaveProperty("windowsHide");
    } finally {
      connection.kill();
    }
  });
});
