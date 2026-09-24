import { randomUUID } from "node:crypto";
import { link, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import {
  assertSecretFileAclIsPrivate,
  readSecretFileAcl,
  resolveCurrentWindowsUser,
} from "@bb/secret-storage";

export async function expectPrivateFile(path: string): Promise<void> {
  if (process.platform === "win32") {
    const alias = join(dirname(path), `.acl-check-${randomUUID()}`);
    await link(path, alias);
    try {
      assertSecretFileAclIsPrivate(
        alias,
        await readSecretFileAcl(alias),
        await resolveCurrentWindowsUser(),
      );
    } finally {
      await rm(alias);
    }
  } else {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
}
