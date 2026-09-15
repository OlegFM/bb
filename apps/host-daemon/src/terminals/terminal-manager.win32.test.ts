import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostDaemonDaemonWsMessage } from "@bb/host-daemon-contract";
import { isSweepRootProcess, queryWindowsProcess } from "@bb/process-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "../runtime-manager.js";
import { TerminalManager } from "./terminal-manager.js";

const WINDOWS_PTY_KILL_EXIT_CODE = -1073741510;
const ACCEPTABLE_TERMINAL_CLOSE_EXIT_CODES: ReadonlySet<number> = new Set([
  0,
  WINDOWS_PTY_KILL_EXIT_CODE,
]);
const POLL_INTERVAL_MS = 50;

interface Win32TerminalHarness {
  closed: boolean;
  cwd: string;
  manager: TerminalManager;
  messages: HostDaemonDaemonWsMessage[];
  terminalId: string;
}

const harnesses: Win32TerminalHarness[] = [];
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-conpty-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function isTerminalExitedMessage(
  message: HostDaemonDaemonWsMessage,
): message is Extract<HostDaemonDaemonWsMessage, { type: "terminal.exited" }> {
  return message.type === "terminal.exited";
}

function collectTerminalOutput(messages: HostDaemonDaemonWsMessage[]): string {
  return Buffer.concat(
    messages.flatMap((message) =>
      message.type === "terminal.output"
        ? [Buffer.from(message.chunk.dataBase64, "base64")]
        : [],
    ),
  ).toString("utf8");
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function outputIncludes(harness: Win32TerminalHarness, text: string): boolean {
  return collectTerminalOutput(harness.messages).includes(text);
}

function promptMarker(harness: Win32TerminalHarness): string {
  return `${path.basename(harness.cwd)}>`;
}

function countPrompts(harness: Win32TerminalHarness): number {
  return (
    collectTerminalOutput(harness.messages).split(promptMarker(harness))
      .length - 1
  );
}

async function waitForOutput(
  harness: Win32TerminalHarness,
  text: string,
  timeoutMs: number,
): Promise<string> {
  await waitUntil(() => outputIncludes(harness, text), timeoutMs);
  return collectTerminalOutput(harness.messages);
}

async function openWin32Terminal(): Promise<Win32TerminalHarness> {
  const cwd = await makeTempDir();
  const messages: HostDaemonDaemonWsMessage[] = [];
  const runtimeManager = new RuntimeManager({
    shellEnv: {
      BB_CLI: "",
      BB_SERVER_URL: "",
      PATH: process.env.Path ?? "",
    },
  });
  const manager = new TerminalManager({
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    runtimeManager,
    sendMessage: (message) => {
      messages.push(message);
      return true;
    },
  });
  const harness: Win32TerminalHarness = {
    closed: false,
    cwd,
    manager,
    messages,
    terminalId: "conpty-terminal",
  };
  harnesses.push(harness);

  await manager.handleMessage({
    type: "terminal.open",
    requestId: "open-conpty",
    terminalId: harness.terminalId,
    target: { kind: "host_path", cwd },
    cols: 200,
    rows: 30,
    start: { mode: "shell" },
  });
  const opened = messages.find((message) => message.type === "terminal.opened");
  if (!opened) {
    throw new Error(
      `Terminal did not open: ${JSON.stringify(messages, null, 2)}`,
    );
  }
  const prompt = `${path.basename(cwd)}>`;
  if (!(await waitUntil(() => outputIncludes(harness, prompt), 15_000))) {
    throw new Error(
      `Terminal never printed a prompt: ${collectTerminalOutput(messages)}`,
    );
  }
  return harness;
}

async function sendTerminalInput(
  harness: Win32TerminalHarness,
  text: Buffer | string,
): Promise<void> {
  await harness.manager.handleMessage({
    type: "terminal.input",
    terminalId: harness.terminalId,
    dataBase64: (typeof text === "string"
      ? Buffer.from(text, "utf8")
      : text
    ).toString("base64"),
  });
}

async function waitForTerminalPid(
  harness: Win32TerminalHarness,
): Promise<number> {
  await waitUntil(() => {
    const [pid] = harness.manager.listOpenTerminalPids();
    return pid !== undefined && pid > 0;
  }, 5_000);
  const [pid] = harness.manager.listOpenTerminalPids();
  if (pid === undefined || pid <= 0) {
    throw new Error("Terminal pty never reported a pid");
  }
  return pid;
}

async function closeWin32Terminal(
  harness: Win32TerminalHarness,
): Promise<void> {
  if (harness.closed) {
    return;
  }
  harness.closed = true;
  await harness.manager.handleMessage({
    type: "terminal.close",
    terminalId: harness.terminalId,
    reason: "user",
  });
  await waitUntil(
    () =>
      harness.messages.some((message) => message.type === "terminal.exited"),
    10_000,
  );
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await closeWin32Terminal(harness);
  }
  await Promise.all(
    tempDirs.splice(0).map((tempDir) =>
      fs.rm(tempDir, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
});

describe.runIf(process.platform === "win32")(
  "TerminalManager on ConPTY",
  () => {
    it("echoes UTF-8 through ConPTY", async () => {
      const harness = await openWin32Terminal();

      await sendTerminalInput(harness, "Write-Output ('При' + 'вет')\r");

      expect(await waitForOutput(harness, "Привет", 10_000)).toContain(
        "Привет",
      );
    }, 30_000);

    it("resizes without ending the session", async () => {
      const harness = await openWin32Terminal();

      await harness.manager.handleMessage({
        type: "terminal.resize",
        terminalId: harness.terminalId,
        cols: 120,
        rows: 40,
      });
      await harness.manager.handleMessage({
        type: "terminal.resize",
        terminalId: harness.terminalId,
        cols: 80,
        rows: 30,
      });
      await sendTerminalInput(harness, "Write-Output ('BB_' + 'RESIZE_OK')\r");

      expect(await waitForOutput(harness, "BB_RESIZE_OK", 10_000)).toContain(
        "BB_RESIZE_OK",
      );
      expect(
        harness.messages.filter(
          (message) => message.type === "terminal.exited",
        ),
      ).toEqual([]);
    }, 30_000);

    it("interrupts a running command with Ctrl+C", async () => {
      const harness = await openWin32Terminal();

      const promptsBeforeSleep = countPrompts(harness);

      await sendTerminalInput(harness, "Start-Sleep -Seconds 30\r");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await sendTerminalInput(harness, Buffer.from([0x03]));

      expect(
        await waitUntil(
          () => countPrompts(harness) > promptsBeforeSleep,
          5_000,
        ),
      ).toBe(true);

      await sendTerminalInput(harness, "Write-Output ('BB_' + 'CTRLC_OK')\r");

      expect(await waitForOutput(harness, "BB_CTRLC_OK", 5_000)).toContain(
        "BB_CTRLC_OK",
      );
    }, 30_000);

    it("closes with a single kill and the process disappears", async () => {
      const harness = await openWin32Terminal();
      const pid = await waitForTerminalPid(harness);

      await closeWin32Terminal(harness);

      const exitedMessages = harness.messages.filter(isTerminalExitedMessage);
      expect(exitedMessages).toHaveLength(1);
      const [exitedMessage] = exitedMessages;
      expect(exitedMessage).toMatchObject({
        type: "terminal.exited",
        terminalId: harness.terminalId,
        closeReason: "user",
      });
      expect(
        ACCEPTABLE_TERMINAL_CLOSE_EXIT_CODES.has(exitedMessage.exitCode ?? NaN),
      ).toBe(true);
      expect(
        await waitUntil(
          async () => (await queryWindowsProcess(pid)) === null,
          5_000,
        ),
      ).toBe(true);
    }, 30_000);

    it("registers the pty as a sweep root", async () => {
      const harness = await openWin32Terminal();
      const pid = await waitForTerminalPid(harness);

      expect(await waitUntil(() => isSweepRootProcess(pid), 3_000)).toBe(true);

      await closeWin32Terminal(harness);

      expect(isSweepRootProcess(pid)).toBe(false);
    }, 30_000);
  },
);
