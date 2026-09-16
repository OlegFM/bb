interface PlatformArgs {
  platform: NodeJS.Platform;
}

interface QuitOnWindowAllClosedArgs {
  hasTray: boolean;
  platform: NodeJS.Platform;
}

interface StartQuitSequenceArgs {
  stoppingForQuit: boolean;
}

export function shouldQuitOnWindowAllClosed(
  args: QuitOnWindowAllClosedArgs,
): boolean {
  if (args.platform === "darwin") {
    return false;
  }
  if (args.platform === "win32") {
    return !args.hasTray;
  }
  return true;
}

export function shouldHandleSessionEnd(args: PlatformArgs): boolean {
  return args.platform === "win32";
}

export function shouldStartQuitSequence(args: StartQuitSequenceArgs): boolean {
  return !args.stoppingForQuit;
}
