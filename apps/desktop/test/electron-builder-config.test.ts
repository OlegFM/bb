import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  createDesktopReleaseInfo,
  DESKTOP_AUTO_UPDATE_FEED_CONFIG,
} from "../src/desktop-update-provider.js";

const desktopPackageRoot = process.cwd();
const require = createRequire(resolve(desktopPackageRoot, "package.json"));
const nativeModulesScript: {
  parseStandaloneArguments(argv: string[]): {
    appOutDir: string | undefined;
    options: {
      arch: string;
      electronVersion?: string;
      platform: string;
    };
  };
  resolveBetterSqlite3PrebuildArguments(options: {
    arch: string;
    electronVersion: string;
    platform: string;
  }): string[];
} = require("./scripts/prepare-native-modules.cjs");

const macConfigSchema = z
  .object({
    entitlements: z.string().min(1),
    entitlementsInherit: z.string().min(1),
    gatekeeperAssess: z.literal(false),
    hardenedRuntime: z.literal(true),
    icon: z.string().min(1),
    identity: z.string().nullable().optional(),
    notarize: z.boolean(),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("arm64")]),
          target: z.literal("dmg"),
        })
        .passthrough(),
      z
        .object({
          arch: z.tuple([z.literal("arm64")]),
          target: z.literal("zip"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const linuxConfigSchema = z
  .object({
    category: z.literal("Development"),
    executableName: z.enum(["bb", "bb-nightly"]),
    icon: z.string().min(1),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("x64")]),
          target: z.literal("AppImage"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const winConfigSchema = z
  .object({
    azureSignOptions: z
      .object({
        certificateProfileName: z.string().min(1),
        codeSigningAccountName: z.string().min(1),
        endpoint: z.string().min(1),
        publisherName: z.string().min(1),
      })
      .optional(),
    icon: z.string().min(1),
    publisherName: z.string().min(1).optional(),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("x64")]),
          target: z.literal("nsis"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const nsisConfigSchema = z
  .object({
    allowToChangeInstallationDirectory: z.literal(true),
    createDesktopShortcut: z.literal(true),
    deleteAppDataOnUninstall: z.literal(false),
    oneClick: z.literal(false),
    perMachine: z.literal(false),
  })
  .passthrough();

const electronBuilderFileSetSchema = z
  .object({
    filter: z.array(z.string().min(1)),
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .passthrough();

const electronBuilderFilePatternSchema = z.union([
  z.string().min(1),
  electronBuilderFileSetSchema,
]);

const electronBuilderConfigSchema = z
  .object({
    afterPack: z.string().min(1),
    asarUnpack: z.array(z.string().min(1)),
    dmg: z
      .object({
        sign: z.boolean(),
      })
      .passthrough(),
    files: z.array(electronBuilderFilePatternSchema),
    linux: linuxConfigSchema,
    mac: macConfigSchema,
    npmRebuild: z.literal(false),
    nsis: nsisConfigSchema,
    win: winConfigSchema,
    appId: z.string().min(1),
    artifactName: z.string().min(1),
    productName: z.string().min(1),
    publish: z.tuple([
      z
        .object({
          channel: z.enum(["latest", "nightly"]),
          provider: z.literal("generic"),
          url: z.string().min(1),
        })
        .passthrough(),
    ]),
    toolsets: z.object({
      appimage: z.literal("1.0.3"),
    }),
  })
  .passthrough();

const desktopPackageJsonSchema = z
  .object({
    main: z.literal("dist/main.js"),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    type: z.never().optional(),
  })
  .passthrough();

const workspacePackageJsonSchema = z
  .object({
    pnpm: z.object({
      supportedArchitectures: z.object({
        cpu: z.array(z.string().min(1)),
        os: z.array(z.string().min(1)),
      }),
    }),
  })
  .passthrough();

const signingEnvironmentKeys = [
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SIGNING_ACCOUNT_NAME",
  "AZURE_SIGNING_CERTIFICATE_PROFILE",
  "AZURE_SIGNING_ENDPOINT",
  "AZURE_TENANT_ID",
  "CSC_IDENTITY_AUTO_DISCOVERY",
  "CSC_KEY_PASSWORD",
  "CSC_LINK",
  "CSC_NAME",
  "WINDOWS_PUBLISHER_NAME",
];
const audioInputEntitlementPattern =
  /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/u;

type ElectronBuilderConfig = z.infer<typeof electronBuilderConfigSchema>;
type EnvironmentOverrides = Record<string, string | undefined>;
type ScriptRunResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};
type ReadResolvedConfigResult = {
  config: ElectronBuilderConfig;
};
type CreateScriptEnvironment = (
  overrides: EnvironmentOverrides,
) => NodeJS.ProcessEnv;
type RunConfigScript = (
  overrides: EnvironmentOverrides,
  extraArguments?: string[],
) => Promise<ScriptRunResult>;
type ReadResolvedConfig = (
  overrides: EnvironmentOverrides,
  extraArguments?: string[],
) => Promise<ReadResolvedConfigResult>;
type RunNativePrepScriptWithArgs = (
  appOutDir: string,
  extraArguments: string[],
) => Promise<ScriptRunResult>;

const createScriptEnvironment: CreateScriptEnvironment = (overrides) => {
  const env = { ...process.env };

  for (const key of signingEnvironmentKeys) {
    delete env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
};

const runConfigScript: RunConfigScript = async (
  overrides,
  extraArguments = [],
) => {
  const child = spawn(
    process.execPath,
    ["scripts/run-electron-builder.mjs", "--print-config", ...extraArguments],
    {
      cwd: desktopPackageRoot,
      env: createScriptEnvironment(overrides),
    },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

const runNativePrepScriptWithArgs: RunNativePrepScriptWithArgs = async (
  appOutDir,
  extraArguments,
) => {
  const child = spawn(
    process.execPath,
    ["scripts/prepare-native-modules.cjs", appOutDir, ...extraArguments],
    { cwd: desktopPackageRoot },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });
  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });
  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

const readResolvedConfig: ReadResolvedConfig = async (
  overrides,
  extraArguments = [],
) => {
  const result = await runConfigScript(overrides, extraArguments);

  expect(result.exitCode).toBe(0);
  return {
    config: electronBuilderConfigSchema.parse(JSON.parse(result.stdout)),
  };
};

describe("electron-builder signing config", () => {
  it("keeps package metadata compatible with electron universal's CJS entry asar", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.main).toBe("dist/main.js");
    expect(packageJson).not.toHaveProperty("type");
  });

  it("ships no plugin build toolchain binaries", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(Object.keys(packageJson.optionalDependencies ?? {})).not.toEqual(
      expect.arrayContaining(["@esbuild/darwin-arm64", "@esbuild/darwin-x64"]),
    );
  });

  it("unpacks the ESM bb-app bridge with an explicit module extension", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.asarUnpack).toContain("dist/bb-app-bridge.mjs");
    expect(config.asarUnpack).not.toContain("dist/bb-app-bridge.js");
  });

  it("runs a native module preparation hook after packaging", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));
    const hookPath = "scripts/prepare-native-modules.cjs";

    expect(config.afterPack).toBe(hookPath);
    await expect(
      access(resolve(desktopPackageRoot, hookPath)),
    ).resolves.toBeUndefined();
  });

  it("passes the standalone platform through to better-sqlite3 prebuild-install", () => {
    const { options } = nativeModulesScript.parseStandaloneArguments([
      "/tmp/linux-unpacked",
      "--electron-version=41.7.0",
      "--arch=x64",
      "--platform=linux",
    ]);
    const electronVersion = options.electronVersion;
    if (electronVersion === undefined) {
      throw new Error("Expected the standalone Electron version argument");
    }

    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: options.arch,
        electronVersion,
        platform: options.platform,
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=41.7.0",
      "--arch=x64",
      "--platform=linux",
    ]);
  });

  it("preserves the macOS better-sqlite3 prebuild-install arguments", () => {
    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: "arm64",
        electronVersion: "41.7.0",
        platform: "darwin",
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=41.7.0",
      "--arch=arm64",
      "--platform=darwin",
    ]);
  });

  it("passes win32 x64 through to better-sqlite3 prebuild-install", () => {
    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: "x64",
        electronVersion: "41.7.0",
        platform: "win32",
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=41.7.0",
      "--arch=x64",
      "--platform=win32",
    ]);
  });

  it("installs native plugin build packages for arm64 and x64", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "..", "..", "package.json"),
      "utf8",
    );
    const packageJson = workspacePackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.pnpm.supportedArchitectures).toEqual({
      cpu: ["arm64", "x64"],
      os: ["current"],
    });
  });

  it("disables in-place native rebuilds so the shared pnpm store is not mutated", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.npmRebuild).toBe(false);
  });

  it("excludes source maps from packaged app files", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.files).toContain("!**/*.map");
  });

  it("copies the app scaffold template as a dedicated file set", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.files).toContainEqual({
      filter: ["**/*"],
      from: "node_modules/bb-app/server/dist/app-scaffold-template",
      to: "node_modules/bb-app/server/dist/app-scaffold-template",
    });
  });

  it("patches packaged node-pty helper path handling", async () => {
    const appOutDir = await mkdtemp(
      resolve(tmpdir(), "bb-desktop-native-modules-"),
    );
    const nodePtyPackageDir = resolve(
      appOutDir,
      "bb.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
    );
    const rebuiltNativeDir = resolve(nodePtyPackageDir, "build", "Release");
    const unixTerminalPath = resolve(
      nodePtyPackageDir,
      "lib",
      "unixTerminal.js",
    );
    const helperPath = resolve(
      nodePtyPackageDir,
      "prebuilds",
      "darwin-arm64",
      "spawn-helper",
    );
    const rebuiltHelperPath = resolve(rebuiltNativeDir, "spawn-helper");

    try {
      await mkdir(rebuiltNativeDir, { recursive: true });
      await writeFile(resolve(rebuiltNativeDir, "pty.node"), "rebuilt");
      await writeFile(rebuiltHelperPath, "rebuilt-helper");
      await chmod(rebuiltHelperPath, 0o644);
      await mkdir(dirname(unixTerminalPath), { recursive: true });
      await writeFile(
        unixTerminalPath,
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      );
      await mkdir(dirname(helperPath), { recursive: true });
      await writeFile(helperPath, "helper");
      await chmod(helperPath, 0o644);
      const result = await runNativePrepScriptWithArgs(appOutDir, [
        "--platform=darwin",
      ]);

      expect(result.exitCode).toBe(0);
      await expect(
        access(resolve(rebuiltNativeDir, "pty.node")),
      ).resolves.toBeUndefined();
      await expect(readFile(unixTerminalPath, "utf8")).resolves.toContain(
        "helperPath.replace(/app\\.asar(?!\\.unpacked)/g, 'app.asar.unpacked')",
      );
      if (process.platform === "win32") {
        await expect(access(helperPath)).resolves.toBeUndefined();
        await expect(access(rebuiltHelperPath)).resolves.toBeUndefined();
      } else {
        expect((await stat(helperPath)).mode & 0o777).toBe(0o755);
        expect((await stat(rebuiltHelperPath)).mode & 0o777).toBe(0o755);
      }
    } finally {
      await rm(appOutDir, { force: true, recursive: true });
    }
  });

  it("accepts a Windows app output whose node-pty carries the ConPTY prebuild", async () => {
    const appOutDir = await mkdtemp(
      resolve(tmpdir(), "bb-desktop-native-modules-win-"),
    );
    const nodePtyPackageDir = resolve(
      appOutDir,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
    );
    try {
      await mkdir(resolve(nodePtyPackageDir, "lib"), { recursive: true });
      await writeFile(
        resolve(nodePtyPackageDir, "lib", "unixTerminal.js"),
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      );
      const prebuildDir = resolve(nodePtyPackageDir, "prebuilds", "win32-x64");
      await mkdir(resolve(prebuildDir, "conpty"), { recursive: true });
      for (const relativePath of [
        "conpty.node",
        "conpty_console_list.node",
        "conpty/conpty.dll",
        "conpty/OpenConsole.exe",
      ]) {
        await writeFile(resolve(prebuildDir, relativePath), "binary");
      }
      const result = await runNativePrepScriptWithArgs(appOutDir, [
        "--platform=win32",
        "--arch=x64",
      ]);

      expect(result.exitCode).toBe(0);
    } finally {
      await rm(appOutDir, { force: true, recursive: true });
    }
  });

  it("refuses a Windows app output whose ConPTY prebuild is incomplete", async () => {
    const appOutDir = await mkdtemp(
      resolve(tmpdir(), "bb-desktop-native-modules-win-"),
    );
    const nodePtyPackageDir = resolve(
      appOutDir,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
    );
    try {
      await mkdir(resolve(nodePtyPackageDir, "lib"), { recursive: true });
      await writeFile(
        resolve(nodePtyPackageDir, "lib", "unixTerminal.js"),
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      );
      const prebuildDir = resolve(nodePtyPackageDir, "prebuilds", "win32-x64");
      await mkdir(resolve(prebuildDir, "conpty"), { recursive: true });
      await writeFile(resolve(prebuildDir, "conpty.node"), "binary");
      await writeFile(
        resolve(prebuildDir, "conpty_console_list.node"),
        "binary",
      );
      await writeFile(resolve(prebuildDir, "conpty", "conpty.dll"), "binary");
      const result = await runNativePrepScriptWithArgs(appOutDir, [
        "--platform=win32",
        "--arch=x64",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Packaged node-pty is missing");
      expect(result.stderr).toContain(
        join("prebuilds", "win32-x64", "conpty", "OpenConsole.exe"),
      );
    } finally {
      await rm(appOutDir, { force: true, recursive: true });
    }
  });

  it("points mac signing entitlements at checked-in plist files", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(config.mac.entitlementsInherit).toBe(
      "build/entitlements.mac.inherit.plist",
    );

    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlements)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlementsInherit)),
    ).resolves.toBeUndefined();
  });

  it("packages macOS artifacts for arm64 only", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.mac.target).toEqual([
      { arch: ["arm64"], target: "dmg" },
      { arch: ["arm64"], target: "zip" },
    ]);
  });

  it("packages a Linux AppImage for x64", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.linux).toMatchObject({
      category: "Development",
      executableName: "bb",
      target: [{ arch: ["x64"], target: "AppImage" }],
    });
    expect(config.toolsets.appimage).toBe("1.0.3");
    await expect(
      access(resolve(desktopPackageRoot, config.linux.icon)),
    ).resolves.toBeUndefined();
  });

  it("grants audio input to the signed app and helper processes", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));
    const entitlementPaths = [
      config.mac.entitlements,
      config.mac.entitlementsInherit,
    ];

    for (const entitlementPath of entitlementPaths) {
      const entitlements = await readFile(
        resolve(desktopPackageRoot, entitlementPath),
        "utf8",
      );

      expect(entitlements).toMatch(audioInputEntitlementPattern);
    }
  });

  it("keeps the updater provider pointed at desktop-latest release assets", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.publish[0]).toMatchObject(DESKTOP_AUTO_UPDATE_FEED_CONFIG);
    expect(DESKTOP_AUTO_UPDATE_FEED_CONFIG.url).toBe(
      "https://github.com/get-bb/bb/releases/download/desktop-latest/",
    );
  });

  it("creates a separate nightly app identity and update feed", async () => {
    const { config } = await readResolvedConfig({
      BB_DESKTOP_RELEASE_CHANNEL: "nightly",
    });
    const nightlyRelease = createDesktopReleaseInfo("nightly");

    expect(config.appId).toBe("dev.bb.desktop.nightly");
    expect(config.appId).toBe(nightlyRelease.appUserModelId);
    expect(config.productName).toBe("bb Nightly");
    expect(config.artifactName).toBe("bb-nightly-${version}-${arch}.${ext}");
    expect(config.linux.icon).toBe("assets/icon-nightly.png");
    expect(config.linux.executableName).toBe("bb-nightly");
    expect(config.mac.icon).toBe("assets/icon-nightly.icns");
    await expect(
      access(resolve(desktopPackageRoot, config.mac.icon)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, "assets/icon-nightly.png")),
    ).resolves.toBeUndefined();
    expect(config.publish[0]).toEqual({
      channel: "nightly",
      provider: "generic",
      url: nightlyRelease.updateReleaseBaseUrl,
    });
  });

  it("rejects unknown desktop release channels", async () => {
    const result = await runConfigScript({
      BB_DESKTOP_RELEASE_CHANNEL: "canary",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "BB_DESKTOP_RELEASE_CHANNEL must be latest or nightly",
    );
  });

  it("signs local builds via keychain auto-discovery when signing secrets are absent", async () => {
    const { config } = await readResolvedConfig({});

    expect(config.mac).not.toHaveProperty("identity");
    expect(config.mac.notarize).toBe(false);
    expect(config.dmg.sign).toBe(false);
    expect(config.appId).toBe(
      createDesktopReleaseInfo("latest").appUserModelId,
    );
  });

  it("keeps builds unsigned when keychain auto-discovery is explicitly disabled", async () => {
    const { config } = await readResolvedConfig({
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });

    expect(config.mac.identity).toBeNull();
    expect(config.mac.notarize).toBe(false);
  });

  it("rejects partial signing secret sets", async () => {
    const partialAppleCredentials = await runConfigScript({
      APPLE_ID: "sawyer@example.com",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
    });

    expect(partialAppleCredentials.exitCode).toBe(1);
    expect(partialAppleCredentials.stderr).toContain(
      "Incomplete macOS signing/notarization environment.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Present: CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Missing: APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.",
    );
  });

  it("enables app signing and notarization when signing and Apple credentials are complete", async () => {
    const completeAppleCredentials = await readResolvedConfig({
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_ID: "sawyer@example.com",
      APPLE_TEAM_ID: "TEAMID1234",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
      CSC_NAME: "Sawyer Hood (TEAMID1234)",
    });

    expect(completeAppleCredentials.config.mac.identity).toBe(
      "Sawyer Hood (TEAMID1234)",
    );
    expect(completeAppleCredentials.config.mac.notarize).toBe(true);
    expect(completeAppleCredentials.config.dmg.sign).toBe(false);
  });

  it("packages a per-user Windows NSIS installer for x64", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.win.target).toEqual([{ arch: ["x64"], target: "nsis" }]);
    expect(config.nsis).toMatchObject({
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      deleteAppDataOnUninstall: false,
      oneClick: false,
      perMachine: false,
    });
    expect(config.artifactName).toBe(
      "${productName}-${version}-${arch}.${ext}",
    );
    await expect(
      access(resolve(desktopPackageRoot, config.win.icon)),
    ).resolves.toBeUndefined();
  });

  it("uses the nightly PNG icon for Windows builds", async () => {
    const { config } = await readResolvedConfig({
      BB_DESKTOP_RELEASE_CHANNEL: "nightly",
    });

    expect(config.win.icon).toBe("assets/icon-nightly.png");
  });

  it("keeps Windows builds unsigned and publisher-less without Azure signing secrets", async () => {
    const { config } = await readResolvedConfig({});

    expect(config.win).not.toHaveProperty("azureSignOptions");
    expect(config.win).not.toHaveProperty("publisherName");
  });

  it("signs Windows builds with Azure Trusted Signing when the secret set is complete", async () => {
    const { config } = await readResolvedConfig(
      {
        AZURE_CLIENT_ID: "client",
        AZURE_CLIENT_SECRET: "secret",
        AZURE_SIGNING_ACCOUNT_NAME: "bb-signing",
        AZURE_SIGNING_CERTIFICATE_PROFILE: "bb-desktop",
        AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
        AZURE_TENANT_ID: "tenant",
        WINDOWS_PUBLISHER_NAME: "bb Desktop Publisher",
      },
      ["--win"],
    );

    expect(config.win.azureSignOptions).toEqual({
      certificateProfileName: "bb-desktop",
      codeSigningAccountName: "bb-signing",
      endpoint: "https://weu.codesigning.azure.net",
      publisherName: "bb Desktop Publisher",
    });
    expect(config.win.publisherName).toBe("bb Desktop Publisher");
  });

  it("rejects partial Windows signing secret sets", async () => {
    const result = await runConfigScript(
      {
        AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
        WINDOWS_PUBLISHER_NAME: "bb Desktop Publisher",
      },
      ["--win"],
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Incomplete Windows signing environment.");
    expect(result.stderr).toContain(
      "Present: AZURE_SIGNING_ENDPOINT, WINDOWS_PUBLISHER_NAME.",
    );
    expect(result.stderr).toContain(
      "Missing: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SIGNING_ACCOUNT_NAME, AZURE_SIGNING_CERTIFICATE_PROFILE.",
    );
  });

  it("ignores a partial Windows signing secret set for a macOS build", async () => {
    const { config } = await readResolvedConfig(
      {
        AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
        WINDOWS_PUBLISHER_NAME: "bb Desktop Publisher",
      },
      ["--mac"],
    );

    expect(config.win).not.toHaveProperty("azureSignOptions");
    expect(config.win).not.toHaveProperty("publisherName");
  });

  it("ignores a complete Windows signing secret set for a Linux build", async () => {
    const { config } = await readResolvedConfig(
      {
        AZURE_CLIENT_ID: "client",
        AZURE_CLIENT_SECRET: "secret",
        AZURE_SIGNING_ACCOUNT_NAME: "bb-signing",
        AZURE_SIGNING_CERTIFICATE_PROFILE: "bb-desktop",
        AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
        AZURE_TENANT_ID: "tenant",
        WINDOWS_PUBLISHER_NAME: "bb Desktop Publisher",
      },
      ["--linux"],
    );

    expect(config.win).not.toHaveProperty("azureSignOptions");
    expect(config.win).not.toHaveProperty("publisherName");
  });

  it("leaves the macOS and Linux blocks untouched by the Windows target", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const baseConfig = electronBuilderConfigSchema.parse(
      JSON.parse(configText),
    );
    const { config } = await readResolvedConfig({});

    expect(config.linux).toEqual({ ...baseConfig.linux, executableName: "bb" });
    expect(config.mac).toEqual({
      ...baseConfig.mac,
      icon: "assets/icon.icns",
      identity: undefined,
      notarize: false,
    });
  });
});
