import { describe, expect, it } from "vitest";
import {
  canonicalizeHostPath,
  managedWorkspaceRoots,
} from "../../../src/services/hosts/host-paths.js";
import { registerHostRpcResponder } from "../../helpers/host-rpc.js";
import { seedHost, seedHostSession } from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

describe("canonicalizeHostPath", () => {
  it("returns the daemon's canonical path and key", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-canon",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type !== "host.canonicalize_path") {
            throw new Error(`unexpected ${request.command.type}`);
          }
          return {
            ok: true,
            result: { path: "C:\\Work\\bb", pathKey: "c:/work/bb" },
          };
        },
      });
      await expect(
        canonicalizeHostPath(harness.deps, {
          hostId: host.id,
          path: "c:/work/bb/",
        }),
      ).resolves.toEqual({ path: "C:\\Work\\bb", pathKey: "c:/work/bb" });
    }));

  it("surfaces daemon path rejections as 400 invalid_path", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-canon-bad",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: false,
          errorCode: "invalid_path",
          errorMessage:
            'Path "\\\\srv\\x" is a UNC or device path; only drive-letter paths are supported',
        }),
      });
      await expect(
        canonicalizeHostPath(harness.deps, {
          hostId: host.id,
          path: "\\\\srv\\x",
        }),
      ).rejects.toMatchObject({
        status: 400,
        body: {
          code: "invalid_path",
          message:
            'Path "\\\\srv\\x" is a UNC or device path; only drive-letter paths are supported',
        },
      });
    }));

  it("falls back to shape normalization when the host is offline", async () =>
    withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-canon-offline" });
      await expect(
        canonicalizeHostPath(harness.deps, {
          hostId: host.id,
          path: "c:/work/bb/",
        }),
      ).resolves.toEqual({ path: "C:\\work\\bb", pathKey: "c:/work/bb" });
    }));
});

describe("managedWorkspaceRoots", () => {
  it("builds managed roots with the host's separator", () => {
    expect(managedWorkspaceRoots("/home/me/.bb")).toEqual([
      "/home/me/.bb/worktrees",
      "/home/me/.bb/personal-workspaces",
    ]);
    expect(managedWorkspaceRoots("C:\\Users\\me\\.bb")).toEqual([
      "C:\\Users\\me\\.bb\\worktrees",
      "C:\\Users\\me\\.bb\\personal-workspaces",
    ]);
  });
});
