interface PlatformArgs {
  platform: NodeJS.Platform;
}

export function shouldQuitOnWindowAllClosed(args: PlatformArgs): boolean {
  return args.platform !== "darwin" && args.platform !== "win32";
}

export function shouldHandleSessionEnd(args: PlatformArgs): boolean {
  return args.platform === "win32";
}
