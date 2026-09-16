import { describe, expect, it } from "vitest";
import {
  createDesktopTray,
  shouldCreateTrayIcon,
  type DesktopTrayDeps,
  type DesktopTrayHandle,
  type DesktopTrayMenuArgs,
} from "../src/desktop-tray.js";

interface FakeTray extends DesktopTrayHandle {
  clicks: Array<() => void>;
  destroyed: number;
  menus: unknown[];
  tooltips: string[];
}

function createFakeTray(): FakeTray {
  const tray: FakeTray = {
    clicks: [],
    destroyed: 0,
    menus: [],
    tooltips: [],
    destroy() {
      tray.destroyed += 1;
    },
    on(event, listener) {
      expect(event).toBe("click");
      tray.clicks.push(listener);
    },
    setContextMenu(menu) {
      tray.menus.push(menu);
    },
    setToolTip(tooltip) {
      tray.tooltips.push(tooltip);
    },
  };
  return tray;
}

function createDeps(fake: FakeTray): DesktopTrayDeps & {
  builtMenus: DesktopTrayMenuArgs[];
  createdIcons: string[];
} {
  const builtMenus: DesktopTrayMenuArgs[] = [];
  const createdIcons: string[] = [];
  return {
    builtMenus,
    createdIcons,
    buildMenu(args) {
      builtMenus.push(args);
      return { kind: "fake-menu" };
    },
    createIcon(imagePath) {
      createdIcons.push(imagePath);
      return fake;
    },
  };
}

describe("shouldCreateTrayIcon", () => {
  it("creates a tray icon only on Windows", () => {
    expect(shouldCreateTrayIcon({ platform: "win32" })).toBe(true);
    expect(shouldCreateTrayIcon({ platform: "darwin" })).toBe(false);
    expect(shouldCreateTrayIcon({ platform: "linux" })).toBe(false);
  });
});

describe("createDesktopTray", () => {
  it("returns null off Windows without touching the deps", () => {
    const fake = createFakeTray();
    const deps = createDeps(fake);

    expect(
      createDesktopTray({
        applicationName: "bb",
        deps,
        iconPath: "/opt/bb/icon.png",
        onQuit() {},
        onShow() {},
        platform: "linux",
      }),
    ).toBeNull();
    expect(deps.createdIcons).toEqual([]);
  });

  it("builds a Windows tray named after the app whose click and menu reach the callbacks", () => {
    const fake = createFakeTray();
    const deps = createDeps(fake);
    const calls: string[] = [];

    const tray = createDesktopTray({
      applicationName: "bb Nightly",
      deps,
      iconPath: "C:\\bb\\icon.png",
      onQuit() {
        calls.push("quit");
      },
      onShow() {
        calls.push("show");
      },
      platform: "win32",
    });

    expect(tray).toBe(fake);
    expect(deps.createdIcons).toEqual(["C:\\bb\\icon.png"]);
    expect(fake.tooltips).toEqual(["bb Nightly"]);
    expect(fake.menus).toEqual([{ kind: "fake-menu" }]);
    expect(deps.builtMenus[0]?.showLabel).toBe("Open bb Nightly");
    expect(deps.builtMenus[0]?.quitLabel).toBe("Quit bb Nightly");
    deps.builtMenus[0]?.onShow();
    deps.builtMenus[0]?.onQuit();
    fake.clicks[0]?.();
    expect(calls).toEqual(["show", "quit", "show"]);
  });
});
