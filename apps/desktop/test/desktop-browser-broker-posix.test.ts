import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it } from "vitest";
import { readBrokerDescriptor } from "../src/desktop-browser-broker-client.js";

const directories: string[] = [];
const descriptor = {
  hostId: "host-1",
  serverUrl: "https://bb.example",
  token: "a".repeat(64),
  url: "ws://127.0.0.1:38887/desktop-browser",
  version: 1,
};

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-desktop-broker-posix-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe.runIf(process.platform !== "win32")(
  "POSIX desktop broker descriptor",
  () => {
    it("reads a regular current-user descriptor with private mode", async () => {
      const directory = await makeDirectory();
      await writeFile(
        join(directory, DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE),
        JSON.stringify(descriptor),
        {
          mode: 0o600,
        },
      );
      await expect(readBrokerDescriptor(directory)).resolves.toEqual(
        descriptor,
      );
    });

    it("rejects public mode, a symlink, a directory and an oversized descriptor", async () => {
      const directory = await makeDirectory();
      const path = join(directory, DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE);
      await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
      await chmod(path, 0o644);
      await expect(readBrokerDescriptor(directory)).rejects.toThrow(
        "permissions",
      );
      await rm(path);
      await writeFile(`${path}.target`, JSON.stringify(descriptor), {
        mode: 0o600,
      });
      await symlink(`${path}.target`, path);
      await expect(readBrokerDescriptor(directory)).rejects.toThrow();
      await rm(path);
      await mkdir(path);
      await expect(readBrokerDescriptor(directory)).rejects.toThrow(
        "permissions",
      );
      await rm(path, { recursive: true });
      await writeFile(path, "x".repeat(16_385), { mode: 0o600 });
      await expect(readBrokerDescriptor(directory)).rejects.toThrow(
        "permissions",
      );
    });
  },
);
