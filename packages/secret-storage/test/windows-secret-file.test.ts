import { execFile } from "node:child_process";
import {
  mkdir,
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
  cwd: string | undefined;
  sizeAtCall: number;
}

function createFakeWindowsAcl(aclOutput?: (target: string) => string): {
  calls: RecordedAclCall[];
  runCommand: (
    command: string,
    args: string[],
    cwd?: string,
  ) => Promise<WindowsAclCommandResult>;
} {
  const calls: RecordedAclCall[] = [];
  return {
    calls,
    runCommand: async (command, args, cwd) => {
      const target = args.length > 0 ? args[0] : "";
      let sizeAtCall = -1;
      try {
        sizeAtCall = (
          await stat(cwd === undefined ? target : path.join(cwd, target))
        ).size;
      } catch {}
      calls.push({ command, args, cwd, sizeAtCall });
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
  it("tightens a staged file, writes it, and links it into place", async () => {
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
    expect(await readdir(dataDir)).toEqual(["secret"]);
    const grant = acl.calls.find((call) =>
      call.args.includes("/inheritance:r"),
    );
    const stagedName = grant?.args[0] ?? "";
    expect(stagedName.startsWith("secret.")).toBe(true);
    expect(stagedName.endsWith(".tmp")).toBe(true);
    expect(grant?.cwd).toBe(dataDir);
    expect(grant?.args.slice(1)).toEqual([
      "/inheritance:r",
      "/grant:r",
      `*${USER_SID}:F`,
    ]);
    expect(grant?.sizeAtCall).toBe(0);
    const verify = acl.calls.find(
      (call) => call.args.length === 1 && call.args[0] === stagedName,
    );
    expect(verify?.sizeAtCall).toBe(0);
    expect(acl.calls.some((call) => call.args[0] === "secret")).toBe(false);
  });

  it("removes the staged file and creates nothing when verification fails", async () => {
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

  it("replaces a wedged empty secret file", async () => {
    const dataDir = await makeTempDir();
    const secretPath = path.join(dataDir, "secret");
    await writeFile(secretPath, "", "utf8");
    const acl = createFakeWindowsAcl();

    const secret = await readOrCreateSecretFile({
      bytes: 32,
      dataDir,
      encoding: "base64",
      fileName: "secret",
      platform: "win32",
      deps: { runCommand: acl.runCommand },
    });

    expect((await readFile(secretPath, "utf8")).trim()).toBe(secret);
    expect(await readdir(dataDir)).toEqual(["secret"]);
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
    expect(grant?.cwd).toBe(dir);
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

  it("refuses an unsupported secret file name before creating or spawning anything", async () => {
    const dataDir = await makeTempDir();
    const acl = createFakeWindowsAcl();

    await expect(
      readOrCreateSecretFile({
        bytes: 32,
        dataDir,
        encoding: "base64",
        fileName: "se cret",
        platform: "win32",
        deps: { runCommand: acl.runCommand },
      }),
    ).rejects.toThrow(/must use ASCII/u);
    await expect(
      writeSecretFile(path.join(dataDir, "to ken"), "xoxb-123", {
        platform: "win32",
        deps: { runCommand: acl.runCommand },
      }),
    ).rejects.toThrow(/must use ASCII/u);
    expect(acl.calls).toEqual([]);
    expect(await readdir(dataDir)).toEqual([]);
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
      expect(await readdir(dataDir)).toEqual(["secret"]);

      const user = await resolveCurrentWindowsUser();
      const aces = await readSecretFileAcl(secretPath);
      expect(aces).toHaveLength(1);
      expect(() =>
        assertSecretFileAclIsPrivate(secretPath, aces, user),
      ).not.toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "returns the same secret to two concurrent creators",
    async () => {
      const dataDir = await makeTempDir();
      const [first, second] = await Promise.all([
        readOrCreateSecretFile({
          bytes: 32,
          dataDir,
          encoding: "base64",
          fileName: "secret",
        }),
        readOrCreateSecretFile({
          bytes: 32,
          dataDir,
          encoding: "base64",
          fileName: "secret",
        }),
      ]);

      expect(second).toBe(first);
      const secretPath = path.join(dataDir, "secret");
      expect((await readFile(secretPath, "utf8")).trim()).toBe(first);
      expect(await readdir(dataDir)).toEqual(["secret"]);

      const user = await resolveCurrentWindowsUser();
      const aces = await readSecretFileAcl(secretPath);
      expect(aces).toHaveLength(1);
      expect(() =>
        assertSecretFileAclIsPrivate(secretPath, aces, user),
      ).not.toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "repairs a secret file left empty by an earlier crash",
    async () => {
      const dataDir = await makeTempDir();
      const secretPath = path.join(dataDir, "secret");
      await writeFile(secretPath, "", "utf8");

      const secret = await readOrCreateSecretFile({
        bytes: 32,
        dataDir,
        encoding: "base64",
        fileName: "secret",
      });

      expect((await readFile(secretPath, "utf8")).trim()).toBe(secret);
      expect(await readdir(dataDir)).toEqual(["secret"]);
      const user = await resolveCurrentWindowsUser();
      const aces = await readSecretFileAcl(secretPath);
      expect(aces).toHaveLength(1);
      expect(() =>
        assertSecretFileAclIsPrivate(secretPath, aces, user),
      ).not.toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "secures secrets inside a directory whose name is not ASCII",
    async () => {
      const dataDir = path.join(
        await makeTempDir(),
        "\u041e\u043b\u0435\u0433 \u043a\u0430\u0442\u0430\u043b\u043e\u0433",
      );
      await mkdir(dataDir, { recursive: true });
      const user = await resolveCurrentWindowsUser();

      const secret = await readOrCreateSecretFile({
        bytes: 32,
        dataDir,
        encoding: "base64",
        fileName: "secret",
      });
      const secretPath = path.join(dataDir, "secret");
      expect((await readFile(secretPath, "utf8")).trim()).toBe(secret);
      const created = await readSecretFileAcl(secretPath);
      expect(created).toHaveLength(1);
      expect(() =>
        assertSecretFileAclIsPrivate(secretPath, created, user),
      ).not.toThrow();

      const inheritedPath = path.join(dataDir, "inherited");
      await writeFile(inheritedPath, "inherited-secret\n", "utf8");
      const before = await readSecretFileAcl(inheritedPath);
      expect(before.some((ace) => ace.rights.includes("(I)"))).toBe(true);

      await expect(readSecretFile(inheritedPath)).resolves.toBe(
        "inherited-secret\n",
      );
      const after = await readSecretFileAcl(inheritedPath);
      expect(after).toHaveLength(1);
      expect(() =>
        assertSecretFileAclIsPrivate(inheritedPath, after, user),
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
