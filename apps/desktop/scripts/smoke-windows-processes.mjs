import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDesktopReleaseConfig,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";
import { createPackagedAppLaunchArguments } from "./packaged-app-launch.mjs";
import { resolvePackagedAppBinary } from "./packaged-app-paths.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDirectory, "..");
const releaseDir = join(desktopPackageRoot, "release");
const startupTimeoutMs = 120_000;
const quitTimeoutMs = 30_000;
const settleMs = 2_000;
const pollIntervalMs = 500;
const interestingImages = new Set([
  "bb.exe",
  "bb nightly.exe",
  "node.exe",
  "pwsh.exe",
  "powershell.exe",
  "cmd.exe",
  "conhost.exe",
]);

function sleep(delayMs) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

export function parseEvidenceDir(argv) {
  const flagIndex = argv.indexOf("--evidence-dir");
  if (flagIndex !== -1 && flagIndex + 1 < argv.length) {
    return argv[flagIndex + 1];
  }
  return join("qa-artifacts", "process-hygiene");
}

function windowsSystemToolPath(name) {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

function runPowerShellJson(script) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      windowsSystemToolPath(
        join("WindowsPowerShell", "v1.0", "powershell.exe"),
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(
            `powershell exited with ${String(code)}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
        return;
      }
      const text = Buffer.concat(stdout).toString("utf8").trim();
      resolvePromise(text.length === 0 ? [] : JSON.parse(text));
    });
  });
}

async function snapshotProcesses() {
  const rows = await runPowerShellJson(
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, @{ Name = 'CreationDate'; Expression = { $_.CreationDate.ToString('o') } }) | ConvertTo-Json -Compress -Depth 2",
  );
  return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
    commandLine: typeof row.CommandLine === "string" ? row.CommandLine : "",
    creationDate: typeof row.CreationDate === "string" ? row.CreationDate : "",
    name: typeof row.Name === "string" ? row.Name.toLowerCase() : "",
    parentPid: Number(row.ParentProcessId),
    pid: Number(row.ProcessId),
  }));
}

export function descendantsOf(rows, rootPid) {
  const children = new Map();
  for (const row of rows) {
    const siblings = children.get(row.parentPid) ?? [];
    siblings.push(row);
    children.set(row.parentPid, siblings);
  }
  const result = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop();
    for (const row of children.get(pid) ?? []) {
      result.push(row);
      pending.push(row.pid);
    }
  }
  return result;
}

async function findFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          rejectPromise(new Error("No TCP port allocated"));
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}

async function waitForHealth(serverUrl, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return false;
    }
    try {
      const response = await fetch(`${serverUrl}/health`);
      if (response.ok) {
        return true;
      }
    } catch {}
    await sleep(pollIntervalMs);
  }
  return false;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once("exit", onExit);
  });
}

function taskkillTree(pid) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      windowsSystemToolPath("taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", () => resolvePromise());
    child.once("exit", () => resolvePromise());
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function smokeWindowsProcesses() {
  if (process.platform !== "win32") {
    throw new Error(
      `The Windows process-hygiene smoke requires win32, got ${process.platform}.`,
    );
  }
  const evidenceDir = resolve(process.cwd(), parseEvidenceDir(process.argv));
  await mkdir(evidenceDir, { recursive: true });
  const releaseConfig = createDesktopReleaseConfig(
    resolveDesktopReleaseChannel(process.env),
  );
  const appBinary = await resolvePackagedAppBinary({
    executableName: releaseConfig.linuxExecutableName,
    platform: process.platform,
    productName: releaseConfig.applicationName,
    releaseDir,
  });
  const smokeRoot = await mkdtemp(join(tmpdir(), "bb-win-process-smoke-"));
  const dataDir = join(smokeRoot, "data");
  const userDataDir = join(smokeRoot, "user-data");
  const quitRequestFile = join(smokeRoot, "quit-request");
  const serverPort = await findFreePort();
  const daemonPort = await findFreePort();
  const serverUrl = `http://127.0.0.1:${String(serverPort)}`;
  const failures = [];

  const bystander = spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { stdio: "ignore", windowsHide: true },
  );
  if (bystander.pid === undefined) {
    throw new Error("Bystander process did not expose a PID.");
  }
  console.log(`Process hygiene smoke: bystander pid ${String(bystander.pid)}.`);

  const before = await snapshotProcesses();
  await writeJson(join(evidenceDir, "before.json"), before);

  const childEnv = {
    ...process.env,
    BB_DATA_DIR: dataDir,
    BB_DESKTOP_ATTACH_WITHOUT_PROMPT: "1",
    BB_DESKTOP_OPEN_DEVTOOLS: "0",
    BB_DESKTOP_QUIT_REQUEST_FILE: quitRequestFile,
    BB_HOST_DAEMON_PORT: String(daemonPort),
    BB_SERVER_PORT: String(serverPort),
  };
  delete childEnv.BB_DESKTOP_APP_URL;
  delete childEnv.BB_DESKTOP_NODE_EXEC_PATH;
  delete childEnv.BB_DESKTOP_VERSION_FEED_URL;
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(
    appBinary,
    createPackagedAppLaunchArguments({
      platform: process.platform,
      userDataDir,
    }),
    { env: childEnv, stdio: "ignore" },
  );
  if (child.pid === undefined) {
    throw new Error("Packaged app did not expose a PID.");
  }
  console.log(
    `Process hygiene smoke: app pid ${String(child.pid)} → ${serverUrl}`,
  );

  let during = [];
  try {
    const healthy = await waitForHealth(serverUrl, child, startupTimeoutMs);
    if (!healthy) {
      failures.push(
        `Owned runtime never answered ${serverUrl}/health within ${String(startupTimeoutMs)}ms (app exit code ${String(child.exitCode)}).`,
      );
    } else {
      const snapshot = await snapshotProcesses();
      during = descendantsOf(snapshot, child.pid);
      await writeJson(join(evidenceDir, "during.json"), during);
      console.log(
        `Process hygiene smoke: ${String(during.length)} descendant processes while running.`,
      );
      if (
        !during.some((row) => row.commandLine.includes("bb-app-bridge.mjs"))
      ) {
        failures.push("No bb-app bridge process found under the app.");
      }
      await writeFile(quitRequestFile, "quit\n", "utf8");
      const exited = await waitForExit(child, quitTimeoutMs);
      if (!exited) {
        failures.push(
          `App pid ${String(child.pid)} ignored the quit request within ${String(quitTimeoutMs)}ms.`,
        );
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await taskkillTree(child.pid);
      await waitForExit(child, 10_000);
    }
  }

  await sleep(settleMs);
  const after = await snapshotProcesses();
  await writeJson(join(evidenceDir, "after.json"), after);
  const afterByPid = new Map(after.map((row) => [row.pid, row]));
  const survivors = during.filter((row) => {
    const now = afterByPid.get(row.pid);
    return now !== undefined && now.creationDate === row.creationDate;
  });
  const beforePids = new Set(before.map((row) => row.pid));
  const strays = after.filter(
    (row) =>
      !beforePids.has(row.pid) &&
      row.pid !== process.pid &&
      row.pid !== bystander.pid &&
      interestingImages.has(row.name) &&
      (row.commandLine.includes(dataDir) ||
        row.commandLine.includes("bb-app-bridge.mjs") ||
        row.commandLine.includes(userDataDir)),
  );
  for (const row of [...survivors, ...strays]) {
    failures.push(
      `Leaked process after quit: ${row.name} (${String(row.pid)}) ${row.commandLine}`,
    );
  }
  if (!isAlive(bystander.pid)) {
    failures.push("The unrelated bystander process was killed during the run.");
  }
  bystander.kill();

  await writeJson(join(evidenceDir, "summary.json"), {
    appBinary,
    appPid: child.pid,
    bystanderPid: bystander.pid,
    descendantsWhileRunning: during.length,
    failures,
    serverUrl,
    strays: strays.map((row) => row.pid),
    survivors: survivors.map((row) => row.pid),
  });
  await rm(smokeRoot, { force: true, recursive: true }).catch(() => undefined);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`FAILED process-hygiene: ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Process hygiene smoke passed: no leaked processes.");
}

await smokeWindowsProcesses().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
