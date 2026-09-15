import { beforeEach, describe, expect, it, vi } from "vitest";

const probeState = vi.hoisted(() => ({
  outputs: new Map<string, string>(),
  commandCalls: [] as string[],
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@get-bb/plugin-sdk/provider-bridge")>();
  return {
    ...original,
    experimental_resolveExecutablePath: vi.fn(async () => null),
    experimental_commandOutput: vi.fn(
      async (command: string, args: readonly string[]) => {
        const key = [command, ...args].join(" ");
        probeState.commandCalls.push(key);
        return probeState.outputs.get(key) ?? null;
      },
    ),
    experimental_npmLatestVersion: vi.fn(async () => "0.85.0"),
    experimental_probeNpmGlobalPackage: vi.fn(async () => ({
      npmBin: null,
      npmGlobalPackageVersion: null,
    })),
  };
});

vi.mock("./rpc-child.js", () => ({
  resolvePiLaunch: () => ({ command: "bb-absent-pi-probe", args: [] }),
}));

import {
  __testing,
  getPiProviderInstallationRun,
  getPiProviderInstallationStatus,
} from "./provider-maintenance.js";

const PI_WINDOWS_REASON =
  "bb needs bun or npm on Path to install Pi on Windows. Install Node.js or Bun, then reload.";
const NPM_INSTALL = "npm install -g @earendil-works/pi-coding-agent@latest";
const BUN_INSTALL = "bun add -g @earendil-works/pi-coding-agent@latest";

beforeEach(() => {
  probeState.outputs = new Map();
  probeState.commandCalls = [];
});

describe("Pi install command matrix", () => {
  it("prefers bun for a bun-managed pi on win32, spelled for spawn resolution", async () => {
    probeState.outputs.set("bun pm bin -g", "C:\\Users\\dev\\.bun\\bin");

    expect(
      await __testing.piGlobalInstallCommand(
        "C:\\Users\\dev\\.bun\\bin\\pi.exe",
        { platform: "win32", env: {} },
      ),
    ).toEqual({
      command: "bun",
      args: ["add", "-g", "@earendil-works/pi-coding-agent@latest"],
      displayCommand: BUN_INSTALL,
    });
  });

  it("falls back to npm on win32 when npm answers", async () => {
    probeState.outputs.set("npm --version", "10.9.3");

    expect(
      await __testing.piGlobalInstallCommand(null, {
        platform: "win32",
        env: {},
      }),
    ).toMatchObject({ command: "npm", displayCommand: NPM_INSTALL });
  });

  it("has no install command on win32 without bun or npm", async () => {
    expect(
      await __testing.piGlobalInstallCommand(null, {
        platform: "win32",
        env: {},
      }),
    ).toBeNull();
  });

  it("keeps the unconditional npm fallback on posix", async () => {
    expect(
      await __testing.piGlobalInstallCommand(null, {
        platform: "linux",
        env: {},
      }),
    ).toMatchObject({ command: "npm", displayCommand: NPM_INSTALL });
    expect(probeState.commandCalls).not.toContain("npm --version");
  });
});

describe("Pi installation status", () => {
  it("reports the missing package manager on win32", async () => {
    const status = await getPiProviderInstallationStatus({
      platform: "win32",
      env: {},
    });

    expect(status.installed).toBe(false);
    expect(status.installAction).toBeNull();
    expect(status.installUnavailableReason).toBe(PI_WINDOWS_REASON);
    expect(
      await getPiProviderInstallationRun("install", {
        platform: "win32",
        env: {},
      }),
    ).toEqual({ available: false, message: PI_WINDOWS_REASON });
  });

  it("offers the npm install with no reason on posix", async () => {
    const status = await getPiProviderInstallationStatus({
      platform: "linux",
      env: {},
    });

    expect(status.installAction).toEqual({
      kind: "install",
      label: "Install",
      command: NPM_INSTALL,
    });
    expect(status.installUnavailableReason).toBeNull();
  });
});
