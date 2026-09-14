import {
  WINDOWS_ENV_SETUP_SCRIPT_NAME,
  WINDOWS_ENV_TEARDOWN_SCRIPT_NAME,
} from "@bb/domain";
import {
  isProcessGroupAlive,
  killProcessGroup,
  POWERSHELL_NONINTERACTIVE_ARGS,
  resolvePowerShellExecutable,
  sanitizeInheritedChildProcessEnv,
  spawnPortableOutputProcess,
  supportsProcessGroups,
  terminateProcessTree,
  type TerminateProcessTreeResult,
} from "@bb/process-utils";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { WorkspaceError } from "bb-environment-provider-host/git";
import { createTerminalOutputLineReader } from "bb-environment-provider-host/terminal-output";
import {
  createProvisionCancelledError,
  emitOutput,
  emitStep,
  throwIfProvisionAborted,
  type ProgressCallback,
} from "bb-environment-provider-host/transcript";

export const DEFAULT_ENV_SETUP_SCRIPT_NAME = ".bb-env-setup.sh";
export const DEFAULT_ENV_TEARDOWN_SCRIPT_NAME = ".bb-env-teardown.sh";

export interface RunSetupScriptArgs {
  workspacePath: string;
  timeoutMs: number;
  platform?: NodeJS.Platform;
  shellPath?: string;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

type RunTeardownScriptArgs = RunSetupScriptArgs;

interface LifecycleScriptCommand {
  command: string;
  args: string[];
  text: string;
}

interface BuildLifecycleScriptCommandArgs {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  scriptPath: string;
}

interface RunLifecycleScriptArgs extends RunSetupScriptArgs {
  kind: "setup" | "teardown";
}

const WINDOWS_LIFECYCLE_TERMINATE_GRACE_MS = 2_000;

function lifecycleScriptNames(kind: "setup" | "teardown"): {
  posix: string;
  windows: string;
} {
  return kind === "setup"
    ? {
        posix: DEFAULT_ENV_SETUP_SCRIPT_NAME,
        windows: WINDOWS_ENV_SETUP_SCRIPT_NAME,
      }
    : {
        posix: DEFAULT_ENV_TEARDOWN_SCRIPT_NAME,
        windows: WINDOWS_ENV_TEARDOWN_SCRIPT_NAME,
      };
}

function windowsPosixScriptMessage(kind: "setup" | "teardown"): string {
  const names = lifecycleScriptNames(kind);
  return `${names.posix} is a POSIX shell script; on Windows bb runs ${names.windows} instead (pwsh.exe or powershell.exe)`;
}

function buildPowerShellScriptCommand(
  args: BuildLifecycleScriptCommandArgs,
): LifecycleScriptCommand {
  const executablePath = resolvePowerShellExecutable(args.env);
  const executableName = path.win32
    .basename(executablePath)
    .replace(/\.exe$/iu, "");
  return {
    command: executablePath,
    args: [...POWERSHELL_NONINTERACTIVE_ARGS, "-File", args.scriptPath],
    text: `${executableName} -File ${path.win32.basename(args.scriptPath)}`,
  };
}

export function buildSetupScriptCommand(
  args: BuildLifecycleScriptCommandArgs,
): LifecycleScriptCommand {
  if (args.platform === "win32") {
    if (!args.scriptPath.toLowerCase().endsWith(".ps1")) {
      throw new WorkspaceError(
        "setup_script_failed",
        windowsPosixScriptMessage("setup"),
      );
    }
    return buildPowerShellScriptCommand(args);
  }

  return {
    command: "env",
    args: ["bash", args.scriptPath],
    text: `env bash ${DEFAULT_ENV_SETUP_SCRIPT_NAME}`,
  };
}

export function buildTeardownScriptCommand(
  args: BuildLifecycleScriptCommandArgs,
): LifecycleScriptCommand {
  if (args.platform === "win32") {
    if (!args.scriptPath.toLowerCase().endsWith(".ps1")) {
      throw new WorkspaceError(
        "setup_script_failed",
        windowsPosixScriptMessage("teardown"),
      );
    }
    return buildPowerShellScriptCommand(args);
  }

  return {
    command: "env",
    args: ["bash", args.scriptPath],
    text: `env bash ${DEFAULT_ENV_TEARDOWN_SCRIPT_NAME}`,
  };
}

async function resolveLifecycleScriptPath(
  workspacePath: string,
  scriptName: string,
): Promise<string | null> {
  const scriptPath = path.join(workspacePath, scriptName);
  try {
    await fs.access(scriptPath);
  } catch {
    return null;
  }
  return scriptPath;
}

export interface ResolvedLifecycleScript {
  scriptPath: string;
  scriptName: string;
  posixOnly: boolean;
}

export async function resolveLifecycleScript(args: {
  kind: "setup" | "teardown";
  platform?: NodeJS.Platform;
  workspacePath: string;
}): Promise<ResolvedLifecycleScript | null> {
  const names = lifecycleScriptNames(args.kind);
  if ((args.platform ?? process.platform) === "win32") {
    const windowsPath = await resolveLifecycleScriptPath(
      args.workspacePath,
      names.windows,
    );
    if (windowsPath !== null) {
      return {
        scriptPath: windowsPath,
        scriptName: names.windows,
        posixOnly: false,
      };
    }
    const posixPath = await resolveLifecycleScriptPath(
      args.workspacePath,
      names.posix,
    );
    return posixPath === null
      ? null
      : { scriptPath: posixPath, scriptName: names.posix, posixOnly: true };
  }

  const scriptPath = await resolveLifecycleScriptPath(
    args.workspacePath,
    names.posix,
  );
  return scriptPath === null
    ? null
    : { scriptPath, scriptName: names.posix, posixOnly: false };
}

async function runLifecycleScript(
  args: RunLifecycleScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  throwIfProvisionAborted(args.signal);
  const platform = args.platform ?? process.platform;
  const resolved = await resolveLifecycleScript({
    kind: args.kind,
    platform,
    workspacePath: args.workspacePath,
  });
  if (resolved === null) {
    return { ran: false };
  }
  const { scriptName, scriptPath } = resolved;

  throwIfProvisionAborted(args.signal);
  const startedAt = Date.now();
  if (resolved.posixOnly) {
    emitStep({
      onProgress: args.onProgress,
      key: `${args.kind}-failed`,
      text: `${scriptName} failed`,
      status: "failed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
    throw new WorkspaceError(
      "setup_script_failed",
      windowsPosixScriptMessage(args.kind),
    );
  }

  const env = sanitizeInheritedChildProcessEnv({
    env: process.env,
    platform,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
  });
  const command =
    args.kind === "setup"
      ? buildSetupScriptCommand({ env, platform, scriptPath })
      : buildTeardownScriptCommand({ env, platform, scriptPath });
  emitStep({
    onProgress: args.onProgress,
    key: `${args.kind}-started`,
    text: `Running ${scriptName}`,
    status: "started",
    startedAt,
  });

  const { timeoutMs } = args;
  const child = spawnPortableOutputProcess({
    command: command.command,
    args: command.args,
    cwd: args.workspacePath,
    detached: supportsProcessGroups(platform),
    env,
    platform,
  });

  const outputChunks: string[] = [];
  const outputLineReader = createTerminalOutputLineReader();
  let outputIndex = 0;
  let abortRequested = false;
  let timedOut = false;

  const emitScriptOutputLines = (lines: string[]): void => {
    for (const line of lines) {
      outputIndex += 1;
      emitOutput(args.onProgress, `${args.kind}-output-${outputIndex}`, line);
    }
  };

  const handleChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    outputChunks.push(text);
    emitScriptOutputLines(outputLineReader.push(text));
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);

  let terminationPromise: Promise<TerminateProcessTreeResult> | null = null;

  const reportIncompleteTermination = (
    result: TerminateProcessTreeResult,
  ): void => {
    const reasons: string[] = [];
    if (result.enumerationError !== null) {
      reasons.push(
        `could not enumerate processes (${result.enumerationError.reason}): ${result.enumerationError.message}`,
      );
    }
    if (result.descendantsSkipped.length > 0) {
      reasons.push(
        `left pid${result.descendantsSkipped.length === 1 ? "" : "s"} ${result.descendantsSkipped
          .map((event) => String(event.pid))
          .join(", ")} alone because their process ids were reused`,
      );
    }
    if (reasons.length === 0) {
      return;
    }
    emitOutput(
      args.onProgress,
      `${args.kind}-cleanup-incomplete`,
      `Cleanup may have left ${scriptName} processes running: ${reasons.join("; ")}`,
    );
  };

  const terminateLifecycleScript = (): void => {
    if (platform !== "win32") {
      killProcessGroup({ child, signal: "SIGKILL" });
      return;
    }
    if (terminationPromise !== null) {
      return;
    }
    terminationPromise = terminateProcessTree({
      child,
      graceMs: WINDOWS_LIFECYCLE_TERMINATE_GRACE_MS,
      platform,
      onSkippedProcess: (event) => {
        emitOutput(
          args.onProgress,
          `${args.kind}-pid-reused-${String(event.pid)}`,
          `Left pid ${String(event.pid)} alone during cleanup: its process id was reused (recorded ${event.expectedCreationDate ?? "unknown"}, found ${event.observedCreationDate ?? "unknown"})`,
        );
      },
    });
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    terminateLifecycleScript();
  }, timeoutMs);
  const abortLifecycleScript = () => {
    if (abortRequested) {
      return;
    }
    abortRequested = true;
    terminateLifecycleScript();
  };
  args.signal?.addEventListener("abort", abortLifecycleScript, {
    once: true,
  });
  if (args.signal?.aborted) {
    abortLifecycleScript();
  }

  try {
    const result = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });

    if (abortRequested || timedOut) {
      if (terminationPromise !== null) {
        reportIncompleteTermination(await terminationPromise);
      }
      while (isProcessGroupAlive(child, platform)) await delay(25);
    }

    const output = outputChunks.join("");
    emitScriptOutputLines(outputLineReader.flush());
    const durationMs = Date.now() - startedAt;
    if (abortRequested || args.signal?.aborted) {
      emitStep({
        onProgress: args.onProgress,
        key: `${args.kind}-cancelled`,
        text: `${scriptName} cancelled`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw createProvisionCancelledError(args.signal?.reason);
    }

    if (timedOut) {
      emitStep({
        onProgress: args.onProgress,
        key: `${args.kind}-failed`,
        text: `${scriptName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw new WorkspaceError(
        "setup_script_failed",
        `${args.kind === "setup" ? "Setup" : "Teardown"} script timed out after ${timeoutMs}ms: ${scriptPath}`,
      );
    }

    if (result.signal) {
      emitStep({
        onProgress: args.onProgress,
        key: `${args.kind}-failed`,
        text: `${scriptName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw new WorkspaceError(
        "setup_script_failed",
        `${args.kind === "setup" ? "Setup" : "Teardown"} script exited via signal ${result.signal}: ${scriptPath}`,
      );
    }

    if ((result.exitCode ?? 0) !== 0) {
      emitStep({
        onProgress: args.onProgress,
        key: `${args.kind}-failed`,
        text: `${scriptName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw new WorkspaceError(
        "setup_script_failed",
        `${args.kind === "setup" ? "Setup" : "Teardown"} script failed with exit code ${result.exitCode}: ${scriptPath}`,
      );
    }

    emitStep({
      onProgress: args.onProgress,
      key: `${args.kind}-completed`,
      text: `${scriptName} finished`,
      status: "completed",
      startedAt,
      metadata: { durationMs },
    });
    return { ran: true, exitCode: result.exitCode ?? 0, output };
  } finally {
    clearTimeout(timeout);
    args.signal?.removeEventListener("abort", abortLifecycleScript);
  }
}

export function runSetupScript(
  args: RunSetupScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  return runLifecycleScript({ ...args, kind: "setup" });
}

export async function runTeardownScript(
  args: RunTeardownScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  const startedAt = Date.now();
  const teardownScriptName =
    (args.platform ?? process.platform) === "win32"
      ? WINDOWS_ENV_TEARDOWN_SCRIPT_NAME
      : DEFAULT_ENV_TEARDOWN_SCRIPT_NAME;
  let failureReported = false;
  const onProgress: ProgressCallback = (entry) => {
    if (entry.type === "step" && entry.key === "teardown-failed") {
      failureReported = true;
    }
    args.onProgress?.(entry);
  };
  try {
    return await runLifecycleScript({ ...args, onProgress, kind: "teardown" });
  } catch (error) {
    if (args.signal?.aborted) throw error;
    if (!failureReported) {
      emitStep({
        onProgress: args.onProgress,
        key: "teardown-failed",
        text: `${teardownScriptName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs: Date.now() - startedAt },
      });
    }
    emitOutput(
      args.onProgress,
      "teardown-error",
      error instanceof Error ? error.message : String(error),
    );
    return { ran: true };
  }
}
