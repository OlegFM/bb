import { beforeEach, describe, expect, it, vi } from "vitest";

const probeState = vi.hoisted(() => ({
  resolvedExecutable: null as string | null,
  outputs: new Map<string, string>(),
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@get-bb/plugin-sdk/provider-bridge")>();
  return {
    ...original,
    experimental_resolveExecutablePath: vi.fn(
      async () => probeState.resolvedExecutable,
    ),
    experimental_commandOutput: vi.fn(
      async (command: string, args: readonly string[]) =>
        probeState.outputs.get([command, ...args].join(" ")) ?? null,
    ),
    experimental_probeNpmGlobalPackage: vi.fn(async () => ({
      npmBin: null,
      npmGlobalPackageVersion: null,
    })),
  };
});

import {
  __testing,
  getClaudeProviderInstallationStatus,
} from "./provider-maintenance.js";

const WINDOWS_REASON =
  "bb cannot run the Claude Code shell installer on Windows. Install Claude Code from https://claude.com/claude-code, then reload.";

function installClaude(version: string, latest: string): void {
  probeState.resolvedExecutable = "C:\\Users\\dev\\.local\\bin\\claude.exe";
  probeState.outputs.set("claude --version", `${version} (Claude Code)`);
  probeState.outputs.set(
    "claude doctor",
    "Running: native\nAuto-update channel: latest\n",
  );
  probeState.outputs.set(
    "npm view @anthropic-ai/claude-code dist-tags --json",
    JSON.stringify({ latest, stable: latest }),
  );
}

beforeEach(() => {
  probeState.resolvedExecutable = null;
  probeState.outputs = new Map();
});

describe("Claude Code install matrix", () => {
  it("reports why a missing install cannot be fixed on win32", async () => {
    const status = await getClaudeProviderInstallationStatus({
      platform: "win32",
      env: {},
    });

    expect(status.installed).toBe(false);
    expect(status.installAction).toBeNull();
    expect(status.installUnavailableReason).toBe(WINDOWS_REASON);
  });

  it("keeps the posix shell installer and no reason", async () => {
    const status = await getClaudeProviderInstallationStatus({
      platform: "linux",
      env: {},
    });

    expect(status.installed).toBe(false);
    expect(status.installAction).toMatchObject({
      kind: "install",
      label: "Install",
    });
    expect(status.installAction?.command).toContain(
      "https://claude.ai/install.sh",
    );
    expect(status.installUnavailableReason).toBeNull();
  });

  it("still offers claude update for an outdated native install on win32", async () => {
    installClaude("2.0.14", "2.1.0");

    const status = await getClaudeProviderInstallationStatus({
      platform: "win32",
      env: {},
    });

    expect(status.needsUpdate).toBe(true);
    expect(status.installAction).toEqual({
      kind: "update",
      label: "Update",
      command: "claude update",
    });
    expect(status.installUnavailableReason).toBeNull();
  });

  it("refuses an install run on win32 with the status reason", async () => {
    const status = await getClaudeProviderInstallationStatus({
      platform: "win32",
      env: {},
    });

    expect(
      __testing.buildProviderInstallationRun(status, "install", {
        platform: "win32",
        env: {},
      }),
    ).toEqual({ available: false, message: WINDOWS_REASON });
  });

  it("runs the posix installer from a matching status", async () => {
    const status = await getClaudeProviderInstallationStatus({
      platform: "linux",
      env: {},
    });

    const run = __testing.buildProviderInstallationRun(status, "install", {
      platform: "linux",
      env: {},
    });

    expect(run).toMatchObject({
      available: true,
      command: { command: "sh" },
      verification: { kind: "installed" },
    });
    expect(run.available && run.command.args).toHaveLength(2);
    expect(run.available && run.command.args[1]).toContain(
      "https://claude.ai/install.sh",
    );
  });
});
