import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveParentProcessPid,
  startParentProcessWatchdog,
} from "../src/parent-watchdog.js";

describe("resolveParentProcessPid", () => {
  it("reads the desktop parent pid on Windows", () => {
    expect(
      resolveParentProcessPid({
        env: { BB_DESKTOP_PARENT_PID: "4242" },
        platform: "win32",
      }),
    ).toBe(4242);
  });

  it("ignores the variable on POSIX where the desktop uses signals", () => {
    expect(
      resolveParentProcessPid({
        env: { BB_DESKTOP_PARENT_PID: "4242" },
        platform: "linux",
      }),
    ).toBeNull();
    expect(
      resolveParentProcessPid({
        env: { BB_DESKTOP_PARENT_PID: "4242" },
        platform: "darwin",
      }),
    ).toBeNull();
  });

  it("rejects malformed pids", () => {
    for (const value of ["", " ", "0", "-1", "12.5", "abc"]) {
      expect(
        resolveParentProcessPid({
          env: { BB_DESKTOP_PARENT_PID: value },
          platform: "win32",
        }),
      ).toBeNull();
    }
    expect(resolveParentProcessPid({ env: {}, platform: "win32" })).toBeNull();
  });
});

describe("startParentProcessWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once when the parent disappears and stops polling", () => {
    let alive = true;
    const checked: number[] = [];
    const onParentExit = vi.fn();
    const stop = startParentProcessWatchdog({
      env: { BB_DESKTOP_PARENT_PID: "4242" },
      intervalMs: 2_000,
      isProcessAlive(pid) {
        checked.push(pid);
        return alive;
      },
      onParentExit,
      platform: "win32",
    });

    vi.advanceTimersByTime(2_000);
    expect(onParentExit).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(2_000);
    expect(onParentExit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6_000);
    expect(onParentExit).toHaveBeenCalledTimes(1);
    expect(checked).toEqual([4242, 4242]);
    stop();
  });

  it("stops checking after stop() is called", () => {
    const isProcessAlive = vi.fn(() => false);
    const onParentExit = vi.fn();
    const stop = startParentProcessWatchdog({
      env: { BB_DESKTOP_PARENT_PID: "4242" },
      intervalMs: 2_000,
      isProcessAlive,
      onParentExit,
      platform: "win32",
    });

    stop();
    vi.advanceTimersByTime(10_000);
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(onParentExit).not.toHaveBeenCalled();
  });

  it("schedules nothing without a Windows parent pid", () => {
    const isProcessAlive = vi.fn(() => false);
    const stop = startParentProcessWatchdog({
      env: { BB_DESKTOP_PARENT_PID: "4242" },
      intervalMs: 2_000,
      isProcessAlive,
      onParentExit: vi.fn(),
      platform: "linux",
    });

    vi.advanceTimersByTime(10_000);
    expect(isProcessAlive).not.toHaveBeenCalled();
    stop();
  });
});
