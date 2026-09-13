import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeHostPath,
  canonicalizeHostPathCommand,
} from "./canonicalize-path.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function directoryStat() {
  return async () => ({ isDirectory: () => true });
}

describe("canonicalizeHostPath", () => {
  it("normalizes a Windows path resolved by the host", async () => {
    await expect(
      canonicalizeHostPath({
        path: "c:/work/bb/",
        platform: "win32",
        realpath: async () => "C:\\Work\\bb",
        stat: directoryStat(),
      }),
    ).resolves.toEqual({ path: "C:\\Work\\bb", pathKey: "c:/work/bb" });
  });

  it("strips the extended-length prefix the native realpath may return", async () => {
    await expect(
      canonicalizeHostPath({
        path: "C:\\Work\\bb",
        platform: "win32",
        realpath: async () => "\\\\?\\C:\\Work\\bb\\",
        stat: directoryStat(),
      }),
    ).resolves.toEqual({ path: "C:\\Work\\bb", pathKey: "c:/work/bb" });
  });

  it("rejects UNC, device and relative input on Windows", async () => {
    for (const input of [
      "\\\\server\\share\\bb",
      "\\\\?\\C:\\bb",
      "//server/share",
      "bb\\repo",
      "/srv/bb",
      "C:",
      "c:",
    ]) {
      await expect(
        canonicalizeHostPath({
          path: input,
          platform: "win32",
          realpath: async () => input,
          stat: directoryStat(),
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
    }
  });

  it("rejects a Windows path that resolves onto a network share", async () => {
    await expect(
      canonicalizeHostPath({
        path: "Z:\\repo",
        platform: "win32",
        realpath: async () => "\\\\?\\UNC\\server\\share\\repo",
        stat: directoryStat(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("not a drive-letter path"),
    });
  });

  it("keeps POSIX paths and keys identical after realpath", async () => {
    await expect(
      canonicalizeHostPath({
        path: "/home/me/link/",
        platform: "linux",
        realpath: async () => "/home/me/repo",
        stat: directoryStat(),
      }),
    ).resolves.toEqual({ path: "/home/me/repo", pathKey: "/home/me/repo" });
  });

  it("rejects relative and Windows input on POSIX", async () => {
    for (const input of ["repo", "C:\\repo"]) {
      await expect(
        canonicalizeHostPath({
          path: input,
          platform: "linux",
          realpath: async () => input,
          stat: directoryStat(),
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
    }
  });

  it("rejects UNC-shaped input on POSIX with the POSIX message", async () => {
    await expect(
      canonicalizeHostPath({
        path: "//srv/x",
        platform: "linux",
        realpath: async () => "//srv/x",
        stat: directoryStat(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("must be an absolute path"),
    });
  });

  it("rejects missing paths and files", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    await expect(
      canonicalizeHostPath({
        path: "/srv/missing",
        platform: "linux",
        realpath: async () => "/srv/missing",
        stat: async () => {
          throw missing;
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("does not exist"),
    });
    await expect(
      canonicalizeHostPath({
        path: "/srv/file.txt",
        platform: "linux",
        realpath: async () => "/srv/file.txt",
        stat: async () => ({ isDirectory: () => false }),
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("not a directory"),
    });
  });

  it("reports a path segment that is a file as not a directory", async () => {
    const notADirectory = Object.assign(new Error("not a directory"), {
      code: "ENOTDIR",
    });
    await expect(
      canonicalizeHostPath({
        path: "/srv/file.txt/sub",
        platform: "linux",
        realpath: async () => "/srv/file.txt/sub",
        stat: async () => {
          throw notADirectory;
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("not a directory"),
    });
  });

  it("propagates stat errors other than ENOENT and ENOTDIR unchanged", async () => {
    const forbidden = Object.assign(new Error("forbidden"), {
      code: "EACCES",
    });
    await expect(
      canonicalizeHostPath({
        path: "/srv/protected",
        platform: "linux",
        realpath: async () => "/srv/protected",
        stat: async () => {
          throw forbidden;
        },
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("canonicalizeHostPathCommand", () => {
  it("resolves a real directory on this host", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-canonical-"));
    tempDirs.push(root);
    const target = path.join(root, "Mixed Case");
    await fs.mkdir(target);
    const expected = await fs.realpath(target);
    const result = await canonicalizeHostPathCommand({
      type: "host.canonicalize_path",
      path: `${target}${path.sep}`,
    });
    expect(result.path.toLowerCase()).toBe(expected.toLowerCase());
    expect(result.pathKey).toBe(
      process.platform === "win32"
        ? result.path.replace(/\\/gu, "/").toLowerCase()
        : result.path,
    );
  });

  it.runIf(process.platform === "win32")(
    "restores the on-disk casing of a lowercased Windows path",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-canonical-"));
      tempDirs.push(root);
      const target = path.join(root, "CamelCase");
      await fs.mkdir(target);
      const result = await canonicalizeHostPathCommand({
        type: "host.canonicalize_path",
        path: target.toLowerCase().replace(/\\/gu, "/"),
      });
      expect(result.path.endsWith("\\CamelCase")).toBe(true);
      expect(result.path.startsWith("\\\\?\\")).toBe(false);
      expect(result.pathKey).toBe(
        result.path.replace(/\\/gu, "/").toLowerCase(),
      );
    },
  );
});
