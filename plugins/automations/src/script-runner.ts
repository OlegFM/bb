import {
  execFile,
  spawn,
  type ChildProcess,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { access, mkdir, stat } from "node:fs/promises";
import {
  assignPathEnv,
  readNodeCmdShim,
  readWindowsEnvValue,
  resolveExecutable,
  resolveWindowsSystemToolPath,
  splitWindowsPathList,
  terminateProcessTree,
} from "@bb/process-utils";
import {
  AUTOMATION_SCRIPT_TIMEOUT_MAX_MS,
  type AutomationScriptInterpreter,
} from "./rpc-types.js";
import {
  resolveAutomationScriptPath,
  resolveDefaultInterpreter,
  resolveInterpreterCommand,
  scriptsRoot,
} from "./script-files.js";

const execFileAsync = promisify(execFile);
const SCRIPT_OUTPUT_MAX_BYTES = 1024 * 1024;

let resolvedBbPath: string | null = null;

const BB_NOT_INJECTED_WARNING =
  "[bb] warning: could not locate the bb CLI, so `bb` is not on PATH for this script.";

export interface ProbeSpawnPlan {
  command: string;
  args: string[];
  verbatim: boolean;
}

export async function resolveProbeSpawnPlan(
  command: string,
  args: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<ProbeSpawnPlan> {
  if (platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) {
    return { command, args, verbatim: false };
  }
  const shim = await readNodeCmdShim(command);
  if (shim !== null) {
    return {
      command: shim.command,
      args: [...shim.args, ...args],
      verbatim: false,
    };
  }
  return {
    command: resolveWindowsSystemToolPath("cmd.exe", env),
    args: ["/d", "/s", "/c", `""${command}" ${args.join(" ")}"`],
    verbatim: true,
  };
}

export function probeExecOptions(args: {
  platform: NodeJS.Platform;
  verbatim: boolean;
}): ExecFileOptions {
  return {
    timeout: 5_000,
    ...(args.platform === "win32" ? { windowsHide: true } : {}),
    ...(args.verbatim ? { windowsVerbatimArguments: true } : {}),
  };
}

export async function commandWorks(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const plan = await resolveProbeSpawnPlan(command, args, platform, env);
    await execFileAsync(
      plan.command,
      plan.args,
      probeExecOptions({ platform, verbatim: plan.verbatim }),
    );
    return true;
  } catch {
    return false;
  }
}

export function bbBinaryCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const fileNames = platform === "win32" ? ["bb.cmd", "bb"] : ["bb"];
  const candidates: string[] = [];
  const pushIfAbsolute = (candidate: string): void => {
    if (pathImpl.isAbsolute(candidate)) {
      candidates.push(candidate);
    }
  };
  const fromCli = env.BB_CLI?.trim();
  if (fromCli !== undefined && fromCli.length > 0) {
    pushIfAbsolute(fromCli);
  }
  const fromCliDir = env.BB_CLI_DIR?.trim();
  if (fromCliDir !== undefined && fromCliDir.length > 0) {
    for (const fileName of fileNames) {
      pushIfAbsolute(pathImpl.join(fromCliDir, fileName));
    }
  }
  const pathEntries =
    platform === "win32"
      ? splitWindowsPathList(readWindowsEnvValue(env, "Path"))
      : (env.PATH ?? "").split(":");
  for (const entry of pathEntries) {
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      for (const fileName of fileNames) {
        pushIfAbsolute(pathImpl.join(trimmed, fileName));
      }
    }
  }
  if (platform !== "win32") {
    candidates.push("/opt/homebrew/bin/bb", "/usr/local/bin/bb");
  }
  return candidates;
}

export async function isExecutableFile(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) return false;
    if (platform === "win32") {
      if (pathImpl.extname(candidate).length === 0) return false;
      return (
        (await resolveExecutable({
          command: candidate,
          env,
          platform,
        })) !== null
      );
    }
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBbBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (resolvedBbPath !== null) return resolvedBbPath;
  for (const candidate of bbBinaryCandidates(env, platform)) {
    if (!(await isExecutableFile(candidate, platform, env))) continue;
    if (await commandWorks(candidate, ["--version"], platform, env)) {
      resolvedBbPath = candidate;
      return candidate;
    }
  }
  return null;
}

export function scriptPathEnv(
  bbPath: string | null,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const basePath = inheritedPath ?? "";
  if (bbPath === null || !pathImpl.isAbsolute(bbPath)) {
    return basePath;
  }
  const bbDir = pathImpl.dirname(bbPath);
  return basePath.length > 0 ? `${bbDir}${pathDelimiter}${basePath}` : bbDir;
}

export function isWakeAgentSuppressed(output: string): boolean {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(last);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "wakeAgent" in parsed &&
      (parsed as { wakeAgent: unknown }).wakeAgent === false
    );
  } catch {
    return false;
  }
}

export interface ScriptRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

interface ScriptRunOutcome {
  status: "succeeded" | "failed" | "skipped";
  output: string | null;
  exitCode: number | null;
  error: string | null;
  skipReason: string | null;
}

export function mapScriptResultToRun(
  result: ScriptRunResult,
): ScriptRunOutcome {
  if (result.timedOut) {
    return {
      status: "failed",
      output: result.output.length > 0 ? result.output : null,
      exitCode: null,
      error: "Script timed out",
      skipReason: null,
    };
  }
  if (result.exitCode !== 0) {
    return {
      status: "failed",
      output: result.output.length > 0 ? result.output : null,
      exitCode: result.exitCode,
      error: `Script exited with code ${result.exitCode}`,
      skipReason: null,
    };
  }
  if (result.output.trim().length === 0) {
    return {
      status: "skipped",
      output: null,
      exitCode: 0,
      error: null,
      skipReason: "empty output",
    };
  }
  if (isWakeAgentSuppressed(result.output)) {
    return {
      status: "skipped",
      output: null,
      exitCode: 0,
      error: null,
      skipReason: "wakeAgent false",
    };
  }
  return {
    status: "succeeded",
    output: result.output,
    exitCode: 0,
    error: null,
    skipReason: null,
  };
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch {}
  }
}

export function scriptSpawnOptions(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): SpawnOptions {
  return {
    cwd: args.cwd,
    detached: process.platform !== "win32",
    env: args.env,
    stdio: ["ignore", "pipe", "pipe"],
    ...(args.platform === "win32" ? { windowsHide: true } : {}),
  };
}

function executeWithProcessGroup(args: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<ScriptRunResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let outputLimitExceeded = false;
    let outputBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let forceKill: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout;
    let treeTermination: Promise<unknown> | null = null;
    const child = spawn(
      args.command,
      args.args,
      scriptSpawnOptions({
        cwd: args.cwd,
        env: args.env,
        platform: args.platform,
      }),
    );

    const terminateGroup = (): void => {
      if (args.platform === "win32") {
        treeTermination = terminateProcessTree({
          child,
          graceMs: 1_000,
          platform: "win32",
        });
        return;
      }
      signalProcessGroup(child, "SIGTERM");
      if (forceKill) return;
      forceKill = setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
      }, 1_000);
      forceKill.unref();
    };
    const capture = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = SCRIPT_OUTPUT_MAX_BYTES - outputBytes;
      if (remaining > 0) {
        const captured = buffer.subarray(0, remaining);
        target.push(captured);
        outputBytes += captured.byteLength;
      }
      if (buffer.byteLength > remaining && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminateGroup();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderrChunks, chunk));
    child.once("error", (error) => {
      capture(stderrChunks, `${error.message}\n`);
      terminateGroup();
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (args.platform !== "win32" && (timedOut || outputLimitExceeded)) {
        signalProcessGroup(child, "SIGKILL");
      }
      const suffix = outputLimitExceeded ? "\n[output truncated]\n" : "";
      const result: ScriptRunResult = {
        exitCode: timedOut ? null : outputLimitExceeded ? 1 : code,
        output: `${Buffer.concat(stdoutChunks).toString("utf8")}${Buffer.concat(
          stderrChunks,
        ).toString("utf8")}${suffix}`,
        timedOut,
      };
      const termination = treeTermination;
      if (termination === null) {
        resolve(result);
        return;
      }
      void termination.then(
        () => resolve(result),
        () => resolve(result),
      );
    });
    timeout = setTimeout(() => {
      timedOut = true;
      terminateGroup();
    }, args.timeoutMs);
    timeout.unref();
  });
}

export async function executeStoredScript(args: {
  pluginDataDir: string;
  automationId: string;
  runId: string;
  projectId: string;
  scriptFile: string;
  interpreter?: AutomationScriptInterpreter;
  timeoutMs: number;
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
  serverUrl: string;
}): Promise<ScriptRunResult> {
  const scriptPath = await resolveAutomationScriptPath({
    dataDir: args.pluginDataDir,
    automationId: args.automationId,
    scriptFile: args.scriptFile,
  });
  const platform = args.platform ?? process.platform;
  const interpreter =
    args.interpreter ?? resolveDefaultInterpreter(args.scriptFile);
  const { command, argsPrefix } = await resolveInterpreterCommand(
    interpreter,
    platform,
    process.env,
  );
  const bbPath = await resolveBbBinary(process.env, platform);
  const warning = bbPath === null ? `${BB_NOT_INJECTED_WARNING}\n` : "";
  const scriptEnv = assignPathEnv({
    env: {
      ...process.env,
      ...(args.env ?? {}),
      BB_SERVER_URL: args.serverUrl,
      BB_PROJECT_ID: args.projectId,
      BB_AUTOMATION_ID: args.automationId,
      BB_AUTOMATION_RUN_ID: args.runId,
    },
    path: scriptPathEnv(bbPath, process.env.PATH, platform),
    platform,
  });
  if (bbPath !== null) {
    scriptEnv.BB_CLI = bbPath;
  }
  const cwd = scriptsRoot(args.pluginDataDir);
  await mkdir(cwd, { recursive: true });
  const result = await executeWithProcessGroup({
    command,
    args: [...argsPrefix, scriptPath],
    cwd,
    timeoutMs: Math.min(args.timeoutMs, AUTOMATION_SCRIPT_TIMEOUT_MAX_MS),
    env: scriptEnv,
    platform,
  });
  return { ...result, output: `${warning}${result.output}` };
}
