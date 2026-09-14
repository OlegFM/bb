import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import {
  dirname,
  extname,
  posix as posixPath,
  resolve,
  win32 as win32Path,
} from "node:path";
import {
  joinExecutablePath,
  readWindowsEnvValue,
  splitWindowsPathList,
} from "./windows-system-tools.js";

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD;.PS1";
const POSIX_PATH_DELIMITER = ":";

const NON_SCRIPT_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([
  ".bat",
  ".cmd",
  ".com",
  ".exe",
]);

const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".bat", ".cmd"]);

const NODE_CMD_SHIM_PATTERNS: readonly RegExp[] = [
  /^\s*@?node(?:\.exe)?\s+"%~dp0\\?([^"\r\n]+)"/imu,
  /"%~dp0\\?node\.exe"\s+"%~dp0\\?([^"\r\n]+)"/iu,
  /"%_prog%"\s+"%dp0%\\?([^"\r\n]+)"/iu,
  /"%dp0%\\?node\.exe"\s+"%dp0%\\?([^"\r\n]+)"/iu,
];

export interface ResolveExecutableArgs {
  command: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
}

export interface NodeCmdShimTarget {
  command: string;
  args: string[];
}

export function windowsExecutableExtensions(pathext?: string): string[] {
  const raw =
    pathext === undefined || pathext.trim() === ""
      ? DEFAULT_WINDOWS_PATHEXT
      : pathext;
  const extensions: string[] = [];
  for (const entry of raw.split(";")) {
    const trimmed = entry.trim().toLowerCase();
    if (trimmed === "") {
      continue;
    }
    const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    if (!extensions.includes(withDot)) {
      extensions.push(withDot);
    }
  }
  return extensions;
}

async function isPosixExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolvePosixExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | null> {
  if (posixPath.isAbsolute(command) || command.includes("/")) {
    const target = posixPath.isAbsolute(command)
      ? command
      : joinExecutablePath("linux", cwd, command);
    return (await isPosixExecutableFile(target)) ? target : null;
  }
  for (const entry of (env.PATH ?? "").split(POSIX_PATH_DELIMITER)) {
    if (entry === "") {
      continue;
    }
    const candidate = joinExecutablePath("linux", entry, command);
    if (await isPosixExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function findWindowsCandidate(
  base: string,
  extensions: string[],
): Promise<string | null> {
  const extension = win32Path.extname(base).toLowerCase();
  if (extensions.includes(extension) && (await fileExists(base))) {
    return base;
  }
  for (const suffix of extensions) {
    const candidate = `${base}${suffix}`;
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolveWindowsExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | null> {
  const extensions = windowsExecutableExtensions(
    readWindowsEnvValue(env, "PATHEXT"),
  );
  if (win32Path.isAbsolute(command) || /[\\/]/u.test(command)) {
    const base = win32Path.isAbsolute(command)
      ? command
      : joinExecutablePath("win32", cwd, command);
    return findWindowsCandidate(base, extensions);
  }
  for (const entry of splitWindowsPathList(readWindowsEnvValue(env, "Path"))) {
    const found = await findWindowsCandidate(
      joinExecutablePath("win32", entry, command),
      extensions,
    );
    if (found !== null) {
      return found;
    }
  }
  return null;
}

export async function resolveExecutable(
  args: ResolveExecutableArgs,
): Promise<string | null> {
  const platform = args.platform ?? process.platform;
  const env = args.env ?? process.env;
  const cwd = args.cwd ?? process.cwd();
  return platform === "win32"
    ? resolveWindowsExecutable(args.command, env, cwd)
    : resolvePosixExecutable(args.command, env, cwd);
}

function shimTargetsNode(body: string): boolean {
  return /node\.exe/iu.test(body) || /(?:^|[\s&|(])@?node\s/imu.test(body);
}

export async function readNodeCmdShim(
  shimPath: string,
): Promise<NodeCmdShimTarget | null> {
  let body: string;
  try {
    body = await readFile(shimPath, "utf8");
  } catch {
    return null;
  }
  if (!shimTargetsNode(body)) {
    return null;
  }
  for (const pattern of NODE_CMD_SHIM_PATTERNS) {
    const captured = pattern.exec(body)?.[1];
    if (captured === undefined) {
      continue;
    }
    const segments = captured
      .split(/[\\/]+/u)
      .filter((segment) => segment !== "");
    if (segments.length === 0) {
      continue;
    }
    const script = resolve(dirname(shimPath), ...segments);
    if (NON_SCRIPT_SHIM_EXTENSIONS.has(extname(script).toLowerCase())) {
      continue;
    }
    return { command: process.execPath, args: [script] };
  }
  return null;
}

export function nodeShimRefusalMessage(launcherPath: string): string {
  return `Windows launcher ${launcherPath} is not a Node shim bb can start directly`;
}

export async function resolveNodeShimSpawnPlan(
  launcherPath: string,
): Promise<NodeCmdShimTarget | null> {
  if (!WINDOWS_SHIM_EXTENSIONS.has(extname(launcherPath).toLowerCase())) {
    return { command: launcherPath, args: [] };
  }
  return readNodeCmdShim(launcherPath);
}
