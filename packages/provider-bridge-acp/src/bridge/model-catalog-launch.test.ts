import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAgentModelCatalog,
  type AgentModelListExecFile,
} from "./bridge.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeBinDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-acp-model-list-"));
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

function recordingExecFile(): {
  calls: { command: string; args: readonly string[]; options: object }[];
  execFileImpl: AgentModelListExecFile;
} {
  const calls: { command: string; args: readonly string[]; options: object }[] =
    [];
  return {
    calls,
    execFileImpl: (command, args, options, callback) => {
      calls.push({ command, args, options });
      callback(null, "gpt-5 - GPT 5\n", "");
    },
  };
}

describe("loadAgentModelCatalog launch", () => {
  it("resolves the list command and hides the console on win32", async () => {
    const binDirectory = makeBinDirectory();
    const exePath = writeExecutable(binDirectory, "cursor-agent.exe");
    const { calls, execFileImpl } = recordingExecFile();

    const catalog = await loadAgentModelCatalog(
      {
        command: "cursor-agent",
        args: ["--list-models"],
        envVars: { Path: binDirectory, PATHEXT: ".EXE;.CMD" },
      },
      { platform: "win32", execFileImpl },
    );

    expect(catalog?.models.map((model) => model.model)).toEqual(["gpt-5"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(exePath);
    expect(calls[0]?.args).toEqual(["--list-models"]);
    expect(calls[0]?.options).toMatchObject({ windowsHide: true });
  });

  it("leaves the posix list command bare with no windowsHide key", async () => {
    const { calls, execFileImpl } = recordingExecFile();

    const catalog = await loadAgentModelCatalog(
      { command: "cursor-agent", args: ["--list-models", "--posix"] },
      { platform: "linux", execFileImpl },
    );

    expect(catalog?.models.map((model) => model.model)).toEqual(["gpt-5"]);
    expect(calls[0]?.command).toBe("cursor-agent");
    expect(calls[0]?.args).toEqual(["--list-models", "--posix"]);
    expect(calls[0]?.options).not.toHaveProperty("windowsHide");
  });
});
