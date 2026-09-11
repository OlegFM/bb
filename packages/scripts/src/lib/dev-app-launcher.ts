import { join } from "node:path";
import type { DevInstanceConfig } from "@bb/config/runtime";

export type DevAppCommand =
  | "current"
  | "env"
  | "help"
  | "logs"
  | "status"
  | "stop";

export type DevAppLogTarget = "desktop" | "dev";

export interface DevAppArgs {
  command: DevAppCommand;
  desktop: boolean;
  logTarget: DevAppLogTarget;
  open: boolean;
  powershell: boolean;
}

export type DevAppEnvShell = "posix" | "powershell";

export interface DevAppPaths {
  desktopLogPath: string;
  desktopPidPath: string;
  desktopUserDataDir: string;
  devLogPath: string;
  devPidPath: string;
  logRoot: string;
}

export type DevAppProcessState = "running" | "stopped";

export interface DevAppStatusArgs {
  branch: string;
  codexVersion: string;
  config: DevInstanceConfig;
  desktopState: DevAppProcessState;
  devState: DevAppProcessState;
  execPath: string;
  nodeAbi: string;
  nodeVersion: string;
  paths: DevAppPaths;
}

export const DEV_SERVER_READY_PATTERN = /Host daemon started/u;

export const DEV_FAILURE_PATTERNS: readonly RegExp[] = [
  /port .* is unavailable/u,
  /ELIFECYCLE/u,
  /ERROR {2}run failed/u,
];

export const DEV_SERVER_READY_TIMEOUT_MS = 90_000;
export const DESKTOP_READY_TIMEOUT_MS = 120_000;

export function desktopReadyPattern(appPort: number): RegExp {
  return new RegExp(`@bb/desktop: app http://localhost:${appPort}(?![0-9])`, "u");
}

function parseLogTarget(word: string | undefined): DevAppLogTarget {
  if (word === undefined || word === "dev") {
    return "dev";
  }
  if (word === "desktop") {
    return "desktop";
  }
  throw new Error(`Unknown log target: ${word}`);
}

export function parseDevAppArgs(argv: readonly string[]): DevAppArgs {
  const flags = { desktop: false, open: false, powershell: false };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--desktop") {
      flags.desktop = true;
    } else if (arg === "--open") {
      flags.open = true;
    } else if (arg === "--powershell") {
      flags.powershell = true;
    } else {
      positional.push(arg);
    }
  }
  const [commandWord = "help", ...rest] = positional;
  if (commandWord === "logs") {
    const [targetWord, ...extra] = rest;
    if (extra.length > 0) {
      throw new Error(`Unexpected arguments: ${extra.join(" ")}`);
    }
    return { ...flags, command: "logs", logTarget: parseLogTarget(targetWord) };
  }
  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
  }
  switch (commandWord) {
    case "current":
    case "env":
    case "status":
    case "stop":
      return { ...flags, command: commandWord, logTarget: "dev" };
    case "help":
    case "-h":
    case "--help":
      return { ...flags, command: "help", logTarget: "dev" };
    default:
      throw new Error(`Unknown command: ${commandWord}`);
  }
}

export function formatDevAppEnv(
  config: DevInstanceConfig,
  shell: DevAppEnvShell,
): string {
  const assignments: Array<[string, string]> = [
    ["BB_SERVER_URL", config.serverUrl],
    ["BB_HOST_DAEMON_PORT", String(config.ports.hostDaemonPort)],
    ["BB_PROJECT_ID", "proj_personal"],
  ];
  const removals = ["BB_THREAD_ID", "BB_ENVIRONMENT_ID", "BB_THREAD_STORAGE"];
  if (shell === "powershell") {
    return [
      ...assignments.map(([key, value]) => `$env:${key} = "${value}"`),
      ...removals.map(
        (key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`,
      ),
    ].join("\n");
  }
  return [
    ...assignments.map(([key, value]) => `export ${key}=${value}`),
    ...removals.map((key) => `unset ${key}`),
  ].join("\n");
}

export function resolveDevAppPaths(
  config: DevInstanceConfig,
  env: NodeJS.ProcessEnv,
): DevAppPaths {
  const logRoot = join(config.dataDir, "dev-app");
  const pidRoot = join(config.dataDir, "dev-supervisors");
  const configuredUserDataDir = env.BB_DESKTOP_USER_DATA_DIR?.trim();
  return {
    desktopLogPath: join(logRoot, "desktop.log"),
    desktopPidPath: join(pidRoot, "dev-app-desktop.pid"),
    desktopUserDataDir:
      configuredUserDataDir !== undefined && configuredUserDataDir.length > 0
        ? configuredUserDataDir
        : join(config.dataDir, "desktop"),
    devLogPath: join(logRoot, "dev.log"),
    devPidPath: join(pidRoot, "dev-app-dev.pid"),
    logRoot,
  };
}

export function assertDesktopNodeRuntime(args: {
  execPath: string;
  version: string;
}): void {
  const match = /^v?(\d+)\.(\d+)\./u.exec(args.version);
  const major = match ? Number(match[1]) : Number.NaN;
  const minor = match ? Number(match[2]) : Number.NaN;
  if (major !== 22 || minor < 19) {
    throw new Error(
      `pnpm dev:desktop needs Node 22.19 or newer on the 22 line (see .nvmrc); current ${args.version} at ${args.execPath}`,
    );
  }
}

export function resolveOpenUrlCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function formatDevAppStatus(args: DevAppStatusArgs): string {
  return [
    `Repo: ${args.config.repoRoot}`,
    `Branch: ${args.branch}`,
    `Node: ${args.nodeVersion} (ABI ${args.nodeAbi}) at ${args.execPath}`,
    `Codex: ${args.codexVersion}`,
    `Instance: ${args.config.instanceId}`,
    `Data dir: ${args.config.dataDir}`,
    `App: http://localhost:${args.config.ports.appPort}`,
    `Server: ${args.config.serverUrl}`,
    `Host daemon: http://127.0.0.1:${args.config.ports.hostDaemonPort}`,
    `Desktop user data: ${args.paths.desktopUserDataDir}`,
    `Dev session: ${args.devState}`,
    `Desktop session: ${args.desktopState}`,
    `Logs: ${args.paths.devLogPath}, ${args.paths.desktopLogPath}`,
  ].join("\n");
}
