import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveInstalledBinEntry,
  resolveLaunchForLabel,
  resolveNpmLaunch,
} from "../scripts/npm-launch.mjs";

describe("resolveNpmLaunch", () => {
  let execRoot: string | undefined;

  afterEach(() => {
    if (execRoot !== undefined) {
      rmSync(execRoot, { force: true, recursive: true });
      execRoot = undefined;
    }
  });

  function createExecPath(withNpm: boolean) {
    execRoot = mkdtempSync(join(tmpdir(), "bb-app-npm-launch-"));
    const npmBinDir = join(execRoot, "node_modules", "npm", "bin");
    mkdirSync(npmBinDir, { recursive: true });
    if (withNpm) {
      writeFileSync(join(npmBinDir, "npm-cli.js"), "");
      writeFileSync(join(npmBinDir, "npx-cli.js"), "");
    }
    return join(execRoot, "node.exe");
  }

  it("routes npm through the bundled CLI script on win32", () => {
    const execPath = createExecPath(true);
    const plan = resolveNpmLaunch({
      args: ["install"],
      command: "npm",
      execPath,
      platform: "win32",
    });
    expect(plan).toEqual({
      args: [
        join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
        "install",
      ],
      command: execPath,
    });
  });

  it("routes npx through the bundled CLI script on win32", () => {
    const execPath = createExecPath(true);
    const plan = resolveNpmLaunch({
      args: ["--yes", "bb-app"],
      command: "npx",
      execPath,
      platform: "win32",
    });
    expect(plan).toEqual({
      args: [
        join(dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js"),
        "--yes",
        "bb-app",
      ],
      command: execPath,
    });
  });

  it("throws when the bundled npm launcher is missing", () => {
    const execPath = createExecPath(false);
    expect(() =>
      resolveNpmLaunch({
        args: ["install"],
        command: "npm",
        execPath,
        platform: "win32",
      }),
    ).toThrowError(
      `npm launcher not found beside ${execPath}; the smoke needs the Node.js distribution's bundled npm`,
    );
  });

  it("is the identity on non-win32 platforms", () => {
    const execPath = createExecPath(false);
    const args = ["install"];
    const plan = resolveNpmLaunch({
      args,
      command: "npm",
      execPath,
      platform: "linux",
    });
    expect(plan).toEqual({ args: ["install"], command: "npm" });
    expect(plan.args).toBe(args);
  });
});

describe("resolveLaunchForLabel", () => {
  let execRoot: string | undefined;

  afterEach(() => {
    if (execRoot !== undefined) {
      rmSync(execRoot, { force: true, recursive: true });
      execRoot = undefined;
    }
  });

  function createExecPath(withNpm: boolean) {
    execRoot = mkdtempSync(join(tmpdir(), "bb-app-npm-launch-label-"));
    const npmBinDir = join(execRoot, "node_modules", "npm", "bin");
    mkdirSync(npmBinDir, { recursive: true });
    if (withNpm) {
      writeFileSync(join(npmBinDir, "npm-cli.js"), "");
    }
    return join(execRoot, "node.exe");
  }

  it("prefixes a resolveNpmLaunch throw with the invocation label", () => {
    const execPath = createExecPath(false);
    expect(() =>
      resolveLaunchForLabel("npm install", "npm", ["install"], {
        execPath,
        platform: "win32",
      }),
    ).toThrowError(
      `npm install: npm launcher not found beside ${execPath}; the smoke needs the Node.js distribution's bundled npm`,
    );
  });

  it("does not wrap a command that never resolves through npm-launch", () => {
    const execPath = createExecPath(false);
    const args = ["--help"];
    const plan = resolveLaunchForLabel("bb-app --help", "bb-app", args, {
      execPath,
      platform: "win32",
    });
    expect(plan).toEqual({ args: ["--help"], command: "bb-app" });
    expect(plan.args).toBe(args);
  });
});

describe("resolveInstalledBinEntry", () => {
  let installRoot: string | undefined;

  afterEach(() => {
    if (installRoot !== undefined) {
      rmSync(installRoot, { force: true, recursive: true });
      installRoot = undefined;
    }
  });

  function createInstall(packageJson: object) {
    installRoot = mkdtempSync(join(tmpdir(), "bb-app-installed-bin-"));
    const binDir = join(installRoot, "node_modules", ".bin");
    const packageDir = join(installRoot, "node_modules", "bb-app");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify(packageJson),
    );
    return { binDir, packageDir };
  }

  it("resolves an object-form bin entry", () => {
    const { binDir, packageDir } = createInstall({
      name: "bb-app",
      bin: { "bb-app": "bin/bb-app.js", bb: "bin/bb.js" },
    });
    expect(resolveInstalledBinEntry(binDir, "bb")).toBe(
      join(packageDir, "bin/bb.js"),
    );
  });

  it("resolves a string-form bin entry under the package's own name", () => {
    const { binDir, packageDir } = createInstall({
      name: "bb-app",
      bin: "bin/bb-app.js",
    });
    expect(resolveInstalledBinEntry(binDir, "bb-app")).toBe(
      join(packageDir, "bin/bb-app.js"),
    );
  });

  it("fails loudly, naming the package, when no bin entry matches", () => {
    const { binDir } = createInstall({
      name: "bb-app",
      bin: { "bb-app": "bin/bb-app.js" },
    });
    expect(() => resolveInstalledBinEntry(binDir, "bb-server")).toThrowError(
      "Installed bb-app package.json has no bin entry for bb-server",
    );
  });
});
