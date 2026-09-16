// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Host } from "@bb/domain";
import { makeHost as host } from "@bb/test-helpers/domain-fixtures";
import type { InstalledPlugin } from "@bb/server-contract";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BbHttpError, sdk } from "@/lib/sdk";
import { hostsQueryKey } from "@/hooks/queries/query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { AddMachineDialog } from "./AddMachineDialog";
import { makeInstalledPlugin } from "@/test/fixtures/plugins";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...original,
    sdk: {
      hosts: {
        createJoinCode: vi.fn(),
        list: vi.fn(),
      },
      plugins: { callRpc: vi.fn(), list: vi.fn() },
    },
  };
});

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

const existingHost = host({ id: "host_primary", name: "MacBook Pro" });

function connectPlugin(
  overrides: Pick<InstalledPlugin, "enabled" | "status">,
): InstalledPlugin {
  return makeInstalledPlugin({
    id: "connect",
    source: "builtin:connect",
    rootDir: "/plugins/connect",
    provenance: "builtin",
    publisherLabel: "BB Official",
    sourceDisplay: "builtin · connect",
    name: "Remote access",
    hasSettings: true,
    ...overrides,
  });
}

function notRunningRpcError(status: string): BbHttpError {
  const message = `plugin "connect" is not running (status: ${status})`;
  return new BbHttpError({
    body: { ok: false, error: message },
    code: null,
    message,
    status: 503,
  });
}
const writeTextMock = vi.fn().mockResolvedValue(undefined);
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeTextMock },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

describe("AddMachineDialog", () => {
  async function renderPairingCommand({
    direct = false,
    joinCode = "jc_test123",
    hostId = "host_new",
    machineCode = "mc_test456",
    serverUrl = "https://example.getbb.app",
    expired = false,
  } = {}) {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode,
      hostId,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    if (direct) {
      vi.mocked(sdk.plugins.callRpc).mockRejectedValue(
        new BbHttpError({
          body: null,
          code: "not_paired",
          message: "not_paired",
          status: 404,
        }),
      );
    } else {
      vi.mocked(sdk.plugins.callRpc).mockResolvedValue({
        code: machineCode,
        expiresAt: Date.now() + (expired ? -1000 : 10 * 60 * 1000),
        serverUrl,
      });
    }
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);
    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl={direct ? serverUrl : "http://direct.example.test:38886"}
        />
      </MemoryRouter>,
      { wrapper },
    );
    return screen.findByText(/curl -fL/u);
  }

  it("copies the selected target shell and restores the unchanged default POSIX command", async () => {
    const command = await renderPairingCommand();
    const posix =
      "curl -fL --progress-meter --connect-timeout 10 --max-time 60 --retry 2 https://example.getbb.app/install.sh | sh -s -- --join-code jc_test123 --host-id host_new --server https://example.getbb.app --machine-code mc_test456";
    expect(command.textContent).toBe(posix);
    expect(
      screen
        .getByRole("button", { name: "macOS / Linux" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Windows PowerShell" }));
    const windowsCommand = screen.getByText(/Invoke-WebRequest/u);
    expect(windowsCommand.textContent).toContain(
      "-Uri 'https://example.getbb.app/install.ps1'",
    );
    expect(windowsCommand.textContent).toContain("-UseBasicParsing");
    expect(windowsCommand.textContent).toContain(
      "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $bbInstaller -JoinCode 'jc_test123' -HostId 'host_new' -Server 'https://example.getbb.app' -MachineCode 'mc_test456'",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith(windowsCommand.textContent),
    );
    fireEvent.click(screen.getByRole("button", { name: "macOS / Linux" }));
    expect(screen.getByText(/curl -fL/u).textContent).toBe(posix);
    fireEvent.click(screen.getByRole("button", { name: /Copy|Copied/u }));
    await waitFor(() => expect(writeTextMock).toHaveBeenLastCalledWith(posix));
  });

  it("uses the direct server without a Connect code for Windows", async () => {
    await renderPairingCommand({
      direct: true,
      serverUrl: "http://direct.example.test:38886",
    });
    fireEvent.click(screen.getByRole("button", { name: "Windows PowerShell" }));
    const command = screen.getByText(/Invoke-WebRequest/u).textContent;
    expect(command).toContain(
      "-Uri 'http://direct.example.test:38886/install.ps1'",
    );
    expect(command).toContain("-Server 'http://direct.example.test:38886'");
    expect(command).not.toContain("-MachineCode");
  });

  it("keeps copying disabled after the earlier Connect code expires while switching shells", async () => {
    await renderPairingCommand({ expired: true });
    expect(screen.getByText("Code expired")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Windows PowerShell" }));
    const copyButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Copy",
    });
    expect(copyButton.disabled).toBe(true);
    fireEvent.click(copyButton);
    expect(writeTextMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Generate a new code" }),
    ).toBeDefined();
  });

  describe
    .skipIf(process.platform !== "win32")
    .each(["powershell.exe", "pwsh.exe"])("copied command in %s", (shell) => {
    function executeCommand(
      command: string,
      childExit: number,
      failDownload = false,
    ) {
      const directory = mkdtempSync(join(tmpdir(), "bb-pairing-command-"));
      const fixture = join(directory, "fixture.ps1");
      const wrapper = join(directory, "wrapper.ps1");
      const output = join(directory, "arguments.json");
      writeFileSync(
        fixture,
        "param([string]$JoinCode,[string]$HostId,[string]$Server,[string]$MachineCode)\n@{ joinCode=$JoinCode; hostId=$HostId; server=$Server; machineCode=$MachineCode; uri=$env:BB_PAIRING_URI } | ConvertTo-Json | Set-Content -LiteralPath $env:BB_PAIRING_OUTPUT -Encoding UTF8\nexit " +
          childExit,
      );
      writeFileSync(
        wrapper,
        "\uFEFFfunction Invoke-WebRequest { [CmdletBinding()]param([string]$Uri,[string]$OutFile,[switch]$UseBasicParsing)\nCopy-Item -LiteralPath $env:BB_PAIRING_FIXTURE -Destination $OutFile; if ($env:BB_PAIRING_FAIL_DOWNLOAD -eq 'true') { throw 'Download failed' }; $env:BB_PAIRING_URI=$Uri }\n$PSNativeCommandArgumentPassing = 'Standard'\n" +
          command +
          "\nif ($PSNativeCommandArgumentPassing -cne 'Standard') { throw 'Caller argument mode changed' }",
      );
      try {
        const result = spawnSync(
          shell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            wrapper,
          ],
          {
            env: {
              ...process.env,
              TMP: directory,
              TEMP: directory,
              BB_PAIRING_FIXTURE: fixture,
              BB_PAIRING_OUTPUT: output,
              BB_PAIRING_FAIL_DOWNLOAD: String(failDownload),
            },
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
          },
        );
        expect(result.error).toBeUndefined();
        expect(readdirSync(directory).sort()).toEqual(
          failDownload
            ? ["fixture.ps1", "wrapper.ps1"]
            : ["arguments.json", "fixture.ps1", "wrapper.ps1"],
        );
        return {
          result,
          arguments: failDownload
            ? null
            : JSON.parse(readFileSync(output, "utf8").replace(/^\uFEFF/u, "")),
        };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    it.each([
      "jc_' \" ; throw 'INJECTION'; # $(throw 'INJECTION')",
      'jc_\\"quoted value\\\\" trailing\\',
      'jc_\\"quoted\\\\"trailing\\',
      "jc_\u2019; throw 123; Write-Output \u2018",
      "jc_\u2018; throw 123; Write-Output \u2019",
      "jc_\u201b; throw 123; Write-Output \u201b",
      "jc_\u201a; throw 123; Write-Output \u201a",
    ])(
      "passes quotes and PowerShell expressions as inert named arguments and removes the downloaded script: %s",
      async (maliciousCode) => {
        const maliciousMachineCode = "mc_'$(throw 'INJECTION')";
        const serverUrl = "https://example.test/'$(throw 'INJECTION')";
        await renderPairingCommand({
          joinCode: maliciousCode,
          machineCode: maliciousMachineCode,
          serverUrl,
        });
        fireEvent.click(
          screen.getByRole("button", { name: "Windows PowerShell" }),
        );
        const { result, arguments: received } = executeCommand(
          screen.getByText(/Invoke-WebRequest/u).textContent ?? "",
          0,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(received).toEqual({
          joinCode: maliciousCode,
          hostId: "host_new",
          server: serverUrl,
          machineCode: maliciousMachineCode,
          uri: serverUrl + "/install.ps1",
        });
      },
    );

    it("reports a child installer failure and still removes only the downloaded script", async () => {
      await renderPairingCommand();
      fireEvent.click(
        screen.getByRole("button", { name: "Windows PowerShell" }),
      );
      const { result } = executeCommand(
        screen.getByText(/Invoke-WebRequest/u).textContent ?? "",
        41,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("41");
    });

    it("terminates on download failure without invoking the installer or leaking a temp file", async () => {
      await renderPairingCommand();
      fireEvent.click(
        screen.getByRole("button", { name: "Windows PowerShell" }),
      );
      const { result } = executeCommand(
        screen.getByText(/Invoke-WebRequest/u).textContent ?? "",
        0,
        true,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Download failed");
    });
  });

  it("mints a join code, shows the pairing command, and detects the new machine connecting", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.plugins.callRpc).mockResolvedValue({
      code: "mc_test456",
      expiresAt: Date.now() + 10 * 60 * 1000,
      serverUrl: "https://example.getbb.app",
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="http://direct.example.test:38886"
        />
      </MemoryRouter>,
      { wrapper },
    );

    const command = await screen.findByText(/--join-code jc_test123/);
    expect(sdk.plugins.callRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "connect",
        method: "createMachineCode",
        input: null,
      }),
    );
    expect(command.textContent).toContain("--host-id host_new");
    expect(command.textContent).toContain(
      "curl -fL --progress-meter --connect-timeout 10 --max-time 60 --retry 2 https://example.getbb.app/install.sh",
    );
    expect(command.textContent).toContain("--server https://example.getbb.app");
    expect(command.textContent).toContain("--machine-code mc_test456");
    expect(command.textContent).not.toContain(window.location.origin);
    expect(command.closest("[data-add-machine-command]")).not.toBeNull();
    expect(
      screen.getByText(
        /It installs bb and keeps the machine connected to this server/u,
      ),
    ).toBeDefined();
    expect(screen.getByText(/Code expires in \d+:\d{2}/)).toBeDefined();
    const waiting = screen.getByText("Waiting for the machine to connect…");
    expect(waiting).toBeDefined();
    expect(waiting.parentElement?.className).not.toContain("border-border");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(command.textContent);
      expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
    });

    await waitFor(() => {
      expect(queryClient.getQueryData<Host[]>(hostsQueryKey())).toHaveLength(1);
    });

    act(() => {
      queryClient.setQueryData<Host[]>(hostsQueryKey(), [
        existingHost,
        host({ id: "host_new", name: "Mac Studio" }),
      ]);
    });

    expect(await screen.findByText("Mac Studio connected")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Set up a project on it →" }),
    ).toBeDefined();
    expect(
      screen.queryByText("Waiting for the machine to connect…"),
    ).toBeNull();
  });

  it("falls back to direct pairing when connect is unpaired and ignores known hosts", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.plugins.callRpc).mockRejectedValue(
      new BbHttpError({
        body: {
          ok: false,
          error: { code: "handler_error", message: "not_paired" },
        },
        code: "handler_error",
        message: "not_paired",
        status: 500,
      }),
    );
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      existingHost,
      host({ id: "host_offline", name: "dev-vm", status: "disconnected" }),
    ]);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="http://direct.example.test:38886"
        />
      </MemoryRouter>,
      { wrapper },
    );

    const command = await screen.findByText(/--join-code jc_test123/);
    expect(command.textContent).toContain(
      "curl -fL --progress-meter --connect-timeout 10 --max-time 60 --retry 2 http://direct.example.test:38886/install.sh",
    );
    expect(command.textContent).toContain(
      "--server http://direct.example.test:38886",
    );
    expect(command.textContent).not.toContain("--machine-code");

    await waitFor(() => {
      expect(queryClient.getQueryData<Host[]>(hostsQueryKey())).toHaveLength(2);
    });

    act(() => {
      queryClient.setQueryData<Host[]>(hostsQueryKey(), [
        existingHost,
        host({ id: "host_offline", name: "dev-vm" }),
      ]);
    });

    expect(
      await screen.findByText("Waiting for the machine to connect…"),
    ).toBeDefined();
    expect(screen.queryByText("dev-vm connected")).toBeNull();
  });

  it("explains that a loopback server is unreachable when connect is unpaired", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.plugins.callRpc).mockRejectedValue(
      new BbHttpError({
        body: {
          ok: false,
          error: { code: "handler_error", message: "not_paired" },
        },
        code: "handler_error",
        message: "not_paired",
        status: 500,
      }),
    );
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);

    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="http://127.0.0.1:38886"
        />
      </MemoryRouter>,
      { wrapper },
    );

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain(
      "Another machine cannot use this address.",
    );
    expect(notice.textContent).toContain("http://127.0.0.1:38886");
    expect(screen.queryByText(/--join-code jc_test123/)).toBeNull();
    const link = screen.getByRole("link", { name: "Set up remote access" });
    expect(link.getAttribute("href")).toBe("/settings/plugins/connect");
    expect(
      screen.queryByText("Waiting for the machine to connect…"),
    ).toBeNull();
  });

  it("offers a retry when connect is temporarily unavailable on a loopback server", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.plugins.callRpc).mockRejectedValue(
      notRunningRpcError("degraded"),
    );
    vi.mocked(sdk.plugins.list).mockResolvedValue({
      plugins: [connectPlugin({ enabled: true, status: "degraded" })],
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);

    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="http://0.0.0.0:38886"
        />
      </MemoryRouter>,
      { wrapper },
    );

    expect(
      await screen.findByText("Remote access isn't ready yet."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    expect(screen.queryByText(/--join-code jc_test123/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("links to the Connect plugin when it is disabled on a loopback server", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.plugins.callRpc).mockRejectedValue(
      notRunningRpcError("disabled"),
    );
    vi.mocked(sdk.plugins.list).mockResolvedValue({
      plugins: [connectPlugin({ enabled: false, status: "disabled" })],
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);

    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="http://127.0.0.1:38886"
        />
      </MemoryRouter>,
      { wrapper },
    );

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("The Connect plugin is disabled");
    const link = screen.getByRole("link", {
      name: "Enable the Connect plugin",
    });
    expect(link.getAttribute("href")).toBe(
      "/settings/plugins/connect?view=installed",
    );
    expect(screen.queryByText("Remote access isn't ready yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(
      screen.queryByText("Waiting for the machine to connect…"),
    ).toBeNull();
    expect(screen.queryByText(/--join-code jc_test123/)).toBeNull();
  });
});
