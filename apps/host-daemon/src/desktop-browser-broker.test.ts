import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { resolveWindowsSystemToolPath } from "@bb/process-utils";
import {
  assertSecretFileAclIsPrivate,
  readSecretFileAcl,
  resolveCurrentWindowsUser,
} from "@bb/secret-storage";
import {
  DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE,
  desktopBrowserBrokerRequestSchema,
} from "@bb/host-daemon-contract";
import {
  startDesktopBrowserBroker,
  type DesktopBrowserBroker,
} from "./desktop-browser-broker.js";

const scope = {
  instanceId: "window-1",
  generation: "generation-1",
  threadId: "thread-1",
};
const tab = {
  tabId: "tab-1",
  threadId: scope.threadId,
  url: "about:blank",
  title: "",
  profile: { kind: "personal" },
  presentation: "hidden",
  control: null,
};
const brokers: DesktopBrowserBroker[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup(timeoutMs = 1000) {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-browser-broker-"));
  directories.push(dataDir);
  const onChanged = vi.fn();
  const broker = await startDesktopBrowserBroker({
    dataDir,
    hostId: "host-1",
    serverUrl: "https://bb.example",
    onChanged,
    requestTimeoutMs: timeoutMs,
  });
  brokers.push(broker);
  broker.setConnected(true);
  return { broker, dataDir, onChanged };
}
async function connect(
  broker: DesktopBrowserBroker,
  serverUrl = "https://bb.example",
) {
  const socket = new WebSocket(broker.descriptor.url, {
    headers: { Authorization: `Bearer ${broker.descriptor.token}` },
  });
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "register",
      hostId: "host-1",
      serverUrl,
      instances: [
        {
          instanceId: scope.instanceId,
          generation: scope.generation,
          label: "Window",
        },
      ],
    }),
  );
  return socket;
}
async function registered(broker: DesktopBrowserBroker) {
  await vi.waitFor(async () => {
    expect(
      (await broker.request({ type: "desktop.browser.list_instances" }))
        .instances,
    ).toHaveLength(1);
  });
}

describe("desktop browser broker", () => {
  it("writes a private bound descriptor and removes it at shutdown", async () => {
    const { broker, dataDir } = await setup();
    const path = join(dataDir, DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE);
    if (process.platform === "win32") {
      const user = await resolveCurrentWindowsUser();
      const aces = await readSecretFileAcl(path);
      expect(() =>
        assertSecretFileAclIsPrivate(path, aces, user),
      ).not.toThrow();
    } else {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(broker.descriptor);
    expect(broker.descriptor.url).toMatch(
      /^ws:\/\/127\.0\.0\.1:\d+\/desktop-browser$/u,
    );
    await broker.close();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32")(
    "retries private publication after a native reader releases the previous descriptor",
    async () => {
      const { broker: first, dataDir } = await setup();
      const path = join(dataDir, DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE);
      const holdScript = String.raw`
$ErrorActionPreference = 'Stop'
$stream = [System.IO.File]::Open($env:BB_BROKER_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]5)
try {
  [Console]::Out.WriteLine('READY')
  [Console]::ReadLine() | Out-Null
  $reader = New-Object System.IO.StreamReader($stream)
  [Console]::Out.WriteLine($reader.ReadToEnd())
} finally {
  $stream.Dispose()
}
`;
      const child = spawn(
        resolveWindowsSystemToolPath("WindowsPowerShell\\v1.0\\powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(holdScript, "utf16le").toString("base64"),
        ],
        { env: { ...process.env, BB_BROKER_PATH: path }, windowsHide: true },
      );
      const chunks: string[] = [];
      child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      try {
        await vi.waitFor(() => expect(chunks.join("")).toContain("READY"), {
          timeout: 5_000,
        });
        const publication = startDesktopBrowserBroker({
          dataDir,
          hostId: "host-2",
          serverUrl: "https://bb.example",
          onChanged: vi.fn(),
        }).then(
          (broker) => ({ broker }),
          (error: unknown) => ({ error }),
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 700));
        child.stdin.end("\n");
        const outcome = await publication;
        if ("error" in outcome) throw outcome.error;
        brokers.push(outcome.broker);
        expect(await closed).toBe(0);
        expect(chunks.join("")).toContain(first.descriptor.token);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
          outcome.broker.descriptor,
        );
      } finally {
        if (child.exitCode === null) {
          if (!child.stdin.writableEnded) child.stdin.end("\n");
          child.kill();
          await closed.catch(() => undefined);
        }
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "cleans private staging after a permanent descriptor publication failure",
    async () => {
      const dataDir = await mkdtemp(
        join(tmpdir(), "bb-browser-broker-blocked-"),
      );
      directories.push(dataDir);
      await mkdir(join(dataDir, DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE));
      await expect(
        startDesktopBrowserBroker({
          dataDir,
          hostId: "host-1",
          serverUrl: "https://bb.example",
          onChanged: vi.fn(),
        }),
      ).rejects.toThrow();
      expect(await readdir(dataDir)).toEqual([
        DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE,
      ]);
    },
  );

  it("rejects unauthenticated, renderer-origin, wrong-server, and offline clients", async () => {
    const { broker } = await setup();
    const invalidHeaders: Record<string, string>[] = [
      {},
      {
        Authorization: `Bearer ${broker.descriptor.token}`,
        Origin: "https://bb.example",
      },
    ];
    for (const headers of invalidHeaders) {
      const socket = new WebSocket(broker.descriptor.url, { headers });
      const [error] = await once(socket, "error");
      expect(error.message).toContain("401");
    }
    const wrongServer = await connect(broker, "https://other.example");
    await once(wrongServer, "close");
    expect(
      (await broker.request({ type: "desktop.browser.list_instances" }))
        .instances,
    ).toEqual([]);
    broker.setConnected(false);
    const offline = new WebSocket(broker.descriptor.url, {
      headers: { Authorization: `Bearer ${broker.descriptor.token}` },
    });
    expect((await once(offline, "error"))[0].message).toContain("401");
  });

  it("routes scoped commands and validates native snapshots", async () => {
    const { broker, onChanged } = await setup();
    const socket = await connect(broker);
    await registered(broker);
    socket.on("message", (data) => {
      const request = desktopBrowserBrokerRequestSchema.parse(
        JSON.parse(data.toString()),
      );
      expect(request.command).toEqual({
        type: "desktop.browser.list_tabs",
        ...scope,
      });
      socket.send(
        JSON.stringify({
          type: "result",
          requestId: request.requestId,
          result: { tabs: [tab] },
        }),
      );
    });
    expect(
      await broker.request({ type: "desktop.browser.list_tabs", ...scope }),
    ).toEqual({ tabs: [tab] });
    const event = { type: "desktop-browser.changed", ...scope, tabs: [tab] };
    socket.send(JSON.stringify(event));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(event));
    await expect(
      broker.request({
        type: "desktop.browser.list_tabs",
        ...scope,
        generation: "old",
      }),
    ).rejects.toThrow("stale");
    const close = once(socket, "close");
    socket.send(JSON.stringify({ ...event, threadId: "other-thread" }));
    await close;
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("disconnects native clients and rejects outstanding commands on server loss", async () => {
    const { broker } = await setup();
    const socket = await connect(broker);
    await registered(broker);
    const response = broker.request({
      type: "desktop.browser.list_tabs",
      ...scope,
    });
    const rejection = expect(response).rejects.toThrow("disconnected");
    const close = once(socket, "close");
    broker.setConnected(false);
    await rejection;
    await close;
    await expect(
      broker.request({ type: "desktop.browser.list_instances" }),
    ).rejects.toThrow("disconnected");
    broker.setConnected(true);
    expect(
      await broker.request({ type: "desktop.browser.list_instances" }),
    ).toEqual({ instances: [] });
  });

  it("bounds unanswered requests and invalidates the native session", async () => {
    const { broker } = await setup(100);
    const socket = await connect(broker);
    await registered(broker);
    const close = once(socket, "close");
    await expect(
      broker.request({ type: "desktop.browser.list_tabs", ...scope }),
    ).rejects.toThrow("timed out");
    await close;
    expect(
      await broker.request({ type: "desktop.browser.list_instances" }),
    ).toEqual({ instances: [] });
  });

  it("rejects malformed results and cross-thread metadata", async () => {
    for (const result of [
      { tabs: [{ ...tab, threadId: "other-thread" }] },
      { wsEndpoint: "http://169.254.169.254" },
    ]) {
      const { broker } = await setup();
      const socket = await connect(broker);
      await registered(broker);
      socket.on("message", (data) => {
        const request = desktopBrowserBrokerRequestSchema.parse(
          JSON.parse(data.toString()),
        );
        socket.send(
          JSON.stringify({
            type: "result",
            requestId: request.requestId,
            result,
          }),
        );
      });
      await expect(
        broker.request({ type: "desktop.browser.list_tabs", ...scope }),
      ).rejects.toThrow();
    }
  });

  it("uses refreshed instance generations and rejects duplicate instance ownership", async () => {
    const { broker } = await setup();
    const socket = await connect(broker);
    await registered(broker);
    const duplicate = await connect(broker);
    await once(duplicate, "close");
    expect(
      (await broker.request({ type: "desktop.browser.list_instances" }))
        .instances,
    ).toHaveLength(1);
    socket.send(
      JSON.stringify({
        type: "register",
        hostId: "host-1",
        serverUrl: "https://bb.example",
        instances: [
          {
            instanceId: scope.instanceId,
            generation: "generation-2",
            label: "New",
          },
        ],
      }),
    );
    await vi.waitFor(async () =>
      expect(
        (await broker.request({ type: "desktop.browser.list_instances" }))
          .instances[0]?.generation,
      ).toBe("generation-2"),
    );
    await expect(
      broker.request({ type: "desktop.browser.list_tabs", ...scope }),
    ).rejects.toThrow("stale");
  });
});
