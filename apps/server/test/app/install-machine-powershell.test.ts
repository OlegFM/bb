import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBundledNpmCli } from "@bb/plugin-build";

const installer = fileURLToPath(
  new URL("../../src/assets/install-machine.ps1", import.meta.url),
);
const wrapper = fileURLToPath(
  new URL("../fixtures/install-machine-wrapper.ps1", import.meta.url),
);
const npm = resolveBundledNpmCli();
const shells = ["powershell.exe", "pwsh.exe"];
let scratch: string;
let artifact: Buffer;

function run(command: string, args: string[], env = process.env) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, { env, windowsHide: true });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    },
  );
}

beforeAll(async () => {
  if (process.platform !== "win32") return;
  scratch = mkdtempSync(join(tmpdir(), "bb-installer-"));
  const pkg = join(scratch, "package");
  mkdirSync(pkg);
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "bb-app",
      version: "0.0.0",
      bin: { "bb-app": "dist/bb-app.js", bb: "dist/bb.js" },
      scripts: { postinstall: "node setup.cjs" },
    }),
  );
  writeFileSync(
    join(pkg, "setup.cjs"),
    `const fs=require('fs'); for(const name of ['node-pty','@parcel/watcher']) { const dir='node_modules/'+name;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/index.js',process.env.BB_FIXTURE_NATIVE_FAIL?'throw new Error("native failure")':'module.exports={}'); }`,
  );
  mkdirSync(join(pkg, "dist"));
  mkdirSync(join(pkg, "host-daemon/dist"), { recursive: true });
  writeFileSync(join(pkg, "host-daemon/dist/daemon-bundle.mjs"), "export {};");
  writeFileSync(
    join(pkg, "dist/bb.js"),
    `const fs=require('fs'),path=require('path');const args=process.argv.slice(2);if(args[0]!=='machine'||args[1]!=='enroll'||args[2]!=='--bootstrap-env')process.exit(1);const bootstrap=JSON.parse(process.env[args[3]]);const data=process.env.BB_DATA_DIR;fs.writeFileSync(path.join(data,'auth.json'),JSON.stringify({hostId:bootstrap.hostId,hostKey:'fixture'}));fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({serverUrl:bootstrap.serverUrl}));fs.writeFileSync(path.join(data,'host-id'),bootstrap.hostId+'\\n');`,
  );
  writeFileSync(
    join(pkg, "dist/bb-app.js"),
    `const fs=require('fs'),http=require('http'),path=require('path');console.error('fixture normal daemon stderr');const args=process.argv.slice(2);const get=(flag)=>args[args.indexOf(flag)+1];const data=process.env.BB_DATA_DIR;const auth=JSON.parse(fs.readFileSync(path.join(data,'auth.json'),'utf8'));fs.writeFileSync(path.join(data,'fixture.pid'),String(process.pid));if(fs.existsSync(path.join(data,'fixture-pause'))){setInterval(()=>{},1000);}else{http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({hostId:auth.hostId,serverUrl:get('--server-url'),connected:true}));}).listen(Number(get('--host-daemon-port')),'127.0.0.1');}`,
  );
  const packed = await run(process.execPath, [
    npm,
    "pack",
    pkg,
    "--pack-destination",
    scratch,
    "--ignore-scripts",
  ]);
  if (packed.code !== 0) throw new Error(packed.output);
  artifact = readFileSync(join(scratch, "bb-app-0.0.0.tgz"));
}, 30_000);
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32").each(shells)(
  "Windows installer in %s",
  (shell) => {
    async function scenario(
      mode: string,
      args: string[] = [],
      denyTask = false,
      storedPort?: number,
      bystanderPid?: number,
    ) {
      const root = mkdtempSync(
        join(
          scratch,
          mode === "smart-quote-path"
            ? "данные с пробелом \u2018left\u2019right\u201alow\u201breversed "
            : "данные с пробелом ",
        ),
      );
      const data = join(root, "profile");
      const junctionTarget = join(root, "junction-target");
      if (mode.startsWith("junction")) {
        mkdirSync(junctionTarget);
        writeFileSync(join(junctionTarget, "marker"), "unchanged");
        symlinkSync(junctionTarget, join(root, ".bb-machines"), "junction");
      }
      let servedArtifact = artifact;
      let serverUnavailable = false;
      if (mode === "foreign-task")
        writeFileSync(
          join(root, "task.json"),
          JSON.stringify({
            Action: { Execute: "foreign.exe", Argument: "foreign launcher" },
          }),
        );
      if (mode === "foreign-run")
        writeFileSync(
          join(root, "run.json"),
          JSON.stringify({ Value: "foreign launcher" }),
        );
      if (storedPort) {
        mkdirSync(data);
        writeFileSync(join(data, "host-daemon-port"), String(storedPort));
      }
      const requests: string[] = [];
      const server = createServer((req, res) => {
        requests.push(req.url ?? "");
        if (mode === "unavailable" || serverUnavailable) {
          res.writeHead(404);
          res.end();
          return;
        }
        const servedDigest = createHash("sha256")
          .update(servedArtifact)
          .digest("hex");
        if (mode !== "missing")
          res.setHeader(
            "x-bb-artifact-sha256",
            mode === "mismatch" ? "0".repeat(64) : servedDigest,
          );
        if (req.headers["if-none-match"] === `"sha256-${servedDigest}"`) {
          res.writeHead(304);
          res.end();
          return;
        }
        res.end(servedArtifact);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No server port");
      const origin = `http://127.0.0.1:${address.port}`;
      const env = {
        ...process.env,
        BB_DATA_DIR: mode === "junction-default" ? "" : data,
        USERPROFILE: root,
        LOCALAPPDATA: root,
        BB_FIXTURE_ORIGIN: origin,
        BB_FIXTURE_NATIVE_FAIL: mode === "native" ? "1" : "",
        BB_ENROLLMENT: JSON.stringify({
          hostId: "host-fixture",
          serverUrl: origin,
          credential: "private-enrollment-token",
          expiresAt: Date.now() + 60 * 60 * 1000,
        }),
        BB_APP_NPM_PREFIX: "preserve-me",
      };
      const invoke = (extra: string[] = []) =>
        run(
          shell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            wrapper,
            "-Installer",
            installer,
            "-FixtureDirectory",
            root,
            ...(denyTask ? ["-DenyTask"] : []),
            ...(mode === "folder-only" ? ["-FolderOnly"] : []),
            ...(bystanderPid ? ["-BystanderPid", String(bystanderPid)] : []),
            ...(mode.startsWith("junction")
              ? ["-JunctionTarget", junctionTarget]
              : []),
            "-BootstrapEnv",
            "BB_ENROLLMENT",
            ...args,
            ...extra.filter(
              (value) => value !== "-HostId" && value !== "different",
            ),
          ],
          extra.includes("-HostId")
            ? {
                ...env,
                BB_ENROLLMENT: JSON.stringify({
                  hostId: "different",
                  serverUrl: origin,
                  credential: "private-enrollment-token",
                  expiresAt: Date.now() + 60 * 60 * 1000,
                }),
              }
            : env,
        );
      try {
        const result = await invoke();
        if (result.code !== 0 && existsSync(join(data, "logs/supervisor.log")))
          result.output +=
            "\nSupervisor log:\n" +
            readFileSync(join(data, "logs/supervisor.log"), "utf8");
        return {
          result,
          data,
          root,
          requests,
          invoke,
          changeArtifact: () => {
            servedArtifact = Buffer.concat([artifact, Buffer.from("changed")]);
          },
          makeUnavailable: () => {
            serverUnavailable = true;
          },
          cleanup: async () => {
            const identityDeadline = Date.now() + 3000;
            while (
              existsSync(join(data, "install-supervisor.pid")) &&
              !existsSync(join(data, "supervisor.json")) &&
              Date.now() < identityDeadline
            )
              await new Promise((resolve) => setTimeout(resolve, 100));
            if (
              existsSync(join(data, "stop-host-daemon.ps1")) &&
              existsSync(join(data, "supervisor.json"))
            ) {
              const stopped = await run(
                shell,
                [
                  "-NoProfile",
                  "-NonInteractive",
                  "-ExecutionPolicy",
                  "Bypass",
                  "-File",
                  join(data, "stop-host-daemon.ps1"),
                ],
                env,
              );
              expect(stopped.code, stopped.output).toBe(0);
            } else if (existsSync(join(data, "supervisor.json"))) {
              const identity: { pid: number } = JSON.parse(
                readFileSync(join(data, "supervisor.json"), "utf8"),
              );
              await run(
                join(
                  process.env.SystemRoot ?? "C:/Windows",
                  "System32/taskkill.exe",
                ),
                ["/PID", String(identity.pid), "/T", "/F"],
              );
            }
            if (existsSync(join(data, "fixture.pid"))) {
              try {
                process.kill(
                  Number(readFileSync(join(data, "fixture.pid"), "utf8")),
                );
              } catch {}
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
          },
        };
      } catch (error) {
        server.close();
        throw error;
      }
    }

    it.each(
      [
        [],
        ["-BootstrapEnv", "bad-name"],
        ["-BootstrapEnv", "BB_ENROLLMENT"],
      ].map((args) => ({ args })),
    )("rejects unsupported arguments %j", async ({ args }) => {
      const result = await run(shell, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installer,
        ...args,
      ]);
      expect(result.code).not.toBe(0);
      expect(result.output.replace(/\r?\n/gu, "")).toMatch(
        /BootstrapEnv|bootstrap environment/iu,
      );
    });
    it.each(["missing", "mismatch", "unavailable", "native"])(
      "fails closed for %s",
      async (mode) => {
        const test = await scenario(mode);
        try {
          expect(test.result.code, test.result.output).not.toBe(0);
          expect(test.result.output).toMatch(/SHA-256|artifact|native/i);
          expect(existsSync(join(test.data, "host-artifact.sha256"))).toBe(
            false,
          );
          expect(existsSync(join(test.root, "task.json"))).toBe(false);
          expect(existsSync(join(test.root, "run.json"))).toBe(false);
        } finally {
          await test.cleanup();
        }
      },
      40_000,
    );
    it("prints help without changing enrollment", async () => {
      const result = await run(shell, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installer,
        "-Help",
      ]);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("-HostDaemonPort");
    });
    it.each(["C:\\", "\\\\server\\share", "C:\\data:stream"])(
      "rejects unsafe data path %s before mutation",
      async (data) => {
        const result = await run(
          shell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            installer,
            "-BootstrapEnv",
            "BB_ENROLLMENT",
          ],
          {
            ...process.env,
            BB_DATA_DIR: data,
            BB_ENROLLMENT: JSON.stringify({
              hostId: "host-fixture",
              serverUrl: "https://example.test",
              credential: "private-enrollment-token",
              expiresAt: Date.now() + 60_000,
            }),
          },
        );
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toMatch(/data paths|drive-local path/i);
      },
    );
    it("preserves smart-quote data paths through enrollment and rerun", async () => {
      const test = await scenario("smart-quote-path");
      try {
        expect(test.result.code, test.result.output).toBe(0);
        expect(
          JSON.parse(readFileSync(join(test.data, "auth.json"), "utf8")),
        ).toMatchObject({ hostId: "host-fixture" });
        const daemonPid = readFileSync(join(test.data, "fixture.pid"), "utf8");
        const port = readFileSync(join(test.data, "host-daemon-port"), "utf8");
        const repeated = await test.invoke();
        expect(repeated.code, repeated.output).toBe(0);
        expect(readFileSync(join(test.data, "fixture.pid"), "utf8")).toBe(
          daemonPid,
        );
        expect(readFileSync(join(test.data, "host-daemon-port"), "utf8")).toBe(
          port,
        );
        expect(existsSync(join(test.root, "task.json"))).toBe(true);
        expect(existsSync(join(test.root, "run.json"))).toBe(false);
      } finally {
        await test.cleanup();
      }
    }, 60_000);
    it.each([false, true])(
      "installs privately and reuses the artifact with task denied=%s",
      async (denyTask) => {
        const test = await scenario("success", [], denyTask);
        try {
          expect(test.result.code, test.result.output).toBe(0);
          const launcher = readFileSync(
            join(test.data, "start-host-daemon.ps1"),
            "utf8",
          );
          expect(launcher).not.toContain("private-enrollment-token");
          expect(launcher).toContain(test.data.replaceAll("'", "''"));
          expect(
            JSON.parse(
              readFileSync(join(test.root, "environment.json"), "utf8"),
            ),
          ).toEqual({ data: true, prefix: true });
          const acl: { protected: boolean; rules: string[]; user: string } =
            JSON.parse(readFileSync(join(test.root, "acl.json"), "utf8"));
          expect(acl.protected).toBe(true);
          expect(acl.rules).toEqual([acl.user]);
          expect(
            existsSync(join(test.root, denyTask ? "run.json" : "task.json")),
          ).toBe(true);
          expect(
            existsSync(join(test.root, denyTask ? "task.json" : "run.json")),
          ).toBe(false);
          const repeated = await test.invoke();
          expect(repeated.code, repeated.output).toBe(0);
          expect(repeated.output).toMatch(/identical|already installed/i);
          const previousPid = Number(
            readFileSync(join(test.data, "fixture.pid"), "utf8"),
          );
          process.kill(previousPid);
          const deadline = Date.now() + 8000;
          let nextPid = previousPid;
          while (Date.now() < deadline && nextPid === previousPid) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            nextPid = Number(
              readFileSync(join(test.data, "fixture.pid"), "utf8"),
            );
          }
          expect(nextPid).not.toBe(previousPid);
          const incompatible = await test.invoke(["-HostId", "different"]);
          expect(incompatible.code).not.toBe(0);
          expect(incompatible.output).toMatch(/different|incompatible/i);
          const installedDigest = readFileSync(
            join(test.data, "host-artifact.sha256"),
            "utf8",
          );
          test.makeUnavailable();
          const unavailable = await test.invoke();
          expect(unavailable.code, unavailable.output).not.toBe(0);
          expect(unavailable.output).toMatch(/artifact is unavailable/i);
          expect(
            readFileSync(join(test.data, "host-artifact.sha256"), "utf8"),
          ).toBe(installedDigest);
        } finally {
          await test.cleanup();
        }
      },
      60_000,
    );
    it("repairs a folder-only ACL before creating private credentials", async () => {
      const test = await scenario("folder-only");
      try {
        expect(test.result.code, test.result.output).toBe(0);
        const acl: { rules: string[]; user: string } = JSON.parse(
          readFileSync(join(test.root, "acl.json"), "utf8"),
        );
        expect(acl.rules).toEqual([acl.user]);
      } finally {
        await test.cleanup();
      }
    }, 40_000);
    it("does not stop a bystander whose PID fails supervisor validation", async () => {
      const bystander = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { stdio: "ignore", windowsHide: true },
      );
      if (!bystander.pid) throw new Error("No bystander PID");
      const test = await scenario(
        "success",
        [],
        false,
        undefined,
        bystander.pid,
      );
      try {
        expect(test.result.code, test.result.output).not.toBe(0);
        expect(test.result.output.replaceAll(/\r?\n/gu, "")).toMatch(
          /New supervisor process identity/i,
        );
        expect(bystander.exitCode).toBeNull();
        expect(bystander.killed).toBe(false);
      } finally {
        await test.cleanup();
        bystander.kill();
      }
    }, 40_000);
    it.each(["junction-default", "junction-registry"])(
      "rejects derived junction paths without changing their targets: %s",
      async (mode) => {
        const test = await scenario(mode);
        try {
          expect(test.result.code, test.result.output).not.toBe(0);
          expect(test.result.output).toMatch(/reparse/i);
          expect(
            readFileSync(join(test.root, "junction-target/marker"), "utf8"),
          ).toBe("unchanged");
          const acl: { before: string; after: string } = JSON.parse(
            readFileSync(join(test.root, "junction-acl.json"), "utf8"),
          );
          expect(acl.after).toBe(acl.before);
        } finally {
          await test.cleanup();
        }
      },
      30_000,
    );
    it("preserves live port metadata and refuses prefix repair without status", async () => {
      const test = await scenario("success");
      try {
        expect(test.result.code, test.result.output).toBe(0);
        const previousPort = readFileSync(
          join(test.data, "host-daemon-port"),
          "utf8",
        );
        const refusedPort = await test.invoke([
          "-HostDaemonPort",
          previousPort === "39900" ? "39901" : "39900",
        ]);
        expect(refusedPort.code, refusedPort.output).not.toBe(0);
        expect(refusedPort.output.replaceAll(/\r?\n/gu, "")).toMatch(
          /live supervisor/i,
        );
        expect(readFileSync(join(test.data, "host-daemon-port"), "utf8")).toBe(
          previousPort,
        );
        const pid = Number(
          readFileSync(join(test.data, "fixture.pid"), "utf8"),
        );
        writeFileSync(join(test.data, "fixture-pause"), "");
        process.kill(pid);
        const deadline = Date.now() + 8000;
        while (
          Date.now() < deadline &&
          Number(readFileSync(join(test.data, "fixture.pid"), "utf8")) === pid
        )
          await new Promise((resolve) => setTimeout(resolve, 200));
        await expect(
          fetch(`http://127.0.0.1:${previousPort}/status`, {
            signal: AbortSignal.timeout(1000),
          }),
        ).rejects.toThrow();
        const oldDigest = readFileSync(
          join(test.data, "host-artifact.sha256"),
          "utf8",
        );
        test.changeArtifact();
        const refusedArtifact = await test.invoke();
        expect(refusedArtifact.code, refusedArtifact.output).not.toBe(0);
        expect(refusedArtifact.output.replaceAll(/\r?\n/gu, "")).toMatch(
          /live supervisor/i,
        );
        expect(
          readFileSync(join(test.data, "host-artifact.sha256"), "utf8"),
        ).toBe(oldDigest);
        rmSync(join(test.data, "host-artifact.sha256"));
        const refusedRepair = await test.invoke();
        expect(refusedRepair.code, refusedRepair.output).not.toBe(0);
        expect(refusedRepair.output.replaceAll(/\r?\n/gu, "")).toMatch(
          /live supervisor/i,
        );
        const reservationPath = join(
          test.root,
          ".bb-machines/host-daemon-ports",
          previousPort,
        );
        const oldReservation = readFileSync(reservationPath, "utf8");
        const unrelated = createServer((_req, res) => res.end("unrelated"));
        await new Promise<void>((resolve) =>
          unrelated.listen(Number(previousPort), "127.0.0.1", resolve),
        );
        try {
          const refusedCollision = await test.invoke();
          expect(refusedCollision.code, refusedCollision.output).not.toBe(0);
          expect(refusedCollision.output.replaceAll(/\r?\n/gu, "")).toMatch(
            /unrelated listener holds the live supervisor port/i,
          );
          expect(
            readFileSync(join(test.data, "host-daemon-port"), "utf8"),
          ).toBe(previousPort);
          expect(readFileSync(reservationPath, "utf8")).toBe(oldReservation);
          expect(unrelated.listening).toBe(true);
        } finally {
          await new Promise<void>((resolve) =>
            unrelated.close(() => resolve()),
          );
        }
        const registry = dirname(reservationPath);
        const reservationsBefore = readdirSync(registry).sort();
        const foreignReservation = join(test.root, "foreign-enrollment");
        writeFileSync(reservationPath, foreignReservation);
        const refusedReservation = await test.invoke();
        expect(refusedReservation.code, refusedReservation.output).not.toBe(0);
        expect(readFileSync(join(test.data, "host-daemon-port"), "utf8")).toBe(
          previousPort,
        );
        expect(readFileSync(reservationPath, "utf8")).toBe(foreignReservation);
        expect(readdirSync(registry).sort()).toEqual(reservationsBefore);
        expect(refusedReservation.output.replaceAll(/\r?\n/gu, "")).toMatch(
          /live supervisor.*reservation/i,
        );
      } finally {
        await test.cleanup();
      }
    }, 50_000);
    it.each(["foreign-task", "foreign-run"])(
      "preserves another enrollment startup: %s",
      async (mode) => {
        const test = await scenario(mode);
        try {
          expect(test.result.code, test.result.output).not.toBe(0);
          expect(test.result.output).toMatch(/another enrollment/i);
          expect(
            readFileSync(
              join(
                test.root,
                mode === "foreign-task" ? "task.json" : "run.json",
              ),
              "utf8",
            ),
          ).toContain("foreign launcher");
        } finally {
          await test.cleanup();
        }
      },
      40_000,
    );
    it("reassigns a stale occupied port without stopping its listener", async () => {
      const listener = createServer((_req, res) => res.end("unrelated"));
      await new Promise<void>((resolve) =>
        listener.listen(0, "127.0.0.1", resolve),
      );
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const test = await scenario("success", [], false, address.port);
      try {
        expect(test.result.code, test.result.output).toBe(0);
        expect(
          Number(readFileSync(join(test.data, "host-daemon-port"), "utf8")),
        ).not.toBe(address.port);
        expect(listener.listening).toBe(true);
      } finally {
        await test.cleanup();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
    }, 40_000);
    it("never stops an unrelated listener on an explicit port", async () => {
      const listener = createServer((_req, res) => res.end("unrelated"));
      await new Promise<void>((resolve) =>
        listener.listen(0, "127.0.0.1", resolve),
      );
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const test = await scenario("success", [
        "-HostDaemonPort",
        String(address.port),
      ]);
      try {
        expect(test.result.code, test.result.output).not.toBe(0);
        expect(test.result.output).toMatch(/in use|occupied/i);
        expect(listener.listening).toBe(true);
      } finally {
        await test.cleanup();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
    }, 30_000);
  },
);
