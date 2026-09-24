import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveAppServerLaunch,
  resolveCodexAppServerLaunch,
} from "./bridge.js";

const onWindows = process.platform === "win32";
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeBinDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-launch-"));
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

describe("Codex Account Pool launch", () => {
  it("adds an in-memory base URL and environment-backed hub header", () => {
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://bb.example/pool/v1");
    vi.stubEnv("CODEX_POOL_AUTH_TOKEN", "secret-machine-token");
    const launch = resolveAppServerLaunch();
    expect(launch.command).toBe("codex");
    expect(launch.args).toContain(
      'openai_base_url="https://bb.example/pool/v1"',
    );
    expect(launch.args).toContain('model_provider="bb-account-pool"');
    expect(launch.args).toContain(
      'model_providers.bb-account-pool.env_http_headers.x-bb-account-pool-token="CODEX_POOL_AUTH_TOKEN"',
    );
    expect(launch.args).toContain(
      "model_providers.bb-account-pool.supports_websockets=false",
    );
    expect(JSON.stringify(launch.args)).not.toContain("secret-machine-token");
  });

  it("leaves Codex's default transport alone when the pool is not routed", () => {
    const launch = resolveAppServerLaunch({});
    expect(launch).toEqual({ command: "codex", args: ["app-server"] });
    expect(JSON.stringify(launch.args)).not.toContain("supports_websockets");
  });

  it("does not partially route when either required variable is missing", () => {
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://bb.example/pool/v1");
    expect(resolveAppServerLaunch()).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });
});

describe("Codex app-server spawn resolution", () => {
  it("resolves the bare command through Path and PATHEXT on win32", async () => {
    const binDirectory = makeBinDirectory();
    const exePath = writeExecutable(binDirectory, "codex.exe");

    await expect(
      resolveCodexAppServerLaunch({
        env: { Path: binDirectory, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
      }),
    ).resolves.toEqual({ command: exePath, args: ["app-server"] });
  });

  it("leaves the posix launch exactly as resolveAppServerLaunch built it", async () => {
    await expect(
      resolveCodexAppServerLaunch({ env: {}, platform: "linux" }),
    ).resolves.toEqual({ command: "codex", args: ["app-server"] });
  });

  it("gives the install guidance when Windows has no Codex CLI at all", async () => {
    const binDirectory = makeBinDirectory();

    await expect(
      resolveCodexAppServerLaunch({
        env: { Path: binDirectory, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
      }),
    ).rejects.toThrow("bb could not find the Codex CLI on this machine");
  });

  it("keeps the launcher-specific reason when Windows finds an unusable codex", async () => {
    const binDirectory = makeBinDirectory();
    const scriptPath = writeExecutable(binDirectory, "codex.ps1");

    await expect(
      resolveCodexAppServerLaunch({
        env: { Path: binDirectory, PATHEXT: ".EXE;.CMD;.PS1" },
        platform: "win32",
      }),
    ).rejects.toThrow(`Windows launcher ${scriptPath} cannot be started`);
  });

  it.runIf(onWindows)(
    "resolves the Codex CLI installed on this Windows host",
    async () => {
      const launch = await resolveCodexAppServerLaunch({
        env: process.env,
        platform: "win32",
      });
      expect(launch.command.toLowerCase()).toContain("codex");
      expect(launch.args).toEqual(["app-server"]);
    },
  );
});

describe("Codex Account Pool isolation", () => {
  it.each([
    { label: "base URL", env: { CODEX_OPENAI_BASE_URL: "" } },
    { label: "hub token", env: { CODEX_POOL_AUTH_TOKEN: "" } },
    {
      label: "both values",
      env: { CODEX_OPENAI_BASE_URL: "", CODEX_POOL_AUTH_TOKEN: "" },
    },
  ])(
    "drops pool routing when an inherited $label is neutralised with an empty value",
    (args) => {
      const launch = resolveAppServerLaunch({
        CODEX_OPENAI_BASE_URL: "https://parent.example/pool/v1",
        CODEX_POOL_AUTH_TOKEN: "inherited-parent-token",
        ...args.env,
      });
      expect(launch).toEqual({ command: "codex", args: ["app-server"] });
      expect(JSON.stringify(launch.args)).not.toContain("parent.example");
      expect(JSON.stringify(launch.args)).not.toContain(
        "inherited-parent-token",
      );
    },
  );
});
