import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  createEnvironment,
  findForeignManagedEnvironmentAtHostPathKey,
  findProviderEnvironmentContainingPathKey,
  listRetiredLoadedEnvironmentIdsOnHost,
  recordEnvironmentCurrentBranch,
  recordProvisionedEnvironmentWorkspace,
  updateEnvironmentMetadata,
} from "../../src/data/environments.js";
import { environments } from "../../src/schema.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/tmp/test",
      pathKey: "/tmp/test",
    },
  });
  return { db, host, project };
}

function createNotifierSpy(): DbNotifier {
  return {
    notifyThread: vi.fn(),
    notifyProject: vi.fn(),
    notifyEnvironment: vi.fn(),
    notifyHost: vi.fn(),
    notifySystem: vi.fn(),
  };
}

describe("environments", () => {
  it("keeps a path unique while provider teardown is pending", () => {
    const { db, host, project } = setup();
    const first = createEnvironment(db, noopNotifier, {
      providerOwnsPath: true,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/teardown-path",
      pathKey: "/tmp/teardown-path",
      status: "ready",
    });
    db.update(environments)
      .set({ teardownStatus: "running" })
      .where(eq(environments.id, first.id))
      .run();

    expect(() =>
      createEnvironment(db, noopNotifier, {
        providerOwnsPath: true,
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/teardown-path",
        pathKey: "/tmp/teardown-path",
        status: "provisioning",
      }),
    ).toThrow(/unique/iu);
  });

  it("keeps one live environment per path key regardless of spelling", () => {
    const { db, host, project } = setup();
    createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "C:\\Work\\bb",
      pathKey: "c:/work/bb",
      providerOwnsPath: false,
    });
    expect(() =>
      createEnvironment(db, noopNotifier, {
        projectId: project.id,
        hostId: host.id,
        path: "c:\\work\\BB",
        pathKey: "c:/work/bb",
        providerOwnsPath: false,
      }),
    ).toThrow(/environments_live_path_key_idx|UNIQUE/u);
  });

  it("lets a destroyed environment's path key be reused", () => {
    const { db, host, project } = setup();
    const first = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/srv/repo",
      pathKey: "/srv/repo",
      providerOwnsPath: false,
    });
    db.update(environments)
      .set({ status: "destroyed", path: null, pathKey: null })
      .where(eq(environments.id, first.id))
      .run();
    expect(
      createEnvironment(db, noopNotifier, {
        projectId: project.id,
        hostId: host.id,
        path: "/srv/repo",
        pathKey: "/srv/repo",
        providerOwnsPath: false,
      }).pathKey,
    ).toBe("/srv/repo");
  });

  it("refuses a path without its key", () => {
    const { db, host, project } = setup();
    expect(() =>
      createEnvironment(db, noopNotifier, {
        projectId: project.id,
        hostId: host.id,
        path: "/srv/repo",
        providerOwnsPath: false,
      }),
    ).toThrow(/pathKey/u);
  });

  it("finds provider environments containing a Windows path key", () => {
    const { db, host, project } = setup();
    const owner = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "C:\\Work\\bb",
      pathKey: "c:/work/bb",
      providerOwnsPath: true,
    });
    expect(
      findProviderEnvironmentContainingPathKey(db, "c:/work/bb/packages/x")?.id,
    ).toBe(owner.id);
    expect(findProviderEnvironmentContainingPathKey(db, "c:/work/bb")?.id).toBe(
      owner.id,
    );
    expect(findProviderEnvironmentContainingPathKey(db, "c:/work/bbx")).toBeNull();
  });

  it("emits metadata-changed when merge base branch changes", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = updateEnvironmentMetadata(db, notifier, environment.id, {
      mergeBaseBranch: "release",
    });

    expect(updated?.mergeBaseBranch).toBe("release");
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("emits metadata-changed when environment name changes", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = updateEnvironmentMetadata(db, notifier, environment.id, {
      name: "Review workspace",
    });

    expect(updated?.name).toBe("Review workspace");
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("does not emit metadata-changed when merge base branch is unchanged", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      mergeBaseBranch: "main",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = updateEnvironmentMetadata(db, notifier, environment.id, {
      mergeBaseBranch: "main",
    });

    expect(updated?.mergeBaseBranch).toBe("main");
    expect(notifier.notifyEnvironment).not.toHaveBeenCalled();
  });

  it("does not emit metadata-changed when environment name is unchanged", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      name: "Review workspace",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = updateEnvironmentMetadata(db, notifier, environment.id, {
      name: "Review workspace",
    });

    expect(updated?.name).toBe("Review workspace");
    expect(notifier.notifyEnvironment).not.toHaveBeenCalled();
  });

  it("records provisioned workspace metadata without touching status", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      status: "provisioning",
    });
    const notifier = createNotifierSpy();

    const updated = recordProvisionedEnvironmentWorkspace(
      db,
      notifier,
      environment.id,
      {
        path: "/tmp/project",
        pathKey: "/tmp/project",
        isGitRepo: true,
        isWorktree: true,
        branchName: "bb/test",
        defaultBranch: "main",
      },
    );

    expect(updated).toMatchObject({
      path: "/tmp/project",
      pathKey: "/tmp/project",
      status: "provisioning",
      isGitRepo: true,
      isWorktree: true,
      branchName: "bb/test",
      defaultBranch: "main",
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("records the current branch observed for an environment", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      branchName: "bb/old",
      defaultBranch: "main",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = recordEnvironmentCurrentBranch(
      db,
      notifier,
      environment.id,
      {
        branchName: "feature/current",
        defaultBranch: "trunk",
      },
    );

    expect(updated).toMatchObject({
      branchName: "feature/current",
      defaultBranch: "trunk",
      baseBranch: null,
      mergeBaseBranch: null,
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("clears the current branch when a detached checkout is observed", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      branchName: "bb/old",
      defaultBranch: "main",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = recordEnvironmentCurrentBranch(
      db,
      notifier,
      environment.id,
      {
        branchName: null,
      },
    );

    expect(updated).toMatchObject({
      branchName: null,
      defaultBranch: "main",
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("lists loaded environments that no longer belong to the host as live records", () => {
    const { db, host, project } = setup();
    const otherHost = upsertHost(db, noopNotifier, {
      name: "other-host",
      type: "persistent",
    });
    const { project: otherProject } = createProject(db, noopNotifier, {
      name: "other-project",
      source: {
        type: "local_path",
        hostId: otherHost.id,
        path: "/tmp/other",
        pathKey: "/tmp/other",
      },
    });
    const retainedEnvironment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      status: "ready",
    });
    const destroyedEnvironment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      status: "destroyed",
    });
    const otherHostEnvironment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: otherProject.id,
      hostId: otherHost.id,
      status: "ready",
    });

    expect(
      listRetiredLoadedEnvironmentIdsOnHost(db, {
        hostId: host.id,
        environmentIds: [
          retainedEnvironment.id,
          destroyedEnvironment.id,
          otherHostEnvironment.id,
          "env_missing",
        ],
      }),
    ).toEqual([
      destroyedEnvironment.id,
      otherHostEnvironment.id,
      "env_missing",
    ]);
  });
});

describe("environment path claims", () => {
  function seedClaim(
    args: ReturnType<typeof setup>,
    input: { environmentProviderId: string; path: string; providerOwnsPath: boolean },
  ) {
    return createEnvironment(args.db, noopNotifier, {
      projectId: args.project.id,
      hostId: args.host.id,
      path: input.path,
      pathKey: input.path,
      status: "ready",
      providerOwnsPath: input.providerOwnsPath,
      environmentProvider: {
        environmentProviderId: input.environmentProviderId,
        instanceKey: null,
        selection: {
          machine: { type: "existing", hostId: args.host.id },
          inputs: null,
        },
      },
    });
  }

  it("claims a path only for a provider that owns the directory", () => {
    const fixture = setup();
    seedClaim(fixture, {
      environmentProviderId: "project-checkout",
      path: "/tmp/attached",
      providerOwnsPath: false,
    });
    const owned = seedClaim(fixture, {
      environmentProviderId: "git-worktree",
      path: "/tmp/owned",
      providerOwnsPath: true,
    });

    expect(
      findProviderEnvironmentContainingPathKey(fixture.db, "/tmp/attached"),
    ).toBeNull();
    expect(
      findProviderEnvironmentContainingPathKey(fixture.db, "/tmp/attached/pkg"),
    ).toBeNull();
    expect(
      findProviderEnvironmentContainingPathKey(fixture.db, "/tmp/owned/pkg")?.id,
    ).toBe(owned.id);
  });

  it("refuses a foreign project only inside a directory a provider owns", () => {
    const fixture = setup();
    const { project: other } = createProject(fixture.db, noopNotifier, {
      name: "other-project",
      source: {
        type: "local_path",
        hostId: fixture.host.id,
        path: "/tmp/other",
        pathKey: "/tmp/other",
      },
    });
    seedClaim(fixture, {
      environmentProviderId: "project-checkout",
      path: "/tmp/shared-checkout",
      providerOwnsPath: false,
    });
    const owned = seedClaim(fixture, {
      environmentProviderId: "git-worktree",
      path: "/tmp/owned-worktree",
      providerOwnsPath: true,
    });

    expect(
      findForeignManagedEnvironmentAtHostPathKey(fixture.db, {
        hostId: fixture.host.id,
        pathKey: "/tmp/shared-checkout",
        projectId: other.id,
      }),
    ).toBeNull();
    expect(
      findForeignManagedEnvironmentAtHostPathKey(fixture.db, {
        hostId: fixture.host.id,
        pathKey: "/tmp/owned-worktree",
        projectId: other.id,
      })?.id,
    ).toBe(owned.id);
  });
});
