import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  POWERSHELL_NONINTERACTIVE_ARGS,
  readNodeCmdShim,
  resolveExecutable,
  resolvePowerShellExecutable,
  resolveWindowsSystemToolPath,
  windowsExecutableExtensions,
} from "../src/index.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bb-resolve-exec-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("windowsExecutableExtensions", () => {
  it("defaults to the documented PATHEXT and lower-cases every entry", () => {
    expect(windowsExecutableExtensions()).toEqual([
      ".com",
      ".exe",
      ".bat",
      ".cmd",
      ".ps1",
    ]);
    expect(windowsExecutableExtensions("")).toEqual([
      ".com",
      ".exe",
      ".bat",
      ".cmd",
      ".ps1",
    ]);
  });

  it("keeps the configured order, adds missing dots and drops duplicates", () => {
    expect(windowsExecutableExtensions(".CMD;EXE; .cmd ;.PS1")).toEqual([
      ".cmd",
      ".exe",
      ".ps1",
    ]);
  });
});

describe("resolveWindowsSystemToolPath", () => {
  it("anchors system tools on SystemRoot in either casing", () => {
    expect(
      resolveWindowsSystemToolPath("taskkill.exe", { SystemRoot: "D:\\Win" }),
    ).toBe("D:\\Win\\System32\\taskkill.exe");
    expect(
      resolveWindowsSystemToolPath("whoami.exe", { SYSTEMROOT: "D:\\Win" }),
    ).toBe("D:\\Win\\System32\\whoami.exe");
    expect(resolveWindowsSystemToolPath("icacls.exe", {})).toBe(
      "C:\\Windows\\System32\\icacls.exe",
    );
  });
});

describe("resolvePowerShellExecutable", () => {
  it("pins the non-interactive argument list", () => {
    expect([...POWERSHELL_NONINTERACTIVE_ARGS]).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
    ]);
  });

  it("falls back to Windows PowerShell when no pwsh.exe exists", () => {
    expect(
      resolvePowerShellExecutable({
        Path: "C:\\missing-one;C:\\missing-two",
        ProgramFiles: "C:\\missing-three",
        SystemRoot: "D:\\Win",
      }),
    ).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("prefers a pwsh.exe found on the Path", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "pwsh.exe"), "");
    expect(resolvePowerShellExecutable({ Path: `C:\\missing;${root}` })).toBe(
      join(root, "pwsh.exe"),
    );
  });
});

describe("resolveExecutable on posix", () => {
  it.skipIf(process.platform === "win32")(
    "walks PATH and returns the first executable file",
    async () => {
      const root = await makeRoot();
      const target = join(root, "git");
      await writeFile(target, "");
      await chmod(target, 0o755);
      await expect(
        resolveExecutable({
          command: "git",
          env: { PATH: `/definitely-missing:${root}` },
          platform: "linux",
        }),
      ).resolves.toBe(target);
      await expect(
        resolveExecutable({
          command: "git",
          env: { PATH: "/definitely-missing" },
          platform: "linux",
        }),
      ).resolves.toBeNull();
    },
  );

  it.skipIf(process.platform === "win32")(
    "checks an explicit path instead of walking PATH",
    async () => {
      const root = await makeRoot();
      const target = join(root, "tool");
      await writeFile(target, "");
      await chmod(target, 0o755);
      await expect(
        resolveExecutable({ command: target, env: {}, platform: "linux" }),
      ).resolves.toBe(target);
      await expect(
        resolveExecutable({
          command: join(root, "absent"),
          env: {},
          platform: "linux",
        }),
      ).resolves.toBeNull();
    },
  );

  it("ignores PATHEXT and never appends an extension", async () => {
    const root = await makeRoot();
    const target = join(root, "tool.exe");
    await writeFile(target, "");
    await chmod(target, 0o755);
    await expect(
      resolveExecutable({
        command: "tool",
        env: { PATH: root, PATHEXT: ".EXE" },
        platform: "linux",
      }),
    ).resolves.toBeNull();
  });
});

describe("resolveExecutable on win32", () => {
  it("appends PATHEXT suffixes in order while walking Path", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "tool.cmd"), "");
    await writeFile(join(root, "tool.exe"), "");
    await expect(
      resolveExecutable({
        command: "tool",
        env: { Path: `C:\\missing;${root}`, PATHEXT: ".COM;.EXE;.CMD" },
        platform: "win32",
      }),
    ).resolves.toBe(join(root, "tool.exe"));
    await expect(
      resolveExecutable({
        command: "tool",
        env: { Path: root, PATHEXT: ".CMD;.EXE" },
        platform: "win32",
      }),
    ).resolves.toBe(join(root, "tool.cmd"));
  });

  it("reads the Path key in any casing", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "tool.exe"), "");
    await expect(
      resolveExecutable({
        command: "tool",
        env: { path: root },
        platform: "win32",
      }),
    ).resolves.toBe(join(root, "tool.exe"));
    await expect(
      resolveExecutable({
        command: "tool",
        env: { PATH: root },
        platform: "win32",
      }),
    ).resolves.toBe(join(root, "tool.exe"));
  });

  it("decides executability by extension and never by the execute bit", async () => {
    const root = await makeRoot();
    const script = join(root, "script.ps1");
    await writeFile(script, "");
    await chmod(script, 0o600);
    await expect(
      resolveExecutable({
        command: "script",
        env: { Path: root },
        platform: "win32",
      }),
    ).resolves.toBe(script);
    await writeFile(join(root, "data.txt"), "");
    await expect(
      resolveExecutable({
        command: "data.txt",
        env: { Path: root },
        platform: "win32",
      }),
    ).resolves.toBeNull();
  });

  it("takes an explicit path as-is when it already carries an extension", async () => {
    const root = await makeRoot();
    const target = join(root, "tool.exe");
    await writeFile(target, "");
    await expect(
      resolveExecutable({ command: target, env: {}, platform: "win32" }),
    ).resolves.toBe(target);
    await expect(
      resolveExecutable({
        command: join(root, "tool"),
        env: {},
        platform: "win32",
      }),
    ).resolves.toBe(target);
  });

  it.runIf(process.platform === "win32")(
    "resolves real Windows tools",
    async () => {
      const resolved = await resolveExecutable({
        command: "cmd",
        env: process.env,
        platform: "win32",
      });
      expect(resolved?.toLowerCase()).toBe(
        resolveWindowsSystemToolPath("cmd.exe").toLowerCase(),
      );
      const whoami = resolveWindowsSystemToolPath("whoami.exe");
      await expect(
        resolveExecutable({
          command: whoami,
          env: process.env,
          platform: "win32",
        }),
      ).resolves.toBe(whoami);
    },
  );
});

describe("readNodeCmdShim", () => {
  it("reads the one-line bb shim", async () => {
    const root = await makeRoot();
    const shim = join(root, "bb.cmd");
    await writeFile(shim, '@node "%~dp0bb" %*\r\n');
    await expect(readNodeCmdShim(shim)).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "bb")],
    });
  });

  it("reads the npm/pnpm dp0 shim", async () => {
    const root = await makeRoot();
    const shim = join(root, "pnpm.cmd");
    await writeFile(
      shim,
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        '  SET "_prog=node"',
        ")",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*',
        "",
      ].join("\r\n"),
    );
    await expect(readNodeCmdShim(shim)).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "node_modules", "pnpm", "bin", "pnpm.cjs")],
    });
  });

  it("reads the relative node.exe shim", async () => {
    const root = await makeRoot();
    const shim = join(root, "tsc.cmd");
    await writeFile(
      shim,
      '"%~dp0\\node.exe" "%~dp0\\..\\typescript\\bin\\tsc" %*\r\n',
    );
    await expect(readNodeCmdShim(shim)).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "..", "typescript", "bin", "tsc")],
    });
  });

  it("reads the direct dp0 node.exe shim", async () => {
    const root = await makeRoot();
    const shim = join(root, "x.cmd");
    await writeFile(
      shim,
      '"%dp0%\\node.exe" "%dp0%\\..\\pkg\\bin\\x.js" %*\r\n',
    );
    await expect(readNodeCmdShim(shim)).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "..", "pkg", "bin", "x.js")],
    });
  });

  it("returns null for a node shim whose target is a binary", async () => {
    const root = await makeRoot();
    const shim = join(root, "wrapper.cmd");
    await writeFile(shim, '@node "%~dp0\\..\\tools\\helper.exe" %*\r\n');
    await expect(readNodeCmdShim(shim)).resolves.toBeNull();
  });

  it("returns null for a shim that does not run node and for a missing file", async () => {
    const root = await makeRoot();
    const shim = join(root, "helper.cmd");
    await writeFile(shim, '@echo off\r\n"%~dp0..\\tools\\helper.exe" %*\r\n');
    await expect(readNodeCmdShim(shim)).resolves.toBeNull();
    await expect(readNodeCmdShim(join(root, "absent.cmd"))).resolves.toBeNull();
  });
});
