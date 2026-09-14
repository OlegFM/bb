import { execFile } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveWindowsSystemToolPath } from "@bb/process-utils";
import { afterEach, describe, expect, it } from "vitest";
import {
  readOrCreateSecretFile,
  readSecretFile,
  writeSecretFile,
} from "../src/index.js";
import {
  assertSecretFileAclIsPrivate,
  readSecretFileAcl,
  resolveCurrentWindowsUser,
  type WindowsAclCommandResult,
} from "../src/windows-acl.js";

const USER_SID = "S-1-5-21-3327206002-2370753384-3252136475-1001";
const WHOAMI_CSV = `"\u0418\u043c\u044f","SID"\r\n"omen\\olege","${USER_SID}"\r\n`;
const SUMMARY =
  "\nSuccessfully processed 1 files; Failed processing 0 files\r\n";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bb-win-secret-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => rm(tempDir, { force: true, recursive: true })),
  );
});

interface RecordedAclCall {
  command: string;
  args: string[];
  sizeAtCall: number;
}

function createFakeWindowsAcl(aclOutput?: (target: string) => string): {
  calls: RecordedAclCall[];
  runCommand: (
    command: string,
    args: string[],
  ) => Promise<WindowsAclCommandResult>;
} {
  const calls: RecordedAclCall[] = [];
  return {
    calls,
    runCommand: async (command, args) => {
      const target = args.length > 0 ? args[0] : "";
      let sizeAtCall = -1;
      try {
        sizeAtCall = (await stat(target)).size;
      } catch {}
      calls.push({ command, args, sizeAtCall });
      if (command.endsWith("whoami.exe")) {
        return { stdout: WHOAMI_CSV, stderr: "", exitCode: 0 };
      }
      if (args.length === 1) {
        return {
          stdout:
            aclOutput?.(target) ?? `${target} omen\\olege:(F)\n${SUMMARY}`,
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

function everyoneAcl(target: string): string {
  return `${target} \u0412\u0441\u0435:(F)\n${" ".repeat(target.length + 1)}omen\\olege:(F)\n${SUMMARY}`;
}

describe("secret files on win32 (injected runner)", () => {
  it("creates the file empty, tightens it, and only then writes the bytes", async () => {
    const dataDir = await makeTempDir();
    const acl = createFakeWindowsAcl();

    const secret = await readOrCreateSecretFile({
      bytes: 32,
      dataDir,
      encoding: "base64",
      fileName: "secret",
      platform: "win32",
      deps: { runCommand: acl.runCommand },
    });

    const secretPath = path.join(dataDir, "secret");
    expect((await readFile(secretPath, "utf8")).trim()).toBe(secret);
    const grant = acl.calls.find((call) =>
      call.args.includes("/inheritance:r"),
    );
    const verify = acl.calls.find(
      (call) => call.args.length === 1 && call.args[0] === secretPath,
    );
    expect(grant?.args).toEqual([
      secretPath,
      "/inheritance:r",
      "/grant:r",
      `*${USER_SID}:F`,
    ]);
    expect(grant?.sizeAtCall).toBe(0);
    expect(verify?.sizeAtCall).toBe(0);
  });

  it("removes the file it created when verification fails", async () => {
    const dataDir = await makeTempDir();
    const acl = createFakeWindowsAcl(everyoneAcl);

    await expect(
      readOrCreateSecretFile({
        bytes: 32,
        dataDir,
        encoding: "base64",
        fileName: "secret",
        platform: "win32",
        deps: { runCommand: acl.runCommand },
      }),
    ).rejects.toThrow(/is not restricted to/u);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("tightens the temp file before writing and renames it into place", async () => {
    const dir = await makeTempDir();
    const secretPath = path.join(dir, "token");
    const acl = createFakeWindowsAcl();

    await writeSecretFile(secretPath, "xoxb-123", {
      platform: "win32",
      deps: { runCommand: acl.runCommand },
    });

    expect(await readFile(secretPath, "utf8")).toBe("xoxb-123");
    expect(await readdir(dir)).toEqual(["token"]);
    const grant = acl.calls.find((call) =>
      call.args.includes("/inheritance:r"),
    );
    expect(grant?.args[0].endsWith(".tmp")).toBe(true);
    expect(grant?.sizeAtCall).toBe(0);
  });

  it("leaves no temp file behind when verification fails", async () => {
    const dir = await makeTempDir();
    const acl = createFakeWindowsAcl(everyoneAcl);

    await expect(
      writeSecretFile(path.join(dir, "token"), "xoxb-123", {
        platform: "win32",
        deps: { runCommand: acl.runCommand },
      }),
    ).rejects.toThrow(/is not restricted to/u);
    expect(await readdir(dir)).toEqual([]);
  });

  it("returns undefined for a missing secret without running icacls", async () => {
    const dir = await makeTempDir();
    const acl = createFakeWindowsAcl();

    await expect(
      readSecretFile(path.join(dir, "missing"), {
        platform: "win32",
        deps: { runCommand: acl.runCommand },
      }),
    ).resolves.toBeUndefined();
    expect(acl.calls).toEqual([]);
  });

  it("tightens an existing secret before handing back its content", async () => {
    const dir = await makeTempDir();
    const secretPath = path.join(dir, "token");
    await writeFile(secretPath, "xoxb-123", "utf8");
    const acl = createFakeWindowsAcl();

    await expect(
      readSecretFile(secretPath, {
        platform: "win32",
        deps: { runCommand: acl.runCommand },
      }),
    ).resolves.toBe("xoxb-123");
    expect(acl.calls.some((call) => call.args.includes("/inheritance:r"))).toBe(
      true,
    );
  });

  it("never runs icacls on the POSIX arm", async () => {
    const dir = await makeTempDir();
    const secretPath = path.join(dir, "token");
    const acl = createFakeWindowsAcl();

    await writeSecretFile(secretPath, "xoxb-123", {
      platform: "linux",
      deps: { runCommand: acl.runCommand },
    });
    await expect(
      readSecretFile(secretPath, {
        platform: "linux",
        deps: { runCommand: acl.runCommand },
      }),
    ).resolves.toBe("xoxb-123");
    await readOrCreateSecretFile({
      bytes: 8,
      dataDir: dir,
      encoding: "hex",
      fileName: "generated",
      platform: "linux",
      deps: { runCommand: acl.runCommand },
    });
    expect(acl.calls).toEqual([]);
  });
});

const runTool = promisify(execFile);

describe("secret files on real NTFS", () => {
  it.runIf(process.platform === "win32")(
    "creates a secret whose only ACE grants the current user full control",
    async () => {
      const dataDir = await makeTempDir();
      const secret = await readOrCreateSecretFile({
        bytes: 32,
        dataDir,
        encoding: "base64",
        fileName: "secret",
      });
      const secretPath = path.join(dataDir, "secret");
      expect((await readFile(secretPath, "utf8")).trim()).toBe(secret);

      const user = await resolveCurrentWindowsUser();
      const aces = await readSecretFileAcl(secretPath);
      expect(aces).toHaveLength(1);
      expect(() =>
        assertSecretFileAclIsPrivate(secretPath, aces, user),
      ).not.toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "writes a secret through a tightened temp file and leaves nothing behind",
    async () => {
      const dir = await makeTempDir();
      const secretPath = path.join(dir, "with space", "token");
      await writeSecretFile(secretPath, "xoxb-123");

      expect(await readFile(secretPath, "utf8")).toBe("xoxb-123");
      expect(await readdir(path.dirname(secretPath))).toEqual(["token"]);
      const user = await resolveCurrentWindowsUser();
      const aces = await readSecretFileAcl(secretPath);
      expect(aces).toHaveLength(1);
      expect(() =>
        assertSecretFileAclIsPrivate(secretPath, aces, user),
      ).not.toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "tightens an inherited ACL on the first read of an existing secret",
    async () => {
      const dataDir = await makeTempDir();
      const secretPath = path.join(dataDir, "secret");
      await writeFile(secretPath, "inherited-secret\n", "utf8");

      const before = await readSecretFileAcl(secretPath);
      expect(before.some((ace) => ace.rights.includes("(I)"))).toBe(true);

      await expect(
        readOrCreateSecretFile({
          bytes: 32,
          dataDir,
          encoding: "base64",
          fileName: "secret",
        }),
      ).resolves.toBe("inherited-secret");

      const user = await resolveCurrentWindowsUser();
      const after = await readSecretFileAcl(secretPath);
      expect(after).toHaveLength(1);
      expect(() =>
        assertSecretFileAclIsPrivate(secretPath, after, user),
      ).not.toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "refuses to hand back a secret that icacls cannot take away from Everyone",
    async () => {
      const dataDir = await makeTempDir();
      const secretPath = path.join(dataDir, "secret");
      await writeFile(secretPath, "shared-secret\n", "utf8");
      await runTool(
        resolveWindowsSystemToolPath("icacls.exe"),
        [secretPath, "/grant", "*S-1-1-0:F"],
        { windowsHide: true },
      );

      await expect(
        readOrCreateSecretFile({
          bytes: 32,
          dataDir,
          encoding: "base64",
          fileName: "secret",
        }),
      ).rejects.toThrow(/is not restricted to[\s\S]*NTFS volume/u);
      expect(await readFile(secretPath, "utf8")).toBe("shared-secret\n");
      expect((await readSecretFileAcl(secretPath)).length).toBeGreaterThan(1);
    },
  );
});
