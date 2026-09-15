import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nodeShimRefusalMessage,
  POWERSHELL_NONINTERACTIVE_ARGS,
  readNodeCmdShim,
  resolveExecutable,
  resolveExecutableSync,
  resolveNodeShimSpawnPlan,
  resolvePowerShellExecutable,
  resolveSpawnPlan,
  resolveSpawnPlanOrThrow,
  resolveWindowsSystemToolPath,
  SpawnPlanUnavailableError,
  spawnPlanUnavailableMessage,
  windowsExecutableExtensions,
} from "../src/index.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bb-resolve-exec-"));
  roots.push(root);
  return root;
}

function makeRootSync(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-resolve-exec-"));
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

describe("resolveExecutableSync", () => {
  it("walks Path and returns the same result as resolveExecutable", async () => {
    const root = makeRootSync();
    writeFileSync(join(root, "tool.exe"), "");
    const args = {
      command: "tool",
      env: { Path: `C:\\missing;${root}`, PATHEXT: ".COM;.EXE" },
      platform: "win32" as const,
    };
    expect(resolveExecutableSync(args)).toBe(join(root, "tool.exe"));
    await expect(resolveExecutable(args)).resolves.toBe(
      resolveExecutableSync(args),
    );
  });

  it("appends PATHEXT suffixes in order, matching the async walk", async () => {
    const root = makeRootSync();
    writeFileSync(join(root, "x.com"), "");
    writeFileSync(join(root, "x.exe"), "");
    const args = {
      command: "x",
      env: { Path: root, PATHEXT: ".COM;.EXE" },
      platform: "win32" as const,
    };
    expect(resolveExecutableSync(args)).toBe(join(root, "x.com"));
    await expect(resolveExecutable(args)).resolves.toBe(
      resolveExecutableSync(args),
    );
  });

  it("finds an explicit .cmd only when .cmd is in PATHEXT, matching the async walk", async () => {
    const root = makeRootSync();
    writeFileSync(join(root, "tool.cmd"), "");
    const withCmd = {
      command: join(root, "tool.cmd"),
      env: {},
      platform: "win32" as const,
    };
    expect(resolveExecutableSync(withCmd)).toBe(join(root, "tool.cmd"));
    await expect(resolveExecutable(withCmd)).resolves.toBe(
      resolveExecutableSync(withCmd),
    );

    const withoutCmd = {
      command: "tool",
      env: { Path: root, PATHEXT: ".EXE" },
      platform: "win32" as const,
    };
    expect(resolveExecutableSync(withoutCmd)).toBeNull();
    await expect(resolveExecutable(withoutCmd)).resolves.toBe(
      resolveExecutableSync(withoutCmd),
    );
  });

  it.skipIf(process.platform === "win32")(
    "returns the executable file on posix, matching the async walk (skipped on win32: the posix PATH delimiter splits a drive letter)",
    async () => {
      const root = makeRootSync();
      const target = `${root}/git`;
      writeFileSync(target, "");
      chmodSync(target, 0o755);
      const args = {
        command: "git",
        env: { PATH: `/definitely-missing:${root}` },
        platform: "linux" as const,
      };
      expect(resolveExecutableSync(args)).toBe(target);
      await expect(resolveExecutable(args)).resolves.toBe(
        resolveExecutableSync(args),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "returns null for a non-executable file on posix, matching the async walk (skipped on win32: NTFS has no mode bits)",
    async () => {
      const root = makeRootSync();
      const target = join(root, "data");
      writeFileSync(target, "");
      chmodSync(target, 0o644);
      const args = {
        command: "data",
        env: { PATH: root },
        platform: "linux" as const,
      };
      expect(resolveExecutableSync(args)).toBeNull();
      await expect(resolveExecutable(args)).resolves.toBe(
        resolveExecutableSync(args),
      );
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

  const NPM_LAUNCHER_SHIM = [
    ":: Created by npm, please don't edit manually.",
    "@ECHO OFF",
    "SETLOCAL",
    'SET "NODE_EXE=%~dp0\\node.exe"',
    'IF NOT EXIST "%NODE_EXE%" ( SET "NODE_EXE=node" )',
    'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
    'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
    'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
    '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
    ")",
    'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" ( SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%" )',
    '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
    "",
  ].join("\r\n");

  it("reads the npm launcher shim", async () => {
    const root = await makeRoot();
    const shim = join(root, "npm.cmd");
    await writeFile(shim, NPM_LAUNCHER_SHIM);
    await expect(readNodeCmdShim(shim)).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "node_modules", "npm", "bin", "npm-cli.js")],
    });
  });

  it("reads the npx launcher shim", async () => {
    const root = await makeRoot();
    const shim = join(root, "npx.cmd");
    await writeFile(
      shim,
      NPM_LAUNCHER_SHIM.replaceAll("NPM_", "NPX_").replaceAll("npm-", "npx-"),
    );
    await expect(readNodeCmdShim(shim)).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "node_modules", "npm", "bin", "npx-cli.js")],
    });
  });

  it("returns null for a launcher whose NPM_CLI_JS names a binary", async () => {
    const root = await makeRoot();
    const shim = join(root, "npm.cmd");
    await writeFile(
      shim,
      NPM_LAUNCHER_SHIM.replace(
        'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
        'SET "NPM_CLI_JS=%~dp0\\node.exe"',
      ),
    );
    await expect(readNodeCmdShim(shim)).resolves.toBeNull();
  });
});

describe("resolveNodeShimSpawnPlan", () => {
  it("passes a non-shim launcher through untouched", async () => {
    const root = await makeRoot();
    const launcher = join(root, "bb.exe");
    await writeFile(launcher, "");
    await expect(resolveNodeShimSpawnPlan(launcher)).resolves.toEqual({
      command: launcher,
      args: [],
    });
  });

  it("plans a node run for a .cmd and a .bat node shim", async () => {
    const root = await makeRoot();
    const cmdShim = join(root, "bb.cmd");
    await writeFile(cmdShim, '@node "%~dp0bb" %*\r\n');
    await expect(resolveNodeShimSpawnPlan(cmdShim)).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "bb")],
    });
    const batShim = join(root, "bb.bat");
    await writeFile(batShim, '@node "%~dp0bb" %*\r\n');
    await expect(resolveNodeShimSpawnPlan(batShim)).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "bb")],
    });
  });

  it("refuses a shim extension that does not run node", async () => {
    const root = await makeRoot();
    const shim = join(root, "code.cmd");
    await writeFile(shim, '@echo off\r\n"%~dp0..\\code.exe" %*\r\n');
    await expect(resolveNodeShimSpawnPlan(shim)).resolves.toBeNull();
    await expect(
      resolveNodeShimSpawnPlan(join(root, "absent.cmd")),
    ).resolves.toBeNull();
  });

  it("names the launcher in the single refusal message", () => {
    expect(nodeShimRefusalMessage("C:\\tools\\code.cmd")).toBe(
      "Windows launcher C:\\tools\\code.cmd is not a Node shim bb can start directly",
    );
  });
});

describe("resolveSpawnPlan", () => {
  it("is a literal identity on posix with no filesystem access", async () => {
    await expect(
      resolveSpawnPlan({
        command: "definitely-missing-tool",
        args: ["--x"],
        platform: "linux",
        env: { PATH: "" },
      }),
    ).resolves.toEqual({ command: "definitely-missing-tool", args: ["--x"] });
  });

  it("resolves an .exe found on Path", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "tool.exe"), "");
    await expect(
      resolveSpawnPlan({
        command: "tool",
        args: ["--x"],
        platform: "win32",
        env: { Path: root },
      }),
    ).resolves.toEqual({ command: join(root, "tool.exe"), args: ["--x"] });
  });

  it("plans a node run for a Node shim found on Path", async () => {
    const parent = await makeRoot();
    const root = join(parent, "shim");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "tool.cmd"),
      '@node "%~dp0\\..\\lib\\cli.js" %*\r\n',
    );
    const libDir = join(parent, "lib");
    await mkdir(libDir, { recursive: true });
    await writeFile(join(libDir, "cli.js"), "");
    await expect(
      resolveSpawnPlan({
        command: "tool",
        args: ["--x"],
        platform: "win32",
        env: { Path: root },
      }),
    ).resolves.toEqual({
      command: process.execPath,
      args: [join(libDir, "cli.js"), "--x"],
    });
  });

  it("plans a node run for the npm launcher shim found on Path", async () => {
    const root = await makeRoot();
    await writeFile(
      join(root, "npm.cmd"),
      [
        ":: Created by npm, please don't edit manually.",
        "@ECHO OFF",
        "SETLOCAL",
        'SET "NODE_EXE=%~dp0\\node.exe"',
        'IF NOT EXIST "%NODE_EXE%" ( SET "NODE_EXE=node" )',
        'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
        'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
        'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
        '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
        ")",
        'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" ( SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%" )',
        '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
        "",
      ].join("\r\n"),
    );
    await expect(
      resolveSpawnPlan({
        command: "npm",
        args: ["install"],
        platform: "win32",
        env: { Path: root },
      }),
    ).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "node_modules", "npm", "bin", "npm-cli.js"), "install"],
    });
  });

  it("returns null when the command is not found on Path", async () => {
    const root = await makeRoot();
    await expect(
      resolveSpawnPlan({
        command: "definitely-missing-tool",
        args: [],
        platform: "win32",
        env: { Path: root },
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a .cmd that is not a Node shim", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "tool.cmd"), "@echo hi\r\n");
    await expect(
      resolveSpawnPlan({
        command: "tool",
        args: [],
        platform: "win32",
        env: { Path: root },
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a resolved .ps1 and rejects with reason not_executable", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "tool.ps1"), "");
    const args = {
      command: "tool",
      args: [],
      platform: "win32" as const,
      env: { Path: root, PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1" },
    };
    await expect(resolveSpawnPlan(args)).resolves.toBeNull();
    await expect(resolveSpawnPlanOrThrow(args)).rejects.toMatchObject({
      reason: "not_executable",
      message: `Windows launcher ${join(root, "tool.ps1")} cannot be started directly`,
    });
  });

  it("builds the not-found, not-a-Node-shim and not-executable refusal messages", () => {
    expect(
      spawnPlanUnavailableMessage({ command: "npm", resolvedPath: null }),
    ).toBe("Command npm was not found on Path");
    expect(
      spawnPlanUnavailableMessage({
        command: "code",
        resolvedPath: "C:\\x\\t.cmd",
      }),
    ).toBe(nodeShimRefusalMessage("C:\\x\\t.cmd"));
    expect(
      spawnPlanUnavailableMessage({
        command: "tool",
        resolvedPath: "C:\\x\\tool.ps1",
      }),
    ).toBe("Windows launcher C:\\x\\tool.ps1 cannot be started directly");
  });

  it("carries the reason and resolved path on SpawnPlanUnavailableError", () => {
    const notFound = new SpawnPlanUnavailableError({
      command: "npm",
      resolvedPath: null,
    });
    expect(notFound.reason).toBe("not_found");
    expect(notFound.command).toBe("npm");
    expect(notFound.resolvedPath).toBeNull();

    const notNodeShim = new SpawnPlanUnavailableError({
      command: "code",
      resolvedPath: "C:\\x\\t.cmd",
    });
    expect(notNodeShim.reason).toBe("not_node_shim");
    expect(notNodeShim.message).toBe(nodeShimRefusalMessage("C:\\x\\t.cmd"));

    const notExecutable = new SpawnPlanUnavailableError({
      command: "tool",
      resolvedPath: "C:\\x\\tool.ps1",
    });
    expect(notExecutable.reason).toBe("not_executable");
    expect(notExecutable.message).toBe(
      "Windows launcher C:\\x\\tool.ps1 cannot be started directly",
    );
  });
});
