import { describe, expect, it } from "vitest";
import {
  LINUX_FRAMELESS_WINDOW_ARGUMENT,
  resolveWindowsTitleBarOverlay,
  shouldUseLinuxFramelessWindow,
  shouldUseWindowsTitleBarOverlay,
  WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
} from "../src/desktop-window-frame.js";

describe("desktop window frame", () => {
  it("enables frameless windows on Linux when requested", () => {
    expect(
      shouldUseLinuxFramelessWindow({
        argv: ["bb-nightly", LINUX_FRAMELESS_WINDOW_ARGUMENT],
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("keeps the native Linux frame by default", () => {
    expect(
      shouldUseLinuxFramelessWindow({
        argv: ["bb-nightly"],
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("ignores the Linux-only option on macOS and Windows", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(
        shouldUseLinuxFramelessWindow({
          argv: ["bb", LINUX_FRAMELESS_WINDOW_ARGUMENT],
          platform,
        }),
      ).toBe(false);
    }
  });
});

describe("Windows title bar overlay", () => {
  it("is used on Windows only", () => {
    expect(shouldUseWindowsTitleBarOverlay({ platform: "win32" })).toBe(true);
    expect(shouldUseWindowsTitleBarOverlay({ platform: "darwin" })).toBe(false);
    expect(shouldUseWindowsTitleBarOverlay({ platform: "linux" })).toBe(false);
  });

  it("matches the app chrome row height and follows the theme", () => {
    expect(WINDOWS_TITLE_BAR_OVERLAY_HEIGHT).toBe(48);
    expect(resolveWindowsTitleBarOverlay({ darkColors: true })).toEqual({
      color: "#1f1f1f",
      height: 48,
      symbolColor: "#e8e8e8",
    });
    expect(resolveWindowsTitleBarOverlay({ darkColors: false })).toEqual({
      color: "#f6f6f6",
      height: 48,
      symbolColor: "#1f1f1f",
    });
  });
});
