import { buildHostPathKey } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  handleUpdateEnvironmentDirectoryToolCall,
  normalizeEnvironmentDirectoryPath,
  validateEnvironmentDirectoryPath,
} from "../../src/services/threads/thread-environment-directory.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("validateEnvironmentDirectoryPath", () => {
  it("accepts absolute paths of both flavors", () => {
    expect(validateEnvironmentDirectoryPath("/srv/repo")).toBeNull();
    expect(validateEnvironmentDirectoryPath("C:\\Work\\bb")).toBeNull();
    expect(validateEnvironmentDirectoryPath("c:/work/bb")).toBeNull();
  });

  it("rejects relative, root, UNC and NUL paths", () => {
    expect(validateEnvironmentDirectoryPath("repo")).toMatch(/absolute/u);
    expect(validateEnvironmentDirectoryPath("/")).toMatch(/filesystem root/u);
    expect(validateEnvironmentDirectoryPath("C:\\")).toMatch(
      /filesystem root/u,
    );
    expect(validateEnvironmentDirectoryPath("\\\\server\\share\\repo")).toMatch(
      /UNC/u,
    );
    expect(validateEnvironmentDirectoryPath("/srv/re\0po")).toMatch(/NUL/u);
  });

  it("refuses separator-only input with the pre-port message", () => {
    for (const input of ["//", "///", " // "]) {
      expect(
        validateEnvironmentDirectoryPath(
          normalizeEnvironmentDirectoryPath(input),
        ),
      ).toBe("Path must be an absolute path on the current host.");
    }
    expect(
      validateEnvironmentDirectoryPath(normalizeEnvironmentDirectoryPath("/")),
    ).toBe("Path must name a project directory, not the filesystem root.");
  });

  it("normalizes non-Windows input exactly as before the Windows port", () => {
    expect(normalizeEnvironmentDirectoryPath(" /srv/repo/ ")).toBe("/srv/repo");
    expect(normalizeEnvironmentDirectoryPath("//srv/repo/")).toBe("//srv/repo");
    expect(normalizeEnvironmentDirectoryPath("/srv//repo")).toBe("/srv//repo");
    expect(normalizeEnvironmentDirectoryPath("/")).toBe("/");
    expect(normalizeEnvironmentDirectoryPath("//")).toBe("");
    expect(normalizeEnvironmentDirectoryPath("repo/")).toBe("repo");
    expect(normalizeEnvironmentDirectoryPath("c:/work/bb/")).toBe(
      "C:\\work\\bb",
    );
  });
});

describe("update_environment_directory managed-root containment", () => {
  it("refuses a managed workspace reached through a symlinked data dir", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-managed-symlink",
        platform: "win32",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-symlink",
      });
      const current = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-symlink",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: current.id,
        status: "idle",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type !== "host.canonicalize_path") {
            throw new Error(`unexpected ${request.command.type}`);
          }
          const path = request.command.path.replace(
            "/tmp/bb-host-data/",
            "/private/bb-data/",
          );
          return {
            ok: true,
            result: { path, pathKey: buildHostPathKey(path) },
          };
        },
      });

      const result = await handleUpdateEnvironmentDirectoryToolCall(
        harness.deps,
        {
          currentEnvironment: current,
          thread,
          turnId: "turn-managed-symlink",
          input: { path: `/tmp/bb-host-data/${host.id}/worktrees/env_x/repo` },
        },
      );

      expect(result).toMatchObject({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining(
              "bb-managed workspace owned by another project",
            ),
          },
        ],
      });
    }));

  it("reports a stored Windows path as already in use when only its casing differs", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-case-insensitive",
        platform: "win32",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "C:\\Work\\bb",
      });
      const current = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "C:\\work\\bb",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: current.id,
        status: "idle",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: true,
          result: {
            path: "C:\\Work\\bb",
            pathKey: buildHostPathKey("C:\\Work\\bb"),
          },
        }),
      });

      const result = await handleUpdateEnvironmentDirectoryToolCall(
        harness.deps,
        {
          currentEnvironment: current,
          thread,
          turnId: "turn-case-insensitive",
          input: { path: "c:/work/bb" },
        },
      );

      expect(result).toMatchObject({
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining(
              "already using C:\\Work\\bb as its environment directory",
            ),
          },
        ],
      });
    }));

  it("keeps checking managed roots when the host data dir cannot be canonicalized", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-datadir-transport",
        platform: "win32",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-datadir",
      });
      const current = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-datadir",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: current.id,
        status: "idle",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type !== "host.canonicalize_path") {
            throw new Error(`unexpected ${request.command.type}`);
          }
          if (request.command.path.startsWith("/tmp/bb-host-data/")) {
            return {
              ok: false,
              errorCode: "internal_error",
              errorMessage: "daemon exploded while resolving the data dir",
            };
          }
          return {
            ok: true,
            result: {
              path: request.command.path,
              pathKey: buildHostPathKey(request.command.path),
            },
          };
        },
      });

      const result = await handleUpdateEnvironmentDirectoryToolCall(
        harness.deps,
        {
          currentEnvironment: current,
          thread,
          turnId: "turn-datadir-transport",
          input: { path: `/tmp/bb-host-data/${host.id}/worktrees/env_x/repo` },
        },
      );

      expect(result).toMatchObject({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining(
              "bb-managed workspace owned by another project",
            ),
          },
        ],
      });
    }));
});
