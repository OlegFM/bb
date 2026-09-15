import { describe, expect, it, vi } from "vitest";
import type { Host } from "@bb/domain";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import {
  formatMachineLastSeen,
  registerMachineCommands,
  resolveMachineId,
} from "../../commands/machine.js";

const hosts: Host[] = [
  {
    id: "host-primary",
    name: "workstation",
    type: "persistent",
    status: "connected",
    maxPermissionMode: "full",
    lastSeenAt: 1_700_000_000_000,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: "host-remote",
    name: "laptop",
    type: "persistent",
    status: "disconnected",
    maxPermissionMode: "full",
    lastSeenAt: null,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 2,
  },
];

describe("bb machine command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerMachineCommands(program, () => "http://server");

  it("bb machine list --json prints the raw host list", async () => {
    stubServerApi({ "v1.hosts.$get": vi.fn(async () => hosts) });

    await runCommand(["machine", "list", "--json"], register);

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(hosts);
  });

  it("bb machine list renders names, IDs, status, and relative last seen", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_120_000);
    stubServerApi({ "v1.hosts.$get": vi.fn(async () => hosts) });

    await runCommand(["machine", "list"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "Name         ID            Status        Last seen\n-----------  ------------  ------------  ---------\nworkstation  host-primary  connected     2m ago\n-----------  ------------  ------------  ---------\nlaptop       host-remote   disconnected  never",
      "",
    ]);
  });

  it("bb machine retry-update resolves the machine and requests a retry", async () => {
    const retryUpdate = vi.fn(async () => ({ ok: true as const }));
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.retry-update.$post": retryUpdate,
    });

    await runCommand(["machine", "retry-update", "laptop"], register);

    expect(retryUpdate).toHaveBeenCalledOnce();
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Machine host-remote update retry requested",
    ]);
  });

  const providerCliStatusReason =
    "bb needs bun or npm on Path to install Pi on Windows. Install Node.js or Bun, then reload.";

  function stubProviderCliStatus(): void {
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () => ({
        pi: {
          displayName: "Pi",
          executableName: "pi",
          executablePath: null,
          installed: false,
          installSource: "notInstalled" as const,
          currentVersion: null,
          latestVersion: "0.85.0",
          minimumSupportedVersion: "0.84.0",
          npmPackageName: "@earendil-works/pi-coding-agent",
          npmGlobalPackageVersion: null,
          installAction: null,
          installUnavailableReason: providerCliStatusReason,
          needsUpdate: false,
          versionUnsupported: false,
        },
      })),
    });
  }

  it("bb machine provider-cli status keeps stdout parseable and reports the reason on stderr", async () => {
    stubProviderCliStatus();

    await runCommand(
      ["machine", "provider-cli", "status", "workstation"],
      register,
    );

    const payloads = collectLogPayloads(vi.mocked(console.log));
    expect(payloads).toHaveLength(1);
    expect(JSON.parse(String(payloads[0])).pi.installUnavailableReason).toBe(
      providerCliStatusReason,
    );
    expect(collectLogPayloads(vi.mocked(console.error))).toEqual([
      `Pi: ${providerCliStatusReason}`,
    ]);
  });

  it("bb machine provider-cli status --json prints only the JSON document", async () => {
    stubProviderCliStatus();

    await runCommand(
      ["machine", "provider-cli", "status", "workstation", "--json"],
      register,
    );

    const payloads = collectLogPayloads(vi.mocked(console.log));
    expect(payloads).toHaveLength(1);
    expect(() => JSON.parse(String(payloads[0]))).not.toThrow();
    expect(JSON.parse(String(payloads[0])).pi.installUnavailableReason).toBe(
      providerCliStatusReason,
    );
    expect(collectLogPayloads(vi.mocked(console.error))).toEqual([]);
  });
});

describe("machine selection", () => {
  it("resolves an ID before names", () => {
    expect(resolveMachineId(hosts, "host-primary")).toBe("host-primary");
  });

  it("resolves an unambiguous name", () => {
    expect(resolveMachineId(hosts, "laptop")).toBe("host-remote");
  });

  it("lists matching IDs for an ambiguous name", () => {
    expect(() =>
      resolveMachineId(
        [...hosts, { ...hosts[0], id: "host-other" }],
        "workstation",
      ),
    ).toThrow(
      "Machine name 'workstation' is ambiguous. Matches: workstation (host-primary), workstation (host-other).",
    );
  });

  it("lists available machines for an unknown selector", () => {
    expect(() => resolveMachineId(hosts, "desktop")).toThrow(
      "Machine 'desktop' was not found. Available machines: workstation (host-primary), laptop (host-remote).",
    );
  });

  it("formats future clock skew as just now", () => {
    expect(formatMachineLastSeen(101, 100)).toBe("just now");
  });
});
