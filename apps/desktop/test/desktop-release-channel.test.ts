import { describe, expect, it } from "vitest";
import {
  createDesktopReleaseConfig,
  resolveDesktopBuildPlatform,
} from "../scripts/desktop-release-channel.mjs";

describe("resolveDesktopBuildPlatform", () => {
  it("maps each supported Node platform to its desktop build platform", () => {
    expect(resolveDesktopBuildPlatform("darwin")).toBe("macos");
    expect(resolveDesktopBuildPlatform("linux")).toBe("linux");
    expect(resolveDesktopBuildPlatform("win32")).toBe("windows");
  });

  it("rejects platforms the desktop does not build for", () => {
    expect(() => resolveDesktopBuildPlatform("freebsd")).toThrow(
      "Desktop builds support darwin, linux and win32 only, got freebsd.",
    );
  });
});

describe("createDesktopReleaseConfig update metadata", () => {
  it("names the Windows updater metadata after the channel with no OS suffix", () => {
    expect(
      createDesktopReleaseConfig("latest").updateMetadataFileNames,
    ).toEqual({
      linux: "latest-linux.yml",
      macos: "latest-mac.yml",
      windows: "latest.yml",
    });
    expect(
      createDesktopReleaseConfig("nightly").updateMetadataFileNames,
    ).toEqual({
      linux: "nightly-linux.yml",
      macos: "nightly-mac.yml",
      windows: "nightly.yml",
    });
  });
});
