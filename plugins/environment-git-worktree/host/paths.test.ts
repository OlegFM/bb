import { WorkspaceError } from "bb-environment-provider-host/git";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveRepoDirName,
  resolveWorktreeAttemptRoot,
  resolveWorktreesRoot,
  resolveWorktreeTargetPath,
} from "./paths.js";

describe("deriveRepoDirName", () => {
  it.each([
    ["local absolute path", "/Users/someone/code/my-repo", "my-repo"],
    [
      "local path with trailing slash",
      "/Users/someone/code/my-repo/",
      "my-repo",
    ],
    ["https URL", "https://github.com/octocat/Hello-World.git", "Hello-World"],
    ["ssh URL", "ssh://git@github.com/octocat/Hello-World.git", "Hello-World"],
    ["scp-style", "git@github.com:octocat/Hello-World.git", "Hello-World"],
    [
      "scp-style without .git",
      "git@github.com:octocat/Hello-World",
      "Hello-World",
    ],
    ["dotted name", "/Users/me/code/my.repo", "my.repo"],
    ["Windows local path", "C:\\Users\\someone\\code\\my-repo", "my-repo"],
    [
      "Windows path with forward slashes and trailing slash",
      "C:/Users/someone/code/my-repo/",
      "my-repo",
    ],
    ["Windows path with trailing backslash", "C:\\code\\my-repo\\", "my-repo"],
    ["Windows dotted name", "D:\\code\\my.repo", "my.repo"],
  ])("derives %s", (_label, input, expected) => {
    expect(deriveRepoDirName(input)).toBe(expected);
  });

  it.each([
    ["root-only path", "/"],
    ["empty string", ""],
    ["bare .git", "/Users/me/code/.git"],
    ["parent traversal", "/Users/me/code/.."],
    ["current dir", "/Users/me/code/."],
    ["leading dash (could be interpreted as flag)", "/tmp/-dangerous"],
    ["whitespace in name", "/tmp/my repo"],
    [
      "url with query parameter encoded into basename",
      "https://host/foo/bar.git;param=x",
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => deriveRepoDirName(input)).toThrowError(WorkspaceError);
  });

  it("builds managed paths with the host's native separator", () => {
    const dataDir = path.join(os.tmpdir(), "bb-data");
    expect(resolveWorktreesRoot(dataDir)).toBe(path.join(dataDir, "worktrees"));
    expect(
      resolveWorktreeTargetPath({
        dataDir,
        pathKey: "thr_1",
        sourcePath: "/x/repo",
      }),
    ).toBe(path.join(dataDir, "worktrees", "thr_1", "repo"));
    expect(() =>
      resolveWorktreeAttemptRoot({ dataDir, pathKey: "../escape" }),
    ).toThrow(/single path segment/u);
  });
});
