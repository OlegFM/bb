import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import {
  POWERSHELL_NONINTERACTIVE_ARGS,
  resolvePowerShellExecutable,
  sanitizeInheritedChildProcessEnv,
} from "@bb/process-utils";
import { ExpectedCommandDispatchError } from "../command-dispatch-support.js";

const execFileAsync = promisify(execFile);

export interface NativeFolderPickerExecFileOptions {
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
}

export type NativeFolderPickerExecFile = (
  file: string,
  args: string[],
  options?: NativeFolderPickerExecFileOptions,
) => Promise<{ stdout: string }>;

export interface NativeFolderPickerDeps {
  env?: NodeJS.ProcessEnv;
  execFile?: NativeFolderPickerExecFile;
  platform?: NodeJS.Platform;
}

type PickFolderResult = HostDaemonOnlineRpcResult<"host.pick_folder">;

const WINDOWS_FOLDER_PICKER_TITLE = "Choose a project folder";
const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:[\\/]$/u;
const WINDOWS_FOLDER_PICKER_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  `$dialog.Description = '${WINDOWS_FOLDER_PICKER_TITLE}'`,
  "$dialog.ShowNewFolderButton = $true",
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }",
].join("; ");

async function defaultExecFile(
  file: string,
  args: string[],
  options?: NativeFolderPickerExecFileOptions,
): Promise<{ stdout: string }> {
  const result = await execFileAsync(file, args, {
    env: options?.env,
    windowsHide: options?.windowsHide,
  });
  return { stdout: result.stdout };
}

function buildExecOptions(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NativeFolderPickerExecFileOptions {
  return {
    env,
    ...(platform === "win32" ? { windowsHide: true } : {}),
  };
}

function toPickFolderResult(selectedPath: string): PickFolderResult {
  const trimmedPath = selectedPath.trim();
  if (trimmedPath === "") {
    return { path: null };
  }
  if (WINDOWS_DRIVE_ROOT_PATTERN.test(trimmedPath)) {
    return { path: trimmedPath };
  }
  return { path: trimmedPath.replace(/[/\\]$/u, "") };
}

function toFolderPickerFailure(error: unknown): ExpectedCommandDispatchError {
  return new ExpectedCommandDispatchError(
    "folder_picker_failed",
    `Folder picker failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function pickMacOsFolder(
  execFileImpl: NativeFolderPickerExecFile,
): Promise<PickFolderResult> {
  let stdout: string;
  try {
    const result = await execFileImpl(
      "osascript",
      [
        "-e",
        'try\nPOSIX path of (choose folder with prompt "Choose a project folder")\non error number -128\nreturn ""\nend try',
      ],
      buildExecOptions(
        sanitizeInheritedChildProcessEnv({ env: process.env }),
        "darwin",
      ),
    );
    stdout = result.stdout;
  } catch (error) {
    throw toFolderPickerFailure(error);
  }
  return toPickFolderResult(stdout);
}

async function pickWindowsFolder(
  execFileImpl: NativeFolderPickerExecFile,
  env: NodeJS.ProcessEnv,
): Promise<PickFolderResult> {
  let stdout: string;
  try {
    const result = await execFileImpl(
      resolvePowerShellExecutable(env),
      [
        ...POWERSHELL_NONINTERACTIVE_ARGS,
        "-STA",
        "-Command",
        WINDOWS_FOLDER_PICKER_SCRIPT,
      ],
      buildExecOptions(
        sanitizeInheritedChildProcessEnv({ env, platform: "win32" }),
        "win32",
      ),
    );
    stdout = result.stdout;
  } catch (error) {
    throw toFolderPickerFailure(error);
  }
  return toPickFolderResult(stdout);
}

export async function pickHostFolderWithDeps(
  deps: NativeFolderPickerDeps = {},
): Promise<PickFolderResult> {
  const platform = deps.platform ?? process.platform;
  const execFileImpl = deps.execFile ?? defaultExecFile;
  if (platform === "darwin") {
    return pickMacOsFolder(execFileImpl);
  }
  if (platform === "win32") {
    return pickWindowsFolder(execFileImpl, deps.env ?? process.env);
  }
  throw new ExpectedCommandDispatchError(
    "unsupported_platform",
    "Folder picker is only supported on macOS",
  );
}

export async function pickHostFolder(): Promise<PickFolderResult> {
  return pickHostFolderWithDeps();
}
