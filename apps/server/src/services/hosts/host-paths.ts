import {
  buildHostPathKey,
  isAbsoluteHostPath,
  isBareDriveHostPath,
  isUncOrDeviceHostPath,
  joinHostPath,
  normalizeHostPath,
} from "@bb/domain";
import type { CanonicalHostPath } from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { WorkSessionDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "./online-rpc.js";

const CANONICALIZE_PATH_TIMEOUT_MS = 15_000;

function invalidHostPath(message: string): ApiError {
  return new ApiError(400, "invalid_path", message, false);
}

function assertCanonicalizableShape(path: string): void {
  if (isUncOrDeviceHostPath(path)) {
    throw invalidHostPath(
      `Path "${path}" is a UNC or device path; use an absolute path on the machine, such as /home/me/repo or C:\\Users\\me\\repo`,
    );
  }
  if (isBareDriveHostPath(path)) {
    throw invalidHostPath(
      `Path "${path}" must be a drive-absolute path such as C:\\Users\\me\\repo`,
    );
  }
  if (!isAbsoluteHostPath(path)) {
    throw invalidHostPath(`Path "${path}" must be an absolute path`);
  }
}

export async function canonicalizeHostPath(
  deps: WorkSessionDeps,
  args: { hostId: string; path: string },
): Promise<CanonicalHostPath> {
  if (deps.hub.getDaemonSessionIdForHost(args.hostId) === null) {
    assertCanonicalizableShape(args.path);
    const path = normalizeHostPath(args.path);
    return { path, pathKey: buildHostPathKey(path) };
  }
  try {
    return await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: CANONICALIZE_PATH_TIMEOUT_MS,
      command: { type: "host.canonicalize_path", path: args.path },
    });
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "invalid_path") {
      throw invalidHostPath(error.body.message);
    }
    throw error;
  }
}

export async function canonicalizeProducedHostPath(
  deps: WorkSessionDeps,
  args: { hostId: string; path: string },
): Promise<CanonicalHostPath> {
  try {
    return await canonicalizeHostPath(deps, args);
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "invalid_path") {
      const path = args.path.replace(/\/+$/u, "") || "/";
      return { path, pathKey: buildHostPathKey(path) };
    }
    throw error;
  }
}

export async function canonicalizeHostDataDir(
  deps: WorkSessionDeps,
  args: { hostId: string; dataDir: string },
): Promise<string> {
  try {
    return (
      await canonicalizeHostPath(deps, {
        hostId: args.hostId,
        path: args.dataDir,
      })
    ).path;
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "invalid_path") {
      return normalizeHostPath(args.dataDir);
    }
    throw error;
  }
}

export function managedWorkspaceRoots(dataDir: string): string[] {
  return [
    joinHostPath(dataDir, "worktrees"),
    joinHostPath(dataDir, "personal-workspaces"),
  ];
}
