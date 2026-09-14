import { describe, expect, it } from "vitest";
import {
  assertSecretFileAclIsPrivate,
  assertSecretFileNameIsSupported,
  createWindowsAclToolRunner,
  parseSecretFileAcl,
  parseWindowsUserCsv,
  readSecretFileAcl,
  resolveCurrentWindowsUser,
  tightenSecretFileAcl,
  type WindowsAclCommandResult,
} from "../src/windows-acl.js";

const USER = {
  accountName: "omen\\olege",
  sid: "S-1-5-21-3327206002-2370753384-3252136475-1001",
};

const SECRET_DIR = "C:\\Users\\olege\\AppData\\Local\\Temp\\bb-acl";
const SECRET_NAME = "secret";
const SECRET_PATH = `${SECRET_DIR}\\${SECRET_NAME}`;
const PAD = " ".repeat(SECRET_NAME.length + 1);
const SUMMARY =
  "\nSuccessfully processed 1 files; Failed processing 0 files\r\n";

const WHOAMI_CSV = `"\u0418\u043c\u044f \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f","SID"\r\n"omen\\olege","${USER.sid}"\r\n`;

interface RecordedCall {
  command: string;
  args: string[];
  cwd: string | undefined;
}

function ok(stdout: string): WindowsAclCommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

describe("parseWindowsUserCsv", () => {
  it("takes the data row and ignores a localized header", () => {
    expect(parseWindowsUserCsv(WHOAMI_CSV)).toEqual(USER);
  });

  it("throws a descriptive error when no SID row is present", () => {
    expect(() => parseWindowsUserCsv('"SID"\r\n')).toThrow(
      /Could not read the current Windows user/u,
    );
  });
});

describe("parseSecretFileAcl", () => {
  it("reads a single tightened ACE and stops at the blank line", () => {
    expect(
      parseSecretFileAcl(
        SECRET_PATH,
        `${SECRET_NAME} OMEN\\olege:(F)\n${SUMMARY}`,
      ),
    ).toEqual([{ identity: "OMEN\\olege", rights: "(F)" }]);
  });

  it("reads indented continuation lines as further ACEs", () => {
    expect(
      parseSecretFileAcl(
        SECRET_PATH,
        `${SECRET_NAME} \u0412\u0441\u0435:(F)\n${PAD}OMEN\\olege:(F)\n${SUMMARY}`,
      ),
    ).toEqual([
      { identity: "\u0412\u0441\u0435", rights: "(F)" },
      { identity: "OMEN\\olege", rights: "(F)" },
    ]);
  });

  it("reads inherited rights and a bare unresolvable SID", () => {
    expect(
      parseSecretFileAcl(
        SECRET_PATH,
        `${SECRET_NAME} OMEN\\CodexSandboxUsers:(I)(M)\n${PAD}S-1-5-21-3069236128-2815927062-1964413744-1774302275:(I)(M)\n${PAD}OMEN\\olege:(I)(F)\n${SUMMARY}`,
      ),
    ).toEqual([
      { identity: "OMEN\\CodexSandboxUsers", rights: "(I)(M)" },
      {
        identity: "S-1-5-21-3069236128-2815927062-1964413744-1774302275",
        rights: "(I)(M)",
      },
      { identity: "OMEN\\olege", rights: "(I)(F)" },
    ]);
  });

  it("throws when the first line does not carry the requested file name", () => {
    expect(() =>
      parseSecretFileAcl(
        SECRET_PATH,
        `${SECRET_PATH} OMEN\\olege:(F)\n${SUMMARY}`,
      ),
    ).toThrow(/Could not parse the permissions/u);
    expect(() =>
      parseSecretFileAcl(SECRET_PATH, `other OMEN\\olege:(F)\n${SUMMARY}`),
    ).toThrow(/Could not parse the permissions/u);
    expect(() => parseSecretFileAcl(SECRET_PATH, "")).toThrow(
      /Could not parse the permissions/u,
    );
  });

  it("refuses a non-ASCII secret file name", () => {
    expect(() =>
      parseSecretFileAcl(
        `${SECRET_DIR}\\\u0441\u0435\u043a\u0440\u0435\u0442`,
        `\u0441\u0435\u043a\u0440\u0435\u0442 OMEN\\olege:(F)\n${SUMMARY}`,
      ),
    ).toThrow(/must use ASCII/u);
  });
});

describe("assertSecretFileAclIsPrivate", () => {
  it("accepts the account name case-insensitively", () => {
    expect(() =>
      assertSecretFileAclIsPrivate(
        SECRET_PATH,
        [{ identity: "OMEN\\OLEGE", rights: "(F)" }],
        USER,
      ),
    ).not.toThrow();
  });

  it("accepts a bare or starred SID identity", () => {
    for (const identity of [USER.sid, `*${USER.sid}`]) {
      expect(() =>
        assertSecretFileAclIsPrivate(
          SECRET_PATH,
          [{ identity, rights: "(F)" }],
          USER,
        ),
      ).not.toThrow();
    }
  });

  it("throws naming the path, the offending identities and the remedy", () => {
    expect(() =>
      assertSecretFileAclIsPrivate(
        SECRET_PATH,
        [
          { identity: "\u0412\u0441\u0435", rights: "(F)" },
          { identity: "OMEN\\olege", rights: "(F)" },
        ],
        USER,
      ),
    ).toThrow(
      new RegExp(
        `${SECRET_PATH.replace(/\\/gu, "\\\\")}[\\s\\S]*\u0412\u0441\u0435:\\(F\\)[\\s\\S]*NTFS volume`,
        "u",
      ),
    );
  });

  it("throws for inherited or partial rights and for a foreign single ACE", () => {
    expect(() =>
      assertSecretFileAclIsPrivate(
        SECRET_PATH,
        [{ identity: "OMEN\\olege", rights: "(OI)(CI)(M)" }],
        USER,
      ),
    ).toThrow(/is not restricted to/u);
    expect(() =>
      assertSecretFileAclIsPrivate(
        SECRET_PATH,
        [{ identity: "OMEN\\CodexSandboxUsers", rights: "(F)" }],
        USER,
      ),
    ).toThrow(/is not restricted to/u);
    expect(() => assertSecretFileAclIsPrivate(SECRET_PATH, [], USER)).toThrow(
      /is not restricted to/u,
    );
  });
});

describe("windows acl commands", () => {
  it("resolves the current user through whoami", async () => {
    const calls: RecordedCall[] = [];
    await expect(
      resolveCurrentWindowsUser({
        runCommand: async (command, args, cwd) => {
          calls.push({ command, args, cwd });
          return ok(WHOAMI_CSV);
        },
      }),
    ).resolves.toEqual(USER);
    expect(calls).toHaveLength(1);
    expect(calls[0].command.endsWith("whoami.exe")).toBe(true);
    expect(calls[0].args).toEqual(["/user", "/fo", "csv"]);
    expect(calls[0].cwd).toBeUndefined();
  });

  it("throws when whoami fails", async () => {
    await expect(
      resolveCurrentWindowsUser({
        runCommand: async () => ({
          stdout: "",
          stderr: "Access is denied.",
          exitCode: 1,
        }),
      }),
    ).rejects.toThrow(
      /Could not determine the current Windows user[\s\S]*denied/u,
    );
  });

  it("grants full control to the user's SID from the secret's directory", async () => {
    const calls: RecordedCall[] = [];
    await tightenSecretFileAcl(SECRET_PATH, USER, {
      runCommand: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return ok("");
      },
    });
    expect(calls[0].command.endsWith("icacls.exe")).toBe(true);
    expect(calls[0].cwd).toBe(SECRET_DIR);
    expect(calls[0].args).toEqual([
      SECRET_NAME,
      "/inheritance:r",
      "/grant:r",
      `*${USER.sid}:F`,
    ]);
  });

  it("names the path and the remedy when icacls fails", async () => {
    const failing = async (): Promise<WindowsAclCommandResult> => ({
      stdout: "",
      stderr: `${SECRET_PATH}: The system cannot find the file specified.`,
      exitCode: 2,
    });
    await expect(
      tightenSecretFileAcl(SECRET_PATH, USER, { runCommand: failing }),
    ).rejects.toThrow(/bb-acl\\secret[\s\S]*NTFS volume/u);
    await expect(
      readSecretFileAcl(SECRET_PATH, { runCommand: failing }),
    ).rejects.toThrow(/bb-acl\\secret[\s\S]*NTFS volume/u);
  });

  it("reads the ACEs back through icacls from the secret's directory", async () => {
    const calls: RecordedCall[] = [];
    await expect(
      readSecretFileAcl(SECRET_PATH, {
        runCommand: async (command, args, cwd) => {
          calls.push({ command, args, cwd });
          return ok(`${SECRET_NAME} OMEN\\olege:(F)\n${SUMMARY}`);
        },
      }),
    ).resolves.toEqual([{ identity: "OMEN\\olege", rights: "(F)" }]);
    expect(calls[0].cwd).toBe(SECRET_DIR);
    expect(calls[0].args).toEqual([SECRET_NAME]);
  });

  it("refuses a non-ASCII secret file name before spawning anything", async () => {
    const calls: RecordedCall[] = [];
    const runCommand = async (
      command: string,
      args: string[],
      cwd?: string,
    ): Promise<WindowsAclCommandResult> => {
      calls.push({ command, args, cwd });
      return ok("");
    };
    const cyrillicPath = `${SECRET_DIR}\\\u0441\u0435\u043a\u0440\u0435\u0442`;

    await expect(
      tightenSecretFileAcl(cyrillicPath, USER, { runCommand }),
    ).rejects.toThrow(
      /\u0441\u0435\u043a\u0440\u0435\u0442[\s\S]*must use ASCII/u,
    );
    await expect(
      readSecretFileAcl(cyrillicPath, { runCommand }),
    ).rejects.toThrow(
      /\u0441\u0435\u043a\u0440\u0435\u0442[\s\S]*must use ASCII/u,
    );
    expect(calls).toEqual([]);
  });
});

describe("assertSecretFileNameIsSupported", () => {
  it("accepts the names bb actually uses", () => {
    for (const name of [
      "secret",
      "auth-secret",
      "http-token",
      "apiKey",
      "secret.a1b2c3d4e5f6.tmp",
      "secret.a1b2c3d4e5f6.empty",
    ]) {
      expect(() =>
        assertSecretFileNameIsSupported(`${SECRET_DIR}\\${name}`),
      ).not.toThrow();
    }
  });

  it("refuses traversal, wildcards, separators and non-ASCII names", () => {
    for (const name of [
      "..",
      ".",
      "a b",
      "*",
      "?",
      "se:cret",
      "\u0441\u0435\u043a\u0440\u0435\u0442",
    ]) {
      expect(() =>
        assertSecretFileNameIsSupported(`${SECRET_DIR}\\${name}`),
      ).toThrow(/must use ASCII/u);
    }
  });
});

describe("windows acl tool runner", () => {
  it("kills the tool and fails closed when it never exits", async () => {
    const spawned: Array<{
      command: string;
      args: string[];
      cwd: string | undefined;
    }> = [];
    const kills: string[] = [];
    const run = createWindowsAclToolRunner({
      timeoutMs: 5,
      spawn: (command, args, cwd) => {
        spawned.push({ command, args, cwd });
        return {
          output: new Promise<WindowsAclCommandResult>(() => {}),
          kill: () => {
            kills.push("SIGKILL");
          },
        };
      },
    });

    await expect(
      run("C:\\Windows\\System32\\icacls.exe", [SECRET_NAME], SECRET_DIR),
    ).rejects.toThrow(
      /Timed out after 5ms[\s\S]*icacls\.exe[\s\S]*NTFS volume/u,
    );
    expect(kills).toEqual(["SIGKILL"]);
    expect(spawned).toEqual([
      {
        command: "C:\\Windows\\System32\\icacls.exe",
        args: [SECRET_NAME],
        cwd: SECRET_DIR,
      },
    ]);
  });

  it("returns the tool output and never kills a tool that exits", async () => {
    const kills: string[] = [];
    const run = createWindowsAclToolRunner({
      timeoutMs: 5_000,
      spawn: () => ({
        output: Promise.resolve({
          stdout: `${SECRET_NAME} OMEN\\olege:(F)`,
          stderr: "",
          exitCode: 0,
        }),
        kill: () => {
          kills.push("SIGKILL");
        },
      }),
    });

    await expect(
      run("C:\\Windows\\System32\\icacls.exe", [SECRET_NAME], SECRET_DIR),
    ).resolves.toEqual({
      stdout: `${SECRET_NAME} OMEN\\olege:(F)`,
      stderr: "",
      exitCode: 0,
    });
    expect(kills).toEqual([]);
  });

  it("propagates a spawn failure without a timeout message", async () => {
    const run = createWindowsAclToolRunner({
      timeoutMs: 5_000,
      spawn: () => ({
        output: Promise.reject(new Error("spawn ENOENT")),
        kill: () => {},
      }),
    });

    await expect(run("icacls.exe", [SECRET_NAME])).rejects.toThrow(
      "spawn ENOENT",
    );
  });
});
