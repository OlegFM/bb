const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const WINDOWS_SEPARATOR_PATTERN = /[\\/]/u;

export function isWindowsAbsolutePath(path: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_PATTERN.test(path);
}

export function hostPathSegments(path: string): string[] {
  return isWindowsAbsolutePath(path)
    ? path.split(WINDOWS_SEPARATOR_PATTERN)
    : path.split("/");
}

export function hostPathBasename(path: string): string | undefined {
  return hostPathSegments(path).at(-1);
}
