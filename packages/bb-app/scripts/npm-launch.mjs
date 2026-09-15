import { existsSync as defaultExistsSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolveNpmLaunch({
  args,
  command,
  execPath,
  existsSync = defaultExistsSync,
  platform,
}) {
  if (platform !== "win32") {
    return { args, command };
  }
  const cliPath = join(
    dirname(execPath),
    "node_modules",
    "npm",
    "bin",
    `${command}-cli.js`,
  );
  if (!existsSync(cliPath)) {
    throw new Error(
      `npm launcher not found beside ${execPath}; the smoke needs the Node.js distribution's bundled npm`,
    );
  }
  return { args: [cliPath, ...args], command: execPath };
}
