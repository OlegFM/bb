import { buildHostPathKey } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  handleUpdateEnvironmentDirectoryToolCall,
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
});

describe("update_environment_directory managed-root containment", () => {
  it("refuses a managed workspace reached through a symlinked data dir", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-managed-symlink",
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
});
