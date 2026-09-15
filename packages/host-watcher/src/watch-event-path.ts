import path from "node:path";

export function isExtendedLengthWindowsPath(candidatePath: string): boolean {
  return (
    candidatePath.startsWith("\\\\?\\") || candidatePath.startsWith("\\\\.\\")
  );
}

function trimTrailingWindowsSeparators(candidatePath: string): string {
  const trimmed = candidatePath.replace(/[\\/]+$/u, "");
  return trimmed.length === 0 ? candidatePath : trimmed;
}

function stripExtendedLengthWindowsPrefix(candidatePath: string): string {
  return candidatePath.replace(/^\\\\[?.]\\/u, "");
}

export function normalizeWatchEventPath(
  rootPath: string,
  eventPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    if (isExtendedLengthWindowsPath(eventPath)) {
      return eventPath;
    }
    if (isExtendedLengthWindowsPath(rootPath)) {
      return path.win32.isAbsolute(eventPath)
        ? path.win32.normalize(eventPath)
        : `${trimTrailingWindowsSeparators(rootPath)}\\${eventPath}`;
    }
    return path.win32.isAbsolute(eventPath)
      ? path.win32.normalize(eventPath)
      : path.win32.resolve(rootPath, eventPath);
  }
  return path.posix.isAbsolute(eventPath)
    ? path.posix.normalize(eventPath)
    : path.posix.resolve(rootPath, eventPath);
}

function foldWindowsPathForContainment(candidatePath: string): string {
  const stripped = stripExtendedLengthWindowsPrefix(candidatePath);
  const normalized = isExtendedLengthWindowsPath(stripped)
    ? stripped
    : path.win32.normalize(stripped);
  return trimTrailingWindowsSeparators(normalized).toLowerCase();
}

export function isWatchPathWithinRoot(
  rootPath: string,
  candidatePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") {
    const relativePath = path.posix.relative(rootPath, candidatePath);
    return (
      relativePath.length === 0 ||
      (!relativePath.startsWith("..") && !path.posix.isAbsolute(relativePath))
    );
  }
  if (
    isExtendedLengthWindowsPath(rootPath) ||
    isExtendedLengthWindowsPath(candidatePath)
  ) {
    const foldedRoot = foldWindowsPathForContainment(rootPath);
    const foldedCandidate = foldWindowsPathForContainment(candidatePath);
    return (
      foldedCandidate === foldedRoot ||
      foldedCandidate.startsWith(`${foldedRoot}\\`)
    );
  }
  const normalizedRoot = path.win32.normalize(rootPath);
  const normalizedCandidate = normalizeWatchEventPath(
    rootPath,
    candidatePath,
    platform,
  );
  const relativePath = path.win32.relative(normalizedRoot, normalizedCandidate);
  return (
    relativePath.length === 0 ||
    (relativePath !== ".." &&
      !relativePath.startsWith("..\\") &&
      !path.win32.isAbsolute(relativePath))
  );
}

export function toWatchRootRelativeKey(
  rootPath: string,
  candidatePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const normalizedRoot = path.win32.normalize(
      stripExtendedLengthWindowsPrefix(rootPath),
    );
    const normalizedCandidate = stripExtendedLengthWindowsPrefix(
      normalizeWatchEventPath(rootPath, candidatePath, platform),
    );
    return path.win32
      .relative(normalizedRoot, normalizedCandidate)
      .split(/[/\\]/u)
      .join("/");
  }
  return path.posix.relative(rootPath, candidatePath);
}

export function dedupeWatchPathChanges<
  T extends { path: string; type: string },
>(changes: T[], platform: NodeJS.Platform = process.platform): T[] {
  if (platform !== "win32") {
    return changes;
  }
  const seen = new Set<string>();
  const result: T[] = [];
  for (const change of changes) {
    const key = `${change.type}\0${change.path.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(change);
  }
  return result;
}

export function joinWatchedEntry(dir: string, entry: string): string {
  return path.win32.isAbsolute(dir) && !path.posix.isAbsolute(dir)
    ? path.win32.join(dir, entry)
    : path.posix.join(dir, entry);
}
