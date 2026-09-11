import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveDevInstanceConfig } from "@bb/config/runtime";
import {
  DEV_FAILURE_PATTERNS,
  DEV_SERVER_READY_PATTERN,
  assertDesktopNodeRuntime,
  desktopReadyPattern,
  followLogFile,
  formatDevAppEnv,
  formatDevAppStatus,
  parseDevAppArgs,
  readTrackedProcessState,
  resolveDevAppPaths,
  resolveOpenUrlCommand,
  startLoggedProcess,
  stopTrackedProcess,
  waitForLogPattern,
} from "../src/lib/dev-app-launcher.js";

const homeDir = join("/", "home", "dev");
const repoRoot = join(homeDir, "work", "bb");
const config = resolveDevInstanceConfig({ homeDir, repoRoot });

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const windowsSessionHost = {
  command: process.execPath,
  args: [
    "--conditions=source",
    "--import",
    "tsx",
    join(monorepoRoot, "packages", "scripts", "src", "commands", "run-dev-app-session-host.ts"),
  ],
};

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

describe("tracked processes", () => {
  it("starts a detached logged child, reports it, and stops its tree", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bb-dev-app-"));
    const logPath = join(tempRoot, "child.log");
    const pidPath = join(tempRoot, "child.pid");
    try {
      const pid = await startLoggedProcess({
        args: ["-e", "console.log('child ready'); setInterval(() => {}, 1000)"],
        command: process.execPath,
        cwd: monorepoRoot,
        env: process.env,
        logPath,
        pidPath,
        platform: process.platform,
        windowsSessionHost,
      });
      expect(pid).toBeGreaterThan(0);

      await waitForLogPattern({
        description: "child",
        failurePatterns: [],
        logPath,
        pollIntervalMs: 50,
        readyPattern: /child ready/u,
        timeoutMs: 15_000,
      });
      expect(await readTrackedProcessState({ pidPath, serviceName: "child" })).toBe("running");

      expect(await stopTrackedProcess({ pidPath, platform: process.platform, serviceName: "child" })).toBe("stopped");
      expect(await readTrackedProcessState({ pidPath, serviceName: "child" })).toBe("stopped");
      expect(await stopTrackedProcess({ pidPath, platform: process.platform, serviceName: "child" })).toBe("not-running");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails fast on a failure pattern and times out otherwise", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bb-dev-app-"));
    const logPath = join(tempRoot, "child.log");
    const pidPath = join(tempRoot, "child.pid");
    try {
      await startLoggedProcess({
        args: ["-e", "console.log('port 1 is unavailable'); setInterval(() => {}, 1000)"],
        command: process.execPath,
        cwd: monorepoRoot,
        env: process.env,
        logPath,
        pidPath,
        platform: process.platform,
        windowsSessionHost,
      });
      await expect(
        waitForLogPattern({
          description: "dev server",
          failurePatterns: [/port .* is unavailable/u],
          logPath,
          pollIntervalMs: 50,
          readyPattern: /never/u,
          timeoutMs: 15_000,
        }),
      ).rejects.toThrow(`dev server failed to start; see ${logPath}`);
      await expect(
        waitForLogPattern({
          description: "dev server",
          failurePatterns: [],
          logPath,
          pollIntervalMs: 50,
          readyPattern: /never/u,
          timeoutMs: 200,
        }),
      ).rejects.toThrow(`Timed out after 200 ms waiting for dev server; see ${logPath}`);
      await stopTrackedProcess({ pidPath, platform: process.platform, serviceName: "child" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects when the process cannot be spawned and leaves no pid file", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bb-dev-app-"));
    const logPath = join(tempRoot, "child.log");
    const pidPath = join(tempRoot, "child.pid");
    try {
      await expect(
        startLoggedProcess({
          args: ["-e", "console.log('unreachable')"],
          command: process.execPath,
          cwd: join(tempRoot, "definitely-missing-cwd"),
          env: process.env,
          logPath,
          pidPath,
          platform: process.platform,
          windowsSessionHost,
        }),
      ).rejects.toThrow();
      expect(existsSync(pidPath)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("followLogFile", () => {
  it("replays existing content, streams appended chunks, and stops on abort", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bb-dev-app-"));
    const logPath = join(tempRoot, "dev.log");
    const chunks: string[] = [];
    const controller = new AbortController();
    try {
      const following = followLogFile({
        logPath,
        pollIntervalMs: 20,
        signal: controller.signal,
        write: (chunk) => {
          chunks.push(chunk);
        },
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
      writeFileSync(logPath, "first line\n");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
      appendFileSync(logPath, "second line\n");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
      controller.abort();
      await following;

      expect(chunks.join("")).toBe("first line\nsecond line\n");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
