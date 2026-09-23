import { joinHostPath } from "@bb/domain";
import type { WorkSessionDeps } from "../../types.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";

interface RequireThreadStoragePathArgs {
  hostId: string;
  threadId: string;
}

export async function requireThreadStoragePath(
  deps: WorkSessionDeps,
  args: RequireThreadStoragePathArgs,
): Promise<string> {
  const session = await ensureHostSessionReadyForWork(deps, {
    hostId: args.hostId,
  });
  return joinHostPath(session.dataDir, "thread-storage", args.threadId);
}
