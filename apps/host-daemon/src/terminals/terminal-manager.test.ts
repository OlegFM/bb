import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@bb/agent-runtime";
import type { HostDaemonDaemonWsMessage } from "@bb/host-daemon-contract";
import type { HostWorkspace } from "@bb/host-workspace";
import {
  isSweepRootProcess,
  unregisterSweepRootProcess,
} from "@bb/process-utils";
import {
  createDeferredPromise,
  makeWorkspaceMergeBase,
  makeWorkspaceStatus,
} from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDaemonLogger } from "../logger.js";
import {
  RuntimeManager,
  type RuntimeManagerOptions,
} from "../runtime-manager.js";
import {
  buildTerminalEnv,
  ensureNodePtySpawnHelpersExecutableInPackage,
  PRIMARY_DEVICE_ATTRIBUTES_RESPONSE,
  resolveDefaultTerminalShell,
  resolveNodePtySpawnHelperPaths,
  TERMINAL_SWEEP_REGISTER_RETRIES,
  TERMINAL_SWEEP_REGISTER_RETRY_MS,
  TerminalManager,
  TerminalShellUnavailableError,
  terminalCloseSupportsForceKill,
  terminalSpawnArgsForStart,
  terminalTitleFromShell,
  type ResolveTerminalShell,
  type SpawnTerminalPtyArgs,
  type TerminalOpenMessage,
  type TerminalPtyAdapter,
  type TerminalPtyDisposable,
  type TerminalPtyExit,
  type TerminalPtyProcess,
} from "./terminal-manager.js";

const tempDirs: string[] = [];
const DEFAULT_TERMINAL_START = { mode: "shell" } as const;
const FAKE_TERMINAL_PID = 4242;
const WINDOWS_TEST_SHELL = "C:\\Windows\\System32\\cmd.exe";

interface ResizeCall {
  cols: number;
  rows: number;
}

interface SpawnedTerminal {
  args: SpawnTerminalPtyArgs;
  pty: FakeTerminalPty;
}

interface TerminalManagerHarness {
  adapter: FakeTerminalPtyAdapter;
  logger: HostDaemonLogger;
  manager: TerminalManager;
  messages: HostDaemonDaemonWsMessage[];
  runtime: AgentRuntime;
  runtimeManager: RuntimeManager;
  workspace: HostWorkspace;
}

interface WaitForOutputArgs {
  messages: HostDaemonDaemonWsMessage[];
  text: string;
}

type TerminalMessageObserver = (message: HostDaemonDaemonWsMessage) => void;

interface CreateHarnessOptions {
  closeGracePeriodMs?: number;
  logger?: HostDaemonLogger;
  markTerminalActiveError?: Error;
  exitedRetentionMs?: number;
  maxExitedScrollbackBytes?: number;
  maxExitedTerminals?: number;
  onSendMessage: TerminalMessageObserver;
  platform?: NodeJS.Platform;
  ptyPids?: number[];
  resolveShell: ResolveTerminalShell;
}

interface CreateHarnessWithShellArgs {
  resolveShell: ResolveTerminalShell;
}

interface AttachTerminalArgs {
  requestId: string;
  terminalId: string;
}

type TerminalOutputChunk = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.output" }
>["chunk"];

type SteerTurnResult = Awaited<ReturnType<AgentRuntime["steerTurn"]>>;

async function makeTempDir(prefix: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeEmptyFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "");
}

function createFakeLogger(): HostDaemonLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

async function cleanupTempDirs(): Promise<void> {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { force: true, recursive: true })),
  );
}

class FakeTerminalPty implements TerminalPtyProcess {
  disposeCount: number;
  readonly killCalls: (string | null)[];
  readonly resizeCalls: ResizeCall[];
  readonly writeCalls: (Buffer | string)[];
  private readonly pendingPids: number[];
  private currentPid: number;
  private readonly dataListeners: ((data: string) => void)[];
  private readonly exitListeners: ((event: TerminalPtyExit) => void)[];
  private readonly registeredDataListeners: ((data: string) => void)[];
  private readonly registeredExitListeners: ((
    event: TerminalPtyExit,
  ) => void)[];

  constructor(pids: number[]) {
    this.disposeCount = 0;
    this.killCalls = [];
    this.resizeCalls = [];
    this.writeCalls = [];
    this.pendingPids = [...pids];
    this.currentPid = 0;
    this.dataListeners = [];
    this.exitListeners = [];
    this.registeredDataListeners = [];
    this.registeredExitListeners = [];
  }

  get pid(): number {
    const next = this.pendingPids.shift();
    if (next !== undefined) {
      this.currentPid = next;
    }
    return this.currentPid;
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  kill(signal?: string): void {
    this.killCalls.push(signal ?? null);
  }

  onData(listener: (data: string) => void): TerminalPtyDisposable {
    this.dataListeners.push(listener);
    this.registeredDataListeners.push(listener);
    return {
      dispose: () => {
        const index = this.dataListeners.indexOf(listener);
        if (index >= 0) {
          this.dataListeners.splice(index, 1);
        }
      },
    };
  }

  onExit(listener: (event: TerminalPtyExit) => void): TerminalPtyDisposable {
    this.exitListeners.push(listener);
    this.registeredExitListeners.push(listener);
    return {
      dispose: () => {
        const index = this.exitListeners.indexOf(listener);
        if (index >= 0) {
          this.exitListeners.splice(index, 1);
        }
      },
    };
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  write(data: Buffer | string): void {
    this.writeCalls.push(data);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode: number): void {
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode });
    }
  }

  emitStaleData(data: string): void {
    for (const listener of [...this.registeredDataListeners]) {
      listener(data);
    }
  }

  emitStaleExit(exitCode: number): void {
    for (const listener of [...this.registeredExitListeners]) {
      listener({ exitCode });
    }
  }
}

class FakeTerminalPtyAdapter implements TerminalPtyAdapter {
  readonly spawned: SpawnedTerminal[];
  private readonly pids: number[];

  constructor(pids: number[] = [FAKE_TERMINAL_PID]) {
    this.spawned = [];
    this.pids = pids;
  }

  spawn(args: SpawnTerminalPtyArgs): TerminalPtyProcess {
    const pty = new FakeTerminalPty(this.pids);
    this.spawned.push({ args, pty });
    return pty;
  }
}

class TerminalActiveFailureRuntimeManager extends RuntimeManager {
  constructor(
    options: RuntimeManagerOptions,
    private readonly failure: Error,
  ) {
    super(options);
  }

  override markTerminalActive(): void {
    throw this.failure;
  }
}

function createFakeRuntime(): AgentRuntime {
  const steerTurnResult: SteerTurnResult = { status: "steered" };
  return {
    ensureProvider: vi.fn(async () => undefined),
    startThread: vi.fn(async () => ({
      providerThreadId: "provider-thread",
    })),
    prepareThreadRewind: vi.fn(async () => ({
      providerThreadId: "provider-thread-rewind",
    })),
    discardThreadRewind: vi.fn(async () => undefined),
    resumeThread: vi.fn(async () => ({
      providerThreadId: "provider-thread",
    })),
    runTurn: vi.fn(async () => undefined),
    steerTurn: vi.fn(async () => steerTurnResult),
    stopThread: vi.fn(async () => ({ providerCheckpointId: null })),
    clearThreadGoal: vi.fn(async () => ({ cleared: true })),
    renameThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    listModels: vi.fn(async () => ({ models: [], selectedOnlyModels: [] })),
    providerHealth: vi.fn(async () => ({ supported: false as const })),
    providerUsage: vi.fn(async () => ({ supported: false as const })),
    providerInstallationStatus: vi.fn(async () => {
      throw new Error("Unexpected provider installation status call");
    }),
    providerInstallationRun: vi.fn(async () => {
      throw new Error("Unexpected provider installation run call");
    }),
    listRunningProviders: vi.fn(() => []),
    getActiveTurnId: vi.fn(() => null),
    waitForActiveTurn: vi.fn(async () => null),
    getProviderSession: vi.fn(() => null),
    reapIdleProviderSessions: vi.fn(async () => ({ reapedSessions: [] })),
    hasThread: vi.fn(() => false),
    getLiveThreadIds: vi.fn(() => []),
    hasOpenBackgroundWork: vi.fn(() => false),
    shutdown: vi.fn(async () => undefined),
  };
}

function createFakeWorkspace(path: string): HostWorkspace {
  return {
    path,
    isGitRepo: true,
    isWorktree: false,
    getCurrentBranch: vi.fn(async () => "main"),
    getHeadSha: vi.fn(async () => "commit-1"),
    getLocalStateFingerprint: vi.fn(async () => "local-1"),
    getSharedGitRefsFingerprint: vi.fn(async () => "refs-1"),
    getAdditionalWorkspaceWriteRoots: vi.fn(async () => []),
    getStatus: vi.fn(async () =>
      makeWorkspaceStatus({
        mergeBase: makeWorkspaceMergeBase(),
      }),
    ),
    getDefaultBranch: vi.fn(async () => "main"),
    getDiff: vi.fn(async () => ({
      diff: "",
      files: "",
      mergeBaseRef: null,
      shortstat: "",
      truncated: false,
    })),
    diffFiles: vi.fn(async () => ({
      files: [],
      shortstat: "",
      mergeBaseRef: null,
      truncated: false,
    })),
    diffPatch: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({ outcome: "none" as const })),
    commit: vi.fn(async () => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
    runPullRequestAction: vi.fn(async () => undefined),
  };
}

function createHarness(): TerminalManagerHarness {
  return createHarnessWithShell({
    resolveShell: async () => "/bin/zsh",
  });
}

function createHarnessWithShell(
  args: CreateHarnessWithShellArgs,
): TerminalManagerHarness {
  return createHarnessWithOptions({
    onSendMessage: () => undefined,
    resolveShell: args.resolveShell,
  });
}

function createHarnessWithOptions(
  args: CreateHarnessOptions,
): TerminalManagerHarness {
  const adapter = new FakeTerminalPtyAdapter(args.ptyPids);
  const messages: HostDaemonDaemonWsMessage[] = [];
  const runtime = createFakeRuntime();
  const workspace = createFakeWorkspace("/tmp/terminal-workspace");
  const logger = args.logger ?? createFakeLogger();
  const runtimeManagerOptions: RuntimeManagerOptions = {
    createRuntime: () => runtime,
    provisionWorkspace: async () => workspace,
    shellEnv: {
      BB_BASE_ENV: "1",
    },
  };
  const runtimeManager =
    args.markTerminalActiveError === undefined
      ? new RuntimeManager(runtimeManagerOptions)
      : new TerminalActiveFailureRuntimeManager(
          runtimeManagerOptions,
          args.markTerminalActiveError,
        );
  const manager = new TerminalManager({
    closeGracePeriodMs: args.closeGracePeriodMs,
    logger,
    platform: args.platform ?? "linux",
    exitedRetentionMs: args.exitedRetentionMs,
    maxExitedScrollbackBytes: args.maxExitedScrollbackBytes,
    maxExitedTerminals: args.maxExitedTerminals,
    ptyAdapter: adapter,
    resolveShell: args.resolveShell,
    runtimeManager,
    sendMessage: (message) => {
      messages.push(message);
      args.onSendMessage(message);
      return true;
    },
  });

  return {
    adapter,
    logger,
    manager,
    messages,
    runtime,
    runtimeManager,
    workspace,
  };
}

function collectTerminalOutput(messages: HostDaemonDaemonWsMessage[]): string {
  return messages
    .flatMap((message) =>
      message.type === "terminal.output"
        ? [Buffer.from(message.chunk.dataBase64, "base64").toString("utf8")]
        : [],
    )
    .join("");
}

async function waitForOutputContaining(args: WaitForOutputArgs): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (collectTerminalOutput(args.messages).includes(args.text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for terminal output: ${args.text}\nCurrent output:\n${collectTerminalOutput(args.messages)}\nMessages:\n${JSON.stringify(args.messages)}`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function openTerminal(
  harness: TerminalManagerHarness,
  contributedEnv: import("@bb/host-daemon-contract").HostDaemonContributedEnvEntry[] = [],
): Promise<FakeTerminalPty> {
  await harness.manager.handleMessage({
    type: "terminal.open",
    contributedEnv,
    requestId: "open-1",
    terminalId: "term-1",
    threadId: "thr-1",
    target: {
      kind: "workspace",
      environmentId: "env-1",
      workspaceContext: {
        workspacePath: "/tmp/terminal-workspace",
      },
    },
    cols: 100,
    rows: 30,
    start: DEFAULT_TERMINAL_START,
  });
  const spawned = harness.adapter.spawned[0];
  if (!spawned) {
    throw new Error("Expected terminal PTY to spawn");
  }
  return spawned.pty;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  unregisterSweepRootProcess(FAKE_TERMINAL_PID);
  await cleanupTempDirs();
});
async function openTerminalWithId(
  harness: TerminalManagerHarness,
  terminalId: string,
): Promise<FakeTerminalPty> {
  const spawnedBefore = harness.adapter.spawned.length;
  await harness.manager.handleMessage({
    type: "terminal.open",
    contributedEnv: [],
    requestId: `open-${terminalId}`,
    terminalId,
    threadId: "thr-1",
    target: {
      kind: "workspace",
      environmentId: "env-1",
      workspaceContext: {
        workspacePath: "/tmp/terminal-workspace",
      },
    },
    cols: 100,
    rows: 30,
    start: DEFAULT_TERMINAL_START,
  });
  const spawned = harness.adapter.spawned[spawnedBefore];
  if (!spawned) {
    throw new Error(`Expected terminal PTY to spawn for ${terminalId}`);
  }
  return spawned.pty;
}

async function attachTerminal(
  harness: TerminalManagerHarness,
  args: AttachTerminalArgs,
): Promise<void> {
  await harness.manager.handleMessage({
    type: "terminal.attach",
    requestId: args.requestId,
    terminalId: args.terminalId,
    sinceSeq: 0,
    tailBytes: 4 * 1024 * 1024,
  });
}

function terminalNotFoundError(
  args: AttachTerminalArgs,
): HostDaemonDaemonWsMessage {
  return {
    type: "terminal.error",
    requestId: args.requestId,
    terminalId: args.terminalId,
    code: "terminal_not_found",
    message: "Terminal session is not open",
  };
}

function textChunk(text: string, seq: number): TerminalOutputChunk {
  return {
    seq,
    dataBase64: Buffer.from(text, "utf8").toString("base64"),
  };
}

describe("TerminalManager", () => {
  it("opens a PTY in the workspace and keeps the environment active", async () => {
    const harness = createHarness();
    await openTerminal(harness);

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      cols: 100,
      cwd: "/tmp/terminal-workspace",
      file: "/bin/zsh",
      rows: 30,
    });
    expect(harness.adapter.spawned[0]?.args.env).toMatchObject({
      BB_BASE_ENV: "1",
      BB_TERMINAL_SESSION_ID: "term-1",
      COLORTERM: "truecolor",
      DISABLE_AUTO_TITLE: "true",
      FORCE_HYPERLINK: "1",
      PROMPT_EOL_MARK: "",
      TERM: "xterm-256color",
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-1",
        initialCwd: "/tmp/terminal-workspace",
        title: "zsh",
      }),
    );
    expect(harness.runtimeManager.get("env-1")?.terminals.has("term-1")).toBe(
      true,
    );
    await harness.runtimeManager.replaceBaseShellEnv({ BB_BASE_ENV: "2" });
    expect(harness.runtimeManager.get("env-1")).toBeDefined();
    expect(harness.runtime.shutdown).not.toHaveBeenCalled();
  });

  it("injects host credentials into a PTY and forwards terminal output as-is", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness, [
      {
        name: "GH_TOKEN",
        value: "terminal-private-token",
        source: { core: "machine-git" },
        reason: "Git",
      },
    ]);
    expect(harness.adapter.spawned[0]?.args.env.GH_TOKEN).toBe(
      "terminal-private-token",
    );
    pty.emitData("terminal-private-token");
    await waitForOutputContaining({
      messages: harness.messages,
      text: "terminal-private-token",
    });
    expect(collectTerminalOutput(harness.messages)).toContain(
      "terminal-private-token",
    );
  });

  it("opens a command PTY through the resolved shell", async () => {
    const harness = createHarness();

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-command",
      terminalId: "term-command",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: { mode: "command", command: "pnpm dev" },
    });

    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      args: ["-lc", "pnpm dev"],
      file: "/bin/zsh",
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-command",
        title: "pnpm dev",
      }),
    );
    expect(
      harness.runtimeManager.get("env-1")?.terminals.has("term-command"),
    ).toBe(true);

    const wideCommand = "调".repeat(100);
    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-wide-command",
      terminalId: "term-wide-command",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: { mode: "command", command: wideCommand },
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-wide-command",
        title: `${"调".repeat(38)}...`,
      }),
    );

    await harness.runtimeManager.replaceBaseShellEnv({ BB_BASE_ENV: "2" });
    expect(harness.runtimeManager.get("env-1")).toBeDefined();
    expect(harness.runtime.shutdown).not.toHaveBeenCalled();
  });

  it("opens a PTY in a host path without an environment", async () => {
    const cwd = await makeTempDir("bb-terminal-host-path-");
    const harness = createHarness();

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-host-path",
      terminalId: "term-host-path",
      target: {
        kind: "host_path",
        cwd,
      },
      cols: 80,
      rows: 24,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      cols: 80,
      cwd,
      rows: 24,
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-host-path",
        initialCwd: cwd,
      }),
    );
    expect(harness.runtimeManager.get("env-1")).toBeUndefined();
  });

  it("opens a host-path PTY in the home directory when no cwd is provided", async () => {
    const harness = createHarness();
    const expectedCwd = os.homedir();

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-host-home",
      terminalId: "term-host-home",
      target: {
        kind: "host_path",
        cwd: null,
      },
      cols: 80,
      rows: 24,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      cwd: expectedCwd,
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-host-home",
        initialCwd: expectedCwd,
      }),
    );
    expect(harness.runtimeManager.get("env-1")).toBeUndefined();
  });

  it("closes a terminal after an in-progress open finishes", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    const harness = createHarnessWithShell({
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const openPromise = harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const closePromise = harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });

    expect(harness.adapter.spawned).toHaveLength(0);
    shell.resolve("/bin/zsh");
    await Promise.all([openPromise, closePromise]);

    const pty = harness.adapter.spawned[0]?.pty;
    if (!pty) {
      throw new Error("Expected terminal PTY to spawn");
    }
    expect(harness.adapter.spawned).toHaveLength(1);
    expect(pty.killCalls).toEqual([null]);

    pty.emitExit(0);
    await vi.waitFor(() =>
      expect(
        harness.messages.filter(
          (message) => message.type === "terminal.exited",
        ),
      ).toEqual([
        {
          type: "terminal.exited",
          terminalId: "term-1",
          exitCode: 0,
          closeReason: "user",
        },
      ]),
    );
  });

  it("shuts down terminals after in-progress opens finish", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    const harness = createHarnessWithShell({
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const openPromise = harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const shutdownPromise = harness.manager.shutdownAll();
    shell.resolve("/bin/zsh");
    await Promise.all([openPromise, shutdownPromise]);

    const pty = harness.adapter.spawned[0]?.pty;
    if (!pty) {
      throw new Error("Expected terminal PTY to spawn");
    }
    expect(pty.killCalls).toEqual([null]);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    ]);
  });

  it("rejects duplicate opens queued behind an in-progress open", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    const harness = createHarnessWithShell({
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const firstOpenPromise = harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const secondOpenPromise = harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-2",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    shell.resolve("/bin/zsh");
    await Promise.all([firstOpenPromise, secondOpenPromise]);

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(resolveShellCalls).toBe(1);
    expect(harness.messages).toContainEqual({
      type: "terminal.error",
      requestId: "open-2",
      terminalId: "term-1",
      code: "terminal_exists",
      message: "Terminal session is already open",
    });
  });

  it("serializes PTY exits behind already queued terminal messages", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    let exitOnOpened = false;
    let harness: TerminalManagerHarness | null = null;
    harness = createHarnessWithOptions({
      onSendMessage: (message) => {
        if (!exitOnOpened || message.type !== "terminal.opened") {
          return;
        }
        const currentHarness = harness;
        const pty = currentHarness?.adapter.spawned[0]?.pty;
        if (!pty) {
          throw new Error("Expected terminal PTY to spawn");
        }
        pty.emitExit(0);
      },
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const firstOpenPromise = harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const secondOpenPromise = harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-2",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    exitOnOpened = true;
    shell.resolve("/bin/zsh");
    await Promise.all([firstOpenPromise, secondOpenPromise]);

    expect(harness.adapter.spawned).toHaveLength(1);
    await vi.waitFor(() =>
      expect(
        harness.messages.filter(
          (message) =>
            message.type === "terminal.opened" ||
            message.type === "terminal.error" ||
            message.type === "terminal.exited",
        ),
      ).toEqual([
        expect.objectContaining({
          type: "terminal.opened",
          requestId: "open-1",
          terminalId: "term-1",
        }),
        {
          type: "terminal.error",
          requestId: "open-2",
          terminalId: "term-1",
          code: "terminal_exists",
          message: "Terminal session is already open",
        },
        {
          type: "terminal.exited",
          terminalId: "term-1",
          exitCode: 0,
          closeReason: "process-exit",
        },
      ]),
    );
  });

  it("rejects terminal opens when the loaded runtime path differs from workspaceContext", async () => {
    const harness = createHarness();
    await harness.runtimeManager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/terminal-workspace",
    });

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-stale",
      terminalId: "term-stale",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/stale-terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.adapter.spawned).toHaveLength(0);
    expect(harness.messages).toEqual([
      {
        type: "terminal.error",
        requestId: "open-stale",
        terminalId: "term-stale",
        code: "workspace_type_mismatch",
        message:
          "Loaded environment env-1 is bound to /tmp/terminal-workspace, not /tmp/stale-terminal-workspace",
      },
    ]);
  });

  it("scrubs inherited bb runtime env vars before spawning a terminal", async () => {
    vi.stubEnv("BB_DATA_DIR", "/tmp/leaked-bb-data");
    vi.stubEnv("BB_HOST_DAEMON_PORT", "38887");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "external-secret");

    const harness = createHarness();
    await openTerminal(harness);

    const env = harness.adapter.spawned[0]?.args.env;
    expect(env).toMatchObject({
      BB_BASE_ENV: "1",
      BB_TERMINAL_SESSION_ID: "term-1",
      OPENAI_API_KEY: "external-secret",
    });
    expect(env?.BB_DATA_DIR).toBeUndefined();
    expect(env?.BB_HOST_DAEMON_PORT).toBeUndefined();
    expect(env?.NODE_ENV).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "makes every available node-pty spawn-helper executable (NTFS has no POSIX mode bits)",
    async () => {
      const logger = createFakeLogger();
      const packageDirectory = await makeTempDir("bb-node-pty-package-");
      const buildNativePath = path.join(
        packageDirectory,
        "build",
        "Release",
        "pty.node",
      );
      const buildHelperPath = path.join(
        packageDirectory,
        "build",
        "Release",
        "spawn-helper",
      );
      const prebuildHelperPath = path.join(
        packageDirectory,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper",
      );
      await writeEmptyFile(buildNativePath);
      await writeEmptyFile(buildHelperPath);
      await fs.chmod(buildHelperPath, 0o644);
      await writeEmptyFile(
        path.join(
          packageDirectory,
          "prebuilds",
          `${process.platform}-${process.arch}`,
          "pty.node",
        ),
      );
      await writeEmptyFile(prebuildHelperPath);
      await fs.chmod(prebuildHelperPath, 0o644);

      expect(resolveNodePtySpawnHelperPaths({ packageDirectory })).toEqual([
        buildHelperPath,
        prebuildHelperPath,
      ]);

      ensureNodePtySpawnHelpersExecutableInPackage({
        logger,
        packageDirectory,
      });

      const buildHelperMode = (await fs.stat(buildHelperPath)).mode;
      const prebuildHelperMode = (await fs.stat(prebuildHelperPath)).mode;
      expect(buildHelperMode & 0o111).not.toBe(0);
      expect(prebuildHelperMode & 0o111).not.toBe(0);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "makes an available prebuild-only node-pty spawn-helper executable (NTFS has no POSIX mode bits)",
    async () => {
      const logger = createFakeLogger();
      const packageDirectory = await makeTempDir("bb-node-pty-package-");
      const prebuildHelperPath = path.join(
        packageDirectory,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper",
      );
      await writeEmptyFile(
        path.join(
          packageDirectory,
          "prebuilds",
          `${process.platform}-${process.arch}`,
          "pty.node",
        ),
      );
      await writeEmptyFile(prebuildHelperPath);
      await fs.chmod(prebuildHelperPath, 0o644);

      expect(resolveNodePtySpawnHelperPaths({ packageDirectory })).toEqual([
        prebuildHelperPath,
      ]);

      ensureNodePtySpawnHelpersExecutableInPackage({
        logger,
        packageDirectory,
      });

      const prebuildHelperMode = (await fs.stat(prebuildHelperPath)).mode;
      expect(prebuildHelperMode & 0o111).not.toBe(0);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("logs and skips when no node-pty spawn-helper is present", async () => {
    const logger = createFakeLogger();
    const packageDirectory = await makeTempDir("bb-node-pty-package-");
    const buildHelperPath = path.join(
      packageDirectory,
      "build",
      "Release",
      "spawn-helper",
    );
    const prebuildHelperPath = path.join(
      packageDirectory,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    await writeEmptyFile(
      path.join(packageDirectory, "build", "Release", "pty.node"),
    );
    await writeEmptyFile(
      path.join(
        packageDirectory,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "pty.node",
      ),
    );

    expect(() =>
      ensureNodePtySpawnHelpersExecutableInPackage({
        logger,
        packageDirectory,
      }),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith({
      component: "terminal-manager",
      msg: "no node-pty spawn-helper found at known paths",
      searched: expect.arrayContaining([buildHelperPath, prebuildHelperPath]),
    });
  });

  it("forwards output and replays scrollback on attach", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("hello");
    pty.emitData("\n");
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-1",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    expect(
      harness.messages.filter((message) => message.type === "terminal.output"),
    ).toEqual([
      {
        type: "terminal.output",
        terminalId: "term-1",
        chunk: {
          seq: 0,
          dataBase64: Buffer.from("hello\n", "utf8").toString("base64"),
        },
      },
    ]);
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-1",
      terminalId: "term-1",
      chunks: [
        {
          seq: 0,
          dataBase64: Buffer.from("hello\n", "utf8").toString("base64"),
        },
      ],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("replays retained scrollback after the terminal exits", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("build failed\n");
    pty.emitExit(1);
    await attachTerminal(harness, {
      requestId: "attach-exited",
      terminalId: "term-1",
    });

    expect(harness.messages).toContainEqual({
      type: "terminal.exited",
      terminalId: "term-1",
      exitCode: 1,
      closeReason: "process-exit",
    });
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-exited",
      terminalId: "term-1",
      chunks: [textChunk("build failed\n", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("keeps a retained terminal read-only after it exits", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("build failed\n");
    pty.emitExit(1);
    await harness.manager.handleMessage({
      type: "terminal.input",
      terminalId: "term-1",
      dataBase64: Buffer.from("pwd\n", "utf8").toString("base64"),
    });
    await harness.manager.handleMessage({
      type: "terminal.resize",
      terminalId: "term-1",
      cols: 120,
      rows: 40,
    });
    pty.emitStaleData("after exit\n");
    await attachTerminal(harness, {
      requestId: "attach-read-only",
      terminalId: "term-1",
    });

    expect(pty.writeCalls).toEqual([]);
    expect(pty.resizeCalls).toEqual([]);
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-read-only",
      terminalId: "term-1",
      chunks: [textChunk("build failed\n", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("forgets retained scrollback once the retention window passes", async () => {
    vi.useFakeTimers();
    const harness = createHarnessWithOptions({
      exitedRetentionMs: 60_000,
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/zsh",
    });
    const pty = await openTerminal(harness);

    pty.emitData("build failed\n");
    pty.emitExit(1);
    await vi.advanceTimersByTimeAsync(59_000);
    await attachTerminal(harness, {
      requestId: "attach-before-expiry",
      terminalId: "term-1",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await attachTerminal(harness, {
      requestId: "attach-after-expiry",
      terminalId: "term-1",
    });

    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-before-expiry",
      terminalId: "term-1",
      chunks: [textChunk("build failed\n", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
    expect(harness.messages).toContainEqual(
      terminalNotFoundError({
        requestId: "attach-after-expiry",
        terminalId: "term-1",
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evicts the oldest retained terminal past the retained terminal cap", async () => {
    const harness = createHarnessWithOptions({
      maxExitedTerminals: 1,
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/zsh",
    });
    const first = await openTerminalWithId(harness, "term-first");
    first.emitData("first output\n");
    first.emitExit(0);
    const second = await openTerminalWithId(harness, "term-second");
    second.emitData("second output\n");
    second.emitExit(0);

    await attachTerminal(harness, {
      requestId: "attach-first",
      terminalId: "term-first",
    });
    await attachTerminal(harness, {
      requestId: "attach-second",
      terminalId: "term-second",
    });

    expect(harness.messages).toContainEqual(
      terminalNotFoundError({
        requestId: "attach-first",
        terminalId: "term-first",
      }),
    );
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-second",
      terminalId: "term-second",
      chunks: [textChunk("second output\n", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("evicts the oldest retained terminal past the retained byte cap", async () => {
    const harness = createHarnessWithOptions({
      maxExitedScrollbackBytes: 8,
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/zsh",
    });
    const first = await openTerminalWithId(harness, "term-first");
    first.emitData("first output\n");
    first.emitExit(0);
    await attachTerminal(harness, {
      requestId: "attach-only-retained",
      terminalId: "term-first",
    });
    const second = await openTerminalWithId(harness, "term-second");
    second.emitData("second output\n");
    second.emitExit(0);
    await attachTerminal(harness, {
      requestId: "attach-evicted",
      terminalId: "term-first",
    });
    await attachTerminal(harness, {
      requestId: "attach-newest",
      terminalId: "term-second",
    });

    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-only-retained",
      terminalId: "term-first",
      chunks: [textChunk("first output\n", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
    expect(harness.messages).toContainEqual(
      terminalNotFoundError({
        requestId: "attach-evicted",
        terminalId: "term-first",
      }),
    );
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-newest",
      terminalId: "term-second",
      chunks: [textChunk("second output\n", 0)],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("clears retained scrollback and its timers on dispose", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("build failed\n");
    pty.emitExit(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    harness.manager.dispose();
    await attachTerminal(harness, {
      requestId: "attach-disposed",
      terminalId: "term-1",
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(harness.messages).toContainEqual(
      terminalNotFoundError({
        requestId: "attach-disposed",
        terminalId: "term-1",
      }),
    );
  });

  it("answers primary device attribute queries without replaying them", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("before\u001b[0cbetween\u001b[cafter");
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-da1",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    expect(pty.writeCalls).toEqual(["\u001b[?1;2c\u001b[?1;2c"]);
    expect(collectTerminalOutput(harness.messages)).toBe("beforebetweenafter");
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-da1",
      terminalId: "term-1",
      chunks: [
        {
          seq: 0,
          dataBase64: Buffer.from("beforebetweenafter", "utf8").toString(
            "base64",
          ),
        },
      ],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("answers primary device attribute queries split across output chunks", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    for (const chunk of ["\u001b", "[", "0", "c", "\u001b[", "c"]) {
      pty.emitData(chunk);
    }
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-split-da1",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    expect(pty.writeCalls).toEqual(["\u001b[?1;2c", "\u001b[?1;2c"]);
    expect(collectTerminalOutput(harness.messages)).toBe("");
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-split-da1",
      terminalId: "term-1",
      chunks: [],
      replayStartSeq: 0,
      nextSeq: 0,
    });
  });

  it("bounds device attribute replies for one flooded output chunk", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("\u001b[c".repeat(5_000));

    expect(pty.writeCalls).toEqual(["\u001b[?1;2c".repeat(8)]);
    expect(collectTerminalOutput(harness.messages)).toBe("");
  });

  it("preserves near matches and incomplete device attribute queries on exit", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("before\u001b[1cafter\u001b[0");
    pty.emitExit(0);

    expect(pty.writeCalls).toEqual([]);
    expect(collectTerminalOutput(harness.messages)).toBe(
      "before\u001b[1cafter\u001b[0",
    );
    expect(
      harness.messages
        .filter(
          (message) =>
            message.type === "terminal.output" ||
            message.type === "terminal.exited",
        )
        .map((message) => message.type),
    ).toEqual(["terminal.output", "terminal.exited"]);
  });

  it("bounds replay to the requested tail without splitting output chunks", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData(`${"a".repeat(64 * 1024)}tail`);
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-tail",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4,
    });

    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-tail",
      terminalId: "term-1",
      chunks: [
        {
          seq: 1,
          dataBase64: Buffer.from("tail", "utf8").toString("base64"),
        },
      ],
      replayStartSeq: 1,
      nextSeq: 2,
    });
  });

  it("flushes pending output before the PTY exit message", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("final output");
    pty.emitExit(0);

    expect(
      harness.messages
        .filter(
          (message) =>
            message.type === "terminal.output" ||
            message.type === "terminal.exited",
        )
        .map((message) => message.type),
    ).toEqual(["terminal.output", "terminal.exited"]);
    expect(collectTerminalOutput(harness.messages)).toBe("final output");
  });

  it("writes input and resizes the active PTY", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    await harness.manager.handleMessage({
      type: "terminal.input",
      terminalId: "term-1",
      dataBase64: Buffer.from("pwd\n", "utf8").toString("base64"),
    });
    await harness.manager.handleMessage({
      type: "terminal.resize",
      terminalId: "term-1",
      cols: 120,
      rows: 40,
    });
    await harness.manager.handleMessage({
      type: "terminal.resize",
      terminalId: "term-1",
      cols: 120,
      rows: 40,
    });

    expect(pty.writeCalls).toHaveLength(1);
    expect(pty.writeCalls[0]).toEqual(Buffer.from("pwd\n"));
    expect(pty.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("kills a terminal and emits exactly one user exit", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });
    pty.emitExit(0);
    pty.emitExit(0);

    expect(pty.killCalls).toEqual([null]);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: 0,
        closeReason: "user",
      },
    ]);
    await harness.runtimeManager.replaceBaseShellEnv({ BB_BASE_ENV: "2" });
    expect(harness.runtimeManager.get("env-1")).toBeUndefined();
    expect(harness.runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("acknowledges closing a terminal that is already gone", async () => {
    const harness = createHarness();

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-missing",
      reason: "user",
    });

    expect(harness.messages).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-missing",
        exitCode: null,
        closeReason: "user",
      },
    ]);
  });

  it("force kills and cleans up a terminal when node-pty never emits exit", async () => {
    vi.useFakeTimers();
    const harness = createHarnessWithOptions({
      closeGracePeriodMs: 10,
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/zsh",
    });
    const pty = await openTerminal(harness);

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(pty.killCalls).toEqual([null, "SIGKILL"]);
    expect(pty.disposeCount).toBe(1);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "user",
      },
    ]);
    await harness.runtimeManager.replaceBaseShellEnv({ BB_BASE_ENV: "2" });
    expect(harness.runtimeManager.get("env-1")).toBeUndefined();
  });

  it("kills all terminals on shutdown", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    await harness.manager.shutdownAll();
    pty.emitExit(0);

    expect(pty.killCalls).toEqual([null]);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    ]);
  });

  it("ignores stale output and exits from a replaced PTY", async () => {
    const harness = createHarness();
    const oldPty = await openTerminal(harness);

    await harness.manager.shutdownAll();
    await openTerminal(harness);
    const newPty = harness.adapter.spawned[1]?.pty;
    if (!newPty) {
      throw new Error("Expected replacement terminal PTY to spawn");
    }

    oldPty.emitStaleData("stale-output\n");
    oldPty.emitStaleExit(7);
    newPty.emitData("current-output\n");
    await harness.manager.handleMessage({
      type: "terminal.input",
      terminalId: "term-1",
      dataBase64: Buffer.from("pwd\n", "utf8").toString("base64"),
    });
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-replacement",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    expect(newPty.writeCalls).toEqual([Buffer.from("pwd\n")]);
    expect(collectTerminalOutput(harness.messages)).toContain(
      "current-output\n",
    );
    expect(collectTerminalOutput(harness.messages)).not.toContain(
      "stale-output\n",
    );
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    ]);
  });

  it("closes a Windows terminal with a single kill and no force stage", async () => {
    vi.useFakeTimers();
    const harness = createHarnessWithOptions({
      closeGracePeriodMs: 10,
      onSendMessage: () => undefined,
      platform: "win32",
      resolveShell: async () => WINDOWS_TEST_SHELL,
    });
    const pty = await openTerminal(harness);

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(pty.killCalls).toEqual([null]);
    expect(pty.disposeCount).toBe(1);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "user",
      },
    ]);
  });

  it("keeps the two-stage close on POSIX", async () => {
    vi.useFakeTimers();
    const harness = createHarnessWithOptions({
      closeGracePeriodMs: 10,
      onSendMessage: () => undefined,
      platform: "linux",
      resolveShell: async () => "/bin/zsh",
    });
    const pty = await openTerminal(harness);

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(pty.killCalls).toEqual([null, "SIGKILL"]);
    expect(pty.disposeCount).toBe(1);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "user",
      },
    ]);
  });

  it("registers the Windows pty as a sweep root once its pid is known", async () => {
    vi.useFakeTimers();
    const harness = createHarnessWithOptions({
      onSendMessage: () => undefined,
      platform: "win32",
      ptyPids: [0, 0, FAKE_TERMINAL_PID],
      resolveShell: async () => WINDOWS_TEST_SHELL,
    });
    const pty = await openTerminal(harness);

    expect(isSweepRootProcess(FAKE_TERMINAL_PID)).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * TERMINAL_SWEEP_REGISTER_RETRY_MS);
    expect(isSweepRootProcess(FAKE_TERMINAL_PID)).toBe(true);

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });
    pty.emitExit(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(isSweepRootProcess(FAKE_TERMINAL_PID)).toBe(false);
  });

  it("gives up registering the sweep root once the pid never arrives", async () => {
    vi.useFakeTimers();
    const logger = createFakeLogger();
    const harness = createHarnessWithOptions({
      logger,
      onSendMessage: () => undefined,
      platform: "win32",
      ptyPids: [0],
      resolveShell: async () => WINDOWS_TEST_SHELL,
    });
    await openTerminal(harness);

    await vi.advanceTimersByTimeAsync(
      TERMINAL_SWEEP_REGISTER_RETRIES * TERMINAL_SWEEP_REGISTER_RETRY_MS,
    );

    expect(isSweepRootProcess(FAKE_TERMINAL_PID)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      { terminalId: "term-1" },
      "Terminal pty never reported a pid; sweep root not registered",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not register sweep roots on POSIX", async () => {
    vi.useFakeTimers();
    const harness = createHarnessWithOptions({
      onSendMessage: () => undefined,
      platform: "linux",
      ptyPids: [0, 0, FAKE_TERMINAL_PID],
      resolveShell: async () => "/bin/zsh",
    });
    await openTerminal(harness);

    expect(isSweepRootProcess(FAKE_TERMINAL_PID)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes the device attributes reply as UTF-8 bytes on Windows", async () => {
    const harness = createHarnessWithOptions({
      onSendMessage: () => undefined,
      platform: "win32",
      resolveShell: async () => WINDOWS_TEST_SHELL,
    });
    const pty = await openTerminal(harness);

    pty.emitData("before\u001b[cafter");

    expect(pty.writeCalls).toEqual([
      Buffer.from(PRIMARY_DEVICE_ATTRIBUTES_RESPONSE, "utf8"),
    ]);
  });

  it("writes the device attributes reply as a string on POSIX", async () => {
    const harness = createHarnessWithOptions({
      onSendMessage: () => undefined,
      platform: "linux",
      resolveShell: async () => "/bin/zsh",
    });
    const pty = await openTerminal(harness);

    pty.emitData("before\u001b[cafter");

    expect(pty.writeCalls).toEqual([PRIMARY_DEVICE_ATTRIBUTES_RESPONSE]);
  });

  it("kills the orphan pty when a Windows open fails after spawn", async () => {
    const harness = createHarnessWithOptions({
      markTerminalActiveError: new Error("terminal activation failed"),
      onSendMessage: () => undefined,
      platform: "win32",
      resolveShell: async () => WINDOWS_TEST_SHELL,
    });
    const markInactive = vi.spyOn(
      harness.runtimeManager,
      "markTerminalInactive",
    );
    const pty = await openTerminal(harness);

    expect(pty.killCalls).toEqual([null]);
    expect(pty.disposeCount).toBe(1);
    expect(harness.manager.listOpenTerminalPids()).toEqual([]);
    expect(isSweepRootProcess(FAKE_TERMINAL_PID)).toBe(false);
    expect(markInactive).not.toHaveBeenCalled();
    expect(harness.messages).toEqual([
      {
        type: "terminal.error",
        requestId: "open-1",
        terminalId: "term-1",
        code: "terminal_open_failed",
        message: "terminal activation failed",
      },
    ]);
  });

  it("leaves the orphan pty alone on POSIX (pre-existing upstream behaviour)", async () => {
    const harness = createHarnessWithOptions({
      markTerminalActiveError: new Error("terminal activation failed"),
      onSendMessage: () => undefined,
      platform: "linux",
      resolveShell: async () => "/bin/zsh",
    });
    const pty = await openTerminal(harness);

    expect(pty.killCalls).toEqual([]);
    expect(pty.disposeCount).toBe(0);
    expect(harness.manager.listOpenTerminalPids()).toEqual([FAKE_TERMINAL_PID]);
    expect(harness.messages).toEqual([
      {
        type: "terminal.error",
        requestId: "open-1",
        terminalId: "term-1",
        code: "terminal_open_failed",
        message: "terminal activation failed",
      },
    ]);
  });

  it("opens a native Windows terminal through the injected adapter", async () => {
    const shell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const harness = createHarnessWithOptions({
      onSendMessage: () => undefined,
      platform: "win32",
      resolveShell: async () => shell,
    });

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-1",
        shell,
        title: "pwsh.exe",
      }),
    );
    expect(harness.adapter.spawned).toHaveLength(1);
    const spawned = harness.adapter.spawned[0];
    expect(spawned?.args).toMatchObject({ args: ["-NoLogo"], file: shell });
    const spawnedEnv = spawned?.args.env ?? {};
    expect(
      Object.keys(spawnedEnv).filter((key) => key.toLowerCase() === "path"),
    ).toEqual(["Path"]);
  });

  it("reports an unavailable Windows shell without spawning", async () => {
    const harness = createHarnessWithOptions({
      onSendMessage: () => undefined,
      platform: "win32",
      resolveShell: async () => {
        throw new TerminalShellUnavailableError();
      },
    });

    await harness.manager.handleMessage({
      type: "terminal.open",
      contributedEnv: [],
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.adapter.spawned).toHaveLength(0);
    expect(harness.messages).toEqual([
      {
        type: "terminal.error",
        requestId: "open-1",
        terminalId: "term-1",
        code: "shell_unavailable",
        message:
          "No terminal shell was found: tried pwsh.exe, powershell.exe, ComSpec and cmd.exe",
      },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "runs commands in one persistent shell from the workspace cwd (POSIX /bin/sh)",
    async () => {
      const workspacePath = await makeTempDir("bb-terminal-manager-real-");
      const targetPath = await makeTempDir("bb-terminal-manager-target-");
      const expectedWorkspacePath = await fs.realpath(workspacePath);
      const expectedTargetPath = await fs.realpath(targetPath);
      const messages: HostDaemonDaemonWsMessage[] = [];
      const runtimeManager = new RuntimeManager({
        createRuntime: () => createFakeRuntime(),
        provisionWorkspace: async () => createFakeWorkspace(workspacePath),
      });
      const manager = new TerminalManager({
        logger: {
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        },
        resolveShell: async () => "/bin/sh",
        runtimeManager,
        sendMessage: (message) => {
          messages.push(message);
          return true;
        },
      });

      await manager.handleMessage({
        type: "terminal.open",
        contributedEnv: [],
        requestId: "open-real",
        terminalId: "term-real",
        threadId: "thr-real",
        target: {
          kind: "workspace",
          environmentId: "env-real",
          workspaceContext: {
            workspacePath,
          },
        },
        cols: 100,
        rows: 30,
        start: DEFAULT_TERMINAL_START,
      });
      await manager.handleMessage({
        type: "terminal.input",
        terminalId: "term-real",
        dataBase64: Buffer.from(
          [
            'printf "__PWD1:%s\\n" "$(pwd -P)"',
            `cd ${shellQuote(targetPath)}`,
            'printf "__PWD2:%s\\n" "$(pwd -P)"',
            "",
          ].join("\n"),
          "utf8",
        ).toString("base64"),
      });

      await waitForOutputContaining({
        messages,
        text: `__PWD1:${expectedWorkspacePath}`,
      });
      await waitForOutputContaining({
        messages,
        text: `__PWD2:${expectedTargetPath}`,
      });
      await manager.shutdownAll();
    },
    10_000,
  );
});

function makeTerminalOpenMessage(
  start: TerminalOpenMessage["start"],
): TerminalOpenMessage {
  return {
    type: "terminal.open",
    contributedEnv: [],
    requestId: "open-1",
    terminalId: "term-1",
    threadId: "thr-1",
    target: {
      kind: "workspace",
      environmentId: "env-1",
      workspaceContext: {
        workspacePath: "/tmp/terminal-workspace",
      },
    },
    cols: 100,
    rows: 30,
    start,
  };
}

function makeExecutableSet(
  executables: string[],
): (filePath: string) => Promise<boolean> {
  const allowed = new Set(executables);
  return async (filePath) => allowed.has(filePath);
}

describe("resolveDefaultTerminalShell", () => {
  it("prefers pwsh found on Path on Windows", async () => {
    await expect(
      resolveDefaultTerminalShell({
        platform: "win32",
        env: { Path: "C:\\Program Files\\PowerShell\\7" },
        pathIsExecutable: makeExecutableSet([]),
        resolveExecutable: async (executableArgs) =>
          executableArgs.command === "pwsh" &&
          executableArgs.platform === "win32"
            ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
            : null,
      }),
    ).resolves.toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("ignores a pwsh launcher shim on Path on Windows", async () => {
    await expect(
      resolveDefaultTerminalShell({
        platform: "win32",
        env: {
          PATHEXT: ".EXE;.CMD",
          Path: "C:\\shims",
          ProgramFiles: "C:\\Program Files",
          SystemRoot: "C:\\Windows",
        },
        pathIsExecutable: makeExecutableSet([
          "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        ]),
        resolveExecutable: async () => "C:\\shims\\pwsh.cmd",
      }),
    ).resolves.toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("falls back to the ProgramFiles pwsh install on Windows", async () => {
    await expect(
      resolveDefaultTerminalShell({
        platform: "win32",
        env: {
          ProgramFiles: "C:\\Program Files",
          SystemRoot: "C:\\Windows",
          ComSpec: "D:\\shells\\cmd.exe",
        },
        pathIsExecutable: makeExecutableSet([
          "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          "D:\\shells\\cmd.exe",
        ]),
        resolveExecutable: async () => null,
      }),
    ).resolves.toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("falls back to Windows PowerShell 5.1 on Windows", async () => {
    await expect(
      resolveDefaultTerminalShell({
        platform: "win32",
        env: { SystemRoot: "C:\\Windows", ComSpec: "D:\\shells\\cmd.exe" },
        pathIsExecutable: makeExecutableSet([
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          "D:\\shells\\cmd.exe",
        ]),
        resolveExecutable: async () => null,
      }),
    ).resolves.toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("falls back to ComSpec before the System32 cmd.exe on Windows", async () => {
    await expect(
      resolveDefaultTerminalShell({
        platform: "win32",
        env: { SystemRoot: "C:\\Windows", ComSpec: "D:\\shells\\cmd.exe" },
        pathIsExecutable: makeExecutableSet([
          "D:\\shells\\cmd.exe",
          "C:\\Windows\\System32\\cmd.exe",
        ]),
        resolveExecutable: async () => null,
      }),
    ).resolves.toBe("D:\\shells\\cmd.exe");
  });

  it("falls back to the System32 cmd.exe on Windows", async () => {
    await expect(
      resolveDefaultTerminalShell({
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        pathIsExecutable: makeExecutableSet(["C:\\Windows\\System32\\cmd.exe"]),
        resolveExecutable: async () => null,
      }),
    ).resolves.toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("rejects when no Windows shell is available", async () => {
    await expect(
      resolveDefaultTerminalShell({
        platform: "win32",
        env: { SystemRoot: "C:\\Windows", ComSpec: "D:\\shells\\cmd.exe" },
        pathIsExecutable: makeExecutableSet([]),
        resolveExecutable: async () => null,
      }),
    ).rejects.toThrow(TerminalShellUnavailableError);
  });

  it("accepts a Windows candidate that exists without the executable bit", async () => {
    const shellDir = await makeTempDir("bb-terminal-shell-");
    const comSpecPath = path.join(shellDir, "cmd.exe");
    await fs.writeFile(comSpecPath, "");
    await fs.chmod(comSpecPath, 0o644);

    await expect(
      resolveDefaultTerminalShell({
        platform: "win32",
        env: {
          SystemRoot: path.join(shellDir, "missing-windows-root"),
          ComSpec: comSpecPath,
        },
        resolveExecutable: async () => null,
      }),
    ).resolves.toBe(comSpecPath);
  });

  it("uses an executable SHELL on POSIX", async () => {
    await expect(
      resolveDefaultTerminalShell({
        platform: "linux",
        env: { SHELL: "/usr/bin/fish" },
        pathIsExecutable: makeExecutableSet(["/usr/bin/fish"]),
      }),
    ).resolves.toBe("/usr/bin/fish");
  });

  it("prefers /bin/zsh over /bin/bash when SHELL is not executable on POSIX", async () => {
    await expect(
      resolveDefaultTerminalShell({
        platform: "linux",
        env: { SHELL: "/usr/bin/fish" },
        pathIsExecutable: makeExecutableSet(["/bin/zsh", "/bin/bash"]),
      }),
    ).resolves.toBe("/bin/zsh");
  });

  it("falls back to /bin/sh when nothing is executable on POSIX", async () => {
    await expect(
      resolveDefaultTerminalShell({
        platform: "linux",
        env: {},
        pathIsExecutable: makeExecutableSet([]),
      }),
    ).resolves.toBe("/bin/sh");
  });

  it("reads SHELL from process.env by default on POSIX", async () => {
    vi.stubEnv("SHELL", "/usr/bin/fish");

    await expect(
      resolveDefaultTerminalShell({
        platform: "linux",
        pathIsExecutable: makeExecutableSet(["/usr/bin/fish"]),
      }),
    ).resolves.toBe("/usr/bin/fish");
  });
});

describe("terminalSpawnArgsForStart", () => {
  it("starts a Windows PowerShell session with -NoLogo only", () => {
    for (const shell of [
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ]) {
      const args = terminalSpawnArgsForStart(
        makeTerminalOpenMessage({ mode: "shell" }),
        shell,
        "win32",
      );

      expect(args).toEqual(["-NoLogo"]);
      expect(args).not.toContain("-NoProfile");
      expect(args).not.toContain("chcp");
    }
  });

  it("runs a Windows PowerShell command through -Command", () => {
    for (const shell of [
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ]) {
      const args = terminalSpawnArgsForStart(
        makeTerminalOpenMessage({ mode: "command", command: "git status" }),
        shell,
        "win32",
      );

      expect(args).toEqual(["-NoLogo", "-Command", "git status"]);
      expect(args).not.toContain("-NoProfile");
      expect(args).not.toContain("chcp");
    }
  });

  it("starts a Windows cmd.exe session with no arguments", () => {
    const args = terminalSpawnArgsForStart(
      makeTerminalOpenMessage({ mode: "shell" }),
      "C:\\Windows\\System32\\cmd.exe",
      "win32",
    );

    expect(args).toEqual([]);
    expect(args).not.toContain("-NoProfile");
    expect(args).not.toContain("chcp");
  });

  it("runs a Windows cmd.exe command through /s /c", () => {
    expect(
      terminalSpawnArgsForStart(
        makeTerminalOpenMessage({ mode: "command", command: "git status" }),
        "C:\\Windows\\System32\\cmd.exe",
        "win32",
      ),
    ).toEqual(["/s", "/c", "git status"]);
  });

  it("spawns a POSIX login shell with no arguments", () => {
    expect(
      terminalSpawnArgsForStart(
        makeTerminalOpenMessage({ mode: "shell" }),
        "/bin/zsh",
        "linux",
      ),
    ).toEqual([]);
  });

  it("runs a POSIX command through -lc", () => {
    expect(
      terminalSpawnArgsForStart(
        makeTerminalOpenMessage({ mode: "command", command: "git status" }),
        "/bin/zsh",
        "linux",
      ),
    ).toEqual(["-lc", "git status"]);
  });
});

describe("buildTerminalEnv", () => {
  it("collapses every PATH casing into one Path on Windows", () => {
    const env = buildTerminalEnv({
      shellEnv: { PATH: "C:\\bb;C:\\old" },
      terminalId: "term-1",
      platform: "win32",
      inheritedEnv: { Path: "C:\\old", PATH: "C:\\older", HOME: "x" },
    });

    expect(
      Object.keys(env).filter((key) => key.toLowerCase() === "path"),
    ).toEqual(["Path"]);
    expect(env.Path).toBe("C:\\bb;C:\\old");
    expect(env).toMatchObject({
      BB_TERMINAL_SESSION_ID: "term-1",
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    });
  });

  it("keeps the inherited Path on Windows when the shell env has none", () => {
    const env = buildTerminalEnv({
      shellEnv: { BB_BASE_ENV: "1" },
      terminalId: "term-1",
      platform: "win32",
      inheritedEnv: { Path: "C:\\inherited", HOME: "x" },
    });

    expect(
      Object.keys(env).filter((key) => key.toLowerCase() === "path"),
    ).toEqual(["Path"]);
    expect(env.Path).toBe("C:\\inherited");
  });

  it("merges the sanitized inherited env, the shell env and the fixed terminal keys on POSIX", () => {
    const env = buildTerminalEnv({
      shellEnv: { PATH: "/bb/bin:/usr/bin", SHELL_ONLY: "shell" },
      terminalId: "term-1",
      platform: "linux",
      inheritedEnv: {
        HOME: "/home/tester",
        PATH: "/usr/bin",
        NODE_ENV: "test",
        BB_DROPPED: "1",
      },
    });

    expect(Object.keys(env)).toEqual([
      "HOME",
      "PATH",
      "SHELL_ONLY",
      "BB_TERMINAL_SESSION_ID",
      "COLORTERM",
      "DISABLE_AUTO_TITLE",
      "FORCE_HYPERLINK",
      "PROMPT_EOL_MARK",
      "TERM",
    ]);
    expect(env).toEqual({
      HOME: "/home/tester",
      PATH: "/bb/bin:/usr/bin",
      SHELL_ONLY: "shell",
      BB_TERMINAL_SESSION_ID: "term-1",
      COLORTERM: "truecolor",
      DISABLE_AUTO_TITLE: "true",
      FORCE_HYPERLINK: "1",
      PROMPT_EOL_MARK: "",
      TERM: "xterm-256color",
    });
  });

  it("inherits process.env by default", () => {
    vi.stubEnv("BB_TERMINAL_ENV_PIN", "inherited");
    vi.stubEnv("TERMINAL_ENV_PIN", "inherited");

    const env = buildTerminalEnv({
      shellEnv: {},
      terminalId: "term-1",
      platform: "linux",
    });

    expect(env.TERMINAL_ENV_PIN).toBe("inherited");
    expect(env.BB_TERMINAL_ENV_PIN).toBeUndefined();
  });
});

describe("terminalCloseSupportsForceKill", () => {
  it("refuses the force stage on Windows and keeps it on POSIX", () => {
    expect(terminalCloseSupportsForceKill("win32")).toBe(false);
    expect(terminalCloseSupportsForceKill("linux")).toBe(true);
    expect(terminalCloseSupportsForceKill("darwin")).toBe(true);
  });
});

describe("terminalTitleFromShell", () => {
  it("uses the Windows executable file name", () => {
    expect(
      terminalTitleFromShell(
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "win32",
      ),
    ).toBe("pwsh.exe");
  });

  it("uses the Windows executable file name after a forward slash", () => {
    expect(
      terminalTitleFromShell("C:/Program Files/PowerShell/7/pwsh.exe", "win32"),
    ).toBe("pwsh.exe");
  });

  it("uses the POSIX basename", () => {
    expect(terminalTitleFromShell("/bin/zsh", "linux")).toBe("zsh");
  });

  it("falls back to Terminal when the shell has no basename", () => {
    expect(terminalTitleFromShell("", "linux")).toBe("Terminal");
  });
});
