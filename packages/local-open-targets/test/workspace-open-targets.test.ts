import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  queryWindowsProcess,
  resolveExecutable,
  resolvePowerShellExecutable,
  resolveWindowsSystemToolPath,
  takeWindowsProcessSnapshot,
  type WindowsProcessSnapshotEntry,
} from "@bb/process-utils";
import {
  createWorkspaceOpenTargetRuntime,
  listWorkspaceOpenTargets,
  listWorkspaceOpenTargetsWithRuntime,
  openPathInTargetWithRuntime,
  type WorkspaceOpenTargetRuntime,
} from "../src/index.js";
import { LAUNCH_ADAPTERS } from "../src/macos-launch-adapters.js";
import type { ExecFileOptions } from "../src/types.js";

describe("default workspace open-target runtime", () => {
  it("exposes the resolved shell PATH without changing system-tool launches", async () => {
    const runtime = createWorkspaceOpenTargetRuntime({
      shellPath: "/Users/test/.local/bin:/usr/bin",
      platform: "linux",
    });

    expect(runtime.env?.PATH).toBe("/Users/test/.local/bin:/usr/bin");
    const inheritedResult = await runtime.execFile(process.execPath, [
      "-e",
      "process.stdout.write(process.env.PATH ?? '')",
    ]);
    expect(inheritedResult.stdout).toBe(process.env.PATH ?? "");

    const userExecutableResult = await runtime.execFile(
      process.execPath,
      ["-e", "process.stdout.write(process.env.PATH ?? '')"],
      { env: runtime.env },
    );
    expect(userExecutableResult.stdout).toBe("/Users/test/.local/bin:/usr/bin");
  });

  it("builds a single Path key for the shell PATH on Windows", () => {
    const runtime = createWorkspaceOpenTargetRuntime({
      shellPath: "C:\\Users\\test\\bin;C:\\Windows\\System32",
      platform: "win32",
    });

    expect(
      Object.keys(runtime.env ?? {}).filter((key) => /^path$/iu.test(key)),
    ).toEqual(["Path"]);
    expect(runtime.env?.Path).toBe(
      "C:\\Users\\test\\bin;C:\\Windows\\System32",
    );
  });
});

type ExecFileHandler = WorkspaceOpenTargetRuntime["execFile"];

interface ExecFileCall {
  args: string[];
  env?: NodeJS.ProcessEnv;
  file: string;
}

interface AvailableMacApplication {
  appPath: string;
  bundleId: string;
  displayName?: string;
}

interface CreateAvailableExecFileArgs {
  availableMacApplications?: AvailableMacApplication[];
  availableBundleIdSubstrings?: string[];
  availableExecutables?: string[];
  calls?: ExecFileCall[];
  fileAssociatedMacApplications?: AvailableMacApplication[];
}

interface CreateRuntimeArgs {
  applicationDirectories?: string[];
  desktopFileDirectories?: string[];
  env?: NodeJS.ProcessEnv;
  execFile?: ExecFileHandler;
  platform?: NodeJS.Platform;
}

function createRuntime(
  args: CreateRuntimeArgs = {},
): WorkspaceOpenTargetRuntime {
  return {
    applicationDirectories: args.applicationDirectories ?? [],
    desktopFileDirectories: args.desktopFileDirectories ?? [],
    execFile:
      args.execFile ??
      (async (file) => {
        if (file === "which") {
          throw new Error("Executable not found");
        }
        return { stdout: "" };
      }),
    env: args.env,
    platform: args.platform ?? "darwin",
  };
}

function createAvailableExecFile(
  args: CreateAvailableExecFileArgs = {},
): ExecFileHandler {
  const availableBundleIdSubstrings = args.availableBundleIdSubstrings ?? [];
  const availableMacApplications: AvailableMacApplication[] = [
    ...(args.availableMacApplications ?? []),
    ...availableBundleIdSubstrings.map((bundleId) => ({
      appPath: `/Applications/${bundleId}.app`,
      bundleId,
    })),
  ];
  const availableExecutables = args.availableExecutables ?? [];
  const fileAssociatedMacApplications =
    args.fileAssociatedMacApplications ?? [];

  return async (file, commandArgs, options) => {
    const call: ExecFileCall = { file, args: commandArgs };
    if (options?.env !== undefined) {
      call.env = options.env;
    }
    args.calls?.push(call);

    if (file === "mdfind") {
      if (commandArgs.join(" ").includes("kMDItemContentType")) {
        return {
          stdout: `${availableMacApplications
            .map((application) => application.appPath)
            .join("\n")}\n`,
        };
      }
      return {
        stdout:
          availableMacApplications
            .filter((application) =>
              commandArgs.join(" ").includes(application.bundleId),
            )
            .map((application) => application.appPath)
            .join("\n") || "",
      };
    }

    if (file === "plutil") {
      const key = commandArgs[1];
      const plistPath = commandArgs.at(-1) ?? "";
      const application = availableMacApplications.find((candidate) =>
        plistPath.startsWith(path.join(candidate.appPath, "Contents")),
      );
      if (!application) {
        return { stdout: "" };
      }
      if (key === "CFBundleIdentifier") {
        return { stdout: `${application.bundleId}\n` };
      }
      if (key === "CFBundleDisplayName" || key === "CFBundleName") {
        return {
          stdout: `${application.displayName ?? path.basename(application.appPath, ".app")}\n`,
        };
      }
      return { stdout: "" };
    }

    if (file === "osascript" && commandArgs.includes("JavaScript")) {
      return {
        stdout: JSON.stringify(
          fileAssociatedMacApplications.map((application) => ({
            appPath: application.appPath,
            bundleId: application.bundleId,
          })),
        ),
      };
    }

    if (file === "which") {
      const executable = commandArgs[0];
      if (executable && availableExecutables.includes(executable)) {
        return {
          stdout: `/usr/local/bin/${executable}\n`,
        };
      }
      throw new Error("Executable not found");
    }

    return { stdout: "" };
  };
}

describe("workspace open targets", () => {
  it("returns no targets on unsupported platforms without probing apps", async () => {
    const execFile = vi.fn(async () => ({ stdout: "" }));

    await expect(
      listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          execFile,
          platform: "freebsd",
        }),
      ),
    ).resolves.toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("discovers Linux platform targets and editor CLIs from PATH", async () => {
    const targets = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile({
          availableExecutables: ["code", "xdg-open", "x-terminal-emulator"],
        }),
        platform: "linux",
      }),
    );

    expect(targets.map((target) => target.id)).toEqual([
      "vscode",
      "default-app",
      "file-manager",
      "terminal",
    ]);
    expect(targets.find((target) => target.id === "vscode")).toMatchObject({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: true,
        openFileAtLine: true,
      },
      kind: "editor",
      label: "VS Code",
    });
    expect(
      targets.find((target) => target.id === "file-manager"),
    ).toMatchObject({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: false,
        openFileAtLine: false,
      },
      kind: "file-manager",
      label: "File Manager",
    });
  });

  it("discovers Linux desktop apps outside app-specific adapters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-desktop-apps-"));
    const desktopDirectory = path.join(root, "applications");
    await mkdir(desktopDirectory, { recursive: true });
    await writeFile(
      path.join(desktopDirectory, "mockedit.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Mock Edit",
        "Categories=Utility;TextEditor;",
        "Exec=mockedit --open %f",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(desktopDirectory, "hidden.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Hidden App",
        "NoDisplay=true",
        "Categories=TextEditor;",
        "Exec=hidden %f",
        "",
      ].join("\n"),
    );
    await Promise.all(
      [
        ["files", "Files", "FileManager"],
        ["terminal", "Terminal", "TerminalEmulator"],
      ].map(async ([id, name, category]) =>
        writeFile(
          path.join(desktopDirectory, `${id}.desktop`),
          [
            "[Desktop Entry]",
            "Type=Application",
            `Name=${name}`,
            `Categories=System;${category};`,
            `Exec=${id} %f`,
            "",
          ].join("\n"),
        ),
      ),
    );
    await writeFile(
      path.join(desktopDirectory, "unrelated.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Music Player",
        "Categories=AudioVideo;Player;",
        "MimeType=audio/mpeg;inode/directory;",
        "Exec=music-player %f",
        "",
      ].join("\n"),
    );

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          desktopFileDirectories: [desktopDirectory],
          platform: "linux",
        }),
      );

      expect(targets).toEqual(
        [
          ["desktop-app:files", "Files"],
          ["desktop-app:mockedit", "Mock Edit"],
          ["desktop-app:terminal", "Terminal"],
        ].map(([id, label]) => ({
          capabilities: {
            openDirectory: true,
            openFile: true,
            openFileAtColumn: false,
            openFileAtLine: false,
          },
          icon: { kind: "symbol", name: "app" },
          id,
          kind: "native-app",
          label,
        })),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers WSL default app and file manager integrations", async () => {
    const targets = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        execFile: createAvailableExecFile({
          availableExecutables: ["explorer.exe", "wslview"],
        }),
        platform: "linux",
      }),
    );

    expect(targets.map((target) => target.id)).toEqual([
      "default-app",
      "file-manager",
    ]);
    expect(targets.find((target) => target.id === "default-app")).toMatchObject(
      {
        label: "Default App",
        kind: "default-app",
      },
    );
    expect(
      targets.find((target) => target.id === "file-manager"),
    ).toMatchObject({
      label: "File Manager",
      kind: "file-manager",
    });
  });

  it("lists Windows platform targets without POSIX editor paths", async () => {
    const execFile = vi.fn<ExecFileHandler>(async () => ({ stdout: "" }));

    const targets = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        env: {},
        execFile,
        platform: "win32",
      }),
    );

    expect(targets.map((target) => target.id)).toEqual([
      "default-app",
      "file-manager",
      "terminal",
    ]);
    expect(
      execFile.mock.calls.some((call) =>
        call[0].toLowerCase().endsWith("reg.exe"),
      ),
    ).toBe(true);
    expect(execFile.mock.calls.some((call) => call[0] === "which")).toBe(false);
    expect(execFile.mock.calls.some((call) => call[0] === "where")).toBe(false);
  });

  it("opens WSL paths with the configured default app bridge", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["wslview"],
      calls,
    });

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "default-app",
        },
        createRuntime({
          env: { WSL_DISTRO_NAME: "Ubuntu" },
          execFile,
          platform: "linux",
        }),
      );

      expect(calls.find((call) => call.file === "wslview")).toEqual({
        file: "wslview",
        args: [filePath],
        env: { WSL_DISTRO_NAME: "Ubuntu" },
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens WSL paths with the file manager bridge through the Linux runtime", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["explorer.exe"],
      calls,
    });

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "file-manager",
        },
        createRuntime({
          env: { WSL_DISTRO_NAME: "Ubuntu" },
          execFile,
          platform: "linux",
        }),
      );

      expect(calls.find((call) => call.file === "explorer.exe")).toEqual({
        file: "explorer.exe",
        args: [path.dirname(filePath)],
        env: { WSL_DISTRO_NAME: "Ubuntu" },
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("rejects unsupported non-Linux open requests", async () => {
    await expect(
      openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: "/tmp/workspace",
          targetId: "default-app",
        },
        createRuntime({ platform: "freebsd" }),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_platform",
    });
  });

  it("opens Linux files with discovered editor CLIs", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["code"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "vscode",
        },
        createRuntime({
          env: { PATH: "/Users/test/.local/bin:/usr/bin" },
          execFile,
          platform: "linux",
        }),
      );

      expect(calls.find((call) => call.file === "code")).toEqual({
        file: "code",
        args: ["-g", `${filePath}:15:6`],
        env: { PATH: "/Users/test/.local/bin:/usr/bin" },
      });
      expect(
        calls.find((call) => call.file === "which" && call.args[0] === "code")
          ?.env,
      ).toEqual({ PATH: "/Users/test/.local/bin:/usr/bin" });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens Linux desktop app targets from desktop Exec entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-desktop-open-"));
    const desktopDirectory = path.join(root, "applications");
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(desktopDirectory, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(filePath, "# Notes\n");
      await writeFile(
        path.join(desktopDirectory, "mockedit.desktop"),
        [
          "[Desktop Entry]",
          "Type=Application",
          "Name=Mock Edit",
          "Categories=TextEditor;",
          "Exec=mockedit --open %f",
          "",
        ].join("\n"),
      );

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "desktop-app:mockedit",
        },
        createRuntime({
          desktopFileDirectories: [desktopDirectory],
          execFile,
          platform: "linux",
        }),
      );

      expect(calls.find((call) => call.file === "mockedit")).toEqual({
        file: "mockedit",
        args: ["--open", filePath],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("opens Linux paths with the platform default app", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["xdg-open"],
      calls,
    });

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "default-app",
        },
        createRuntime({ execFile, platform: "linux" }),
      );

      expect(calls.find((call) => call.file === "xdg-open")).toEqual({
        file: "xdg-open",
        args: [filePath],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens remote SSH paths in a Linux terminal", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["ssh", "x-terminal-emulator"],
      calls,
    });

    await openPathInTargetWithRuntime(
      {
        context: {
          kind: "remote-ssh",
          sshAuthority: "devbox",
        },
        columnNumber: 8,
        lineNumber: 42,
        path: "/home/me/project/src/file.ts",
        targetId: "terminal",
      },
      createRuntime({ execFile, platform: "linux" }),
    );

    const terminalCall = calls.find(
      (call) => call.file === "x-terminal-emulator",
    );
    expect(terminalCall).toBeDefined();
    expect(terminalCall?.args.slice(0, 5)).toEqual([
      "-e",
      "ssh",
      "-t",
      "--",
      "devbox",
    ]);
    expect(terminalCall?.args.at(-1)).toContain("/home/me/project/src/file.ts");
    expect(terminalCall?.args.at(-1)).toContain("42");
    expect(terminalCall?.args.at(-1)).toContain("8");
  });

  it("discovers built-in targets and bundle-id matches", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["dev.zed.Zed"],
      calls,
    });

    const targets = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile,
      }),
    );

    expect(targets.map((target) => target.id)).toEqual([
      "zed",
      "finder",
      "terminal",
      "default-app",
    ]);
    expect(targets.find((target) => target.id === "default-app")).toEqual({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: false,
        openFileAtLine: false,
      },
      icon: { kind: "symbol", name: "default-app" },
      id: "default-app",
      kind: "default-app",
      label: "Default App",
    });
    expect(targets.find((target) => target.id === "terminal")).toMatchObject({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: true,
        openFileAtLine: true,
      },
      id: "terminal",
      label: "Terminal",
    });
    expect(targets.find((target) => target.id === "finder")).toMatchObject({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: false,
        openFileAtLine: false,
      },
      id: "finder",
      label: "Finder",
    });
    expect(
      calls.some((call) => call.args.join(" ").includes("com.apple.finder")),
    ).toBe(false);
    expect(
      calls.some((call) => call.args.join(" ").includes("com.apple.Terminal")),
    ).toBe(false);
  });

  it("opens paths with the macOS default app", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 3,
          lineNumber: 12,
          path: filePath,
          targetId: "default-app",
        },
        createRuntime({
          env: { PATH: "/Users/test/.local/bin:/usr/bin" },
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["--", filePath],
      });
      expect(calls.some((call) => call.file === "which")).toBe(false);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("reveals files in Finder", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["open"],
      calls,
    });

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "finder",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-R", filePath],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens BBEdit and Emacs through macOS application open instead of editor CLIs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const applicationsDirectory = path.join(root, "Applications");
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(path.join(applicationsDirectory, "BBEdit.app"), {
        recursive: true,
      });
      await mkdir(path.join(applicationsDirectory, "Emacs.app"), {
        recursive: true,
      });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(filePath, "# Notes\n");

      for (const target of [
        { appName: "BBEdit", cli: "bbedit", targetId: "bbedit" },
        { appName: "Emacs", cli: "emacsclient", targetId: "emacs" },
      ]) {
        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: 6,
            lineNumber: 15,
            path: filePath,
            targetId: target.targetId,
          },
          createRuntime({
            applicationDirectories: [applicationsDirectory],
            execFile,
          }),
        );

        expect(calls.some((call) => call.file === target.cli)).toBe(false);
        expect(
          calls.find(
            (call) => call.file === "open" && call.args[1] === target.appName,
          ),
        ).toEqual({
          file: "open",
          args: ["-a", target.appName, "--", filePath],
        });
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("opens TextMate locations through txmt URLs with column support", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const applicationsDirectory = path.join(root, "Applications");
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["open"],
      calls,
    });

    try {
      await mkdir(path.join(applicationsDirectory, "TextMate.app"), {
        recursive: true,
      });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "textmate",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(calls.some((call) => call.file === "mate")).toBe(false);
      const openCall = calls.find(
        (call) => call.file === "open" && call.args[1] === "TextMate",
      );
      expect(openCall?.args.slice(0, 2)).toEqual(["-a", "TextMate"]);
      const textMateUri = new URL(openCall?.args[2] ?? "");
      expect(textMateUri.protocol).toBe("txmt:");
      expect(textMateUri.searchParams.get("url")).toBe(
        pathToFileURL(filePath).toString(),
      );
      expect(textMateUri.searchParams.get("line")).toBe("15");
      expect(textMateUri.searchParams.get("column")).toBe("6");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("advertises and uses column support for IntelliJ IDEA", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-intellij-idea-"));
    const applicationsDirectory = path.join(root, "Applications");
    const intellijAppPath = path.join(
      applicationsDirectory,
      "IntelliJ IDEA.app",
    );
    const intellijExecutable = path.join(
      intellijAppPath,
      "Contents",
      "MacOS",
      "idea",
    );
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(path.dirname(intellijExecutable), { recursive: true });
      await writeFile(intellijExecutable, "");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(
        targets.find((target) => target.id === "intellij-idea"),
      ).toMatchObject({
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: true,
          openFileAtLine: true,
        },
        label: "IntelliJ IDEA",
      });

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "intellij-idea",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === intellijExecutable)).toEqual({
        file: intellijExecutable,
        args: ["--line", "15", "--column", "6", filePath],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("falls back to application bundle paths when bundle id lookup misses", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    await mkdir(path.join(applicationsDirectory, "Cursor.app"), {
      recursive: true,
    });

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          applicationDirectories: [applicationsDirectory],
        }),
      );

      expect(targets.map((target) => target.id)).toContain("cursor");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses Cursor's bundled macOS CLI when the shell command is unavailable", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    const cursorAppPath = path.join(applicationsDirectory, "Cursor.app");
    const cursorExecutable = path.join(
      cursorAppPath,
      "Contents",
      "MacOS",
      "Cursor",
    );
    const cursorCli = path.join(
      cursorAppPath,
      "Contents",
      "Resources",
      "app",
      "out",
      "cli.js",
    );
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(path.dirname(cursorExecutable), { recursive: true });
      await mkdir(path.dirname(cursorCli), { recursive: true });
      await writeFile(cursorExecutable, "");
      await writeFile(cursorCli, "");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "cursor",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          env: {
            NODE_OPTIONS: "--inspect",
            NODE_REPL_EXTERNAL_MODULE: "repl-module",
          },
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === cursorExecutable)).toEqual({
        file: cursorExecutable,
        args: [cursorCli, "-g", `${filePath}:15:6`],
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: "1",
          VSCODE_NODE_OPTIONS: "--inspect",
          VSCODE_NODE_REPL_EXTERNAL_MODULE: "repl-module",
        }),
      });
      expect(
        calls.find((call) => call.file === cursorExecutable)?.env,
      ).not.toHaveProperty("NODE_OPTIONS");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses bundled macOS editor CLIs when shell commands are unavailable", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });
    const cases = [
      {
        appName: "Code",
        args: ["-g", `${filePath}:15:6`],
        relativeExecutablePath: ["Contents", "Resources", "app", "bin", "code"],
        targetId: "vscode",
      },
      {
        appName: "Code - Insiders",
        args: ["-g", `${filePath}:15:6`],
        relativeExecutablePath: ["Contents", "Resources", "app", "bin", "code"],
        targetId: "vscode-insiders",
      },
      {
        appName: "Windsurf",
        args: ["-g", `${filePath}:15:6`],
        relativeExecutablePath: [
          "Contents",
          "Resources",
          "app",
          "bin",
          "windsurf",
        ],
        targetId: "devin-desktop",
      },
      {
        appName: "Devin",
        args: ["-g", `${filePath}:15:6`],
        relativeExecutablePath: [
          "Contents",
          "Resources",
          "app",
          "bin",
          "devin-desktop",
        ],
        targetId: "devin-desktop",
      },
      {
        appName: "Antigravity",
        args: ["-g", `${filePath}:15:6`],
        relativeExecutablePath: [
          "Contents",
          "Resources",
          "app",
          "bin",
          "antigravity",
        ],
        targetId: "antigravity",
      },
      {
        appName: "Zed Nightly",
        args: [`${filePath}:15:6`],
        relativeExecutablePath: ["Contents", "MacOS", "zed"],
        targetId: "zed",
      },
      {
        appName: "Sublime Text",
        args: [`${filePath}:15:6`],
        relativeExecutablePath: ["Contents", "SharedSupport", "bin", "subl"],
        targetId: "sublime-text",
      },
    ];

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");
      for (const testCase of cases) {
        const executablePath = path.join(
          applicationsDirectory,
          `${testCase.appName}.app`,
          ...testCase.relativeExecutablePath,
        );
        await mkdir(path.dirname(executablePath), { recursive: true });
        await writeFile(executablePath, "");

        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: 6,
            lineNumber: 15,
            path: filePath,
            targetId: testCase.targetId,
          },
          createRuntime({
            applicationDirectories: [applicationsDirectory],
            execFile,
          }),
        );

        expect(calls.find((call) => call.file === executablePath)).toEqual({
          file: executablePath,
          args: testCase.args,
        });
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses bundled VS Code CLI for remote SSH opens when the shell command is unavailable", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    const codeExecutable = path.join(
      applicationsDirectory,
      "Code.app",
      "Contents",
      "Resources",
      "app",
      "bin",
      "code",
    );
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["ssh"],
      calls,
    });

    try {
      await mkdir(path.dirname(codeExecutable), { recursive: true });
      await writeFile(codeExecutable, "");

      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );
      expect(targets.find((target) => target.id === "vscode")).toMatchObject({
        remoteSshCapabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: true,
          openFileAtLine: true,
        },
      });

      await openPathInTargetWithRuntime(
        {
          context: {
            kind: "remote-ssh",
            sshAuthority: "mbp-intel",
          },
          columnNumber: 2,
          lineNumber: 10,
          path: "/repo/src/file.ts",
          targetId: "vscode",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === codeExecutable)).toEqual({
        file: codeExecutable,
        args: [
          "--remote",
          "ssh-remote+mbp-intel",
          "-g",
          "/repo/src/file.ts:10:2",
        ],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers Warp from the macOS application bundle", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    await mkdir(path.join(applicationsDirectory, "Warp.app"), {
      recursive: true,
    });

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          applicationDirectories: [applicationsDirectory],
        }),
      );

      expect(targets.find((target) => target.id === "warp")).toMatchObject({
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: false,
          openFileAtLine: false,
        },
        icon: { kind: "builtin", name: "warp" },
        kind: "terminal",
        label: "Warp",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers Antigravity with the current bundle id", async () => {
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.google.antigravity"],
    });

    const targets = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile,
      }),
    );

    expect(targets.map((target) => target.id)).toContain("antigravity");
  });

  it("discovers Devin Desktop with its current bundle id", async () => {
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.exafunction.windsurf"],
    });

    const targets = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile,
      }),
    );

    expect(
      targets.find((target) => target.id === "devin-desktop"),
    ).toMatchObject({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: true,
        openFileAtLine: true,
      },
      icon: { kind: "builtin", name: "devin-desktop" },
      kind: "editor",
      label: "Devin Desktop",
    });
  });

  it("discovers generic macOS apps from file-specific LaunchServices results", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const mockEditPath = "/Applications/MockEdit.app";
    const zedPath = "/Applications/Zed.app";
    const execFile: ExecFileHandler = async (file, commandArgs) => {
      if (file === "mdfind") {
        const query = commandArgs.join(" ");
        if (query.includes("kMDItemContentType")) {
          return { stdout: `${mockEditPath}\n${zedPath}\n` };
        }
        if (query.includes("dev.zed.Zed")) {
          return { stdout: `${zedPath}\n` };
        }
        return { stdout: "" };
      }
      if (file === "osascript" && commandArgs.includes("JavaScript")) {
        return {
          stdout: JSON.stringify([
            { appPath: mockEditPath, bundleId: "com.example.MockEdit" },
            { appPath: zedPath, bundleId: "dev.zed.Zed" },
          ]),
        };
      }
      if (file === "plutil") {
        const key = commandArgs[1];
        const plistPath = commandArgs.at(-1) ?? "";
        if (plistPath.includes("MockEdit.app")) {
          if (key === "CFBundleIdentifier") {
            return { stdout: "com.example.MockEdit\n" };
          }
          if (key === "CFBundleDisplayName") {
            return { stdout: "Mock Edit\n" };
          }
          return { stdout: "" };
        }
        if (plistPath.includes("Zed.app")) {
          if (key === "CFBundleIdentifier") {
            return { stdout: "dev.zed.Zed\n" };
          }
          if (key === "CFBundleDisplayName") {
            return { stdout: "Zed\n" };
          }
        }
      }
      if (file === "which") {
        throw new Error("Executable not found");
      }
      return { stdout: "" };
    };

    try {
      await writeFile(filePath, "# Notes\n");

      const globalTargets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({ execFile }),
      );
      expect(globalTargets.find((target) => target.id === "zed")).toBeDefined();
      expect(
        globalTargets.find(
          (target) => target.id === "mac-app:com.example.MockEdit",
        ),
      ).toBeUndefined();

      const fileTargets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({ execFile }),
        { path: filePath },
      );

      expect(fileTargets.find((target) => target.id === "zed")).toBeDefined();
      expect(
        fileTargets.find((target) => target.id === "mac-app:dev.zed.Zed"),
      ).toBeUndefined();
      expect(
        fileTargets.find(
          (target) => target.id === "mac-app:com.example.MockEdit",
        ),
      ).toMatchObject({
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: false,
          openFileAtLine: false,
        },
        icon: { kind: "symbol", name: "app" },
        kind: "native-app",
        label: "Mock Edit",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens generic macOS app targets by bundle id", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile: ExecFileHandler = async (file, commandArgs) => {
      calls.push({ file, args: commandArgs });
      if (file === "mdfind") {
        return commandArgs.join(" ").includes("com.example.MockEdit")
          ? { stdout: "/Applications/MockEdit.app\n" }
          : { stdout: "" };
      }
      if (file === "which") {
        throw new Error("Executable not found");
      }
      return { stdout: "" };
    };

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "mac-app:com.example.MockEdit",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-b", "com.example.MockEdit", "--", filePath],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("uses app-provided icons for discovered targets without built-in icons", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-open-target-icon-"));
    const appPath = path.join(root, "WebStorm.app");
    const calls: ExecFileCall[] = [];
    await mkdir(appPath, { recursive: true });
    const execFile: ExecFileHandler = async (file, commandArgs) => {
      calls.push({ file, args: commandArgs });
      if (file === "mdfind") {
        if (commandArgs.join(" ").includes("kMDItemContentType")) {
          return { stdout: `${appPath}\n` };
        }
        return {
          stdout: commandArgs.join(" ").includes("com.jetbrains.WebStorm")
            ? `${appPath}\n`
            : "",
        };
      }
      if (file === "plutil") {
        const key = commandArgs[1];
        if (key === "CFBundleIdentifier") {
          return { stdout: "com.jetbrains.WebStorm\n" };
        }
        if (key === "CFBundleDisplayName" || key === "CFBundleName") {
          return { stdout: "WebStorm\n" };
        }
        if (key === "CFBundleIconFile") {
          return { stdout: "webstorm\n" };
        }
        return { stdout: "" };
      }
      if (file === "qlmanage") {
        const outputDir = commandArgs[commandArgs.indexOf("-o") + 1];
        const inputPath = commandArgs.at(-1);
        if (outputDir && inputPath) {
          await writeFile(
            path.join(outputDir, `${path.basename(inputPath)}.png`),
            "fake-png",
          );
        }
        return { stdout: "" };
      }
      if (file === "which") {
        throw new Error("Executable not found");
      }
      return { stdout: "" };
    };

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({ execFile }),
      );

      expect(targets.find((target) => target.id === "webstorm")).toMatchObject({
        icon: {
          kind: "data-url",
          dataUrl: "data:image/png;base64,ZmFrZS1wbmc=",
        },
        label: "WebStorm",
      });
      expect(calls.some((call) => call.file === "qlmanage")).toBe(true);
      expect(calls.find((call) => call.file === "qlmanage")?.args).toEqual(
        expect.arrayContaining(["-t", "-s", "32"]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("prefers app-provided icons for discovered known app targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-open-target-icon-"));
    const appPath = path.join(root, "Visual Studio Code.app");
    const calls: ExecFileCall[] = [];
    await mkdir(appPath, { recursive: true });
    const execFile: ExecFileHandler = async (file, commandArgs) => {
      calls.push({ file, args: commandArgs });
      if (file === "mdfind") {
        if (commandArgs.join(" ").includes("kMDItemContentType")) {
          return { stdout: `${appPath}\n` };
        }
        return {
          stdout: commandArgs.join(" ").includes("com.microsoft.VSCode")
            ? `${appPath}\n`
            : "",
        };
      }
      if (file === "plutil") {
        const key = commandArgs[1];
        if (key === "CFBundleIdentifier") {
          return { stdout: "com.microsoft.VSCode\n" };
        }
        if (key === "CFBundleDisplayName" || key === "CFBundleName") {
          return { stdout: "Code\n" };
        }
        if (key === "CFBundleIconFile") {
          return { stdout: "Code\n" };
        }
        return { stdout: "" };
      }
      if (file === "qlmanage") {
        const outputDir = commandArgs[commandArgs.indexOf("-o") + 1];
        const inputPath = commandArgs.at(-1);
        if (outputDir && inputPath) {
          await writeFile(
            path.join(outputDir, `${path.basename(inputPath)}.png`),
            "vscode-png",
          );
        }
        return { stdout: "" };
      }
      if (file === "which") {
        throw new Error("Executable not found");
      }
      return { stdout: "" };
    };

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({ execFile }),
      );

      expect(targets.find((target) => target.id === "vscode")).toMatchObject({
        icon: {
          kind: "data-url",
          dataUrl: "data:image/png;base64,dnNjb2RlLXBuZw==",
        },
        label: "VS Code",
      });
      expect(calls.some((call) => call.file === "qlmanage")).toBe(true);
      expect(calls.find((call) => call.file === "qlmanage")?.args).toEqual(
        expect.arrayContaining(["-t", "-s", "32"]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers and opens JetBrains Toolbox applications through bundled executables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-jetbrains-toolbox-"));
    const homeDirectory = path.join(root, "home");
    const webStormAppPath = path.join(
      homeDirectory,
      "Library",
      "Application Support",
      "JetBrains",
      "Toolbox",
      "apps",
      "WebStorm",
      "ch-0",
      "241.1",
      "WebStorm.app",
    );
    const webStormExecutable = path.join(
      webStormAppPath,
      "Contents",
      "MacOS",
      "webstorm",
    );
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(path.dirname(webStormExecutable), { recursive: true });
      await writeFile(webStormExecutable, "");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          env: { HOME: homeDirectory },
          execFile,
        }),
      );
      expect(targets.find((target) => target.id === "webstorm")).toMatchObject({
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: true,
          openFileAtLine: true,
        },
        label: "WebStorm",
      });

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "webstorm",
        },
        createRuntime({
          env: { HOME: homeDirectory },
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === webStormExecutable)).toEqual({
        file: webStormExecutable,
        args: ["--line", "15", "--column", "6", filePath],
        env: { HOME: homeDirectory },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("falls back when app-provided icons exceed the contract size limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-open-target-icon-"));
    const appPath = path.join(root, "Visual Studio Code.app");
    await mkdir(appPath, { recursive: true });
    const execFile: ExecFileHandler = async (file, commandArgs) => {
      if (file === "mdfind") {
        return commandArgs.join(" ").includes("com.microsoft.VSCode")
          ? { stdout: `${appPath}\n` }
          : { stdout: "" };
      }
      if (file === "plutil") {
        const key = commandArgs[1];
        if (key === "CFBundleIdentifier") {
          return { stdout: "com.microsoft.VSCode\n" };
        }
        if (key === "CFBundleDisplayName" || key === "CFBundleName") {
          return { stdout: "Code\n" };
        }
        if (key === "CFBundleIconFile") {
          return { stdout: "Code\n" };
        }
        return { stdout: "" };
      }
      if (file === "qlmanage") {
        const outputDir = commandArgs[commandArgs.indexOf("-o") + 1];
        const inputPath = commandArgs.at(-1);
        if (outputDir && inputPath) {
          await writeFile(
            path.join(outputDir, `${path.basename(inputPath)}.png`),
            "x".repeat(200_000),
          );
        }
        return { stdout: "" };
      }
      if (file === "which") {
        throw new Error("Executable not found");
      }
      return { stdout: "" };
    };

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({ execFile }),
      );

      expect(targets.find((target) => target.id === "vscode")).toMatchObject({
        icon: { kind: "builtin", name: "vscode" },
        label: "VS Code",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("opens Xcode files through xed with the enclosing project container", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-xcode-open-"));
    const applicationsDirectory = path.join(root, "Applications");
    const xcodeAppPath = path.join(applicationsDirectory, "Xcode.app");
    const xedPath = path.join(
      xcodeAppPath,
      "Contents",
      "Developer",
      "usr",
      "bin",
      "xed",
    );
    const workspacePath = path.join(root, "workspace");
    const xcodeWorkspacePath = path.join(workspacePath, "App.xcworkspace");
    const filePath = path.join(workspacePath, "Sources", "App", "File.swift");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(path.dirname(xedPath), { recursive: true });
      await writeFile(xedPath, "");
      await mkdir(xcodeWorkspacePath, { recursive: true });
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "let value = 1\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "xcode",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === xedPath)).toEqual({
        file: xedPath,
        args: ["--project", xcodeWorkspacePath, "--line", "22", filePath],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("opens the workspace with an argument separator before the path", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["dev.zed.Zed"],
      calls,
    });

    try {
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "zed",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-a", "Zed", "--", workspacePath],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("uses the VS Code CLI for workspace opens when available", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.microsoft.VSCode"],
      availableExecutables: ["code"],
      calls,
    });

    try {
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "vscode",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "code")).toEqual({
        file: "code",
        args: [workspacePath],
      });
      expect(calls.some((call) => call.file === "open")).toBe(false);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("advertises VS Code remote SSH support only when the CLI is available", async () => {
    const withCli = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile({
          availableBundleIdSubstrings: ["com.microsoft.VSCode"],
          availableExecutables: ["code"],
        }),
      }),
    );
    expect(withCli.find((target) => target.id === "vscode")).toMatchObject({
      remoteSshCapabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtLine: true,
      },
    });

    const withoutCli = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile({
          availableBundleIdSubstrings: ["com.microsoft.VSCode"],
        }),
      }),
    );
    expect(
      withoutCli.find((target) => target.id === "vscode")
        ?.remoteSshCapabilities,
    ).toBeUndefined();
  });

  it("advertises terminal remote SSH support only when osascript and ssh are available", async () => {
    const withLauncher = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile({
          availableExecutables: ["osascript", "ssh"],
        }),
      }),
    );
    expect(
      withLauncher.find((target) => target.id === "terminal"),
    ).toMatchObject({
      remoteSshCapabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtLine: true,
      },
    });

    const withoutLauncher = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile(),
      }),
    );
    expect(
      withoutLauncher.find((target) => target.id === "terminal")
        ?.remoteSshCapabilities,
    ).toBeUndefined();

    const withoutSsh = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile({
          availableExecutables: ["osascript"],
        }),
      }),
    );
    expect(
      withoutSsh.find((target) => target.id === "terminal")
        ?.remoteSshCapabilities,
    ).toBeUndefined();
  });

  it("opens remote SSH paths with VS Code without local path checks", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.microsoft.VSCode"],
      availableExecutables: ["code"],
      calls,
    });

    await openPathInTargetWithRuntime(
      {
        context: {
          kind: "remote-ssh",
          sshAuthority: "devbox",
        },
        columnNumber: 9,
        lineNumber: 42,
        path: "/home/me/missing-on-client.ts",
        targetId: "vscode",
      },
      createRuntime({ execFile }),
    );

    expect(calls.find((call) => call.file === "code")).toEqual({
      file: "code",
      args: [
        "--remote",
        "ssh-remote+devbox",
        "-g",
        "/home/me/missing-on-client.ts:42:9",
      ],
    });
  });

  it("opens remote SSH paths in Terminal with a remote editor script", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["osascript", "ssh"],
      calls,
    });

    await openPathInTargetWithRuntime(
      {
        context: {
          kind: "remote-ssh",
          sshAuthority: "devbox",
        },
        columnNumber: 8,
        lineNumber: 42,
        path: "/home/me/project/src/file.ts",
        targetId: "terminal",
      },
      createRuntime({ execFile }),
    );

    const osascriptCall = calls.find((call) => call.file === "osascript");
    expect(osascriptCall).toBeDefined();
    const script = osascriptCall?.args.join("\n") ?? "";
    expect(script).toContain('tell application "Terminal" to do script');
    expect(script).toContain("ssh");
    expect(script).toContain("devbox");
    expect(script).toContain("/home/me/project/src/file.ts");
    expect(script).toContain("line=");
    expect(script).toContain("42");
    expect(script).toContain("column=");
    expect(script).toContain("8");
    expect(script).toContain("VISUAL");
    expect(script).toContain("EDITOR");
  });

  it("opens remote SSH paths in Ghostty by passing ssh args to the app", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.mitchellh.ghostty"],
      availableExecutables: ["open", "ssh"],
      calls,
    });

    await openPathInTargetWithRuntime(
      {
        context: {
          kind: "remote-ssh",
          sshAuthority: "devbox",
        },
        columnNumber: null,
        lineNumber: null,
        path: "/home/me/project",
        targetId: "ghostty",
      },
      createRuntime({ execFile }),
    );

    expect(calls.find((call) => call.file === "open")).toEqual({
      file: "open",
      args: [
        "-na",
        "Ghostty",
        "--args",
        "-e",
        "ssh",
        "-t",
        "--",
        "devbox",
        expect.stringContaining("/home/me/project"),
      ],
    });
  });

  it("opens remote SSH paths in Zed with SSH URIs", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["dev.zed.Zed"],
      availableExecutables: ["zed"],
      calls,
    });

    await openPathInTargetWithRuntime(
      {
        context: {
          kind: "remote-ssh",
          sshAuthority: "devbox",
        },
        columnNumber: 3,
        lineNumber: 7,
        path: "/home/me/project/src/file with spaces.ts",
        targetId: "zed",
      },
      createRuntime({ execFile }),
    );

    expect(calls.find((call) => call.file === "zed")).toEqual({
      file: "zed",
      args: ["ssh://devbox/home/me/project/src/file%20with%20spaces.ts:7:3"],
    });
  });

  it("rejects remote SSH opens for targets without remote support", async () => {
    await expect(
      openPathInTargetWithRuntime(
        {
          context: {
            kind: "remote-ssh",
            sshAuthority: "devbox",
          },
          columnNumber: null,
          lineNumber: null,
          path: "/home/me/project",
          targetId: "sublime-text",
        },
        createRuntime({
          execFile: createAvailableExecFile({
            availableBundleIdSubstrings: ["com.sublimetext.4"],
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "remote_target_unsupported",
    });
  });

  it("rejects missing paths", async () => {
    await expect(
      openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: path.join(tmpdir(), "bb-missing-workspace"),
          targetId: "zed",
        },
        createRuntime({
          execFile: createAvailableExecFile({
            availableBundleIdSubstrings: ["dev.zed.Zed"],
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "path_not_found",
    });
  });

  it("opens local directories in Terminal with a short cd command", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "terminal",
        },
        createRuntime({ execFile }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain('tell application "Terminal" to do script');
      expect(script).toContain(`cd '${workspacePath}'`);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local directories in iTerm2 with a short cd command", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.googlecode.iterm2"],
      calls,
    });

    try {
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "iterm2",
        },
        createRuntime({ execFile }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain(
        'tell application "iTerm" to create window with default profile',
      );
      expect(script).toContain(
        'tell application "iTerm" to tell current session of current window to write text',
      );
      expect(script).toContain(`cd '${workspacePath}'`);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local files in Terminal with a resolved terminal editor command", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["vim"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "terminal",
        },
        createRuntime({ execFile }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain('tell application "Terminal" to do script');
      expect(script).toContain(
        `cd '${path.dirname(filePath)}' && 'vim' '+call cursor(22,4)' '${filePath}'`,
      );
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local files in iTerm2 with a resolved terminal editor command", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "README.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.googlecode.iterm2"],
      availableExecutables: ["vim"],
      calls,
    });

    try {
      await writeFile(filePath, "# Test\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "iterm2",
        },
        createRuntime({ execFile }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain(
        'tell application "iTerm" to create window with default profile',
      );
      expect(script).toContain(
        'tell application "iTerm" to tell current session of current window to write text',
      );
      expect(script).toContain(`cd '${workspacePath}' && 'vim' '${filePath}'`);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("inserts terminal editor location args before explicit editor args separator", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "terminal",
        },
        createRuntime({
          env: { VISUAL: "vim --clean --" },
          execFile,
        }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain(
        `cd '${path.dirname(filePath)}' && 'vim' '--clean' '+call cursor(22,4)' '--' '${filePath}'`,
      );
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local files in Terminal at the containing directory when no terminal editor is available", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "README.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await writeFile(filePath, "# Test\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "terminal",
        },
        createRuntime({ execFile }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain('tell application "Terminal" to do script');
      expect(script).toContain(`cd '${workspacePath}'`);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local files in Warp at the containing directory", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    await mkdir(path.join(applicationsDirectory, "Warp.app"), {
      recursive: true,
    });
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "README.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(workspacePath, { recursive: true });
      await writeFile(filePath, "# Test\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "warp",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-a", "Warp", workspacePath],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("opens local files in Ghostty with a resolved terminal editor command", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.mitchellh.ghostty"],
      availableExecutables: ["vim"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "ghostty",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: [
          "-na",
          "Ghostty.app",
          "--args",
          "-e",
          "/bin/zsh",
          "-lc",
          `cd '${path.dirname(filePath)}' && 'vim' '+call cursor(22,4)' '${filePath}'`,
        ],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local files in Ghostty at the containing directory when no terminal editor is available", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "README.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.mitchellh.ghostty"],
      calls,
    });

    try {
      await writeFile(filePath, "# Test\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "ghostty",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-a", "Ghostty", workspacePath],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("uses line-aware direct-editor commands when available", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.todesktop.230313mzl4w4u92"],
      availableExecutables: ["cursor"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "cursor",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "cursor")).toEqual({
        file: "cursor",
        args: ["-g", `${filePath}:15:6`],
      });
      expect(calls.some((call) => call.file === "open")).toBe(false);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("uses Devin Desktop line and column direct-editor commands when available", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.exafunction.windsurf"],
      availableExecutables: ["devin-desktop"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "devin-desktop",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "devin-desktop")).toEqual({
        file: "devin-desktop",
        args: ["-g", `${filePath}:15:6`],
      });
      expect(calls.some((call) => call.file === "open")).toBe(false);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("falls back to regular app opens when a line-aware executable is unavailable", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.todesktop.230313mzl4w4u92"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "cursor",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-a", "Cursor", "--", filePath],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("rejects unavailable targets", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));

    try {
      await expect(
        openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: workspacePath,
            targetId: "vscode",
          },
          createRuntime(),
        ),
      ).rejects.toMatchObject({
        code: "target_unavailable",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("rejects workspace opening on unsupported platforms", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));

    try {
      await expect(
        openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: workspacePath,
            targetId: "vscode",
          },
          createRuntime({ platform: "freebsd" }),
        ),
      ).rejects.toMatchObject({
        code: "unsupported_platform",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  describe("windows", () => {
    interface WindowsExecFileCall {
      args: string[];
      file: string;
      options?: ExecFileOptions;
    }

    interface CreateWindowsRuntimeArgs {
      appPaths?: Record<string, string>;
      beforeFailure?: () => Promise<void>;
      calls?: WindowsExecFileCall[];
      env?: NodeJS.ProcessEnv;
      failWithCode?: (executableName: string) => number | null;
    }

    function windowsExecutableName(file: string): string {
      const segments = file.split(/[\\/]/u);
      return (segments[segments.length - 1] ?? file).toLowerCase();
    }

    function createWindowsRuntime(
      args: CreateWindowsRuntimeArgs,
    ): WorkspaceOpenTargetRuntime {
      return createRuntime({
        env: args.env ?? {},
        execFile: async (file, commandArgs, options) => {
          const name = windowsExecutableName(file);
          args.calls?.push({ file, args: commandArgs, options });
          if (name === "reg.exe") {
            const key = commandArgs[1] ?? "";
            const entry = Object.entries(args.appPaths ?? {}).find(
              ([valueName]) =>
                key.toLowerCase().endsWith(`\\${valueName.toLowerCase()}`),
            );
            if (entry === undefined) {
              throw new Error("ERROR: The system was unable to find the key");
            }
            return {
              stdout: `\r\n${key}\r\n    (Default)    REG_SZ    ${entry[1]}\r\n\r\n`,
            };
          }
          const failCode = args.failWithCode?.(name) ?? null;
          if (failCode !== null) {
            await args.beforeFailure?.();
            throw Object.assign(new Error(`exited with ${failCode}`), {
              code: failCode,
            });
          }
          return { stdout: "" };
        },
        platform: "win32",
      });
    }

    async function createWindowsPathDirectory(
      executableNames: string[],
    ): Promise<string> {
      const directory = await mkdtemp(path.join(tmpdir(), "bb-win-path-"));
      for (const executableName of executableNames) {
        await writeFile(path.join(directory, executableName), "");
      }
      return directory;
    }

    it("discovers VS Code on the Windows Path with remote support", async () => {
      const pathDirectory = await createWindowsPathDirectory(["code.exe"]);

      try {
        const targets = await listWorkspaceOpenTargetsWithRuntime(
          createWindowsRuntime({ env: { Path: pathDirectory } }),
        );

        expect(targets.map((target) => target.id)).toEqual([
          "vscode",
          "default-app",
          "file-manager",
          "terminal",
        ]);
        expect(targets.find((target) => target.id === "vscode")).toMatchObject({
          icon: { kind: "builtin", name: "vscode" },
          kind: "editor",
          label: "VS Code",
          remoteSshCapabilities: {
            openDirectory: true,
            openFile: true,
            openFileAtColumn: true,
            openFileAtLine: true,
          },
        });
        expect(
          targets.find((target) => target.id === "terminal"),
        ).toMatchObject({
          capabilities: {
            openDirectory: true,
            openFile: true,
            openFileAtColumn: false,
            openFileAtLine: false,
          },
          kind: "terminal",
        });
      } finally {
        await rm(pathDirectory, { force: true, recursive: true });
      }
    });

    it("opens files in VS Code at line and column from the Windows Path", async () => {
      const pathDirectory = await createWindowsPathDirectory(["code.exe"]);
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
      const filePath = path.join(workspacePath, "file.ts");
      const calls: WindowsExecFileCall[] = [];

      try {
        await writeFile(filePath, "export const value = 1;\n");

        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: 6,
            lineNumber: 15,
            path: filePath,
            targetId: "vscode",
          },
          createWindowsRuntime({ calls, env: { Path: pathDirectory } }),
        );

        expect(calls).toEqual([
          {
            file: path.join(pathDirectory, "code.exe"),
            args: ["-g", `${filePath}:15:6`],
            options: { env: { Path: pathDirectory } },
          },
        ]);
      } finally {
        await rm(pathDirectory, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("discovers an editor through the App Paths registry when the Path misses", async () => {
      const installRoot = await mkdtemp(path.join(tmpdir(), "bb-apppaths-"));
      const codeExe = path.join(installRoot, "Code.exe");
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
      const calls: WindowsExecFileCall[] = [];

      try {
        await writeFile(codeExe, "");

        const runtime = createWindowsRuntime({
          appPaths: { "code.exe": codeExe },
          calls,
        });
        const targets = await listWorkspaceOpenTargetsWithRuntime(runtime);
        expect(targets.map((target) => target.id)).toContain("vscode");

        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: workspacePath,
            targetId: "vscode",
          },
          runtime,
        );

        const registryCall = calls.find(
          (call) => windowsExecutableName(call.file) === "reg.exe",
        );
        expect(registryCall?.args).toEqual([
          "query",
          "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\code.exe",
          "/ve",
        ]);
        expect(calls.find((call) => call.file === codeExe)).toMatchObject({
          file: codeExe,
          args: [workspacePath],
        });
      } finally {
        await rm(installRoot, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("runs a node .cmd shim through the Node executable", async () => {
      const localAppData = await mkdtemp(path.join(tmpdir(), "bb-localapp-"));
      const binDirectory = path.join(
        localAppData,
        "Programs",
        "Microsoft VS Code",
        "bin",
      );
      const codeCmd = path.join(binDirectory, "code.cmd");
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
      const calls: WindowsExecFileCall[] = [];

      try {
        await mkdir(binDirectory, { recursive: true });
        await writeFile(codeCmd, '@node "%~dp0code" %*\r\n');
        await writeFile(path.join(binDirectory, "code"), "");

        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: workspacePath,
            targetId: "vscode",
          },
          createWindowsRuntime({ calls, env: { LOCALAPPDATA: localAppData } }),
        );

        expect(calls.find((call) => call.file === process.execPath)).toEqual({
          file: process.execPath,
          args: [path.join(binDirectory, "code"), workspacePath],
          options: { env: { LOCALAPPDATA: localAppData } },
        });
      } finally {
        await rm(localAppData, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("runs a non-node .cmd shim through cmd.exe", async () => {
      const localAppData = await mkdtemp(path.join(tmpdir(), "bb-localapp-"));
      const codeCmd = path.join(
        localAppData,
        "Programs",
        "Microsoft VS Code",
        "bin",
        "code.cmd",
      );
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
      const calls: WindowsExecFileCall[] = [];

      try {
        await mkdir(path.dirname(codeCmd), { recursive: true });
        await writeFile(codeCmd, '@echo off\r\n"%~dp0..\\Code.exe" %*\r\n');

        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: workspacePath,
            targetId: "vscode",
          },
          createWindowsRuntime({ calls, env: { LOCALAPPDATA: localAppData } }),
        );

        const call = calls.find(
          (candidate) => windowsExecutableName(candidate.file) === "cmd.exe",
        );
        expect(call?.file.endsWith("System32\\cmd.exe")).toBe(true);
        expect(call?.args).toEqual([
          "/d",
          "/s",
          "/c",
          `""${codeCmd}" "${workspacePath}""`,
        ]);
        expect(call?.options?.windowsVerbatimArguments).toBe(true);
      } finally {
        await rm(localAppData, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("selects files and opens directories in Explorer", async () => {
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
      const nestedDirectory = path.join(workspacePath, "sub");
      const filePath = path.join(nestedDirectory, "notes.md");
      const calls: WindowsExecFileCall[] = [];

      try {
        await mkdir(nestedDirectory, { recursive: true });
        await writeFile(filePath, "# Notes\n");

        const runtime = createWindowsRuntime({ calls });
        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: filePath,
            targetId: "file-manager",
          },
          runtime,
        );
        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: nestedDirectory,
            targetId: "file-manager",
          },
          runtime,
        );

        expect(
          calls.map((call) => [windowsExecutableName(call.file), call.args]),
        ).toEqual([
          ["explorer.exe", [`/select,"${filePath}"`]],
          ["explorer.exe", [nestedDirectory]],
        ]);
      } finally {
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("opens files and directories with the default app through Explorer", async () => {
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
      const filePath = path.join(workspacePath, "notes.md");
      const calls: WindowsExecFileCall[] = [];

      try {
        await writeFile(filePath, "# Notes\n");

        const runtime = createWindowsRuntime({ calls });
        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: filePath,
            targetId: "default-app",
          },
          runtime,
        );
        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: workspacePath,
            targetId: "default-app",
          },
          runtime,
        );

        expect(
          calls.map((call) => [windowsExecutableName(call.file), call.args]),
        ).toEqual([
          ["explorer.exe", [filePath]],
          ["explorer.exe", [workspacePath]],
        ]);
        expect(
          calls.some((call) => windowsExecutableName(call.file) === "cmd.exe"),
        ).toBe(false);
      } finally {
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("opens Windows Terminal at the containing directory", async () => {
      const pathDirectory = await createWindowsPathDirectory(["wt.exe"]);
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
      const filePath = path.join(workspacePath, "notes.md");
      const calls: WindowsExecFileCall[] = [];

      try {
        await writeFile(filePath, "# Notes\n");

        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: filePath,
            targetId: "terminal",
          },
          createWindowsRuntime({ calls, env: { Path: pathDirectory } }),
        );

        expect(calls).toEqual([
          {
            file: path.join(pathDirectory, "wt.exe"),
            args: ["-d", workspacePath],
            options: { env: { Path: pathDirectory }, windowsHide: false },
          },
        ]);
      } finally {
        await rm(pathDirectory, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("falls back to a detached PowerShell console when wt is absent", async () => {
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
      const calls: WindowsExecFileCall[] = [];

      try {
        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: workspacePath,
            targetId: "terminal",
          },
          createWindowsRuntime({ calls }),
        );

        expect(calls).toHaveLength(1);
        expect(windowsExecutableName(calls[0]?.file ?? "")).toBe("cmd.exe");
        expect(calls[0]?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
        expect(calls[0]?.args[3]).toMatch(
          /^"start "" \/D "[^"]+" "[^"]*(?:pwsh|powershell)\.exe" -NoLogo"$/u,
        );
        expect(calls[0]?.args[3]).toContain(`/D "${workspacePath}"`);
        expect(calls[0]?.options).toEqual({
          detached: true,
          env: {},
          windowsHide: true,
          windowsVerbatimArguments: true,
        });
      } finally {
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("starts the console fallback in a spaced directory through cmd start", async () => {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), "bb-ws-"));
      const workspacePath = path.join(workspaceRoot, "my project");
      const calls: WindowsExecFileCall[] = [];

      try {
        await mkdir(workspacePath, { recursive: true });

        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: workspacePath,
            targetId: "terminal",
          },
          createWindowsRuntime({ calls }),
        );

        const shellPath = resolvePowerShellExecutable({});
        expect(workspacePath).toContain(" ");
        expect(calls[0]?.file.endsWith("System32\\cmd.exe")).toBe(true);
        expect(calls[0]?.args).toEqual([
          "/d",
          "/s",
          "/c",
          `"start "" /D "${workspacePath}" "${shellPath}" -NoLogo"`,
        ]);
        expect(calls[0]?.options?.windowsVerbatimArguments).toBe(true);
        expect(calls[0]?.options?.windowsHide).toBe(true);
        expect(calls[0]?.options?.detached).toBe(true);
      } finally {
        await rm(workspaceRoot, { force: true, recursive: true });
      }
    });

    it.runIf(
      process.platform === "win32" && process.env.BB_QA_REAL_LAUNCH === "1",
    )(
      "leaves a live interactive console behind for the terminal fallback",
      async () => {
        const workspaceRoot = await mkdtemp(path.join(tmpdir(), "bb-ws-"));
        const workspacePath = path.join(workspaceRoot, "my project");
        const runtimeEnv: NodeJS.ProcessEnv = {
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        };
        const runtime: WorkspaceOpenTargetRuntime = {
          ...createWorkspaceOpenTargetRuntime(),
          env: runtimeEnv,
        };
        const shellPath = resolvePowerShellExecutable(runtimeEnv);

        const isFallbackShell = (
          entry: WindowsProcessSnapshotEntry,
        ): boolean => {
          const commandLine = entry.commandLine ?? "";
          return (
            (entry.executablePath ?? "").toLowerCase() ===
              shellPath.toLowerCase() &&
            commandLine.includes("-NoLogo") &&
            !commandLine.includes("-NonInteractive")
          );
        };

        const killFallbackShell = async (pid: number): Promise<void> => {
          await new Promise((resolveKill) => {
            const kill = spawn(
              resolveWindowsSystemToolPath("taskkill.exe", process.env),
              ["/PID", String(pid), "/F"],
              { stdio: "ignore", windowsHide: true },
            );
            kill.once("error", () => resolveKill(undefined));
            kill.once("exit", () => resolveKill(undefined));
          });
        };

        let launched: WindowsProcessSnapshotEntry[] = [];
        try {
          await mkdir(workspacePath, { recursive: true });

          const before = await takeWindowsProcessSnapshot();
          const beforePids = new Set(before.map((entry) => entry.pid));

          await openPathInTargetWithRuntime(
            {
              context: { kind: "local" },
              columnNumber: null,
              lineNumber: null,
              path: workspacePath,
              targetId: "terminal",
            },
            runtime,
          );

          await new Promise((resolveWait) => setTimeout(resolveWait, 2000));

          launched = (await takeWindowsProcessSnapshot()).filter(
            (entry) => !beforePids.has(entry.pid) && isFallbackShell(entry),
          );
          console.log(
            `terminal fallback consoles: ${
              launched
                .map(
                  (entry) => `pid=${entry.pid} started=${entry.creationDate}`,
                )
                .join(", ") || "(none)"
            }`,
          );

          expect(launched.length).toBeGreaterThan(0);

          for (const entry of launched) {
            await killFallbackShell(entry.pid);
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 700));

          for (const entry of launched) {
            expect(await queryWindowsProcess(entry.pid)).toBeNull();
          }
        } finally {
          for (const entry of launched) {
            await killFallbackShell(entry.pid);
          }
          await rm(workspaceRoot, { force: true, recursive: true }).catch(
            () => undefined,
          );
        }
      },
    );

    it("treats an Explorer exit code of 1 on an existing path as success", async () => {
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));

      try {
        await expect(
          openPathInTargetWithRuntime(
            {
              context: { kind: "local" },
              columnNumber: null,
              lineNumber: null,
              path: workspacePath,
              targetId: "file-manager",
            },
            createWindowsRuntime({
              failWithCode: (name) => (name === "explorer.exe" ? 1 : null),
            }),
          ),
        ).resolves.toBeUndefined();
      } finally {
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("surfaces Explorer failures when the path is gone or the code is not 1", async () => {
      const missingPath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
      const failingPath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));

      try {
        await expect(
          openPathInTargetWithRuntime(
            {
              context: { kind: "local" },
              columnNumber: null,
              lineNumber: null,
              path: missingPath,
              targetId: "file-manager",
            },
            createWindowsRuntime({
              beforeFailure: () =>
                rm(missingPath, { force: true, recursive: true }),
              failWithCode: (name) => (name === "explorer.exe" ? 1 : null),
            }),
          ),
        ).rejects.toMatchObject({ code: 1 });

        await expect(
          openPathInTargetWithRuntime(
            {
              context: { kind: "local" },
              columnNumber: null,
              lineNumber: null,
              path: failingPath,
              targetId: "file-manager",
            },
            createWindowsRuntime({
              failWithCode: (name) => (name === "explorer.exe" ? 2 : null),
            }),
          ),
        ).rejects.toMatchObject({ code: 2 });
      } finally {
        await rm(missingPath, { force: true, recursive: true });
        await rm(failingPath, { force: true, recursive: true });
      }
    });

    it("opens remote SSH paths in VS Code and rejects targets without remote support", async () => {
      const pathDirectory = await createWindowsPathDirectory(["code.exe"]);
      const calls: WindowsExecFileCall[] = [];

      try {
        await openPathInTargetWithRuntime(
          {
            context: { kind: "remote-ssh", sshAuthority: "devbox" },
            columnNumber: 9,
            lineNumber: 42,
            path: "/home/me/missing-on-client.ts",
            targetId: "vscode",
          },
          createWindowsRuntime({ calls, env: { Path: pathDirectory } }),
        );

        expect(calls.at(-1)).toMatchObject({
          file: path.join(pathDirectory, "code.exe"),
          args: [
            "--remote",
            "ssh-remote+devbox",
            "-g",
            "/home/me/missing-on-client.ts:42:9",
          ],
        });

        await expect(
          openPathInTargetWithRuntime(
            {
              context: { kind: "remote-ssh", sshAuthority: "devbox" },
              columnNumber: null,
              lineNumber: null,
              path: "/home/me/project",
              targetId: "file-manager",
            },
            createWindowsRuntime({}),
          ),
        ).rejects.toMatchObject({ code: "remote_target_unsupported" });

        await expect(
          openPathInTargetWithRuntime(
            {
              context: { kind: "remote-ssh", sshAuthority: "devbox" },
              columnNumber: null,
              lineNumber: null,
              path: "/home/me/project",
              targetId: "vscode",
            },
            createWindowsRuntime({}),
          ),
        ).rejects.toMatchObject({ code: "target_unavailable" });
      } finally {
        await rm(pathDirectory, { force: true, recursive: true });
      }
    });

    it("rejects desktop and macOS app targets as unavailable", async () => {
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));

      try {
        for (const targetId of [
          "desktop-app:mockedit",
          "mac-app:com.example.MockEdit",
        ]) {
          await expect(
            openPathInTargetWithRuntime(
              {
                context: { kind: "local" },
                columnNumber: null,
                lineNumber: null,
                path: workspacePath,
                targetId,
              },
              createWindowsRuntime({}),
            ),
          ).rejects.toMatchObject({ code: "target_unavailable" });
        }
      } finally {
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("discovers editors from Windows install roots", async () => {
      const localAppData = await mkdtemp(path.join(tmpdir(), "bb-localapp-"));
      const programFiles = await mkdtemp(path.join(tmpdir(), "bb-progfiles-"));
      const localCases = [
        { relativePath: ["cursor", "Cursor.exe"], targetId: "cursor" },
        { relativePath: ["Zed", "zed.exe"], targetId: "zed" },
        {
          relativePath: ["Windsurf", "Windsurf.exe"],
          targetId: "devin-desktop",
        },
        {
          relativePath: ["Antigravity", "Antigravity.exe"],
          targetId: "antigravity",
        },
      ];
      const sublExe = path.join(programFiles, "Sublime Text", "subl.exe");
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
      const filePath = path.join(workspacePath, "notes.md");
      const calls: WindowsExecFileCall[] = [];

      try {
        for (const testCase of localCases) {
          const executablePath = path.join(
            localAppData,
            "Programs",
            ...testCase.relativePath,
          );
          await mkdir(path.dirname(executablePath), { recursive: true });
          await writeFile(executablePath, "");
        }
        await mkdir(path.dirname(sublExe), { recursive: true });
        await writeFile(sublExe, "");
        await writeFile(filePath, "# Notes\n");

        const runtime = createWindowsRuntime({
          calls,
          env: { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
        });
        const targets = await listWorkspaceOpenTargetsWithRuntime(runtime);
        for (const testCase of [
          ...localCases,
          { relativePath: [], targetId: "sublime-text" },
        ]) {
          expect(targets.map((target) => target.id)).toContain(
            testCase.targetId,
          );
        }

        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: 6,
            lineNumber: 15,
            path: filePath,
            targetId: "sublime-text",
          },
          runtime,
        );

        expect(calls.find((call) => call.file === sublExe)).toMatchObject({
          file: sublExe,
          args: [`${filePath}:15:6`],
        });
      } finally {
        await rm(localAppData, { force: true, recursive: true });
        await rm(programFiles, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("discovers JetBrains Toolbox shims and versioned installs", async () => {
      const localAppData = await mkdtemp(path.join(tmpdir(), "bb-localapp-"));
      const programFiles = await mkdtemp(path.join(tmpdir(), "bb-progfiles-"));
      const ideaCmd = path.join(
        localAppData,
        "JetBrains",
        "Toolbox",
        "scripts",
        "idea.cmd",
      );
      const webstormExe = path.join(
        programFiles,
        "JetBrains",
        "WebStorm 2024.1",
        "bin",
        "webstorm64.exe",
      );
      const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
      const filePath = path.join(workspacePath, "file.ts");
      const calls: WindowsExecFileCall[] = [];

      try {
        await mkdir(path.dirname(ideaCmd), { recursive: true });
        await writeFile(ideaCmd, "@echo off\r\n");
        await mkdir(path.dirname(webstormExe), { recursive: true });
        await writeFile(webstormExe, "");
        await writeFile(filePath, "export const value = 1;\n");

        const runtime = createWindowsRuntime({
          calls,
          env: { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
        });
        const targets = await listWorkspaceOpenTargetsWithRuntime(runtime);
        expect(targets.map((target) => target.id)).toContain("intellij-idea");
        expect(targets.map((target) => target.id)).toContain("webstorm");

        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: 6,
            lineNumber: 15,
            path: filePath,
            targetId: "intellij-idea",
          },
          runtime,
        );
        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: 15,
            path: filePath,
            targetId: "webstorm",
          },
          runtime,
        );

        expect(
          calls.find((call) => windowsExecutableName(call.file) === "cmd.exe")
            ?.args,
        ).toEqual([
          "/d",
          "/s",
          "/c",
          `""${ideaCmd}" "--line" "15" "--column" "6" "${filePath}""`,
        ]);
        expect(calls.find((call) => call.file === webstormExe)?.args).toEqual([
          "--line",
          "15",
          filePath,
        ]);
      } finally {
        await rm(localAppData, { force: true, recursive: true });
        await rm(programFiles, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
      }
    });

    it("leaves JetBrains targets unavailable without Toolbox or installs", async () => {
      const localAppData = await mkdtemp(path.join(tmpdir(), "bb-empty-"));

      try {
        const targets = await listWorkspaceOpenTargetsWithRuntime(
          createWindowsRuntime({ env: { LOCALAPPDATA: localAppData } }),
        );

        for (const targetId of [
          "intellij-idea",
          "pycharm",
          "webstorm",
          "goland",
          "rider",
          "rustrover",
          "phpstorm",
          "android-studio",
        ]) {
          expect(targets.map((target) => target.id)).not.toContain(targetId);
        }
      } finally {
        await rm(localAppData, { force: true, recursive: true });
      }
    });

    it("quotes a .cmd shim and its arguments into one verbatim command line", async () => {
      const localAppData = await mkdtemp(path.join(tmpdir(), "bb-localapp-"));
      const codeCmd = path.join(
        localAppData,
        "Programs",
        "Microsoft VS Code",
        "bin",
        "code.cmd",
      );
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), "bb-ws-"));
      const workspacePath = path.join(workspaceRoot, "my project");
      const calls: WindowsExecFileCall[] = [];

      try {
        await mkdir(path.dirname(codeCmd), { recursive: true });
        await writeFile(codeCmd, '@echo off\r\n"%~dp0..\\Code.exe" %*\r\n');
        await mkdir(workspacePath, { recursive: true });

        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: workspacePath,
            targetId: "vscode",
          },
          createWindowsRuntime({ calls, env: { LOCALAPPDATA: localAppData } }),
        );

        const call = calls.find(
          (candidate) => windowsExecutableName(candidate.file) === "cmd.exe",
        );
        expect(codeCmd).toContain(" ");
        expect(workspacePath).toContain(" ");
        expect(call?.args).toEqual([
          "/d",
          "/s",
          "/c",
          `""${codeCmd}" "${workspacePath}""`,
        ]);
        expect(call?.options?.windowsVerbatimArguments).toBe(true);
      } finally {
        await rm(localAppData, { force: true, recursive: true });
        await rm(workspaceRoot, { force: true, recursive: true });
      }
    });

    it.runIf(process.platform === "win32")(
      "runs a real spaced .cmd shim with a spaced argument through cmd.exe",
      async () => {
        const localAppData = await mkdtemp(path.join(tmpdir(), "bb-localapp-"));
        const codeCmd = path.join(
          localAppData,
          "Programs",
          "Microsoft VS Code",
          "bin",
          "code.cmd",
        );
        const workspaceRoot = await mkdtemp(path.join(tmpdir(), "bb-ws-"));
        const workspacePath = path.join(workspaceRoot, "my project");
        const argvOutput = path.join(workspaceRoot, "argv out.txt");
        const calls: WindowsExecFileCall[] = [];

        try {
          await mkdir(path.dirname(codeCmd), { recursive: true });
          await writeFile(
            codeCmd,
            [
              "@echo off",
              "setlocal enabledelayedexpansion",
              'set "VAL=%~1"',
              `>"${argvOutput}" echo(!VAL!`,
              "",
            ].join("\r\n"),
          );
          await mkdir(workspacePath, { recursive: true });

          await openPathInTargetWithRuntime(
            {
              context: { kind: "local" },
              columnNumber: null,
              lineNumber: null,
              path: workspacePath,
              targetId: "vscode",
            },
            createWindowsRuntime({
              calls,
              env: { LOCALAPPDATA: localAppData },
            }),
          );

          const call = calls.find(
            (candidate) => windowsExecutableName(candidate.file) === "cmd.exe",
          );
          expect(call).toBeDefined();

          const runtime = createWorkspaceOpenTargetRuntime();
          await runtime.execFile(
            call?.file ?? "",
            call?.args ?? [],
            call?.options,
          );

          expect((await readFile(argvOutput, "utf8")).trim()).toBe(
            workspacePath,
          );
        } finally {
          await rm(localAppData, { force: true, recursive: true });
          await rm(workspaceRoot, { force: true, recursive: true });
        }
      },
    );

    it("rejects a detached launch whose executable cannot be spawned", async () => {
      const runtime = createWorkspaceOpenTargetRuntime();

      await expect(
        runtime.execFile(
          path.join(tmpdir(), "bb-missing-launcher-does-not-exist"),
          [],
          { detached: true },
        ),
      ).rejects.toMatchObject({ code: "target_unavailable" });
    });

    it("reveals a spaced file path with a quoted Explorer select token", async () => {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), "bb-ws-"));
      const nestedDirectory = path.join(workspaceRoot, "my notes");
      const filePath = path.join(nestedDirectory, "read me.md");
      const calls: WindowsExecFileCall[] = [];

      try {
        await mkdir(nestedDirectory, { recursive: true });
        await writeFile(filePath, "# Notes\n");

        const runtime = createWindowsRuntime({ calls });
        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: filePath,
            targetId: "file-manager",
          },
          runtime,
        );
        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: nestedDirectory,
            targetId: "file-manager",
          },
          runtime,
        );

        expect(calls[0]?.args).toEqual([`/select,"${filePath}"`]);
        expect(calls[0]?.options?.windowsVerbatimArguments).toBe(true);
        expect(calls[1]?.args).toEqual([nestedDirectory]);
        expect(calls[1]?.options?.windowsVerbatimArguments).toBeUndefined();
      } finally {
        await rm(workspaceRoot, { force: true, recursive: true });
      }
    });

    it("ignores a PowerShell script launcher on the Windows Path", async () => {
      const pathDirectory = await createWindowsPathDirectory(["code.ps1"]);

      try {
        const targets = await listWorkspaceOpenTargetsWithRuntime(
          createWindowsRuntime({ env: { Path: pathDirectory } }),
        );

        expect(targets.map((target) => target.id)).not.toContain("vscode");
      } finally {
        await rm(pathDirectory, { force: true, recursive: true });
      }
    });

    it("probes App Paths only for adapters that declare Windows install paths", async () => {
      const calls: WindowsExecFileCall[] = [];

      await listWorkspaceOpenTargetsWithRuntime(
        createWindowsRuntime({ calls }),
      );

      const probedValueNames = calls
        .filter((call) => windowsExecutableName(call.file) === "reg.exe")
        .map((call) => (call.args[1] ?? "").split("\\").pop());

      expect(probedValueNames).toContain("code.exe");
      for (const macOnlyExecutable of [
        "bbedit.exe",
        "mate.exe",
        "xed.exe",
        "osascript.exe",
        "open.exe",
      ]) {
        expect(probedValueNames).not.toContain(macOnlyExecutable);
      }
    });

    it("reports mac-only terminals as unsupported for remote SSH paths", async () => {
      for (const targetId of ["terminal", "iterm2", "ghostty"]) {
        await expect(
          openPathInTargetWithRuntime(
            {
              context: { kind: "remote-ssh", sshAuthority: "devbox" },
              columnNumber: null,
              lineNumber: null,
              path: "/home/me/project",
              targetId,
            },
            createWindowsRuntime({}),
          ),
        ).rejects.toMatchObject({ code: "remote_target_unsupported" });
      }
    });

    it.runIf(process.platform === "win32")(
      "lists the real open targets of this desktop",
      async () => {
        const targets = await listWorkspaceOpenTargets();
        const targetIds = targets.map((target) => target.id);

        expect(targetIds).toContain("file-manager");
        expect(targetIds).toContain("terminal");
        expect(targetIds).toContain("default-app");

        const adapterExecutables = LAUNCH_ADAPTERS.flatMap((adapter) =>
          adapter.macos.openMode === "default-app"
            ? []
            : [
                adapter.macos.pathOpenCommand?.executable,
                adapter.macos.lineOpenCommand?.executable,
              ].filter(
                (executable): executable is string => executable !== undefined,
              ),
        );
        const resolvedExecutables = await Promise.all(
          adapterExecutables.map((command) =>
            resolveExecutable({ command, platform: "win32" }),
          ),
        );
        const staticTargetIds = new Set([
          "default-app",
          "file-manager",
          "terminal",
        ]);
        const discoveredTargetIds = targetIds.filter(
          (targetId) => !staticTargetIds.has(targetId),
        );

        if (resolvedExecutables.some((resolved) => resolved !== null)) {
          expect(discoveredTargetIds.length).toBeGreaterThan(0);
        } else {
          console.log(
            "no adapter executable resolves on this desktop; skipped the discovery assertion",
          );
        }
      },
    );
  });
});
