import { spawn } from "node:child_process";
import { resolveSpawnPlanOrThrow } from "./resolve-executable.js";
import { terminateProcessTree } from "./windows-process-stop.js";

const DEFAULT_CAPTURE_MAX_BYTES = 1024 * 1024;

export interface RunCommandCaptureArgs {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  maxBytes?: number;
  platform?: NodeJS.Platform;
  windowsHide?: boolean;
}

export interface CommandCaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  spawnError: string | null;
}

interface SettleArgs {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
}

export async function runCommandCapture(
  args: RunCommandCaptureArgs,
): Promise<CommandCaptureResult> {
  const platform = args.platform ?? process.platform;
  const plan = await resolveSpawnPlanOrThrow({
    command: args.command,
    args: args.args,
    env: args.env,
    platform,
    cwd: args.cwd,
  });
  const maxBytes = args.maxBytes ?? DEFAULT_CAPTURE_MAX_BYTES;

  return new Promise<CommandCaptureResult>((resolveResult) => {
    const child = spawn(plan.command, plan.args, {
      cwd: args.cwd,
      env: args.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide:
        platform === "win32" ? (args.windowsHide ?? true) : args.windowsHide,
    });

    let settled = false;
    let truncated = false;
    let timedOut = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    function stop(): void {
      if (platform === "win32") {
        void terminateProcessTree({ child, graceMs: 0, platform });
      } else {
        child.kill("SIGKILL");
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, args.timeoutMs);

    function collect(chunk: Buffer, chunks: Buffer[], bytes: number): number {
      if (bytes >= maxBytes) {
        truncated = true;
        return bytes;
      }
      const remaining = maxBytes - bytes;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        truncated = true;
        stop();
        return maxBytes;
      }
      chunks.push(chunk);
      return bytes + chunk.length;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(chunk, stdoutChunks, stdoutBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = collect(chunk, stderrChunks, stderrBytes);
    });

    function settle(result: SettleArgs): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveResult({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut,
        truncated,
        spawnError: result.spawnError,
      });
    }

    child.once("error", (error) => {
      settle({ exitCode: null, signal: null, spawnError: error.message });
    });
    child.once("close", (code, signal) => {
      settle({ exitCode: code, signal, spawnError: null });
    });
  });
}
