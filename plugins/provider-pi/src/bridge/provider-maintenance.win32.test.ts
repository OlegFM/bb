import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probePiVersion } from "./provider-maintenance.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeEmptyBinDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-pi-probe-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("probePiVersion", () => {
  it("reports why Windows cannot start the probe instead of an ENOENT", async () => {
    const binDirectory = makeEmptyBinDirectory();

    await expect(
      probePiVersion({
        platform: "win32",
        env: { Path: binDirectory, PATHEXT: ".EXE;.CMD" },
      }),
    ).resolves.toEqual({
      version: null,
      failure: "`pi --version` Command pi was not found on Path",
    });
  });

  it("leaves the posix probe on the bare command", async () => {
    const probe = await probePiVersion({
      platform: "linux",
      env: { PATH: makeEmptyBinDirectory() },
    });

    expect(probe.version).toBe(null);
    expect(probe.failure).toMatch(/^`pi --version` /u);
    expect(probe.failure).not.toContain("was not found on Path");
  });
});
