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
        platform: "win32",
      });
      const responder = registerHostRpcResponder(harness, {
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
      expect(responder.requests.map((request) => request.command.type)).toEqual(
        ["host.canonicalize_path"],
      );
    }));

  it("never asks a POSIX host to canonicalize", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-canon-posix",
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          throw new Error(`unexpected ${request.command.type}`);
        },
      });
      await expect(
        canonicalizeHostPath(harness.deps, {
          hostId: host.id,
          path: "/srv/link/repo/",
        }),
      ).resolves.toEqual({
        path: "/srv/link/repo",
        pathKey: "/srv/link/repo",
      });
      expect(responder.requests).toEqual([]);
    }));

  it("never asks a wsl host to canonicalize", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-canon-wsl",
        platform: "wsl",
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          throw new Error(`unexpected ${request.command.type}`);
        },
      });
      await expect(
        canonicalizeHostPath(harness.deps, {
          hostId: host.id,
          path: "/srv/link/repo/",
        }),
      ).resolves.toEqual({
        path: "/srv/link/repo",
        pathKey: "/srv/link/repo",
      });
      expect(responder.requests).toEqual([]);
    }));

  it("surfaces daemon path rejections as 400 invalid_path", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-canon-bad",
        platform: "win32",
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

  it("degrades to the shape result when a win32 daemon call fails", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-canon-broken",
        platform: "win32",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: false,
          errorCode: "internal_error",
          errorMessage: "canonicalization crashed",
        }),
      });
      await expect(
        canonicalizeHostPath(harness.deps, {
          hostId: host.id,
          path: "c:/work/bb/",
        }),
      ).resolves.toEqual({ path: "C:\\work\\bb", pathKey: "c:/work/bb" });
      await expect(
        canonicalizeHostPath(harness.deps, {
          hostId: host.id,
          path: "\\\\server\\share\\bb",
        }),
      ).rejects.toMatchObject({
        status: 400,
        body: { code: "invalid_path" },
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

  it("refuses unsupported shapes in the offline fallback", async () =>
    withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-canon-offline-shapes" });
      const refuse = (path: string) =>
        expect(
          canonicalizeHostPath(harness.deps, { hostId: host.id, path }),
        ).rejects.toMatchObject({
          status: 400,
          body: { code: "invalid_path" },
        });

      await refuse("\\\\server\\share\\bb");
      await refuse("work/bb");
      await refuse("C:");
    }));

  it("keeps POSIX paths as typed in the offline fallback", async () =>
    withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-canon-offline-posix" });
      await expect(
        canonicalizeHostPath(harness.deps, {
          hostId: host.id,
          path: "/srv/missing/repo/",
        }),
      ).resolves.toEqual({
        path: "/srv/missing/repo",
        pathKey: "/srv/missing/repo",
      });
      await expect(
        canonicalizeHostPath(harness.deps, {
          hostId: host.id,
          path: "//server/share/bb",
        }),
      ).resolves.toEqual({
        path: "//server/share/bb",
        pathKey: "//server/share/bb",
      });
    }));

  it("names both accepted shapes when the offline fallback refuses a UNC path", async () =>
    withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-canon-offline-unc" });
      await expect(
        canonicalizeHostPath(harness.deps, {
          hostId: host.id,
          path: "\\\\server\\share\\bb",
        }),
      ).rejects.toMatchObject({
        status: 400,
        body: {
          code: "invalid_path",
          message: expect.stringContaining(
            "use an absolute path on the machine, such as /home/me/repo or C:\\Users\\me\\repo",
          ),
        },
      });
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
