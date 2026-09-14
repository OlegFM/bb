import { describe, expect, it } from "vitest";
import {
  assertSecretFileAclIsPrivate,
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

const SECRET_PATH = "C:\\Users\\olege\\AppData\\Local\\Temp\\bb-acl\\secret";
const PAD = " ".repeat(SECRET_PATH.length + 1);
const SUMMARY =
  "\nSuccessfully processed 1 files; Failed processing 0 files\r\n";

const WHOAMI_CSV = `"\u0418\u043c\u044f \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f","SID"\r\n"omen\\olege","${USER.sid}"\r\n`;

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
        `${SECRET_PATH} OMEN\\olege:(F)\n${SUMMARY}`,
      ),
    ).toEqual([{ identity: "OMEN\\olege", rights: "(F)" }]);
  });

  it("reads indented continuation lines as further ACEs", () => {
    expect(
      parseSecretFileAcl(
        SECRET_PATH,
        `${SECRET_PATH} \u0412\u0441\u0435:(F)\n${PAD}OMEN\\olege:(F)\n${SUMMARY}`,
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
        `${SECRET_PATH} OMEN\\CodexSandboxUsers:(I)(M)\n${PAD}S-1-5-21-3069236128-2815927062-1964413744-1774302275:(I)(M)\n${PAD}OMEN\\olege:(I)(F)\n${SUMMARY}`,
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

  it("throws when the first line does not carry the requested path", () => {
    expect(() =>
      parseSecretFileAcl(SECRET_PATH, `C:\\other OMEN\\olege:(F)\n${SUMMARY}`),
    ).toThrow(/Could not parse the permissions/u);
    expect(() => parseSecretFileAcl(SECRET_PATH, "")).toThrow(
      /Could not parse the permissions/u,
    );
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
    const calls: Array<{ command: string; args: string[] }> = [];
    await expect(
      resolveCurrentWindowsUser({
        runCommand: async (command, args) => {
          calls.push({ command, args });
          return ok(WHOAMI_CSV);
        },
      }),
    ).resolves.toEqual(USER);
    expect(calls).toHaveLength(1);
    expect(calls[0].command.endsWith("whoami.exe")).toBe(true);
    expect(calls[0].args).toEqual(["/user", "/fo", "csv"]);
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

  it("grants full control to the user's SID and nothing else", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await tightenSecretFileAcl(SECRET_PATH, USER, {
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return ok("");
      },
    });
    expect(calls[0].command.endsWith("icacls.exe")).toBe(true);
    expect(calls[0].args).toEqual([
      SECRET_PATH,
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

  it("reads the ACEs back through icacls", async () => {
    await expect(
      readSecretFileAcl(SECRET_PATH, {
        runCommand: async () =>
          ok(`${SECRET_PATH} OMEN\\olege:(F)\n${SUMMARY}`),
      }),
    ).resolves.toEqual([{ identity: "OMEN\\olege", rights: "(F)" }]);
  });
});
