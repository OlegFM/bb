import {
  basenameHostPath,
  isAbsoluteHostPath,
  isHostPathRoot,
  isUncOrDeviceHostPath,
  normalizeHostPath,
} from "./host-path.js";

const SEPARATOR_ONLY_PATH_PATTERN = /^[\\/]+$/u;

export const INVALID_PROJECT_PATH_MESSAGE =
  "Project path must be an absolute path.";
export const PROJECT_PATH_ROOT_MESSAGE =
  "Project path must point to a project directory, not the filesystem root.";
export const UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE =
  "UNC and device paths (\\\\server\\share) are not supported. Use an absolute path on the machine, such as /home/me/repo or C:\\Users\\me\\repo.";

export function isAbsoluteProjectPath(path: string): boolean {
  return isAbsoluteHostPath(path.trim());
}

export function normalizeProjectPathInput(path: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath || !isAbsoluteHostPath(trimmedPath)) {
    return trimmedPath;
  }
  return normalizeHostPath(trimmedPath);
}

export function getProjectPathValidationMessage(path: string): string | null {
  const trimmedPath = path.trim();
  const normalizedPath = normalizeProjectPathInput(trimmedPath);
  if (!normalizedPath) {
    return INVALID_PROJECT_PATH_MESSAGE;
  }
  if (isUncOrDeviceHostPath(normalizedPath)) {
    return UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE;
  }
  if (trimmedPath !== "/" && SEPARATOR_ONLY_PATH_PATTERN.test(trimmedPath)) {
    return INVALID_PROJECT_PATH_MESSAGE;
  }
  if (!isAbsoluteHostPath(normalizedPath)) {
    return INVALID_PROJECT_PATH_MESSAGE;
  }
  if (isHostPathRoot(normalizedPath)) {
    return PROJECT_PATH_ROOT_MESSAGE;
  }
  return null;
}

export function deriveProjectNameFromPath(path: string): string {
  const normalizedPath = normalizeProjectPathInput(path);
  if (getProjectPathValidationMessage(normalizedPath) !== null) {
    return "";
  }
  return basenameHostPath(normalizedPath);
}
