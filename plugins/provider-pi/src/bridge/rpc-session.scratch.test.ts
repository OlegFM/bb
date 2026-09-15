import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PI_BRIDGE_ARGS_ENV, PI_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import { PiRpcSession } from "./rpc-session.js";

const onWindows = process.platform === "win32";
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeSession(): { session: PiRpcSession; scratchDir: string } {
  const workspace = mkdtempSync(join(tmpdir(), "bb-pi-scratch-"));
  temporaryDirectories.push(workspace);
  const scratchDir = join(workspace, "scratch");
  const extensionPath = join(workspace, "bb-extension.mjs");
  writeFileSync(extensionPath, "export default {};\n");
  const session = new PiRpcSession(
    {
      cwd: workspace,
      sessionFilePath: join(workspace, "session.jsonl"),
      sessionDir: join(workspace, "sessions"),
      scratchDir,
      extensionPath,
      recordThreadId: "thr_scratch",
      noSession: true,
      systemPrompt: "system prompt",
      appendSystemPrompt: "append prompt",
    },
    async () => {
      throw new Error("the scratch-file test never forwards a tool call");
    },
    () => undefined,
    () => undefined,
  );
  return { session, scratchDir };
}

it.runIf(onWindows)(
  "removes the scratch files on win32 when the launch plan cannot be built",
  async () => {
    vi.stubEnv(PI_BRIDGE_COMMAND_ENV, "bb-pi-that-does-not-exist");
    vi.stubEnv(PI_BRIDGE_ARGS_ENV, "[1]");
    const { session, scratchDir } = makeSession();

    await expect(session.start()).rejects.toThrow(
      `${PI_BRIDGE_ARGS_ENV} must be a JSON array of strings`,
    );
    expect(readdirSync(scratchDir)).toEqual([]);
  },
);

it.skipIf(onWindows)(
  "leaves the scratch files on POSIX when the launch plan cannot be built, matching pre-existing behaviour",
  async () => {
    vi.stubEnv(PI_BRIDGE_COMMAND_ENV, "bb-pi-that-does-not-exist");
    vi.stubEnv(PI_BRIDGE_ARGS_ENV, "[1]");
    const { session, scratchDir } = makeSession();

    await expect(session.start()).rejects.toThrow(
      `${PI_BRIDGE_ARGS_ENV} must be a JSON array of strings`,
    );
    expect(readdirSync(scratchDir).length).toBeGreaterThan(0);
  },
);

it.runIf(onWindows)(
  "removes the scratch files when Windows cannot resolve the launcher",
  async () => {
    vi.stubEnv(PI_BRIDGE_COMMAND_ENV, "bb-pi-that-does-not-exist");
    vi.stubEnv(PI_BRIDGE_ARGS_ENV, "[]");
    const { session, scratchDir } = makeSession();

    await expect(session.start()).rejects.toThrow(
      "Command bb-pi-that-does-not-exist was not found on Path",
    );
    expect(readdirSync(scratchDir)).toEqual([]);
  },
);
