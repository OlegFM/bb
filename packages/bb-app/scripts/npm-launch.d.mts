export interface ResolveNpmLaunchArgs {
  args: string[];
  command: "npm" | "npx";
  execPath: string;
  existsSync?: (path: string) => boolean;
  platform: NodeJS.Platform;
}

export interface ResolvedNpmLaunch {
  args: string[];
  command: string;
}

export function resolveNpmLaunch(args: ResolveNpmLaunchArgs): ResolvedNpmLaunch;

export interface ResolveLaunchOptions {
  execPath?: string;
  existsSync?: (path: string) => boolean;
  platform?: NodeJS.Platform;
}

export function resolveLaunchForLabel(
  label: string,
  command: string,
  args: string[],
  options?: ResolveLaunchOptions,
): ResolvedNpmLaunch;

export function resolveInstalledBinEntry(
  binDir: string,
  packageName: string,
  bin: string,
): string;
