import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, win32 as win32Path } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildModelProbeOptions } from "../model-list.js";
import {
  buildSessionOptions,
  resolveClaudeCodeExecutable,
} from "../session-options.js";

const onWindows = process.platform === "win32";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-claude-win32-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(
  directory: string,
  name: string,
  contents = "@echo off\n",
): string {
  const filePath = join(directory, name);
  writeFileSync(filePath, contents);
  try {
    chmodSync(filePath, 0o755);
  } catch {}
  return filePath;
}

describe("resolveClaudeCodeExecutable on win32", () => {
  it("prefers claude.exe over an extensionless sibling", () => {
    const binDirectory = makeDirectory();
    writeExecutable(binDirectory, "claude", "#!/bin/sh\nexit 0\n");
    const exePath = writeExecutable(binDirectory, "claude.exe");

    expect(
      resolveClaudeCodeExecutable({
        env: { Path: binDirectory, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
      }),
    ).toBe(exePath);
  });

  it.skipIf(onWindows)(
    "leaves the posix walk untouched when an .exe sibling exists",
    () => {
      const binDirectory = makeDirectory();
      const shimPath = writeExecutable(
        binDirectory,
        "claude",
        "#!/bin/sh\nexit 0\n",
      );
      writeExecutable(binDirectory, "claude.exe");

      expect(
        resolveClaudeCodeExecutable({
          env: { PATH: binDirectory },
          platform: "linux",
        }),
      ).toBe(shimPath);
    },
  );

  it("resolves an explicit extensionless override to its .exe sibling", () => {
    const binDirectory = makeDirectory();
    const shimPath = writeExecutable(
      binDirectory,
      "claude",
      "#!/bin/sh\nexit 0\n",
    );
    const exePath = writeExecutable(binDirectory, "claude.exe");

    expect(
      resolveClaudeCodeExecutable({
        env: { BB_CLAUDE_CODE_EXECUTABLE: shimPath },
        platform: "win32",
      }),
    ).toBe(exePath);
  });

  it("rejects an explicit override that resolves to nothing", () => {
    const binDirectory = makeDirectory();

    expect(() =>
      resolveClaudeCodeExecutable({
        env: {
          BB_CLAUDE_CODE_EXECUTABLE: join(binDirectory, "claude"),
        },
        platform: "win32",
      }),
    ).toThrow(
      `BB_CLAUDE_CODE_EXECUTABLE must point to an executable Claude CLI path: ${join(
        binDirectory,
        "claude",
      )}`,
    );
  });

  it("skips an extensionless file in an earlier Path entry", () => {
    const firstDirectory = makeDirectory();
    const secondDirectory = makeDirectory();
    writeExecutable(firstDirectory, "claude", "#!/bin/sh\nexit 0\n");
    const exePath = writeExecutable(secondDirectory, "claude.exe");

    expect(
      resolveClaudeCodeExecutable({
        env: {
          Path: [firstDirectory, secondDirectory].join(";"),
          PATHEXT: ".EXE;.CMD",
        },
        platform: "win32",
      }),
    ).toBe(exePath);
  });

  it("searches Path entries in order before it ranks PATHEXT", () => {
    const firstDirectory = makeDirectory();
    const secondDirectory = makeDirectory();
    const cmdPath = writeExecutable(firstDirectory, "claude.cmd");
    writeExecutable(secondDirectory, "claude.exe");

    expect(
      resolveClaudeCodeExecutable({
        env: {
          Path: [firstDirectory, secondDirectory].join(";"),
          PATHEXT: ".EXE;.CMD",
        },
        platform: "win32",
      }),
    ).toBe(cmdPath);
  });

  it("ranks PATHEXT within a single Path entry", () => {
    const binDirectory = makeDirectory();
    writeExecutable(binDirectory, "claude.cmd");
    const exePath = writeExecutable(binDirectory, "claude.exe");

    expect(
      resolveClaudeCodeExecutable({
        env: { Path: binDirectory, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
      }),
    ).toBe(exePath);
  });

  it("reads the Path key when the environment has no PATH key", () => {
    const binDirectory = makeDirectory();
    const exePath = writeExecutable(binDirectory, "claude.exe");

    expect(
      resolveClaudeCodeExecutable({
        env: { Path: binDirectory, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
      }),
    ).toBe(exePath);
  });

  it.runIf(onWindows)(
    "falls back to the well-known Windows install locations in order",
    () => {
      const home = makeDirectory();
      const localBin = win32Path.join(home, ".local", "bin", "claude.exe");
      const claudeLocal = win32Path.join(
        home,
        ".claude",
        "local",
        "claude.exe",
      );
      mkdirSync(win32Path.dirname(claudeLocal), { recursive: true });
      writeFileSync(claudeLocal, "@echo off\n");

      expect(
        resolveClaudeCodeExecutable({
          env: { USERPROFILE: home, Path: "", PATHEXT: ".EXE" },
          platform: "win32",
        }),
      ).toBe(claudeLocal);

      mkdirSync(win32Path.dirname(localBin), { recursive: true });
      writeFileSync(localBin, "@echo off\n");

      expect(
        resolveClaudeCodeExecutable({
          env: { USERPROFILE: home, Path: "", PATHEXT: ".EXE" },
          platform: "win32",
        }),
      ).toBe(localBin);
    },
  );

  it("never consults USERPROFILE on a posix platform", () => {
    const home = makeDirectory();
    const localBin = join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const shimPath = writeExecutable(localBin, "claude", "#!/bin/sh\nexit 0\n");

    expect(
      resolveClaudeCodeExecutable({ env: { HOME: home }, platform: "linux" }),
    ).toBe(shimPath);
    expect(
      resolveClaudeCodeExecutable({
        env: { USERPROFILE: home },
        platform: "linux",
      }),
    ).not.toBe(shimPath);
  });

  it.runIf(onWindows)(
    "finds the Claude CLI installed on this Windows host",
    () => {
      const resolved = resolveClaudeCodeExecutable({
        env: process.env,
        platform: "win32",
      });
      expect(resolved).not.toBe(null);
      expect(resolved?.toLowerCase().endsWith("claude.exe")).toBe(true);
    },
  );
});

describe("session and probe options", () => {
  it("carries the win32-resolved executable into both entry points", () => {
    const binDirectory = makeDirectory();
    const exePath = writeExecutable(binDirectory, "claude.exe");
    const env = { Path: binDirectory, PATHEXT: ".EXE" };

    expect(
      buildModelProbeOptions(env, "win32").pathToClaudeCodeExecutable,
    ).toBe(exePath);
    expect(
      buildSessionOptions(
        {
          chromeEnabled: false,
          workflowsEnabled: false,
          cwd: "/tmp/worktree",
          instructionMode: "append",
          getPermissionEscalation: () => "ask",
          permissionMode: "default",
          permissionScope: "workspace",
        },
        env,
        "win32",
      ).pathToClaudeCodeExecutable,
    ).toBe(exePath);
  });
});

describe("posix PATH walk", () => {
  it.skipIf(onWindows)("still splits PATH with the posix delimiter", () => {
    const firstDirectory = makeDirectory();
    const secondDirectory = makeDirectory();
    const shimPath = writeExecutable(
      secondDirectory,
      "claude",
      "#!/bin/sh\nexit 0\n",
    );

    expect(
      resolveClaudeCodeExecutable({
        env: { PATH: [firstDirectory, secondDirectory].join(delimiter) },
        platform: "linux",
      }),
    ).toBe(shimPath);
  });
});
