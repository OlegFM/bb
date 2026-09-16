import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { DesktopBrowserChanged } from "@bb/host-daemon-contract";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  session: { fromPartition: () => ({}) },
  nativeImage: { createFromBuffer: () => ({}) },
}));

import { createDesktopBrowserBroker } from "../src/desktop-browser-broker.js";
import type {
  DesktopBrowserNativeTab,
  DesktopBrowserViewManager,
} from "../src/desktop-browser-view.js";

const THREAD_ID = "thr_23456789ab";
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function createWindow(id: number) {
  let destroyed = false;
  const sent: Array<{ channel: string; payload: object }> = [];
  const webContents = {
    id,
    isDestroyed: () => destroyed,
    send(channel: string, payload: object) {
      if (destroyed) throw new TypeError("Object has been destroyed");
      sent.push({ channel, payload });
    },
  };
  return {
    sent,
    destroy() {
      destroyed = true;
    },
    revive() {
      destroyed = false;
    },
    window: {
      get webContents() {
        if (destroyed) throw new TypeError("Object has been destroyed");
        return webContents;
      },
      isDestroyed: () => destroyed,
      focus: () => undefined,
      show: () => undefined,
      restore: () => undefined,
      isMinimized: () => false,
      getContentBounds: () => ({ width: 800, height: 600 }),
      contentView: {
        addChildView: () => undefined,
        removeChildView: () => undefined,
      },
    },
  };
}

function createFixture(platform: NodeJS.Platform = "win32") {
  const tabs = new Map<number, DesktopBrowserNativeTab[]>();
  const changes = new Set<() => void>();
  const unused = () => {
    throw new Error("Unexpected view manager operation");
  };
  const manager: DesktopBrowserViewManager = {
    listTabs: ({ hostWebContentsId, threadId }) =>
      (tabs.get(hostWebContentsId) ?? []).filter(
        (tab) => threadId === null || tab.threadId === threadId,
      ),
    subscribeAutomationTabs(listener) {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    getAutomationTabs: () => [],
    destroyAll() {
      tabs.clear();
      for (const listener of changes) listener();
    },
    createTab: unused,
    closeTab: unused,
    captureTab: unused,
    profileSession: unused,
    attach: unused,
    detach: unused,
    focus: unused,
    navigate: unused,
    goBack: unused,
    goForward: unused,
    reload: unused,
    stop: unused,
    setBounds: unused,
    setVisible: unused,
    setVisibleWithoutFocus: unused,
    findInPage: unused,
    stopFindInPage: unused,
    beginWindowResize: unused,
    endWindowResize: unused,
    prepareWindowReload: unused,
    releaseWindow: unused,
  };
  const broker = createDesktopBrowserBroker({
    manager,
    product: "Chrome/1",
    platform,
  });
  const windows: ReturnType<typeof createWindow>[] = [];
  disposers.push(() => {
    for (const window of windows) window.revive();
    broker.dispose();
  });
  function addWindow(id: number, tabIds: string[] = []) {
    const window = createWindow(id);
    windows.push(window);
    tabs.set(
      id,
      tabIds.map((tabId) => ({
        tabId,
        threadId: THREAD_ID,
        url: "https://example.com",
        title: "Example",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        errorText: null,
        generation: `generation:${tabId}`,
        profile: { kind: "automation", id: "profile-a" },
        presentation: "hidden",
      })),
    );
    broker.registerWindow(window.window);
    const instance = broker.listInstances().at(-1);
    if (!instance) throw new Error("Window was not registered");
    return { ...window, instance };
  }
  return {
    broker,
    tabs,
    addWindow,
    notify() {
      for (const listener of changes) listener();
    },
  };
}

describe("desktop browser broker window lifecycle", () => {
  it("releases an already destroyed window once and removes its target", () => {
    const { broker, addWindow } = createFixture();
    const first = addWindow(7);
    broker.setHostId("host-a");
    let registryChanges = 0;
    broker.subscribeInstances(() => registryChanges++);
    first.destroy();

    expect(() => broker.releaseWindow(7)).not.toThrow();
    expect(broker.listInstances()).toEqual([]);
    expect(broker.getTarget(7)).toBeNull();
    expect(() => broker.releaseWindow(7)).not.toThrow();
    expect(registryChanges).toBe(1);
  });

  it("revokes every lease and closes its CDP connection after window destruction", async () => {
    const { broker, addWindow } = createFixture();
    const first = addWindow(7, ["tab-a", "tab-b"]);
    const second = addWindow(8, ["tab-c"]);
    broker.setHostId("host-a");
    const expiresAt = Date.now() + 60_000;
    for (const [leaseId, tabId] of [
      ["lease-a", "tab-a"],
      ["lease-b", "tab-b"],
    ])
      await broker.execute({
        type: "desktop.browser.acquire_control",
        ...first.instance,
        threadId: THREAD_ID,
        leaseId,
        tabIds: [tabId],
        controllerLabel: "Agent",
        expiresAt,
      });
    const connection = await broker.execute({
      type: "desktop.browser.open_connection",
      ...first.instance,
      threadId: THREAD_ID,
      leaseId: "lease-a",
      tabIds: ["tab-a"],
    });
    if (!("wsEndpoint" in connection)) throw new Error("Missing CDP endpoint");
    const socket = new WebSocket(connection.wsEndpoint);
    disposers.push(() => socket.terminate());
    await once(socket, "open");
    const closed = once(socket, "close");
    const events: DesktopBrowserChanged[] = [];
    broker.subscribe((event) => events.push(event));
    const sendsBeforeClose = first.sent.length;
    first.destroy();

    expect(() => broker.releaseWindow(7)).not.toThrow();
    await closed;
    expect(first.sent).toHaveLength(sendsBeforeClose);
    expect(events.at(-1)).toMatchObject({
      instanceId: first.instance.instanceId,
      threadId: THREAD_ID,
      tabs: [],
    });
    expect(broker.listInstances()).toEqual([second.instance]);
    for (const leaseId of ["lease-a", "lease-b"]) {
      await expect(
        broker.execute({
          type: "desktop.browser.acquire_control",
          ...second.instance,
          threadId: THREAD_ID,
          leaseId,
          tabIds: ["tab-c"],
          controllerLabel: "Agent",
          expiresAt,
        }),
      ).resolves.toHaveProperty("lease.leaseId", leaseId);
      await broker.execute({
        type: "desktop.browser.release_control",
        ...second.instance,
        threadId: THREAD_ID,
        leaseId,
      });
    }
  });

  it("keeps other windows usable while a destroyed entry awaits release", async () => {
    const { broker, addWindow, tabs, notify } = createFixture();
    const first = addWindow(7, ["tab-a"]);
    broker.setHostId("host-a");
    first.destroy();
    expect(() => addWindow(8, ["tab-b"])).not.toThrow();
    const second = broker
      .listInstances()
      .find((instance) => instance.instanceId !== first.instance.instanceId);
    if (!second) throw new Error("Second window was not registered");
    expect(broker.getTarget(8)).toMatchObject({
      hostId: "host-a",
      instanceId: second.instanceId,
    });
    tabs.get(8)![0]!.title = "Navigated";
    expect(notify).not.toThrow();
    await expect(
      broker.execute({
        type: "desktop.browser.list_tabs",
        ...second,
        threadId: THREAD_ID,
      }),
    ).resolves.toMatchObject({
      tabs: [{ tabId: "tab-b", title: "Navigated" }],
    });
    expect(() => broker.setHostId(null)).not.toThrow();
    expect(() => broker.releaseWindow(7)).not.toThrow();
    expect(broker.listInstances()).toHaveLength(1);
  });

  it.each(["takeover", "disconnect", "manager change", "dispose"])(
    "revokes control safely through %s while the window is destroyed",
    async (action) => {
      const { broker, addWindow, notify } = createFixture();
      const first = addWindow(7, ["tab-a"]);
      await broker.execute({
        type: "desktop.browser.acquire_control",
        ...first.instance,
        threadId: THREAD_ID,
        leaseId: "lease-a",
        tabIds: ["tab-a"],
        controllerLabel: "Agent",
        expiresAt: Date.now() + 60_000,
      });
      first.destroy();

      expect(() => {
        if (action === "takeover") broker.takeOver(7, "tab-a");
        else if (action === "disconnect") broker.setHostId(null);
        else if (action === "manager change") notify();
        else broker.dispose();
      }).not.toThrow();
      first.revive();
      if (action !== "dispose")
        expect(broker.getControl(7, "tab-a")?.control).toBeNull();
    },
  );

  it.each(["darwin", "linux"] as const)(
    "preserves the existing destroyed-window lifecycle on %s",
    (platform) => {
      const { broker, addWindow } = createFixture(platform);
      const first = addWindow(7);
      first.destroy();

      expect(() => broker.releaseWindow(7)).toThrow(
        "Object has been destroyed",
      );
    },
  );
});
