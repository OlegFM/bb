import { realpathSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BB_CLI_REEXEC_ENV,
  maybeReexecViaBbCli,
  resolveNodeLauncherSpawnPlan,
} from "../bb-cli-reexec.js";

describe("maybeReexecViaBbCli", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bb-cli-reexec-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writeExecutable(name: string): Promise<string> {
    const path = join(tempRoot, name);
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(path, 0o755);
    return path;
  }

  it("no-ops when BB_CLI is unset", () => {
    const reexec = vi.fn();
    maybeReexecViaBbCli({
      env: {},
      currentExecutablePath: "/tmp/current-bb",
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("no-ops when BB_CLI equals the current executable", async () => {
    const path = await writeExecutable("bb");
    const reexec = vi.fn();
    maybeReexecViaBbCli({
      env: { BB_CLI: path },
      currentExecutablePath: path,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("no-ops when already in a re-exec hop", async () => {
    const current = await writeExecutable("current");
    const target = await writeExecutable("target");
    const reexec = vi.fn();
    maybeReexecViaBbCli({
      env: { BB_CLI: target, [BB_CLI_REEXEC_ENV]: "1" },
      currentExecutablePath: current,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("re-execs to BB_CLI when it differs from the current entry", async () => {
    const current = await writeExecutable("current");
    const target = await writeExecutable("target");
    const reexec = vi.fn();
    maybeReexecViaBbCli({
      env: { BB_CLI: target, BB_SERVER_URL: "http://127.0.0.1:1" },
      currentExecutablePath: current,
      argv: ["status", "--json"],
      reexec,
    });
    expect(reexec).toHaveBeenCalledOnce();
    expect(reexec.mock.calls[0]?.[0]).toEqual({
      target: realpathSync(target),
      argv: ["status", "--json"],
      env: expect.objectContaining({
        BB_CLI: target,
        BB_SERVER_URL: "http://127.0.0.1:1",
        [BB_CLI_REEXEC_ENV]: "1",
      }),
    });
  });

  it("no-ops when BB_CLI path is missing", async () => {
    const current = await writeExecutable("current");
    const reexec = vi.fn();
    maybeReexecViaBbCli({
      env: { BB_CLI: join(tempRoot, "does-not-exist") },
      currentExecutablePath: current,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });
});

describe("resolveNodeLauncherSpawnPlan", () => {
  let planRoot: string;

  beforeEach(async () => {
    planRoot = await mkdtemp(join(tmpdir(), "bb-cli-plan-"));
  });

  afterEach(async () => {
    await rm(planRoot, { recursive: true, force: true });
  });

  it("spawns a POSIX launcher directly", async () => {
    await expect(
      resolveNodeLauncherSpawnPlan("/opt/bb/bin/bb", "darwin"),
    ).resolves.toEqual({ command: "/opt/bb/bin/bb", argsPrefix: [] });
    await expect(
      resolveNodeLauncherSpawnPlan("/opt/bb/bin/bb.cmd", "darwin"),
    ).resolves.toEqual({ command: "/opt/bb/bin/bb.cmd", argsPrefix: [] });
  });

  it("reads the node shim of a Windows .cmd launcher", async () => {
    const script = join(planRoot, "bb");
    await writeFile(script, "");
    await writeFile(join(planRoot, "bb.cmd"), '@node "%~dp0bb" %*\r\n');
    await writeFile(join(planRoot, "bb.CMD"), '@node "%~dp0bb" %*\r\n');

    await expect(
      resolveNodeLauncherSpawnPlan(join(planRoot, "bb.cmd"), "win32"),
    ).resolves.toEqual({ command: process.execPath, argsPrefix: [script] });
    await expect(
      resolveNodeLauncherSpawnPlan(join(planRoot, "bb.CMD"), "win32"),
    ).resolves.toEqual({ command: process.execPath, argsPrefix: [script] });
  });

  it("refuses a Windows .cmd launcher that is not a node shim", async () => {
    const shimPath = join(planRoot, "bb.cmd");
    await writeFile(shimPath, "@echo off\r\nstart notepad.exe\r\n");
    await expect(
      resolveNodeLauncherSpawnPlan(shimPath, "win32"),
    ).rejects.toThrow(
      `Windows launcher ${shimPath} is not a Node shim bb can start directly`,
    );
    const missingPath = join(planRoot, "absent.cmd");
    await expect(
      resolveNodeLauncherSpawnPlan(missingPath, "win32"),
    ).rejects.toThrow(
      `Windows launcher ${missingPath} is not a Node shim bb can start directly`,
    );
  });

  it("spawns a non-shim Windows target directly", async () => {
    await expect(
      resolveNodeLauncherSpawnPlan("C:\\tools\\bb.exe", "win32"),
    ).resolves.toEqual({ command: "C:\\tools\\bb.exe", argsPrefix: [] });
  });
});
