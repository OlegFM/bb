import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveExecutable, resolveSpawnPlanOrThrow } from "@bb/process-utils";
import { buildPluginApp } from "./build-plugin-app.js";
import {
  PLUGIN_TOOLCHAIN_PINS,
  resolvePluginBuildToolchain,
  toolchainCacheDir,
} from "./toolchain.js";

describe("plugin build toolchain", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "bb-toolchain-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("keys the cache directory on the pinned versions", () => {
    const dir = toolchainCacheDir("/data");
    for (const version of Object.values(PLUGIN_TOOLCHAIN_PINS)) {
      expect(basename(dir)).toContain(version);
    }
    expect(dir).toBe(join("/data", basename(dir)));
  });

  it("prefers a locally resolvable toolchain over fetching", async () => {
    const toolchain = await resolvePluginBuildToolchain(baseDir, {
      onFetchStart: () => {
        throw new Error("fetched despite a locally resolvable toolchain");
      },
    });

    expect(toolchain.esbuild).toMatch(/^file:\/\//);
    expect(toolchain.esbuild).toContain("esbuild");
    expect(toolchain.tailwindNode).toContain("@tailwindcss/node");
    expect(toolchain.tailwindOxide).toContain("@tailwindcss/oxide");
    expect(
      await rm(toolchainCacheDir(baseDir), { recursive: true }).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("returns importable module specifiers", async () => {
    const toolchain = await resolvePluginBuildToolchain(baseDir);
    const esbuild = (await import(
      toolchain.esbuild
    )) as typeof import("esbuild");
    const result = await esbuild.transform("const x: number = 1", {
      loader: "ts",
    });

    expect(result.code.trim()).toBe("const x = 1;");
  });

  describe("fetched toolchain", () => {
    it.runIf(process.env.BB_TEST_TOOLCHAIN_FETCH === "1")(
      "builds a plugin frontend with nothing resolvable locally",
      async () => {
        const fetchEvents: string[] = [];
        const toolchain = await resolvePluginBuildToolchain(baseDir, {
          ignoreLocal: true,
          onFetchStart: () => fetchEvents.push("start"),
          onFetchDone: (ms) => fetchEvents.push(`done:${ms > 0}`),
        });

        expect(fetchEvents).toEqual(["start", "done:true"]);

        expect(toolchain.esbuild).toContain("toolchain-");
        expect(toolchain.tailwindCssDir).toContain("toolchain-");

        const pluginDir = join(baseDir, "plugin");
        await mkdir(pluginDir, { recursive: true });
        await writeFile(
          join(pluginDir, "package.json"),
          JSON.stringify({
            name: "bb-plugin-fetched",
            version: "0.1.0",
            bb: {
              name: "Fetched",
              description: "Fetched toolchain fixture.",
              branding: { icon: "Zap" },
              server: "./server.ts",
              app: "./app.tsx",
            },
          }),
        );
        await writeFile(
          join(pluginDir, "server.ts"),
          "export default function plugin() {}",
        );
        await writeFile(
          join(pluginDir, "app.tsx"),
          `import { definePluginApp } from "@get-bb/plugin-sdk/app";\n` +
            `export default definePluginApp({});\n`,
        );

        const result = await buildPluginApp(pluginDir, "0.9.0-test", toolchain);
        const css = await readFile(result.cssPath, "utf8");

        expect(css.length).toBeGreaterThan(0);
        expect(css).toContain("--");
      },
      600_000,
    );

    it("keeps script-policy npm config out of the fetch", async () => {
      const binDir = join(baseDir, "bin");
      const envDump = join(baseDir, "npm-env.json");
      await mkdir(binDir, { recursive: true });
      const fakeNpm = join(
        binDir,
        process.platform === "win32" ? "npm.cmd" : "npm",
      );
      const fakeNpmNode = join(binDir, "npm-fixture.mjs");
      await writeFile(
        fakeNpmNode,
        `import { writeFileSync } from "node:fs";\n` +
          `const keys = ["npm_config_allow_scripts", "npm_config_ignore_scripts", "npm_config_foreground_scripts", "npm_config_registry"];\n` +
          `const selected = Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.includes(key.toLowerCase())));\n` +
          `writeFileSync(process.env.BB_TEST_NPM_ENV_DUMP, JSON.stringify({ selected, argv: process.argv.slice(2), entry: process.argv[1], execPath: process.execPath }));\n`,
      );
      if (process.platform === "win32") {
        await writeFile(fakeNpm, `@node "%~dp0\\npm-fixture.mjs" %*\r\n`);
      } else {
        await writeFile(
          fakeNpm,
          `#!/bin/sh\nexec "${process.execPath}" "${fakeNpmNode}" "$@"\n`,
        );
        await chmod(fakeNpm, 0o755);
      }

      const overrides: Record<string, string> = {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        BB_TEST_NPM_ENV_DUMP: envDump,
        npm_config_allow_scripts: "@github/keytar,node-pty",
        NPM_CONFIG_IGNORE_SCRIPTS: "false",
        npm_config_foreground_scripts: "true",
        npm_config_registry: "https://registry.example.invalid/",
      };
      const previous = new Map<string, string | undefined>();
      for (const [key, value] of Object.entries(overrides)) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
      }
      try {
        expect(
          await resolveExecutable({ command: "npm", env: process.env }),
        ).toBe(fakeNpm);
        if (process.platform === "win32") {
          const plan = await resolveSpawnPlanOrThrow({
            command: "npm",
            args: ["--version"],
            env: process.env,
          });
          expect(plan).toEqual({
            command: process.execPath,
            args: [fakeNpmNode, "--version"],
          });
        }
        await expect(
          resolvePluginBuildToolchain(baseDir, { ignoreLocal: true }),
        ).rejects.toThrow(/incomplete or misversioned/);
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      const recorded = JSON.parse(await readFile(envDump, "utf8")) as {
        selected: Record<string, string>;
        argv: string[];
        entry: string;
        execPath: string;
      };
      const seen = new Map(
        Object.entries(recorded.selected).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      expect(seen.has("npm_config_allow_scripts")).toBe(false);
      expect(seen.has("npm_config_ignore_scripts")).toBe(false);
      expect(seen.has("npm_config_foreground_scripts")).toBe(false);
      expect(seen.get("npm_config_registry")).toBe(
        "https://registry.example.invalid/",
      );
      expect(recorded.entry).toBe(fakeNpmNode);
      expect(recorded.execPath).toBe(process.execPath);
      const staging = recorded.argv[2];
      expect(
        staging?.startsWith(`${toolchainCacheDir(baseDir)}.staging-`),
      ).toBe(true);
      expect(staging?.slice(toolchainCacheDir(baseDir).length)).toMatch(
        /^\.staging-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(recorded.argv).toEqual([
        "install",
        "--prefix",
        staging,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        ...Object.entries(PLUGIN_TOOLCHAIN_PINS).map(
          ([name, version]) => `${name}@${version}`,
        ),
      ]);
    });

    it("reuses an already-fetched toolchain without reinstalling", async () => {
      const local = await resolvePluginBuildToolchain(baseDir);
      expect(local.tailwindCssDir.length).toBeGreaterThan(0);
    });
  });
});
