import { buildHostPathKey, joinHostPath, normalizeHostPath } from "@bb/domain";
import type { CanonicalHostPath } from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { WorkSessionDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "./online-rpc.js";

const CANONICALIZE_PATH_TIMEOUT_MS = 15_000;

export async function canonicalizeHostPath(
  deps: WorkSessionDeps,
  args: { hostId: string; path: string },
): Promise<CanonicalHostPath> {
  if (deps.hub.getDaemonSessionIdForHost(args.hostId) === null) {
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
      throw new ApiError(400, "invalid_path", error.body.message, false);
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
