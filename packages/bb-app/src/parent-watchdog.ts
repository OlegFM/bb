const PARENT_PID_ENV_NAME = "BB_DESKTOP_PARENT_PID";

interface ResolveParentProcessPidArgs {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

interface StartParentProcessWatchdogArgs {
  env: NodeJS.ProcessEnv;
  intervalMs: number;
  isProcessAlive?: (pid: number) => boolean;
  onParentExit: () => void;
  platform: NodeJS.Platform;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function resolveParentProcessPid(
  args: ResolveParentProcessPidArgs,
): number | null {
  if (args.platform !== "win32") {
    return null;
  }
  const raw = args.env[PARENT_PID_ENV_NAME]?.trim();
  if (raw === undefined || !/^\d+$/u.test(raw)) {
    return null;
  }
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function startParentProcessWatchdog(
  args: StartParentProcessWatchdogArgs,
): () => void {
  const parentPid = resolveParentProcessPid({
    env: args.env,
    platform: args.platform,
  });
  if (parentPid === null) {
    return () => undefined;
  }
  const isProcessAlive = args.isProcessAlive ?? defaultIsProcessAlive;
  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) {
      return;
    }
    clearInterval(timer);
    args.onParentExit();
  }, args.intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
