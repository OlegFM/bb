import { describe, expect, it } from "vitest";
import {
  shouldHandleSessionEnd,
  shouldQuitOnWindowAllClosed,
  shouldStartQuitSequence,
} from "../src/desktop-runtime-policy.js";

describe("shouldQuitOnWindowAllClosed", () => {
  it("keeps macOS running with no windows whether or not a tray exists", () => {
    expect(
      shouldQuitOnWindowAllClosed({ hasTray: true, platform: "darwin" }),
    ).toBe(false);
    expect(
      shouldQuitOnWindowAllClosed({ hasTray: false, platform: "darwin" }),
    ).toBe(false);
  });

  it("keeps Windows running with no windows so the tray owns the lifetime", () => {
    expect(
      shouldQuitOnWindowAllClosed({ hasTray: true, platform: "win32" }),
    ).toBe(false);
  });

  it("quits Windows with no windows when there is no tray to park in", () => {
    expect(
      shouldQuitOnWindowAllClosed({ hasTray: false, platform: "win32" }),
    ).toBe(true);
  });

  it("still quits Linux with no windows whether or not a tray exists", () => {
    expect(
      shouldQuitOnWindowAllClosed({ hasTray: true, platform: "linux" }),
    ).toBe(true);
    expect(
      shouldQuitOnWindowAllClosed({ hasTray: false, platform: "linux" }),
    ).toBe(true);
  });
});

describe("shouldHandleSessionEnd", () => {
  it("handles the Windows logoff event only on Windows", () => {
    expect(shouldHandleSessionEnd({ platform: "win32" })).toBe(true);
    expect(shouldHandleSessionEnd({ platform: "darwin" })).toBe(false);
    expect(shouldHandleSessionEnd({ platform: "linux" })).toBe(false);
  });
});

describe("shouldStartQuitSequence", () => {
  it("starts the quit sequence once and ignores re-entry", () => {
    expect(shouldStartQuitSequence({ stoppingForQuit: false })).toBe(true);
    expect(shouldStartQuitSequence({ stoppingForQuit: true })).toBe(false);
  });
});
