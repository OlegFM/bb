import {
  findForeignManagedEnvironmentAtHostPathKey,
  findProjectEnvironmentByHostPathKey,
  type DbConnection,
} from "@bb/db";
import { isBbManagedWorkspacePath } from "./workspace-paths.js";

interface ForeignProviderOwnedPathCheckArgs {
  dataDir: string | null;
  hostId: string;
  path: string;
  pathKey: string;
  projectId: string;
}

export function foreignProviderOwnedPathRefusal(
  db: DbConnection,
  args: ForeignProviderOwnedPathCheckArgs,
): string | null {
  const refusal =
    "Workspace path is a bb-managed workspace owned by another project";

  if (
    findForeignManagedEnvironmentAtHostPathKey(db, {
      hostId: args.hostId,
      pathKey: args.pathKey,
      projectId: args.projectId,
    })
  ) {
    return refusal;
  }

  if (
    args.dataDir !== null &&
    isBbManagedWorkspacePath({ dataDir: args.dataDir, path: args.path }) &&
    findProjectEnvironmentByHostPathKey(
      db,
      args.projectId,
      args.hostId,
      args.pathKey,
    ) === null
  ) {
    return refusal;
  }

  return null;
}
