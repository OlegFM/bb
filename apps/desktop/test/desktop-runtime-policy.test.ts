import { describe, expect, it } from "vitest";
import {
  shouldHandleSessionEnd,
  shouldQuitOnWindowAllClosed,
} from "../src/desktop-runtime-policy.js";

describe("shouldQuitOnWindowAllClosed", () => {
  it("keeps macOS running with no windows", () => {
    expect(shouldQuitOnWindowAllClosed({ platform: "darwin" })).toBe(false);
  });

  it("keeps Windows running with no windows so the tray owns the lifetime", () => {
    expect(shouldQuitOnWindowAllClosed({ platform: "win32" })).toBe(false);
  });

  it("still quits Linux with no windows", () => {
    expect(shouldQuitOnWindowAllClosed({ platform: "linux" })).toBe(true);
  });
});

describe("shouldHandleSessionEnd", () => {
  it("handles the Windows logoff event only on Windows", () => {
    expect(shouldHandleSessionEnd({ platform: "win32" })).toBe(true);
    expect(shouldHandleSessionEnd({ platform: "darwin" })).toBe(false);
    expect(shouldHandleSessionEnd({ platform: "linux" })).toBe(false);
  });
});
