import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readdir, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { escapeHtmlText } from "@bb/domain";
import { z } from "zod";
import {
  LOG_VIEWER_VISIBLE_LINE_LIMIT,
  type LogViewerComponent,
  type LogViewerLine,
} from "./log-viewer-contract.js";

export const LOG_VIEWER_IPC_BATCH_INTERVAL_MS = 50;
export const LOG_VIEWER_IPC_BATCH_LINE_LIMIT = 250;

const LOG_VIEWER_INITIAL_TAIL_LINES = 400;
const LOG_VIEWER_ROTATION_POLL_INTERVAL_MS = 2_000;
const LOG_VIEWER_TAIL_WINDOW_BYTES = 64 * 1024;
const LOG_VIEWER_MAX_TAIL_WINDOW_BYTES = 4 * 1024 * 1024;
const LOG_VIEWER_COMPONENTS: LogViewerComponent[] = ["server", "host-daemon"];
const PINO_LEVEL_LABELS = new Map<number, string>([
  [10, "trace"],
  [20, "debug"],
  [30, "info"],
  [40, "warn"],
  [50, "error"],
  [60, "fatal"],
]);

const pinoLogRecordSchema = z
  .object({
    component: z.string().optional(),
    level: z.number(),
    msg: z.string().optional(),
    time: z.number(),
  })
  .loose();

interface FormatLogLineArgs {
  component: LogViewerComponent;
  line: string;
}

function padNumber(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

function formatLogTimestamp(timeMs: number): string {
  const date = new Date(timeMs);
  const datePart = `${date.getFullYear()}-${padNumber(date.getMonth() + 1, 2)}-${padNumber(date.getDate(), 2)}`;
  const timePart = `${padNumber(date.getHours(), 2)}:${padNumber(date.getMinutes(), 2)}:${padNumber(date.getSeconds(), 2)}.${padNumber(date.getMilliseconds(), 3)}`;
  return `${datePart} ${timePart}`;
}

function parseJsonObject(line: string): unknown {
  if (!line.startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function formatLogLine(args: FormatLogLineArgs): string {
  const parsed = pinoLogRecordSchema.safeParse(parseJsonObject(args.line));
  if (!parsed.success) {
    return `[${args.component}] ${args.line}`;
  }

  const { component, level, msg, time, ...fields } = parsed.data;
  const levelLabel = PINO_LEVEL_LABELS.get(level) ?? `level ${level}`;
  const sourceLabel =
    component === undefined || component === args.component
      ? args.component
      : `${args.component}:${component}`;
  const parts = [
    formatLogTimestamp(time),
    `[${levelLabel}]`,
    `[${sourceLabel}]`,
  ];
  if (msg !== undefined && msg.length > 0) {
    parts.push(msg);
  }
  if (Object.keys(fields).length > 0) {
    parts.push(JSON.stringify(fields));
  }
  return parts.join(" ");
}

interface CreateLogViewerViewUrlArgs {
  logDir: string;
}

interface ResolveCurrentLogFileArgs {
  component: LogViewerComponent;
  logDir: string;
}

interface CreateLogTailerArgs {
  logDir: string;
  onLines(lines: LogViewerLine[]): void;
  platform?: NodeJS.Platform;
}

export interface LogTailer {
  processIds(): number[];
  start(): Promise<void>;
  stop(): void;
}

interface CreateLogLineBufferArgs {
  flushIntervalMs: number;
  flushLineCount: number;
  maxLines: number;
  onFlush(lines: LogViewerLine[]): void;
}

export interface LogLineBuffer {
  append(lines: LogViewerLine[]): void;
  clear(): void;
  flush(): void;
  lines(): LogViewerLine[];
  stop(): void;
}

interface ParseLogFileCandidateArgs {
  component: LogViewerComponent;
  fileName: string;
}

interface LogFileCandidate {
  fileName: string;
  sequence: number;
  timestampMs: number;
}

interface TailProcess {
  childProcess: ChildProcess;
  filePath: string;
}

interface FileFollow {
  decoder: StringDecoder;
  filePath: string;
  mtimeMs: number;
  offset: number;
}

interface ComponentTailState {
  component: LogViewerComponent;
  currentFilePath: string | null;
  fileFollow: FileFollow | null;
  pendingText: string;
  tailProcess: TailProcess | null;
}

interface RestartFollowerArgs {
  filePath: string;
  state: ComponentTailState;
}

interface StopTailProcessArgs {
  state: ComponentTailState;
}

interface FollowAppendedBytesArgs {
  state: ComponentTailState;
}

interface ReadLastLogLinesArgs {
  filePath: string;
  maxLines: number;
}

interface LastLogLines {
  lines: string[];
  mtimeMs: number;
  size: number;
}

interface ReadAppendedLogBytesArgs {
  fileFollow: FileFollow;
}

interface AppendedLogBytes {
  rotated: boolean;
  text: string;
}

interface HandleDirectoryWatchErrorArgs {
  error: Error;
  watcher: FSWatcher;
}

interface HandleTailChunkArgs {
  chunk: string;
  state: ComponentTailState;
}

interface EmitSystemLineArgs {
  text: string;
}

interface EmitComponentLinesArgs {
  component: LogViewerComponent;
  lines: string[];
}

interface CreateComponentTailStateArgs {
  component: LogViewerComponent;
}

interface ScheduleBufferFlushArgs {
  buffer: LogLineBufferState;
}

interface LogLineBufferState {
  flushTimer: NodeJS.Timeout | null;
  pendingLines: LogViewerLine[];
  visibleLines: LogViewerLine[];
}

export function createLogLineBuffer(
  args: CreateLogLineBufferArgs,
): LogLineBuffer {
  const state: LogLineBufferState = {
    flushTimer: null,
    pendingLines: [],
    visibleLines: [],
  };

  function clearFlushTimer(): void {
    if (state.flushTimer === null) {
      return;
    }
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }

  function flush(): void {
    clearFlushTimer();
    if (state.pendingLines.length === 0) {
      return;
    }

    const pendingLines = state.pendingLines;
    state.pendingLines = [];
    args.onFlush(pendingLines);
  }

  function scheduleBufferFlush(scheduleArgs: ScheduleBufferFlushArgs): void {
    if (scheduleArgs.buffer.flushTimer !== null) {
      return;
    }
    scheduleArgs.buffer.flushTimer = setTimeout(() => {
      scheduleArgs.buffer.flushTimer = null;
      flush();
    }, args.flushIntervalMs);
  }

  return {
    append(lines) {
      if (lines.length === 0) {
        return;
      }

      state.visibleLines.push(...lines);
      if (state.visibleLines.length > args.maxLines) {
        state.visibleLines.splice(0, state.visibleLines.length - args.maxLines);
      }

      state.pendingLines.push(...lines);
      if (state.pendingLines.length >= args.flushLineCount) {
        flush();
        return;
      }
      scheduleBufferFlush({ buffer: state });
    },
    clear() {
      clearFlushTimer();
      state.pendingLines = [];
      state.visibleLines = [];
    },
    flush,
    lines() {
      return [...state.visibleLines];
    },
    stop() {
      flush();
      clearFlushTimer();
    },
  };
}

export function createLogViewerViewUrl(
  args: CreateLogViewerViewUrlArgs,
): string {
  const escapedLogDir = escapeHtmlText(args.logDir);
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>bb - Server & Daemon Logs</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      background: Canvas;
      color: CanvasText;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      height: 100vh;
      margin: 0;
    }

    header {
      align-items: center;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      display: grid;
      gap: 12px;
      grid-template-columns: minmax(0, 1fr) auto;
      padding: 16px 18px 12px;
    }

    h1 {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0;
      line-height: 1.25;
      margin: 0 0 4px;
    }

    .path {
      color: color-mix(in srgb, CanvasText 60%, transparent);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .actions {
      align-items: center;
      display: flex;
      gap: 8px;
    }

    button {
      appearance: none;
      background: color-mix(in srgb, CanvasText 7%, transparent);
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 6px;
      color: CanvasText;
      cursor: default;
      font: inherit;
      font-size: 12px;
      line-height: 1;
      padding: 8px 10px;
    }

    button:active {
      background: color-mix(in srgb, CanvasText 13%, transparent);
    }

    label {
      align-items: center;
      color: color-mix(in srgb, CanvasText 72%, transparent);
      display: inline-flex;
      font-size: 12px;
      gap: 6px;
      white-space: nowrap;
    }

    input {
      margin: 0;
    }

    main {
      min-height: 0;
      padding: 12px;
    }

    pre {
      background: color-mix(in srgb, CanvasText 5%, transparent);
      border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
      border-radius: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      height: 100%;
      line-height: 1.45;
      margin: 0;
      overflow: auto;
      padding: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .status {
      color: color-mix(in srgb, CanvasText 64%, transparent);
      font-size: 12px;
      min-width: 58px;
      text-align: right;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Server & Daemon Logs</h1>
      <div class="path" title="${escapedLogDir}">${escapedLogDir}</div>
    </div>
    <div class="actions">
      <label><input id="autoscroll" type="checkbox" checked> Auto-scroll</label>
      <button id="copy" type="button">Copy Logs</button>
      <button id="open" type="button">Open Logs Folder</button>
      <button id="clear" type="button">Clear</button>
      <div id="status" class="status">0 lines</div>
    </div>
  </header>
  <main>
    <pre id="log" aria-live="polite"></pre>
  </main>
  <script>
    const maxLines = ${LOG_VIEWER_VISIBLE_LINE_LIMIT};
    const api = window.bbLogViewer;
    const autoscroll = document.getElementById("autoscroll");
    const clearButton = document.getElementById("clear");
    const copyButton = document.getElementById("copy");
    const logElement = document.getElementById("log");
    const openButton = document.getElementById("open");
    const statusElement = document.getElementById("status");
    const lines = [];

    function shouldStickToBottom() {
      return autoscroll.checked &&
        logElement.scrollTop + logElement.clientHeight >= logElement.scrollHeight - 24;
    }

    function render(stickToBottom) {
      logElement.textContent = lines.join("\\n");
      statusElement.textContent = String(lines.length) + " lines";
      if (stickToBottom) {
        logElement.scrollTop = logElement.scrollHeight;
      }
    }

    function appendEntries(entries) {
      const stickToBottom = shouldStickToBottom();
      for (const entry of entries) {
        lines.push(entry.text);
      }
      if (lines.length > maxLines) {
        lines.splice(0, lines.length - maxLines);
      }
      render(stickToBottom);
    }

    api.onSnapshot((event) => {
      lines.splice(0, lines.length);
      appendEntries(event.lines);
    });

    api.onAppend((event) => {
      appendEntries(event.lines);
    });

    clearButton.addEventListener("click", () => {
      lines.splice(0, lines.length);
      render(true);
    });

    copyButton.addEventListener("click", async () => {
      await api.copyLogs({ text: lines.join("\\n") });
      const previousLabel = copyButton.textContent;
      copyButton.textContent = "Copied";
      setTimeout(() => {
        copyButton.textContent = previousLabel;
      }, 900);
    });

    openButton.addEventListener("click", async () => {
      await api.openLogsFolder();
    });
  </script>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function parseLogFileCandidate(
  args: ParseLogFileCandidateArgs,
): LogFileCandidate | null {
  const exactFileName = `${args.component}.log`;
  if (args.fileName === exactFileName) {
    return {
      fileName: args.fileName,
      sequence: 0,
      timestampMs: 0,
    };
  }

  const prefix = `${args.component}.`;
  const suffix = ".log";
  if (!args.fileName.startsWith(prefix) || !args.fileName.endsWith(suffix)) {
    return null;
  }

  const rawSequence = args.fileName.slice(
    prefix.length,
    args.fileName.length - suffix.length,
  );
  const sequence = /^\d+$/u.test(rawSequence) ? Number(rawSequence) : 0;
  return {
    fileName: args.fileName,
    sequence,
    timestampMs: 0,
  };
}

export async function resolveCurrentLogFile(
  args: ResolveCurrentLogFileArgs,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(args.logDir);
  } catch {
    return null;
  }

  const candidates: LogFileCandidate[] = [];
  for (const entry of entries) {
    const candidate = parseLogFileCandidate({
      component: args.component,
      fileName: entry,
    });
    if (candidate === null) {
      continue;
    }

    try {
      const fileStats = await stat(join(args.logDir, candidate.fileName));
      if (!fileStats.isFile()) {
        continue;
      }
      candidates.push({
        fileName: candidate.fileName,
        sequence: candidate.sequence,
        timestampMs: Math.max(
          fileStats.birthtimeMs,
          fileStats.ctimeMs,
          fileStats.mtimeMs,
        ),
      });
    } catch {}
  }

  candidates.sort((left, right) => {
    if (left.timestampMs !== right.timestampMs) {
      return right.timestampMs - left.timestampMs;
    }
    if (left.sequence !== right.sequence) {
      return right.sequence - left.sequence;
    }
    return right.fileName.localeCompare(left.fileName);
  });

  const candidate = candidates[0];
  return candidate === undefined ? null : join(args.logDir, candidate.fileName);
}

function createComponentTailState(
  args: CreateComponentTailStateArgs,
): ComponentTailState {
  return {
    component: args.component,
    currentFilePath: null,
    fileFollow: null,
    pendingText: "",
    tailProcess: null,
  };
}

async function readLastLogLines(
  args: ReadLastLogLinesArgs,
): Promise<LastLogLines> {
  const handle = await open(args.filePath, "r");
  try {
    const fileStats = await handle.stat();
    const size = fileStats.size;
    const mtimeMs = fileStats.mtimeMs;
    let windowBytes = LOG_VIEWER_TAIL_WINDOW_BYTES;
    for (;;) {
      const start = Math.max(0, size - windowBytes);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      const bytesRead =
        length === 0
          ? 0
          : (await handle.read(buffer, 0, length, start)).bytesRead;
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const newlineCount = text.split("\n").length - 1;
      if (
        start === 0 ||
        newlineCount > args.maxLines ||
        windowBytes >= LOG_VIEWER_MAX_TAIL_WINDOW_BYTES
      ) {
        const lines = text.split(/\r?\n/u);
        if (lines[lines.length - 1] === "") {
          lines.pop();
        }
        return {
          lines: lines.slice(-args.maxLines),
          mtimeMs,
          size: start + bytesRead,
        };
      }
      windowBytes *= 2;
    }
  } finally {
    await handle.close();
  }
}

async function readAppendedLogBytes(
  args: ReadAppendedLogBytesArgs,
): Promise<AppendedLogBytes> {
  const handle = await open(args.fileFollow.filePath, "r");
  try {
    const fileStats = await handle.stat();
    const size = fileStats.size;
    const rotated =
      size < args.fileFollow.offset ||
      (size === args.fileFollow.offset &&
        fileStats.mtimeMs !== args.fileFollow.mtimeMs);
    args.fileFollow.mtimeMs = fileStats.mtimeMs;
    if (rotated) {
      args.fileFollow.decoder = new StringDecoder("utf8");
      args.fileFollow.offset = 0;
    }

    const length = size - args.fileFollow.offset;
    if (length <= 0) {
      return { rotated, text: "" };
    }

    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      args.fileFollow.offset,
    );
    args.fileFollow.offset += bytesRead;
    return {
      rotated,
      text: args.fileFollow.decoder.write(buffer.subarray(0, bytesRead)),
    };
  } finally {
    await handle.close();
  }
}

export function createLogTailer(args: CreateLogTailerArgs): LogTailer {
  const platform = args.platform ?? process.platform;
  const componentStates = LOG_VIEWER_COMPONENTS.map((component) =>
    createComponentTailState({ component }),
  );
  let directoryWatcher: FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let refreshInProgress = false;
  let refreshAgain = false;
  let stopped = false;

  function emitSystemLine(emitArgs: EmitSystemLineArgs): void {
    args.onLines([{ source: "system", text: `[system] ${emitArgs.text}` }]);
  }

  function emitComponentLines(emitArgs: EmitComponentLinesArgs): void {
    args.onLines(
      emitArgs.lines
        .filter((line) => line.length > 0)
        .map((line) => ({
          source: emitArgs.component,
          text: formatLogLine({ component: emitArgs.component, line }),
        })),
    );
  }

  function handleTailChunk(handleArgs: HandleTailChunkArgs): void {
    const combinedText = `${handleArgs.state.pendingText}${handleArgs.chunk}`;
    const lines = combinedText.split(/\r?\n/u);
    if (combinedText.endsWith("\n") || combinedText.endsWith("\r")) {
      handleArgs.state.pendingText = "";
      emitComponentLines({
        component: handleArgs.state.component,
        lines,
      });
      return;
    }

    handleArgs.state.pendingText = lines.pop() ?? "";
    emitComponentLines({
      component: handleArgs.state.component,
      lines,
    });
  }

  function stopTailProcess(stopArgs: StopTailProcessArgs): void {
    const tailProcess = stopArgs.state.tailProcess;
    stopArgs.state.fileFollow = null;
    stopArgs.state.tailProcess = null;
    stopArgs.state.currentFilePath = null;
    stopArgs.state.pendingText = "";
    if (tailProcess === null) {
      return;
    }
    tailProcess.childProcess.kill("SIGTERM");
  }

  function handleDirectoryWatchError(
    watchArgs: HandleDirectoryWatchErrorArgs,
  ): void {
    if (directoryWatcher !== watchArgs.watcher) {
      return;
    }
    directoryWatcher = null;
    watchArgs.watcher.close();
    if (stopped) {
      return;
    }
    emitSystemLine({
      text: `log directory watch failed: ${watchArgs.error.message}`,
    });
  }

  async function followAppendedBytes(
    followArgs: FollowAppendedBytesArgs,
  ): Promise<void> {
    const fileFollow = followArgs.state.fileFollow;
    if (fileFollow === null) {
      return;
    }

    let appended: AppendedLogBytes;
    try {
      appended = await readAppendedLogBytes({ fileFollow });
    } catch {
      return;
    }
    if (stopped || followArgs.state.fileFollow !== fileFollow) {
      return;
    }
    if (appended.rotated) {
      followArgs.state.pendingText = "";
    }
    if (appended.text.length > 0) {
      handleTailChunk({ chunk: appended.text, state: followArgs.state });
    }
  }

  async function restartFileFollow(
    restartArgs: RestartFollowerArgs,
  ): Promise<void> {
    stopTailProcess({ state: restartArgs.state });
    restartArgs.state.currentFilePath = restartArgs.filePath;

    const fileFollow: FileFollow = {
      decoder: new StringDecoder("utf8"),
      filePath: restartArgs.filePath,
      mtimeMs: 0,
      offset: 0,
    };
    restartArgs.state.fileFollow = fileFollow;

    let initialLines: LastLogLines;
    try {
      initialLines = await readLastLogLines({
        filePath: restartArgs.filePath,
        maxLines: LOG_VIEWER_INITIAL_TAIL_LINES,
      });
    } catch (error) {
      if (stopped || restartArgs.state.fileFollow !== fileFollow) {
        return;
      }
      restartArgs.state.fileFollow = null;
      restartArgs.state.currentFilePath = null;
      const message = error instanceof Error ? error.message : String(error);
      emitSystemLine({
        text: `${restartArgs.state.component} log read failed: ${message}`,
      });
      return;
    }

    if (stopped || restartArgs.state.fileFollow !== fileFollow) {
      return;
    }
    fileFollow.mtimeMs = initialLines.mtimeMs;
    fileFollow.offset = initialLines.size;
    emitComponentLines({
      component: restartArgs.state.component,
      lines: initialLines.lines,
    });
    await followAppendedBytes({ state: restartArgs.state });
  }

  async function restartFollower(
    restartArgs: RestartFollowerArgs,
  ): Promise<void> {
    if (platform === "win32") {
      await restartFileFollow(restartArgs);
      return;
    }
    restartTailProcess(restartArgs);
  }

  function restartTailProcess(restartArgs: RestartFollowerArgs): void {
    stopTailProcess({ state: restartArgs.state });
    restartArgs.state.currentFilePath = restartArgs.filePath;

    const childProcess = spawn(
      "tail",
      ["-n", String(LOG_VIEWER_INITIAL_TAIL_LINES), "-F", restartArgs.filePath],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const tailProcess: TailProcess = {
      childProcess,
      filePath: restartArgs.filePath,
    };
    restartArgs.state.tailProcess = tailProcess;

    if (childProcess.stdout !== null) {
      childProcess.stdout.setEncoding("utf8");
      childProcess.stdout.on("data", (chunk: string) => {
        handleTailChunk({ chunk, state: restartArgs.state });
      });
    }

    if (childProcess.stderr !== null) {
      childProcess.stderr.setEncoding("utf8");
      childProcess.stderr.on("data", (chunk: string) => {
        const text = chunk.trim();
        if (text.length > 0) {
          emitSystemLine({
            text: `${restartArgs.state.component} tail: ${text}`,
          });
        }
      });
    }

    childProcess.once("error", (error) => {
      emitSystemLine({
        text: `${restartArgs.state.component} tail failed: ${error.message}`,
      });
    });

    childProcess.once("exit", (code, signal) => {
      if (stopped || restartArgs.state.tailProcess !== tailProcess) {
        return;
      }
      restartArgs.state.tailProcess = null;
      emitSystemLine({
        text: `${restartArgs.state.component} tail stopped with ${
          code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`
        }`,
      });
    });
  }

  async function refreshTailProcesses(): Promise<void> {
    if (stopped) {
      return;
    }

    for (const state of componentStates) {
      const currentFilePath = await resolveCurrentLogFile({
        component: state.component,
        logDir: args.logDir,
      });
      if (currentFilePath === null) {
        if (state.currentFilePath !== null) {
          stopTailProcess({ state });
        }
        continue;
      }
      if (currentFilePath !== state.currentFilePath) {
        await restartFollower({
          filePath: currentFilePath,
          state,
        });
        continue;
      }
      await followAppendedBytes({ state });
    }
  }

  function scheduleRefresh(): void {
    if (stopped) {
      return;
    }
    if (refreshInProgress) {
      refreshAgain = true;
      return;
    }

    refreshInProgress = true;
    void refreshTailProcesses()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        emitSystemLine({ text: `log refresh failed: ${message}` });
      })
      .finally(() => {
        refreshInProgress = false;
        if (refreshAgain) {
          refreshAgain = false;
          scheduleRefresh();
        }
      });
  }

  return {
    processIds() {
      return componentStates.flatMap((state) => {
        const pid = state.tailProcess?.childProcess.pid;
        return pid === undefined ? [] : [pid];
      });
    },
    async start() {
      stopped = false;
      await mkdir(args.logDir, { recursive: true });
      try {
        const watcher = watch(args.logDir, () => {
          scheduleRefresh();
        });
        directoryWatcher = watcher;
        watcher.on("error", (error) => {
          handleDirectoryWatchError({ error, watcher });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitSystemLine({ text: `log directory watch failed: ${message}` });
      }
      pollTimer = setInterval(
        scheduleRefresh,
        LOG_VIEWER_ROTATION_POLL_INTERVAL_MS,
      );
      await refreshTailProcesses();
    },
    stop() {
      stopped = true;
      directoryWatcher?.close();
      directoryWatcher = null;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      for (const state of componentStates) {
        stopTailProcess({ state });
      }
    },
  };
}
