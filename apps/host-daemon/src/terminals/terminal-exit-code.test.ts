import { describe, expect, it } from "vitest";
import {
  normalizeTerminalExitCode,
  WINDOWS_CONTROL_C_EXIT_CODE,
} from "./terminal-exit-code.js";

describe("normalizeTerminalExitCode", () => {
  it("drops the ConPTY control-c code after a bb-requested close on Windows", () => {
    expect(WINDOWS_CONTROL_C_EXIT_CODE).toBe(-1073741510);
    expect(
      normalizeTerminalExitCode({
        closeRequested: true,
        exitCode: WINDOWS_CONTROL_C_EXIT_CODE,
        platform: "win32",
      }),
    ).toBeNull();
  });

  it("keeps the code when the shell died on its own or on any other code", () => {
    expect(
      normalizeTerminalExitCode({
        closeRequested: false,
        exitCode: WINDOWS_CONTROL_C_EXIT_CODE,
        platform: "win32",
      }),
    ).toBe(WINDOWS_CONTROL_C_EXIT_CODE);
    expect(
      normalizeTerminalExitCode({
        closeRequested: true,
        exitCode: 1,
        platform: "win32",
      }),
    ).toBe(1);
    expect(
      normalizeTerminalExitCode({
        closeRequested: true,
        exitCode: 0,
        platform: "win32",
      }),
    ).toBe(0);
  });

  it("never touches POSIX exit codes", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(
        normalizeTerminalExitCode({
          closeRequested: true,
          exitCode: WINDOWS_CONTROL_C_EXIT_CODE,
          platform,
        }),
      ).toBe(WINDOWS_CONTROL_C_EXIT_CODE);
    }
  });
});
