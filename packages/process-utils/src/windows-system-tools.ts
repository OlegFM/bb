import { existsSync } from "node:fs";
import { win32 as win32Path } from "node:path";

const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const WINDOWS_PATH_DELIMITER = ";";

export const POWERSHELL_NONINTERACTIVE_ARGS: readonly string[] = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
];

export function readWindowsEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const direct = env[name];
  if (direct !== undefined) {
    return direct;
  }
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowered && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function splitWindowsPathList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const entries: string[] = [];
  for (const raw of value.split(WINDOWS_PATH_DELIMITER)) {
    const trimmed = raw.trim().replace(/^"+|"+$/gu, "");
    if (trimmed !== "") {
      entries.push(trimmed);
    }
  }
  return entries;
}

function appendExecutableSegment(
  base: string,
  segment: string,
  platform: NodeJS.Platform,
): string {
  if (base === "") {
    return segment;
  }
  if (base.endsWith("/") || base.endsWith("\\")) {
    return `${base}${segment}`;
  }
  if (platform !== "win32") {
    return `${base}/${segment}`;
  }
  return base.includes("\\") || !base.includes("/")
    ? `${base}\\${segment}`
    : `${base}/${segment}`;
}

export function joinExecutablePath(
  platform: NodeJS.Platform,
  base: string,
  ...segments: string[]
): string {
  let joined = base;
  for (const segment of segments) {
    joined = appendExecutableSegment(joined, segment, platform);
  }
  return joined;
}

export function resolveWindowsSystemToolPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return win32Path.join(
    readWindowsEnvValue(env, "SystemRoot") ?? DEFAULT_WINDOWS_SYSTEM_ROOT,
    "System32",
    name,
  );
}

export function resolvePowerShellExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const entry of splitWindowsPathList(readWindowsEnvValue(env, "Path"))) {
    const candidate = joinExecutablePath("win32", entry, "pwsh.exe");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const programFiles = readWindowsEnvValue(env, "ProgramFiles");
  if (programFiles !== undefined) {
    const candidate = joinExecutablePath(
      "win32",
      programFiles,
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return win32Path.join(
    readWindowsEnvValue(env, "SystemRoot") ?? DEFAULT_WINDOWS_SYSTEM_ROOT,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}
