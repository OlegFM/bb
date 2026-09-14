import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { extname, resolve, win32 as win32Path } from "node:path";

export const BB_CLI_REEXEC_ENV = "BB_CLI_REEXEC";

interface MaybeReexecViaBbCliArgs {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  currentExecutablePath?: string;
  exit?: (code: number) => void;
  reexec?: (args: {
    target: string;
    argv: string[];
    env: NodeJS.ProcessEnv;
  }) => void;
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(resolve(path));
  } catch {
    return null;
  }
}

const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat"]);

export interface NodeLauncherSpawnPlan {
  command: string;
  argsPrefix: string[];
}

export async function resolveNodeLauncherSpawnPlan(
  cliPath: string,
  platform: NodeJS.Platform,
): Promise<NodeLauncherSpawnPlan> {
  const extension = extname(cliPath).toLowerCase();
  if (platform !== "win32" || !WINDOWS_SHIM_EXTENSIONS.has(extension)) {
    return { command: cliPath, argsPrefix: [] };
  }
  const { readNodeCmdShim } = await import("@bb/process-utils");
  const shim = await readNodeCmdShim(cliPath);
  if (shim === null) {
    throw new Error(
      `Windows launcher ${cliPath} is not a Node shim bb can start directly`,
    );
  }
  return { command: shim.command, argsPrefix: shim.args };
}

export function nodeLauncherPlanTargetsScript(
  plan: NodeLauncherSpawnPlan,
  scriptPath: string,
): boolean {
  const shimTarget = plan.argsPrefix[0];
  if (shimTarget === undefined) {
    return false;
  }
  return (
    win32Path.resolve(shimTarget).toLowerCase() ===
    win32Path.resolve(scriptPath).toLowerCase()
  );
}

export async function maybeReexecViaBbCli(
  options: MaybeReexecViaBbCliArgs = {},
): Promise<void> {
  const env = options.env ?? process.env;
  if (env[BB_CLI_REEXEC_ENV] === "1") {
    return;
  }

  const targetRaw = env.BB_CLI?.trim();
  if (!targetRaw) {
    return;
  }

  const currentRaw = options.currentExecutablePath ?? process.argv[1];
  if (!currentRaw) {
    return;
  }

  const target = tryRealpath(targetRaw);
  const current = tryRealpath(currentRaw);
  if (target === null || current === null || target === current) {
    return;
  }

  const argv = options.argv ?? process.argv.slice(2);
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    [BB_CLI_REEXEC_ENV]: "1",
  };

  if (options.reexec) {
    options.reexec({ target, argv, env: childEnv });
    return;
  }

  const exitProcess = options.exit ?? process.exit;

  let plan: NodeLauncherSpawnPlan;
  try {
    plan = await resolveNodeLauncherSpawnPlan(target, process.platform);
  } catch (error) {
    process.stderr.write(
      `bb: failed to re-exec BB_CLI=${target}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    exitProcess(1);
    return;
  }

  if (nodeLauncherPlanTargetsScript(plan, current)) {
    return;
  }

  const result = spawnSync(plan.command, [...plan.argsPrefix, ...argv], {
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(
      `bb: failed to re-exec BB_CLI=${target}: ${result.error.message}\n`,
    );
    process.exitCode = 1;
    return;
  }
  exitProcess(result.status === null ? 1 : result.status);
}
