import { existsSync } from "node:fs";

export const DESKTOP_QUIT_REQUEST_FILE_ENV_NAME =
  "BB_DESKTOP_QUIT_REQUEST_FILE";

interface ResolveDesktopQuitRequestFileArgs {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

interface WatchDesktopQuitRequestFileArgs {
  fileExists?: (filePath: string) => boolean;
  filePath: string;
  onRequest(): void;
  pollMs: number;
}

export interface DesktopQuitRequestWatcher {
  stop(): void;
}

export function resolveDesktopQuitRequestFile(
  args: ResolveDesktopQuitRequestFileArgs,
): string | null {
  if (args.platform !== "win32") {
    return null;
  }
  const raw = args.env[DESKTOP_QUIT_REQUEST_FILE_ENV_NAME]?.trim();
  return raw === undefined || raw.length === 0 ? null : raw;
}

export function watchDesktopQuitRequestFile(
  args: WatchDesktopQuitRequestFileArgs,
): DesktopQuitRequestWatcher {
  const fileExists = args.fileExists ?? existsSync;
  const timer = setInterval(() => {
    if (!fileExists(args.filePath)) {
      return;
    }
    clearInterval(timer);
    args.onRequest();
  }, args.pollMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
