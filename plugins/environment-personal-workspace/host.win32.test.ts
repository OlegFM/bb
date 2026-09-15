import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeSkippedProcessEvent {
  pid: number;
  reason: "pid-reused";
  expectedCreationDate: string | null;
  observedCreationDate: string | null;
}

const mockKillProcessesWithCwdUnder = vi.hoisted(() =>
  vi.fn(
    async (args: {
      onSkippedProcess?: (event: FakeSkippedProcessEvent) => void;
    }) => {
      args.onSkippedProcess?.({
        pid: 4242,
        reason: "pid-reused",
        expectedCreationDate: "a",
        observedCreationDate: "b",
      });
    },
  ),
);

vi.mock("@get-bb/plugin-sdk/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@get-bb/plugin-sdk/host")>()),
  experimental_killProcessesWithCwdUnder: mockKillProcessesWithCwdUnder,
}));

import { createPersonalWorkspaceHostEntry } from "./host.js";

const temporaryRoots: string[] = [];

async function createDataDir(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), "bb-personal-workspace-plugin-win32-"),
  );
  temporaryRoots.push(root);
  return join(root, "plugin-data");
}

function createHarness(dataDir: string) {
  return experimental_createHostEntryHarness(
    createPersonalWorkspaceHostEntry(),
    {
      experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") },
    },
  );
}

afterEach(async () => {
  mockKillProcessesWithCwdUnder.mockClear();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.runIf(process.platform === "win32")(
  "personal workspace host entry (win32)",
  () => {
    it("reports a skipped sweep process on stderr", async () => {
      const dataDir = await createDataDir();
      const harness = createHarness(dataDir);
      const created = await harness.experimental_call("createWorkspace", {
        pathKey: "thr_busy",
      });

      const originalWrite = process.stderr.write.bind(process.stderr);
      const calls: unknown[] = [];
      process.stderr.write = ((chunk: unknown) => {
        calls.push(chunk);
        return true;
      }) as typeof process.stderr.write;
      try {
        await harness.experimental_call("removeWorkspace", {
          pathKey: "thr_busy",
          path: created.path,
        });
      } finally {
        process.stderr.write = originalWrite;
      }

      expect(calls).toContain(
        "bb sweep left pid 4242 alone: process id reused\n",
      );
    });
  },
);
