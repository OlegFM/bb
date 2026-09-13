import { describe, expect, it } from "vitest";
import { isBbManagedWorkspacePath } from "../../src/services/threads/workspace-paths.js";

describe("isBbManagedWorkspacePath", () => {
  it("recognizes POSIX managed roots and their children", () => {
    const dataDir = "/home/me/.bb";
    expect(
      isBbManagedWorkspacePath({ dataDir, path: "/home/me/.bb/worktrees" }),
    ).toBe(true);
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: "/home/me/.bb/worktrees/env/repo",
      }),
    ).toBe(true);
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: "/home/me/.bb/personal-workspaces/env",
      }),
    ).toBe(true);
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: "/home/me/.bb/worktrees-other",
      }),
    ).toBe(false);
    expect(isBbManagedWorkspacePath({ dataDir, path: "/home/me/repo" })).toBe(
      false,
    );
  });

  it("recognizes Windows managed roots regardless of spelling", () => {
    const dataDir = "C:\\Users\\me\\.bb";
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: "c:/users/ME/.bb/worktrees/env/repo",
      }),
    ).toBe(true);
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: "C:\\Users\\me\\.bb\\personal-workspaces\\env",
      }),
    ).toBe(true);
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: "C:\\Users\\me\\.bbx\\worktrees\\env",
      }),
    ).toBe(false);
    expect(
      isBbManagedWorkspacePath({
        dataDir,
        path: "/Users/me/.bb/worktrees/env",
      }),
    ).toBe(false);
  });
});
