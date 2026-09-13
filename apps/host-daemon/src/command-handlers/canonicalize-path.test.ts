import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExpectedCommandDispatchError,
  isExpectedOnlineRpcFailureError,
} from "../command-dispatch-support.js";
import {
  canonicalizeHostPath,
  canonicalizeHostPathCommand,
  type CanonicalizeHostPathArgs,
} from "./canonicalize-path.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function throwingRealpath(): {
  calls: string[];
  realpath: (path: string) => Promise<string>;
} {
  const calls: string[] = [];
  return {
    calls,
    realpath: (path) => {
      calls.push(path);
      return Promise.reject(fsError("ENOENT"));
    },
  };
}

describe("canonicalizeHostPath", () => {
  it("normalizes a Windows path resolved by the host", async () => {
    await expect(
      canonicalizeHostPath({
        path: "c:/work/bb/",
        platform: "win32",
        realpath: async () => "C:\\Work\\bb",
      }),
    ).resolves.toEqual({ path: "C:\\Work\\bb", pathKey: "c:/work/bb" });
  });

  it("strips the extended-length prefix the native realpath may return", async () => {
    await expect(
      canonicalizeHostPath({
        path: "C:\\Work\\bb",
        platform: "win32",
        realpath: async () => "\\\\?\\C:\\Work\\bb\\",
      }),
    ).resolves.toEqual({ path: "C:\\Work\\bb", pathKey: "c:/work/bb" });
  });

  it("rejects UNC, device, POSIX-shaped and relative input on Windows", async () => {
    for (const input of [
      "\\\\server\\share\\bb",
      "\\\\?\\C:\\bb",
      "bb\\repo",
      "/srv/bb",
      "//server/share",
      "C:",
      "c:",
    ]) {
      await expect(
        canonicalizeHostPath({
          path: input,
          platform: "win32",
          realpath: async () => input,
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
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("not a drive-letter path"),
    });
  });

  it("returns the shape-normalized path when a Windows path does not exist", async () => {
    for (const code of ["ENOENT", "ENOTDIR"]) {
      await expect(
        canonicalizeHostPath({
          path: "c:/Work/missing/",
          platform: "win32",
          realpath: () => Promise.reject(fsError(code)),
        }),
      ).resolves.toEqual({
        path: "C:\\Work\\missing",
        pathKey: "c:/work/missing",
      });
    }
  });

  it("propagates Windows realpath errors other than ENOENT and ENOTDIR", async () => {
    await expect(
      canonicalizeHostPath({
        path: "C:\\Work\\protected",
        platform: "win32",
        realpath: () => Promise.reject(fsError("EACCES")),
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("returns POSIX paths as typed without touching the filesystem", async () => {
    const stub = throwingRealpath();
    await expect(
      canonicalizeHostPath({
        path: "/home/me/link/",
        platform: "linux",
        realpath: stub.realpath,
      }),
    ).resolves.toEqual({ path: "/home/me/link", pathKey: "/home/me/link" });
    await expect(
      canonicalizeHostPath({
        path: "/srv/missing",
        platform: "linux",
        realpath: stub.realpath,
      }),
    ).resolves.toEqual({ path: "/srv/missing", pathKey: "/srv/missing" });
    await expect(
      canonicalizeHostPath({
        path: "/srv/file.txt",
        platform: "linux",
        realpath: stub.realpath,
      }),
    ).resolves.toEqual({ path: "/srv/file.txt", pathKey: "/srv/file.txt" });
    expect(stub.calls).toEqual([]);
  });

  it("accepts POSIX paths that start with more than one separator", async () => {
    const stub = throwingRealpath();
    await expect(
      canonicalizeHostPath({
        path: "//srv/x",
        platform: "linux",
        realpath: stub.realpath,
      }),
    ).resolves.toEqual({ path: "//srv/x", pathKey: "//srv/x" });
    expect(stub.calls).toEqual([]);
  });

  it("rejects relative and Windows input on POSIX", async () => {
    for (const input of ["repo", "C:\\repo", "\\\\server\\share\\bb"]) {
      await expect(
        canonicalizeHostPath({
          path: input,
          platform: "linux",
          realpath: async () => input,
        }),
      ).rejects.toMatchObject({
        code: "invalid_path",
        message: expect.stringContaining("must be an absolute path"),
      });
    }
  });

  it("marks every invalid_path rejection as an expected failure", async () => {
    const cases: CanonicalizeHostPathArgs[] = [
      {
        path: "\\\\server\\share\\bb",
        platform: "win32",
        realpath: async () => "\\\\server\\share\\bb",
      },
      {
        path: "C:",
        platform: "win32",
        realpath: async () => "C:",
      },
      {
        path: "Z:\\repo",
        platform: "win32",
        realpath: async () => "\\\\?\\UNC\\server\\share\\repo",
      },
      {
        path: "repo",
        platform: "linux",
        realpath: async () => "repo",
      },
    ];
    for (const args of cases) {
      const error = await canonicalizeHostPath(args).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ExpectedCommandDispatchError);
      expect(isExpectedOnlineRpcFailureError(error)).toBe(true);
      expect(error).toMatchObject({ code: "invalid_path" });
    }
  });
});

describe("canonicalizeHostPathCommand", () => {
  it("resolves a real directory on this host", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-canonical-"));
    tempDirs.push(root);
    const target = path.join(root, "Mixed Case");
    await fs.mkdir(target);
    const expected =
      process.platform === "win32" ? await fs.realpath(target) : target;
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

  it("returns a path that does not exist on this host", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-canonical-"));
    tempDirs.push(root);
    const missing = path.join(root, "missing");
    const result = await canonicalizeHostPathCommand({
      type: "host.canonicalize_path",
      path: missing,
    });
    expect(result.path.toLowerCase()).toBe(missing.toLowerCase());
    expect(result.pathKey).toBe(
      process.platform === "win32"
        ? missing.replace(/\\/gu, "/").toLowerCase()
        : missing,
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
