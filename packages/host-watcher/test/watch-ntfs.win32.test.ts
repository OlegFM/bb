import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostWatcher } from "../src/index.js";
import { RootSubscription } from "../src/root-subscription.js";
import {
  isWatchPathWithinRoot,
  normalizeWatchEventPath,
} from "../src/watch-event-path.js";
import type { HostPathWatchChange } from "../src/host-watcher-types.js";

const tempDirs: string[] = [];
const activeStops: Array<() => void | Promise<void>> = [];
const TEST_TIMEOUT_MS = 20_000;
const INNER_WAIT_TIMEOUT_MS = TEST_TIMEOUT_MS / 3;
const POLL_INTERVAL_MS = 50;

type Sleep = (durationMs: number) => Promise<void>;

const sleep: Sleep = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function registerStop(
  stop: () => void | Promise<void>,
): () => void | Promise<void> {
  activeStops.push(stop);
  return stop;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for watcher state");
}

function watchExtendedLengthRoot(
  rootPath: string,
  onEvents: (changes: HostPathWatchChange[]) => void,
): { ready: Promise<void>; stop: () => Promise<void> } {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const subscription = new RootSubscription({
    rootPath,
    retryDelayMs: 250,
    maxRetryDelayMs: 30_000,
    onEvents: (events) => {
      onEvents(
        events.map((event) => ({
          path: normalizeWatchEventPath(rootPath, event.path),
          type: event.type,
        })),
      );
    },
    onReady: () => {
      resolveReady();
    },
    onDroppedEvents: () => {},
    onWatchError: () => {},
  });
  subscription.start();
  return { ready, stop: () => subscription.dispose() };
}

afterEach(async () => {
  await Promise.all(activeStops.splice(0).map((stop) => stop()));
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { force: true, recursive: true })),
  );
});

describe.runIf(process.platform === "win32")(
  "watcher event paths on NTFS",
  () => {
    it(
      "matches renamed and deleted paths case-insensitively and ignores node_modules",
      async () => {
        const root = await makeTempDir("bb-watch-ntfs-");
        const watcher = createHostWatcher();
        const changes: HostPathWatchChange[] = [];
        let ready = false;

        const stopWatching = watcher.watchPathRoot?.({
          rootPath: root,
          ignoredPaths: ["**/node_modules/**"],
          onChange: (batch) => {
            changes.push(...batch);
          },
          onReady: () => {
            ready = true;
          },
          onRescanRequired: () => {},
          onWatchError: () => {},
        });
        expect(stopWatching).toBeDefined();
        if (stopWatching) {
          registerStop(stopWatching);
        }

        try {
          await waitFor(() => ready, INNER_WAIT_TIMEOUT_MS);

          const filePath = path.join(root, "a.txt");
          await fs.writeFile(filePath, "hello");
          await waitFor(
            () =>
              changes.some((change) =>
                change.path.toLowerCase().endsWith("\\a.txt"),
              ),
            INNER_WAIT_TIMEOUT_MS,
          );

          const renamedPath = path.join(root, "B.TXT");
          await fs.rename(filePath, renamedPath);
          await waitFor(
            () =>
              changes.some((change) =>
                change.path.toLowerCase().endsWith("\\b.txt"),
              ),
            INNER_WAIT_TIMEOUT_MS,
          );

          await fs.rm(renamedPath, { force: true });
          await sleep(500);

          const nodeModulesDir = path.join(root, "node_modules");
          await fs.mkdir(nodeModulesDir, { recursive: true });
          await fs.writeFile(
            path.join(nodeModulesDir, "x.js"),
            "module.exports = {};",
          );
          await sleep(1_000);

          expect(
            changes.some((change) => /(^|\\)a\.txt$/iu.test(change.path)),
          ).toBe(true);
          expect(
            changes.some((change) => /(^|\\)b\.txt$/iu.test(change.path)),
          ).toBe(true);
          expect(
            changes.every(
              (change) => !change.path.toLowerCase().includes("node_modules"),
            ),
          ).toBe(true);
          expect(changes.every((change) => change.path.includes("\\"))).toBe(
            true,
          );
          expect(
            changes.every((change) => isWatchPathWithinRoot(root, change.path)),
          ).toBe(true);
        } finally {
          await stopWatching?.();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "matches events reported under an extended-length root",
      async () => {
        const root = await makeTempDir("bb-watch-ntfs-ext-");
        const extendedRoot = `\\\\?\\${root}`;
        const changes: HostPathWatchChange[] = [];

        const { ready, stop } = watchExtendedLengthRoot(
          extendedRoot,
          (batch) => {
            changes.push(...batch);
          },
        );
        registerStop(stop);

        try {
          await Promise.race([
            ready,
            sleep(INNER_WAIT_TIMEOUT_MS).then(() => {
              throw new Error("Timed out waiting for the watcher to be ready");
            }),
          ]);

          const filePath = path.join(root, "c.txt");
          await fs.writeFile(filePath, "hello");
          await waitFor(
            () =>
              changes.some((change) =>
                change.path.toLowerCase().endsWith("c.txt"),
              ),
            INNER_WAIT_TIMEOUT_MS,
          );

          expect(
            changes.every((change) =>
              isWatchPathWithinRoot(extendedRoot, change.path),
            ),
          ).toBe(true);
        } finally {
          await stop();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
