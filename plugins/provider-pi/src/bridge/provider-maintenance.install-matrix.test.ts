import { beforeEach, describe, expect, it, vi } from "vitest";

const probeState = vi.hoisted(() => ({
  executables: new Map<string, string>(),
  outputs: new Map<string, string>(),
  commandCalls: [] as string[],
  resolveCalls: [] as string[],
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@get-bb/plugin-sdk/provider-bridge")>();
  return {
    ...original,
    experimental_resolveExecutablePath: vi.fn(async (command: string) => {
      probeState.resolveCalls.push(command);
      return probeState.executables.get(command) ?? null;
    }),
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
  getPiProviderInstallationRun,
  getPiProviderInstallationStatus,
  piGlobalInstallCommand,
} from "./provider-maintenance.js";

const PI_WINDOWS_REASON =
  "bb needs bun or npm on Path to install Pi on Windows. Install Node.js or Bun, then reload.";
const NPM_INSTALL = "npm install -g @earendil-works/pi-coding-agent@latest";
const BUN_INSTALL = "bun add -g @earendil-works/pi-coding-agent@latest";
const WINDOWS_BUN_BIN = "C:\\Users\\dev\\.bun\\bin";
const POSIX_BUN_BIN = "/home/dev/.bun/bin";

beforeEach(() => {
  probeState.executables = new Map();
  probeState.outputs = new Map();
  probeState.commandCalls = [];
  probeState.resolveCalls = [];
});

describe("Pi install command matrix", () => {
  it("reads win32 bun ownership with win32 path semantics on any host", async () => {
    probeState.outputs.set("bun pm bin -g", WINDOWS_BUN_BIN);

    expect(
      await piGlobalInstallCommand(`${WINDOWS_BUN_BIN}\\pi.exe`, {
        platform: "win32",
        env: {},
      }),
    ).toEqual({
      command: "bun",
      args: ["add", "-g", "@earendil-works/pi-coding-agent@latest"],
      displayCommand: BUN_INSTALL,
    });
  });

  it("ignores win32 drive-letter casing when deciding bun ownership", async () => {
    probeState.outputs.set("bun pm bin -g", WINDOWS_BUN_BIN);

    expect(
      await piGlobalInstallCommand("c:\\USERS\\dev\\.bun\\BIN\\pi.exe", {
        platform: "win32",
        env: {},
      }),
    ).toMatchObject({ command: "bun" });
  });

  it("reads posix bun ownership with posix path semantics on any host", async () => {
    probeState.outputs.set("bun pm bin -g", POSIX_BUN_BIN);

    expect(
      await piGlobalInstallCommand(`${POSIX_BUN_BIN}/pi`, {
        platform: "linux",
        env: {},
      }),
    ).toMatchObject({ command: "bun", displayCommand: BUN_INSTALL });
  });

  it("installs a fresh pi through bun on win32 when bun is on Path", async () => {
    probeState.executables.set("bun", "C:\\Users\\dev\\.bun\\bin\\bun.exe");

    expect(
      await piGlobalInstallCommand(null, {
        platform: "win32",
        env: {},
      }),
    ).toMatchObject({ command: "bun", displayCommand: BUN_INSTALL });
    expect(probeState.commandCalls).not.toContain("npm --version");
  });

  it("falls back to npm on win32 when bun is absent and npm answers", async () => {
    probeState.outputs.set("npm --version", "10.9.3");

    expect(
      await piGlobalInstallCommand(null, {
        platform: "win32",
        env: {},
      }),
    ).toMatchObject({ command: "npm", displayCommand: NPM_INSTALL });
  });

  it("has no install command on win32 without bun or npm", async () => {
    expect(
      await piGlobalInstallCommand(null, {
        platform: "win32",
        env: {},
      }),
    ).toBeNull();
  });

  it("never updates a non-bun-managed pi through bun on win32", async () => {
    probeState.executables.set("bun", "C:\\Users\\dev\\.bun\\bin\\bun.exe");
    probeState.outputs.set("bun pm bin -g", WINDOWS_BUN_BIN);

    expect(
      await piGlobalInstallCommand("C:\\Program Files\\pi\\pi.exe", {
        platform: "win32",
        env: {},
      }),
    ).toBeNull();
  });

  it("keeps the unconditional npm fallback on posix", async () => {
    probeState.executables.set("bun", "/home/dev/.bun/bin/bun");

    expect(
      await piGlobalInstallCommand(null, {
        platform: "linux",
        env: {},
      }),
    ).toMatchObject({ command: "npm", displayCommand: NPM_INSTALL });
    expect(probeState.commandCalls).not.toContain("npm --version");
    expect(probeState.resolveCalls).not.toContain("bun");
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

  it("offers the bun install on win32 when only bun is on Path", async () => {
    probeState.executables.set("bun", "C:\\Users\\dev\\.bun\\bin\\bun.exe");

    const status = await getPiProviderInstallationStatus({
      platform: "win32",
      env: {},
    });

    expect(status.installAction).toEqual({
      kind: "install",
      label: "Install",
      command: BUN_INSTALL,
    });
    expect(status.installUnavailableReason).toBeNull();
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
