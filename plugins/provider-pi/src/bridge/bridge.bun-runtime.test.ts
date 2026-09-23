import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { experimental_resolveExecutableSync as resolveExecutableSync } from "@get-bb/plugin-sdk/provider-bridge";
import { handleLine } from "./bridge.js";
import { PI_BRIDGE_ARGS_ENV, PI_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import {
  FULL_PERMISSION_OPTIONS,
  fakePiPath,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

function bunBinary(): string | null {
  const command = resolveExecutableSync({ command: "bun" });
  if (command === null) {
    if (process.env.CI)
      throw new Error("Bun is required for the Pi runtime regression in CI");
    return null;
  }
  if (
    !isAbsolute(command) ||
    !existsSync(command) ||
    basename(command).toLowerCase() !==
      (process.platform === "win32" ? "bun.exe" : "bun")
  ) {
    throw new Error(`Unexpected Bun executable: ${command}`);
  }
  const probe = spawnSync(command, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.status !== 0 || !probe.stdout?.trim()) {
    if (process.env.CI)
      throw new Error("Bun is required for the Pi runtime regression in CI");
    return null;
  }
  return command;
}

describe("Pi bridge under the Bun runtime", () => {
  let harness: FakePiBridgeHarness;
  let nextId = 2000;

  beforeEach(async () => {
    harness = await startFakePiBridge({
      prefix: "bb-pi-bun-",
      initialize: true,
    });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it.skipIf(bunBinary() === null)(
    "delivers dynamic tool results when pi runs under the Bun runtime",
    async () => {
      const bun = bunBinary();
      if (bun === null) throw new Error("Bun executable missing");
      expect(fakePiPath).toMatch(/fake-pi-rpc\.mjs$/u);
      expect(existsSync(fakePiPath)).toBe(true);
      vi.stubEnv(PI_BRIDGE_COMMAND_ENV, bun);
      vi.stubEnv(PI_BRIDGE_ARGS_ENV, JSON.stringify([fakePiPath]));

      const threadId = "thr_bun_dyn_tool";
      const started = await harness.request((nextId += 1), "thread/start", {
        threadId,
        cwd: harness.workspaceDir,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
        dynamicTools: [
          {
            name: "bb_probe",
            description: "A bb tool.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
            },
          },
        ],
      });
      expect(started.error, JSON.stringify(started)).toBeUndefined();

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: (nextId += 1),
          method: "turn/start",
          params: {
            threadId,
            providerThreadId: threadId,
            clientRequestId: "creq_bu23456789",
            input: [
              {
                type: "text",
                text: `/tool bb_probe ${JSON.stringify({ value: "hi" })}`,
                mentions: [],
              },
            ],
            options: FULL_PERMISSION_OPTIONS,
          },
        }),
      );
      const toolCall = await harness.waitForMessage(
        (m) => m.method === "item/tool/call",
        "the dynamic tool call",
      );
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: toolCall.id,
          result: {
            contentItems: [{ type: "inputText", text: "bun-result-text" }],
            success: true,
          },
        }),
      );
      await harness.waitForMessage(
        () =>
          harness
            .deltasOf(threadId)
            .some(
              (d) =>
                d.kind === "item.textDelta" &&
                String(d.text).includes("Tool said: bun-result-text"),
            ),
        "the tool result to reach pi under Bun",
      );
      await harness.waitForDelta(threadId, (d) => d.kind === "turn.boundary");
    },
    90_000,
  );
});
