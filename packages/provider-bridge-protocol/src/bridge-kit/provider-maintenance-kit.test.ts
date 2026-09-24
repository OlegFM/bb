import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSpawnPlan } from "@bb/process-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandOutput,
  compareVersions,
  downloadedInstallerCommand,
  formatCommand,
  installationVerification,
  installerUnavailableReason,
  npmCommand,
  npmGlobalInstallCommand,
  npmGlobalInstallSource,
  resolveExecutablePath,
  readCliVersion,
  versionFrom,
} from "./provider-maintenance-kit.js";

vi.mock("@bb/process-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bb/process-utils")>();
  return { ...actual, resolveSpawnPlan: vi.fn(actual.resolveSpawnPlan) };
});

describe("provider maintenance kit", () => {
  it.skipIf(process.platform === "win32")(
    "reads the version of a CLI that keeps reading stdin until EOF",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "bb-cli-version-"));
      try {
        const executable = path.join(dir, "stdio-server-cli");
        await writeFile(
          executable,
          '#!/bin/sh\ncat >/dev/null\necho "tool 1.2.3"\n',
        );
        await chmod(executable, 0o755);
        expect(await readCliVersion(executable)).toBe("1.2.3");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("compares the numeric core of CLI versions, prerelease below release", () => {
    expect(compareVersions("0.135.9", "0.136.0")).toBeLessThan(0);
    expect(compareVersions("0.136.0-beta.1", "0.136.0")).toBeLessThan(0);
    expect(compareVersions("0.136.0", "0.136.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.136.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it.each([
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.beta", "1.0.0-beta"],
    ["1.0.0-beta", "1.0.0-beta.2"],
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-beta.9", "1.0.0-beta.10"],
    ["1.0.0-beta.11", "1.0.0-rc.1"],
    ["1.0.0-rc.2", "1.0.0-rc.10"],
    ["1.0.0-rc.10", "1.0.0"],
    ["1.0.0-9", "1.0.0-alpha"],
    ["1.0.0-B", "1.0.0-a"],
    ["1.0.0-alpha.2", "1.0.0-alpha.2.1"],
    ["1.0.0", "1.0.1-alpha"],
  ])("orders %s below %s in both directions", (older, newer) => {
    expect(compareVersions(older, newer)).toBeLessThan(0);
    expect(compareVersions(newer, older)).toBeGreaterThan(0);
    expect(compareVersions(older, older)).toBe(0);
  });

  it("ignores build metadata for precedence", () => {
    expect(compareVersions("1.0.0+build.9", "1.0.0+build.10")).toBe(0);
    expect(compareVersions("1.0.0-beta.2+x", "1.0.0-beta.2+y")).toBe(0);
    expect(compareVersions("1.0.0-beta.9+x", "1.0.0-beta.10+y")).toBeLessThan(
      0,
    );
  });

  it.each([
    "not-a-version",
    "",
    "1.0",
    "1.0.0.1",
    "01.0.0",
    "1.0.0-beta.01",
    "1.0.0-beta..1",
    "1.0.0-",
    "1.0.0+",
    "tool 1.0.0",
    "1.0.0 trailing",
  ])("rejects invalid version %j in either operand", (invalid) => {
    expect(() => compareVersions(invalid, "0.0.0")).toThrow(TypeError);
    expect(() => compareVersions("0.0.0", invalid)).toThrow(TypeError);
  });

  it("reads the version out of a CLI banner", () => {
    expect(versionFrom("codex-cli 0.150.0")).toBe("0.150.0");
    expect(versionFrom("v2.1.0-beta.3\n")).toBe("2.1.0-beta.3");
    expect(versionFrom("no version here")).toBeNull();
    expect(versionFrom(null)).toBeNull();
  });

  it.each([
    "1.2.3-2026.01.15",
    "0.5.0-01",
    "1.2.3-beta..1",
    "1.2.3-beta.",
    "1.2.3-",
    "1.2.3+",
    "1.2.3+build..1",
    "1.2.3.4",
    "01.2.3",
  ])("returns null for invalid CLI version %s", (version) => {
    expect(versionFrom(`codex ${version}`)).toBeNull();
  });

  it("preserves valid prereleases and build metadata", () => {
    const version = versionFrom("codex 1.2.3-beta.10+2026.01.15");
    expect(version).toBe("1.2.3-beta.10+2026.01.15");
    expect(compareVersions(version!, "1.2.3-beta.9")).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32").each([
    ["1.2.3-2026.01.15", ""],
    ["0.5.0-01", " >&2"],
    ["1.2.3-beta..1", ""],
  ])("returns null when --version reports %s", async (version, redirect) => {
    const dir = await mkdtemp(path.join(tmpdir(), "bb-cli-invalid-version-"));
    try {
      const executable = path.join(dir, "invalid-version-cli");
      await writeFile(
        executable,
        `#!/bin/sh\necho "codex ${version}"${redirect}\n`,
      );
      await chmod(executable, 0o755);
      expect(await readCliVersion(executable)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("quotes only the arguments a shell would mangle", () => {
    expect(
      formatCommand("npm", ["install", "-g", "@openai/codex@latest"]),
    ).toBe("npm install -g @openai/codex@latest");
    expect(formatCommand("sh", ["-c", "echo 'hi' && ls"])).toBe(
      "sh -c 'echo '\\''hi'\\'' && ls'",
    );
  });

  it("attributes an executable inside npm's global bin to npm", () => {
    const npmBin = path.join(path.sep, "usr", "local", "bin");
    expect(
      npmGlobalInstallSource({
        installed: true,
        executablePath: path.join(npmBin, "codex"),
        npmBin,
      }),
    ).toBe("npmGlobal");
    expect(
      npmGlobalInstallSource({
        installed: true,
        executablePath: path.join(path.sep, "opt", "homebrew", "bin", "codex"),
        npmBin,
      }),
    ).toBe("external");
    expect(
      npmGlobalInstallSource({ installed: true, executablePath: null, npmBin }),
    ).toBe("external");
    expect(
      npmGlobalInstallSource({
        installed: false,
        executablePath: null,
        npmBin: null,
      }),
    ).toBe("notInstalled");
  });

  it("verifies an update against the latest version, or a change when the registry was unreachable", () => {
    expect(
      installationVerification(
        { currentVersion: "1.0.0", latestVersion: "1.1.0" },
        "update",
      ),
    ).toEqual({ kind: "version_at_least", version: "1.1.0" });
    expect(
      installationVerification(
        { currentVersion: "1.0.0", latestVersion: null },
        "update",
      ),
    ).toEqual({ kind: "version_changed", previousVersion: "1.0.0" });
    expect(
      installationVerification(
        { currentVersion: null, latestVersion: null },
        "install",
      ),
    ).toEqual({ kind: "installed" });
  });
});

describe("provider maintenance kit: platform injection", () => {
  const roots: string[] = [];

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "bb-provider-kit-"));
    roots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("resolves npm on every platform (the daemon resolves the real launcher)", () => {
    expect(npmCommand()).toBe("npm");
  });

  it("builds the same npm global install command on posix and win32", () => {
    const expected = {
      command: "npm",
      args: ["install", "-g", "@openai/codex@latest"],
      displayCommand: "npm install -g @openai/codex@latest",
    };
    expect(npmGlobalInstallCommand("@openai/codex")).toEqual(expected);
  });

  it("keeps the POSIX downloaded-installer script byte-identical and refuses on win32", () => {
    const script =
      'tmp=$(mktemp "${TMPDIR:-/tmp}/provider-installation.XXXXXX") && trap \'rm -f "$tmp"\' EXIT && curl -fsSL https://claude.ai/install.sh -o "$tmp" && bash "$tmp"';
    expect(
      downloadedInstallerCommand("https://claude.ai/install.sh", "linux"),
    ).toEqual({ command: "sh", args: ["-c", script], displayCommand: script });
    expect(
      downloadedInstallerCommand("https://claude.ai/install.sh", "win32"),
    ).toBeNull();
  });

  it("names the installer-unavailable reason sentence", () => {
    expect(
      installerUnavailableReason(
        "Claude Code",
        "https://claude.com/claude-code",
      ),
    ).toBe(
      "bb cannot run the Claude Code shell installer on Windows. Install Claude Code from https://claude.com/claude-code, then reload.",
    );
  });

  it("attributes npm-global installs case-insensitively on win32 and case-sensitively elsewhere", () => {
    const executablePath = "C:\\NVM4W\\nodejs\\codex.cmd";
    const npmBin = "C:\\nvm4w\\nodejs";
    expect(
      npmGlobalInstallSource({
        installed: true,
        executablePath,
        npmBin,
        platform: "win32",
      }),
    ).toBe("npmGlobal");
    expect(
      npmGlobalInstallSource({
        installed: true,
        executablePath,
        npmBin,
        platform: "linux",
      }),
    ).toBe("external");
  });

  it("resolves a win32 executable through Path and PATHEXT, not where.exe", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "pwsh.exe"), "");
    await expect(
      resolveExecutablePath("pwsh", {
        platform: "win32",
        env: { Path: root },
      }),
    ).resolves.toBe(path.join(root, "pwsh.exe"));
    await expect(
      resolveExecutablePath("pwsh", {
        platform: "win32",
        env: { Path: root, PATHEXT: ".COM;.CMD" },
      }),
    ).resolves.toBeNull();
    await expect(
      resolveExecutablePath(path.join(root, "pwsh"), {
        platform: "win32",
        env: {},
      }),
    ).resolves.toBe(path.join(root, "pwsh.exe"));
  });

  it("returns null without throwing when a win32 spawn plan cannot resolve", async () => {
    const root = await makeRoot();
    await expect(
      commandOutput("npm", ["--version"], {
        platform: "win32",
        env: { Path: root },
      }),
    ).resolves.toBeNull();
  });

  it("resolves a win32 command with the Path from options.env merged over process.env", async () => {
    const root = await makeRoot();
    await writeFile(
      path.join(root, "probe.cmd"),
      "@echo off\r\necho probe-ok\r\n",
    );
    vi.mocked(resolveSpawnPlan).mockClear();

    await commandOutput("probe", [], {
      platform: "win32",
      env: { Path: root },
    });

    expect(resolveSpawnPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "probe",
        env: { ...process.env, Path: root },
        platform: "win32",
      }),
    );
  });

  it.runIf(process.platform === "win32")(
    "runs npm through the resolved spawn plan on win32",
    async () => {
      const root = await makeRoot();
      await writeFile(
        path.join(root, "npm-cli.cjs"),
        'if (process.argv[2] !== "--version") process.exit(1); console.log("11.16.0");',
      );
      await writeFile(
        path.join(root, "npm.cmd"),
        '@node "%~dp0\\npm-cli.cjs" %*\r\n',
      );
      const output = await commandOutput("npm", ["--version"], {
        platform: "win32",
        env: { Path: root },
      });
      expect(output).toBe("11.16.0");
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps POSIX commandOutput byte-identical",
    async () => {
      await expect(
        commandOutput("sh", ["-c", "printf out; printf err 1>&2"], {
          platform: "linux",
        }),
      ).resolves.toBe("out\nerr");
    },
  );
});
