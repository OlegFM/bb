import { describe, expect, it } from "vitest";
import {
  CURSOR_ACP_MAINTENANCE,
  __testing,
  getAcpProviderInstallationStatus,
} from "./provider-maintenance.js";

function cursorMissingInstallationStatus() {
  return {
    executableName: "cursor-agent",
    executablePath: null,
    installed: false,
    installSource: "notInstalled" as const,
    currentVersion: null,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: {
      kind: "install" as const,
      label: "Install" as const,
      command: "install Cursor",
    },
    installUnavailableReason: null,
    needsUpdate: false,
    versionUnsupported: false,
  };
}

const CURSOR_WINDOWS_REASON =
  "bb cannot run the Cursor Agent shell installer on Windows. Install Cursor Agent from https://cursor.com/install, then reload.";

describe("ACP provider maintenance", () => {
  it("normalizes Cursor plan and spend limits without reading daemon state", () => {
    expect(
      __testing.normalizeUsage(
        {
          billingCycleEnd: "1767225600000",
          planUsage: { totalPercentUsed: 72.2 },
          spendLimitUsage: {
            overallUsed: "1250",
            overallLimit: "5000",
          },
        },
        { planInfo: { planName: "Pro" } },
        "cursor@example.com",
      ),
    ).toEqual({
      status: "ok",
      accountEmail: "cursor@example.com",
      planLabel: "Pro",
      windows: [
        {
          label: "Plan usage",
          usedPercent: 72,
          resetsAt: "2026-01-01T00:00:00.000Z",
        },
        {
          label: "On-demand spend",
          usedPercent: 25,
          resetsAt: "2026-01-01T00:00:00.000Z",
          cost: { usedUsdCents: 1250, limitUsdCents: 5000 },
        },
      ],
    });
  });

  it("offers the installer only through a fresh matching action", () => {
    expect(
      __testing.buildProviderInstallationRun(
        cursorMissingInstallationStatus(),
        {
          maintenance: CURSOR_ACP_MAINTENANCE,
          command: "cursor-agent",
          action: "install",
          platform: "linux",
          env: {},
        },
      ),
    ).toMatchObject({
      available: true,
      command: { command: "sh" },
      verification: { kind: "installed" },
    });
  });

  it("reports why the shell installer cannot run on win32", async () => {
    const status = await getAcpProviderInstallationStatus({
      maintenance: CURSOR_ACP_MAINTENANCE,
      command: "cursor-agent",
      platform: "win32",
      env: {},
    });

    expect(status.installed).toBe(false);
    expect(status.installAction).toBeNull();
    expect(status.installUnavailableReason).toBe(CURSOR_WINDOWS_REASON);
    expect(
      __testing.buildProviderInstallationRun(status, {
        maintenance: CURSOR_ACP_MAINTENANCE,
        command: "cursor-agent",
        action: "install",
        platform: "win32",
        env: {},
      }),
    ).toEqual({ available: false, message: CURSOR_WINDOWS_REASON });
  });

  it("keeps the posix install action and no reason", async () => {
    const status = await getAcpProviderInstallationStatus({
      maintenance: CURSOR_ACP_MAINTENANCE,
      command: "bb-absent-cursor-agent",
      platform: "linux",
      env: {},
    });

    expect(status.installAction).toMatchObject({
      kind: "install",
      label: "Install",
    });
    expect(status.installUnavailableReason).toBeNull();
  });

  it("refuses an install for an unmatched or unmaintained command", () => {
    expect(
      __testing.buildProviderInstallationRun(
        { ...cursorMissingInstallationStatus(), installAction: null },
        { maintenance: undefined, command: "opencode", action: "install" },
      ),
    ).toEqual({
      available: false,
      message: "opencode install is not available on this host.",
    });
    expect(
      __testing.buildProviderInstallationRun(
        cursorMissingInstallationStatus(),
        {
          maintenance: undefined,
          command: "opencode",
          action: "install",
        },
      ),
    ).toEqual({
      available: false,
      message: "opencode install is not available on this host.",
    });
  });
});
