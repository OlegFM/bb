# Native Windows Port — Phase 1 (Host identity and host-owned paths) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native Windows host daemon identifies itself as `win32`, drive-absolute project and environment paths (`C:\Users\me\repo`) are first-class across the contract, the server, the database, the workspace plugins and the browser app, and every path comparison runs on a host-owned canonical `pathKey` so `C:/x`, `C:\x` and `c:\X` resolve to one identity.

**Architecture:** Path math that only depends on the string shape lives once in `@bb/domain` (`host-path.ts`) and is shared by the daemon, the server and the app. The host daemon owns canonical paths: a new `host.canonicalize_path` RPC returns `{ path, pathKey }` from `fs.realpath.native`; the server stores both as opaque strings in new `path_key` columns and never derives a stored key from a stored path. Servers compare and contain paths by `path_key`; raw `path` equality remains only for display and for the client-facing list filter. The workspace plugins derive managed paths with the host's native `path` module. `HOST_DAEMON_PROTOCOL_VERSION` is bumped once, to 200.

**Tech Stack:** pnpm 9.15.0, Turbo, Vitest 4, TypeScript, zod, Drizzle ORM + drizzle-kit (SQLite), Hono, React (app), Electron (desktop contract only).

**Spec:** `docs/superpowers/specs/2026-09-11-native-windows-port-design.md` (§4 Architecture principles incl. the `path_key` migration, §5 Host paths seam, §7 Phase 1, §8 Verification).

## Global Constraints

- Target is Windows 11 x64 only; no ARM64, no Windows 10 (spec §3). Drive-letter input only: UNC (`\\server\share`), device (`\\.\`) and extended-length (`\\?\`) paths are rejected with a message naming drive-letter paths as the remedy (spec §3, §5).
- Platform is injected, never ambient: functions whose behaviour depends on the OS take `platform` as a parameter; `process.platform` is read only at composition roots (daemon command wrapper, Desktop `main.ts`/`preload.ts`) (spec §4).
- Three path classes (spec §4): host-absolute paths branch on flavor by shape (`/`-rooted = POSIX, `X:\`/`X:/` = Windows); repository-relative paths stay `/`-separated; URL paths are never host paths. A host path belongs to the host, not to the process validating it, so contracts validate shape permissively and the daemon validates strictly.
- Host-owned canonical paths (spec §4): the daemon returns `{ path, pathKey }`; `path` is the native display path with normalized separators, uppercase drive letter, no trailing separator (drive roots keep `C:\`), never a `\\?\` prefix; `pathKey` is `path` with `\` replaced by `/` and lower-cased on Windows, `path` unchanged on POSIX. Keys always use `/`, so `LIKE key || '/%'` containment stays valid. Stored `path_key` values come from the daemon whenever the host is connected; the server derives a key by shape (`buildHostPathKey`) only for offline hosts (ruling: today's offline project registration must keep working), transient claims, containment checks against the host data directory, and test doubles. Clients never supply a key.
- `HOST_DAEMON_PROTOCOL_VERSION` moves from 199 to 200 exactly once, in the commit that adds `host.canonicalize_path` (spec §4, §7).
- Code comments are forbidden in TypeScript and JavaScript except semantic tool directives (`AGENTS.md`).
- Builds, typechecks and tests run through Turbo: `pnpm exec turbo run <task> --filter=<pkg>` (`AGENTS.md`). Single test files may be run with `pnpm --filter <pkg> exec vitest run <file>` while iterating; every task ends with the Turbo `typecheck` of the touched packages and the Turbo `test` of every package whose tests changed.
- Never mock the database: tests use `createConnection(":memory:")` + `migrate(db)` or `createMigratedConnection()` (`AGENTS.md`).
- Drizzle schema changes regenerate migrations and snapshots through `pnpm exec turbo run db:generate --filter=@bb/db -- --name path_key`; snapshot JSON is never edited by hand; the generated `.sql` may gain backfill statements (precedent: `packages/db/drizzle/0015_good_lila_cheney.sql`).
- Node 22.19.x (`.nvmrc`) is the verification runtime; on the reference desktop `nvm use 22.19.0` then `corepack enable`.
- Commits are grouped by seam; each task below ends with one commit whose message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` followed by `Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4`.
- Donor policy (spec §10): donor fragments from `refs/remotes/upstream-pr/3188` are read, adapted and tested, never cherry-picked blindly; the donor's UNC and `\\?\` acceptance is not ported; known limitations go to `docs/platform-windows.md`, evidence to `qa/windows/phase-1/`.
- Measurement rule (spec §8): no Windows behaviour is claimed until it has run on Windows; `it.runIf(process.platform === "win32")` tests run on the reference desktop and the `windows-x64` CI job; pure functions with injected platform run everywhere.
- Phase gate (spec §7): a project on `C:\` is created from the UI and the CLI; a managed worktree of a hook-less repository provisions and is removed; `C:/x`, `C:\x` and `c:\X` resolve to one project identity; two creates of equivalent paths yield one environment; the migration collision check is exercised against a fixture with duplicate live rows; POSIX suites unchanged (WSL run).
- `serverPath` in `hostDaemonContributedEnvEntrySchema` is an HTTP URL path, not a host path; it is out of scope (ledger ruling).

## File Structure

| Path | Responsibility |
|---|---|
| `packages/host-daemon-contract/src/local.ts` | `hostPlatformSchema` gains `"win32"` |
| `packages/host-daemon-contract/src/commands.ts`, `src/protocol.ts` | `host.canonicalize_path` command + `canonicalHostPathSchema`; protocol 200 |
| `packages/host-daemon-contract/test/contract.test.ts` | Pins the enum, the command round trip and version 200 |
| `apps/host-daemon/src/host-platform.ts` (+ `.test.ts`) | `win32` branch of `resolveHostPlatform` |
| `apps/host-daemon/src/command-handlers/canonicalize-path.ts` (+ `.test.ts`) | Pure `canonicalizeHostPath` with injected platform/realpath/stat; command wrapper |
| `apps/host-daemon/src/command-dispatch.ts` | Registers `host.canonicalize_path` |
| `packages/desktop-contract/src/info.ts`, `src/version-feed.ts` (+ tests) | Desktop platform enum gains `"windows"`; feed file name `desktop-version-windows.json` |
| `apps/desktop/src/desktop-platform.ts` (+ `test/desktop-platform.test.ts`), `src/desktop-update-provider.ts` (+ test) | `win32` → `"windows"`; update checks disabled on Windows until Phase 4 |
| `apps/app/src/components/settings/MachinesSettingsSection.tsx`, `apps/app/src/views/MachineSettingsView.tsx` (+ tests) | `win32: "Windows"` label |
| `apps/app/src/components/dialogs/ProjectPathDialog.tsx` | Drive-letter guidance copy for `win32` hosts |
| `packages/domain/src/host-path.ts` (+ `test/host-path.test.ts`), `src/index.ts` | Shape-based host path helpers and `buildHostPathKey` |
| `packages/domain/src/project-path.ts` (+ `test/project-path.test.ts`) | Drive-absolute project paths accepted, UNC rejected, names derived from either separator |
| `packages/db/src/schema.ts`, `drizzle/0117_path_key.sql`, `drizzle/meta/*` | `path_key` columns, indexes, partial unique index, backfill |
| `packages/db/src/migrate.ts` (+ `test/migrate.test.ts`) | Live-row collision pre-check |
| `packages/db/src/data/environments.ts`, `data/projects.ts`, `data/project-sources.ts` (+ tests) | Key-based lookups, claims and binds; `pathKey` on writes |
| `apps/server/src/services/hosts/host-paths.ts` (+ test) | `canonicalizeHostPath` RPC helper, managed workspace roots |
| `apps/server/src/routes/projects.ts` | Canonicalize before create/createSource/updateSource |
| `apps/server/src/services/environments/environment-engine.ts` | Claims and binds by key; produced paths canonicalized |
| `apps/server/src/services/threads/workspace-paths.ts`, `workspace-path-claims.ts`, `thread-environment-directory.ts`, `services/environments/path-admission.ts`, `services/plugins/plugin-registration.ts` | Route through `@bb/domain` host-path helpers and key-based DB functions |
| `apps/server/test/helpers/commands.ts`, `helpers/seed.ts` | Test daemon answers `host.canonicalize_path`; seeds carry `pathKey` |
| `plugins/environment-git-worktree/host/paths.ts` (+ test), `plugins/environment-personal-workspace/host/paths.ts` (+ new test) | Managed paths via native `path` |
| `apps/app/src/lib/absolute-file-path.ts`, `components/ui/markdown-local-file-link.ts`, `markdown-local-file-link-normalize.ts` (+ tests) | Drive-absolute file paths and `file:///C:/` links |
| `packages/config/src/runtime.ts` (+ `packages/scripts/test/run-dev.test.ts`) | `resolveInheritedDevSkillsRootPaths` without `"/"` joins |
| `docs/platform-windows.md`, `docs/platform-support.md` | Status, protocol note, known limitations |
| `qa/windows/phase-1/*` | Gate evidence |

---

### Task 1: Widen the host platform contract to `win32` and the desktop contract to `windows`

**Files:**
- Modify: `packages/host-daemon-contract/src/local.ts:143`
- Modify: `packages/host-daemon-contract/test/contract.test.ts:14-25`
- Modify: `apps/host-daemon/src/host-platform.ts`
- Create: `apps/host-daemon/src/host-platform.test.ts`
- Modify: `apps/app/src/components/settings/MachinesSettingsSection.tsx:74-79`, `apps/app/src/views/MachineSettingsView.tsx:60-65`
- Modify: `apps/app/src/components/settings/MachinesSettingsSection.test.tsx:41`, `apps/app/src/views/MachineSettingsView.test.tsx:46`
- Modify: `apps/app/src/components/dialogs/ProjectPathDialog.tsx:132-148`
- Modify: `packages/desktop-contract/src/info.ts:19`, `packages/desktop-contract/src/version-feed.ts`, `packages/desktop-contract/test/info.test.ts`, `packages/desktop-contract/test/version-feed.test.ts`
- Modify: `apps/desktop/src/desktop-platform.ts`, `apps/desktop/src/desktop-update-provider.ts:84-99`, `apps/desktop/test/desktop-update-provider.test.ts`
- Create: `apps/desktop/test/desktop-platform.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `HostPlatform` includes `"win32"`; `BbDesktopInfo["platform"]` and `BbDesktopVersionFeedPlatform` include `"windows"`; `resolveHostPlatform("win32", env)` returns `"win32"`; `resolveBbDesktopPlatform("win32")` returns `"windows"`.

- [ ] **Step 1: Write the failing contract tests**

In `packages/host-daemon-contract/test/contract.test.ts` replace the `hostPlatformSchema` block:

```ts
describe("hostPlatformSchema", () => {
  it("accepts the supported platform values", () => {
    for (const value of ["darwin", "linux", "wsl", "win32", "unknown"] as const) {
      expect(hostPlatformSchema.parse(value)).toBe(value);
    }
  });

  it("rejects other strings", () => {
    expect(() => hostPlatformSchema.parse("windows")).toThrow();
    expect(() => hostPlatformSchema.parse("")).toThrow();
  });
});
```

Create `apps/host-daemon/src/host-platform.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveHostPlatform } from "./host-platform.js";

describe("resolveHostPlatform", () => {
  it("reports native Windows as win32", () => {
    expect(resolveHostPlatform("win32", {})).toBe("win32");
  });

  it("ignores WSL variables leaking into a native Windows process", () => {
    expect(
      resolveHostPlatform("win32", { WSL_DISTRO_NAME: "Ubuntu-24.04" }),
    ).toBe("win32");
  });

  it("keeps WSL distinct from Linux", () => {
    expect(
      resolveHostPlatform("linux", { WSL_DISTRO_NAME: "Ubuntu-24.04" }),
    ).toBe("wsl");
    expect(
      resolveHostPlatform("linux", { WSL_INTEROP: "/run/WSL/1_interop" }),
    ).toBe("wsl");
    expect(resolveHostPlatform("linux", {})).toBe("linux");
  });

  it("maps macOS and unsupported platforms", () => {
    expect(resolveHostPlatform("darwin", {})).toBe("darwin");
    expect(resolveHostPlatform("freebsd", {})).toBe("unknown");
  });
});
```

In `packages/desktop-contract/test/info.test.ts` add after `it("accepts linux", ...)`:

```ts
  it("accepts windows", () => {
    expect(
      bbDesktopInfoSchema.safeParse({
        ...baseInfo,
        platform: "windows",
      }).success,
    ).toBe(true);
  });
```

Keep `it("rejects win32", ...)` as is (`win32` is a Node platform, not a desktop platform value).

In `packages/desktop-contract/test/version-feed.test.ts`, extend the file-name test:

```ts
    expect(createBbDesktopVersionFeedFileName("windows")).toBe(
      "desktop-version-windows.json",
    );
```

Create `apps/desktop/test/desktop-platform.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveBbDesktopPlatform } from "../src/desktop-platform.js";

describe("resolveBbDesktopPlatform", () => {
  it("maps each Node platform to its desktop platform", () => {
    expect(resolveBbDesktopPlatform("darwin")).toBe("macos");
    expect(resolveBbDesktopPlatform("win32")).toBe("windows");
    expect(resolveBbDesktopPlatform("linux")).toBe("linux");
  });

  it("does not report other platforms as Windows", () => {
    expect(resolveBbDesktopPlatform("freebsd")).toBe("linux");
  });
});
```

In `apps/desktop/test/desktop-update-provider.test.ts` add inside `describe("desktop update support", ...)`:

```ts
  it("disables update checks on Windows until the Windows feed ships", () => {
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: () => true,
        env: {},
        platform: "windows",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: false });
  });
```

In `apps/app/src/components/settings/MachinesSettingsSection.test.tsx`, widen the fixture union on line 41 to `"darwin" | "linux" | "wsl" | "win32" | "unknown" | null` and add, next to the test `distinguishes the client-local daemon from the primary machine`, a test named `labels a native Windows daemon as Windows` that renders the same way with `hostDaemon.platform = "win32"` and asserts `expect(screen.getByText("Windows")).toBeDefined()`. Widen the same union in `apps/app/src/views/MachineSettingsView.test.tsx:46`.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm --filter @bb/host-daemon-contract exec vitest run test/contract.test.ts -t hostPlatformSchema`, `pnpm --filter @bb/host-daemon exec vitest run src/host-platform.test.ts`, `pnpm --filter @bb/desktop-contract exec vitest run`, `pnpm --filter @bb/desktop exec vitest run test/desktop-platform.test.ts test/desktop-update-provider.test.ts`.

Expected: the win32/windows assertions fail; everything else passes.

- [ ] **Step 3: Widen the contracts and the resolvers**

`packages/host-daemon-contract/src/local.ts`:

```ts
export const hostPlatformSchema = z.enum([
  "darwin",
  "linux",
  "wsl",
  "win32",
  "unknown",
]);
```

`apps/host-daemon/src/host-platform.ts`:

```ts
import type { HostPlatform } from "@bb/host-daemon-contract";

export function resolveHostPlatform(
  nodePlatform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): HostPlatform {
  if (nodePlatform === "darwin") return "darwin";
  if (nodePlatform === "win32") return "win32";
  if (nodePlatform === "linux") {
    const isWsl = env.WSL_DISTRO_NAME != null || env.WSL_INTEROP != null;
    return isWsl ? "wsl" : "linux";
  }
  return "unknown";
}
```

`packages/desktop-contract/src/info.ts` line 19: `platform: z.enum(["macos", "linux", "windows"]),`

`packages/desktop-contract/src/version-feed.ts`:

```ts
const bbDesktopVersionFeedPlatformSchema = z.enum(["macos", "linux", "windows"]);
```

and

```ts
const BB_DESKTOP_VERSION_FEED_FILE_NAMES = {
  linux: "desktop-version-linux.json",
  macos: "desktop-version.json",
  windows: "desktop-version-windows.json",
} as const satisfies Record<BbDesktopVersionFeedPlatform, string>;
```

`apps/desktop/src/desktop-platform.ts`:

```ts
import type { BbDesktopInfo } from "@bb/desktop-contract";

export function resolveBbDesktopPlatform(
  platform: NodeJS.Platform,
): BbDesktopInfo["platform"] {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}
```

`apps/desktop/src/desktop-update-provider.ts`, first statement of `resolveDesktopUpdateSupport`:

```ts
  if (args.platform === "windows") {
    return { autoUpdate: false, versionCheck: false };
  }
```

- [ ] **Step 4: Label the platform in the app**

Add `win32: "Windows",` between `linux` and `wsl` in both `PLATFORM_LABELS` maps (`MachinesSettingsSection.tsx`, `MachineSettingsView.tsx`).

In `apps/app/src/components/dialogs/ProjectPathDialog.tsx`, `getPlatformCopy` gains a branch before the `wsl` one:

```ts
  if (platform === "win32") {
    return {
      description: `Enter an absolute Windows path${hostSuffix} to the project folder, such as C:\\Users\\me\\repo.`,
      placeholder: "C:\\path\\to\\project",
    };
  }
```

- [ ] **Step 5: Run the tests and typechecks**

Run: the four commands from Step 2 plus `pnpm --filter @bb/app exec vitest run src/components/settings/MachinesSettingsSection.test.tsx src/views/MachineSettingsView.test.tsx`, then `pnpm exec turbo run typecheck --filter=@bb/host-daemon-contract --filter=@bb/host-daemon --filter=@bb/desktop-contract --filter=@bb/desktop --filter=@bb/app --filter=@bb/server`, then `pnpm exec turbo run test --filter=@bb/host-daemon-contract --filter=@bb/desktop-contract`.

Expected: all green. The `apps/desktop/src/main.ts` update-feed wiring typechecks because both enums gained `"windows"`.

- [ ] **Step 6: Commit**

```bash
git add packages/host-daemon-contract packages/desktop-contract apps/host-daemon/src/host-platform.ts apps/host-daemon/src/host-platform.test.ts apps/desktop/src/desktop-platform.ts apps/desktop/src/desktop-update-provider.ts apps/desktop/test apps/app/src/components/settings/MachinesSettingsSection.tsx apps/app/src/components/settings/MachinesSettingsSection.test.tsx apps/app/src/views/MachineSettingsView.tsx apps/app/src/views/MachineSettingsView.test.tsx apps/app/src/components/dialogs/ProjectPathDialog.tsx
git commit -m "Add win32 to the host platform contract and windows to the desktop contract

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 2: Shape-based host path helpers in `@bb/domain`

**Files:**
- Create: `packages/domain/src/host-path.ts`
- Create: `packages/domain/test/host-path.test.ts`
- Modify: `packages/domain/src/index.ts:33` (add the export next to `project-path`)

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `@bb/domain`):
  - `type HostPathFlavor = "posix" | "windows"`
  - `detectHostPathFlavor(path: string): HostPathFlavor | null`
  - `isAbsoluteHostPath(path: string): boolean`, `isWindowsHostPath(path: string): boolean`, `isUncOrDeviceHostPath(path: string): boolean`
  - `normalizeHostPath(path: string): string` (uppercase drive, `\` separators, collapsed runs, no trailing separator except `X:\` and `/`; non-absolute input returned unchanged)
  - `isHostPathRoot(path: string): boolean`
  - `joinHostPath(rootPath: string, ...segments: string[]): string`
  - `basenameHostPath(path: string): string`, `dirnameHostPath(path: string): string`
  - `buildHostPathKey(path: string): string`
  - `isHostPathWithin(args: { rootPath: string; candidatePath: string }): boolean`

- [ ] **Step 1: Write the failing tests**

Create `packages/domain/test/host-path.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  basenameHostPath,
  buildHostPathKey,
  detectHostPathFlavor,
  dirnameHostPath,
  isAbsoluteHostPath,
  isHostPathRoot,
  isHostPathWithin,
  isUncOrDeviceHostPath,
  isWindowsHostPath,
  joinHostPath,
  normalizeHostPath,
} from "../src/host-path.js";

describe("host-path", () => {
  it("classifies host paths by shape", () => {
    expect(detectHostPathFlavor("/home/me/repo")).toBe("posix");
    expect(detectHostPathFlavor("C:\\Users\\me\\repo")).toBe("windows");
    expect(detectHostPathFlavor("c:/Users/me/repo")).toBe("windows");
    expect(detectHostPathFlavor("C:\\")).toBe("windows");
    expect(detectHostPathFlavor("C:")).toBe("windows");
    expect(detectHostPathFlavor("C:Users\\me")).toBeNull();
    expect(detectHostPathFlavor("relative/path")).toBeNull();
    expect(detectHostPathFlavor("\\\\server\\share\\repo")).toBeNull();
    expect(detectHostPathFlavor("//server/share/repo")).toBeNull();
    expect(detectHostPathFlavor("\\\\?\\C:\\Users\\me")).toBeNull();
    expect(detectHostPathFlavor("")).toBeNull();
  });

  it("recognizes UNC and device paths", () => {
    expect(isUncOrDeviceHostPath("\\\\server\\share")).toBe(true);
    expect(isUncOrDeviceHostPath("//server/share")).toBe(true);
    expect(isUncOrDeviceHostPath("\\\\?\\C:\\x")).toBe(true);
    expect(isUncOrDeviceHostPath("\\\\.\\pipe\\x")).toBe(true);
    expect(isUncOrDeviceHostPath("C:\\x")).toBe(false);
    expect(isUncOrDeviceHostPath("/x")).toBe(false);
  });

  it("answers absolute and windows checks", () => {
    expect(isAbsoluteHostPath("/srv/repo")).toBe(true);
    expect(isAbsoluteHostPath("D:/repo")).toBe(true);
    expect(isAbsoluteHostPath("repo")).toBe(false);
    expect(isWindowsHostPath("D:/repo")).toBe(true);
    expect(isWindowsHostPath("/srv/repo")).toBe(false);
  });

  it("normalizes Windows paths to uppercase drive and backslashes", () => {
    expect(normalizeHostPath("c:/Users//me\\repo/")).toBe("C:\\Users\\me\\repo");
    expect(normalizeHostPath("c:\\")).toBe("C:\\");
    expect(normalizeHostPath("c:/")).toBe("C:\\");
    expect(normalizeHostPath("c:")).toBe("C:\\");
    expect(normalizeHostPath("C:\\Work\\bb\\\\")).toBe("C:\\Work\\bb");
  });

  it("normalizes POSIX paths by trimming trailing separators only", () => {
    expect(normalizeHostPath("/srv/repo/")).toBe("/srv/repo");
    expect(normalizeHostPath("/srv//repo")).toBe("/srv//repo");
    expect(normalizeHostPath("/")).toBe("/");
    expect(normalizeHostPath("///")).toBe("/");
  });

  it("returns non-absolute input unchanged", () => {
    expect(normalizeHostPath("relative/path/")).toBe("relative/path/");
    expect(normalizeHostPath("\\\\server\\share\\")).toBe("\\\\server\\share\\");
  });

  it("detects filesystem roots", () => {
    expect(isHostPathRoot("/")).toBe(true);
    expect(isHostPathRoot("c:/")).toBe(true);
    expect(isHostPathRoot("C:")).toBe(true);
    expect(isHostPathRoot("/srv")).toBe(false);
    expect(isHostPathRoot("C:\\srv")).toBe(false);
  });

  it("joins with the root's separator", () => {
    expect(joinHostPath("/home/me/.bb", "worktrees")).toBe("/home/me/.bb/worktrees");
    expect(joinHostPath("/", "srv", "repo")).toBe("/srv/repo");
    expect(joinHostPath("C:\\Users\\me\\.bb", "worktrees", "env/repo")).toBe(
      "C:\\Users\\me\\.bb\\worktrees\\env\\repo",
    );
    expect(joinHostPath("C:\\", "Work")).toBe("C:\\Work");
    expect(joinHostPath("C:\\Work")).toBe("C:\\Work");
  });

  it("derives basenames and dirnames per flavor", () => {
    expect(basenameHostPath("/srv/repos/bb/")).toBe("bb");
    expect(basenameHostPath("C:\\Users\\me\\bb")).toBe("bb");
    expect(basenameHostPath("c:/Users/me/bb/")).toBe("bb");
    expect(basenameHostPath("/")).toBe("");
    expect(basenameHostPath("C:\\")).toBe("");
    expect(dirnameHostPath("/srv/repos/bb")).toBe("/srv/repos");
    expect(dirnameHostPath("/srv")).toBe("/");
    expect(dirnameHostPath("/")).toBe("/");
    expect(dirnameHostPath("C:\\Users\\me\\bb")).toBe("C:\\Users\\me");
    expect(dirnameHostPath("C:\\bb")).toBe("C:\\");
    expect(dirnameHostPath("C:\\")).toBe("C:\\");
  });

  it("builds comparison keys", () => {
    expect(buildHostPathKey("C:\\Work\\bb")).toBe("c:/work/bb");
    expect(buildHostPathKey("c:/work/bb/")).toBe("c:/work/bb");
    expect(buildHostPathKey("C:\\")).toBe("c:/");
    expect(buildHostPathKey("/Work/bb/")).toBe("/Work/bb");
    expect(buildHostPathKey("/")).toBe("/");
  });

  it("checks containment by key", () => {
    expect(
      isHostPathWithin({ rootPath: "/home/me/.bb/worktrees", candidatePath: "/home/me/.bb/worktrees/env/repo" }),
    ).toBe(true);
    expect(
      isHostPathWithin({ rootPath: "/home/me/.bb/worktrees", candidatePath: "/home/me/.bb/worktrees" }),
    ).toBe(true);
    expect(
      isHostPathWithin({ rootPath: "/home/me/.bb/worktrees", candidatePath: "/home/me/.bb/worktrees-2" }),
    ).toBe(false);
    expect(isHostPathWithin({ rootPath: "/", candidatePath: "/srv" })).toBe(true);
    expect(
      isHostPathWithin({ rootPath: "C:\\Users\\me\\.bb\\worktrees", candidatePath: "c:/users/ME/.bb/worktrees/env/repo" }),
    ).toBe(true);
    expect(isHostPathWithin({ rootPath: "C:\\", candidatePath: "C:\\Work" })).toBe(true);
    expect(
      isHostPathWithin({ rootPath: "C:\\Users\\me", candidatePath: "/Users/me/repo" }),
    ).toBe(false);
    expect(
      isHostPathWithin({ rootPath: "C:\\Users\\me", candidatePath: "C:\\Users\\me2" }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bb/domain exec vitest run test/host-path.test.ts`
Expected: FAIL, module `../src/host-path.js` not found.

- [ ] **Step 3: Implement the helpers**

Create `packages/domain/src/host-path.ts`:

```ts
export type HostPathFlavor = "posix" | "windows";

const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/u;
const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:[\\/]*$/u;
const WINDOWS_DRIVE_PREFIX_PATTERN = /^([A-Za-z]):/u;
const WINDOWS_CANONICAL_ROOT_PATTERN = /^[A-Z]:\\$/u;
const UNC_OR_DEVICE_PATH_PATTERN = /^[\\/]{2}/u;
const WINDOWS_SEPARATOR_RUN_PATTERN = /[\\/]+/u;
const POSIX_SEPARATOR_RUN_PATTERN = /\/+/u;

export function isUncOrDeviceHostPath(path: string): boolean {
  return UNC_OR_DEVICE_PATH_PATTERN.test(path);
}

export function detectHostPathFlavor(path: string): HostPathFlavor | null {
  if (isUncOrDeviceHostPath(path)) {
    return null;
  }
  if (path.startsWith("/")) {
    return "posix";
  }
  if (
    WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(path) ||
    WINDOWS_DRIVE_ROOT_PATTERN.test(path)
  ) {
    return "windows";
  }
  return null;
}

export function isAbsoluteHostPath(path: string): boolean {
  return detectHostPathFlavor(path) !== null;
}

export function isWindowsHostPath(path: string): boolean {
  return detectHostPathFlavor(path) === "windows";
}

function normalizeWindowsHostPath(path: string): string {
  const drive = WINDOWS_DRIVE_PREFIX_PATTERN.exec(path)?.[1]?.toUpperCase() ?? "";
  const segments = path
    .slice(2)
    .split(WINDOWS_SEPARATOR_RUN_PATTERN)
    .filter((segment) => segment.length > 0);
  return segments.length === 0
    ? `${drive}:\\`
    : `${drive}:\\${segments.join("\\")}`;
}

function normalizePosixHostPath(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

export function normalizeHostPath(path: string): string {
  const flavor = detectHostPathFlavor(path);
  if (flavor === "windows") {
    return normalizeWindowsHostPath(path);
  }
  if (flavor === "posix") {
    return normalizePosixHostPath(path);
  }
  return path;
}

export function isHostPathRoot(path: string): boolean {
  const normalized = normalizeHostPath(path);
  return normalized === "/" || WINDOWS_CANONICAL_ROOT_PATTERN.test(normalized);
}

function hostPathSeparator(path: string): "/" | "\\" {
  return isWindowsHostPath(path) ? "\\" : "/";
}

export function joinHostPath(rootPath: string, ...segments: string[]): string {
  const root = normalizeHostPath(rootPath);
  const separator = hostPathSeparator(root);
  const splitter =
    separator === "\\"
      ? WINDOWS_SEPARATOR_RUN_PATTERN
      : POSIX_SEPARATOR_RUN_PATTERN;
  const tail = segments
    .flatMap((segment) => segment.split(splitter))
    .filter((segment) => segment.length > 0)
    .join(separator);
  if (tail.length === 0) {
    return root;
  }
  return root.endsWith(separator) ? `${root}${tail}` : `${root}${separator}${tail}`;
}

export function basenameHostPath(path: string): string {
  const normalized = normalizeHostPath(path);
  if (isHostPathRoot(normalized) || !isAbsoluteHostPath(normalized)) {
    return "";
  }
  const separator = hostPathSeparator(normalized);
  return normalized.slice(normalized.lastIndexOf(separator) + 1);
}

export function dirnameHostPath(path: string): string {
  const normalized = normalizeHostPath(path);
  if (isHostPathRoot(normalized) || !isAbsoluteHostPath(normalized)) {
    return normalized;
  }
  const separator = hostPathSeparator(normalized);
  const index = normalized.lastIndexOf(separator);
  if (separator === "/") {
    return index <= 0 ? "/" : normalized.slice(0, index);
  }
  return index <= 2 ? normalized.slice(0, 3) : normalized.slice(0, index);
}

export function buildHostPathKey(path: string): string {
  const normalized = normalizeHostPath(path);
  if (isWindowsHostPath(normalized)) {
    return normalized.replace(/\\/gu, "/").toLowerCase();
  }
  return normalized;
}

export function isHostPathWithin(args: {
  rootPath: string;
  candidatePath: string;
}): boolean {
  const rootFlavor = detectHostPathFlavor(args.rootPath);
  const candidateFlavor = detectHostPathFlavor(args.candidatePath);
  if (
    rootFlavor === null ||
    candidateFlavor === null ||
    rootFlavor !== candidateFlavor
  ) {
    return false;
  }
  const rootKey = buildHostPathKey(args.rootPath);
  const candidateKey = buildHostPathKey(args.candidatePath);
  if (candidateKey === rootKey) {
    return true;
  }
  const prefix = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  return candidateKey.startsWith(prefix);
}
```

Add `export * from "./host-path.js";` to `packages/domain/src/index.ts` directly above the `project-path` export.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @bb/domain exec vitest run test/host-path.test.ts`, then `pnpm exec turbo run test typecheck --filter=@bb/domain`.
Expected: PASS. If an exported name collides with an existing `@bb/domain` export, rename the new symbol (keep the `HostPath` suffix convention) and update the test.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/host-path.ts packages/domain/src/index.ts packages/domain/test/host-path.test.ts
git commit -m "Add shape-based host path helpers to the domain package

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 3: `host.canonicalize_path` RPC and the protocol bump to 200

**Files:**
- Modify: `packages/host-daemon-contract/src/commands.ts` (schemas near `hostPathsExistCommandSchema`; registry entry after `"host.paths_exist"`)
- Modify: `packages/host-daemon-contract/src/protocol.ts:1`
- Modify: `packages/host-daemon-contract/test/contract.test.ts:1000-1004` and a new round-trip test
- Create: `apps/host-daemon/src/command-handlers/canonicalize-path.ts`
- Create: `apps/host-daemon/src/command-handlers/canonicalize-path.test.ts`
- Modify: `apps/host-daemon/src/command-dispatch.ts` (import + `onlineRpcHandlers` entry next to `"host.paths_exist"`)

**Interfaces:**
- Consumes: `buildHostPathKey`, `detectHostPathFlavor`, `isUncOrDeviceHostPath`, `normalizeHostPath` from `@bb/domain` (Task 2).
- Produces: command `{ type: "host.canonicalize_path", path: string }` (onlineRpc, retryable) with result `CanonicalHostPath = { path: string; pathKey: string }` exported from `@bb/host-daemon-contract`; `canonicalizeHostPath(args: { path; platform; realpath; stat })` in the daemon; `HOST_DAEMON_PROTOCOL_VERSION === 200`.

- [ ] **Step 1: Write the failing contract tests**

In `packages/host-daemon-contract/test/contract.test.ts` change the version pin to `expect(HOST_DAEMON_PROTOCOL_VERSION).toBe(200);` and add inside `describe("host-daemon command schemas", ...)`:

```ts
  it("round-trips host.canonicalize_path", () => {
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        type: "host.canonicalize_path",
        path: "C:\\Work\\bb",
      }).success,
    ).toBe(true);
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        type: "host.canonicalize_path",
        path: "",
      }).success,
    ).toBe(false);
    const resultSchema =
      hostDaemonOnlineRpcResultSchemaByType["host.canonicalize_path"];
    expect(
      resultSchema.safeParse({ path: "C:\\Work\\bb", pathKey: "c:/work/bb" })
        .success,
    ).toBe(true);
    expect(resultSchema.safeParse({ path: "C:\\Work\\bb" }).success).toBe(false);
  });
```

Create `apps/host-daemon/src/command-handlers/canonicalize-path.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeHostPath,
  canonicalizeHostPathCommand,
} from "./canonicalize-path.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function directoryStat() {
  return async () => ({ isDirectory: () => true });
}

describe("canonicalizeHostPath", () => {
  it("normalizes a Windows path resolved by the host", async () => {
    await expect(
      canonicalizeHostPath({
        path: "c:/work/bb/",
        platform: "win32",
        realpath: async () => "C:\\Work\\bb",
        stat: directoryStat(),
      }),
    ).resolves.toEqual({ path: "C:\\Work\\bb", pathKey: "c:/work/bb" });
  });

  it("strips the extended-length prefix the native realpath may return", async () => {
    await expect(
      canonicalizeHostPath({
        path: "C:\\Work\\bb",
        platform: "win32",
        realpath: async () => "\\\\?\\C:\\Work\\bb\\",
        stat: directoryStat(),
      }),
    ).resolves.toEqual({ path: "C:\\Work\\bb", pathKey: "c:/work/bb" });
  });

  it("rejects UNC, device and relative input on Windows", async () => {
    for (const input of ["\\\\server\\share\\bb", "\\\\?\\C:\\bb", "//server/share", "bb\\repo", "/srv/bb"]) {
      await expect(
        canonicalizeHostPath({
          path: input,
          platform: "win32",
          realpath: async () => input,
          stat: directoryStat(),
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
    }
  });

  it("rejects a Windows path that resolves onto a network share", async () => {
    await expect(
      canonicalizeHostPath({
        path: "Z:\\repo",
        platform: "win32",
        realpath: async () => "\\\\?\\UNC\\server\\share\\repo",
        stat: directoryStat(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("not a drive-letter path"),
    });
  });

  it("keeps POSIX paths and keys identical after realpath", async () => {
    await expect(
      canonicalizeHostPath({
        path: "/home/me/link/",
        platform: "linux",
        realpath: async () => "/home/me/repo",
        stat: directoryStat(),
      }),
    ).resolves.toEqual({ path: "/home/me/repo", pathKey: "/home/me/repo" });
  });

  it("rejects relative and Windows input on POSIX", async () => {
    for (const input of ["repo", "C:\\repo"]) {
      await expect(
        canonicalizeHostPath({
          path: input,
          platform: "linux",
          realpath: async () => input,
          stat: directoryStat(),
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
    }
  });

  it("rejects missing paths and files", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    await expect(
      canonicalizeHostPath({
        path: "/srv/missing",
        platform: "linux",
        realpath: async () => "/srv/missing",
        stat: async () => {
          throw missing;
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("does not exist"),
    });
    await expect(
      canonicalizeHostPath({
        path: "/srv/file.txt",
        platform: "linux",
        realpath: async () => "/srv/file.txt",
        stat: async () => ({ isDirectory: () => false }),
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("not a directory"),
    });
  });
});

describe("canonicalizeHostPathCommand", () => {
  it("resolves a real directory on this host", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-canonical-"));
    tempDirs.push(root);
    const target = path.join(root, "Mixed Case");
    await fs.mkdir(target);
    const expected = await fs.realpath(target);
    const result = await canonicalizeHostPathCommand({
      type: "host.canonicalize_path",
      path: `${target}${path.sep}`,
    });
    expect(result.path.toLowerCase()).toBe(expected.toLowerCase());
    expect(result.pathKey).toBe(
      process.platform === "win32"
        ? result.path.replace(/\\/gu, "/").toLowerCase()
        : result.path,
    );
  });

  it.runIf(process.platform === "win32")(
    "restores the on-disk casing of a lowercased Windows path",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-canonical-"));
      tempDirs.push(root);
      const target = path.join(root, "CamelCase");
      await fs.mkdir(target);
      const result = await canonicalizeHostPathCommand({
        type: "host.canonicalize_path",
        path: target.toLowerCase().replace(/\\/gu, "/"),
      });
      expect(result.path.endsWith("\\CamelCase")).toBe(true);
      expect(result.path.startsWith("\\\\?\\")).toBe(false);
      expect(result.pathKey).toBe(result.path.replace(/\\/gu, "/").toLowerCase());
    },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/host-daemon-contract exec vitest run test/contract.test.ts -t "host-daemon command schemas"` and `pnpm --filter @bb/host-daemon exec vitest run src/command-handlers/canonicalize-path.test.ts`.
Expected: FAIL (version 199, unknown command type, missing module).

- [ ] **Step 3: Add the contract**

In `packages/host-daemon-contract/src/commands.ts`, next to `hostPathsExistCommandSchema`:

```ts
const hostCanonicalizePathCommandSchema = z
  .object({
    type: z.literal("host.canonicalize_path"),
    path: z.string().min(1),
  })
  .strict();

export const canonicalHostPathSchema = z
  .object({
    path: z.string().min(1),
    pathKey: z.string().min(1),
  })
  .strict();
export type CanonicalHostPath = z.infer<typeof canonicalHostPathSchema>;
```

Registry entry after `"host.paths_exist"`:

```ts
  "host.canonicalize_path": defineHostDaemonCommandDescriptor({
    type: "host.canonicalize_path",
    schema: hostCanonicalizePathCommandSchema,
    resultSchema: canonicalHostPathSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
```

Make sure `CanonicalHostPath` and `canonicalHostPathSchema` are reachable from `@bb/host-daemon-contract` (follow how `pathsExistResponseSchema` is exported).

`packages/host-daemon-contract/src/protocol.ts`: `export const HOST_DAEMON_PROTOCOL_VERSION = 200 as const;`

- [ ] **Step 4: Implement the daemon handler**

Create `apps/host-daemon/src/command-handlers/canonicalize-path.ts`:

```ts
import { realpath as realpathCallback } from "node:fs";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import {
  buildHostPathKey,
  detectHostPathFlavor,
  isUncOrDeviceHostPath,
  normalizeHostPath,
} from "@bb/domain";
import type { CanonicalHostPath } from "@bb/host-daemon-contract";
import {
  CommandDispatchError,
  type CommandOf,
} from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";

const WINDOWS_EXTENDED_LENGTH_PREFIX = "\\\\?\\";
const realpathNative = promisify(realpathCallback.native);

export interface CanonicalizeHostPathArgs {
  path: string;
  platform: NodeJS.Platform;
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isDirectory(): boolean }>;
}

function stripExtendedLengthPrefix(path: string): string {
  return path.startsWith(WINDOWS_EXTENDED_LENGTH_PREFIX)
    ? path.slice(WINDOWS_EXTENDED_LENGTH_PREFIX.length)
    : path;
}

function assertAcceptedShape(path: string, platform: NodeJS.Platform): void {
  if (isUncOrDeviceHostPath(path)) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${path}" is a UNC or device path; only drive-letter paths are supported`,
    );
  }
  const flavor = detectHostPathFlavor(path);
  if (platform === "win32" && flavor !== "windows") {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${path}" must be a drive-absolute path such as C:\\Users\\me\\repo`,
    );
  }
  if (platform !== "win32" && flavor !== "posix") {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${path}" must be an absolute path`,
    );
  }
}

export async function canonicalizeHostPath(
  args: CanonicalizeHostPathArgs,
): Promise<CanonicalHostPath> {
  assertAcceptedShape(args.path, args.platform);
  let isDirectory: boolean;
  try {
    isDirectory = (await args.stat(args.path)).isDirectory();
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT") || isFsErrorWithCode(error, "ENOTDIR")) {
      throw new CommandDispatchError(
        "invalid_path",
        `Path "${args.path}" does not exist`,
      );
    }
    throw error;
  }
  if (!isDirectory) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${args.path}" is not a directory`,
    );
  }
  const resolved = await args.realpath(args.path);
  const candidate =
    args.platform === "win32" ? stripExtendedLengthPrefix(resolved) : resolved;
  if (args.platform === "win32" && detectHostPathFlavor(candidate) !== "windows") {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${args.path}" resolves to "${resolved}", which is not a drive-letter path`,
    );
  }
  const path = normalizeHostPath(candidate);
  return { path, pathKey: buildHostPathKey(path) };
}

export async function canonicalizeHostPathCommand(
  command: CommandOf<"host.canonicalize_path">,
): Promise<CanonicalHostPath> {
  return canonicalizeHostPath({
    path: command.path,
    platform: process.platform,
    realpath: (path) => realpathNative(path),
    stat: (path) => fs.stat(path),
  });
}
```

Register in `apps/host-daemon/src/command-dispatch.ts`: import `canonicalizeHostPathCommand` from `./command-handlers/canonicalize-path.js` and add `"host.canonicalize_path": canonicalizeHostPathCommand,` right after `"host.paths_exist": checkHostPathsExist,` in `onlineRpcHandlers`.

- [ ] **Step 5: Run the tests and typechecks**

Run: the two commands from Step 2, then `pnpm exec turbo run typecheck --filter=@bb/host-daemon-contract --filter=@bb/host-daemon --filter=@bb/server --filter=@bb/app --filter=@bb/scripts`, then `pnpm exec turbo run test --filter=@bb/host-daemon-contract`, and grep the repo for the literal `199` next to `PROTOCOL` (`git grep -n "toBe(199)"`) to confirm no other pin exists.
Expected: all green; the `windows-x64` job and the reference desktop run the `it.runIf(win32)` case (Task 11).

- [ ] **Step 6: Commit**

```bash
git add packages/host-daemon-contract apps/host-daemon/src/command-handlers/canonicalize-path.ts apps/host-daemon/src/command-handlers/canonicalize-path.test.ts apps/host-daemon/src/command-dispatch.ts
git commit -m "Add host.canonicalize_path and bump the host daemon protocol to 200

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 4: Drive-absolute project paths in `@bb/domain`

**Files:**
- Modify: `packages/domain/src/project-path.ts` (rewrite)
- Modify: `packages/domain/test/project-path.test.ts` (rewrite)

**Interfaces:**
- Consumes: `basenameHostPath`, `isAbsoluteHostPath`, `isHostPathRoot`, `isUncOrDeviceHostPath`, `normalizeHostPath` (Task 2).
- Produces: `INVALID_PROJECT_PATH_MESSAGE`, `PROJECT_PATH_ROOT_MESSAGE`, `UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE`, `isAbsoluteProjectPath(path)`, `normalizeProjectPathInput(path)`, `getProjectPathValidationMessage(path)`, `deriveProjectNameFromPath(path)`. `isNativeWindowsProjectPath` and `UNSUPPORTED_NATIVE_WINDOWS_PROJECT_PATH_MESSAGE` are deleted; `git grep` for both names must be empty after this task (the only importer today is the test file).

- [ ] **Step 1: Rewrite the test file**

Replace `packages/domain/test/project-path.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
  deriveProjectNameFromPath,
  getProjectPathValidationMessage,
  INVALID_PROJECT_PATH_MESSAGE,
  isAbsoluteProjectPath,
  normalizeProjectPathInput,
  PROJECT_PATH_ROOT_MESSAGE,
  UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE,
} from "../src/project-path.js";

describe("project-path", () => {
  const windowsProjectPath = "C:\\Users\\michael\\bb";
  const uncProjectPath = "\\\\server\\share\\bb";

  it("derives a project name from POSIX paths", () => {
    expect(deriveProjectNameFromPath("/srv/repos/bb")).toBe("bb");
    expect(deriveProjectNameFromPath("/srv/repos/bb/")).toBe("bb");
    expect(deriveProjectNameFromPath("/mnt/c/Users/michael/bb/")).toBe("bb");
  });

  it("derives a project name from Windows paths with either separator", () => {
    expect(deriveProjectNameFromPath(windowsProjectPath)).toBe("bb");
    expect(deriveProjectNameFromPath("C:/Users/michael/bb/")).toBe("bb");
    expect(deriveProjectNameFromPath("c:\\users\\michael\\bb\\")).toBe("bb");
  });

  it("does not derive a project name from roots, UNC paths or relative paths", () => {
    expect(deriveProjectNameFromPath("/")).toBe("");
    expect(deriveProjectNameFromPath("C:\\")).toBe("");
    expect(deriveProjectNameFromPath("c:/")).toBe("");
    expect(deriveProjectNameFromPath(uncProjectPath)).toBe("");
    expect(deriveProjectNameFromPath("relative/bb")).toBe("");
  });

  it("recognizes absolute paths of both flavors", () => {
    expect(isAbsoluteProjectPath("/srv/repos/bb")).toBe(true);
    expect(isAbsoluteProjectPath("/mnt/c/Users/michael/bb")).toBe(true);
    expect(isAbsoluteProjectPath(windowsProjectPath)).toBe(true);
    expect(isAbsoluteProjectPath("  C:/Users/michael/bb  ")).toBe(true);
    expect(isAbsoluteProjectPath(uncProjectPath)).toBe(false);
    expect(isAbsoluteProjectPath("C:Users\\michael\\bb")).toBe(false);
    expect(isAbsoluteProjectPath("relative/path")).toBe(false);
  });

  it("normalizes input without collapsing roots", () => {
    expect(normalizeProjectPathInput("/srv/repos/bb/")).toBe("/srv/repos/bb");
    expect(normalizeProjectPathInput("/")).toBe("/");
    expect(normalizeProjectPathInput(" c:/Users/michael/bb/ ")).toBe(
      windowsProjectPath,
    );
    expect(normalizeProjectPathInput(`${windowsProjectPath}\\`)).toBe(
      windowsProjectPath,
    );
    expect(normalizeProjectPathInput("c:")).toBe("C:\\");
    expect(normalizeProjectPathInput(uncProjectPath)).toBe(uncProjectPath);
    expect(normalizeProjectPathInput("   ")).toBe("");
  });

  it("returns clear validation messages", () => {
    expect(getProjectPathValidationMessage("/srv/repos/bb")).toBeNull();
    expect(getProjectPathValidationMessage(windowsProjectPath)).toBeNull();
    expect(getProjectPathValidationMessage("c:/Users/michael/bb/")).toBeNull();
    expect(getProjectPathValidationMessage("/")).toBe(PROJECT_PATH_ROOT_MESSAGE);
    expect(getProjectPathValidationMessage("C:\\")).toBe(PROJECT_PATH_ROOT_MESSAGE);
    expect(getProjectPathValidationMessage("relative/path")).toBe(
      INVALID_PROJECT_PATH_MESSAGE,
    );
    expect(getProjectPathValidationMessage("C:Users\\michael\\bb")).toBe(
      INVALID_PROJECT_PATH_MESSAGE,
    );
    expect(getProjectPathValidationMessage("")).toBe(INVALID_PROJECT_PATH_MESSAGE);
    expect(getProjectPathValidationMessage(uncProjectPath)).toBe(
      UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE,
    );
    expect(getProjectPathValidationMessage("//server/share/bb")).toBe(
      UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE,
    );
    expect(getProjectPathValidationMessage("\\\\?\\C:\\Users\\michael\\bb")).toBe(
      UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bb/domain exec vitest run test/project-path.test.ts`
Expected: FAIL (missing `UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE`, Windows paths rejected).

- [ ] **Step 3: Rewrite the module**

Replace `packages/domain/src/project-path.ts` with:

```ts
import {
  basenameHostPath,
  isAbsoluteHostPath,
  isHostPathRoot,
  isUncOrDeviceHostPath,
  normalizeHostPath,
} from "./host-path.js";

export const INVALID_PROJECT_PATH_MESSAGE =
  "Project path must be an absolute path.";
export const PROJECT_PATH_ROOT_MESSAGE =
  "Project path must point to a project directory, not the filesystem root.";
export const UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE =
  "UNC and device paths are not supported. Use a drive-letter path like C:\\Users\\me\\repo.";

export function isAbsoluteProjectPath(path: string): boolean {
  return isAbsoluteHostPath(path.trim());
}

export function normalizeProjectPathInput(path: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath || !isAbsoluteHostPath(trimmedPath)) {
    return trimmedPath;
  }
  return normalizeHostPath(trimmedPath);
}

export function getProjectPathValidationMessage(path: string): string | null {
  const normalizedPath = normalizeProjectPathInput(path);
  if (!normalizedPath) {
    return INVALID_PROJECT_PATH_MESSAGE;
  }
  if (isUncOrDeviceHostPath(normalizedPath)) {
    return UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE;
  }
  if (!isAbsoluteHostPath(normalizedPath)) {
    return INVALID_PROJECT_PATH_MESSAGE;
  }
  if (isHostPathRoot(normalizedPath)) {
    return PROJECT_PATH_ROOT_MESSAGE;
  }
  return null;
}

export function deriveProjectNameFromPath(path: string): string {
  const normalizedPath = normalizeProjectPathInput(path);
  if (getProjectPathValidationMessage(normalizedPath) !== null) {
    return "";
  }
  return basenameHostPath(normalizedPath);
}
```

- [ ] **Step 4: Sweep stale names and verify consumers**

Run `git grep -n "isNativeWindowsProjectPath\|UNSUPPORTED_NATIVE_WINDOWS_PROJECT_PATH_MESSAGE\|Native Windows paths are not supported"` — expected: no hits outside `docs/superpowers/` history. Consumers (`apps/app/src/components/dialogs/ProjectPathDialog.tsx`, `ProjectMachineSetupDialog.tsx`, `RemotePathBrowser.tsx`, `apps/app/src/hooks/useLocalPathPicker.tsx`, `useQuickCreateProject.tsx`, `packages/server-contract/src/api/projects.ts`) keep compiling unchanged.

Run: `pnpm --filter @bb/domain exec vitest run test/project-path.test.ts`, then `pnpm exec turbo run test typecheck --filter=@bb/domain --filter=@bb/server-contract`, then `pnpm --filter @bb/app exec vitest run src/components/dialogs/ProjectPathDialog.test.tsx src/hooks/useLocalPathPicker.test.tsx src/hooks/useQuickCreateProject.test.tsx src/components/dialogs/RemotePathBrowser.breadcrumb.test.ts`, then `pnpm exec turbo run typecheck --filter=@bb/app`.
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/project-path.ts packages/domain/test/project-path.test.ts
git commit -m "Accept drive-absolute project paths and reject UNC paths

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 5: `path_key` columns, migration and key-based data access

**Files:**
- Modify: `packages/db/src/schema.ts:411-509`
- Create (generated): `packages/db/drizzle/0117_path_key.sql`, `packages/db/drizzle/meta/0117_snapshot.json`; Modify (generated): `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/migrate.ts` (new pre-check called from `migrate()` after `assertNoDuplicatePendingInteractionProviderRequests`)
- Modify: `packages/db/src/data/environments.ts`, `packages/db/src/data/projects.ts`, `packages/db/src/data/project-sources.ts`
- Modify: `packages/db/test/migrate.test.ts`, `packages/db/test/data/environments.test.ts`, `packages/db/test/data/projects.test.ts`, `packages/db/test/data/project-sources.test.ts`
- Modify: `apps/server/test/helpers/seed.ts` (`seedProjectWithSource`, `seedEnvironment`) and every `apps/server` source or test call site of the renamed functions (find them with `git grep`), passing `buildHostPathKey(path)` from `@bb/domain` until Task 6 replaces the server-side callers with daemon-canonical keys.

**Interfaces:**
- Consumes: `buildHostPathKey` (Task 2).
- Produces:
  - Columns `project_sources.path_key` and `environments.path_key` (nullable text); indexes `project_sources_host_path_key_idx (host_id, path_key)`, `environments_host_path_key_idx (host_id, path_key)`, partial unique `environments_live_path_key_idx (project_id, host_id, path_key) WHERE status != 'destroyed' AND path_key IS NOT NULL`. The existing `environments_project_host_path_idx` stays.
  - `CreateProjectLocalPathSourceInput { type: "local_path"; hostId: string; path: string; pathKey: string }` (projects.ts) and `CreateLocalPathProjectSourceInput` (project-sources.ts) with the same `pathKey: string`.
  - `UpdateLocalPathProjectSourceInput { location?: { path: string; pathKey: string }; isDefault?: true }`.
  - `getPublicProjectByLocalPathSource` matches on `pathKey`.
  - `CreateEnvironmentInput` gains `pathKey?: string | null`, set together with `path` (throws `Environment path and pathKey must be set together` otherwise).
  - `findProjectEnvironmentByHostPathKey(db, projectId, hostId, pathKey)`, `findProviderEnvironmentContainingPathKey(db, pathKey)`, `findForeignManagedEnvironmentAtHostPathKey(db, { hostId, pathKey, projectId })`, `claimEnvironmentPathKey(db, provisioning, pathKey, force?)`, `findEnvironmentPathClaim(db, hostId, pathKey | null, owner)` (the `claim_path` column now stores keys), `bindEnvironmentPath(db, provisioning, location: { path: string; pathKey: string })`. The raw-path versions are removed.
  - `listEnvironments` keeps its raw `path` filter (client-facing filter; ruling).

- [ ] **Step 1: Write the failing DB tests**

In `packages/db/test/data/environments.test.ts` add (using the file's existing `setup()` and `noopNotifier`; when creating environments pass both `path` and `pathKey`):

```ts
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
    updateEnvironment(db, noopNotifier, first.id, { status: "destroyed", path: null, pathKey: null });
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
    expect(findProviderEnvironmentContainingPathKey(db, "c:/work/bb/packages/x")?.id).toBe(owner.id);
    expect(findProviderEnvironmentContainingPathKey(db, "c:/work/bb")?.id).toBe(owner.id);
    expect(findProviderEnvironmentContainingPathKey(db, "c:/work/bbx")).toBeNull();
  });
```

If the file has no `updateEnvironment` import, use the helper the existing teardown tests in the same file use to mark a row destroyed (the test named `keeps a path unique while provider teardown is pending` shows the pattern) and keep the assertion. Update every existing `createEnvironment`/`bindEnvironmentPath`/`claimEnvironmentPath` call in this file to the new signatures (`pathKey: path` for POSIX fixtures).

In `packages/db/test/data/projects.test.ts` add:

```ts
  it("returns the existing project for a differently spelled path with the same key", () => {
    const { db, host } = setup();
    const first = findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "bb",
      source: { type: "local_path", hostId: host.id, path: "C:\\Work\\bb", pathKey: "c:/work/bb" },
    });
    const second = findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "bb again",
      source: { type: "local_path", hostId: host.id, path: "c:\\work\\BB", pathKey: "c:/work/bb" },
    });
    expect(second.project.id).toBe(first.project.id);
    expect(second.source.path).toBe("C:\\Work\\bb");
    expect(listProjects(db).filter((project) => project.id === first.project.id)).toHaveLength(1);
  });
```

In `packages/db/test/data/project-sources.test.ts` add:

```ts
  it("re-points a source with a new path and key", () => {
    const { db, host, project } = setup();
    const source = listProjectSources(db, project.id)[0]!;
    const updated = updateProjectSource(db, noopNotifier, source.id, {
      location: { path: "D:\\Work\\bb", pathKey: "d:/work/bb" },
    });
    expect(updated?.path).toBe("D:\\Work\\bb");
    expect(
      db.select({ pathKey: projectSources.pathKey }).from(projectSources).where(eq(projectSources.id, source.id)).get()?.pathKey,
    ).toBe("d:/work/bb");
  });
```

(add the `projectSources`/`eq` imports the file lacks). Update every `createProject`/`createProjectSource` fixture in the three test files to pass `pathKey` equal to its POSIX `path`.

In `packages/db/test/migrate.test.ts` add, next to `fails clearly before provider-request uniqueness migration when pending interaction duplicates exist`:

```ts
  it("fails clearly before the path_key migration when live environments share a host path", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE environments (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          host_id text NOT NULL,
          path text,
          status text NOT NULL
        );
        INSERT INTO environments (id, project_id, host_id, path, status) VALUES
          ('env_a', 'proj_1', 'host_1', '/srv/repo', 'ready'),
          ('env_b', 'proj_1', 'host_1', '/srv/repo', 'provisioning'),
          ('env_c', 'proj_1', 'host_1', '/srv/repo', 'destroyed'),
          ('env_d', 'proj_1', 'host_1', '/srv/other', 'ready');
      `);

      expect(() => migrate(db)).toThrow(
        /Collisions: proj_1\/host_1\/\/srv\/repo ids=env_a, env_b\./u,
      );
    } finally {
      closeConnection(db);
    }
  });

  it("backfills path_key from path and installs the live-row unique index", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      db.$client.exec(`
        DROP INDEX environments_live_path_key_idx;
        DROP INDEX environments_host_path_key_idx;
        DROP INDEX project_sources_host_path_key_idx;
        ALTER TABLE environments DROP COLUMN path_key;
        ALTER TABLE project_sources DROP COLUMN path_key;
      `);
      db.$client
        .prepare<[number]>("DELETE FROM __drizzle_migrations WHERE created_at = ?")
        .run(pathKeyMigrationWhen);
      const host = upsertHost(db, noopNotifier, { name: "host", type: "persistent" });
      const now = Date.now();
      db.$client
        .prepare("INSERT INTO projects (id, name, sort_key, created_at, updated_at) VALUES ('proj_1', 'bb', 'a0', ?, ?)")
        .run(now, now);
      db.$client
        .prepare(
          "INSERT INTO project_sources (id, project_id, type, host_id, path, is_default, created_at, updated_at) VALUES ('src_1', 'proj_1', 'local_path', ?, '/srv/repo', 1, ?, ?)",
        )
        .run(host.id, now, now);
      db.$client
        .prepare(
          "INSERT INTO environments (id, project_id, host_id, path, status, created_at, updated_at) VALUES ('env_1', 'proj_1', ?, '/srv/repo', 'ready', ?, ?)",
        )
        .run(host.id, now, now);

      migrate(db);

      expect(
        db.$client.prepare<[], { pathKey: string }>("SELECT path_key AS pathKey FROM project_sources WHERE id = 'src_1'").get(),
      ).toEqual({ pathKey: "/srv/repo" });
      expect(
        db.$client.prepare<[], { pathKey: string }>("SELECT path_key AS pathKey FROM environments WHERE id = 'env_1'").get(),
      ).toEqual({ pathKey: "/srv/repo" });
      expect(
        db.$client
          .prepare<[], { name: string; partial: number; unique: number }>("PRAGMA index_list(environments)")
          .all()
          .find((index) => index.name === "environments_live_path_key_idx"),
      ).toMatchObject({ partial: 1, unique: 1 });
    } finally {
      closeConnection(db);
    }
  });
```

Define `pathKeyMigrationWhen` the way the file defines the other `...MigrationWhen` constants (read the tag's `when` from `drizzle/meta/_journal.json`). If the `projects` insert needs more NOT NULL columns than shown, add them with the defaults the schema declares.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/db exec vitest run test/data/environments.test.ts test/data/projects.test.ts test/data/project-sources.test.ts test/migrate.test.ts`
Expected: FAIL (unknown columns, unknown functions).

- [ ] **Step 3: Change the schema and generate the migration**

`packages/db/src/schema.ts`, `project_sources`: add `pathKey: text("path_key"),` after `path`, and `index("project_sources_host_path_key_idx").on(table.hostId, table.pathKey),` after `project_sources_host_idx`.

`environments`: add `pathKey: text("path_key"),` after `path`; in the index list add after `environments_host_path_lookup_idx`:

```ts
    index("environments_host_path_key_idx").on(table.hostId, table.pathKey),
    uniqueIndex("environments_live_path_key_idx")
      .on(table.projectId, table.hostId, table.pathKey)
      .where(sql`${table.status} != 'destroyed' AND ${table.pathKey} IS NOT NULL`),
```

Run: `pnpm exec turbo run db:generate --filter=@bb/db -- --name path_key`
Expected: `packages/db/drizzle/0117_path_key.sql`, `meta/0117_snapshot.json` and a new `_journal.json` entry with tag `0117_path_key`. If drizzle-kit ignores `--name`, rename the generated `.sql` and the journal `tag` together (never edit the snapshot).

Edit `0117_path_key.sql` so the backfill runs after the columns exist and before the indexes:

```sql
ALTER TABLE `environments` ADD `path_key` text;--> statement-breakpoint
ALTER TABLE `project_sources` ADD `path_key` text;--> statement-breakpoint
UPDATE `environments` SET `path_key` = `path` WHERE `path` IS NOT NULL AND `path_key` IS NULL;--> statement-breakpoint
UPDATE `project_sources` SET `path_key` = `path` WHERE `path` IS NOT NULL AND `path_key` IS NULL;--> statement-breakpoint
CREATE INDEX `environments_host_path_key_idx` ON `environments` (`host_id`,`path_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `environments_live_path_key_idx` ON `environments` (`project_id`,`host_id`,`path_key`) WHERE "environments"."status" != 'destroyed' AND "environments"."path_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `project_sources_host_path_key_idx` ON `project_sources` (`host_id`,`path_key`);
```

Keep drizzle-kit's exact spelling of the generated statements; only insert the two `UPDATE` lines.

- [ ] **Step 4: Add the collision pre-check**

In `packages/db/src/migrate.ts` add near `PendingInteractionProviderRequestDuplicateRow`:

```ts
interface LiveEnvironmentPathCollisionRow {
  projectId: string;
  hostId: string;
  path: string;
  ids: string;
  duplicateCount: number;
}
```

and near `assertNoDuplicatePendingInteractionProviderRequests`:

```ts
function assertNoLiveEnvironmentPathCollisions(db: DbConnection): void {
  const columnNames = getTableInfo(db, "environments").map(
    (column) => column.name,
  );
  if (
    columnNames.includes("path_key") ||
    !columnNames.includes("path") ||
    !columnNames.includes("status")
  ) {
    return;
  }

  const collisions = db.$client
    .prepare<[], LiveEnvironmentPathCollisionRow>(
      `
        SELECT
          project_id AS projectId,
          host_id AS hostId,
          path,
          GROUP_CONCAT(id, ', ') AS ids,
          COUNT(*) AS duplicateCount
        FROM environments
        WHERE path IS NOT NULL
          AND status != 'destroyed'
        GROUP BY project_id, host_id, path
        HAVING COUNT(*) > 1
        ORDER BY duplicateCount DESC, project_id, host_id, path
        LIMIT 10
      `,
    )
    .all();
  if (collisions.length === 0) {
    return;
  }

  throw new Error(
    [
      "Cannot add environments.path_key because live environments already share a path on one host.",
      "Each project keeps one live environment per host path; destroy or delete the duplicates before restarting.",
      `Collisions: ${collisions
        .map((row) => `${row.projectId}/${row.hostId}/${row.path} ids=${row.ids}`)
        .join("; ")}.`,
    ].join(" "),
  );
}
```

Call it in `migrate()` right after `assertNoDuplicatePendingInteractionProviderRequests(db);`.

- [ ] **Step 5: Move data access onto keys**

`packages/db/src/data/environments.ts`:
- `CreateEnvironmentInput`: add `pathKey?: string | null;`. In `createEnvironment`, before the insert: `if ((input.path == null) !== (input.pathKey == null)) throw new Error("Environment path and pathKey must be set together");` and write `pathKey: input.pathKey ?? null`.
- Rename `findProjectEnvironmentByHostPath` → `findProjectEnvironmentByHostPathKey(db, projectId, hostId, pathKey)` matching `eq(environments.pathKey, pathKey)`.
- Rename `findProviderEnvironmentContainingPath` → `findProviderEnvironmentContainingPathKey(db, pathKey)` with `or(eq(environments.pathKey, pathKey), sql\`${pathKey} LIKE ${environments.pathKey} || '/%'\`)`.
- Rename `findForeignManagedEnvironmentAtHostPath` → `findForeignManagedEnvironmentAtHostPathKey(db, { hostId, pathKey, projectId })` with the same key predicate.
- `claimEnvironmentPath` → `claimEnvironmentPathKey(db, provisioning, pathKey, force?)`; `findEnvironmentPathClaim(db, hostId, pathKey | null, owner)`; the stored `claim_path` is the key.
- `bindEnvironmentPath(db, provisioning, location: { path: string; pathKey: string })`: the existence lookup uses `eq(environments.pathKey, location.pathKey)`; when rehoming, also clear `pathKey: null` on the current row; on the direct path (no existing row) set `path: location.path, pathKey: location.pathKey` wherever the current implementation writes `path`. Read the function before editing: today it returns `current` unchanged when no other row exists, so add an explicit `tx.update(environments).set({ path: location.path, pathKey: location.pathKey }).where(eq(environments.id, current.id))` in that branch only if the current code relies on a later `updateEnvironment` call to write `path`; trace `runCreate` in `apps/server/src/services/environments/environment-engine.ts` and keep whichever site writes `path` today, adding `pathKey` beside it.
- Any `updateEnvironment` input that accepts `path` also accepts `pathKey`.

`packages/db/src/data/projects.ts`: `CreateProjectLocalPathSourceInput` gains `pathKey: string`; `getPublicProjectWithLocalPathSource` uses `eq(projectSources.pathKey, source.pathKey)` instead of `path`; `insertProject` writes `pathKey: input.source.pathKey`.

`packages/db/src/data/project-sources.ts`: `CreateLocalPathProjectSourceInput` gains `pathKey: string` (written on insert); `UpdateLocalPathProjectSourceInput` becomes `{ location?: { path: string; pathKey: string }; isDefault?: true }` and `updateProjectSource` writes `path`/`pathKey` from `location`.

Update the server call sites so the tree typechecks (`git grep -n "findProjectEnvironmentByHostPath\|findProviderEnvironmentContainingPath\|findForeignManagedEnvironmentAtHostPath\|claimEnvironmentPath\|bindEnvironmentPath\|findEnvironmentPathClaim" apps/server`): pass `buildHostPathKey(path)` (imported from `@bb/domain`) where a key is required, `location: { path, pathKey: buildHostPathKey(path) }` in `routes/projects.ts` `updateSource`, and `pathKey: buildHostPathKey(path)` in `routes/projects.ts` `create`/`createSource`. In `apps/server/test/helpers/seed.ts`, `seedProjectWithSource` and `seedEnvironment` set `pathKey: buildHostPathKey(path)` whenever they set `path`. Fix remaining test call sites the same way.

- [ ] **Step 6: Run the tests and typechecks**

Run: `pnpm exec turbo run test typecheck --filter=@bb/db`, then `pnpm exec turbo run typecheck --filter=@bb/server`, then `pnpm exec turbo run test --filter=@bb/server` piped to a file (`2>&1 | tee /tmp/server-tests.txt` on POSIX or `| Tee-Object` on Windows) and inspect the tail.
Expected: `@bb/db` green; `@bb/server` green on POSIX, and on Windows no test file fails that passed in `qa/windows/phase-0/31-test-baseline.md` (compare file names).

- [ ] **Step 7: Commit**

```bash
git add packages/db apps/server
git commit -m "Store host path keys for project sources and environments

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 6: Server host paths, daemon canonicalization and the POSIX gates

**Files:**
- Create: `apps/server/src/services/hosts/host-paths.ts`
- Create: `apps/server/test/services/hosts/host-paths.test.ts`
- Modify: `apps/server/src/routes/projects.ts` (`create` ~359, `createSource` ~466, `updateSource` ~534)
- Modify: `apps/server/src/services/environments/environment-engine.ts:364-377, 391-436`
- Modify: `apps/server/src/services/threads/workspace-paths.ts`, `workspace-path-claims.ts`, `thread-environment-directory.ts:89-108`, `apps/server/src/services/environments/path-admission.ts`, `apps/server/src/services/plugins/plugin-registration.ts:423`
- Modify: `apps/server/test/helpers/commands.ts` (`registerTestHostRpcCapture`)
- Create: `apps/server/test/threads/workspace-paths.test.ts`, `apps/server/test/threads/environment-directory-path.test.ts`
- Modify: `apps/server/test/services/environments/provider-orchestration.test.ts`, `apps/server/test/public/public-projects-local-host.test.ts`

**Interfaces:**
- Consumes: `host.canonicalize_path` (Task 3), `@bb/domain` host-path helpers (Task 2), key-based DB functions (Task 5).
- Produces:
  - `canonicalizeHostPath(deps: WorkSessionDeps, args: { hostId: string; path: string }): Promise<CanonicalHostPath>`: when the host has an open daemon session (`deps.hub.getDaemonSessionIdForHost(hostId) !== null`) it calls `host.canonicalize_path` and daemon `invalid_path` failures become `ApiError(400, "invalid_path", <daemon message>)`; when the host is offline it returns `{ path: normalizeHostPath(path), pathKey: buildHostPathKey(path) }` so projects can still be registered for a disconnected machine (today's behaviour, pinned by `creates projects and local sources when inspection is unavailable`); transport failures of a connected host keep their 502 shape.
  - `managedWorkspaceRoots(dataDir: string): string[]`.
  - `validateEnvironmentDirectoryPath(path: string): string | null` exported from `thread-environment-directory.ts`.
  - The test daemon (`registerTestHostRpcCapture`) answers `host.canonicalize_path` with `{ path: normalizeHostPath(path), pathKey: buildHostPathKey(path) }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/threads/workspace-paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isBbManagedWorkspacePath } from "../../src/services/threads/workspace-paths.js";

describe("isBbManagedWorkspacePath", () => {
  it("recognizes POSIX managed roots and their children", () => {
    const dataDir = "/home/me/.bb";
    expect(isBbManagedWorkspacePath({ dataDir, path: "/home/me/.bb/worktrees" })).toBe(true);
    expect(isBbManagedWorkspacePath({ dataDir, path: "/home/me/.bb/worktrees/env/repo" })).toBe(true);
    expect(isBbManagedWorkspacePath({ dataDir, path: "/home/me/.bb/personal-workspaces/env" })).toBe(true);
    expect(isBbManagedWorkspacePath({ dataDir, path: "/home/me/.bb/worktrees-other" })).toBe(false);
    expect(isBbManagedWorkspacePath({ dataDir, path: "/home/me/repo" })).toBe(false);
  });

  it("recognizes Windows managed roots regardless of spelling", () => {
    const dataDir = "C:\\Users\\me\\.bb";
    expect(isBbManagedWorkspacePath({ dataDir, path: "c:/users/ME/.bb/worktrees/env/repo" })).toBe(true);
    expect(isBbManagedWorkspacePath({ dataDir, path: "C:\\Users\\me\\.bb\\personal-workspaces\\env" })).toBe(true);
    expect(isBbManagedWorkspacePath({ dataDir, path: "C:\\Users\\me\\.bbx\\worktrees\\env" })).toBe(false);
    expect(isBbManagedWorkspacePath({ dataDir, path: "/Users/me/.bb/worktrees/env" })).toBe(false);
  });
});
```

Create `apps/server/test/threads/environment-directory-path.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateEnvironmentDirectoryPath } from "../../src/services/threads/thread-environment-directory.js";

describe("validateEnvironmentDirectoryPath", () => {
  it("accepts absolute paths of both flavors", () => {
    expect(validateEnvironmentDirectoryPath("/srv/repo")).toBeNull();
    expect(validateEnvironmentDirectoryPath("C:\\Work\\bb")).toBeNull();
    expect(validateEnvironmentDirectoryPath("c:/work/bb")).toBeNull();
  });

  it("rejects relative, root, UNC and NUL paths", () => {
    expect(validateEnvironmentDirectoryPath("repo")).toMatch(/absolute/u);
    expect(validateEnvironmentDirectoryPath("/")).toMatch(/filesystem root/u);
    expect(validateEnvironmentDirectoryPath("C:\\")).toMatch(/filesystem root/u);
    expect(validateEnvironmentDirectoryPath("\\\\server\\share\\repo")).toMatch(/UNC/u);
    expect(validateEnvironmentDirectoryPath("/srv/re\0po")).toMatch(/NUL/u);
  });
});
```

Create `apps/server/test/services/hosts/host-paths.test.ts` using `withTestHarness`, `seedHostSession` and `registerHostRpcResponder` (see `apps/server/test/public/public-project-clone-sources.test.ts` for the harness idiom):

```ts
  it("returns the daemon's canonical path and key", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, { id: "host-canon" });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type !== "host.canonicalize_path") {
            throw new Error(`unexpected ${request.command.type}`);
          }
          return { ok: true, result: { path: "C:\\Work\\bb", pathKey: "c:/work/bb" } };
        },
      });
      await expect(
        canonicalizeHostPath(harness.deps, { hostId: host.id, path: "c:/work/bb/" }),
      ).resolves.toEqual({ path: "C:\\Work\\bb", pathKey: "c:/work/bb" });
    }));

  it("surfaces daemon path rejections as 400 invalid_path", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, { id: "host-canon-bad" });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({ ok: false, errorCode: "invalid_path", errorMessage: 'Path "\\\\srv\\x" is a UNC or device path; only drive-letter paths are supported' }),
      });
      await expect(
        canonicalizeHostPath(harness.deps, { hostId: host.id, path: "\\\\srv\\x" }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_path" });
    }));

  it("builds managed roots with the host's separator", () => {
    expect(managedWorkspaceRoots("/home/me/.bb")).toEqual(["/home/me/.bb/worktrees", "/home/me/.bb/personal-workspaces"]);
    expect(managedWorkspaceRoots("C:\\Users\\me\\.bb")).toEqual(["C:\\Users\\me\\.bb\\worktrees", "C:\\Users\\me\\.bb\\personal-workspaces"]);
  });
```

In `apps/server/test/public/public-projects-local-host.test.ts` add (the file already imports `seedHostSession`, `readJson`, `listPublicProjects`, `withTestHarness` and defines `projectResponseSchema`):

```ts
  it("resolves differently spelled Windows paths to one project on a connected host", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-windows-identity" });
      seedPrimaryHost(harness.deps, host.id);

      const create = (name: string, path: string) =>
        harness.app.request("/api/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            source: { type: "local_path", hostId: host.id, path },
          }),
        });

      const firstResponse = await create("Windows Project", "C:/Work/bb/");
      const repeatedResponse = await create("Windows Project Again", "c:\\work\\bb");

      expect(firstResponse.status).toBe(201);
      expect(repeatedResponse.status).toBe(201);
      const firstProject = projectResponseSchema.parse(await readJson(firstResponse));
      const repeatedProject = projectResponseSchema.parse(await readJson(repeatedResponse));
      expect(repeatedProject.id).toBe(firstProject.id);
      expect(firstProject.sources).toEqual([
        expect.objectContaining({ path: "C:\\Work\\bb" }),
      ]);
      expect(listPublicProjects(harness.db)).toHaveLength(1);
    });
  });

  it("registers a Windows project for an offline host with a shape-derived key", async () => {
    await withTestHarness(async (harness) => {
      const offlinePrimary = seedHost(harness.deps, { id: "host-windows-offline" });
      seedPrimaryHost(harness.deps, offlinePrimary.id);

      const response = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Offline Windows Project",
          source: { type: "local_path", hostId: offlinePrimary.id, path: "c:/Work/bb/" },
        }),
      });

      expect(response.status).toBe(201);
      const project = projectResponseSchema.parse(await readJson(response));
      expect(project.sources).toEqual([
        expect.objectContaining({ path: "C:\\Work\\bb" }),
      ]);
    });
  });

  it("rejects UNC project paths at the API boundary", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-unc" });
      seedPrimaryHost(harness.deps, host.id);

      const response = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "UNC Project",
          source: { type: "local_path", hostId: host.id, path: "\\\\server\\share\\bb" },
        }),
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        message: expect.stringContaining("UNC and device paths are not supported"),
      });
    });
  });
```

The connected-host case is canonicalized by the test daemon (Step 3); the offline case exercises the server-side fallback. Adjust the 400 body assertion to the validation error shape the route returns (`onValidationError` in `registerProjectRoutes`). In `apps/server/test/services/hosts/host-paths.test.ts` also add `it("falls back to shape normalization when the host is offline", ...)`: `seedHost` without a session, then `canonicalizeHostPath(harness.deps, { hostId, path: "c:/work/bb/" })` resolves to `{ path: "C:\\work\\bb", pathKey: "c:/work/bb" }`.

In `apps/server/test/services/environments/provider-orchestration.test.ts` add next to `normalizes trailing slashes on claimed paths`:

```ts
  it("binds a Windows workspace by its key and reuses it for an equivalent path", async () =>
    withTestHarness(async (harness) => {
      const fixture = setup(harness, {
        create: async (context) => {
          expect(await context.experimental_claimPath("C:\\Work\\bb\\")).toBe(true);
          return { status: "created", path: "c:/work/bb/", ownsPath: false };
        },
      });
      fixture.ask();
      await fixture.settled();
      expect(fixture.row()).toMatchObject({ path: "C:\\work\\bb", pathKey: "c:/work/bb", status: "ready" });

      const competitor = seedThread(harness.deps, { projectId: fixture.context.project.id, status: "starting" });
      const second = reserveEnvironment(harness.db, {
        ...fixture.row(),
        ownerThreadId: competitor.id,
        status: "creating" as const,
        path: null,
        pathKey: null,
        claimPath: null,
      });
      expect(claimEnvironmentPathKey(harness.db, second, "c:/work/bb")).toBe(false);
      expect(
        listEnvironments(harness.db, { projectId: fixture.context.project.id }).filter((row) => row.status !== "destroyed" && row.pathKey === "c:/work/bb"),
      ).toHaveLength(1);
    }));
```

Adapt the helper names to the ones the file already imports; the test daemon canonicalizes `c:/work/bb/` to `C:\work\bb` (Step 3), so the stored display path keeps the provider's segment casing while the key is lower-cased.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/server exec vitest run test/threads/workspace-paths.test.ts test/threads/environment-directory-path.test.ts test/services/hosts/host-paths.test.ts test/public/public-projects-local-host.test.ts test/services/environments/provider-orchestration.test.ts`
Expected: FAIL (missing modules/exports, Windows paths rejected).

- [ ] **Step 3: Teach the test daemon to canonicalize**

In `apps/server/test/helpers/commands.ts` `registerTestHostRpcCapture`, next to the `plugin.host.dispose`/`plugin.host.cancel` auto-response, add:

```ts
      if (command.type === "host.canonicalize_path") {
        const path = normalizeHostPath(command.path);
        deps.hub.recordHostOnlineRpcResponse({
          message: hostDaemonOnlineRpcResponseMessageSchema.parse({
            type: "host-rpc.response",
            requestId: message.requestId,
            commandType: command.type,
            ok: true,
            result: { path, pathKey: buildHostPathKey(path) },
          }),
          sessionId: args.sessionId,
        });
        return;
      }
```

(import `buildHostPathKey`, `normalizeHostPath` from `@bb/domain`).

- [ ] **Step 4: Add the server helpers**

Create `apps/server/src/services/hosts/host-paths.ts`:

```ts
import { buildHostPathKey, joinHostPath, normalizeHostPath } from "@bb/domain";
import type { CanonicalHostPath } from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { WorkSessionDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "./online-rpc.js";

const CANONICALIZE_PATH_TIMEOUT_MS = 15_000;

export async function canonicalizeHostPath(
  deps: WorkSessionDeps,
  args: { hostId: string; path: string },
): Promise<CanonicalHostPath> {
  if (deps.hub.getDaemonSessionIdForHost(args.hostId) === null) {
    const path = normalizeHostPath(args.path);
    return { path, pathKey: buildHostPathKey(path) };
  }
  try {
    return await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: CANONICALIZE_PATH_TIMEOUT_MS,
      command: { type: "host.canonicalize_path", path: args.path },
    });
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "invalid_path") {
      throw new ApiError(400, "invalid_path", error.body.message, false);
    }
    throw error;
  }
}

export function managedWorkspaceRoots(dataDir: string): string[] {
  return [
    joinHostPath(dataDir, "worktrees"),
    joinHostPath(dataDir, "personal-workspaces"),
  ];
}
```

Check `ApiError`'s constructor and `code` property name in `apps/server/src/errors.ts` and adjust the field access; the daemon's `ok: false` answer reaches the server as `ApiError(502, errorCode, errorMessage)` (`online-rpc.ts:128`).

- [ ] **Step 5: Route the gates through the helpers**

`workspace-paths.ts`:

```ts
import { isHostPathWithin } from "@bb/domain";
import { managedWorkspaceRoots } from "../hosts/host-paths.js";

export function isBbManagedWorkspacePath(args: {
  dataDir: string;
  path: string;
}): boolean {
  return managedWorkspaceRoots(args.dataDir).some((rootPath) =>
    isHostPathWithin({ rootPath, candidatePath: args.path }),
  );
}
```

`workspace-path-claims.ts`: `ForeignProviderOwnedPathCheckArgs` gains `pathKey: string`; call `findForeignManagedEnvironmentAtHostPathKey(db, { hostId, pathKey, projectId })` and `findProjectEnvironmentByHostPathKey(db, projectId, hostId, pathKey)`; keep `path` for `isBbManagedWorkspacePath`.

`thread-environment-directory.ts`: replace `normalizeDirectoryPath` with `normalizeHostPath` and `validateDirectoryPath` with the exported

```ts
export function validateEnvironmentDirectoryPath(path: string): string | null {
  if (isUncOrDeviceHostPath(path)) {
    return "Path must be a drive-letter path; UNC and device paths are not supported.";
  }
  if (!isAbsoluteHostPath(path)) {
    return "Path must be an absolute path on the current host.";
  }
  if (isHostPathRoot(path)) {
    return "Path must name a project directory, not the filesystem root.";
  }
  if (path.includes("\0")) {
    return "Path must not contain NUL bytes.";
  }
  return null;
}
```

Where the tool looks up or creates an environment for the validated path, first call `canonicalizeHostPath(deps, { hostId, path })` and use the returned `path`/`pathKey` for the lookup (`findProjectEnvironmentByHostPathKey`) and for any `createEnvironment`/`bindEnvironmentPath` write; keep the daemon's `invalid_path` message as the tool failure text.

`path-admission.ts`: `const pathKey = buildHostPathKey(args.path);` and pass it to both `findEnvironmentPathClaim` calls (the first call keeps `null`).

`plugin-registration.ts:423`: `findProviderEnvironmentContainingPathKey(deps.db, buildHostPathKey(rootDir))`.

`environment-engine.ts`:

```ts
            experimental_claimPath: async (value) => {
              const path = z
                .string()
                .min(1)
                .refine(isAbsoluteHostPath)
                .refine((path) => !path.includes("\0"))
                .parse(value);
              if (signal.aborted) return false;
              return claimEnvironmentPathKey(
                deps.db,
                provisioning,
                buildHostPathKey(path),
              );
            },
```

and in the `created` branch:

```ts
        const canonical = await canonicalizeHostPath(deps, {
          hostId: context.host.id,
          path: result.path,
        });
        const producedPath = canonical.path;
        const { dataDir } = await ensureHostSessionReadyForWork(deps, {
          hostId: context.host.id,
        });
        deps.db.transaction(
          () => {
            const refusal = foreignProviderOwnedPathRefusal(deps.db, {
              dataDir,
              hostId: context.host.id,
              path: producedPath,
              pathKey: canonical.pathKey,
              projectId: context.project.id,
            });
            if (refusal !== null) throw new Error(refusal);
            const claimed = claimEnvironmentPathKey(
              deps.db,
              provisioning,
              canonical.pathKey,
              true,
            );
            if (!claimed)
              throw new Error(
                "Workspace path is already claimed by another provisioning.",
              );
            const existing = findProjectEnvironmentByHostPathKey(
              deps.db,
              context.project.id,
              context.host.id,
              canonical.pathKey,
            );
            ...unchanged provider-identity check...
            provisioning = bindEnvironmentPath(deps.db, provisioning, {
              path: producedPath,
              pathKey: canonical.pathKey,
            });
          },
          { behavior: "immediate" },
        );
        result = { ...result, path: producedPath };
```

Replace the `buildHostPathKey(...)` placeholders Task 5 left in `routes/projects.ts`:

```ts
  post(routes.create, async (context, payload) => {
    const { source } = payload;
    requireNonDestroyedHostWithStatus(deps, source.hostId);
    assertUsableHostId(deps, { hostId: source.hostId });
    const canonical = await canonicalizeHostPath(deps, {
      hostId: source.hostId,
      path: source.path,
    });
    const resolvedSource = {
      ...source,
      path: canonical.path,
      pathKey: canonical.pathKey,
    };
    const existingProject = getPublicProjectByLocalPathSource(deps.db, resolvedSource);
    ...rest unchanged, using resolvedSource for the git inspection and findOrCreateProjectByLocalPathSource...
```

Keep the existing `source.type === "local_path"` guard if the request schema allows other types. `createSource`: `local_path` → canonicalize `payload.path`; `clone` → canonicalize `resolved.path` after the clone completes; pass `pathKey` to `createProjectSource`. `updateSource`: when `payload.path` is set, canonicalize it (`existing.hostId`) and pass `location: { path, pathKey }`.

- [ ] **Step 6: Run the tests and typechecks**

Run: the command from Step 2, then `pnpm exec turbo run typecheck --filter=@bb/server`, then `pnpm exec turbo run test --filter=@bb/server` piped to a file; inspect failures.
Expected: green on POSIX; on Windows no new failing test file versus `qa/windows/phase-0/31-test-baseline.md`.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "Canonicalize host paths through the daemon and compare by key on the server

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 7: Managed paths in the workspace plugins use the host's native separator

**Files:**
- Modify: `plugins/environment-git-worktree/host/paths.ts`
- Modify: `plugins/environment-git-worktree/host/paths.test.ts`
- Modify: `plugins/environment-personal-workspace/host/paths.ts`
- Create: `plugins/environment-personal-workspace/host/paths.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (plugin host code runs on the host; `dataDir` is native).
- Produces: `deriveRepoDirName` accepts Windows source paths; `resolveWorktreesRoot`, `resolveWorktreeAttemptRoot`, `resolveWorktreeTargetPath`, `resolveWorkspacePath` build with `node:path` `join`.

- [ ] **Step 1: Write the failing tests**

In `plugins/environment-git-worktree/host/paths.test.ts` add rows to the `it.each` table:

```ts
  ["Windows local path", "C:\\Users\\someone\\code\\my-repo", "my-repo"],
  ["Windows path with forward slashes and trailing slash", "C:/Users/someone/code/my-repo/", "my-repo"],
  ["Windows path with trailing backslash", "C:\\code\\my-repo\\", "my-repo"],
  ["Windows dotted name", "D:\\code\\my.repo", "my.repo"],
```

and a new test:

```ts
import os from "node:os";
import path from "node:path";

it("builds managed paths with the host's native separator", () => {
  const dataDir = path.join(os.tmpdir(), "bb-data");
  expect(resolveWorktreesRoot(dataDir)).toBe(path.join(dataDir, "worktrees"));
  expect(
    resolveWorktreeTargetPath({ dataDir, pathKey: "thr_1", sourcePath: "/x/repo" }),
  ).toBe(path.join(dataDir, "worktrees", "thr_1", "repo"));
  expect(() =>
    resolveWorktreeAttemptRoot({ dataDir, pathKey: "../escape" }),
  ).toThrow(/single path segment/u);
});
```

Create `plugins/environment-personal-workspace/host/paths.test.ts`:

```ts
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRemovableWorkspacePath,
  resolveWorkspacePath,
  WORKSPACES_DIR_NAME,
} from "./paths.js";

describe("personal workspace paths", () => {
  const dataDir = path.join(os.tmpdir(), "bb-personal");

  it("builds the workspace path with the host's native separator", () => {
    expect(resolveWorkspacePath({ dataDir, pathKey: "thr_a" })).toBe(
      path.join(dataDir, WORKSPACES_DIR_NAME, "thr_a"),
    );
  });

  it("rejects keys that are not a single segment", () => {
    expect(() => resolveWorkspacePath({ dataDir, pathKey: "../x" })).toThrow(/single path segment/u);
    expect(() => resolveWorkspacePath({ dataDir, pathKey: "a/b" })).toThrow(/single path segment/u);
  });

  it("only removes paths under the workspace roots", () => {
    const own = path.join(dataDir, WORKSPACES_DIR_NAME, "thr_a");
    expect(assertRemovableWorkspacePath({ dataDir, path: own })).toBe(path.resolve(own));
    expect(() =>
      assertRemovableWorkspacePath({ dataDir, path: path.join(dataDir, "elsewhere", "thr_a") }),
    ).toThrow(/outside the personal workspace roots/u);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter bb-plugin-environment-git-worktree exec vitest run host/paths.test.ts` and `pnpm --filter bb-plugin-environment-personal-workspace exec vitest run host/paths.test.ts`.
Expected: the Windows rows fail with `invalid_source_path`; the personal workspace test passes or fails only on the separator assertion when run on Windows.

- [ ] **Step 3: Use native path joins**

`plugins/environment-git-worktree/host/paths.ts`:

```ts
import { WorkspaceError } from "bb-environment-provider-host/git";
import path from "node:path";

const REPO_DIR_NAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;

function tryParseUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ssh:"
    ) {
      return url.pathname;
    }
  } catch {}
  return null;
}

function sourceBasename(pathPart: string): string {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(pathPart)) {
    return path.win32.basename(pathPart.replace(/[\\/]+$/u, ""));
  }
  return path.posix.basename(pathPart.replace(/\/+$/u, ""));
}

export function deriveRepoDirName(sourcePath: string): string {
  const trimmed = sourcePath.replace(/\/+$/, "");

  const scpMatch = /^[^:/\\]+@[^:]+:(?<path>.+)$/.exec(trimmed);
  const pathPart =
    scpMatch?.groups?.path ?? tryParseUrlPath(trimmed) ?? trimmed;

  const basename = sourceBasename(pathPart);
  const candidate = basename.endsWith(".git")
    ? basename.slice(0, -".git".length)
    : basename;

  if (
    !candidate ||
    candidate === "." ||
    candidate === ".." ||
    !REPO_DIR_NAME_PATTERN.test(candidate)
  ) {
    throw new WorkspaceError(
      "invalid_source_path",
      `Cannot derive repository directory name from source "${sourcePath}"`,
    );
  }
  return candidate;
}

export function resolveWorktreesRoot(dataDir: string): string {
  return path.join(dataDir, "worktrees");
}

export function resolveWorktreeAttemptRoot(args: {
  dataDir: string;
  pathKey: string;
}): string {
  if (
    args.pathKey === "." ||
    args.pathKey === ".." ||
    path.basename(args.pathKey) !== args.pathKey ||
    /[\\/]/u.test(args.pathKey)
  ) {
    throw new WorkspaceError(
      "invalid_path_key",
      "A worktree path key must be a single path segment",
    );
  }
  return path.join(resolveWorktreesRoot(args.dataDir), args.pathKey);
}

export function resolveWorktreeTargetPath(args: {
  dataDir: string;
  pathKey: string;
  sourcePath: string;
}): string {
  return path.join(
    resolveWorktreeAttemptRoot(args),
    deriveRepoDirName(args.sourcePath),
  );
}
```

`plugins/environment-personal-workspace/host/paths.ts`: in `isSinglePathSegment` add `&& !/[\\/]/u.test(value)`; in `resolveWorkspacePath` replace `path.posix.join` with `path.join`.

- [ ] **Step 4: Run the tests and typechecks**

Run: the two commands from Step 2, then `pnpm exec turbo run test typecheck --filter=bb-plugin-environment-git-worktree --filter=bb-plugin-environment-personal-workspace`.
Expected: green on POSIX. On Windows the `host.test.ts` suites of both plugins were already failing in the Phase 0 baseline (they shell out to `mkdir -p`/`sleep`); record that they still fail for that reason only (Task 10 documents it).

- [ ] **Step 5: Commit**

```bash
git add plugins/environment-git-worktree/host plugins/environment-personal-workspace/host
git commit -m "Derive managed workspace paths with the host's native separator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 8: Drive-absolute file paths and links in the app

**Files:**
- Modify: `apps/app/src/lib/absolute-file-path.ts`, `apps/app/src/lib/absolute-file-path.test.ts`
- Modify: `apps/app/src/components/ui/markdown-local-file-link.ts`, `markdown-local-file-link.test.ts`
- Modify: `apps/app/src/components/ui/markdown-local-file-link-normalize.ts`, `markdown-local-file-link-normalize.test.ts`
- Modify: `apps/app/src/hooks/useQuickCreateProject.test.tsx`

Donor: `git show refs/remotes/upstream-pr/3188:apps/app/src/lib/absolute-file-path.ts` (and `.test.ts`), `...:apps/app/src/components/ui/markdown-local-file-link.ts` (and `.test.ts`), `...:apps/app/src/components/ui/markdown-local-file-link-normalize.ts`. Port the drive-letter logic; drop every UNC, `\\?\` and rooted-`\` branch and their tests.

**Interfaces:**
- Consumes: `deriveProjectNameFromPath` now names Windows paths (Task 4).
- Produces: `isAbsoluteFilePath(path)` and `isWindowsAbsoluteFilePath(path)` exported from `@/lib/absolute-file-path`; `normalizeAbsoluteFilePath`, `isAbsoluteFilePathWithinRoot`, `buildAbsoluteFilePath`, `resolveAbsoluteFilePath`, `getAbsoluteDirname` handle `C:\...` paths; markdown links accept `C:\...`/`C:/...` destinations and render `file:///C:/...` anchors.

- [ ] **Step 1: Write the failing tests**

Append to `apps/app/src/lib/absolute-file-path.test.ts`:

```ts
describe("windows absolute file paths", () => {
  it("normalizes drive paths and resolves dot segments", () => {
    expect(normalizeAbsoluteFilePath({ path: "c:/Users/me/../me/repo/./file.ts" })).toBe("C:\\Users\\me\\repo\\file.ts");
    expect(normalizeAbsoluteFilePath({ path: "C:\\" })).toBe("C:\\");
    expect(normalizeAbsoluteFilePath({ path: "\\\\server\\share\\file" })).toBeNull();
    expect(normalizeAbsoluteFilePath({ path: "repo\\file" })).toBeNull();
  });

  it("checks containment case-insensitively within a Windows root", () => {
    expect(isAbsoluteFilePathWithinRoot({ candidatePath: "c:/users/ME/repo/src/a.ts", rootPath: "C:\\Users\\me\\repo" })).toBe(true);
    expect(isAbsoluteFilePathWithinRoot({ candidatePath: "C:\\Users\\me\\repo2\\a.ts", rootPath: "C:\\Users\\me\\repo" })).toBe(false);
    expect(isAbsoluteFilePathWithinRoot({ candidatePath: "/Users/me/repo/a.ts", rootPath: "C:\\Users\\me\\repo" })).toBe(false);
  });

  it("builds and resolves paths under a Windows root", () => {
    expect(buildAbsoluteFilePath({ path: "src/a.ts", rootPath: "C:\\Users\\me\\repo\\" })).toBe("C:\\Users\\me\\repo\\src\\a.ts");
    expect(resolveAbsoluteFilePath({ path: "C:\\other\\b.ts", rootPath: "C:\\Users\\me\\repo" })).toBe("C:\\other\\b.ts");
    expect(getAbsoluteDirname({ path: "C:\\Users\\me\\repo\\a.ts" })).toBe("C:\\Users\\me\\repo");
    expect(getAbsoluteDirname({ path: "C:\\a.ts" })).toBe("C:\\");
  });
});
```

Add to `markdown-local-file-link.test.ts` (mirror the surrounding POSIX cases for parse, relative resolution and anchor building):

```ts
  it("parses Windows absolute file hrefs", () => {
    expect(parseLocalFileHref({ href: "C:\\Users\\me\\repo\\README.md", requireLikelyFileBasename: true })).toMatchObject({ path: "C:\\Users\\me\\repo\\README.md" });
    expect(parseLocalFileHref({ href: "file:///C:/Users/me/repo/README.md", requireLikelyFileBasename: true })).toMatchObject({ path: "C:/Users/me/repo/README.md" });
    expect(parseLocalFileHref({ href: "\\\\server\\share\\README.md", requireLikelyFileBasename: true })).toBeNull();
  });

  it("resolves relative hrefs against a Windows base directory", () => {
    expect(resolveRelativeLocalFileHref({ href: "docs/guide.md", baseDir: "C:\\Users\\me\\repo", rootPath: "C:\\Users\\me\\repo" })).toMatchObject({ path: "C:\\Users\\me\\repo\\docs\\guide.md" });
  });

  it("builds file URLs for Windows paths", () => {
    expect(buildLocalFileAnchorHref({ path: "C:\\Users\\me\\repo\\README.md", lineRange: null }, undefined)).toBe("file:///C:/Users/me/repo/README.md");
  });
```

Adapt the argument shapes to the functions' real signatures in the file. Add to `markdown-local-file-link-normalize.test.ts` a case where `[x](C:\Users\me\My Notes\file.md)` is wrapped in angle brackets like the POSIX space case. In `apps/app/src/hooks/useQuickCreateProject.test.tsx` add a case submitting `C:\Work\bb` and expecting the mutation to be called with `name: "bb"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/app exec vitest run src/lib/absolute-file-path.test.ts src/components/ui/markdown-local-file-link.test.ts src/components/ui/markdown-local-file-link-normalize.test.ts src/hooks/useQuickCreateProject.test.tsx`
Expected: the new cases fail.

- [ ] **Step 3: Port the donor logic (drive-letter only)**

`absolute-file-path.ts`: add `detectHostPathFlavor` (`/` → posix, `/^[A-Za-z]:[\\/]/u` → windows, else null), `isWindowsAbsoluteFilePath`, `isAbsoluteFilePath` (exported), `resolveDotSegments`, `normalizeWindowsFilePath` (unify to `\`, uppercase drive, resolve dot segments, root stays `C:\`), `normalizePosixFilePath`, the Windows arm of `isAbsoluteFilePathWithinRoot` (lower-cased comparison with a trailing `\`), `buildWindowsFilePath`, `getWindowsDirname`; keep the POSIX behaviour byte-identical to today.

`markdown-local-file-link.ts`: split basenames on `/[/\\]/u`; `isValidAbsoluteLocalFilePath` gains the Windows arm (no trailing separator, no `\n`/`\r`/`?`/`#`/control characters); `parseAbsoluteLocalFileHref` uses `isAbsoluteFilePath`; `resolveRelativeLocalFileHref` rejects absolute inputs with `isAbsoluteFilePath` and joins with `buildAbsoluteFilePath`; `parseLocalFileHref` strips the leading `/` from `file:///C:/...` pathnames; `buildAbsoluteFileUrl` emits `file:///C:/...` with `\` turned into `/` and segments percent-encoded, returning `null` for UNC input.

`markdown-local-file-link-normalize.ts`: `isLocalFileMarkdownDestination` becomes `destination.startsWith("file://") || isAbsoluteFilePath(destination)`.

- [ ] **Step 4: Run the tests and typechecks**

Run: the command from Step 2, then `pnpm exec turbo run typecheck --filter=@bb/app`, then `pnpm --filter @bb/app exec vitest run src/lib src/components/ui/markdown-local-file-link.test.ts src/components/ui/markdown-local-file-link-normalize.test.ts src/lib/thread-local-file-links.test.ts src/components/ui/markdown-document-link-routing.test.ts src/components/ui/markdown-file-image-routing.test.ts` (skip files that do not exist).
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/lib/absolute-file-path.ts apps/app/src/lib/absolute-file-path.test.ts apps/app/src/components/ui/markdown-local-file-link.ts apps/app/src/components/ui/markdown-local-file-link.test.ts apps/app/src/components/ui/markdown-local-file-link-normalize.ts apps/app/src/components/ui/markdown-local-file-link-normalize.test.ts apps/app/src/hooks/useQuickCreateProject.test.tsx
git commit -m "Handle drive-absolute file paths and links in the app

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 9: `resolveInheritedDevSkillsRootPaths` without `"/"` joins

**Files:**
- Modify: `packages/config/src/runtime.ts:229-245`
- Modify: `packages/scripts/test/run-dev.test.ts:141-192`

**Interfaces:**
- Consumes: nothing.
- Produces: the same function signature; parent data dir computed by walking up with `resolve`, so the result uses the host separator on every platform.

- [ ] **Step 1: Write the failing test**

In `packages/scripts/test/run-dev.test.ts`, next to `inherits parent bb skills for managed worktree dev apps`, add:

```ts
  it.runIf(process.platform === "win32")(
    "inherits parent bb skills for a Windows managed worktree dev app",
    () => {
      const homeDir = "C:\\Users\\tester";
      const repoRoot =
        "C:\\Users\\tester\\.bb-dev\\code-bb-abc123\\worktrees\\env_feature\\bb";
      expect(resolveInheritedDevSkillsRootPaths({ homeDir, repoRoot })).toEqual([
        "C:\\Users\\tester\\.bb-dev\\code-bb-abc123\\skills",
        "C:\\Users\\tester\\.bb\\skills",
      ]);
    },
  );
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @bb/scripts exec vitest run test/run-dev.test.ts`
Expected: on Windows the new case fails with a mixed-separator path; on POSIX it is skipped and the three existing cases pass.

- [ ] **Step 3: Implement**

```ts
export function resolveInheritedDevSkillsRootPaths(
  args: ResolveInheritedDevSkillsRootPathsArgs,
): string[] {
  const roots = [join(resolveProdDataDir({ homeDir: args.homeDir }), "skills")];
  const repoRoot = resolve(args.repoRoot);
  const segments = repoRoot.split(/[\\/]+/u);
  const worktreesIndex = segments.lastIndexOf(MANAGED_WORKTREE_DIR_NAME);
  if (worktreesIndex <= 0) {
    return roots;
  }

  const levelsUp = segments.length - worktreesIndex;
  const parentDataDir = resolve(repoRoot, ...Array.from({ length: levelsUp }, () => ".."));

  return Array.from(new Set([join(parentDataDir, "skills"), ...roots]));
}
```

- [ ] **Step 4: Run the tests and typechecks**

Run: `pnpm exec turbo run test typecheck --filter=@bb/config --filter=@bb/scripts` (on the reference desktop as well as POSIX; Task 11 records the Windows run).
Expected: green; the three POSIX cases keep their exact expectations.

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/runtime.ts packages/scripts/test/run-dev.test.ts
git commit -m "Resolve inherited dev skill roots without joining on slashes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/platform-windows.md` (status table row 1, new section "Host identity and paths", known limitations, evidence list)
- Modify: `docs/platform-support.md` (only if it enumerates host platforms or path formats; otherwise leave it)
- Sweep: `git grep -n "/mnt/c\|Native Windows paths\|WSL path" docs plugins/bb-guide apps/app/src --` and update copy that tells users native Windows paths are unsupported.

- [ ] **Step 1: Update `docs/platform-windows.md`**

Status row: `| 1 Host identity and host-owned paths | landed; evidence under \`qa/windows/phase-1/\` |`.

New section after "Native add-ons":

```markdown
## Host identity and paths (Phase 1)

- A native Windows daemon reports `platform: "win32"` (`HOST_DAEMON_PROTOCOL_VERSION` 200); WSL daemons keep reporting `wsl`. The Machines settings label it "Windows".
- Project and environment paths may be drive-absolute (`C:\Users\me\repo`, `C:/Users/me/repo`). UNC (`\\server\share`), device (`\\.\`) and extended-length (`\\?\`) paths are rejected with a message naming drive-letter paths.
- The host daemon owns canonical paths: `host.canonicalize_path` resolves the on-disk casing and symlinks with `fs.realpath.native`, strips any `\\?\` prefix, and returns `{ path, pathKey }`. `path_key` is the comparison key stored next to `path` on `project_sources` and `environments` (`\` → `/`, lower-cased on Windows; unchanged on POSIX). `C:/Work/bb`, `C:\Work\bb` and `c:\work\BB` resolve to one project and one live environment (partial unique index `environments_live_path_key_idx`).
- When the host is connected, the daemon's canonical form is stored; when it is offline, the server stores the shape-normalized path and its shape-derived key (the same rule the migration backfill applies), so projects can still be registered for a disconnected machine.
- Managed worktrees and personal workspaces are derived with the host's native separator under `%USERPROFILE%\.bb\worktrees` and `%USERPROFILE%\.bb\personal-workspaces` (dev: `%USERPROFILE%\.bb-dev\<instance>\...`).
```

Known limitations additions (one bullet each): environment claims and the `isBbManagedWorkspacePath` containment check compute keys by shape on the server (no realpath) until the path exists; `listEnvironments` `path` query filter compares raw paths; app views that derive a file name with `split("/")` (`environment-queries.ts`, `project-queries.ts`, `api.ts`, `plugin-slot-resolvers.ts`, `file-opener-tabs.ts`, `rightPanelFileVisuals.ts`) show the full Windows path until Phase 3; the host directory browser cannot switch drives; the native folder picker stays macOS-only until Phase 2; the workspace plugin `host.test.ts` suites still shell out to `mkdir -p`/`sleep` and fail on Windows (Phase 2); `resolveInheritedDevSkillsRootPaths` is measured only on the reference desktop.

Evidence list: add the `qa/windows/phase-1/` files from Task 11.

- [ ] **Step 2: Run the docs sweep and commit**

Run the `git grep` from the Files list; update every hit that instructs users to use `/mnt/c/...` instead of native paths (keep WSL guidance where it is about WSL hosts).

```bash
git add docs plugins/bb-guide apps/app/src
git commit -m "Document Phase 1 host identity and path handling on native Windows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

(Adjust the `git add` list to the files actually touched.)

---

### Task 11: Phase gate and evidence

**Files:**
- Create: `qa/windows/phase-1/00-host.md`, `30-build-typecheck.txt`, `31-test-results.md`, `31-test-output-tail.txt`, `20-project-on-c.md`, `21-path-identity.md`, `22-managed-worktree.md`, `40-posix-check.md`, `41-ci-run.md`

**Interfaces:**
- Consumes: everything above; `qa/windows/scripts/summarize-turbo-run.mjs` and `qa/windows/phase-0/31-test-baseline.md` from Phase 0.
- Produces: the evidence the spec §7 Phase 1 gate requires.

Measurement rule for every command below: run it in one shell, append `EXIT=<code>` captured in that same shell to the evidence file, and paste the exact command line above the output.

- [ ] **Step 1: Host facts**

`qa/windows/phase-1/00-host.md`: date, `git rev-parse HEAD`, `node -v`, `pnpm -v`, `git --version`, Windows build (`[System.Environment]::OSVersion.Version`).

- [ ] **Step 2: Build and typecheck on the reference desktop**

```powershell
nvm use 22.19.0
pnpm exec turbo run build typecheck --output-logs=new-only 2>&1 | Tee-Object -Append qa/windows/phase-1/30-build-typecheck.txt; "EXIT=$LASTEXITCODE" | Tee-Object -Append qa/windows/phase-1/30-build-typecheck.txt
```

Expected: `EXIT=0`, all tasks successful.

- [ ] **Step 3: Tests on the reference desktop**

```powershell
pnpm exec turbo run test --continue --summarize --output-logs=errors-only --filter=@bb/domain --filter=@bb/db --filter=@bb/host-daemon-contract --filter=@bb/desktop-contract --filter=@bb/server-contract --filter=@bb/config --filter=@bb/scripts --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/app --filter=@bb/desktop --filter=bb-plugin-environment-git-worktree --filter=bb-plugin-environment-personal-workspace 2>&1 | Tee-Object qa/windows/phase-1/31-test-output.txt
node qa/windows/scripts/summarize-turbo-run.mjs | Tee-Object qa/windows/phase-1/31-test-results.md
```

Add to `31-test-results.md`: the commit SHA and Node version; a second table `package | failed/passed test files` for the failing packages taken from the vitest summaries in the output; a comparison column against `qa/windows/phase-0/31-test-baseline.md` listing any test file that fails now but did not fail then. Expected: `@bb/domain`, `@bb/db`, `@bb/host-daemon-contract`, `@bb/desktop-contract`, `@bb/server-contract`, `@bb/config` pass; the others show no newly failing file. Keep the last 200 lines of the output as `31-test-output-tail.txt` and delete `31-test-output.txt`.

- [ ] **Step 4: Project on `C:\` from the UI and the CLI**

Create two hook-less repositories: `git init C:\Users\olege\Work\phase1-ui` and `git init C:\Users\olege\Work\phase1-cli` (one commit each). Start the dev app (`pnpm dev:app`, see `docs/debugging-and-qa.md`), open the UI, add a project by browsing to `C:\Users\olege\Work\phase1-ui`, and record in `20-project-on-c.md`: the Machines settings label, the project id and the stored source path from `GET /projects/<id>` (use the dev server URL from `pnpm dev:status`). Then from PowerShell:

```powershell
$env:BB_SERVER_URL = "<dev server url>"
pnpm exec turbo run build --filter=@bb/cli
node apps/cli/bin/bb project create --name phase1-cli --root C:\Users\olege\Work\phase1-cli --json
```

Record the JSON and `EXIT`. Expected: both projects exist with drive-absolute paths.

- [ ] **Step 5: Path identity**

Against the dev server, POST `/projects` three times with `source.path` = `C:/Users/olege/Work/phase1-ui`, `C:\Users\olege\Work\phase1-ui\` and `c:\users\olege\work\PHASE1-UI` (use `Invoke-RestMethod` with the request shape from `packages/server-contract/src/api/projects.ts`). Record the three responses in `21-path-identity.md`. Expected: one project id, stored path `C:\Users\olege\Work\phase1-ui`. Also POST with `\\server\share\repo` and record the 400 body.

- [ ] **Step 6: Managed worktree provisions and is removed**

In the UI, start a thread in the `phase1-ui` project with the Worktree environment provider. Record in `22-managed-worktree.md`: the environment path from `GET /environments?projectId=...`, `git -C C:\Users\olege\Work\phase1-ui worktree list`, and `Test-Path` of the environment directory; then delete the environment (UI or `DELETE /environments/<id>`) and record `Test-Path` again and `git worktree list`. Expected: the path is `%USERPROFILE%\.bb-dev\<instance>\worktrees\<key>\phase1-ui`, exists while the environment is live, and is gone after removal. If provisioning fails for a reason outside this phase (a process, hook or terminal seam), record the exact error, cite the phase that owns it, and continue; the controller rules on the gate.

- [ ] **Step 7: POSIX check in WSL**

In WSL (`~/bb-posix-check`): `git fetch origin windows-native/phase-1 && git checkout windows-native/phase-1 && pnpm install --frozen-lockfile`, then the same Turbo test command as Step 3 (bash, `2>&1 | tee ~/phase1-posix.txt; echo "EXIT=$?"` in the same shell). Record the summariser table and `EXIT` in `40-posix-check.md`. Expected: every listed package passes.

- [ ] **Step 8: CI**

```bash
git push -u origin windows-native/phase-1
gh run list -R OlegFM/bb --branch windows-native/phase-1 --limit 3
```

Wait for `Windows x64 (windows-2025, Node 22.x)` to conclude (`gh run view <id> -R OlegFM/bb --json jobs`), record the run URL, job result and artifact name in `41-ci-run.md`, then cancel the run's queued Blacksmith jobs with `gh run cancel <id> -R OlegFM/bb` (and the `Version Lockstep` runs the push queued).

- [ ] **Step 9: Commit the evidence**

```bash
git add qa/windows/phase-1
git commit -m "Record the Phase 1 Windows gate evidence

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
git push
```

- [ ] **Step 10: Gate check**

Confirm before calling Phase 1 done:

- `30-build-typecheck.txt` ends with `EXIT=0`.
- `31-test-results.md` shows the six pure packages passing and no newly failing test file elsewhere.
- `20-project-on-c.md` shows a UI-created and a CLI-created project with drive-absolute paths.
- `21-path-identity.md` shows one project id for three spellings and a 400 for the UNC path.
- `22-managed-worktree.md` shows the worktree created and removed (or the documented out-of-phase blocker).
- `40-posix-check.md` shows every listed package green in WSL.
- `41-ci-run.md` links a green `windows-x64` job.
