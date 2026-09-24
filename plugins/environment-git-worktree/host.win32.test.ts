import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { removeWorktree } from "./host/worktree.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  mockKillProcessesWithCwdUnder.mockClear();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.runIf(process.platform === "win32")(
  "removeWorktree sweep (win32)",
  () => {
    it("reports a skipped sweep process on stderr", async () => {
      const root = await mkdtemp(join(tmpdir(), "bb-worktree-plugin-win32-"));
      temporaryRoots.push(root);
      const workspacePath = join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });

      const calls: unknown[] = [];
      const stderrWriteSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk) => {
          calls.push(chunk);
          return true;
        });
      try {
        await removeWorktree({
          path: workspacePath,
        });
      } finally {
        stderrWriteSpy.mockRestore();
      }

      expect(calls).toContain(
        "bb sweep left pid 4242 alone: process id reused\n",
      );
    });
  },
);
