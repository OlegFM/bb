import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const commandPath = join(repoRoot, "packages", "scripts", "src", "commands", "run-dev-app.ts");

function runDevApp(args, env) {
  return spawnSync(
    process.execPath,
    ["--conditions=source", "--import", "tsx", commandPath, ...args],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } },
  );
}

describe("run-dev-app", () => {
  it("reports status for a checkout with nothing running", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "bb-dev-app-home-"));
    try {
      const result = runDevApp(["status"], { HOME: tempHome, USERPROFILE: tempHome });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `Node: ${process.version} (ABI ${process.versions.modules}) at ${process.execPath}`,
      );
      expect(result.stdout).toContain("Dev session: stopped");
      expect(result.stdout).toContain("Desktop session: stopped");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("stops cleanly when nothing is running", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "bb-dev-app-home-"));
    try {
      const result = runDevApp(["stop"], { HOME: tempHome, USERPROFILE: tempHome });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("dev server: not running");
      expect(result.stderr).toContain("desktop: not running");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("prints usage and fails on an unknown command", () => {
    const result = runDevApp(["main"], {});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: main");
    expect(result.stderr).toContain("Usage: pnpm dev:app");
  });

  it("prints shell-specific env lines", () => {
    const posix = runDevApp(["env"], {});
    const powershell = runDevApp(["env", "--powershell"], {});

    expect(posix.status).toBe(0);
    expect(posix.stdout.split("\n")[0]).toMatch(/^export BB_SERVER_URL=http:\/\/127\.0\.0\.1:\d+$/u);
    expect(posix.stdout).toContain("unset BB_THREAD_STORAGE");
    expect(powershell.status).toBe(0);
    expect(powershell.stdout.split("\n")[0]).toMatch(/^\$env:BB_SERVER_URL = "http:\/\/127\.0\.0\.1:\d+"$/u);
  });

  it("pins the root engine floor for primary development", () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const nodePin = readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim();

    expect(packageJson.engines.node).toBe(`>=${nodePin}`);
  });
});
