import { WorkspaceError } from "bb-environment-provider-host/git";
import path from "node:path";

const REPO_DIR_NAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;

function tryParseUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ssh:"
    ) {
      return url.pathname;
    }
  } catch {}
  return null;
}

function sourceBasename(pathPart: string): string {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(pathPart)) {
    return path.win32.basename(pathPart.replace(/[\\/]+$/u, ""));
  }
  return path.posix.basename(pathPart.replace(/\/+$/u, ""));
}

export function deriveRepoDirName(sourcePath: string): string {
  const trimmed = sourcePath.replace(/\/+$/, "");

  const scpMatch = /^[^:/\\]+@[^:]+:(?<path>.+)$/.exec(trimmed);
  const pathPart =
    scpMatch?.groups?.path ?? tryParseUrlPath(trimmed) ?? trimmed;

  const basename = sourceBasename(pathPart);
  const candidate = basename.endsWith(".git")
    ? basename.slice(0, -".git".length)
    : basename;

  if (
    !candidate ||
    candidate === "." ||
    candidate === ".." ||
    !REPO_DIR_NAME_PATTERN.test(candidate)
  ) {
    throw new WorkspaceError(
      "invalid_source_path",
      `Cannot derive repository directory name from source "${sourcePath}"`,
    );
  }
  return candidate;
}

export function resolveWorktreesRoot(dataDir: string): string {
  return path.join(dataDir, "worktrees");
}

export function resolveWorktreeAttemptRoot(args: {
  dataDir: string;
  pathKey: string;
}): string {
  if (
    args.pathKey === "." ||
    args.pathKey === ".." ||
    path.basename(args.pathKey) !== args.pathKey ||
    /[\\/]/u.test(args.pathKey)
  ) {
    throw new WorkspaceError(
      "invalid_path_key",
      "A worktree path key must be a single path segment",
    );
  }
  return path.join(resolveWorktreesRoot(args.dataDir), args.pathKey);
}

export function resolveWorktreeTargetPath(args: {
  dataDir: string;
  pathKey: string;
  sourcePath: string;
}): string {
  return path.join(
    resolveWorktreeAttemptRoot(args),
    deriveRepoDirName(args.sourcePath),
  );
}
