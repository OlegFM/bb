import { PassThrough, type Readable } from "node:stream";
import type { ProviderInstallationCommand } from "@bb/provider-bridge-protocol";
import {
  providerCliInstallEventSchema,
  type ProviderCliInstallEvent,
} from "@bb/host-daemon-contract";
import {
  resolveSpawnPlanOrThrow,
  terminateProcessTree,
  type SpawnPlan,
} from "@bb/process-utils";
import { spawn as spawnPty } from "node-pty";
import type { HostDaemonLogger } from "./logger.js";
import { ensureNodePtySpawnHelperExecutable } from "./terminals/terminal-manager.js";

const nodePtyLogger: HostDaemonLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface ProviderInstallationProcess {
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  onError(listener: (error: Error) => void): void;
  onClose(
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

export interface ProviderInstallationProcessSpawner {
  spawn(args: {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  }): ProviderInstallationProcess;
}

let activeProviderId: string | null = null;

export class ProviderInstallationInProgressError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Provider installation already running for ${providerId}`);
    this.name = "ProviderInstallationInProgressError";
    this.providerId = providerId;
  }
}

function createPtyProviderInstallationProcessSpawner(): ProviderInstallationProcessSpawner {
  return {
    spawn(args) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      ensureNodePtySpawnHelperExecutable(nodePtyLogger);
      const pty = spawnPty(args.command, args.args, {
        cols: 120,
        cwd: process.cwd(),
        env: args.env ?? process.env,
        name: "xterm-256color",
        rows: 30,
      });
      let exited = false;
      pty.onData((data) => stdout.write(data));
      pty.onExit(() => {
        exited = true;
        stdout.end();
        stderr.end();
      });
      return {
        stdout,
        stderr,
        kill(signal) {
          if (args.platform !== "win32") {
            pty.kill(signal);
            return true;
          }
          pty.kill();
          const pid = pty.pid;
          if (pid > 0) {
            void terminateProcessTree({
              child: {
                pid,
                get exitCode() {
                  return exited ? 0 : null;
                },
                signalCode: null,
                kill: () => {
                  pty.kill();
                  return true;
                },
              },
              graceMs: 0,
              platform: "win32",
            });
          }
          return true;
        },
        onError(listener) {
          void listener;
        },
        onClose(listener) {
          pty.onExit((event) => listener(event.exitCode, null));
        },
      };
    },
  };
}

export function streamProviderInstallation(args: {
  providerId: string;
  plan: ProviderInstallationCommand;
  env?: NodeJS.ProcessEnv;
  processSpawner?: ProviderInstallationProcessSpawner;
  platform?: NodeJS.Platform;
  resolveSpawnPlan?: typeof resolveSpawnPlanOrThrow;
}): ReadableStream<Uint8Array> {
  if (activeProviderId !== null) {
    throw new ProviderInstallationInProgressError(activeProviderId);
  }
  activeProviderId = args.providerId;
  const platform = args.platform ?? process.platform;
  let closed = false;
  let child: ProviderInstallationProcess | null = null;
  const release = () => {
    if (activeProviderId === args.providerId) activeProviderId = null;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const write = (event: ProviderCliInstallEvent) => {
        if (closed) return;
        const parsed = providerCliInstallEventSchema.parse(event);
        controller.enqueue(encoder.encode(`${JSON.stringify(parsed)}\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        release();
        controller.close();
      };
      write({
        type: "started",
        provider: args.providerId,
        command: args.plan.displayCommand,
      });
      let spawnPlan: SpawnPlan = {
        command: args.plan.command,
        args: [...args.plan.args],
      };
      if (platform === "win32") {
        try {
          spawnPlan = await (args.resolveSpawnPlan ?? resolveSpawnPlanOrThrow)({
            command: args.plan.command,
            args: args.plan.args,
            env: args.env ?? process.env,
            platform,
          });
        } catch (error) {
          write({
            type: "error",
            provider: args.providerId,
            message: error instanceof Error ? error.message : String(error),
          });
          close();
          return;
        }
        if (closed) return;
      }
      try {
        child = (
          args.processSpawner ?? createPtyProviderInstallationProcessSpawner()
        ).spawn({
          command: spawnPlan.command,
          args: spawnPlan.args,
          ...(args.env === undefined ? {} : { env: args.env }),
          platform,
        });
      } catch (error) {
        write({
          type: "error",
          provider: args.providerId,
          message: error instanceof Error ? error.message : String(error),
        });
        close();
        return;
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text: string) =>
        write({
          type: "output",
          provider: args.providerId,
          stream: "stdout",
          text,
        }),
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text: string) =>
        write({
          type: "output",
          provider: args.providerId,
          stream: "stderr",
          text,
        }),
      );
      child.onError((error) => {
        write({
          type: "error",
          provider: args.providerId,
          message: error.message,
        });
        close();
      });
      child.onClose((exitCode, signal) => {
        write({
          type: "completed",
          provider: args.providerId,
          exitCode,
          signal,
          success: exitCode === 0,
        });
        close();
      });
    },
    cancel() {
      closed = true;
      release();
      child?.kill(platform === "win32" ? undefined : "SIGTERM");
    },
  });
}
