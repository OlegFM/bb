import { isHostPathWithin, joinHostPath } from "@bb/domain";
import { PLUGIN_PROCESS_DATA_KINDS } from "@bb/process-utils";
import { managedWorkspaceRoots } from "../hosts/host-paths.js";

export function isBbManagedWorkspacePath(args: {
  dataDir: string;
  path: string;
}): boolean {
  if (
    managedWorkspaceRoots(args.dataDir).some((rootPath) =>
      isHostPathWithin({ rootPath, candidatePath: args.path }),
    )
  )
    return true;
  const pluginsRoot = joinHostPath(args.dataDir, "plugins");
  if (!isHostPathWithin({ rootPath: pluginsRoot, candidatePath: args.path })) {
    return false;
  }
  const relative = args.path.slice(pluginsRoot.length).replace(/^[\\/]+/u, "");
  const [pluginSegment, kind] = relative.split(/[\\/]/u);
  return (
    pluginSegment !== undefined &&
    pluginSegment.length > 0 &&
    kind !== undefined &&
    PLUGIN_PROCESS_DATA_KINDS.some((value) => value === kind)
  );
}
