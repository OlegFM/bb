export const WINDOWS_CONTROL_C_EXIT_CODE = -1073741510;

interface NormalizeTerminalExitCodeArgs {
  closeRequested: boolean;
  exitCode: number;
  platform: NodeJS.Platform;
}

export function normalizeTerminalExitCode(
  args: NormalizeTerminalExitCodeArgs,
): number | null {
  if (
    args.platform === "win32" &&
    args.closeRequested &&
    args.exitCode === WINDOWS_CONTROL_C_EXIT_CODE
  ) {
    return null;
  }
  return args.exitCode;
}
