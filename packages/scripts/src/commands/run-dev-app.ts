import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCurrentDevInstanceConfig,
  stripThreadContextEnv,
} from "@bb/config/runtime";
import type { DevInstanceConfig } from "@bb/config/runtime";
import {
  spawnPortableOutputProcess,
  spawnPortableProcess,
} from "@bb/process-utils";
import {
  DESKTOP_READY_TIMEOUT_MS,
  DEV_FAILURE_PATTERNS,
  DEV_SERVER_READY_PATTERN,
  DEV_SERVER_READY_TIMEOUT_MS,
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
} from "../lib/dev-app-launcher.js";
import type { DevAppPaths } from "../lib/dev-app-launcher.js";
import { runScriptProcess } from "../lib/process-helpers.js";

const commandsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(commandsDir, "..", "..", "..", "..");

const sessionHostPath = fileURLToPath(
  new URL(`./run-dev-app-session-host${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);
const windowsSessionHost = {
  command: process.execPath,
  args: [...process.execArgv, sessionHostPath],
};

const USAGE = [
  "Usage: pnpm dev:app <command> [flags] (shortcuts: pnpm dev:desktop | pnpm dev:status | pnpm dev:stop)",
  "  current [--desktop] [--open]   restart the source dev loop for this checkout",
  "  status                         print instance, ports and session state",
  "  stop                           stop the dev server and desktop sessions",
  "  env [--powershell]             print shell lines that target this checkout's dev server",
  "  logs [dev|desktop]             follow a session log",
].join("\n");

function log(message: string): void {
  process.stderr.write(`[dev-app] ${message}\n`);
}

function captureCommandOutput(
  command: string,
  args: string[],
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawnPortableOutputProcess({
      args,
      command,
      cwd: repoRoot,
      env: process.env,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => resolvePromise(null));
    child.once("close", (code) => {
      resolvePromise(
        code === 0 ? Buffer.concat(chunks).toString("utf8").trim() : null,
      );
    });
  });
}

async function runStep(
  description: string,
  command: string,
  args: string[],
): Promise<void> {
  log(description);
  const code = await runScriptProcess({
    args,
    command,
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (code !== 0) {
    throw new Error(`${description} failed with exit code ${code}`);
  }
}

async function ensureDependencies(desktop: boolean): Promise<void> {
  await runStep("Installing dependencies", "pnpm", ["install", "--frozen-lockfile"]);
  await runStep("Checking native modules", process.execPath, [
    join(repoRoot, "scripts", "ensure-native-modules.mjs"),
  ]);
  await runStep("Building the plugin SDK", "pnpm", [
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@get-bb/plugin-sdk",
    "--output-logs=new-only",
  ]);
  if (!desktop) {
    return;
  }
  const desktopRequire = createRequire(
    join(repoRoot, "apps", "desktop", "package.json"),
  );
  try {
    desktopRequire("electron");
  } catch {
    const installScript = desktopRequire.resolve("electron/install.js");
    await runStep("Installing the Electron binary", process.execPath, [installScript]);
  }
}

function childEnv(): NodeJS.ProcessEnv {
  return stripThreadContextEnv(process.env);
}

async function stopAll(paths: DevAppPaths): Promise<void> {
  const desktop = await stopTrackedProcess({
    pidPath: paths.desktopPidPath,
    platform: process.platform,
    serviceName: "desktop",
  });
  log(`desktop: ${desktop === "stopped" ? "stopped" : "not running"}`);
  const dev = await stopTrackedProcess({
    pidPath: paths.devPidPath,
    platform: process.platform,
    serviceName: "dev server",
  });
  log(`dev server: ${dev === "stopped" ? "stopped" : "not running"}`);
}

function trackedSessionIsAlive(args: {
  pidPath: string;
  serviceName: string;
}): () => Promise<boolean> {
  return async () => (await readTrackedProcessState(args)) === "running";
}

async function startDevServer(paths: DevAppPaths): Promise<void> {
  log(`Starting dev server, log ${paths.devLogPath}`);
  await startLoggedProcess({
    args: ["run", "dev"],
    command: "pnpm",
    cwd: repoRoot,
    env: childEnv(),
    logPath: paths.devLogPath,
    pidPath: paths.devPidPath,
    platform: process.platform,
    windowsSessionHost,
  });
  await waitForLogPattern({
    description: "dev server",
    failurePatterns: DEV_FAILURE_PATTERNS,
    isAlive: trackedSessionIsAlive({
      pidPath: paths.devPidPath,
      serviceName: "dev server",
    }),
    logPath: paths.devLogPath,
    readyPattern: DEV_SERVER_READY_PATTERN,
    timeoutMs: DEV_SERVER_READY_TIMEOUT_MS,
  });
}

async function startDesktop(
  config: DevInstanceConfig,
  paths: DevAppPaths,
): Promise<void> {
  log(`Starting desktop, log ${paths.desktopLogPath}`);
  await startLoggedProcess({
    args: ["exec", "turbo", "run", "dev", "--filter=@bb/desktop"],
    command: "pnpm",
    cwd: repoRoot,
    env: childEnv(),
    logPath: paths.desktopLogPath,
    pidPath: paths.desktopPidPath,
    platform: process.platform,
    windowsSessionHost,
  });
  await waitForLogPattern({
    description: "desktop app",
    failurePatterns: DEV_FAILURE_PATTERNS,
    isAlive: trackedSessionIsAlive({
      pidPath: paths.desktopPidPath,
      serviceName: "desktop",
    }),
    logPath: paths.desktopLogPath,
    readyPattern: desktopReadyPattern(config.ports.appPort),
    timeoutMs: DESKTOP_READY_TIMEOUT_MS,
  });
}

function openAppUrl(config: DevInstanceConfig): void {
  const url = `http://localhost:${config.ports.appPort}`;
  const opener = resolveOpenUrlCommand(process.platform, url);
  const child = spawnPortableProcess({
    args: opener.args,
    command: opener.command,
    cwd: repoRoot,
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.once("error", (error) => log(`Could not open ${url}: ${error.message}`));
  child.unref();
}

async function printStatus(
  config: DevInstanceConfig,
  paths: DevAppPaths,
): Promise<void> {
  const [branchName, commit, devState, desktopState] = await Promise.all([
    captureCommandOutput("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    captureCommandOutput("git", ["rev-parse", "--short", "HEAD"]),
    readTrackedProcessState({ pidPath: paths.devPidPath, serviceName: "dev server" }),
    readTrackedProcessState({ pidPath: paths.desktopPidPath, serviceName: "desktop" }),
  ]);
  process.stdout.write(
    `${formatDevAppStatus({
      branch: `${branchName ?? "unknown"} (${commit ?? "unknown"})`,
      config,
      desktopState,
      devState,
      execPath: process.execPath,
      nodeAbi: process.versions.modules,
      nodeVersion: process.version,
      paths,
    })}\n`,
  );
}

async function main(): Promise<void> {
  const args = parseDevAppArgs(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const config = resolveCurrentDevInstanceConfig(repoRoot);
  const paths = resolveDevAppPaths(config, process.env);
  if (args.command === "status") {
    await printStatus(config, paths);
    return;
  }
  if (args.command === "stop") {
    await stopAll(paths);
    return;
  }
  if (args.command === "env") {
    process.stdout.write(
      `${formatDevAppEnv(config, args.powershell ? "powershell" : "posix")}\n`,
    );
    return;
  }
  if (args.command === "logs") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await followLogFile({
      logPath: args.logTarget === "desktop" ? paths.desktopLogPath : paths.devLogPath,
      signal: controller.signal,
      write: (chunk) => {
        process.stdout.write(chunk);
      },
    });
    return;
  }
  if (args.desktop) {
    assertDesktopNodeRuntime({
      execPath: process.execPath,
      version: process.version,
    });
  }
  await stopAll(paths);
  await ensureDependencies(args.desktop);
  await startDevServer(paths);
  if (args.desktop) {
    await startDesktop(config, paths);
  }
  if (args.open) {
    openAppUrl(config);
  }
  await printStatus(config, paths);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[dev-app] ${message}\n${USAGE}\n`);
  process.exitCode = 1;
});
