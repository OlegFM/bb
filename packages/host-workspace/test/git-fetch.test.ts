import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteBranches, runGit } from "../src/git.js";
import {
  killWindowsProcessesWithCwdUnder,
  queryWindowsProcess,
  resolveExecutable,
} from "@bb/process-utils";

const tempDirs: string[] = [];

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function initRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bb-git-fetch-"));
  tempDirs.push(repo);
  await runGit(["init", "-b", "main"], { cwd: repo });
  await runGit(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Initial commit",
    ],
    { cwd: repo },
  );
  return repo;
}

async function writeScript(repo: string, name: string, body: string) {
  const script = path.join(repo, name);
  await fs.writeFile(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return script;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("background Git authentication", () => {
  it.runIf(process.platform === "win32")(
    "uses a resolved Node Git shim for non-interactive fetch",
    async () => {
      const repo = await initRepo();
      const binPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "bb-git-fetch-bin-"),
      );
      tempDirs.push(binPath);
      const logPath = path.join(binPath, "fetch.json");
      const realGit = await resolveExecutable({
        command: "git",
        env: process.env,
      });
      expect(realGit).toMatch(/git\.exe$/iu);
      await fs.writeFile(
        path.join(binPath, "git-fixture.js"),
        [
          'const fs = require("node:fs");',
          'const { spawnSync } = require("node:child_process");',
          "const args = process.argv.slice(2);",
          'if (args[0] === "fetch") {',
          "  fs.writeFileSync(process.env.TEST_GIT_FETCH_LOG, JSON.stringify({ args, prompt: process.env.GIT_TERMINAL_PROMPT, askpass: process.env.GIT_ASKPASS }));",
          "  process.exit(0);",
          "}",
          'const result = spawnSync(process.env.TEST_REAL_GIT, args, { env: process.env, encoding: "utf8", windowsHide: true });',
          'process.stdout.write(result.stdout ?? "");',
          'process.stderr.write(result.stderr ?? "");',
          "process.exit(result.status ?? 1);",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(binPath, "git.cmd"),
        '@echo off\r\n@node "%~dp0\\git-fixture.js" %*\r\n',
      );
      vi.stubEnv("TEST_REAL_GIT", realGit ?? "");
      vi.stubEnv("TEST_GIT_FETCH_LOG", logPath);
      await runGit(["remote", "add", "origin", repo], { cwd: repo });

      await expect(
        fetchRemoteBranches(repo, {
          interactive: false,
          shellPath: binPath,
          timeoutMs: 5_000,
        }),
      ).resolves.toEqual({ status: "fetched" });
      expect(JSON.parse(await fs.readFile(logPath, "utf8"))).toEqual({
        args: ["fetch", "--all", "--prune", "--quiet"],
        prompt: "0",
        askpass: "false",
      });
    },
  );

  it("preserves a working GIT_SSH wrapper, including paths with spaces", async () => {
    const repo = await initRepo();
    const wrapper = await writeScript(
      repo,
      "ssh wrapper.sh",
      `if [ "$1" = "-G" ]; then exit 0; fi\nexec git-upload-pack ${quote(repo)}`,
    );
    vi.stubEnv("GIT_SSH_COMMAND", undefined);
    vi.stubEnv("GIT_SSH", wrapper);
    await runGit(["remote", "add", "origin", "ssh://git.invalid/repo.git"], {
      cwd: repo,
    });

    await expect(
      fetchRemoteBranches(repo, { interactive: false, timeoutMs: 2_000 }),
    ).resolves.toEqual({ status: "fetched" });
    await expect(
      runGit(["rev-parse", "origin/main"], { cwd: repo }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it.each(["GIT_ASKPASS", "core.askPass", "SSH_ASKPASS"])(
    "suppresses %s on HTTP authentication while preserving explicit refresh prompts",
    async (setting) => {
      const repo = await initRepo();
      const log = path.join(repo, "prompts.log");
      const askpass = await writeScript(
        repo,
        "askpass.sh",
        `printf '%s\\n' "$*" >> ${quote(log)}\nprintf '%s\\n' fixture`,
      );
      await fs.writeFile(log, "");
      vi.stubEnv("GIT_ASKPASS", undefined);
      vi.stubEnv("SSH_ASKPASS", undefined);
      if (setting === "core.askPass") {
        await runGit(["config", "core.askPass", askpass], { cwd: repo });
      } else {
        vi.stubEnv(setting, askpass);
      }
      await runGit(["config", "credential.helper", ""], { cwd: repo });
      const server = http.createServer((_request, response) => {
        response.writeHead(401, {
          "WWW-Authenticate": 'Basic realm="fixture"',
        });
        response.end();
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected an HTTP listener address");
        }
        await runGit(
          [
            "remote",
            "add",
            "origin",
            `http://127.0.0.1:${address.port}/repo.git`,
          ],
          { cwd: repo },
        );
        await expect(
          fetchRemoteBranches(repo, { interactive: false, timeoutMs: 2_000 }),
        ).resolves.toEqual({ status: "failed" });
        expect(await fs.readFile(log, "utf8")).toBe("");

        await expect(
          fetchRemoteBranches(repo, { interactive: true, timeoutMs: 2_000 }),
        ).resolves.toEqual({ status: "failed" });
        expect(await fs.readFile(log, "utf8")).toContain("Username for");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills background transport descendants when a refresh times out",
    async () => {
      const repo = await initRepo();
      const marker = path.join(repo, "late-side-effect");
      const wrapper = await writeScript(
        repo,
        "slow-ssh.sh",
        `if [ "$1" = "-G" ]; then exit 0; fi\n(sleep 0.5; touch ${quote(marker)}) &\nwait`,
      );
      await runGit(["config", "core.sshCommand", quote(wrapper)], {
        cwd: repo,
      });
      await runGit(["remote", "add", "origin", "ssh://git.invalid/repo.git"], {
        cwd: repo,
      });
      await expect(
        fetchRemoteBranches(repo, { interactive: false, timeoutMs: 200 }),
      ).resolves.toEqual({ status: "failed" });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform === "win32")(
    "kills a started native SSH transport descendant when refresh times out",
    async () => {
      const repo = await initRepo();
      const ready = path.join(repo, "descendant-ready");
      const late = path.join(repo, "late-side-effect");
      const afterTimeout = path.join(repo, "after-timeout");
      const trace = path.join(repo, "git-trace.log");
      const transport = path.join(repo, "slow-ssh.js");
      await fs.writeFile(
        transport,
        [
          'const fs = require("node:fs");',
          'const { spawn } = require("node:child_process");',
          'if (process.argv.includes("-G")) process.exit(0);',
          `const child = spawn(process.execPath, ["-e", ${JSON.stringify('const fs = require("node:fs"); setInterval(() => { if (fs.existsSync(process.argv[1])) fs.writeFileSync(process.argv[2], "late"); }, 25);')}, ${JSON.stringify(afterTimeout)}, ${JSON.stringify(late)}], { stdio: "ignore", windowsHide: true });`,
          `fs.writeFileSync(${JSON.stringify(ready)}, String(child.pid));`,
          "setInterval(() => {}, 30000);",
        ].join("\n"),
      );
      const command = `"${process.execPath.replaceAll("\\", "/")}" "${transport.replaceAll("\\", "/")}"`;
      await runGit(["config", "core.sshCommand", command], { cwd: repo });
      await runGit(["remote", "add", "origin", "ssh://git.invalid/repo.git"], {
        cwd: repo,
      });
      vi.stubEnv("GIT_TRACE", trace);
      vi.stubEnv("GIT_SSH_VARIANT", "simple");

      const timeoutMs = 73_819;
      const nativeSetTimeout = globalThis.setTimeout;
      let triggerTimeout: (() => void) | undefined;
      const timeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) => {
          if (delay !== timeoutMs) {
            return nativeSetTimeout(callback, delay, ...args);
          }
          let fired = false;
          const invoke = () => {
            if (fired) return;
            fired = true;
            callback(...args);
          };
          const fallback = nativeSetTimeout(invoke, 20_000);
          triggerTimeout = () => {
            clearTimeout(fallback);
            invoke();
          };
          return fallback;
        });
      const fetch = fetchRemoteBranches(repo, {
        interactive: false,
        timeoutMs,
      });
      let descendantPid: number | null = null;
      let descendantGone = false;
      try {
        const deadline = Date.now() + 15_000;
        while (descendantPid === null && Date.now() < deadline) {
          const pidText = (
            await fs.readFile(ready, "utf8").catch(() => "")
          ).trim();
          if (/^\d+$/u.test(pidText)) descendantPid = Number(pidText);
          else await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (descendantPid === null) {
          throw new Error(
            `SSH descendant never started: ${await fs.readFile(trace, "utf8").catch(() => "no Git trace")}`,
          );
        }
        expect(await queryWindowsProcess(descendantPid ?? -1)).not.toBeNull();
        expect(triggerTimeout).toBeTypeOf("function");
        triggerTimeout?.();
        await expect(fetch).resolves.toEqual({ status: "failed" });
        await fs.writeFile(afterTimeout, "released");
        await new Promise((resolve) => setTimeout(resolve, 400));
        await expect(fs.access(late)).rejects.toMatchObject({ code: "ENOENT" });

        expect(await queryWindowsProcess(descendantPid ?? -1)).toBeNull();
        descendantGone = true;
      } finally {
        try {
          triggerTimeout?.();
          if (!descendantGone) {
            await killWindowsProcessesWithCwdUnder({
              directory: repo,
              runner: undefined,
              env: process.env,
              timeoutMs: undefined,
              selfPid: process.pid,
              onSkippedProcess: undefined,
            });
          }
        } finally {
          try {
            await fetch;
          } finally {
            timeoutSpy.mockRestore();
          }
        }
      }
    },
    45_000,
  );
});
