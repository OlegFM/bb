import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ensureSecretFileIsPrivate,
  type WindowsAclDeps,
} from "./windows-acl.js";

export interface SecretFileOptions {
  platform?: NodeJS.Platform;
  deps?: WindowsAclDeps;
}

interface ReadOrCreateSecretFileArgs extends SecretFileOptions {
  bytes: number;
  dataDir: string;
  encoding: BufferEncoding;
  fileName: string;
}

const verifiedSecretPaths = new Set<string>();

async function ensureSecretFileIsPrivateOnce(
  path: string,
  options: SecretFileOptions,
): Promise<void> {
  const key = path.toLowerCase();
  if (verifiedSecretPaths.has(key)) return;
  await ensureSecretFileIsPrivate(path, options.deps ?? {});
  verifiedSecretPaths.add(key);
}

async function createPrivateSecretFile(
  path: string,
  options: SecretFileOptions,
): Promise<void> {
  const handle = await open(path, "wx");
  await handle.close();
  await ensureSecretFileIsPrivate(path, options.deps ?? {});
}

function errorCodeOf(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

async function removeWedgedSecretFile(path: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")).trim().length > 0) {
      return;
    }
  } catch (error) {
    if (errorCodeOf(error) !== "ENOENT") {
      throw error;
    }
    return;
  }
  await rm(path, { force: true });
}

export async function readOrCreateSecretFile(
  args: ReadOrCreateSecretFileArgs,
): Promise<string> {
  await mkdir(args.dataDir, { recursive: true });
  const secretPath = join(args.dataDir, args.fileName);
  const platform = args.platform ?? process.platform;

  try {
    const existing = (await readFile(secretPath, "utf8")).trim();
    if (existing.length > 0) {
      if (platform === "win32") {
        await ensureSecretFileIsPrivateOnce(secretPath, { deps: args.deps });
      }
      return existing;
    }
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (errorCode !== "ENOENT") {
      throw error;
    }
  }

  const generatedSecret = randomBytes(args.bytes).toString(args.encoding);

  if (platform === "win32") {
    await removeWedgedSecretFile(secretPath);
    const stagedPath = `${secretPath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await createPrivateSecretFile(stagedPath, { deps: args.deps });
      await writeFile(stagedPath, `${generatedSecret}\n`, { encoding: "utf8" });
    } catch (error) {
      await rm(stagedPath, { force: true });
      throw error;
    }
    try {
      await link(stagedPath, secretPath);
    } catch (error) {
      await unlink(stagedPath);
      if (errorCodeOf(error) !== "EEXIST") {
        throw error;
      }
      const racedSecret = (await readFile(secretPath, "utf8")).trim();
      if (racedSecret.length === 0) {
        throw new Error(`Failed to initialize secret at ${secretPath}`);
      }
      await ensureSecretFileIsPrivateOnce(secretPath, { deps: args.deps });
      return racedSecret;
    }
    await unlink(stagedPath);
    verifiedSecretPaths.add(secretPath.toLowerCase());
    return generatedSecret;
  }

  try {
    await writeFile(secretPath, `${generatedSecret}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return generatedSecret;
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (errorCode !== "EEXIST") {
      throw error;
    }
  }

  const racedSecret = (await readFile(secretPath, "utf8")).trim();
  if (racedSecret.length === 0) {
    throw new Error(`Failed to initialize secret at ${secretPath}`);
  }
  return racedSecret;
}

export async function writeSecretFile(
  path: string,
  value: string,
  options: SecretFileOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;

  if ((options.platform ?? process.platform) === "win32") {
    try {
      await createPrivateSecretFile(tempPath, options);
      await writeFile(tempPath, value, { encoding: "utf8" });
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    verifiedSecretPaths.add(path.toLowerCase());
    return;
  }

  try {
    await writeFile(tempPath, value, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function readSecretFile(
  path: string,
  options: SecretFileOptions = {},
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== "win32") {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (errorCodeOf(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    await ensureSecretFileIsPrivateOnce(path, options);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function deleteSecretFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
