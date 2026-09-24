import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("bundled CommonJS file lock", () => {
  it("loads the native addon and excludes another holder until release", async () => {
    const cacheDir = join(packageRoot, "node_modules", ".cache");
    await mkdir(cacheDir, { recursive: true });
    const buildDir = await mkdtemp(join(cacheDir, "file-lock-cjs-"));
    try {
      const outputPath = join(buildDir, "file-lock.cjs");
      const result = await build({
        bundle: true,
        entryPoints: [join(packageRoot, "src", "file-lock.ts")],
        external: ["fs-native-extensions"],
        format: "cjs",
        logLevel: "silent",
        outfile: outputPath,
        platform: "node",
        target: "node22",
      });
      expect(result.warnings).toEqual([]);
      const module = createRequire(import.meta.url)(
        outputPath,
      ) as typeof import("../src/file-lock.js");
      const lockPath = join(buildDir, "test.lock");
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const owner = module.withFileLock({
        path: lockPath,
        timeoutMs: 1_000,
        work: async () => {
          enter();
          await held;
          return "owner";
        },
      });
      await entered;
      try {
        await expect(
          module.withFileLock({
            path: lockPath,
            timeoutMs: 50,
            work: async () => "contender",
          }),
        ).rejects.toBeInstanceOf(module.FileLockTimeoutError);
      } finally {
        release();
      }
      await expect(owner).resolves.toBe("owner");
      await expect(
        module.withFileLock({
          path: lockPath,
          timeoutMs: 1_000,
          work: async () => "next",
        }),
      ).resolves.toBe("next");
    } finally {
      await rm(buildDir, { force: true, recursive: true });
    }
  });
});
