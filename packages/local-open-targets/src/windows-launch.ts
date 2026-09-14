import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceOpenTarget } from "@bb/host-daemon-contract";
import {
  resolveExecutable,
  resolveNodeShimSpawnPlan,
  resolvePowerShellExecutable,
  resolveWindowsSystemToolPath,
} from "@bb/process-utils";
import {
  BASIC_FILE_OPEN_CAPABILITIES,
  FILE_MANAGER_OPEN_CAPABILITIES,
} from "./capabilities.js";
import { WorkspaceOpenTargetError } from "./errors.js";
import { LAUNCH_ADAPTERS } from "./macos-launch-adapters.js";
import type {
  ExecFileInvocation,
  ExistingPath,
  LaunchAdapter,
  MacCommandExecutableAdapter,
  MacRemoteSshOpenCommandAdapter,
  OpenPathInTargetArgs,
  WorkspaceOpenTargetRuntime,
} from "./types.js";

const WINDOWS_APP_PATHS_SUBKEY =
  "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths";
const WINDOWS_APP_PATHS_HIVES = ["HKLM", "HKCU"] as const;
const WINDOWS_REGISTRY_VALUE_PATTERN = /\sREG_(?:EXPAND_)?SZ\s+(.*)$/mu;
const WINDOWS_LAUNCHER_PATHEXT = ".exe;.cmd;.bat;.com";
const WINDOWS_DEFAULT_SYSTEM_ROOT = "C:\\Windows";
const WINDOWS_INSTALL_ROOT_ENV_VARIABLES = [
  "ProgramFiles",
  "ProgramFiles(x86)",
] as const;
const WINDOWS_JETBRAINS_SHIM_EXTENSIONS = [".cmd", ".bat", ".exe"];
const WINDOWS_TERMINAL_COMMAND = "wt";
const WINDOWS_TERMINAL_ALIAS_SEGMENTS = ["Microsoft", "WindowsApps", "wt.exe"];
const WINDOWS_UNSUPPORTED_TARGET_ID_PREFIXES = ["desktop-app:", "mac-app:"];
const WINDOWS_CMD_SHIM_ARGUMENT_ENV_PREFIX = "BBOPENTARGETARG";

type WindowsAppPathCache = Map<string, Promise<string | null>>;

interface WindowsCommandAdapter extends MacCommandExecutableAdapter {
  fallbackExecutables?: MacCommandExecutableAdapter[];
}

interface WindowsLaunchInvocation extends ExecFileInvocation {
  cwd?: string;
  detached?: boolean;
  explorerPath?: string;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
}

interface ResolveWindowsCliOpenArgs {
  columnNumber: number | null;
  definition: LaunchAdapter;
  existingPath: ExistingPath;
  lineNumber: number | null;
}

interface ResolveWindowsRemoteSshOpenArgs {
  columnNumber: number | null;
  definition: LaunchAdapter;
  lineNumber: number | null;
  path: string;
  sshAuthority: string;
}

function isPresentTarget(
  target: WorkspaceOpenTarget | null,
): target is WorkspaceOpenTarget {
  return target !== null;
}

function isExitCodeOneError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === 1;
}

function readWindowsRuntimeEnvValue(
  runtime: WorkspaceOpenTargetRuntime,
  name: string,
): string | undefined {
  const env = runtime.env;
  if (env === undefined) {
    return undefined;
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

function readWindowsDirectoryEnvValue(
  runtime: WorkspaceOpenTargetRuntime,
  name: string,
): string | null {
  const value = readWindowsRuntimeEnvValue(runtime, name)?.trim();
  return value === undefined || value === "" ? null : value;
}

async function windowsPathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function sortNewestNameFirst(entries: string[]): string[] {
  return [...entries].sort((a, b) => b.localeCompare(a));
}

function findWindowsLaunchAdapter(targetId: string): LaunchAdapter | null {
  return LAUNCH_ADAPTERS.find((candidate) => candidate.id === targetId) ?? null;
}

async function requireOpenableWindowsPath(
  targetPath: string,
): Promise<ExistingPath> {
  const stat = await fs.stat(targetPath).catch(() => null);
  if (stat === null) {
    throw new WorkspaceOpenTargetError({
      code: "path_not_found",
      message: `Open target path does not exist: ${targetPath}`,
    });
  }
  if (stat.isDirectory()) {
    return { path: targetPath, type: "directory" };
  }
  if (stat.isFile()) {
    return { path: targetPath, type: "file" };
  }
  throw new WorkspaceOpenTargetError({
    code: "path_not_openable",
    message: `Open target path must be a file or directory: ${targetPath}`,
  });
}

function getWindowsInstallRoots(runtime: WorkspaceOpenTargetRuntime): string[] {
  const roots: string[] = [];
  const localAppData = readWindowsDirectoryEnvValue(runtime, "LOCALAPPDATA");
  if (localAppData !== null) {
    roots.push(path.join(localAppData, "Programs"));
  }
  for (const variableName of WINDOWS_INSTALL_ROOT_ENV_VARIABLES) {
    const root = readWindowsDirectoryEnvValue(runtime, variableName);
    if (root !== null && !roots.includes(root)) {
      roots.push(root);
    }
  }
  return roots;
}

function getWindowsKnownExecutablePaths(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): string[] {
  const relativePaths = definition.windows?.knownRelativePaths ?? [];
  if (relativePaths.length === 0) {
    return [];
  }
  return getWindowsInstallRoots(runtime).flatMap((root) =>
    relativePaths.map((relativePath) => path.join(root, ...relativePath)),
  );
}

function parseWindowsRegistryDefaultValue(stdout: string): string | null {
  const match = WINDOWS_REGISTRY_VALUE_PATTERN.exec(stdout);
  const value = (match?.[1] ?? "").trim().replace(/^"(.*)"$/u, "$1");
  return value === "" ? null : value;
}

async function queryWindowsAppPath(
  executable: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const registryExecutable = resolveWindowsSystemToolPath(
    "reg.exe",
    runtime.env,
  );
  const valueName = executable.toLowerCase().endsWith(".exe")
    ? executable
    : `${executable}.exe`;
  for (const hive of WINDOWS_APP_PATHS_HIVES) {
    let stdout: string;
    try {
      const result = await runtime.execFile(
        registryExecutable,
        ["query", `${hive}\\${WINDOWS_APP_PATHS_SUBKEY}\\${valueName}`, "/ve"],
        { env: runtime.env },
      );
      stdout = result.stdout;
    } catch {
      continue;
    }
    const value = parseWindowsRegistryDefaultValue(stdout);
    if (value !== null && (await windowsPathExists(value))) {
      return value;
    }
  }
  return null;
}

function readWindowsAppPath(
  executable: string,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<string | null> {
  const key = executable.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const lookup = queryWindowsAppPath(executable, runtime);
  cache.set(key, lookup);
  return lookup;
}

function getWindowsJetBrainsToolbox(definition: LaunchAdapter): {
  bundlePrefixes: string[];
  executable: string;
} | null {
  if (definition.macos.openMode === "default-app") {
    return null;
  }
  return definition.macos.jetBrainsToolbox ?? null;
}

async function findWindowsJetBrainsToolboxScriptPath(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const toolbox = getWindowsJetBrainsToolbox(definition);
  const localAppData = readWindowsDirectoryEnvValue(runtime, "LOCALAPPDATA");
  if (toolbox === null || localAppData === null) {
    return null;
  }
  const scriptsDirectory = path.join(
    localAppData,
    "JetBrains",
    "Toolbox",
    "scripts",
  );
  for (const extension of WINDOWS_JETBRAINS_SHIM_EXTENSIONS) {
    const candidatePath = path.join(
      scriptsDirectory,
      `${toolbox.executable}${extension}`,
    );
    if (await windowsPathExists(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

async function findWindowsJetBrainsInstallPath(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const toolbox = getWindowsJetBrainsToolbox(definition);
  if (toolbox === null) {
    return null;
  }
  const launcherFileName = `${toolbox.executable}64.exe`;
  for (const root of getWindowsInstallRoots(runtime)) {
    const jetBrainsRoot = path.join(root, "JetBrains");
    const entries = await fs
      .readdir(jetBrainsRoot, { withFileTypes: true })
      .catch(() => null);
    if (entries === null) {
      continue;
    }
    const candidateDirectories = sortNewestNameFirst(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) =>
          toolbox.bundlePrefixes.some((prefix) =>
            name.toLowerCase().startsWith(prefix),
          ),
        ),
    );
    for (const directoryName of candidateDirectories) {
      const candidatePath = path.join(
        jetBrainsRoot,
        directoryName,
        "bin",
        launcherFileName,
      );
      if (await windowsPathExists(candidatePath)) {
        return candidatePath;
      }
    }
  }
  return null;
}

async function findWindowsExecutablePath(
  definition: LaunchAdapter,
  command: WindowsCommandAdapter,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<string | null> {
  const candidates = [command, ...(command.fallbackExecutables ?? [])];
  for (const candidate of candidates) {
    const resolved = await resolveWindowsLauncherExecutable(
      candidate.executable,
      runtime,
    );
    if (resolved !== null) {
      return resolved;
    }
  }
  if (definition.windows !== undefined) {
    for (const candidate of candidates) {
      const appPath = await readWindowsAppPath(
        candidate.executable,
        runtime,
        cache,
      );
      if (appPath !== null) {
        return appPath;
      }
    }
  }
  for (const candidatePath of getWindowsKnownExecutablePaths(
    definition,
    runtime,
  )) {
    if (await windowsPathExists(candidatePath)) {
      return candidatePath;
    }
  }
  const toolboxScriptPath = await findWindowsJetBrainsToolboxScriptPath(
    definition,
    runtime,
  );
  if (toolboxScriptPath !== null) {
    return toolboxScriptPath;
  }
  return findWindowsJetBrainsInstallPath(definition, runtime);
}

export function buildWindowsLauncherResolutionEnv(
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const launcherEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined || key.toLowerCase() === "pathext") {
      continue;
    }
    launcherEnv[key] = value;
  }
  launcherEnv.PATHEXT = WINDOWS_LAUNCHER_PATHEXT;
  return launcherEnv;
}

async function resolveWindowsLauncherExecutable(
  command: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  return resolveExecutable({
    command,
    env: buildWindowsLauncherResolutionEnv(runtime.env ?? process.env),
    platform: "win32",
  });
}

function buildWindowsCmdShimCommand(
  executablePath: string,
  args: string[],
): { commandLine: string; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {};
  const references = [executablePath, ...args].map((value, index) => {
    const name = `${WINDOWS_CMD_SHIM_ARGUMENT_ENV_PREFIX}${index}`;
    env[name] = value;
    return `"%${name}%"`;
  });
  return { commandLine: `"${references.join(" ")}"`, env };
}

function buildWindowsStartConsoleCommandLine(shellPath: string): string {
  return `"start "" "${shellPath}" -NoLogo"`;
}

async function buildWindowsExecutableInvocation(
  executablePath: string,
  args: string[],
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WindowsLaunchInvocation> {
  const nodeShim = await resolveNodeShimSpawnPlan(executablePath);
  if (nodeShim !== null) {
    return {
      file: nodeShim.command,
      args: [...nodeShim.args, ...args],
      env: runtime.env,
    };
  }
  const shim = buildWindowsCmdShimCommand(executablePath, args);
  return {
    file: resolveWindowsSystemToolPath("cmd.exe", runtime.env),
    args: ["/d", "/s", "/c", shim.commandLine],
    env: { ...(runtime.env ?? process.env), ...shim.env },
    windowsVerbatimArguments: true,
  };
}

function resolveWindowsExplorerPath(
  runtime: WorkspaceOpenTargetRuntime,
): string {
  return path.join(
    readWindowsDirectoryEnvValue(runtime, "SystemRoot") ??
      WINDOWS_DEFAULT_SYSTEM_ROOT,
    "explorer.exe",
  );
}

function getWindowsCliOpenCommand(
  definition: LaunchAdapter,
): WindowsCommandAdapter | null {
  if (definition.macos.openMode === "default-app") {
    return null;
  }
  return (
    definition.macos.pathOpenCommand ?? definition.macos.lineOpenCommand ?? null
  );
}

function getWindowsRemoteSshOpenCommand(
  definition: LaunchAdapter,
): MacRemoteSshOpenCommandAdapter | null {
  if (definition.macos.openMode === "default-app") {
    return null;
  }
  return definition.macos.remoteSshOpenCommand ?? null;
}

async function isWindowsCliTargetAvailable(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<boolean> {
  const command = getWindowsCliOpenCommand(definition);
  return (
    command !== null &&
    (await findWindowsExecutablePath(definition, command, runtime, cache)) !==
      null
  );
}

async function findUnavailableWindowsRemoteSshExecutable(
  definition: LaunchAdapter,
  command: MacRemoteSshOpenCommandAdapter,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<string | null> {
  for (const executable of command.requiredExecutables ?? []) {
    if (
      (await resolveExecutable({
        command: executable,
        env: runtime.env,
        platform: "win32",
      })) === null
    ) {
      return executable;
    }
  }
  return (await findWindowsExecutablePath(
    definition,
    command,
    runtime,
    cache,
  )) === null
    ? command.executable
    : null;
}

async function toWindowsOpenTarget(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<WorkspaceOpenTarget | null> {
  if (!(await isWindowsCliTargetAvailable(definition, runtime, cache))) {
    return null;
  }
  const target: WorkspaceOpenTarget = {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    icon: definition.icon,
    capabilities: definition.capabilities,
  };
  const remoteSshOpenCommand = getWindowsRemoteSshOpenCommand(definition);
  if (
    remoteSshOpenCommand !== null &&
    (await findUnavailableWindowsRemoteSshExecutable(
      definition,
      remoteSshOpenCommand,
      runtime,
      cache,
    )) === null
  ) {
    target.remoteSshCapabilities = remoteSshOpenCommand.capabilities;
  }
  return target;
}

export async function listWindowsWorkspaceOpenTargets(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WorkspaceOpenTarget[]> {
  const cache: WindowsAppPathCache = new Map();
  const editors = await Promise.all(
    LAUNCH_ADAPTERS.map((definition) =>
      toWindowsOpenTarget(definition, runtime, cache),
    ),
  );
  return [
    ...editors.filter(isPresentTarget),
    {
      id: "default-app",
      label: "Default App",
      kind: "default-app",
      icon: { kind: "symbol", name: "default-app" },
      capabilities: BASIC_FILE_OPEN_CAPABILITIES,
    },
    {
      id: "file-manager",
      label: "File Manager",
      kind: "file-manager",
      icon: { kind: "symbol", name: "file-manager" },
      capabilities: FILE_MANAGER_OPEN_CAPABILITIES,
    },
    {
      id: "terminal",
      label: "Terminal",
      kind: "terminal",
      icon: { kind: "symbol", name: "terminal" },
      capabilities: BASIC_FILE_OPEN_CAPABILITIES,
    },
  ];
}

async function maybeResolveWindowsCliOpenInvocation(
  args: ResolveWindowsCliOpenArgs,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<WindowsLaunchInvocation | null> {
  if (args.definition.macos.openMode === "default-app") {
    return null;
  }
  const lineOpenCommand = args.definition.macos.lineOpenCommand;
  if (
    lineOpenCommand !== undefined &&
    args.lineNumber !== null &&
    args.existingPath.type === "file"
  ) {
    const executablePath = await findWindowsExecutablePath(
      args.definition,
      lineOpenCommand,
      runtime,
      cache,
    );
    if (executablePath !== null) {
      return buildWindowsExecutableInvocation(
        executablePath,
        lineOpenCommand.toArgs({
          columnNumber: lineOpenCommand.supportsColumn
            ? args.columnNumber
            : null,
          lineNumber: args.lineNumber,
          path: args.existingPath.path,
        }),
        runtime,
      );
    }
  }
  const pathOpenCommand = args.definition.macos.pathOpenCommand;
  if (pathOpenCommand === undefined) {
    return null;
  }
  const executablePath = await findWindowsExecutablePath(
    args.definition,
    pathOpenCommand,
    runtime,
    cache,
  );
  if (executablePath === null) {
    return null;
  }
  const openPath =
    args.existingPath.type === "file" &&
    args.definition.fileOpenBehavior === "containing-directory"
      ? path.dirname(args.existingPath.path)
      : args.existingPath.path;
  return buildWindowsExecutableInvocation(
    executablePath,
    pathOpenCommand.toArgs(openPath),
    runtime,
  );
}

function resolveWindowsDefaultAppInvocation(
  existingPath: ExistingPath,
  runtime: WorkspaceOpenTargetRuntime,
): WindowsLaunchInvocation {
  return {
    file: resolveWindowsExplorerPath(runtime),
    args: [existingPath.path],
    env: runtime.env,
    explorerPath: existingPath.path,
  };
}

function resolveWindowsFileManagerInvocation(
  existingPath: ExistingPath,
  runtime: WorkspaceOpenTargetRuntime,
): WindowsLaunchInvocation {
  if (existingPath.type === "file") {
    return {
      file: resolveWindowsExplorerPath(runtime),
      args: [`/select,"${existingPath.path}"`],
      env: runtime.env,
      explorerPath: existingPath.path,
      windowsVerbatimArguments: true,
    };
  }
  return {
    file: resolveWindowsExplorerPath(runtime),
    args: [existingPath.path],
    env: runtime.env,
    explorerPath: existingPath.path,
  };
}

async function findWindowsTerminalExecutable(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const resolved = await resolveWindowsLauncherExecutable(
    WINDOWS_TERMINAL_COMMAND,
    runtime,
  );
  if (resolved !== null) {
    return resolved;
  }
  const localAppData = readWindowsDirectoryEnvValue(runtime, "LOCALAPPDATA");
  if (localAppData === null) {
    return null;
  }
  const aliasPath = path.join(localAppData, ...WINDOWS_TERMINAL_ALIAS_SEGMENTS);
  return (await windowsPathExists(aliasPath)) ? aliasPath : null;
}

async function resolveWindowsTerminalInvocation(
  existingPath: ExistingPath,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WindowsLaunchInvocation> {
  const directory =
    existingPath.type === "file"
      ? path.dirname(existingPath.path)
      : existingPath.path;
  const windowsTerminalPath = await findWindowsTerminalExecutable(runtime);
  if (windowsTerminalPath !== null) {
    return {
      file: windowsTerminalPath,
      args: ["-d", directory],
      env: runtime.env,
      windowsHide: false,
    };
  }
  return {
    file: resolveWindowsSystemToolPath("cmd.exe", runtime.env),
    args: [
      "/d",
      "/s",
      "/c",
      buildWindowsStartConsoleCommandLine(
        resolvePowerShellExecutable(runtime.env),
      ),
    ],
    cwd: directory,
    detached: true,
    env: runtime.env,
    windowsHide: true,
    windowsVerbatimArguments: true,
  };
}

async function resolveWindowsRemoteSshInvocation(
  args: ResolveWindowsRemoteSshOpenArgs,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<WindowsLaunchInvocation> {
  const remoteSshOpenCommand = getWindowsRemoteSshOpenCommand(args.definition);
  if (remoteSshOpenCommand === null) {
    throw new WorkspaceOpenTargetError({
      code: "remote_target_unsupported",
      message: `${args.definition.label} cannot open remote SSH paths`,
    });
  }
  const unavailableExecutable = await findUnavailableWindowsRemoteSshExecutable(
    args.definition,
    remoteSshOpenCommand,
    runtime,
    cache,
  );
  if (unavailableExecutable !== null) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `${args.definition.label} remote SSH opener is unavailable: ${unavailableExecutable}`,
    });
  }
  const executablePath = await findWindowsExecutablePath(
    args.definition,
    remoteSshOpenCommand,
    runtime,
    cache,
  );
  if (executablePath === null) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `${args.definition.label} remote SSH opener is unavailable: ${remoteSshOpenCommand.executable}`,
    });
  }
  return buildWindowsExecutableInvocation(
    executablePath,
    remoteSshOpenCommand.toArgs({
      columnNumber: remoteSshOpenCommand.capabilities.openFileAtColumn
        ? args.columnNumber
        : null,
      lineNumber: remoteSshOpenCommand.capabilities.openFileAtLine
        ? args.lineNumber
        : null,
      path: args.path,
      sshAuthority: args.sshAuthority,
    }),
    runtime,
  );
}

async function resolveWindowsOpenInvocation(
  args: OpenPathInTargetArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WindowsLaunchInvocation> {
  const cache: WindowsAppPathCache = new Map();
  const definition = findWindowsLaunchAdapter(args.targetId);
  if (args.context.kind === "remote-ssh") {
    if (
      definition !== null &&
      getWindowsCliOpenCommand(definition) !== null &&
      getWindowsRemoteSshOpenCommand(definition) !== null
    ) {
      return resolveWindowsRemoteSshInvocation(
        {
          columnNumber: args.columnNumber,
          definition,
          lineNumber: args.lineNumber,
          path: args.path,
          sshAuthority: args.context.sshAuthority,
        },
        runtime,
        cache,
      );
    }
    throw new WorkspaceOpenTargetError({
      code: "remote_target_unsupported",
      message: `${args.targetId} cannot open remote SSH paths`,
    });
  }

  if (
    WINDOWS_UNSUPPORTED_TARGET_ID_PREFIXES.some((prefix) =>
      args.targetId.startsWith(prefix),
    )
  ) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `Workspace open target is unavailable: ${args.targetId}`,
    });
  }

  const existingPath = await requireOpenableWindowsPath(args.path);
  if (definition !== null) {
    const invocation = await maybeResolveWindowsCliOpenInvocation(
      {
        columnNumber: args.columnNumber,
        definition,
        existingPath,
        lineNumber: args.lineNumber,
      },
      runtime,
      cache,
    );
    if (invocation !== null) {
      return invocation;
    }
  }
  if (args.targetId === "default-app") {
    return resolveWindowsDefaultAppInvocation(existingPath, runtime);
  }
  if (args.targetId === "file-manager") {
    return resolveWindowsFileManagerInvocation(existingPath, runtime);
  }
  if (args.targetId === "terminal") {
    return resolveWindowsTerminalInvocation(existingPath, runtime);
  }
  throw new WorkspaceOpenTargetError({
    code: "target_unavailable",
    message: `Workspace open target is unavailable: ${args.targetId}`,
  });
}

export async function openWindowsPathInTarget(
  args: OpenPathInTargetArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<void> {
  const invocation = await resolveWindowsOpenInvocation(args, runtime);
  try {
    await runtime.execFile(invocation.file, invocation.args, {
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      ...(invocation.detached === undefined
        ? {}
        : { detached: invocation.detached }),
      env: invocation.env,
      ...(invocation.windowsHide === undefined
        ? {}
        : { windowsHide: invocation.windowsHide }),
      ...(invocation.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
    });
  } catch (error) {
    if (
      invocation.explorerPath !== undefined &&
      isExitCodeOneError(error) &&
      (await windowsPathExists(invocation.explorerPath))
    ) {
      return;
    }
    throw error;
  }
}
