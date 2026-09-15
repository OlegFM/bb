import { PassThrough } from "node:stream";
import { SpawnPlanUnavailableError } from "@bb/process-utils";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderInstallationInProgressError,
  streamProviderInstallation,
  type ProviderInstallationProcess,
  type ProviderInstallationProcessSpawner,
} from "./provider-installation.js";

function fakeProcess(): Omit<
  ProviderInstallationProcess,
  "stdout" | "stderr"
> & {
  stdout: PassThrough;
  stderr: PassThrough;
  close(exitCode: number): void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let closeListener: ((exitCode: number | null, signal: null) => void) | null =
    null;
  return {
    stdout,
    stderr,
    kill: vi.fn(() => true),
    onError: vi.fn(),
    onClose(listener) {
      closeListener = listener;
    },
    close(exitCode) {
      stdout.end();
      stderr.end();
      closeListener?.(exitCode, null);
    },
  };
}

async function readEvents(stream: ReadableStream<Uint8Array>) {
  const text = await new Response(stream).text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("streamProviderInstallation", () => {
  it("executes the provider plan and streams process output", async () => {
    const process = fakeProcess();
    const spawner: ProviderInstallationProcessSpawner = {
      spawn: vi.fn(() => process),
    };
    const stream = streamProviderInstallation({
      providerId: "example-provider",
      plan: {
        command: "example",
        args: ["upgrade"],
        displayCommand: "example upgrade",
      },
      platform: "linux",
      processSpawner: spawner,
    });
    process.stdout.write("working\n");
    process.close(0);

    await expect(readEvents(stream)).resolves.toEqual([
      {
        type: "started",
        provider: "example-provider",
        command: "example upgrade",
      },
      {
        type: "output",
        provider: "example-provider",
        stream: "stdout",
        text: "working\n",
      },
      {
        type: "completed",
        provider: "example-provider",
        exitCode: 0,
        signal: null,
        success: true,
      },
    ]);
    expect(spawner.spawn).toHaveBeenCalledWith({
      command: "example",
      args: ["upgrade"],
      platform: "linux",
    });
  });

  it("allows only one installation process at a time", async () => {
    const firstProcess = fakeProcess();
    const first = streamProviderInstallation({
      providerId: "first",
      plan: { command: "one", args: [], displayCommand: "one" },
      platform: "linux",
      processSpawner: { spawn: () => firstProcess },
    });
    expect(() =>
      streamProviderInstallation({
        providerId: "second",
        plan: { command: "two", args: [], displayCommand: "two" },
        platform: "linux",
        processSpawner: { spawn: () => fakeProcess() },
      }),
    ).toThrow(ProviderInstallationInProgressError);
    firstProcess.close(0);
    await readEvents(first);

    const secondProcess = fakeProcess();
    const second = streamProviderInstallation({
      providerId: "second",
      plan: { command: "two", args: [], displayCommand: "two" },
      platform: "linux",
      processSpawner: { spawn: () => secondProcess },
    });
    secondProcess.close(0);
    await readEvents(second);
  });

  it("rewrites a Windows npm plan to node.exe npm-cli.js before spawning", async () => {
    const process = fakeProcess();
    const spawner: ProviderInstallationProcessSpawner = {
      spawn: vi.fn(() => process),
    };
    const resolveSpawnPlan = vi.fn(async () => ({
      command: "C:\\nodejs\\node.exe",
      args: [
        "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "install",
        "-g",
        "x@latest",
      ],
    }));
    const stream = streamProviderInstallation({
      providerId: "example-provider",
      plan: {
        command: "npm",
        args: ["install", "-g", "x@latest"],
        displayCommand: "npm install -g x@latest",
      },
      env: { Path: "C:\\nodejs" },
      platform: "win32",
      processSpawner: spawner,
      resolveSpawnPlan,
    });
    await vi.waitFor(() => expect(spawner.spawn).toHaveBeenCalled());
    process.close(0);

    await expect(readEvents(stream)).resolves.toEqual([
      {
        type: "started",
        provider: "example-provider",
        command: "npm install -g x@latest",
      },
      {
        type: "completed",
        provider: "example-provider",
        exitCode: 0,
        signal: null,
        success: true,
      },
    ]);
    expect(resolveSpawnPlan).toHaveBeenCalledWith({
      command: "npm",
      args: ["install", "-g", "x@latest"],
      env: { Path: "C:\\nodejs" },
      platform: "win32",
    });
    expect(spawner.spawn).toHaveBeenCalledWith({
      command: "C:\\nodejs\\node.exe",
      args: [
        "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "install",
        "-g",
        "x@latest",
      ],
      env: { Path: "C:\\nodejs" },
      platform: "win32",
    });
  });

  it("emits an error event when a Windows plan cannot be resolved", async () => {
    const spawner: ProviderInstallationProcessSpawner = {
      spawn: vi.fn(() => fakeProcess()),
    };
    const stream = streamProviderInstallation({
      providerId: "example-provider",
      plan: {
        command: "npm",
        args: ["install", "-g", "x@latest"],
        displayCommand: "npm install -g x@latest",
      },
      platform: "win32",
      processSpawner: spawner,
      resolveSpawnPlan: async () => {
        throw new SpawnPlanUnavailableError({
          command: "npm",
          resolvedPath: null,
        });
      },
    });

    await expect(readEvents(stream)).resolves.toEqual([
      {
        type: "started",
        provider: "example-provider",
        command: "npm install -g x@latest",
      },
      {
        type: "error",
        provider: "example-provider",
        message: "Command npm was not found on Path",
      },
    ]);
    expect(spawner.spawn).not.toHaveBeenCalled();

    const nextProcess = fakeProcess();
    const next = streamProviderInstallation({
      providerId: "example-provider",
      plan: {
        command: "npm",
        args: ["install", "-g", "x@latest"],
        displayCommand: "npm install -g x@latest",
      },
      platform: "linux",
      processSpawner: { spawn: () => nextProcess },
    });
    nextProcess.close(0);
    await readEvents(next);
  });

  it("passes POSIX plans through unchanged", async () => {
    const process = fakeProcess();
    const spawner: ProviderInstallationProcessSpawner = {
      spawn: vi.fn(() => process),
    };
    const resolveSpawnPlan = vi.fn(async () => {
      throw new Error("resolveSpawnPlan must not run on POSIX");
    });
    const stream = streamProviderInstallation({
      providerId: "example-provider",
      plan: {
        command: "sh",
        args: ["-c", "curl -fsSL https://example.test/install.sh | sh"],
        displayCommand:
          "sh -c 'curl -fsSL https://example.test/install.sh | sh'",
      },
      env: { PATH: "/usr/bin" },
      platform: "linux",
      processSpawner: spawner,
      resolveSpawnPlan,
    });
    process.close(0);
    await readEvents(stream);

    expect(spawner.spawn).toHaveBeenCalledWith({
      command: "sh",
      args: ["-c", "curl -fsSL https://example.test/install.sh | sh"],
      env: { PATH: "/usr/bin" },
      platform: "linux",
    });
    expect(resolveSpawnPlan).not.toHaveBeenCalled();
  });

  it("cancels a Windows installation through the process tree", async () => {
    const windowsProcess = fakeProcess();
    const windowsSpawner: ProviderInstallationProcessSpawner = {
      spawn: vi.fn(() => windowsProcess),
    };
    const windowsStream = streamProviderInstallation({
      providerId: "example-provider",
      plan: {
        command: "npm",
        args: ["install", "-g", "x@latest"],
        displayCommand: "npm install -g x@latest",
      },
      platform: "win32",
      processSpawner: windowsSpawner,
      resolveSpawnPlan: async () => ({
        command: "C:\\nodejs\\node.exe",
        args: [
          "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
          "install",
          "-g",
          "x@latest",
        ],
      }),
    });
    await vi.waitFor(() => expect(windowsSpawner.spawn).toHaveBeenCalled());
    await windowsStream.cancel();

    expect(windowsProcess.kill).toHaveBeenCalledWith(undefined);

    const posixProcess = fakeProcess();
    const posixStream = streamProviderInstallation({
      providerId: "example-provider",
      plan: {
        command: "sh",
        args: ["-c", "install"],
        displayCommand: "sh -c install",
      },
      platform: "linux",
      processSpawner: { spawn: () => posixProcess },
    });
    await posixStream.cancel();

    expect(posixProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
