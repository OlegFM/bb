import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRemovableWorkspacePath,
  resolveWorkspacePath,
  WORKSPACES_DIR_NAME,
} from "./paths.js";

describe("personal workspace paths", () => {
  const dataDir = path.join(os.tmpdir(), "bb-personal");

  it("builds the workspace path with the host's native separator", () => {
    expect(resolveWorkspacePath({ dataDir, pathKey: "thr_a" })).toBe(
      path.join(dataDir, WORKSPACES_DIR_NAME, "thr_a"),
    );
  });

  it("rejects keys that are not a single segment", () => {
    expect(() => resolveWorkspacePath({ dataDir, pathKey: "../x" })).toThrow(
      /single path segment/u,
    );
    expect(() => resolveWorkspacePath({ dataDir, pathKey: "a/b" })).toThrow(
      /single path segment/u,
    );
  });

  it.runIf(process.platform !== "win32")(
    "accepts a backslash in a key on POSIX hosts",
    () => {
      expect(resolveWorkspacePath({ dataDir, pathKey: "a\\b" })).toBe(
        path.join(dataDir, WORKSPACES_DIR_NAME, "a\\b"),
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "refuses a backslash in a key on Windows hosts",
    () => {
      expect(() => resolveWorkspacePath({ dataDir, pathKey: "a\\b" })).toThrow(
        /single path segment/u,
      );
    },
  );

  it("only removes paths under the workspace roots", () => {
    const own = path.join(dataDir, WORKSPACES_DIR_NAME, "thr_a");
    expect(assertRemovableWorkspacePath({ dataDir, path: own })).toBe(
      path.resolve(own),
    );
    expect(() =>
      assertRemovableWorkspacePath({
        dataDir,
        path: path.join(dataDir, "elsewhere", "thr_a"),
      }),
    ).toThrow(/outside the personal workspace roots/u);
  });
});
