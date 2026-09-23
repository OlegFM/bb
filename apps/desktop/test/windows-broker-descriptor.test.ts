import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveWindowsSystemToolPath } from "@bb/process-utils";
import { writeSecretFile } from "@bb/secret-storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWindowsBrokerDescriptorSecurity,
  readWindowsBrokerDescriptor,
} from "../src/windows-broker-descriptor.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function descriptorPath(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "bb-windows-broker-descriptor-"),
  );
  directories.push(directory);
  return join(directory, "desktop-browser-broker.json");
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Windows broker descriptor trust", () => {
  const sid = "S-1-5-21-100-200-300-1001";
  const privateSecurity = {
    aces: [
      {
        accessType: "Allow",
        identity: sid,
        inherited: false,
        inheritanceFlags: "None",
        propagationFlags: "None",
        rights: "FullControl",
      },
    ],
    contentBase64: "e30=",
    currentSid: sid,
    ownerSid: sid,
    protected: true,
  };

  it("rejects a descriptor controlled by a foreign owner despite a private read ACE", () => {
    expect(() =>
      assertWindowsBrokerDescriptorSecurity({
        ...privateSecurity,
        ownerSid: "S-1-5-21-100-200-300-2002",
      }),
    ).toThrow("permissions");
    expect(() =>
      assertWindowsBrokerDescriptorSecurity(privateSecurity),
    ).not.toThrow();
  });

  it("rejects inherited, broad and partial access", () => {
    for (const security of [
      { ...privateSecurity, protected: false },
      {
        ...privateSecurity,
        aces: [
          ...privateSecurity.aces,
          { ...privateSecurity.aces[0], identity: "S-1-1-0" },
        ],
      },
      {
        ...privateSecurity,
        aces: [{ ...privateSecurity.aces[0], rights: "Read" }],
      },
    ]) {
      expect(() => assertWindowsBrokerDescriptorSecurity(security)).toThrow(
        "permissions",
      );
    }
  });
});

describe.runIf(process.platform === "win32")(
  "native Windows broker descriptor",
  () => {
    it("reads a privately published descriptor from its secured handle", async () => {
      const path = await descriptorPath();
      await writeSecretFile(path, '{"token":"private"}');
      await expect(readWindowsBrokerDescriptor(path)).resolves.toBe(
        '{"token":"private"}',
      );
    });

    it("rejects a descriptor with an extra Everyone ACE", async () => {
      const path = await descriptorPath();
      await writeSecretFile(path, '{"token":"private"}');
      await execFileAsync(resolveWindowsSystemToolPath("icacls.exe"), [
        path,
        "/grant",
        "*S-1-1-0:R",
      ]);
      await expect(readWindowsBrokerDescriptor(path)).rejects.toThrow(
        "permissions",
      );
    });

    it("rejects an unsafe replacement of a previously private descriptor", async () => {
      const path = await descriptorPath();
      await writeSecretFile(path, '{"token":"private"}');
      await rename(path, `${path}.old`);
      await writeFile(path, '{"token":"replaced"}');
      await expect(readWindowsBrokerDescriptor(path)).rejects.toThrow(
        "permissions",
      );
    });

    it("rejects a reparse point even when its target is private", async () => {
      const path = await descriptorPath();
      await writeSecretFile(`${path}.target`, '{"token":"private"}');
      await symlink(`${path}.target`, path, "file");
      await expect(readWindowsBrokerDescriptor(path)).rejects.toThrow(
        "permissions",
      );
    });
  },
);
