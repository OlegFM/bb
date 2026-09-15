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
