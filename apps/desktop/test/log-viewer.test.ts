import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const openControl = vi.hoisted(() => ({
  failingPath: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      if (
        openControl.failingPath !== null &&
        String(args[0]) === openControl.failingPath
      ) {
        throw Object.assign(new Error("EBUSY: resource busy or locked, open"), {
          code: "EBUSY",
        });
      }
      return original.open(...args);
    },
  };
});

import {
  createLogLineBuffer,
  createLogTailer,
  formatLogLine,
  resolveCurrentLogFile,
  type LogTailer,
} from "../src/log-viewer.js";
import type { LogViewerLine } from "../src/log-viewer-contract.js";

interface TempDir {
  path: string;
}

interface WaitForArgs {
  predicate(): boolean;
  timeoutMs?: number;
}

interface CreateTestLogLineArgs {
  index: number;
}

const tempDirs: TempDir[] = [];
const tailers: LogTailer[] = [];

async function createTempDir(): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), "bb-desktop-log-viewer-"));
  const tempDir = { path };
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  openControl.failingPath = null;
  while (tailers.length > 0) {
    tailers.pop()?.stop();
  }
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir !== undefined) {
      await rm(tempDir.path, { force: true, recursive: true });
    }
  }
});

async function waitFor(args: WaitForArgs): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 5_000;
  const startedAt = Date.now();
  while (!args.predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 25);
    });
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createTestLogLine(args: CreateTestLogLineArgs): LogViewerLine {
  return {
    source: "server",
    text: `line-${args.index}`,
  };
}

describe("formatLogLine", () => {
  const timeMs = new Date(2026, 8, 9, 9, 25, 50, 443).getTime();

  it("renders pino records with a local timestamp, level, message, and remaining fields", () => {
    const line = JSON.stringify({
      level: 40,
      time: timeMs,
      component: "server",
      errorCode: "host_unavailable",
      errorDetails: { reason: "disconnected" },
      msg: "Failed to resolve host",
    });

    expect(formatLogLine({ component: "server", line })).toBe(
      '2026-09-09 09:25:50.443 [warn] [server] Failed to resolve host {"errorCode":"host_unavailable","errorDetails":{"reason":"disconnected"}}',
    );
  });

  it("omits the field suffix when only core fields are present", () => {
    const line = JSON.stringify({
      level: 30,
      time: timeMs,
      component: "server",
      msg: "Daemon WebSocket closed",
    });

    expect(formatLogLine({ component: "server", line })).toBe(
      "2026-09-09 09:25:50.443 [info] [server] Daemon WebSocket closed",
    );
  });

  it("keeps a sub-component that differs from the log file component", () => {
    const line = JSON.stringify({
      level: 50,
      time: timeMs,
      component: "provider",
      msg: "boom",
    });

    expect(formatLogLine({ component: "host-daemon", line })).toBe(
      "2026-09-09 09:25:50.443 [error] [host-daemon:provider] boom",
    );
  });

  it("falls back to the raw line for non-pino output", () => {
    expect(formatLogLine({ component: "server", line: "plain text" })).toBe(
      "[server] plain text",
    );
    expect(formatLogLine({ component: "server", line: '{"msg":"x"}' })).toBe(
      '[server] {"msg":"x"}',
    );
    expect(formatLogLine({ component: "server", line: "{not json" })).toBe(
      "[server] {not json",
    );
  });
});

describe("log viewer", () => {
  it("selects the newest matching server log file", async () => {
    const tempDir = await createTempDir();
    const firstServerLog = join(tempDir.path, "server.1.log");
    const nextServerLog = join(tempDir.path, "server.2.log");
    await writeFile(firstServerLog, "older\n");
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 10);
    });
    await writeFile(nextServerLog, "newer\n");
    await writeFile(join(tempDir.path, "host-daemon.9.log"), "ignored\n");

    await expect(
      resolveCurrentLogFile({
        component: "server",
        logDir: tempDir.path,
      }),
    ).resolves.toBe(nextServerLog);
  });

  it("returns null when no matching component log exists", async () => {
    const tempDir = await createTempDir();
    await writeFile(join(tempDir.path, "host-daemon.1.log"), "daemon\n");

    await expect(
      resolveCurrentLogFile({
        component: "server",
        logDir: tempDir.path,
      }),
    ).resolves.toBeNull();
  });

  describe.skipIf(process.platform === "win32")(
    "tail-backed follower (POSIX)",
    () => {
      it("streams appended log lines from the active server log", async () => {
        const tempDir = await createTempDir();
        const lines: LogViewerLine[] = [];
        await writeFile(join(tempDir.path, "server.1.log"), "");
        const tailer = createLogTailer({
          logDir: tempDir.path,
          onLines(newLines) {
            lines.push(...newLines);
          },
          platform: "linux",
        });
        tailers.push(tailer);
        await tailer.start();

        await appendFile(join(tempDir.path, "server.1.log"), "streamed\n");

        await waitFor({
          predicate() {
            return lines.some((line) => line.text.includes("streamed"));
          },
        });
        expect(lines.some((line) => line.text === "[server] streamed")).toBe(
          true,
        );
      });

      it("follows a newer rotated server log file", async () => {
        const tempDir = await createTempDir();
        const lines: LogViewerLine[] = [];
        await writeFile(join(tempDir.path, "server.1.log"), "first\n");
        const tailer = createLogTailer({
          logDir: tempDir.path,
          onLines(newLines) {
            lines.push(...newLines);
          },
          platform: "linux",
        });
        tailers.push(tailer);
        await tailer.start();
        await waitFor({
          predicate() {
            return lines.some((line) => line.text === "[server] first");
          },
        });

        await new Promise((resolvePromise) => {
          setTimeout(resolvePromise, 25);
        });
        await writeFile(join(tempDir.path, "server.2.log"), "second\n");

        await waitFor({
          predicate() {
            return lines.some((line) => line.text === "[server] second");
          },
        });
      });

      it("kills tail child processes when stopped", async () => {
        const tempDir = await createTempDir();
        await writeFile(join(tempDir.path, "server.1.log"), "");
        await writeFile(join(tempDir.path, "host-daemon.1.log"), "");
        const tailer = createLogTailer({
          logDir: tempDir.path,
          onLines() {},
          platform: "linux",
        });
        tailers.push(tailer);
        await tailer.start();

        const processIds = tailer.processIds();
        expect(processIds).toHaveLength(2);
        expect(processIds.every(isProcessRunning)).toBe(true);

        tailer.stop();
        await waitFor({
          predicate() {
            return processIds.every((pid) => !isProcessRunning(pid));
          },
        });
      });
    },
  );

  it("caps the in-memory line buffer to the configured line limit", () => {
    const buffer = createLogLineBuffer({
      flushIntervalMs: 1_000,
      flushLineCount: 20_000,
      maxLines: 10_000,
      onFlush() {},
    });
    const lines = Array.from({ length: 11_000 }, (_value, index) =>
      createTestLogLine({ index }),
    );

    buffer.append(lines);

    const bufferedLines = buffer.lines();
    expect(bufferedLines).toHaveLength(10_000);
    expect(bufferedLines[0]?.text).toBe("line-1000");
    expect(bufferedLines[9_999]?.text).toBe("line-10999");
    buffer.stop();
  });

  it("batches appended lines before flushing to the renderer", async () => {
    const flushedBatches: LogViewerLine[][] = [];
    const buffer = createLogLineBuffer({
      flushIntervalMs: 25,
      flushLineCount: 10,
      maxLines: 100,
      onFlush(lines) {
        flushedBatches.push(lines);
      },
    });

    buffer.append([createTestLogLine({ index: 1 })]);
    buffer.append([createTestLogLine({ index: 2 })]);

    await waitFor({
      predicate() {
        return flushedBatches.length === 1;
      },
    });
    expect(flushedBatches[0]?.map((line) => line.text)).toEqual([
      "line-1",
      "line-2",
    ]);
    buffer.stop();
  });
});

describe("file-backed follower (win32 arm)", () => {
  function createWideTestLine(args: CreateTestLogLineArgs): string {
    return `line-${args.index}`.padEnd(200, "x");
  }

  it("emits only the last tail window of a large existing log file", async () => {
    const tempDir = await createTempDir();
    const lines: LogViewerLine[] = [];
    const logLines = Array.from({ length: 1_000 }, (_value, index) =>
      createWideTestLine({ index }),
    );
    await writeFile(
      join(tempDir.path, "server.1.log"),
      `${logLines.join("\n")}\n`,
    );
    const tailer = createLogTailer({
      logDir: tempDir.path,
      onLines(newLines) {
        lines.push(...newLines);
      },
      platform: "win32",
    });
    tailers.push(tailer);
    await tailer.start();

    expect(lines).toHaveLength(400);
    expect(lines[0]?.text).toBe(
      `[server] ${createWideTestLine({ index: 600 })}`,
    );
    expect(lines[399]?.text).toBe(
      `[server] ${createWideTestLine({ index: 999 })}`,
    );
  });

  it("emits every line when the log file is shorter than the tail window", async () => {
    const tempDir = await createTempDir();
    const lines: LogViewerLine[] = [];
    await writeFile(join(tempDir.path, "server.1.log"), "alpha\nbeta\ngamma\n");
    const tailer = createLogTailer({
      logDir: tempDir.path,
      onLines(newLines) {
        lines.push(...newLines);
      },
      platform: "win32",
    });
    tailers.push(tailer);
    await tailer.start();

    expect(lines.map((line) => line.text)).toEqual([
      "[server] alpha",
      "[server] beta",
      "[server] gamma",
    ]);
  });

  it("emits nothing for an empty log file and then streams appended lines", async () => {
    const tempDir = await createTempDir();
    const lines: LogViewerLine[] = [];
    await writeFile(join(tempDir.path, "server.1.log"), "");
    const tailer = createLogTailer({
      logDir: tempDir.path,
      onLines(newLines) {
        lines.push(...newLines);
      },
      platform: "win32",
    });
    tailers.push(tailer);
    await tailer.start();

    expect(lines).toHaveLength(0);

    await appendFile(join(tempDir.path, "server.1.log"), "streamed\n");

    await waitFor({
      predicate() {
        return lines.some((line) => line.text === "[server] streamed");
      },
      timeoutMs: 10_000,
    });
  }, 20_000);

  it("decodes a multi-byte character split across two appends", async () => {
    const tempDir = await createTempDir();
    const lines: LogViewerLine[] = [];
    const logPath = join(tempDir.path, "server.1.log");
    await writeFile(logPath, "");
    const tailer = createLogTailer({
      logDir: tempDir.path,
      onLines(newLines) {
        lines.push(...newLines);
      },
      platform: "win32",
    });
    tailers.push(tailer);
    await tailer.start();

    const character = Buffer.from("é", "utf8");
    await appendFile(
      logPath,
      Buffer.concat([Buffer.from("first\n", "utf8"), character.subarray(0, 1)]),
    );
    await waitFor({
      predicate() {
        return lines.some((line) => line.text === "[server] first");
      },
      timeoutMs: 10_000,
    });

    await appendFile(
      logPath,
      Buffer.concat([character.subarray(1), Buffer.from("\n", "utf8")]),
    );
    await waitFor({
      predicate() {
        return lines.some((line) => line.text === "[server] é");
      },
      timeoutMs: 10_000,
    });
    expect(lines.some((line) => line.text.includes("�"))).toBe(false);
  }, 30_000);

  it("re-reads a truncated log file from the start", async () => {
    const tempDir = await createTempDir();
    const lines: LogViewerLine[] = [];
    const logPath = join(tempDir.path, "server.1.log");
    await writeFile(logPath, "one\ntwo\n");
    const tailer = createLogTailer({
      logDir: tempDir.path,
      onLines(newLines) {
        lines.push(...newLines);
      },
      platform: "win32",
    });
    tailers.push(tailer);
    await tailer.start();

    expect(lines.map((line) => line.text)).toEqual([
      "[server] one",
      "[server] two",
    ]);

    await writeFile(logPath, "three\n");

    await waitFor({
      predicate() {
        return lines.some((line) => line.text === "[server] three");
      },
      timeoutMs: 10_000,
    });
  }, 20_000);

  it("follows a newer rotated server log file", async () => {
    const tempDir = await createTempDir();
    const lines: LogViewerLine[] = [];
    await writeFile(join(tempDir.path, "server.1.log"), "first\n");
    const tailer = createLogTailer({
      logDir: tempDir.path,
      onLines(newLines) {
        lines.push(...newLines);
      },
      platform: "win32",
    });
    tailers.push(tailer);
    await tailer.start();
    await waitFor({
      predicate() {
        return lines.some((line) => line.text === "[server] first");
      },
      timeoutMs: 10_000,
    });

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 25);
    });
    await writeFile(join(tempDir.path, "server.2.log"), "second\n");

    await waitFor({
      predicate() {
        return lines.some((line) => line.text === "[server] second");
      },
      timeoutMs: 10_000,
    });
  }, 30_000);

  it("emits only the tail window when the log grows while the follower attaches", async () => {
    const tempDir = await createTempDir();
    const lines: LogViewerLine[] = [];
    const logPath = join(tempDir.path, "server.1.log");
    const existingLines = Array.from({ length: 3_000 }, (_value, index) =>
      createWideTestLine({ index }),
    );
    await writeFile(logPath, `${existingLines.join("\n")}\n`);
    const tailer = createLogTailer({
      logDir: tempDir.path,
      onLines(newLines) {
        lines.push(...newLines);
      },
      platform: "win32",
    });
    tailers.push(tailer);

    const concurrentAppends = (async () => {
      for (let index = 0; index < 50; index += 1) {
        await appendFile(logPath, `extra-${index}\n`);
      }
    })();
    await tailer.start();
    await concurrentAppends;

    const texts = lines.map((line) => line.text);
    expect(texts[0]).toMatch(/^\[server\] line-2[6-9]\d\dx*$/u);
    expect(texts.length).toBeLessThanOrEqual(500);
    expect(new Set(texts).size).toBe(texts.length);
  }, 30_000);

  it("holds a partial final line until the rest of it arrives", async () => {
    const tempDir = await createTempDir();
    const lines: LogViewerLine[] = [];
    const logPath = join(tempDir.path, "server.1.log");
    await writeFile(logPath, "complete\npart");
    const tailer = createLogTailer({
      logDir: tempDir.path,
      onLines(newLines) {
        lines.push(...newLines);
      },
      platform: "win32",
    });
    tailers.push(tailer);
    await tailer.start();

    expect(lines.map((line) => line.text)).toEqual(["[server] complete"]);

    await appendFile(logPath, "ial\n");

    await waitFor({
      predicate() {
        return lines.some((line) => line.text === "[server] partial");
      },
      timeoutMs: 10_000,
    });
    expect(lines.map((line) => line.text)).toEqual([
      "[server] complete",
      "[server] partial",
    ]);
  }, 20_000);

  it("recovers on the next tick when the initial log read fails", async () => {
    const tempDir = await createTempDir();
    const lines: LogViewerLine[] = [];
    const logPath = join(tempDir.path, "server.1.log");
    await writeFile(logPath, "before\n");
    openControl.failingPath = logPath;
    const tailer = createLogTailer({
      logDir: tempDir.path,
      onLines(newLines) {
        lines.push(...newLines);
      },
      platform: "win32",
    });
    tailers.push(tailer);
    await tailer.start();

    expect(lines.map((line) => line.text)).toEqual([
      "[system] server log read failed: EBUSY: resource busy or locked, open",
    ]);

    openControl.failingPath = null;
    await appendFile(logPath, "after\n");

    await waitFor({
      predicate() {
        return lines.some((line) => line.text === "[server] after");
      },
      timeoutMs: 10_000,
    });
    expect(lines.some((line) => line.text === "[server] before")).toBe(true);
  }, 20_000);

  it("reports a failing follow once and resumes after it recovers", async () => {
    const tempDir = await createTempDir();
    const lines: LogViewerLine[] = [];
    const logPath = join(tempDir.path, "server.1.log");
    await writeFile(logPath, "start\n");
    const tailer = createLogTailer({
      logDir: tempDir.path,
      onLines(newLines) {
        lines.push(...newLines);
      },
      platform: "win32",
    });
    tailers.push(tailer);
    await tailer.start();
    expect(lines.map((line) => line.text)).toEqual(["[server] start"]);

    openControl.failingPath = logPath;
    await appendFile(logPath, "during\n");
    await waitFor({
      predicate() {
        return lines.some((line) =>
          line.text.startsWith("[system] server follow:"),
        );
      },
      timeoutMs: 10_000,
    });
    expect(
      lines.filter((line) => line.text.startsWith("[system] server follow:")),
    ).toHaveLength(1);

    for (let index = 0; index < 3; index += 1) {
      await appendFile(logPath, `ignored-${index}\n`);
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 50);
      });
    }
    expect(
      lines.filter((line) => line.text.startsWith("[system] server follow:")),
    ).toHaveLength(1);

    openControl.failingPath = null;
    await appendFile(logPath, "after\n");

    await waitFor({
      predicate() {
        return lines.some((line) => line.text === "[server] after");
      },
      timeoutMs: 10_000,
    });
    expect(lines.some((line) => line.text === "[server] during")).toBe(true);
  }, 30_000);

  it("reports no tail child processes", async () => {
    const tempDir = await createTempDir();
    await writeFile(join(tempDir.path, "server.1.log"), "");
    await writeFile(join(tempDir.path, "host-daemon.1.log"), "");
    const tailer = createLogTailer({
      logDir: tempDir.path,
      onLines() {},
      platform: "win32",
    });
    tailers.push(tailer);
    await tailer.start();

    expect(tailer.processIds()).toEqual([]);
  });

  it.runIf(process.platform === "win32")(
    "streams appended lines on this host without an explicit platform",
    async () => {
      const tempDir = await createTempDir();
      const lines: LogViewerLine[] = [];
      await writeFile(join(tempDir.path, "server.1.log"), "");
      const tailer = createLogTailer({
        logDir: tempDir.path,
        onLines(newLines) {
          lines.push(...newLines);
        },
      });
      tailers.push(tailer);
      await tailer.start();

      await appendFile(join(tempDir.path, "server.1.log"), "native\n");

      await waitFor({
        predicate() {
          return lines.some((line) => line.text === "[server] native");
        },
        timeoutMs: 10_000,
      });
      expect(tailer.processIds()).toEqual([]);
    },
    20_000,
  );
});
