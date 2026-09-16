export const LINUX_FRAMELESS_WINDOW_ARGUMENT = "--no-window-frame";

interface ShouldUseLinuxFramelessWindowArgs {
  argv: readonly string[];
  platform: NodeJS.Platform;
}

export function shouldUseLinuxFramelessWindow(
  args: ShouldUseLinuxFramelessWindowArgs,
): boolean {
  return (
    args.platform === "linux" &&
    args.argv.includes(LINUX_FRAMELESS_WINDOW_ARGUMENT)
  );
}

export const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = 48;

export interface DesktopTitleBarOverlay {
  color: string;
  height: number;
  symbolColor: string;
}

interface ResolveWindowsTitleBarOverlayArgs {
  darkColors: boolean;
}

interface ShouldUseWindowsTitleBarOverlayArgs {
  platform: NodeJS.Platform;
}

export function shouldUseWindowsTitleBarOverlay(
  args: ShouldUseWindowsTitleBarOverlayArgs,
): boolean {
  return args.platform === "win32";
}

export function resolveWindowsTitleBarOverlay(
  args: ResolveWindowsTitleBarOverlayArgs,
): DesktopTitleBarOverlay {
  return args.darkColors
    ? {
        color: "#1f1f1f",
        height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
        symbolColor: "#e8e8e8",
      }
    : {
        color: "#f6f6f6",
        height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
        symbolColor: "#1f1f1f",
      };
}
