import { beforeEach, describe, expect, it, vi } from "vitest";

const probeState = vi.hoisted(() => ({
  resolvedExecutable: null as string | null,
  versionOutput: null as string | null,
  latestVersion: null as string | null,
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@get-bb/plugin-sdk/provider-bridge")>();
  return {
    ...original,
    experimental_resolveExecutablePath: vi.fn(
      async () => probeState.resolvedExecutable,
    ),
    experimental_commandOutput: vi.fn(async () => probeState.versionOutput),
    experimental_npmLatestVersion: vi.fn(async () => probeState.latestVersion),
    experimental_probeNpmGlobalPackage: vi.fn(async () => ({
      npmBin: null,
      npmGlobalPackageVersion: null,
    })),
  };
});

import { getCodexProviderInstallationStatus } from "./provider-maintenance.js";

beforeEach(() => {
  probeState.resolvedExecutable = null;
  probeState.versionOutput = null;
  probeState.latestVersion = null;
});

describe("Codex install matrix", () => {
  it("offers the npm install with no unavailable reason", async () => {
    probeState.latestVersion = "0.141.0";

    const status = await getCodexProviderInstallationStatus();

    expect(status.installAction).toEqual({
      kind: "install",
      label: "Install",
      command: "npm install -g @openai/codex@latest",
    });
    expect(status.installUnavailableReason).toBeNull();
  });

  it("keeps codex update with no unavailable reason", async () => {
    probeState.resolvedExecutable = "C:\\Program Files\\codex\\codex.exe";
    probeState.versionOutput = "codex-cli 0.140.0";
    probeState.latestVersion = "0.141.0";

    const status = await getCodexProviderInstallationStatus();

    expect(status.needsUpdate).toBe(true);
    expect(status.installAction).toEqual({
      kind: "update",
      label: "Update",
      command: "codex update",
    });
    expect(status.installUnavailableReason).toBeNull();
  });
});
