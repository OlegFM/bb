import { existsSync as defaultExistsSync, readFileSync } from "node:fs";
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

function resolveLaunch(
  command,
  args,
  { execPath = process.execPath, existsSync, platform = process.platform } = {},
) {
  if (command !== "npm" && command !== "npx") {
    return { args, command };
  }
  return resolveNpmLaunch({
    args,
    command,
    execPath,
    platform,
    ...(existsSync === undefined ? {} : { existsSync }),
  });
}

export function resolveLaunchForLabel(label, command, args, options) {
  try {
    return resolveLaunch(command, args, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

export function resolveInstalledBinEntry(binDir, bin) {
  const packageDir = join(binDir, "..", "bb-app");
  const packageJson = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  );
  const entry =
    typeof packageJson.bin === "string"
      ? packageJson.name === bin
        ? packageJson.bin
        : undefined
      : packageJson.bin?.[bin];
  if (typeof entry !== "string") {
    throw new Error(
      `Installed ${packageJson.name ?? "package"} package.json has no bin entry for ${bin}`,
    );
  }
  return join(packageDir, entry);
}
