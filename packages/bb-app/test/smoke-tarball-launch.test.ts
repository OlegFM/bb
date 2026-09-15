import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmLaunch } from "../scripts/npm-launch.mjs";

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
