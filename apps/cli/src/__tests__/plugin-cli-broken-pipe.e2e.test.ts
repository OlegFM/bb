import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cliEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
const output = "record\n".repeat(100_000);

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

describe.skipIf(process.platform === "win32")(
  "plugin CLI process output",
  () => {
    it.each([
      ["fixture", "stdout", 0, true, null],
      ["fixture", "stderr", 0, true, null],
      ["plugin run fixture", "stdout", 0, true, null],
      ["plugin run fixture", "stderr", 0, true, null],
      ["fixture", "stdout", 7, true, null],
      ["fixture", "stdout", 0, false, null],
      ["fixture", "stdout", 1, false, "ENOSPC"],
      ["fixture", "stdout", 1, false, "generic stream failure"],
    ] as const)(
      "%s %s preserves exit %i (early close: %s, write error: %s)",
      async (command, channel, exitCode, earlyClose, writeError) => {
        let invocations = 0;
        const server = createServer((request, response) => {
          response.setHeader("content-type", "application/json");
          if (request.url === "/api/v1/plugins/contributions") {
            response.end(
              JSON.stringify({
                cliCommands: [
                  {
                    pluginId: "fixture",
                    name: "fixture",
                    summary: "Fixture",
                    commands: [],
                  },
                ],
              }),
            );
          } else if (request.url === "/api/v1/plugins/fixture/cli") {
            invocations += 1;
            request.resume();
            response.end(
              JSON.stringify({
                exitCode: writeError === null ? exitCode : 0,
                [channel]: output,
              }),
            );
          } else {
            response.statusCode = 404;
            response.end("{}");
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        try {
          const address = server.address();
          if (address === null || typeof address === "string")
            throw new Error("Missing fixture address");
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            BB_SERVER_URL: `http://127.0.0.1:${address.port}`,
          };
          for (const key of [
            "BB_CLI",
            "BB_CLI_REEXEC",
            "BB_PROJECT_ID",
            "BB_THREAD_ID",
          ])
            delete env[key];
          const injection =
            writeError === null
              ? ""
              : ` --import ${shellQuote(`data:text/javascript,${encodeURIComponent(`process.stdout._write = (_chunk, _encoding, callback) => callback(Object.assign(new Error(${JSON.stringify(writeError)}), { code: ${JSON.stringify(writeError)} }));`)}`)}`;
          const pipeline = `${shellQuote(process.execPath)} --conditions=source --import tsx${injection} ${shellQuote(cliEntry)} ${command} list${channel === "stderr" ? " 2>&1" : ""} | ${earlyClose ? "head -n 1" : "wc -c"}`;
          const result = await new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
            stdout: string;
            stderr: string;
            killed: boolean;
          }>((resolve, reject) => {
            const child = spawn(
              "/bin/bash",
              ["-o", "pipefail", "-c", pipeline],
              {
                cwd: repoRoot,
                env,
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let stdout = "";
            let stderr = "";
            let killed = false;
            child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
              stdout += chunk;
            });
            child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
              stderr += chunk;
            });
            const timer = setTimeout(() => {
              killed = true;
              if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
            }, 60_000);
            child.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once("close", (code, signal) => {
              clearTimeout(timer);
              resolve({ code, signal, stdout, stderr, killed });
            });
          });
          expect(result).toMatchObject({
            killed: false,
            signal: null,
            code: exitCode,
          });
          if (writeError === null) expect(result.stderr).toBe("");
          else expect(result.stderr).toContain(writeError);
          expect(result.code).toBe(exitCode);
          expect(result.stdout.trim()).toBe(
            earlyClose
              ? "record"
              : writeError === null
                ? String(Buffer.byteLength(output))
                : "0",
          );
          expect(invocations).toBe(1);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      65_000,
    );
  },
);

describe.runIf(process.platform === "win32")(
  "plugin CLI native process output",
  () => {
    it.each([
      ["fixture", "stdout", 0, true, null],
      ["fixture", "stderr", 0, true, null],
      ["plugin run fixture", "stdout", 0, true, null],
      ["plugin run fixture", "stderr", 0, true, null],
      ["fixture", "stdout", 7, true, null],
      ["fixture", "stdout", 0, false, null],
      ["fixture", "stderr", 0, false, null],
      ["fixture", "stdout", 1, false, "ENOSPC"],
      ["fixture", "stdout", 1, false, "generic stream failure"],
    ] as const)(
      "%s %s preserves exit %i (early close: %s, write error: %s)",
      async (command, channel, exitCode, earlyClose, writeError) => {
        const fixtureDir = await mkdtemp(join(tmpdir(), "bb-cli-pipe-"));
        let invocations = 0;
        const server = createServer((request, response) => {
          response.setHeader("content-type", "application/json");
          if (request.url === "/api/v1/plugins/contributions") {
            response.end(
              JSON.stringify({
                cliCommands: [
                  {
                    pluginId: "fixture",
                    name: "fixture",
                    summary: "Fixture",
                    commands: [],
                  },
                ],
              }),
            );
          } else if (
            request.url === "/api/v1/plugins/fixture/cli" &&
            request.method === "POST"
          ) {
            invocations += 1;
            request.resume();
            response.end(
              JSON.stringify({
                exitCode: writeError === null ? exitCode : 0,
                [channel]: output,
              }),
            );
          } else {
            response.statusCode = 404;
            response.end("{}");
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        try {
          const address = server.address();
          if (address === null || typeof address === "string") {
            throw new Error("Missing fixture address");
          }
          const env: NodeJS.ProcessEnv = { ...process.env };
          for (const key of Object.keys(env)) {
            if (
              /^BB_/iu.test(key) ||
              /^(?:NODE_OPTIONS|NPM_TOKEN|NODE_AUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN)$/iu.test(
                key,
              ) ||
              /^npm_config_.*(?:auth|token|password|username|otp)/iu.test(key)
            ) {
              delete env[key];
            }
          }
          env.BB_DATA_DIR = fixtureDir;
          env.BB_SERVER_URL = `http://127.0.0.1:${address.port}`;
          const args = ["--conditions=source", "--import", "tsx"];
          if (writeError !== null) {
            const script = `process.stdout._write = (_chunk, _encoding, callback) => callback(Object.assign(new Error(${JSON.stringify(writeError)}), { code: ${JSON.stringify(writeError)} }));`;
            args.push(
              "--import",
              `data:text/javascript,${encodeURIComponent(script)}`,
            );
          }
          args.push(cliEntry, ...command.split(" "), "list");
          const child = spawn(process.execPath, args, {
            cwd: repoRoot,
            env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          let firstLine = "";
          let readerClosed = false;
          let childClosed = false;
          let timedOut = false;
          let spawnError: Error | null = null;
          const selected = channel === "stdout" ? child.stdout : child.stderr;
          selected.setEncoding("utf8");
          selected.on("data", (chunk: string) => {
            if (earlyClose && firstLine === "") {
              firstLine = chunk.split("\n", 1)[0] ?? "";
              selected.destroy();
              return;
            }
            if (channel === "stdout") stdout += chunk;
            else stderr += chunk;
          });
          selected.once("close", () => {
            if (!childClosed && earlyClose) readerClosed = true;
          });
          const other = channel === "stdout" ? child.stderr : child.stdout;
          other.setEncoding("utf8").on("data", (chunk: string) => {
            if (channel === "stdout") stderr += chunk;
            else stdout += chunk;
          });
          child.once("error", (error) => {
            spawnError = error;
          });
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, 60_000);
          const result = await new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
          }>((resolve) => {
            child.once("close", (code, signal) => {
              childClosed = true;
              clearTimeout(timer);
              resolve({ code, signal });
            });
          });
          expect(spawnError).toBeNull();
          expect(timedOut).toBe(false);
          expect(result).toEqual({ code: exitCode, signal: null });
          expect(invocations).toBe(1);
          if (earlyClose) {
            expect(firstLine).toBe("record");
            expect(readerClosed).toBe(true);
          } else if (writeError === null) {
            expect(channel === "stdout" ? stdout : stderr).toBe(output);
          } else {
            expect(stdout).toBe("");
            expect(stderr).toContain(writeError);
          }
          if (writeError === null) {
            expect(channel === "stdout" ? stderr : stdout).toBe("");
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(fixtureDir, { recursive: true, force: true });
        }
      },
      65_000,
    );
  },
);
