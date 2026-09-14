import {
  resolveWindowsSystemToolPath,
  spawnPortableOutputProcess,
} from "@bb/process-utils";

export interface WindowsSecretUser {
  accountName: string;
  sid: string;
}

export interface WindowsAclCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type WindowsAclCommandRunner = (
  command: string,
  args: string[],
) => Promise<WindowsAclCommandResult>;

export interface WindowsAclDeps {
  env?: NodeJS.ProcessEnv;
  runCommand?: WindowsAclCommandRunner;
}

export interface WindowsFileAce {
  identity: string;
  rights: string;
}

export const SECRET_FILE_ACL_REMEDY =
  "Store the bb data directory on an NTFS volume where icacls can set permissions";

const WINDOWS_SID_PATTERN = /^S-\d+(?:-\d+)+$/u;
const WINDOWS_USER_CSV_ROW_PATTERN = /^"([^"]*)","([^"]*)"$/u;

function runWindowsAclTool(
  command: string,
  args: string[],
): Promise<WindowsAclCommandResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnPortableOutputProcess({
      command,
      args,
      platform: "win32",
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.once("error", rejectRun);
    child.once("close", (code) => {
      resolveRun({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
}

function describeCommandFailure(result: WindowsAclCommandResult): string {
  const detail = result.stderr.trim();
  const exit = `exited with ${String(result.exitCode)}`;
  return detail.length > 0 ? `${exit}: ${detail}` : exit;
}

export function parseWindowsUserCsv(stdout: string): WindowsSecretUser {
  const lines = stdout.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = WINDOWS_USER_CSV_ROW_PATTERN.exec(lines[index].trim());
    if (match === null) continue;
    const accountName = match[1];
    const sid = match[2];
    if (!WINDOWS_SID_PATTERN.test(sid)) continue;
    return { accountName, sid };
  }
  throw new Error(
    `Could not read the current Windows user from "whoami /user /fo csv" output: ${JSON.stringify(stdout)}`,
  );
}

let cachedWindowsUser: Promise<WindowsSecretUser> | undefined;

export async function resolveCurrentWindowsUser(
  deps: WindowsAclDeps = {},
): Promise<WindowsSecretUser> {
  const load = async (): Promise<WindowsSecretUser> => {
    const run = deps.runCommand ?? runWindowsAclTool;
    const command = resolveWindowsSystemToolPath("whoami.exe", deps.env);
    const result = await run(command, ["/user", "/fo", "csv"]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not determine the current Windows user: "${command} /user /fo csv" ${describeCommandFailure(result)}`,
      );
    }
    return parseWindowsUserCsv(result.stdout);
  };
  if (deps.runCommand !== undefined) {
    return load();
  }
  if (cachedWindowsUser === undefined) {
    cachedWindowsUser = load();
  }
  try {
    return await cachedWindowsUser;
  } catch (error) {
    cachedWindowsUser = undefined;
    throw error;
  }
}

export async function tightenSecretFileAcl(
  path: string,
  user: WindowsSecretUser,
  deps: WindowsAclDeps = {},
): Promise<void> {
  const run = deps.runCommand ?? runWindowsAclTool;
  const command = resolveWindowsSystemToolPath("icacls.exe", deps.env);
  const result = await run(command, [
    path,
    "/inheritance:r",
    "/grant:r",
    `*${user.sid}:F`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not restrict the secret file "${path}" to ${user.accountName}: icacls ${describeCommandFailure(result)}. ${SECRET_FILE_ACL_REMEDY}.`,
    );
  }
}

export function parseSecretFileAcl(
  path: string,
  stdout: string,
): WindowsFileAce[] {
  const aces: WindowsFileAce[] = [];
  let sawFirstLine = false;
  for (const rawLine of stdout.split(/\r?\n/u)) {
    if (rawLine.trim().length === 0) break;
    let line = rawLine;
    if (!sawFirstLine) {
      sawFirstLine = true;
      if (!line.startsWith(path)) {
        throw new Error(
          `Could not parse the permissions of the secret file "${path}": ${JSON.stringify(stdout)}`,
        );
      }
      line = line.slice(path.length);
    }
    const entry = line.trim();
    const separator = entry.lastIndexOf(":");
    if (separator <= 0) {
      throw new Error(
        `Could not parse the permissions of the secret file "${path}": ${JSON.stringify(stdout)}`,
      );
    }
    aces.push({
      identity: entry.slice(0, separator),
      rights: entry.slice(separator + 1),
    });
  }
  if (!sawFirstLine) {
    throw new Error(
      `Could not parse the permissions of the secret file "${path}": ${JSON.stringify(stdout)}`,
    );
  }
  return aces;
}

export async function readSecretFileAcl(
  path: string,
  deps: WindowsAclDeps = {},
): Promise<WindowsFileAce[]> {
  const run = deps.runCommand ?? runWindowsAclTool;
  const command = resolveWindowsSystemToolPath("icacls.exe", deps.env);
  const result = await run(command, [path]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not read the permissions of the secret file "${path}": icacls ${describeCommandFailure(result)}. ${SECRET_FILE_ACL_REMEDY}.`,
    );
  }
  return parseSecretFileAcl(path, result.stdout);
}

function isOwnerIdentity(
  ace: WindowsFileAce,
  user: WindowsSecretUser,
): boolean {
  const identity = ace.identity.startsWith("*")
    ? ace.identity.slice(1)
    : ace.identity;
  const normalized = identity.toLowerCase();
  return (
    normalized === user.accountName.toLowerCase() ||
    normalized === user.sid.toLowerCase()
  );
}

export function assertSecretFileAclIsPrivate(
  path: string,
  aces: readonly WindowsFileAce[],
  user: WindowsSecretUser,
): void {
  const offending = aces.filter(
    (ace) => !isOwnerIdentity(ace, user) || ace.rights !== "(F)",
  );
  if (aces.length === 1 && offending.length === 0) {
    return;
  }
  const listed =
    aces.length === 0
      ? "no entries"
      : aces.map((ace) => `${ace.identity}:${ace.rights}`).join(", ");
  throw new Error(
    `The secret file "${path}" is not restricted to ${user.accountName}: ${listed}. ${SECRET_FILE_ACL_REMEDY}.`,
  );
}

export async function ensureSecretFileIsPrivate(
  path: string,
  deps: WindowsAclDeps = {},
): Promise<void> {
  const user = await resolveCurrentWindowsUser(deps);
  await tightenSecretFileAcl(path, user, deps);
  assertSecretFileAclIsPrivate(path, await readSecretFileAcl(path, deps), user);
}
