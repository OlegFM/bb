interface ShouldCreateTrayIconArgs {
  platform: NodeJS.Platform;
}

export interface DesktopTrayHandle {
  destroy(): void;
  on(event: "click", listener: () => void): void;
  setContextMenu(menu: unknown): void;
  setToolTip(tooltip: string): void;
}

export interface DesktopTrayMenuArgs {
  onQuit(): void;
  onShow(): void;
  quitLabel: string;
  showLabel: string;
}

export interface DesktopTrayDeps {
  buildMenu(args: DesktopTrayMenuArgs): unknown;
  createIcon(imagePath: string): DesktopTrayHandle;
}

interface CreateDesktopTrayArgs {
  applicationName: string;
  deps: DesktopTrayDeps;
  iconPath: string;
  onQuit(): void;
  onShow(): void;
  platform: NodeJS.Platform;
}

export function shouldCreateTrayIcon(args: ShouldCreateTrayIconArgs): boolean {
  return args.platform === "win32";
}

export function createDesktopTray(
  args: CreateDesktopTrayArgs,
): DesktopTrayHandle | null {
  if (!shouldCreateTrayIcon({ platform: args.platform })) {
    return null;
  }
  const tray = args.deps.createIcon(args.iconPath);
  tray.setToolTip(args.applicationName);
  tray.setContextMenu(
    args.deps.buildMenu({
      onQuit: args.onQuit,
      onShow: args.onShow,
      quitLabel: `Quit ${args.applicationName}`,
      showLabel: `Open ${args.applicationName}`,
    }),
  );
  tray.on("click", args.onShow);
  return tray;
}
