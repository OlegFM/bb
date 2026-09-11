import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDevInstanceConfig } from "@bb/config/runtime";
import {
  DEV_FAILURE_PATTERNS,
  DEV_SERVER_READY_PATTERN,
  assertDesktopNodeRuntime,
  desktopReadyPattern,
  formatDevAppEnv,
  formatDevAppStatus,
  parseDevAppArgs,
  resolveDevAppPaths,
  resolveOpenUrlCommand,
} from "../src/lib/dev-app-launcher.js";

const homeDir = join("/", "home", "dev");
const repoRoot = join(homeDir, "work", "bb");
const config = resolveDevInstanceConfig({ homeDir, repoRoot });

const defaults = {
  desktop: false,
  logTarget: "dev",
  open: false,
  powershell: false,
} as const;

describe("parseDevAppArgs", () => {
  it("defaults to help and accepts flags anywhere", () => {
    expect(parseDevAppArgs([])).toEqual({ ...defaults, command: "help" });
    expect(parseDevAppArgs(["--desktop", "current", "--open"])).toEqual({
      ...defaults,
      command: "current",
      desktop: true,
      open: true,
    });
    expect(parseDevAppArgs(["status"])).toEqual({ ...defaults, command: "status" });
    expect(parseDevAppArgs(["--help"])).toEqual({ ...defaults, command: "help" });
    expect(parseDevAppArgs(["env", "--powershell"])).toEqual({
      ...defaults,
      command: "env",
      powershell: true,
    });
  });

  it("takes an optional log target for logs", () => {
    expect(parseDevAppArgs(["logs"])).toEqual({ ...defaults, command: "logs" });
    expect(parseDevAppArgs(["logs", "desktop"])).toEqual({
      ...defaults,
      command: "logs",
      logTarget: "desktop",
    });
    expect(() => parseDevAppArgs(["logs", "launcher"])).toThrow("Unknown log target: launcher");
  });

  it("rejects unknown commands and stray arguments", () => {
    expect(() => parseDevAppArgs(["main"])).toThrow("Unknown command: main");
    expect(() => parseDevAppArgs(["stop", "extra"])).toThrow("Unexpected arguments: extra");
  });
});

describe("formatDevAppEnv", () => {
  it("prints the six launcher env lines for a POSIX shell", () => {
    expect(formatDevAppEnv(config, "posix").split("\n")).toEqual([
      `export BB_SERVER_URL=${config.serverUrl}`,
      `export BB_HOST_DAEMON_PORT=${config.ports.hostDaemonPort}`,
      "export BB_PROJECT_ID=proj_personal",
      "unset BB_THREAD_ID",
      "unset BB_ENVIRONMENT_ID",
      "unset BB_THREAD_STORAGE",
    ]);
  });

  it("prints the same lines for PowerShell", () => {
    expect(formatDevAppEnv(config, "powershell").split("\n")).toEqual([
      `$env:BB_SERVER_URL = "${config.serverUrl}"`,
      `$env:BB_HOST_DAEMON_PORT = "${config.ports.hostDaemonPort}"`,
      '$env:BB_PROJECT_ID = "proj_personal"',
      "Remove-Item Env:BB_THREAD_ID -ErrorAction SilentlyContinue",
      "Remove-Item Env:BB_ENVIRONMENT_ID -ErrorAction SilentlyContinue",
      "Remove-Item Env:BB_THREAD_STORAGE -ErrorAction SilentlyContinue",
    ]);
  });
});

describe("resolveDevAppPaths", () => {
  it("scopes logs and pid files to the checkout instance", () => {
    const paths = resolveDevAppPaths(config, {});

    expect(paths.logRoot).toBe(join(config.dataDir, "dev-app"));
    expect(paths.devLogPath).toBe(join(config.dataDir, "dev-app", "dev.log"));
    expect(paths.desktopLogPath).toBe(join(config.dataDir, "dev-app", "desktop.log"));
    expect(paths.devPidPath).toBe(join(config.dataDir, "dev-supervisors", "dev-app-dev.pid"));
    expect(paths.desktopPidPath).toBe(join(config.dataDir, "dev-supervisors", "dev-app-desktop.pid"));
    expect(paths.desktopUserDataDir).toBe(join(config.dataDir, "desktop"));
  });

  it("honours BB_DESKTOP_USER_DATA_DIR", () => {
    const paths = resolveDevAppPaths(config, { BB_DESKTOP_USER_DATA_DIR: " /custom/desktop " });

    expect(paths.desktopUserDataDir).toBe("/custom/desktop");
  });
});

describe("assertDesktopNodeRuntime", () => {
  it("accepts Node 22.19 and newer on the 22 line", () => {
    expect(() => assertDesktopNodeRuntime({ execPath: "/n/node", version: "v22.19.0" })).not.toThrow();
    expect(() => assertDesktopNodeRuntime({ execPath: "/n/node", version: "v22.23.2" })).not.toThrow();
  });

  it("rejects other lines and older 22 releases", () => {
    for (const version of ["v22.18.9", "v24.12.0", "v20.19.0"]) {
      expect(() => assertDesktopNodeRuntime({ execPath: "/n/node", version })).toThrow(
        `needs Node 22.19 or newer on the 22 line (see .nvmrc); current ${version} at /n/node`,
      );
    }
  });
});

describe("resolveOpenUrlCommand", () => {
  it("picks the platform opener", () => {
    expect(resolveOpenUrlCommand("win32", "http://localhost:1")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "http://localhost:1"],
    });
    expect(resolveOpenUrlCommand("darwin", "http://localhost:1")).toEqual({
      command: "open",
      args: ["http://localhost:1"],
    });
    expect(resolveOpenUrlCommand("linux", "http://localhost:1")).toEqual({
      command: "xdg-open",
      args: ["http://localhost:1"],
    });
  });
});

describe("readiness patterns", () => {
  it("match the dev server and desktop banners and the known failures", () => {
    expect(DEV_SERVER_READY_PATTERN.test("[host-daemon] Host daemon started on 27001")).toBe(true);
    expect(desktopReadyPattern(11001).test("@bb/desktop: app http://localhost:11001 (Vite dev server — live reload)")).toBe(true);
    expect(desktopReadyPattern(11001).test("@bb/desktop: app http://localhost:11002")).toBe(false);
    expect(DEV_FAILURE_PATTERNS.some((pattern) => pattern.test("[dev] port 19001 is unavailable"))).toBe(true);
    expect(DEV_FAILURE_PATTERNS.some((pattern) => pattern.test("ELIFECYCLE Command failed"))).toBe(true);
    expect(DEV_FAILURE_PATTERNS.some((pattern) => pattern.test("ERROR  run failed: command exited (1)"))).toBe(true);
    expect(DEV_FAILURE_PATTERNS.some((pattern) => pattern.test("all good"))).toBe(false);
  });
});

describe("formatDevAppStatus", () => {
  it("prints the thirteen status lines", () => {
    const paths = resolveDevAppPaths(config, {});
    const status = formatDevAppStatus({
      branch: "main (abc1234)",
      codexVersion: "codex-cli 0.50.0",
      config,
      desktopState: "stopped",
      devState: "running",
      execPath: "/n/node",
      nodeAbi: "127",
      nodeVersion: "v22.19.0",
      paths,
    });

    expect(status.split("\n")).toEqual([
      `Repo: ${repoRoot}`,
      "Branch: main (abc1234)",
      "Node: v22.19.0 (ABI 127) at /n/node",
      "Codex: codex-cli 0.50.0",
      `Instance: ${config.instanceId}`,
      `Data dir: ${config.dataDir}`,
      `App: http://localhost:${config.ports.appPort}`,
      `Server: ${config.serverUrl}`,
      `Host daemon: http://127.0.0.1:${config.ports.hostDaemonPort}`,
      `Desktop user data: ${paths.desktopUserDataDir}`,
      "Dev session: running",
      "Desktop session: stopped",
      `Logs: ${paths.devLogPath}, ${paths.desktopLogPath}`,
    ]);
  });
});
