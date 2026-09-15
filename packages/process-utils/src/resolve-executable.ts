import { accessSync, constants } from "node:fs";
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

const DIRECTLY_EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".com",
]);

const NODE_CMD_SHIM_PATTERNS: readonly RegExp[] = [
  /^\s*@?node(?:\.exe)?\s+"%~dp0\\?([^"\r\n]+)"/imu,
  /"%~dp0\\?node\.exe"\s+"%~dp0\\?([^"\r\n]+)"/iu,
  /"%_prog%"\s+"%dp0%\\?([^"\r\n]+)"/iu,
  /"%dp0%\\?node\.exe"\s+"%dp0%\\?([^"\r\n]+)"/iu,
  /^\s*SET\s+"NP[MX]_CLI_JS=%~dp0\\?([^"\r\n]+)"/imu,
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

function isPosixExecutableFileSync(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
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

function fileExistsSync(candidate: string): boolean {
  try {
    accessSync(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function posixCandidatePaths(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string[] {
  if (posixPath.isAbsolute(command) || command.includes("/")) {
    return [
      posixPath.isAbsolute(command)
        ? command
        : joinExecutablePath("linux", cwd, command),
    ];
  }
  const candidates: string[] = [];
  for (const entry of (env.PATH ?? "").split(POSIX_PATH_DELIMITER)) {
    if (entry === "") {
      continue;
    }
    candidates.push(joinExecutablePath("linux", entry, command));
  }
  return candidates;
}

async function resolvePosixExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | null> {
  for (const candidate of posixCandidatePaths(command, env, cwd)) {
    if (await isPosixExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolvePosixExecutableSync(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | null {
  for (const candidate of posixCandidatePaths(command, env, cwd)) {
    if (isPosixExecutableFileSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function windowsCandidatePaths(base: string, extensions: string[]): string[] {
  const candidates: string[] = [];
  const extension = win32Path.extname(base).toLowerCase();
  if (extensions.includes(extension)) {
    candidates.push(base);
  }
  for (const suffix of extensions) {
    candidates.push(`${base}${suffix}`);
  }
  return candidates;
}

async function findWindowsCandidate(
  base: string,
  extensions: string[],
): Promise<string | null> {
  for (const candidate of windowsCandidatePaths(base, extensions)) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findWindowsCandidateSync(
  base: string,
  extensions: string[],
): string | null {
  for (const candidate of windowsCandidatePaths(base, extensions)) {
    if (fileExistsSync(candidate)) {
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

function resolveWindowsExecutableSync(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | null {
  const extensions = windowsExecutableExtensions(
    readWindowsEnvValue(env, "PATHEXT"),
  );
  if (win32Path.isAbsolute(command) || /[\\/]/u.test(command)) {
    const base = win32Path.isAbsolute(command)
      ? command
      : joinExecutablePath("win32", cwd, command);
    return findWindowsCandidateSync(base, extensions);
  }
  for (const entry of splitWindowsPathList(readWindowsEnvValue(env, "Path"))) {
    const found = findWindowsCandidateSync(
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

export function resolveExecutableSync(
  args: ResolveExecutableArgs,
): string | null {
  const platform = args.platform ?? process.platform;
  const env = args.env ?? process.env;
  const cwd = args.cwd ?? process.cwd();
  return platform === "win32"
    ? resolveWindowsExecutableSync(args.command, env, cwd)
    : resolvePosixExecutableSync(args.command, env, cwd);
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

export interface SpawnPlan {
  command: string;
  args: string[];
}

export interface ResolveSpawnPlanArgs {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
}

export function spawnPlanUnavailableMessage(args: {
  command: string;
  resolvedPath: string | null;
}): string {
  if (args.resolvedPath === null) {
    return `Command ${args.command} was not found on Path`;
  }
  return WINDOWS_SHIM_EXTENSIONS.has(extname(args.resolvedPath).toLowerCase())
    ? nodeShimRefusalMessage(args.resolvedPath)
    : `Windows launcher ${args.resolvedPath} cannot be started directly`;
}

export class SpawnPlanUnavailableError extends Error {
  readonly reason: "not_found" | "not_node_shim" | "not_executable";
  readonly command: string;
  readonly resolvedPath: string | null;

  constructor(args: { command: string; resolvedPath: string | null }) {
    super(spawnPlanUnavailableMessage(args));
    this.name = "SpawnPlanUnavailableError";
    this.reason =
      args.resolvedPath === null
        ? "not_found"
        : WINDOWS_SHIM_EXTENSIONS.has(extname(args.resolvedPath).toLowerCase())
          ? "not_node_shim"
          : "not_executable";
    this.command = args.command;
    this.resolvedPath = args.resolvedPath;
  }
}

interface SpawnPlanDetailed {
  plan: SpawnPlan | null;
  resolvedPath: string | null;
}

async function resolveSpawnPlanDetailed(
  args: ResolveSpawnPlanArgs,
): Promise<SpawnPlanDetailed> {
  const platform = args.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      plan: { command: args.command, args: [...args.args] },
      resolvedPath: null,
    };
  }
  const resolved = await resolveExecutable({
    command: args.command,
    env: args.env,
    platform,
    cwd: args.cwd,
  });
  if (resolved === null) {
    return { plan: null, resolvedPath: null };
  }
  const resolvedExtension = extname(resolved).toLowerCase();
  if (
    !DIRECTLY_EXECUTABLE_EXTENSIONS.has(resolvedExtension) &&
    !WINDOWS_SHIM_EXTENSIONS.has(resolvedExtension)
  ) {
    return { plan: null, resolvedPath: resolved };
  }
  const shimPlan = await resolveNodeShimSpawnPlan(resolved);
  if (shimPlan === null) {
    return { plan: null, resolvedPath: resolved };
  }
  return {
    plan: {
      command: shimPlan.command,
      args: [...shimPlan.args, ...args.args],
    },
    resolvedPath: resolved,
  };
}

export async function resolveSpawnPlan(
  args: ResolveSpawnPlanArgs,
): Promise<SpawnPlan | null> {
  return (await resolveSpawnPlanDetailed(args)).plan;
}

export async function resolveSpawnPlanOrThrow(
  args: ResolveSpawnPlanArgs,
): Promise<SpawnPlan> {
  const detailed = await resolveSpawnPlanDetailed(args);
  if (detailed.plan === null) {
    throw new SpawnPlanUnavailableError({
      command: args.command,
      resolvedPath: detailed.resolvedPath,
    });
  }
  return detailed.plan;
}
