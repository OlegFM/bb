import { describe, expect, it } from "vitest";
import { resolveHostPlatform } from "./host-platform.js";

describe("resolveHostPlatform", () => {
  it("reports native Windows as win32", () => {
    expect(resolveHostPlatform("win32", {})).toBe("win32");
  });

  it("ignores WSL variables leaking into a native Windows process", () => {
    expect(
      resolveHostPlatform("win32", { WSL_DISTRO_NAME: "Ubuntu-24.04" }),
    ).toBe("win32");
  });

  it("keeps WSL distinct from Linux", () => {
    expect(
      resolveHostPlatform("linux", { WSL_DISTRO_NAME: "Ubuntu-24.04" }),
    ).toBe("wsl");
    expect(
      resolveHostPlatform("linux", { WSL_INTEROP: "/run/WSL/1_interop" }),
    ).toBe("wsl");
    expect(resolveHostPlatform("linux", {})).toBe("linux");
  });

  it("maps macOS and unsupported platforms", () => {
    expect(resolveHostPlatform("darwin", {})).toBe("darwin");
    expect(resolveHostPlatform("freebsd", {})).toBe("unknown");
  });
});
