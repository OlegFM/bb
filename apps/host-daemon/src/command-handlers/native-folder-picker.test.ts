import { POWERSHELL_NONINTERACTIVE_ARGS } from "@bb/process-utils";
import { describe, expect, it } from "vitest";
import { pickHostFolderWithDeps } from "./native-folder-picker.js";

interface RecordedCall {
  args: string[];
  env?: NodeJS.ProcessEnv;
  file: string;
}

function createExecFile(options: {
  calls?: RecordedCall[];
  failure?: Error;
  stdout?: string;
}) {
  return async (
    file: string,
    args: string[],
    execOptions?: { env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string }> => {
    options.calls?.push({ file, args, env: execOptions?.env });
    if (options.failure !== undefined) {
      throw options.failure;
    }
    return { stdout: options.stdout ?? "" };
  };
}

describe("pickHostFolderWithDeps on Windows", () => {
  it("runs the folder browser dialog in a single-threaded apartment", async () => {
    const calls: RecordedCall[] = [];

    await expect(
      pickHostFolderWithDeps({
        env: {},
        execFile: createExecFile({
          calls,
          stdout: "C:\\Work\\bb\r\n",
        }),
        platform: "win32",
      }),
    ).resolves.toEqual({ path: "C:\\Work\\bb" });

    const call = calls[0];
    expect(call?.file.toLowerCase()).toMatch(/(?:pwsh|powershell)\.exe$/u);
    expect(call?.args.slice(0, POWERSHELL_NONINTERACTIVE_ARGS.length)).toEqual([
      ...POWERSHELL_NONINTERACTIVE_ARGS,
    ]);
    expect(call?.args.slice(POWERSHELL_NONINTERACTIVE_ARGS.length, -1)).toEqual(
      ["-STA", "-Command"],
    );
    const script = call?.args.at(-1) ?? "";
    expect(script).toContain("Add-Type -AssemblyName System.Windows.Forms");
    expect(script).toContain("System.Windows.Forms.FolderBrowserDialog");
    expect(script).toContain("$dialog.Description = 'Choose a project folder'");
    expect(script).toContain("$dialog.ShowNewFolderButton = $true");
    expect(script).toContain("$dialog.SelectedPath");
  });

  it("normalizes the selected path", async () => {
    const cases: Array<[string, string | null]> = [
      ["C:\\Work\\bb\\\r\n", "C:\\Work\\bb"],
      ["  C:\\Work\\My Project  \n", "C:\\Work\\My Project"],
      ["\r\n", null],
      ["", null],
      ["C:\\\r\n", "C:\\"],
    ];

    for (const [stdout, expected] of cases) {
      await expect(
        pickHostFolderWithDeps({
          env: {},
          execFile: createExecFile({ stdout }),
          platform: "win32",
        }),
      ).resolves.toEqual({ path: expected });
    }
  });

  it("reports a non-zero exit as a folder picker failure", async () => {
    await expect(
      pickHostFolderWithDeps({
        env: {},
        execFile: createExecFile({
          failure: Object.assign(new Error("Command failed: exit 1"), {
            code: 1,
          }),
        }),
        platform: "win32",
      }),
    ).rejects.toMatchObject({
      code: "folder_picker_failed",
      message: expect.stringContaining("Command failed"),
    });
  });
});

describe("pickHostFolderWithDeps on other platforms", () => {
  it("keeps the macOS osascript prompt", async () => {
    const calls: RecordedCall[] = [];

    await expect(
      pickHostFolderWithDeps({
        execFile: createExecFile({
          calls,
          stdout: "/Users/me/Projects/bb/\n",
        }),
        platform: "darwin",
      }),
    ).resolves.toEqual({ path: "/Users/me/Projects/bb" });
    expect(calls[0]?.file).toBe("osascript");
    expect(calls[0]?.args).toEqual([
      "-e",
      'try\nPOSIX path of (choose folder with prompt "Choose a project folder")\non error number -128\nreturn ""\nend try',
    ]);
  });

  it("rejects unsupported platforms", async () => {
    await expect(
      pickHostFolderWithDeps({
        execFile: createExecFile({}),
        platform: "linux",
      }),
    ).rejects.toMatchObject({
      code: "unsupported_platform",
      message: "Folder picker is only supported on macOS",
    });
  });
});
