import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readOrCreateSecretFile } from "../src/index.js";
import type { WindowsAclCommandResult } from "../src/windows-acl.js";

interface FileSystemHooks {
  linkAttempts: number;
  linkError?: Error;
  stagedRemovalError?: Error;
  afterRename?: (oldPath: string, newPath: string) => Promise<void>;
}

const hooks = vi.hoisted((): FileSystemHooks => ({ linkAttempts: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (existingPath: string, newPath: string) => {
      hooks.linkAttempts += 1;
      if (hooks.linkError !== undefined) {
        throw hooks.linkError;
      }
      await actual.link(existingPath, newPath);
    },
    rename: async (oldPath: string, newPath: string) => {
      await actual.rename(oldPath, newPath);
      const afterRename = hooks.afterRename;
      if (afterRename !== undefined) {
        hooks.afterRename = undefined;
        await afterRename(oldPath, newPath);
      }
    },
    rm: async (
      target: string,
      options?: { force?: boolean; recursive?: boolean },
    ) => {
      if (hooks.stagedRemovalError !== undefined && target.endsWith(".tmp")) {
        throw hooks.stagedRemovalError;
      }
      await actual.rm(target, options);
    },
  };
});

const USER_SID = "S-1-5-21-3327206002-2370753384-3252136475-1001";
const WHOAMI_CSV = `"\u0418\u043c\u044f","SID"\r\n"omen\\olege","${USER_SID}"\r\n`;
const SUMMARY =
  "\nSuccessfully processed 1 files; Failed processing 0 files\r\n";

const tempDirs: string[] = [];

function createErrnoError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function runFakeAcl(
  command: string,
  args: string[],
): Promise<WindowsAclCommandResult> {
  if (command.endsWith("whoami.exe")) {
    return { stdout: WHOAMI_CSV, stderr: "", exitCode: 0 };
  }
  if (args.length === 1) {
    return {
      stdout: `${args[0]} omen\\olege:(F)\n${SUMMARY}`,
      stderr: "",
      exitCode: 0,
    };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}

async function makeTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bb-win-publish-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function createSecret(dataDir: string): Promise<string> {
  return readOrCreateSecretFile({
    bytes: 32,
    dataDir,
    encoding: "base64",
    fileName: "secret",
    platform: "win32",
    deps: { runCommand: runFakeAcl },
  });
}

afterEach(async () => {
  hooks.linkAttempts = 0;
  hooks.linkError = undefined;
  hooks.stagedRemovalError = undefined;
  hooks.afterRename = undefined;
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => rm(tempDir, { force: true, recursive: true })),
  );
});

describe("publishing a win32 secret", () => {
  it("reports the remedy when the hard link cannot be created", async () => {
    const dataDir = await makeTempDir();
    hooks.linkError = createErrnoError(
      "EPERM",
      "operation not permitted, link",
    );

    await expect(createSecret(dataDir)).rejects.toThrow(
      /Could not publish the secret file[\s\S]*EPERM[\s\S]*NTFS volume/u,
    );
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("keeps the publish failure and names a staged file it could not remove", async () => {
    const dataDir = await makeTempDir();
    hooks.linkError = createErrnoError(
      "EPERM",
      "operation not permitted, link",
    );
    hooks.stagedRemovalError = createErrnoError("EBUSY", "resource busy");

    await expect(createSecret(dataDir)).rejects.toThrow(
      /Could not publish the secret file[\s\S]*staged file[\s\S]*\.tmp[\s\S]*could not be removed[\s\S]*EPERM/u,
    );
    const left = await readdir(dataDir);
    expect(left).toHaveLength(1);
    expect(left[0].endsWith(".tmp")).toBe(true);
  });

  it("keeps a secret another process published while an empty file was repaired", async () => {
    const dataDir = await makeTempDir();
    const secretPath = path.join(dataDir, "secret");
    await writeFile(secretPath, "", "utf8");
    hooks.afterRename = async () => {
      await writeFile(secretPath, "published-by-another-process\n", "utf8");
    };

    await expect(createSecret(dataDir)).resolves.toBe(
      "published-by-another-process",
    );
    expect(await readFile(secretPath, "utf8")).toBe(
      "published-by-another-process\n",
    );
    expect(await readdir(dataDir)).toEqual(["secret"]);
    expect(hooks.linkAttempts).toBe(0);
  });

  it("replaces an empty file and leaves no aside copy behind", async () => {
    const dataDir = await makeTempDir();
    const secretPath = path.join(dataDir, "secret");
    await writeFile(secretPath, "", "utf8");

    const secret = await createSecret(dataDir);

    expect((await readFile(secretPath, "utf8")).trim()).toBe(secret);
    expect(await readdir(dataDir)).toEqual(["secret"]);
  });
});
