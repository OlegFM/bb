export type HostPathFlavor = "posix" | "windows";

const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/u;
const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:[\\/]*$/u;
const WINDOWS_DRIVE_PREFIX_PATTERN = /^([A-Za-z]):/u;
const WINDOWS_CANONICAL_ROOT_PATTERN = /^[A-Z]:\\$/u;
const UNC_OR_DEVICE_PATH_PATTERN = /^[\\/]{2}(?![\\/])/u;
const WINDOWS_SEPARATOR_RUN_PATTERN = /[\\/]+/u;
const POSIX_SEPARATOR_RUN_PATTERN = /\/+/u;

export function isUncOrDeviceHostPath(path: string): boolean {
  return UNC_OR_DEVICE_PATH_PATTERN.test(path);
}

export function detectHostPathFlavor(path: string): HostPathFlavor | null {
  if (isUncOrDeviceHostPath(path)) {
    return null;
  }
  if (path.startsWith("/")) {
    return "posix";
  }
  if (
    WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(path) ||
    WINDOWS_DRIVE_ROOT_PATTERN.test(path)
  ) {
    return "windows";
  }
  return null;
}

export function isAbsoluteHostPath(path: string): boolean {
  return detectHostPathFlavor(path) !== null;
}

export function isWindowsHostPath(path: string): boolean {
  return detectHostPathFlavor(path) === "windows";
}

function normalizeWindowsHostPath(path: string): string {
  const drive = WINDOWS_DRIVE_PREFIX_PATTERN.exec(path)?.[1]?.toUpperCase() ?? "";
  const segments = path
    .slice(2)
    .split(WINDOWS_SEPARATOR_RUN_PATTERN)
    .filter((segment) => segment.length > 0);
  return segments.length === 0
    ? `${drive}:\\`
    : `${drive}:\\${segments.join("\\")}`;
}

function normalizePosixHostPath(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

export function normalizeHostPath(path: string): string {
  const flavor = detectHostPathFlavor(path);
  if (flavor === "windows") {
    return normalizeWindowsHostPath(path);
  }
  if (flavor === "posix") {
    return normalizePosixHostPath(path);
  }
  return path;
}

export function isHostPathRoot(path: string): boolean {
  const normalized = normalizeHostPath(path);
  return normalized === "/" || WINDOWS_CANONICAL_ROOT_PATTERN.test(normalized);
}

function hostPathSeparator(path: string): "/" | "\\" {
  return isWindowsHostPath(path) ? "\\" : "/";
}

export function joinHostPath(rootPath: string, ...segments: string[]): string {
  const root = normalizeHostPath(rootPath);
  const separator = hostPathSeparator(root);
  const splitter =
    separator === "\\"
      ? WINDOWS_SEPARATOR_RUN_PATTERN
      : POSIX_SEPARATOR_RUN_PATTERN;
  const tail = segments
    .flatMap((segment) => segment.split(splitter))
    .filter((segment) => segment.length > 0)
    .join(separator);
  if (tail.length === 0) {
    return root;
  }
  return root.endsWith(separator) ? `${root}${tail}` : `${root}${separator}${tail}`;
}

export function basenameHostPath(path: string): string {
  const normalized = normalizeHostPath(path);
  if (isHostPathRoot(normalized) || !isAbsoluteHostPath(normalized)) {
    return "";
  }
  const separator = hostPathSeparator(normalized);
  return normalized.slice(normalized.lastIndexOf(separator) + 1);
}

export function dirnameHostPath(path: string): string {
  const normalized = normalizeHostPath(path);
  if (isHostPathRoot(normalized) || !isAbsoluteHostPath(normalized)) {
    return normalized;
  }
  const separator = hostPathSeparator(normalized);
  const index = normalized.lastIndexOf(separator);
  if (separator === "/") {
    return index <= 0 ? "/" : normalized.slice(0, index);
  }
  return index <= 2 ? normalized.slice(0, 3) : normalized.slice(0, index);
}

export function buildHostPathKey(path: string): string {
  const normalized = normalizeHostPath(path);
  if (isWindowsHostPath(normalized)) {
    return normalized.replace(/\\/gu, "/").toLowerCase();
  }
  return normalized;
}

export function isHostPathWithin(args: {
  rootPath: string;
  candidatePath: string;
}): boolean {
  const rootFlavor = detectHostPathFlavor(args.rootPath);
  const candidateFlavor = detectHostPathFlavor(args.candidatePath);
  if (
    rootFlavor === null ||
    candidateFlavor === null ||
    rootFlavor !== candidateFlavor
  ) {
    return false;
  }
  const rootKey = buildHostPathKey(args.rootPath);
  const candidateKey = buildHostPathKey(args.candidatePath);
  if (candidateKey === rootKey) {
    return true;
  }
  const prefix = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  return candidateKey.startsWith(prefix);
}
