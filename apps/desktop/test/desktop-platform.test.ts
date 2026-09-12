import { describe, expect, it } from "vitest";
import { resolveBbDesktopPlatform } from "../src/desktop-platform.js";

describe("resolveBbDesktopPlatform", () => {
  it("maps each Node platform to its desktop platform", () => {
    expect(resolveBbDesktopPlatform("darwin")).toBe("macos");
    expect(resolveBbDesktopPlatform("win32")).toBe("windows");
    expect(resolveBbDesktopPlatform("linux")).toBe("linux");
  });

  it("does not report other platforms as Windows", () => {
    expect(resolveBbDesktopPlatform("freebsd")).toBe("linux");
  });
});
