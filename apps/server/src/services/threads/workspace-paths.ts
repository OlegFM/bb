import { isHostPathWithin } from "@bb/domain";
import { managedWorkspaceRoots } from "../hosts/host-paths.js";

export function isBbManagedWorkspacePath(args: {
  dataDir: string;
  path: string;
}): boolean {
  return managedWorkspaceRoots(args.dataDir).some((rootPath) =>
    isHostPathWithin({ rootPath, candidatePath: args.path }),
  );
}
