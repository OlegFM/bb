import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findWorktreeForBranch, runGit } from "../src/git.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function comparablePath(value: string): string {
  return process.platform === "win32"
    ? value.replace(/\\/gu, "/").toLowerCase()
    : value;
}

async function initWorktreeLayout() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-provider-host-"));
  tempDirs.push(root);
  const repoPath = path.join(root, "repo");
  await fs.mkdir(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  const worktreePath = path.join(root, "feature-a");
  await runGit(["worktree", "add", "-b", "feature-a", worktreePath], {
    cwd: repoPath,
  });
  return { repoPath, worktreePath };
}

describe("findWorktreeForBranch", () => {
  it("reads the porcelain worktree path this host's git prints", async () => {
    const { repoPath, worktreePath } = await initWorktreeLayout();
    const expected = await fs.realpath(worktreePath);

    const found = await findWorktreeForBranch(repoPath, "feature-a");

    expect(found).not.toBeNull();
    expect(found).not.toContain("\r");
    expect(comparablePath(found ?? "")).toBe(comparablePath(expected));
    if (process.platform === "win32") {
      expect(found ?? "").toMatch(/^[A-Za-z]:\//u);
    }
  });

  it("returns null for a branch with no worktree", async () => {
    const { repoPath } = await initWorktreeLayout();

    await expect(findWorktreeForBranch(repoPath, "main")).resolves.not.toBe(
      null,
    );
    await expect(
      findWorktreeForBranch(repoPath, "no-such-branch"),
    ).resolves.toBeNull();
  });
});
