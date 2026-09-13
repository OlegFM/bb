import {
  detectHostPathFlavor,
  isAbsoluteHostPath,
  isBareDriveHostPath,
} from "@bb/domain";

interface ResolveAbsoluteFilePathArgs {
  path: string;
  rootPath: string | null | undefined;
}

interface BuildAbsoluteFilePathArgs {
  path: string;
  rootPath: string;
}

interface GetAbsoluteDirnameArgs {
  path: string;
}

interface IsAbsoluteFilePathWithinRootArgs {
  candidatePath: string;
  rootPath: string;
}

interface NormalizeAbsoluteFilePathArgs {
  path: string;
}

export function isWindowsAbsoluteFilePath(path: string): boolean {
  return detectHostPathFlavor(path) === "windows" && !isBareDriveHostPath(path);
}

export function isAbsoluteFilePath(path: string): boolean {
  return isAbsoluteHostPath(path) && !isBareDriveHostPath(path);
}

function trimTrailingSlash(path: string): string {
  if (path === "/") {
    return path;
  }
  return path.replace(/\/+$/u, "");
}

function trimLeadingSlash(path: string): string {
  return path.replace(/^\/+/u, "");
}

function trimTrailingBackslash(path: string): string {
  return path.replace(/\\+$/u, "");
}

function resolveDotSegments(segments: string[]): string[] {
  const normalizedSegments: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (normalizedSegments.length > 0) {
        normalizedSegments.pop();
      }
      continue;
    }
    normalizedSegments.push(segment);
  }
  return normalizedSegments;
}

function normalizeWindowsFilePath(path: string): string {
  const unified = path.replace(/\//gu, "\\");
  const drive = unified.slice(0, 1).toUpperCase();
  const segments = resolveDotSegments(unified.slice(3).split("\\"));
  return segments.length === 0
    ? `${drive}:\\`
    : `${drive}:\\${segments.join("\\")}`;
}

function normalizePosixFilePath(path: string): string {
  const normalizedSegments = resolveDotSegments(path.split("/"));

  return normalizedSegments.length === 0
    ? "/"
    : `/${normalizedSegments.join("/")}`;
}

export function normalizeAbsoluteFilePath({
  path,
}: NormalizeAbsoluteFilePathArgs): string | null {
  if (!isAbsoluteFilePath(path)) {
    return null;
  }
  return isWindowsAbsoluteFilePath(path)
    ? normalizeWindowsFilePath(path)
    : normalizePosixFilePath(path);
}

function windowsRootWithSeparator(rootPath: string): string {
  return rootPath.endsWith("\\") ? rootPath : `${rootPath}\\`;
}

export function isAbsoluteFilePathWithinRoot({
  candidatePath,
  rootPath,
}: IsAbsoluteFilePathWithinRootArgs): boolean {
  const normalizedCandidatePath = normalizeAbsoluteFilePath({
    path: candidatePath,
  });
  const normalizedRootPath = normalizeAbsoluteFilePath({ path: rootPath });
  if (normalizedCandidatePath === null || normalizedRootPath === null) {
    return false;
  }

  const candidateIsWindows = isWindowsAbsoluteFilePath(normalizedCandidatePath);
  const rootIsWindows = isWindowsAbsoluteFilePath(normalizedRootPath);
  if (candidateIsWindows !== rootIsWindows) {
    return false;
  }

  if (rootIsWindows) {
    const loweredCandidate = normalizedCandidatePath.toLowerCase();
    const loweredRoot = normalizedRootPath.toLowerCase();
    return (
      loweredCandidate === loweredRoot ||
      loweredCandidate.startsWith(windowsRootWithSeparator(loweredRoot))
    );
  }

  if (normalizedRootPath === "/") {
    return normalizedCandidatePath.startsWith("/");
  }

  return (
    normalizedCandidatePath === normalizedRootPath ||
    normalizedCandidatePath.startsWith(`${normalizedRootPath}/`)
  );
}

function buildWindowsFilePath(rootPath: string, relativePath: string): string {
  const normalizedRootPath = trimTrailingBackslash(rootPath);
  const unifiedRelativePath = relativePath
    .replace(/\//gu, "\\")
    .replace(/^\\+/u, "");
  return `${normalizedRootPath}\\${unifiedRelativePath}`;
}

export function buildAbsoluteFilePath({
  path,
  rootPath,
}: BuildAbsoluteFilePathArgs): string {
  if (isAbsoluteFilePath(path)) {
    return path;
  }

  if (isWindowsAbsoluteFilePath(rootPath)) {
    return buildWindowsFilePath(rootPath, path);
  }

  const normalizedRootPath = trimTrailingSlash(rootPath);
  const relativePath = trimLeadingSlash(path);
  if (normalizedRootPath === "/") {
    return `/${relativePath}`;
  }
  return `${normalizedRootPath}/${relativePath}`;
}

export function resolveAbsoluteFilePath({
  path,
  rootPath,
}: ResolveAbsoluteFilePathArgs): string | null {
  if (isAbsoluteFilePath(path)) {
    return path;
  }
  if (!rootPath) {
    return null;
  }
  return buildAbsoluteFilePath({ path, rootPath });
}

function getWindowsDirname(path: string): string {
  const normalized = normalizeWindowsFilePath(path);
  const lastSeparatorIndex = normalized.lastIndexOf("\\");
  const parent = normalized.slice(0, lastSeparatorIndex);
  return isBareDriveHostPath(parent) ? `${parent}\\` : parent;
}

export function getAbsoluteDirname({ path }: GetAbsoluteDirnameArgs): string {
  if (isWindowsAbsoluteFilePath(path)) {
    return getWindowsDirname(path);
  }
  const trimmed = trimTrailingSlash(path);
  const lastSlashIndex = trimmed.lastIndexOf("/");
  return lastSlashIndex <= 0 ? "/" : trimmed.slice(0, lastSlashIndex);
}
