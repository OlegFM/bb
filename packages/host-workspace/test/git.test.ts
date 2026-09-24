import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@bb/test-helpers";
import * as processUtils from "@bb/process-utils";
import {
  detectGitRepo,
  detectGitRepoKind,
  detectLinkedWorktree,
  fetchRemoteBranches,
  getCheckoutRef,
  getWorkspaceGitOperation,
  isLinkedWorktreeGitDir,
  parseNameStatusEntries,
  parseNumstatEntriesZ,
  parsePatchId,
  parsePorcelainEntries,
  readDefaultBranchRefs,
  readGitBlob,
  runGit,
  runGitOutputPipeline,
  runGitWithNullRecordLimit,
  runShellPipeline,
  summarizeNumstat,
} from "../src/git.js";

const tempDirs: string[] = [];

async function writeWindowsGitShim(binPath: string): Promise<void> {
  await fs.writeFile(
    path.join(binPath, "git-fixture.js"),
    [
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") process.stdout.write("user-shell-git\\n");',
      'else if (args[0] === "--probe-env") process.stdout.write(`${process.env.BB_DATA_DIR ?? "missing"}|${process.env.NODE_ENV ?? "missing"}|${process.env.OPENAI_API_KEY ?? "missing"}`);',
      'else if (args[0] === "--null-records") process.stdout.write("fixture.txt\\0");',
      'else if (args[0] === "--touch-marker") { fs.writeFileSync(args[1], "started"); process.stdout.write("payload"); }',
      'else if (args[0] === "hash-object") {',
      '  let input = "";',
      '  process.stdin.on("data", (chunk) => { input += chunk; });',
      '  process.stdin.on("end", () => process.stdout.write(input));',
      "} else process.exit(2);",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(binPath, "git.cmd"),
    '@echo off\r\n@node "%~dp0\\git-fixture.js" %*\r\n',
  );
}

async function initReadGitBlobRepo() {
  const repoPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-read-git-blob-"),
  );
  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.mkdir(path.join(repoPath, "docs"));
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await fs.writeFile(path.join(repoPath, "docs", "index.md"), "docs\n", "utf8");
  await fs.writeFile(path.join(repoPath, "large.txt"), "0123456789\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  return repoPath;
}

async function initEmptyRepo() {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "bb-empty-git-"));
  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  return repoPath;
}

async function initConflictRepo() {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "bb-git-conflict-"));
  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  await runGit(["switch", "-c", "feature"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
  await runGit(["commit", "-am", "Feature edit"], { cwd: repoPath });
  await runGit(["switch", "main"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "main\n", "utf8");
  await runGit(["commit", "-am", "Main edit"], { cwd: repoPath });
  return repoPath;
}

async function initDefaultBranchRemoteRepo() {
  const repoPath = await initReadGitBlobRepo();
  const remotePath = await fs.mkdtemp(path.join(os.tmpdir(), "bb-git-remote-"));
  tempDirs.push(remotePath);
  await runGit(["init", "--bare"], { cwd: remotePath });
  await runGit(["remote", "add", "origin", remotePath], { cwd: repoPath });
  await runGit(["push", "-u", "origin", "main"], { cwd: repoPath });
  await runGit(["fetch", "origin"], { cwd: repoPath });
  return { remotePath, repoPath };
}

async function pushRemoteMainCommit(remotePath: string) {
  const cloneParent = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-git-remote-clone-"),
  );
  tempDirs.push(cloneParent);
  const clonePath = path.join(cloneParent, "repo");
  await runGit(["clone", "--branch", "main", remotePath, clonePath], {
    cwd: cloneParent,
  });
  await runGit(["config", "user.name", "BB Tests"], { cwd: clonePath });
  await runGit(["config", "user.email", "bb@example.com"], {
    cwd: clonePath,
  });
  await fs.writeFile(path.join(clonePath, "remote.txt"), "remote\n", "utf8");
  await runGit(["add", "."], { cwd: clonePath });
  await runGit(["commit", "-m", "Remote edit"], { cwd: clonePath });
  await runGit(["push", "origin", "main"], { cwd: clonePath });
}

async function initSshRemoteRepo() {
  const repoPath = await initReadGitBlobRepo();
  const sshLogPath = path.join(repoPath, "ssh-invocations.log");
  const sshScriptPath = path.join(
    repoPath,
    process.platform === "win32" ? "recording-ssh.js" : "recording-ssh.sh",
  );
  if (process.platform === "win32") {
    await fs.writeFile(
      sshScriptPath,
      [
        'const fs = require("node:fs");',
        'fs.appendFileSync(process.env.TEST_SSH_LOG, `${process.argv.slice(2).join("\\n")}\\nGIT_TERMINAL_PROMPT=${process.env.GIT_TERMINAL_PROMPT ?? "unset"}\\n`);',
        "process.exit(255);",
      ].join("\n"),
    );
    vi.stubEnv("TEST_SSH_LOG", sshLogPath);
  } else {
    await fs.writeFile(
      sshScriptPath,
      `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(sshLogPath)}\nprintf 'GIT_TERMINAL_PROMPT=%s\\n' "\${GIT_TERMINAL_PROMPT-unset}" >> ${JSON.stringify(sshLogPath)}\nexit 255\n`,
      { encoding: "utf8", mode: 0o755 },
    );
  }
  await runGit(["remote", "add", "origin", "ssh://git.invalid/repo.git"], {
    cwd: repoPath,
  });
  const sshCommand =
    process.platform === "win32"
      ? `"${process.execPath.replaceAll("\\", "/")}" "${sshScriptPath.replaceAll("\\", "/")}"`
      : sshScriptPath;
  await runGit(["config", "core.sshCommand", sshCommand], { cwd: repoPath });
  return { repoPath, sshLogPath };
}

async function initBareWorktreeLayout() {
  const origin = await initReadGitBlobRepo();
  await runGit(["branch", "feature-a"], { cwd: origin });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-bare-layout-"));
  tempDirs.push(root);
  await runGit(["clone", "--bare", origin, ".bare"], { cwd: root });
  await fs.writeFile(path.join(root, ".git"), "gitdir: ./.bare\n", "utf8");
  await runGit(["worktree", "add", "feature-a", "feature-a"], { cwd: root });
  return { root, worktreePath: path.join(root, "feature-a") };
}

async function initPatchIdRepo() {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "bb-patch-id-"));
  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "changed\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Second commit"], { cwd: repoPath });
  return repoPath;
}

async function initOversizedDiffDir() {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), "bb-pipeline-cap-"));
  tempDirs.push(dirPath);
  await fs.writeFile(path.join(dirPath, "empty.txt"), "", "utf8");
  await fs.writeFile(
    path.join(dirPath, "big.txt"),
    `${"x".repeat(63)}\n`.repeat(280_000),
    "utf8",
  );
  return dirPath;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe.runIf(process.platform !== "win32")("runShellPipeline", () => {
  it("scrubs inherited bb runtime env vars and node mode", async () => {
    const repoPath = await initEmptyRepo();
    vi.stubEnv("BB_DATA_DIR", "/tmp/leaked-bb-data");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "external-secret");

    const result = await runShellPipeline(
      `printf '%s|%s|%s' "\${BB_DATA_DIR-missing}" "\${NODE_ENV-missing}" "\${OPENAI_API_KEY-missing}"`,
      [],
      { cwd: repoPath },
    );

    expect(result.stdout).toBe("missing|missing|external-secret");
  });
});

describe.runIf(process.platform === "win32")("native Git environment", () => {
  it("scrubs inherited bb runtime env vars and node mode", async () => {
    const repoPath = await initEmptyRepo();
    const binPath = await fs.mkdtemp(path.join(os.tmpdir(), "bb-git-env-bin-"));
    tempDirs.push(binPath);
    await writeWindowsGitShim(binPath);
    vi.stubEnv("BB_DATA_DIR", "leaked-bb-data");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "external-secret");

    const result = await runGit(["--probe-env"], {
      cwd: repoPath,
      shellPath: binPath,
    });

    expect(result.stdout).toBe("missing|missing|external-secret");
  });
});

describe("runGitOutputPipeline", () => {
  it.runIf(process.platform === "win32")(
    "does not start Git when aborted during executable resolution",
    async () => {
      const workspacePath = await fs.mkdtemp(
        path.join(os.tmpdir(), "bb-git-pipeline-abort-"),
      );
      const binPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "bb-git-pipeline-bin-"),
      );
      tempDirs.push(workspacePath, binPath);
      await writeWindowsGitShim(binPath);
      const marker = path.join(workspacePath, "started");
      const entered = createDeferredPromise<void>();
      const release = createDeferredPromise<void>();
      const original = processUtils.resolveSpawnPlanOrThrow;
      const resolver = vi
        .spyOn(processUtils, "resolveSpawnPlanOrThrow")
        .mockImplementation(async (request) => {
          entered.resolve();
          await release.promise;
          return original(request);
        });
      const controller = new AbortController();

      try {
        const pending = runGitOutputPipeline(
          ["--touch-marker", marker],
          ["hash-object", "--stdin"],
          {
            cwd: workspacePath,
            shellPath: binPath,
            signal: controller.signal,
          },
        );
        await entered.promise;
        controller.abort();
        release.resolve();
        await expect(pending).rejects.toMatchObject({
          code: "provision_cancelled",
        });
        await expect(fs.access(marker)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        release.resolve();
        resolver.mockRestore();
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "classifies resolver rejection after abort as cancellation",
    async () => {
      const workspacePath = await fs.mkdtemp(
        path.join(os.tmpdir(), "bb-git-pipeline-abort-"),
      );
      tempDirs.push(workspacePath);
      const entered = createDeferredPromise<void>();
      const release = createDeferredPromise<void>();
      const resolver = vi
        .spyOn(processUtils, "resolveSpawnPlanOrThrow")
        .mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          throw new Error("resolution failed");
        });
      const controller = new AbortController();

      try {
        const pending = runGitOutputPipeline(["--version"], ["hash-object"], {
          cwd: workspacePath,
          signal: controller.signal,
        });
        await entered.promise;
        controller.abort();
        release.resolve();
        await expect(pending).rejects.toMatchObject({
          code: "provision_cancelled",
        });
      } finally {
        release.resolve();
        resolver.mockRestore();
      }
    },
  );

  it("pipes producer stdout into the consumer without a shell", async () => {
    const repoPath = await initEmptyRepo();

    const result = await runGitOutputPipeline(
      ["--version"],
      ["hash-object", "--stdin"],
      { cwd: repoPath },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("computes a stable patch id for a real diff", async () => {
    const repoPath = await initPatchIdRepo();

    const result = await runGitOutputPipeline(
      ["diff", "HEAD~1..HEAD"],
      ["patch-id", "--stable"],
      { cwd: repoPath },
    );

    expect(result.exitCode).toBe(0);
    expect(parsePatchId(result.stdout.split("\n")[0])).toMatch(
      /^[0-9a-f]{40}$/u,
    );
  });

  it.skipIf(process.platform === "win32")(
    "returns the same patch id as the POSIX shell pipeline",
    async () => {
      const repoPath = await initPatchIdRepo();

      const piped = await runGitOutputPipeline(
        ["diff", "HEAD~1..HEAD"],
        ["patch-id", "--stable"],
        { cwd: repoPath },
      );
      const shelled = await runShellPipeline(
        'git diff "$1".."$2" | git patch-id --stable',
        ["HEAD~1", "HEAD"],
        { cwd: repoPath },
      );

      expect(piped.stdout).toBe(shelled.stdout);
      expect(piped.exitCode).toBe(shelled.exitCode);
      const sharedPatchId = parsePatchId(piped.stdout.split("\n")[0]);
      expect(sharedPatchId).toBe(parsePatchId(shelled.stdout.split("\n")[0]));
      expect(sharedPatchId).toMatch(/^[0-9a-f]{40}$/u);
    },
  );

  it("reports a producer failure as a non-zero exit when allowFailure is set", async () => {
    const repoPath = await initEmptyRepo();

    const result = await runGitOutputPipeline(
      ["rev-parse", "--verify", "refs/heads/does-not-exist"],
      ["patch-id", "--stable"],
      { cwd: repoPath, allowFailure: true },
    );

    expect(result.exitCode).not.toBe(0);
  });

  it("raises a shell pipeline failure when the producer fails", async () => {
    const repoPath = await initEmptyRepo();

    await expect(
      runGitOutputPipeline(
        ["rev-parse", "--verify", "refs/heads/does-not-exist"],
        ["patch-id", "--stable"],
        { cwd: repoPath },
      ),
    ).rejects.toMatchObject({
      code: "shell_pipeline_failed",
      name: "WorkspaceError",
    });
  });

  it("classifies pipeline timeouts as hard failures when allowFailure is true", async () => {
    const repoPath = await initEmptyRepo();

    await expect(
      runGitOutputPipeline(["--version"], ["patch-id", "--stable"], {
        cwd: repoPath,
        allowFailure: true,
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({
      code: "shell_pipeline_timeout",
      name: "WorkspaceError",
    });
  });

  it("stops the producer when the consumer exits before reading its output", async () => {
    const dirPath = await initOversizedDiffDir();

    const result = await runGitOutputPipeline(
      ["diff", "--no-index", "--", "empty.txt", "big.txt"],
      ["--version"],
      { cwd: dirPath, allowFailure: true, timeoutMs: 5_000 },
    );

    expect(result.stdout).toContain("git version");
  });

  it("caps collected output at the shell pipeline buffer limit", async () => {
    const dirPath = await initOversizedDiffDir();

    const capped = await runGitOutputPipeline(
      ["--version"],
      ["diff", "--no-index", "--", "empty.txt", "big.txt"],
      { cwd: dirPath, allowFailure: true },
    );

    expect(Buffer.byteLength(capped.stdout, "utf8")).toBe(16 * 1024 * 1024);
    expect(capped.exitCode).toBe(1);

    await expect(
      runGitOutputPipeline(
        ["--version"],
        ["diff", "--no-index", "--", "empty.txt", "big.txt"],
        { cwd: dirPath },
      ),
    ).rejects.toMatchObject({
      code: "shell_pipeline_failed",
      name: "WorkspaceError",
    });
  });

  it("classifies aborted pipelines as cancellations", async () => {
    const repoPath = await initEmptyRepo();
    const controller = new AbortController();

    const pending = runGitOutputPipeline(
      ["hash-object", "--stdin"],
      ["patch-id", "--stable"],
      { cwd: repoPath, signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "provision_cancelled",
      name: "WorkspaceError",
    });
  });
});

describe("runGitWithNullRecordLimit", () => {
  it("stops an untracked path listing at the requested complete-record count", async () => {
    const repoPath = await initEmptyRepo();
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        fs.writeFile(path.join(repoPath, `file-${index}.txt`), `${index}\n`),
      ),
    );

    const result = await runGitWithNullRecordLimit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: repoPath },
      "single",
      3,
    );

    expect(result.recordLimitReached).toBe(true);
    expect(result.recordCount).toBe(3);
    expect(result.stdout.split("\0").filter(Boolean)).toHaveLength(3);
  });

  it("keeps rename records complete when stopping name-status output", async () => {
    const repoPath = await initReadGitBlobRepo();
    await runGit(["mv", "README.md", "RENAMED.md"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "docs", "index.md"), "changed\n");
    await fs.rm(path.join(repoPath, "large.txt"));

    const result = await runGitWithNullRecordLimit(
      ["diff", "--name-status", "-M", "-z", "HEAD"],
      { cwd: repoPath },
      "name-status",
      2,
    );

    expect(result.recordLimitReached).toBe(true);
    expect(result.recordCount).toBe(2);
    expect(parseNameStatusEntries(result.stdout)).toHaveLength(2);
  });

  it("keeps rename records complete when stopping numstat output", async () => {
    const repoPath = await initReadGitBlobRepo();
    await runGit(["mv", "README.md", "RENAMED.md"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "RENAMED.md"), "hello\nmore\n");
    await fs.writeFile(path.join(repoPath, "docs", "index.md"), "changed\n");
    await fs.rm(path.join(repoPath, "large.txt"));

    const result = await runGitWithNullRecordLimit(
      ["diff", "--numstat", "-M", "-z", "HEAD"],
      { cwd: repoPath },
      "numstat",
      2,
    );

    expect(result.recordLimitReached).toBe(true);
    expect(result.recordCount).toBe(2);
    expect(parseNumstatEntriesZ(result.stdout)).toHaveLength(2);
    expect(parseNumstatEntriesZ(result.stdout)).toContainEqual({
      path: "RENAMED.md",
      insertions: 1,
      deletions: 0,
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not confuse a regular numstat path ending in a tab with a rename",
    async () => {
      const repoPath = await initReadGitBlobRepo();
      const unusualPath = "trailing-tab\t";
      await fs.writeFile(path.join(repoPath, unusualPath), "one\n");
      await runGit(["add", unusualPath], { cwd: repoPath });

      const result = await runGitWithNullRecordLimit(
        ["diff", "--cached", "--numstat", "-z", "HEAD"],
        { cwd: repoPath },
        "numstat",
        1,
      );

      expect(result.recordLimitReached).toBe(true);
      expect(result.recordCount).toBe(1);
      expect(parseNumstatEntriesZ(result.stdout)).toEqual([
        { path: unusualPath, insertions: 1, deletions: 0 },
      ]);
    },
  );
});

describe("detectGitRepoKind", () => {
  it("tells a bare repository root apart from its worktrees and plain directories", async () => {
    const { root, worktreePath } = await initBareWorktreeLayout();
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-plain-dir-"));
    tempDirs.push(plainDir);

    await expect(detectGitRepoKind(root)).resolves.toBe("bare");
    await expect(detectGitRepoKind(path.join(root, ".bare"))).resolves.toBe(
      "bare",
    );
    await expect(detectGitRepoKind(worktreePath)).resolves.toBe("work-tree");
    await expect(detectGitRepoKind(plainDir)).resolves.toBe("none");
  });

  it("tells a linked worktree apart from an ordinary checkout", async () => {
    const { worktreePath } = await initBareWorktreeLayout();
    const ordinaryCheckout = await initReadGitBlobRepo();
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-plain-wt-"));
    tempDirs.push(plainDir);

    await expect(detectLinkedWorktree(worktreePath)).resolves.toBe(true);
    await expect(detectLinkedWorktree(ordinaryCheckout)).resolves.toBe(false);
    await expect(detectLinkedWorktree(plainDir)).resolves.toBe(false);
  });

  it("reads a backslash-separated git dir as a linked worktree only on win32", () => {
    const windowsGitDir = "C:\\Users\\me\\repo\\.bare\\worktrees\\feature-a";

    expect(isLinkedWorktreeGitDir(windowsGitDir, "win32")).toBe(true);
    expect(isLinkedWorktreeGitDir(windowsGitDir, "darwin")).toBe(false);
    expect(
      isLinkedWorktreeGitDir("/srv/repo/.bare/worktrees/feature-a", "win32"),
    ).toBe(true);
    expect(
      isLinkedWorktreeGitDir("/srv/repo/.bare/worktrees/feature-a", "darwin"),
    ).toBe(true);
    expect(isLinkedWorktreeGitDir("C:\\Users\\me\\repo\\.git", "win32")).toBe(
      false,
    );
  });

  it("keeps a real linked worktree detected under the win32 arm", async () => {
    const { worktreePath } = await initBareWorktreeLayout();
    const ordinaryCheckout = await initReadGitBlobRepo();

    await expect(
      detectLinkedWorktree(worktreePath, { platform: "win32" }),
    ).resolves.toBe(true);
    await expect(
      detectLinkedWorktree(ordinaryCheckout, { platform: "win32" }),
    ).resolves.toBe(false);
  });

  it("keeps detectGitRepo scoped to work trees so bare roots get no checkout UI", async () => {
    const { root, worktreePath } = await initBareWorktreeLayout();

    await expect(detectGitRepo(root)).resolves.toBe(false);
    await expect(detectGitRepo(worktreePath)).resolves.toBe(true);
  });
});

describe("getCheckoutRef", () => {
  it("reports the HEAD branch of a bare repository root", async () => {
    const { root } = await initBareWorktreeLayout();
    const head = await runGit(["rev-parse", "HEAD"], { cwd: root });

    await expect(getCheckoutRef(root)).resolves.toEqual({
      kind: "branch",
      branchName: "main",
      headSha: head.stdout.trim(),
    });
  });

  it("reports branch checkouts with HEAD sha", async () => {
    const repoPath = await initReadGitBlobRepo();
    const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });

    await expect(getCheckoutRef(repoPath)).resolves.toEqual({
      kind: "branch",
      branchName: "main",
      headSha: head.stdout.trim(),
    });
  });

  it("reports detached HEAD without pretending there is a current branch", async () => {
    const repoPath = await initReadGitBlobRepo();
    const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
    await runGit(["switch", "--detach", "HEAD"], { cwd: repoPath });

    await expect(getCheckoutRef(repoPath)).resolves.toEqual({
      kind: "detached",
      headSha: head.stdout.trim(),
    });
  });

  it("reports unborn branches for empty repositories", async () => {
    const repoPath = await initEmptyRepo();

    await expect(getCheckoutRef(repoPath)).resolves.toEqual({
      kind: "unborn",
      branchName: "main",
    });
  });
});

describe("readDefaultBranchRefs", () => {
  it("reports equal local and origin defaults", async () => {
    const { repoPath } = await initDefaultBranchRemoteRepo();

    await expect(readDefaultBranchRefs(repoPath)).resolves.toEqual({
      defaultBranch: "main",
      defaultBranchRelation: "equal",
      originDefaultBranch: "origin/main",
    });
  });

  it("reports a local default behind origin", async () => {
    const { remotePath, repoPath } = await initDefaultBranchRemoteRepo();
    await pushRemoteMainCommit(remotePath);
    await runGit(["fetch", "origin"], { cwd: repoPath });

    await expect(readDefaultBranchRefs(repoPath)).resolves.toMatchObject({
      defaultBranch: "main",
      defaultBranchRelation: "local-behind",
      originDefaultBranch: "origin/main",
    });
  });

  it("reports a local default ahead of origin", async () => {
    const { repoPath } = await initDefaultBranchRemoteRepo();
    await fs.writeFile(path.join(repoPath, "local.txt"), "local\n", "utf8");
    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "Local edit"], { cwd: repoPath });

    await expect(readDefaultBranchRefs(repoPath)).resolves.toMatchObject({
      defaultBranch: "main",
      defaultBranchRelation: "local-ahead",
      originDefaultBranch: "origin/main",
    });
  });

  it("reports diverged local and origin defaults", async () => {
    const { remotePath, repoPath } = await initDefaultBranchRemoteRepo();
    await fs.writeFile(path.join(repoPath, "local.txt"), "local\n", "utf8");
    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "Local edit"], { cwd: repoPath });
    await pushRemoteMainCommit(remotePath);
    await runGit(["fetch", "origin"], { cwd: repoPath });

    await expect(readDefaultBranchRefs(repoPath)).resolves.toMatchObject({
      defaultBranch: "main",
      defaultBranchRelation: "diverged",
      originDefaultBranch: "origin/main",
    });
  });

  it("omits origin defaults when no origin ref exists", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(readDefaultBranchRefs(repoPath)).resolves.toEqual({
      defaultBranch: "main",
      defaultBranchRelation: undefined,
      originDefaultBranch: undefined,
    });
  });
});

describe("getWorkspaceGitOperation", () => {
  it("reports no operation for ordinary repositories", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(getWorkspaceGitOperation(repoPath)).resolves.toEqual({
      kind: "none",
    });
  });

  it("reports merge conflicts", async () => {
    const repoPath = await initConflictRepo();
    const merge = await runGit(["merge", "feature"], {
      cwd: repoPath,
      allowFailure: true,
    });
    expect(merge.exitCode).not.toBe(0);

    await expect(getWorkspaceGitOperation(repoPath)).resolves.toEqual({
      kind: "merge",
      hasConflicts: true,
    });
  });

  it("reports rebase conflicts", async () => {
    const repoPath = await initConflictRepo();
    await runGit(["switch", "feature"], { cwd: repoPath });
    const rebase = await runGit(["rebase", "main"], {
      cwd: repoPath,
      allowFailure: true,
    });
    expect(rebase.exitCode).not.toBe(0);

    await expect(getWorkspaceGitOperation(repoPath)).resolves.toEqual({
      kind: "rebase",
      hasConflicts: true,
    });
  });
});

describe("command timeouts", () => {
  it("classifies git command timeouts as hard failures when allowFailure is true", async () => {
    const repoPath = await initEmptyRepo();

    await expect(
      runGit(["-c", "alias.bb-sleep=!sleep 5", "bb-sleep"], {
        cwd: repoPath,
        allowFailure: true,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      code: "git_command_timeout",
      name: "WorkspaceError",
    });
  });

  it.runIf(process.platform !== "win32")(
    "classifies shell pipeline timeouts as hard failures when allowFailure is true",
    async () => {
      const repoPath = await initEmptyRepo();

      await expect(
        runShellPipeline("sleep 5", [], {
          cwd: repoPath,
          allowFailure: true,
          timeoutMs: 10,
        }),
      ).rejects.toMatchObject({
        code: "shell_pipeline_timeout",
        name: "WorkspaceError",
      });
    },
  );
});

describe("fetchRemoteBranches", () => {
  it("keeps a non-interactive fetch from prompting for ssh or git credentials", async () => {
    const { repoPath, sshLogPath } = await initSshRemoteRepo();

    await expect(
      fetchRemoteBranches(repoPath, { interactive: false }),
    ).resolves.toEqual({ status: "failed" });

    const log = await fs.readFile(sshLogPath, "utf8");
    expect(log).not.toContain("BatchMode");
    expect(log).toContain("GIT_TERMINAL_PROMPT=0\n");
  });

  it("leaves an interactive fetch free to prompt", async () => {
    const { repoPath, sshLogPath } = await initSshRemoteRepo();
    vi.stubEnv("GIT_TERMINAL_PROMPT", undefined);

    await expect(
      fetchRemoteBranches(repoPath, { interactive: true }),
    ).resolves.toEqual({ status: "failed" });

    const log = await fs.readFile(sshLogPath, "utf8");
    expect(log).not.toContain("BatchMode");
    expect(log).toContain("GIT_TERMINAL_PROMPT=unset\n");
  });
});

describe("user-shell Git resolution", () => {
  it.runIf(process.platform === "win32")(
    "reports a missing shell-path Git as workspace command failures",
    async () => {
      const workspacePath = await fs.mkdtemp(
        path.join(os.tmpdir(), "bb-git-missing-workspace-"),
      );
      const binPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "bb-git-missing-bin-"),
      );
      tempDirs.push(workspacePath, binPath);

      await expect(
        runGitWithNullRecordLimit(
          ["ls-files", "-z"],
          { cwd: workspacePath, shellPath: binPath },
          "single",
          1,
        ),
      ).rejects.toMatchObject({ code: "git_command_failed" });
      await expect(
        runGitOutputPipeline(["--version"], ["hash-object", "--stdin"], {
          cwd: workspacePath,
          shellPath: binPath,
        }),
      ).rejects.toMatchObject({ code: "shell_pipeline_failed" });
    },
  );

  it("uses the resolved shell PATH for Git commands and Git pipelines", async () => {
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "bb-git-shell-path-workspace-"),
    );
    const binPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "bb-git-shell-path-bin-"),
    );
    tempDirs.push(workspacePath, binPath);
    if (process.platform === "win32") {
      await writeWindowsGitShim(binPath);
    } else {
      const gitPath = path.join(binPath, "git");
      await fs.writeFile(gitPath, "#!/bin/sh\nprintf 'user-shell-git\\n'\n");
      await fs.chmod(gitPath, 0o755);
    }

    await expect(
      runGit(["--version"], { cwd: workspacePath, shellPath: binPath }),
    ).resolves.toMatchObject({ stdout: "user-shell-git\n" });
    if (process.platform === "win32") {
      await expect(
        runGitWithNullRecordLimit(
          ["--null-records"],
          { cwd: workspacePath, shellPath: binPath },
          "single",
          1,
        ),
      ).resolves.toMatchObject({
        stdout: "fixture.txt\0",
        recordCount: 1,
      });
      await expect(
        runGitOutputPipeline(["--version"], ["hash-object", "--stdin"], {
          cwd: workspacePath,
          shellPath: binPath,
        }),
      ).resolves.toMatchObject({ stdout: "user-shell-git\n" });
    } else {
      await expect(
        runShellPipeline("git --version", [], {
          cwd: workspacePath,
          shellPath: binPath,
        }),
      ).resolves.toMatchObject({ stdout: "user-shell-git\n" });
    }
  });
});

describe("readGitBlob", () => {
  it("reads a blob at a git ref and reports the returned byte size", async () => {
    const repoPath = await initReadGitBlobRepo();

    const blob = await readGitBlob(repoPath, "HEAD", "README.md", 1024);

    expect(blob.contents?.toString("utf8")).toBe("hello\n");
    expect(blob.sizeBytes).toBe(Buffer.byteLength("hello\n"));
  });

  it("returns null contents for a missing blob path", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "HEAD", "missing.txt", 1024),
    ).resolves.toEqual({
      contents: null,
      sizeBytes: 0,
    });
  });

  it("returns null contents for a missing ref", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "missing-ref", "README.md", 1024),
    ).resolves.toEqual({
      contents: null,
      sizeBytes: 0,
    });
  });

  it("rejects non-blob git objects instead of treating them as missing", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "HEAD", "docs", 1024),
    ).rejects.toMatchObject({
      code: "git_command_failed",
    });
  });

  it("allows blobs exactly at the byte cap", async () => {
    const repoPath = await initReadGitBlobRepo();

    const blob = await readGitBlob(repoPath, "HEAD", "large.txt", 11);

    expect(blob.contents?.toString("utf8")).toBe("0123456789\n");
    expect(blob.sizeBytes).toBe(11);
  });

  it("rejects oversized blobs during size preflight", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "HEAD", "large.txt", 4),
    ).rejects.toMatchObject({
      code: "blob_too_large",
      message: "Blob size 11 bytes exceeds the 0 MB limit",
    });
  });
});

describe("parsePorcelainEntries", () => {
  it("parses ordinary entries and renamed targets", () => {
    expect(
      parsePorcelainEntries(
        [
          " M README.md",
          "R  old-name.ts -> new-name.ts",
          "D  removed.txt",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "README.md",
        status: "M",
        indexStatus: " ",
        worktreeStatus: "M",
      },
      {
        path: "new-name.ts",
        status: "R",
        indexStatus: "R",
        worktreeStatus: " ",
      },
      {
        path: "removed.txt",
        status: "D",
        indexStatus: "D",
        worktreeStatus: " ",
      },
    ]);
  });

  it("decodes quoted git paths and octal escapes", () => {
    expect(
      parsePorcelainEntries(
        [
          '?? "a b.txt"',
          '?? "quote\\\\and\\\"slash.txt"',
          'R  "old\\040name.txt" -> "new\\040name.txt"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "a b.txt",
        status: "??",
        indexStatus: "?",
        worktreeStatus: "?",
      },
      {
        path: 'quote\\and"slash.txt',
        status: "??",
        indexStatus: "?",
        worktreeStatus: "?",
      },
      {
        path: "new name.txt",
        status: "R",
        indexStatus: "R",
        worktreeStatus: " ",
      },
    ]);
  });
});

describe("parseNameStatusEntries", () => {
  it("parses add, modify, and delete entries", () => {
    const output = [
      "A",
      "src/new.ts",
      "M",
      "src/existing.ts",
      "D",
      "src/old.ts",
      "",
    ].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/new.ts", status: "A" },
      { path: "src/existing.ts", status: "M" },
      { path: "src/old.ts", status: "D" },
    ]);
  });

  it("takes the new path for rename and copy entries", () => {
    const output = [
      "R100",
      "src/old.ts",
      "src/new.ts",
      "C75",
      "src/base.ts",
      "src/copy.ts",
      "",
    ].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/new.ts", status: "R" },
      { path: "src/copy.ts", status: "C" },
    ]);
  });

  it("preserves single-letter status with no similarity score", () => {
    const output = ["T", "src/link.ts", ""].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/link.ts", status: "T" },
    ]);
  });

  it("interleaves regular and rename entries correctly", () => {
    const output = [
      "M",
      "src/a.ts",
      "R090",
      "src/b-old.ts",
      "src/b-new.ts",
      "A",
      "src/c.ts",
      "",
    ].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/b-new.ts", status: "R" },
      { path: "src/c.ts", status: "A" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseNameStatusEntries("")).toEqual([]);
  });

  it("skips truncated trailing entries without throwing", () => {
    expect(parseNameStatusEntries("M\0")).toEqual([]);
    expect(parseNameStatusEntries("R100\0src/old.ts\0")).toEqual([]);
  });
});

describe("summarizeNumstat", () => {
  it("totals changed files, insertions, and deletions", () => {
    expect(
      summarizeNumstat(
        ["10\t4\tREADME.md", "-\t-\tbinary.dat", "2\t0\tsrc/app.ts"].join("\n"),
      ),
    ).toEqual({
      changedFiles: 3,
      insertions: 12,
      deletions: 4,
    });
  });
});

describe("parseNumstatEntriesZ", () => {
  it("keeps a regular path ending in a tab distinct from a rename", () => {
    expect(parseNumstatEntriesZ("1\t0\ttrailing-tab\t\0")).toEqual([
      { path: "trailing-tab\t", insertions: 1, deletions: 0 },
    ]);
  });

  it("parses normal and binary entries from NUL-delimited output", () => {
    const output =
      "10\t4\tREADME.md\0" + "-\t-\tbinary.dat\0" + "2\t0\tsrc/app.ts\0";
    expect(parseNumstatEntriesZ(output)).toEqual([
      { path: "README.md", insertions: 10, deletions: 4 },
      { path: "binary.dat", insertions: null, deletions: null },
      { path: "src/app.ts", insertions: 2, deletions: 0 },
    ]);
  });

  it("takes the new path for rename entries", () => {
    const output = "3\t1\t\0src/old.ts\0src/new.ts\0" + "5\t2\tsrc/app.ts\0";
    expect(parseNumstatEntriesZ(output)).toEqual([
      { path: "src/new.ts", insertions: 3, deletions: 1 },
      { path: "src/app.ts", insertions: 5, deletions: 2 },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseNumstatEntriesZ("")).toEqual([]);
  });
});
