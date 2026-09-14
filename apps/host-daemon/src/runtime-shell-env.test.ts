import fs from "node:fs/promises";
import os from "node:os";
import path, { delimiter } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUserShellPathResolver,
  prepareRuntimeShellEnv,
  readWindowsRegistryPath,
  resolveBbExecutablePathInDirectory,
  resolveLocalBbExecutablePath,
  resolveUserShellPath,
  type SpawnUserShellEnv,
  type SpawnUserShellEnvArgs,
  type UserShellEnvSpawnResult,
} from "./runtime-shell-env.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directoryPath);
  return directoryPath;
}

interface FakeCliPackageOptions {
  executablePath?: string;
  executable?: boolean;
  writeEntry?: boolean;
  writeRuntime?: boolean;
}

interface FakeCliPackage {
  cliEntryPath: string;
  cliRuntimePath: string;
}

interface FakeShellEnvSpawn {
  calls: SpawnUserShellEnvArgs[];
  spawn: SpawnUserShellEnv;
}

interface CreateShellEnvSpawnResultArgs {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  stderr?: string;
  stdout?: string;
}

interface CreateFakeShellEnvSpawnArgs {
  results: UserShellEnvSpawnResult[];
}

async function withPlatform<T>(
  platform: NodeJS.Platform,
  action: () => Promise<T>,
): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  if (!originalDescriptor) {
    throw new Error("Expected process.platform descriptor");
  }

  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });

  try {
    return await action();
  } finally {
    Object.defineProperty(process, "platform", originalDescriptor);
  }
}

async function createFakeCliPackage(
  options: FakeCliPackageOptions = {},
): Promise<FakeCliPackage> {
  const cliPackageRoot = await makeTempDir("bb-cli-package-");
  const executablePath = options.executablePath ?? "./dist/bin/bb";
  const cliEntryPath = path.resolve(cliPackageRoot, executablePath);
  const cliRuntimePath = path.resolve(cliPackageRoot, "dist/index.js");

  if (options.writeEntry ?? true) {
    await fs.mkdir(path.dirname(cliEntryPath), { recursive: true });
    await fs.writeFile(
      cliEntryPath,
      "#!/usr/bin/env node\nprocess.stdout.write('bb')\n",
      { mode: options.executable ? 0o755 : 0o644 },
    );
    await fs.chmod(cliEntryPath, options.executable ? 0o755 : 0o644);
  }

  if (options.writeRuntime) {
    await fs.mkdir(path.dirname(cliRuntimePath), { recursive: true });
    await fs.writeFile(cliRuntimePath, "process.stdout.write('bb')\n", "utf8");
  }

  return {
    cliEntryPath,
    cliRuntimePath,
  };
}

function createShellEnvSpawnResult(
  args: CreateShellEnvSpawnResultArgs,
): UserShellEnvSpawnResult {
  return {
    ...(args.error === undefined ? {} : { error: args.error }),
    signal: args.signal ?? null,
    status: args.status ?? 0,
    stderr: args.stderr ?? "",
    stdout: args.stdout ?? "",
  };
}

function createMarkedShellEnvOutput(pathValue: string): string {
  return [
    "shell startup noise",
    "__BB_SHELL_ENV_START__",
    "USER=test-user",
    `PATH=${pathValue}`,
    "__BB_SHELL_ENV_END__",
    "shell shutdown noise",
  ].join("\n");
}

const WINDOWS_MACHINE_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const WINDOWS_USER_KEY = "HKCU\\Environment";

const windowsProbeEnv: NodeJS.ProcessEnv = {
  Path: "C:\\Windows\\System32;C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  SystemRoot: "C:\\Windows",
  USERPROFILE: "C:\\Users\\me",
};

function createRegistryQueryOutput(
  key: string,
  type: "REG_SZ" | "REG_EXPAND_SZ",
  value: string,
): string {
  return ["", key, `    Path    ${type}    ${value}`, "", ""].join("\r\n");
}

function createWindowsProbeBlock(entries: [string, string][]): string[] {
  return [
    "__BB_SHELL_ENV_START__",
    ...entries.map(
      ([name, value]) =>
        `${name}=${Buffer.from(value, "utf8").toString("base64")}`,
    ),
    "__BB_SHELL_ENV_END__",
  ];
}

function createFakeRegistryCommand(
  respond: (args: SpawnUserShellEnvArgs) => UserShellEnvSpawnResult,
): FakeShellEnvSpawn {
  const calls: SpawnUserShellEnvArgs[] = [];
  return {
    calls,
    async spawn(spawnArgs) {
      calls.push(spawnArgs);
      return respond(spawnArgs);
    },
  };
}

function createFakeShellEnvSpawn(
  args: CreateFakeShellEnvSpawnArgs,
): FakeShellEnvSpawn {
  const calls: SpawnUserShellEnvArgs[] = [];
  const results = [...args.results];
  return {
    calls,
    async spawn(spawnArgs) {
      calls.push(spawnArgs);
      const result = results.shift();
      if (!result) {
        throw new Error("Unexpected shell env spawn");
      }
      return result;
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directoryPath) =>
        fs.rm(directoryPath, { recursive: true, force: true }),
      ),
  );
});

describe("resolveLocalBbExecutablePath", () => {
  it("returns the built CLI executable path", async () => {
    const { cliEntryPath, cliRuntimePath } = await createFakeCliPackage({
      executable: true,
      writeRuntime: true,
    });

    await expect(
      resolveLocalBbExecutablePath({
        cliExecutablePath: cliEntryPath,
        cliRuntimePath,
      }),
    ).resolves.toBe(cliEntryPath);
  });

  it("fails before startup when the source CLI runtime is unbuilt", async () => {
    const { cliEntryPath, cliRuntimePath } = await createFakeCliPackage({
      executable: true,
    });

    await expect(
      resolveLocalBbExecutablePath({
        cliExecutablePath: cliEntryPath,
        cliRuntimePath,
      }),
    ).rejects.toThrow(
      `Missing built bb CLI runtime at ${cliRuntimePath}. Build @bb/cli before starting the host daemon.`,
    );
  });

  it("fails clearly when the built CLI entry is missing", async () => {
    const { cliEntryPath } = await createFakeCliPackage({
      writeEntry: false,
    });

    await expect(
      resolveLocalBbExecutablePath({
        cliExecutablePath: cliEntryPath,
      }),
    ).rejects.toThrow(
      `Missing built bb CLI entry at ${cliEntryPath}. Build @bb/cli before starting the host daemon.`,
    );
  });

  it("fails clearly when the built CLI entry is not executable", async () => {
    const { cliEntryPath } = await createFakeCliPackage({
      executable: false,
    });

    await expect(
      resolveLocalBbExecutablePath({
        cliExecutablePath: cliEntryPath,
      }),
    ).rejects.toThrow(
      `Resolved bb CLI entry is not executable: ${cliEntryPath}. Build @bb/cli before starting the host daemon.`,
    );
  });

  it("skips the execute-bit check on win32", async () => {
    const { cliEntryPath } = await createFakeCliPackage({
      executable: false,
    });

    await expect(
      withPlatform("win32", () =>
        resolveLocalBbExecutablePath({
          cliExecutablePath: cliEntryPath,
        }),
      ),
    ).resolves.toBe(cliEntryPath);
  });
});

describe("resolveUserShellPath", () => {
  it("settles when the shell env probe times out even if the shell ignores SIGTERM", async () => {
    const shellDir = await makeTempDir("bb-shell-timeout-");
    const shellPath = path.join(shellDir, "ignore-term-shell");
    await fs.writeFile(
      shellPath,
      [
        "#!/usr/bin/env node",
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await fs.chmod(shellPath, 0o755);

    const startedAt = Date.now();

    await expect(
      resolveUserShellPath({
        env: { SHELL: shellPath, PATH: "/usr/bin" },
        platform: "linux",
        timeoutMs: 25,
      }),
    ).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("loads PATH from the configured interactive login shell", async () => {
    const shellPath = "/root/.local/bin:/usr/local/bin:/usr/bin";
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createMarkedShellEnvOutput(shellPath),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: { SHELL: "/usr/bin/bash", PATH: "/usr/bin" },
        platform: "linux",
        spawnUserShellEnv: fakeSpawn.spawn,
        timeoutMs: 1234,
      }),
    ).resolves.toBe(shellPath);

    expect(fakeSpawn.calls).toEqual([
      {
        command: "/usr/bin/bash",
        args: [
          "-ilc",
          "printf '%s\\n' __BB_SHELL_ENV_START__; env; printf '%s\\n' __BB_SHELL_ENV_END__",
        ],
        env: { SHELL: "/usr/bin/bash", PATH: "/usr/bin" },
        timeoutMs: 1234,
      },
    ]);
  });

  it("falls back to a non-interactive login shell when the interactive probe fails", async () => {
    const shellPath = "/home/me/.local/bin:/usr/bin";
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          status: 1,
          stderr: "interactive shell failed",
        }),
        createShellEnvSpawnResult({
          stdout: createMarkedShellEnvOutput(shellPath),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
        platform: "linux",
        spawnUserShellEnv: fakeSpawn.spawn,
      }),
    ).resolves.toBe(shellPath);

    expect(fakeSpawn.calls.map((call) => call.args[0])).toEqual([
      "-ilc",
      "-lc",
    ]);
  });

  it("retains the previous PATH when a refreshed interactive probe fails", async () => {
    const interactivePath = "/home/me/.local/bin:/usr/bin";
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createMarkedShellEnvOutput(interactivePath),
        }),
        createShellEnvSpawnResult({
          status: 1,
          stderr: "interactive shell failed",
        }),
      ],
    });

    const resolvePath = createUserShellPathResolver({
      env: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
      platform: "linux",
      spawnUserShellEnv: fakeSpawn.spawn,
    });

    await expect(resolvePath()).resolves.toBe(interactivePath);
    await expect(resolvePath()).resolves.toBe(interactivePath);

    expect(fakeSpawn.calls.map((call) => call.args[0])).toEqual([
      "-ilc",
      "-ilc",
    ]);
  });

  it("uses plain login mode for sh-compatible fallback shells", async () => {
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createMarkedShellEnvOutput("/usr/bin:/bin"),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: { PATH: "/usr/bin" },
        platform: "linux",
        spawnUserShellEnv: fakeSpawn.spawn,
      }),
    ).resolves.toBe("/usr/bin:/bin");

    expect(fakeSpawn.calls[0]?.command).toBe("/bin/sh");
    expect(fakeSpawn.calls[0]?.args[0]).toBe("-lc");
  });

  it("uses zsh as the macOS fallback shell when SHELL is unset", async () => {
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createMarkedShellEnvOutput("/opt/homebrew/bin:/usr/bin"),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: { PATH: "/usr/bin" },
        platform: "darwin",
        spawnUserShellEnv: fakeSpawn.spawn,
      }),
    ).resolves.toBe("/opt/homebrew/bin:/usr/bin");

    expect(fakeSpawn.calls[0]?.command).toBe("/bin/zsh");
    expect(fakeSpawn.calls[0]?.args[0]).toBe("-ilc");
  });
});

describe("prepareRuntimeShellEnv", () => {
  it("uses the daemon proxy URL without exporting its machine credential", () => {
    vi.stubEnv("BB_CONNECT_MACHINE_CREDENTIAL", "bbcm_durable_secret");

    const env = prepareRuntimeShellEnv({
      bbExecutableDirectory: "/tmp/bb-bin",
      inheritedPath: "/usr/bin",
      serverUrl: "http://127.0.0.1:43123",
    });

    expect(env.BB_SERVER_URL).toBe("http://127.0.0.1:43123");
    expect(env).not.toHaveProperty("BB_CONNECT_MACHINE_CREDENTIAL");
  });

  it("prepends the configured bb executable directory to PATH and sets BB_CLI", () => {
    expect(
      prepareRuntimeShellEnv({
        bbExecutableDirectory: "/tmp/bb-bin",
        hostDaemonPort: 3002,
        inheritedPath: "/usr/bin",
        platform: "linux",
        serverUrl: "http://127.0.0.1:3334",
      }),
    ).toEqual({
      PATH: `/tmp/bb-bin${delimiter}/usr/bin`,
      BB_CLI: path.resolve("/tmp/bb-bin", "bb"),
      BB_SERVER_URL: "http://127.0.0.1:3334",
      BB_HOST_DAEMON_PORT: "3002",
    });
  });

  it("uses an explicit bbExecutablePath for BB_CLI", () => {
    expect(
      prepareRuntimeShellEnv({
        bbExecutableDirectory: "/tmp/bb-bin",
        bbExecutablePath: "/opt/custom/bb",
        inheritedPath: "/usr/bin",
        serverUrl: "http://127.0.0.1:3334",
      }),
    ).toMatchObject({
      BB_CLI: "/opt/custom/bb",
      PATH: `/tmp/bb-bin${delimiter}/usr/bin`,
    });
  });

  it("falls back to process.env.PATH when inheritedPath is omitted", () => {
    vi.stubEnv("PATH", "/usr/local/bin:/usr/bin");

    expect(
      prepareRuntimeShellEnv({
        bbExecutableDirectory: "/tmp/bb-bin",
        hostDaemonPort: 3002,
        platform: "linux",
        serverUrl: "http://127.0.0.1:3334",
      }),
    ).toEqual({
      PATH: `/tmp/bb-bin${delimiter}/usr/local/bin:/usr/bin`,
      BB_CLI: path.resolve("/tmp/bb-bin", "bb"),
      BB_SERVER_URL: "http://127.0.0.1:3334",
      BB_HOST_DAEMON_PORT: "3002",
    });
  });

  it("omits the host daemon port when the local API is disabled", () => {
    expect(
      prepareRuntimeShellEnv({
        bbExecutableDirectory: "/tmp/bb-bin",
        inheritedPath: "/usr/bin",
        platform: "linux",
        serverUrl: "http://127.0.0.1:3334",
      }),
    ).toEqual({
      PATH: `/tmp/bb-bin${delimiter}/usr/bin`,
      BB_CLI: path.resolve("/tmp/bb-bin", "bb"),
      BB_SERVER_URL: "http://127.0.0.1:3334",
    });
  });
});

describe("readWindowsRegistryPath", () => {
  it("joins the machine and user values and expands %VAR% references", async () => {
    const registry = createFakeRegistryCommand((args) =>
      createShellEnvSpawnResult({
        stdout:
          args.args[1] === WINDOWS_USER_KEY
            ? createRegistryQueryOutput(
                WINDOWS_USER_KEY,
                "REG_EXPAND_SZ",
                "%USERPROFILE%\\bin;;%NOT_SET%\\x",
              )
            : createRegistryQueryOutput(
                WINDOWS_MACHINE_KEY,
                "REG_SZ",
                "C:\\Windows\\System32;C:\\Windows",
              ),
      }),
    );

    await expect(
      readWindowsRegistryPath({
        env: windowsProbeEnv,
        runCommand: registry.spawn,
      }),
    ).resolves.toBe(
      "C:\\Windows\\System32;C:\\Windows;C:\\Users\\me\\bin;%NOT_SET%\\x",
    );
    expect(registry.calls.map((call) => call.args)).toEqual([
      ["query", WINDOWS_MACHINE_KEY, "/v", "Path"],
      ["query", WINDOWS_USER_KEY, "/v", "Path"],
    ]);
    expect(registry.calls[0]?.command).toBe("C:\\Windows\\System32\\reg.exe");
  });

  it("keeps the machine value when the user value is missing", async () => {
    const registry = createFakeRegistryCommand((args) =>
      args.args[1] === WINDOWS_USER_KEY
        ? createShellEnvSpawnResult({
            status: 1,
            stderr:
              "ERROR: The system was unable to find the specified registry key or value.",
          })
        : createShellEnvSpawnResult({
            stdout: createRegistryQueryOutput(
              WINDOWS_MACHINE_KEY,
              "REG_SZ",
              "C:\\Windows\\System32",
            ),
          }),
    );

    await expect(
      readWindowsRegistryPath({
        env: windowsProbeEnv,
        runCommand: registry.spawn,
      }),
    ).resolves.toBe("C:\\Windows\\System32");
  });

  it("returns null when neither key yields a Path row", async () => {
    const registry = createFakeRegistryCommand(() =>
      createShellEnvSpawnResult({
        stdout: [
          "",
          WINDOWS_USER_KEY,
          "    TEMP    REG_SZ    C:\\Temp",
          "",
        ].join("\r\n"),
      }),
    );

    await expect(
      readWindowsRegistryPath({
        env: windowsProbeEnv,
        runCommand: registry.spawn,
      }),
    ).resolves.toBeNull();
  });

  it("keeps a literal %VAR% reference in a REG_SZ value", async () => {
    const registry = createFakeRegistryCommand((args) =>
      args.args[1] === WINDOWS_USER_KEY
        ? createShellEnvSpawnResult({ status: 1 })
        : createShellEnvSpawnResult({
            stdout: createRegistryQueryOutput(
              WINDOWS_MACHINE_KEY,
              "REG_SZ",
              "%USERPROFILE%\\bin;C:\\Windows",
            ),
          }),
    );

    await expect(
      readWindowsRegistryPath({
        env: windowsProbeEnv,
        runCommand: registry.spawn,
      }),
    ).resolves.toBe("%USERPROFILE%\\bin;C:\\Windows");
  });

  it("strips surrounding quotes from registry entries", async () => {
    const registry = createFakeRegistryCommand((args) =>
      args.args[1] === WINDOWS_USER_KEY
        ? createShellEnvSpawnResult({ status: 1 })
        : createShellEnvSpawnResult({
            stdout: createRegistryQueryOutput(
              WINDOWS_MACHINE_KEY,
              "REG_SZ",
              '"C:\\Program Files\\Foo";C:\\Windows',
            ),
          }),
    );

    await expect(
      readWindowsRegistryPath({
        env: windowsProbeEnv,
        runCommand: registry.spawn,
      }),
    ).resolves.toBe("C:\\Program Files\\Foo;C:\\Windows");
  });

  it("expands a lowercase %var% reference case-insensitively", async () => {
    const registry = createFakeRegistryCommand((args) =>
      args.args[1] === WINDOWS_USER_KEY
        ? createShellEnvSpawnResult({ status: 1 })
        : createShellEnvSpawnResult({
            stdout: createRegistryQueryOutput(
              WINDOWS_MACHINE_KEY,
              "REG_EXPAND_SZ",
              "%userprofile%\\bin",
            ),
          }),
    );

    await expect(
      readWindowsRegistryPath({
        env: windowsProbeEnv,
        runCommand: registry.spawn,
      }),
    ).resolves.toBe("C:\\Users\\me\\bin");
  });

  it.runIf(process.platform === "win32")(
    "reads the real machine and user PATH from the registry",
    async () => {
      const registryPath = await readWindowsRegistryPath({ env: process.env });
      expect(registryPath).not.toBeNull();
      expect(registryPath?.toLowerCase()).toContain("system32");
    },
  );
});

describe("resolveUserShellPath on Windows", () => {
  function registryAlways(value: string): FakeShellEnvSpawn {
    return createFakeRegistryCommand((args) =>
      args.args[1] === WINDOWS_USER_KEY
        ? createShellEnvSpawnResult({ status: 1 })
        : createShellEnvSpawnResult({
            stdout: createRegistryQueryOutput(
              WINDOWS_MACHINE_KEY,
              "REG_SZ",
              value,
            ),
          }),
    );
  }

  it("prefers the PowerShell profile probe over the registry", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createWindowsProbeBlock([
            ["USERNAME", "me"],
            ["Path", "C:\\profile\\bin;C:\\Windows"],
          ]).join("\r\n"),
        }),
      ],
    });
    const registry = registryAlways("C:\\registry\\bin");

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registry.spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\profile\\bin;C:\\Windows");

    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.command.toLowerCase()).toMatch(
      /(pwsh|powershell)\.exe$/u,
    );
    expect(probe.calls[0]?.args[0]).toBe("-NoLogo");
    expect(probe.calls[0]?.args[1]).toBe("-Command");
    expect(probe.calls[0]?.args[2]).toContain("Get-ChildItem Env:");
    expect(probe.calls[0]?.timeoutMs).toBe(8_000);
  });

  it("ignores a hostile profile that prints a fake marker pair first", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: [
            ...createWindowsProbeBlock([["Path", "C:\\evil"]]),
            "profile noise",
            ...createWindowsProbeBlock([["Path", "C:\\real\\bin"]]),
          ].join("\r\n"),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\real\\bin");
  });

  it("skips a corrupt base64 Path line and keeps scanning", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: [
            "__BB_SHELL_ENV_START__",
            "Path=**not base64**",
            `PATH=${Buffer.from("C:\\second\\bin", "utf8").toString("base64")}`,
            "__BB_SHELL_ENV_END__",
          ].join("\r\n"),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\second\\bin");
  });

  it("falls back to the registry when the probe fails", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({ status: 1, stderr: "profile exploded" }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\registry\\bin");
  });

  it("falls back to the inherited Path when the probe and the registry fail", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [createShellEnvSpawnResult({ status: 1 })],
    });
    const registry = createFakeRegistryCommand(() =>
      createShellEnvSpawnResult({ status: 1 }),
    );

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registry.spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\Windows\\System32;C:\\Windows");
  });

  it("ignores SHELL on Windows", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createWindowsProbeBlock([["Path", "C:\\profile\\bin"]]).join(
            "\r\n",
          ),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: {
          ...windowsProbeEnv,
          SHELL: "C:\\Program Files\\Git\\bin\\bash.exe",
        },
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\profile\\bin");
    expect(probe.calls[0]?.args[0]).toBe("-NoLogo");
  });

  it("probes with the freshly read registry PATH under a single Path key", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createWindowsProbeBlock([
            ["Path", "C:\\registry\\bin;C:\\profile\\bin"],
          ]).join("\r\n"),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: { ...windowsProbeEnv, PATH: "C:\\stale" },
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\registry\\bin;C:\\profile\\bin");

    const probeEnv = probe.calls[0]?.env ?? {};
    expect(probeEnv.Path).toBe("C:\\registry\\bin");
    expect(
      Object.keys(probeEnv).filter((key) => key.toLowerCase() === "path"),
    ).toEqual(["Path"]);
    expect(probeEnv.USERPROFILE).toBe("C:\\Users\\me");
  });

  it("falls back to the registry when the probe times out", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          error: new Error("Shell env probe timed out after 8000ms"),
          status: null,
          stdout: [
            "__BB_SHELL_ENV_START__",
            `Path=${Buffer.from("C:\\partial\\bin", "utf8").toString("base64")}`,
            "__BB_SHELL_ENV_END__",
          ].join("\r\n"),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\registry\\bin");
  });

  it("falls back to the registry when the probe block has no end marker", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: [
            "__BB_SHELL_ENV_START__",
            `Path=${Buffer.from("C:\\truncated\\bin", "utf8").toString("base64")}`,
          ].join("\r\n"),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\registry\\bin");
  });

  it("falls back to the registry when the encoded Path length is truncated", async () => {
    const encoded = Buffer.from("C:\\truncated\\bin", "utf8").toString(
      "base64",
    );
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: [
            "__BB_SHELL_ENV_START__",
            `Path=${encoded.slice(0, encoded.length - 1)}`,
            "__BB_SHELL_ENV_END__",
          ].join("\r\n"),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\registry\\bin");
  });

  it("keeps the previous PATH when the probe and the registry both fail", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createWindowsProbeBlock([["Path", "C:\\profile\\bin"]]).join(
            "\r\n",
          ),
        }),
        createShellEnvSpawnResult({ status: 1 }),
      ],
    });
    const registry = createFakeRegistryCommand(() =>
      createShellEnvSpawnResult({ status: 1 }),
    );

    const resolvePath = createUserShellPathResolver({
      env: windowsProbeEnv,
      platform: "win32",
      runCommand: registry.spawn,
      spawnUserShellEnv: probe.spawn,
    });

    await expect(resolvePath()).resolves.toBe("C:\\profile\\bin");
    await expect(resolvePath()).resolves.toBe("C:\\profile\\bin");
  });

  it("points BB_CLI at bb.cmd on win32", () => {
    expect(resolveBbExecutablePathInDirectory("/tmp/bb-bin", "win32")).toBe(
      path.resolve("/tmp/bb-bin", "bb.cmd"),
    );
    expect(resolveBbExecutablePathInDirectory("/tmp/bb-bin", "linux")).toBe(
      path.resolve("/tmp/bb-bin", "bb"),
    );
    expect(
      prepareRuntimeShellEnv({
        bbExecutableDirectory: "/tmp/bb-bin",
        inheritedPath: "C:\\Windows",
        platform: "win32",
        serverUrl: "http://127.0.0.1:3334",
      }).BB_CLI,
    ).toBe(path.resolve("/tmp/bb-bin", "bb.cmd"));
  });
});
