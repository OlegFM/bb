import { randomUUID } from "node:crypto";
import { link, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureSecretFileIsPrivate } from "@bb/secret-storage";

export async function openPrivateOutput(path: string): Promise<FileHandle> {
  if (process.platform !== "win32") return open(path, "wx", 0o600);
  const stagedPath = join(dirname(path), `.bb-output-${randomUUID()}.tmp`);
  const handle = await open(stagedPath, "wx", 0o600);
  let published = false;
  try {
    await ensureSecretFileIsPrivate(stagedPath);
    await link(stagedPath, path);
    published = true;
    await rm(stagedPath);
    return handle;
  } catch (error) {
    await handle.close();
    if (published) await rm(path, { force: true });
    await rm(stagedPath, { force: true });
    throw error;
  }
}

export async function writeNewPrivateOutput(
  path: string,
  text: string,
): Promise<void> {
  const handle = await openPrivateOutput(path);
  try {
    await handle.writeFile(text, "utf8");
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}
