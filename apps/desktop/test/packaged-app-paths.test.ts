import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePackagedAppBinary } from "../scripts/packaged-app-paths.mjs";

describe("resolvePackagedAppBinary", () => {
  it("points at the unpacked Linux executable", async () => {
    await expect(
      resolvePackagedAppBinary({
        executableName: "bb",
        platform: "linux",
        productName: "bb",
        releaseDir: "/tmp/release",
      }),
    ).resolves.toBe(join("/tmp/release", "linux-unpacked", "bb"));
  });

  it("points at the unpacked Windows executable named after the product", async () => {
    await expect(
      resolvePackagedAppBinary({
        executableName: "bb-nightly",
        platform: "win32",
        productName: "bb Nightly",
        releaseDir: "C:\\work\\release",
      }),
    ).resolves.toBe(
      join("C:\\work\\release", "win-unpacked", "bb Nightly.exe"),
    );
  });

  it("still rejects platforms without a packaged layout", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "bb-packaged-paths-"));
    try {
      await expect(
        resolvePackagedAppBinary({
          executableName: "bb",
          platform: "freebsd",
          productName: "bb",
          releaseDir,
        }),
      ).rejects.toThrow("Unsupported packaged desktop platform: freebsd");
    } finally {
      await rm(releaseDir, { force: true, recursive: true });
    }
  });
});
