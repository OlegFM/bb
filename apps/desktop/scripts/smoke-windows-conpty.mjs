import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { taskkillTreeSync } from "./smoke-windows-process-tools.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..", "..", "..");
const stepTimeoutMs = 10_000;
const shellStartupMs = 3_000;
const pollIntervalMs = 100;
const outputTailLength = 1_500;
const acceptableKillExitCodes = new Set([0, -1073741510]);

function sleep(delayMs) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

function outputTail(output) {
  return output.slice(-outputTailLength);
}

async function pollUntil({ check, deadlineMs, intervalMs = pollIntervalMs }) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() <= deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await sleep(intervalMs);
  }
  return null;
}

async function waitForPattern(getOutput, pattern, timeoutMs) {
  return pollUntil({
    check: () => getOutput().match(pattern),
    deadlineMs: timeoutMs,
  });
}

async function waitForExit(exitPromise, timeoutMs) {
  return await Promise.race([
    exitPromise.then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function waitForCondition(predicate, timeoutMs) {
  const matched = await pollUntil({
    check: () => (predicate() ? true : null),
    deadlineMs: timeoutMs,
  });
  return matched === true;
}

function countOccurrences(haystack, needle) {
  if (needle === "") {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + needle.length;
  }
}

async function waitForShellPid(pty, timeoutMs) {
  const pid = await pollUntil({
    check: () => {
      const value = pty.pid;
      return typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : null;
    },
    deadlineMs: timeoutMs,
  });
  if (pid === null) {
    throw new Error(
      `node-pty never reported a usable PID (last saw ${String(pty.pid)}).`,
    );
  }
  return pid;
}

async function readTasklist(pid) {
  const { stdout } = await execFileAsync(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe"),
    ["/FI", `PID eq ${String(pid)}`, "/FO", "CSV", "/NH"],
  );
  return stdout;
}

function tasklistContainsPid(tasklistStdout, pid) {
  return tasklistStdout.includes(`"${String(pid)}"`);
}

async function waitForPidInTasklist(pid, present, timeoutMs) {
  const matched = await pollUntil({
    check: async () => {
      let stdout = "";
      try {
        stdout = await readTasklist(pid);
      } catch {
        stdout = "";
      }
      return tasklistContainsPid(stdout, pid) === present ? true : null;
    },
    deadlineMs: timeoutMs,
  });
  return matched === true;
}

function readWindowsEnvValue(env, name) {
  const direct = env[name];
  if (direct !== undefined) {
    return direct;
  }
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowered && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function windowsExecutableExtensions(pathext) {
  const raw =
    pathext === undefined || pathext.trim() === ""
      ? ".COM;.EXE;.BAT;.CMD;.PS1"
      : pathext;
  const extensions = [];
  for (const entry of raw.split(";")) {
    const trimmed = entry.trim().toLowerCase();
    if (trimmed === "") {
      continue;
    }
    const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    if (!extensions.includes(withDot)) {
      extensions.push(withDot);
    }
  }
  return extensions;
}

function fileExistsSync(candidate) {
  try {
    accessSync(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const windowsConsoleImageExtensions = new Set([".com", ".exe"]);

function findPwshOnPath(env) {
  const pathValue = readWindowsEnvValue(env, "Path") ?? "";
  const extensions = windowsExecutableExtensions(
    readWindowsEnvValue(env, "PATHEXT"),
  ).filter((extension) => windowsConsoleImageExtensions.has(extension));
  for (const rawEntry of pathValue.split(";")) {
    const entry = rawEntry.trim().replace(/^"+|"+$/gu, "");
    if (entry === "") {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(entry, `pwsh${extension}`);
      if (fileExistsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveShellFile(env) {
  const onPath = findPwshOnPath(env);
  if (onPath !== null) {
    return onPath;
  }
  const programFiles = readWindowsEnvValue(env, "ProgramFiles");
  if (programFiles !== undefined) {
    const candidate = join(programFiles, "PowerShell", "7", "pwsh.exe");
    if (fileExistsSync(candidate)) {
      return candidate;
    }
  }
  const systemRoot = readWindowsEnvValue(env, "SystemRoot") ?? "C:\\Windows";
  return join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function spawnShell(nodePty, shellFile) {
  const pty = nodePty.spawn(shellFile, ["-NoLogo"], {
    cols: 80,
    rows: 30,
    cwd: tmpdir(),
    env: process.env,
  });
  let output = "";
  let exited = false;
  let exitCode = null;
  const exit = new Promise((resolveExit) => {
    pty.onExit((event) => {
      exited = true;
      exitCode = event?.exitCode ?? null;
      resolveExit();
    });
  });
  pty.onData((data) => {
    output += data;
  });
  return {
    exit,
    getExitCode: () => exitCode,
    getOutput: () => output,
    isExited: () => exited,
    pty,
  };
}

function releasePty(pty) {
  const destroy = pty.destroy;
  if (typeof destroy === "function") {
    try {
      destroy.apply(pty);
    } catch {}
    return;
  }
  if (typeof pty.dispose === "function") {
    try {
      pty.dispose();
    } catch {}
  }
}

async function destroyShell(session) {
  try {
    session.pty.kill();
  } catch {}
  await Promise.race([session.exit, sleep(5_000)]);
  const pid = session.pty.pid;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    taskkillTreeSync(pid);
    await Promise.race([session.exit, sleep(5_000)]);
  }
  releasePty(session.pty);
}

const results = [];

async function runCheck(name, run) {
  let session = null;
  try {
    const outcome = await run();
    session = outcome.session ?? null;
    results.push({ name, ok: true });
    console.log(
      `check ${name}: ok${outcome.detail ? ` ${outcome.detail}` : ""}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false });
    console.log(`check ${name}: fail ${message}`);
  } finally {
    if (session !== null) {
      await destroyShell(session);
    }
  }
}

async function runSpawnEcho(nodePty, shellFile) {
  const session = spawnShell(nodePty, shellFile);
  try {
    await sleep(shellStartupMs);
    if (session.isExited()) {
      throw new Error(
        `Shell exited during startup.\noutput tail:\n${outputTail(session.getOutput())}`,
      );
    }
    const pid = await waitForShellPid(session.pty, 2_000);
    session.pty.write(Buffer.from("Write-Output ('BB_' + 'WN_OK')\r", "utf8"));
    const match = await waitForPattern(
      session.getOutput,
      /BB_WN_OK/,
      stepTimeoutMs,
    );
    if (match === null) {
      throw new Error(
        `BB_WN_OK never appeared in shell output.\noutput tail:\n${outputTail(session.getOutput())}`,
      );
    }
    return { detail: `pid=${String(pid)}`, session };
  } catch (error) {
    await destroyShell(session);
    throw error;
  }
}

async function runUtf8(nodePty, shellFile) {
  const session = spawnShell(nodePty, shellFile);
  try {
    await sleep(shellStartupMs);
    session.pty.write(Buffer.from("Write-Output ('dise' + 'ño ✓')\r", "utf8"));
    const match = await waitForPattern(
      session.getOutput,
      /diseño ✓/,
      stepTimeoutMs,
    );
    if (match === null) {
      throw new Error(
        `UTF-8 round-trip failed: "diseño ✓" never appeared intact.\noutput tail:\n${outputTail(session.getOutput())}`,
      );
    }
    return { detail: "", session };
  } catch (error) {
    await destroyShell(session);
    throw error;
  }
}

async function runResize(nodePty, shellFile) {
  const session = spawnShell(nodePty, shellFile);
  try {
    await sleep(shellStartupMs);
    session.pty.resize(120, 40);
    await sleep(500);
    session.pty.resize(80, 30);
    await sleep(500);
    if (session.isExited()) {
      throw new Error("Shell died after resize.");
    }
    session.pty.write(
      Buffer.from("Write-Output ('BB_WN_' + 'RESIZE_OK')\r", "utf8"),
    );
    const match = await waitForPattern(
      session.getOutput,
      /BB_WN_RESIZE_OK/,
      stepTimeoutMs,
    );
    if (match === null) {
      throw new Error(
        `Shell stopped responding after resize.\noutput tail:\n${outputTail(session.getOutput())}`,
      );
    }
    return { detail: "", session };
  } catch (error) {
    await destroyShell(session);
    throw error;
  }
}

async function runCtrlC(nodePty, shellFile) {
  const session = spawnShell(nodePty, shellFile);
  try {
    await sleep(shellStartupMs);
    const promptMarker = `${basename(tmpdir())}>`;
    const promptsBeforeSleep = countOccurrences(
      session.getOutput(),
      promptMarker,
    );
    session.pty.write(Buffer.from("Start-Sleep -Seconds 30\r", "utf8"));
    await sleep(300);
    session.pty.write(Buffer.from("\x03", "utf8"));
    const interrupted = await waitForCondition(
      () =>
        countOccurrences(session.getOutput(), promptMarker) >
        promptsBeforeSleep,
      5_000,
    );
    if (!interrupted) {
      throw new Error(
        `Ctrl+C never returned the shell to a fresh prompt.\noutput tail:\n${outputTail(session.getOutput())}`,
      );
    }
    session.pty.write(
      Buffer.from("Write-Output ('BB_' + 'CTRLC_OK')\r", "utf8"),
    );
    const match = await waitForPattern(session.getOutput, /BB_CTRLC_OK/, 5_000);
    if (match === null) {
      throw new Error(
        `BB_CTRLC_OK never appeared after Ctrl+C.\noutput tail:\n${outputTail(session.getOutput())}`,
      );
    }
    return { detail: "", session };
  } catch (error) {
    await destroyShell(session);
    throw error;
  }
}

async function runClose(nodePty, shellFile) {
  const session = spawnShell(nodePty, shellFile);
  try {
    await sleep(shellStartupMs);
    const pid = await waitForShellPid(session.pty, 2_000);
    session.pty.kill();
    const exited = await waitForExit(session.exit, stepTimeoutMs);
    if (!exited) {
      throw new Error(`Shell pid ${String(pid)} ignored pty.kill().`);
    }
    const exitCode = session.getExitCode();
    if (exitCode === null || !acceptableKillExitCodes.has(exitCode)) {
      throw new Error(
        `Shell pid ${String(pid)} exited with unexpected code ${String(exitCode)}.`,
      );
    }
    const gone = await waitForPidInTasklist(pid, false, 5_000);
    if (!gone) {
      const stdout = await readTasklist(pid);
      taskkillTreeSync(pid);
      throw new Error(
        `Shell pid ${String(pid)} survived pty.kill() and is still in tasklist (zombie). tasklist:\n${stdout.trim()}`,
      );
    }
    releasePty(session.pty);
    return {
      detail: `pid=${String(pid)} exitCode=${String(exitCode)} reaped`,
      session: null,
    };
  } catch (error) {
    await destroyShell(session);
    throw error;
  }
}

async function runTree(nodePty, shellFile) {
  const session = spawnShell(nodePty, shellFile);
  let childPid = null;
  try {
    await sleep(shellStartupMs);
    const parentPid = await waitForShellPid(session.pty, 2_000);
    session.pty.write(
      Buffer.from(
        "$bbWnChild = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo','-Command','Start-Sleep -Seconds 60' -PassThru; Write-Output ('BB_WN_CHILD_' + $bbWnChild.Id)\r",
        "utf8",
      ),
    );
    const match = await waitForPattern(
      session.getOutput,
      /BB_WN_CHILD_(\d+)/,
      stepTimeoutMs,
    );
    if (match === null) {
      throw new Error(
        `Shell never reported a child PID.\noutput tail:\n${outputTail(session.getOutput())}`,
      );
    }
    childPid = Number(match[1]);
    const childAppeared = await waitForPidInTasklist(childPid, true, 5_000);
    if (!childAppeared) {
      throw new Error(
        `Child pid ${String(childPid)} never appeared in tasklist; tree assertion would be vacuous.`,
      );
    }
    taskkillTreeSync(parentPid);
    await waitForExit(session.exit, stepTimeoutMs);
    const parentGone = await waitForPidInTasklist(parentPid, false, 5_000);
    if (!parentGone) {
      const parentStdout = await readTasklist(parentPid);
      throw new Error(
        `Parent pid ${String(parentPid)} survived taskkill /PID /T /F. tasklist:\n${parentStdout.trim()}`,
      );
    }
    const childGone = await waitForPidInTasklist(childPid, false, 5_000);
    if (!childGone) {
      const stdout = await readTasklist(childPid);
      throw new Error(
        `Child pid ${String(childPid)} survived taskkill /T of parent ${String(parentPid)} (zombie). tasklist:\n${stdout.trim()}`,
      );
    }
    releasePty(session.pty);
    return {
      detail: `parent=${String(parentPid)} child=${String(childPid)} reaped`,
      session: null,
    };
  } catch (error) {
    if (childPid !== null) {
      taskkillTreeSync(childPid);
    }
    await destroyShell(session);
    throw error;
  }
}

async function main() {
  if (process.platform !== "win32") {
    console.log("conpty smoke: skipped (not win32)");
    process.exit(0);
  }

  const nodePtyRequire = createRequire(
    join(repoRoot, "apps", "host-daemon", "package.json"),
  );
  const nodePty = nodePtyRequire("node-pty");
  const shellFile = resolveShellFile(process.env);

  await runCheck("spawn-echo", () => runSpawnEcho(nodePty, shellFile));
  await runCheck("utf8", () => runUtf8(nodePty, shellFile));
  await runCheck("resize", () => runResize(nodePty, shellFile));
  await runCheck("ctrl-c", () => runCtrlC(nodePty, shellFile));
  await runCheck("close", () => runClose(nodePty, shellFile));
  await runCheck("tree", () => runTree(nodePty, shellFile));

  const passed = results.filter((result) => result.ok).length;
  console.log(`conpty smoke: ${String(passed)}/${String(results.length)}`);
  process.exit(passed === results.length ? 0 : 1);
}

await main();
