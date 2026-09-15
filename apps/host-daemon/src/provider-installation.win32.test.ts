import { randomUUID } from "node:crypto";
import {
  providerCliInstallEventSchema,
  type ProviderCliInstallEvent,
} from "@bb/host-daemon-contract";
import {
  queryWindowsProcess,
  takeWindowsProcessSnapshot,
} from "@bb/process-utils";
import { afterEach, describe, expect, it } from "vitest";
import { streamProviderInstallation } from "./provider-installation.js";

const POLL_INTERVAL_MS = 250;
const NODE_OUTPUT_MARKER = "BB_CONPTY_INSTALL_OK";
const CASE_TIMEOUT_MS = 30_000;

interface StartedInstallation {
  marker: string | null;
  stream: ReadableStream<Uint8Array>;
}

const startedInstallations: StartedInstallation[] = [];

function startInstallation(args: {
  providerId: string;
  marker?: string;
  command: string;
  commandArgs: string[];
}): ReadableStream<Uint8Array> {
  const stream = streamProviderInstallation({
    providerId: args.providerId,
    plan: {
      command: args.command,
      args: args.commandArgs,
      displayCommand: `${args.command} ${args.commandArgs.join(" ")}`,
    },
    env: process.env,
  });
  startedInstallations.push({ marker: args.marker ?? null, stream });
  return stream;
}

async function readInstallationEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<ProviderCliInstallEvent[]> {
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => providerCliInstallEventSchema.parse(JSON.parse(line)));
}

function installationOutput(events: ProviderCliInstallEvent[]): string {
  return events
    .flatMap((event) => (event.type === "output" ? [event.text] : []))
    .join("");
}

async function listMarkerPids(marker: string): Promise<number[]> {
  const snapshot = await takeWindowsProcessSnapshot();
  return snapshot
    .filter((entry) => entry.commandLine?.includes(marker) === true)
    .map((entry) => entry.pid);
}

async function waitUntil(
  predicate: () => Promise<boolean>,
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
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, POLL_INTERVAL_MS),
    );
  }
}

async function waitForMarkerPid(
  marker: string,
  timeoutMs: number,
): Promise<number> {
  let pids: number[] = [];
  await waitUntil(async () => {
    pids = await listMarkerPids(marker);
    return pids.length > 0;
  }, timeoutMs);
  const pid = pids[0];
  if (pid === undefined) {
    throw new Error(`No Windows process was started for ${marker}`);
  }
  return pid;
}

afterEach(async () => {
  const survivors: number[] = [];
  for (const started of startedInstallations.splice(0)) {
    if (!started.stream.locked) {
      await started.stream.cancel();
    }
    if (started.marker === null) {
      continue;
    }
    for (const pid of await listMarkerPids(started.marker)) {
      survivors.push(pid);
      try {
        process.kill(pid);
      } catch {}
    }
  }
  expect(survivors).toEqual([]);
});

describe.runIf(process.platform === "win32")(
  "streamProviderInstallation on ConPTY",
  () => {
    it(
      "streams a resolved node command through ConPTY",
      async () => {
        const events = await readInstallationEvents(
          startInstallation({
            providerId: "conpty-node",
            marker: NODE_OUTPUT_MARKER,
            command: "node",
            commandArgs: [
              "-e",
              `process.stdout.write('${NODE_OUTPUT_MARKER}')`,
            ],
          }),
        );

        expect(installationOutput(events)).toContain(NODE_OUTPUT_MARKER);
        expect(events.at(-1)).toMatchObject({
          type: "completed",
          provider: "conpty-node",
          exitCode: 0,
          success: true,
        });
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "runs the npm launcher through ConPTY after the shim rewrite",
      async () => {
        const events = await readInstallationEvents(
          startInstallation({
            providerId: "conpty-npm",
            command: "npm",
            commandArgs: ["--version"],
          }),
        );

        expect(installationOutput(events)).toMatch(/\d+\.\d+\.\d+/u);
        expect(events.at(-1)).toMatchObject({
          type: "completed",
          provider: "conpty-npm",
          exitCode: 0,
          success: true,
        });
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "cancels a running installation and leaves no process behind",
      async () => {
        const marker = `BB_CONPTY_CANCEL_${randomUUID().replaceAll("-", "")}`;
        const stream = startInstallation({
          providerId: "conpty-cancel",
          marker,
          command: "node",
          commandArgs: ["-e", `void'${marker}';setTimeout(()=>{},30000)`],
        });
        const pid = await waitForMarkerPid(marker, 15_000);

        const cancelStartedAt = Date.now();
        await stream.cancel();
        const cancelDurationMs = Date.now() - cancelStartedAt;

        expect(cancelDurationMs).toBeLessThan(3_000);
        expect(
          await waitUntil(
            async () => (await queryWindowsProcess(pid)) === null,
            10_000,
          ),
        ).toBe(true);
        expect(await listMarkerPids(marker)).toEqual([]);
      },
      CASE_TIMEOUT_MS,
    );
  },
);
