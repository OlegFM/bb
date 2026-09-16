import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveDesktopQuitRequestFile,
  watchDesktopQuitRequestFile,
} from "../src/desktop-quit-request.js";

describe("resolveDesktopQuitRequestFile", () => {
  it("honours the request file only on Windows", () => {
    expect(
      resolveDesktopQuitRequestFile({
        env: { BB_DESKTOP_QUIT_REQUEST_FILE: "C:\\smoke\\quit" },
        platform: "win32",
      }),
    ).toBe("C:\\smoke\\quit");
    expect(
      resolveDesktopQuitRequestFile({
        env: { BB_DESKTOP_QUIT_REQUEST_FILE: "/tmp/quit" },
        platform: "linux",
      }),
    ).toBeNull();
    expect(
      resolveDesktopQuitRequestFile({
        env: { BB_DESKTOP_QUIT_REQUEST_FILE: "/tmp/quit" },
        platform: "darwin",
      }),
    ).toBeNull();
  });

  it("ignores an unset or blank variable", () => {
    expect(
      resolveDesktopQuitRequestFile({ env: {}, platform: "win32" }),
    ).toBeNull();
    expect(
      resolveDesktopQuitRequestFile({
        env: { BB_DESKTOP_QUIT_REQUEST_FILE: "   " },
        platform: "win32",
      }),
    ).toBeNull();
  });
});

describe("watchDesktopQuitRequestFile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once when the file appears and stops polling afterwards", () => {
    let exists = false;
    const fileExists = vi.fn(() => exists);
    const onRequest = vi.fn();
    const watcher = watchDesktopQuitRequestFile({
      fileExists,
      filePath: "C:\\smoke\\quit",
      onRequest,
      pollMs: 500,
    });

    vi.advanceTimersByTime(500);
    expect(onRequest).not.toHaveBeenCalled();
    exists = true;
    vi.advanceTimersByTime(500);
    expect(onRequest).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(fileExists).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("stops polling when stopped", () => {
    const fileExists = vi.fn(() => true);
    const watcher = watchDesktopQuitRequestFile({
      fileExists,
      filePath: "C:\\smoke\\quit",
      onRequest: vi.fn(),
      pollMs: 500,
    });

    watcher.stop();
    vi.advanceTimersByTime(5_000);
    expect(fileExists).not.toHaveBeenCalled();
  });
});
