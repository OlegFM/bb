# Native Windows Port — Phase 0 (Foundation and honest gating) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repository install, build and typecheck on native Windows 11 x64, replace the last bash-only developer entry point with a Node supervisor, add a non-required Windows CI leg, and record a measured per-package failing-test baseline.

**Architecture:** No product behaviour changes. Phase 0 removes the install-time `os` gates, teaches `scripts/ensure-native-modules.mjs` about all three native add-ons with Windows guidance, removes POSIX-only shell usage from package scripts and developer tooling, and adds the first Windows job to CI. Every platform-dependent function takes `platform` as a parameter so its win32 branch is unit-tested on Linux.

**Tech Stack:** pnpm 9.15.0, Turbo, Vitest 4, TypeScript (via `tsx --conditions=source` for scripts), oxlint JS plugins, GitHub Actions (`windows-2025`), node-pty 1.2.0-beta.15, better-sqlite3 12.10.0, @parcel/watcher 2.5.6.

**Spec:** `docs/superpowers/specs/2026-09-11-native-windows-port-design.md` (§7 Phase 0, §8 Verification, §9 Risks).

## Global Constraints

- Target is Windows 11 x64 only; no ARM64, no Windows 10 (spec §3).
- Platform is injected, never ambient: functions whose behaviour depends on the OS take `platform` as a parameter; `process.platform` is read only at composition roots (spec §4).
- `shell: true` is forbidden; `.cmd`/`.bat` run only for explicit CMD commands (spec §4).
- No native code path may spawn `wsl.exe` (spec §1).
- `HOST_DAEMON_PROTOCOL_VERSION` is not bumped in Phase 0 (spec §7).
- Code comments are forbidden in TypeScript and JavaScript except semantic tool directives (`AGENTS.md`); YAML workflow comments follow the existing `ci.yml` style.
- Builds, typechecks and tests run through Turbo: `pnpm exec turbo run <task> --filter=<pkg>` (`AGENTS.md`).
- Node 22.19.x (`.nvmrc`) is the primary verification runtime for Phase 0; a secondary install and build check on Node 24 is recorded as evidence only.
- pnpm is `9.15.0` (`packageManager`); on the reference desktop it comes from `corepack enable`.
- Commits are grouped by seam; each task below ends with one commit whose message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Donor policy (spec §10): the `bb wn` identity, root `ASSUMPTIONS.md`/`DECISIONS.md`/`KNOWN-ISSUES.md` and `qa-evidence/` are never ported; known limitations go to `docs/platform-windows.md`, evidence to `qa/windows/phase-0/`.
- Measurement rule (spec §8): no Windows behaviour is claimed until it has run on Windows; every gate below names the machine it ran on.
- Phase gate (spec §7): `pnpm install --frozen-lockfile` and `pnpm exec turbo run build typecheck` green on the reference desktop and on the Windows CI job; failing-test count per package recorded as the baseline in `qa/windows/phase-0/`.

## File Structure

| Path | Responsibility |
|---|---|
| `packages/bb-app/package.json`, `apps/desktop/package.json` | Drop the `os` allowlists (add `win32`) |
| `packages/bb-app/test/index.test.ts` | Pin the widened `os` list |
| `scripts/ensure-native-modules.mjs` | Verify `better-sqlite3`, `node-pty`, `@parcel/watcher`; Windows guidance; injected `platform` |
| `packages/scripts/test/ensure-native-modules.test.mjs` | Existing suite, extended with verify-only and win32 cases |
| `turbo.json` | `//#ensure-native-modules` inputs include `apps/host-daemon/package.json` |
| `packages/test-helpers/src/tmp-root.ts` (+ `index.ts`) | `tmpRoot(name)` for test files |
| `apps/server/vitest.config.ts`, `apps/host-daemon/vitest.config.ts`, `tests/integration/vitest.config.ts` | `BB_DATA_DIR` under `os.tmpdir()` |
| `packages/scripts/test/vitest-config-tmp-literals.test.mjs` | Ratchet: no `/tmp` literal in any `vitest*.config.ts` |
| `scripts/oxlint-plugin.mjs`, `.oxlintrc.json` | New rule `bb/no-tmp-path-literal` |
| `packages/scripts/test/oxlint-plugin.test.mjs` | First unit test for the plugin |
| `packages/connect-client/package.json`, `packages/secret-storage/package.json`, `packages/agent-runtime/package.json` | Portable `clean` and `test:unit` scripts |
| `tests/qa/scripts/run-root-command.mjs`, `tests/qa/package.json` | Cross-platform parent-PID lookup and `.cmd`-safe spawn |
| `.gitattributes` | CRLF for `*.cmd` and `*.bat` |
| `packages/scripts/src/lib/dev-app-launcher.ts` | Pure helpers and process control for the dev launcher |
| `packages/scripts/src/commands/run-dev-app.ts` | `current`, `status`, `stop`, `env`, `logs`, `help` entry point |
| `packages/scripts/test/dev-app-launcher.test.ts`, `packages/scripts/test/run-dev-app.test.mjs` | Launcher tests (replaces `bb-dev-app.test.mjs`) |
| `packages/scripts/package.json`, root `package.json`, `apps/desktop/README.md` | Wire the launcher behind `dev:app`, `dev:desktop`, `dev:status`, `dev:stop` |
| `docs/debugging-and-qa.md`, `apps/mobile/README.md`, `.bb/skills/verify-bb/**`, `.bb/skills/plugin-guide-maintenance/SKILL.md` | Reference sweep before `scripts/bb-dev-app` is deleted |
| `.github/workflows/ci.yml`, `packages/scripts/test/ci-workflow.test.ts` | Non-required `windows-x64` job |
| `docs/platform-windows.md`, `docs/platform-support.md` | Prerequisites, measurements, known limitations |
| `qa/windows/phase-0/*`, `qa/windows/scripts/summarize-turbo-run.mjs` | Evidence and the baseline summariser |

---

### Task 0: Reference-desktop prerequisites

**Files:** none in the repository. Machine setup on the Windows 11 Pro 26200 desktop, recorded in Task 10 docs.

- [ ] **Step 1: Make pnpm available and pin Node 22.19**

Run in PowerShell 7:

```powershell
corepack enable
winget install --id Schniz.fnm --accept-source-agreements --accept-package-agreements
fnm install 22.19.0
fnm use 22.19.0
node -v
pnpm -v
```

Expected: `v22.19.0` and `9.15.0`. Add `fnm env --use-on-cd | Out-String | Invoke-Expression` to `$PROFILE` so `fnm` follows `.nvmrc` in new shells.

- [ ] **Step 2: Long paths and symlinks**

```powershell
git config --global core.longpaths true
git config --global core.symlinks true
Start-Process reg -Verb RunAs -ArgumentList 'add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f'
```

Expected: the registry command asks for elevation once and returns `The operation completed successfully.` Enable Developer Mode in Settings → System → For developers so `core.symlinks` can create links without elevation.

- [ ] **Step 3: Record host facts**

```powershell
New-Item -ItemType Directory -Force -Path qa/windows/phase-0 | Out-Null
"# Host facts" | Out-File qa/windows/phase-0/00-host.md
(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture | Out-String) | Out-File -Append qa/windows/phase-0/00-host.md
"node $(node -v) pnpm $(pnpm -v) git $(git --version)" | Out-File -Append qa/windows/phase-0/00-host.md
"pwsh $($PSVersionTable.PSVersion)" | Out-File -Append qa/windows/phase-0/00-host.md
```

Expected: the file lists Windows 11 Pro 10.0.26200, Node 22.19.0, pnpm 9.15.0, Git 2.52. Do not commit yet; Task 11 commits all evidence together.

---

### Task 1: Remove the `os` install gates

**Files:**
- Modify: `packages/bb-app/package.json:35-38`
- Modify: `apps/desktop/package.json:7-10`
- Test: `packages/bb-app/test/index.test.ts:2154`

**Interfaces:**
- Consumes: nothing.
- Produces: `bb-app` and `@bb/desktop` install on `win32`; `packages/bb-app/scripts/build-host.mjs:109` propagates the widened list into the generated host package unchanged.

- [ ] **Step 1: Write the failing test**

In `packages/bb-app/test/index.test.ts` change line 2154:

```ts
    expect(metadata.os).toEqual(["darwin", "linux", "win32"]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec turbo run test --filter=bb-app -- -t "limits npm package metadata"`
Expected: FAIL with `expected [ 'darwin', 'linux' ] to deeply equal [ 'darwin', 'linux', 'win32' ]`.

- [ ] **Step 3: Widen both `os` fields**

`packages/bb-app/package.json`:

```json
  "os": [
    "darwin",
    "linux",
    "win32"
  ],
```

`apps/desktop/package.json`:

```json
  "os": [
    "darwin",
    "linux",
    "win32"
  ],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec turbo run test --filter=bb-app -- -t "limits npm package metadata"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bb-app/package.json apps/desktop/package.json packages/bb-app/test/index.test.ts
git commit -m "Allow bb-app and the desktop shell to install on win32

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Measure install and native add-ons on the reference desktop

**Files:**
- Create: `qa/windows/phase-0/10-install.txt`, `qa/windows/phase-0/11-native-modules.md`, `qa/windows/scripts/conpty-load-check.mjs`

**Interfaces:**
- Consumes: Task 1 (install would otherwise refuse `bb-app`).
- Produces: the measured answer to spec §9 "node-pty prebuilds"; the numbers Task 10 documents.

- [ ] **Step 1: Install with the pinned lockfile**

```powershell
pnpm install --frozen-lockfile 2>&1 | Tee-Object qa/windows/phase-0/10-install.txt
```

Expected: exit code 0. If pnpm reports `ERR_PNPM_UNSUPPORTED_PLATFORM`, Task 1 was not applied. If `node-pty` runs `node-gyp rebuild`, note it in Step 3; the tarball ships `prebuilds/win32-x64/conpty.node`, `conpty_console_list.node`, `conpty/conpty.dll` and `conpty/OpenConsole.exe`, so a rebuild means the prebuild step failed.

- [ ] **Step 2: Write the load check**

Create `qa/windows/scripts/conpty-load-check.mjs`:

```js
import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireFromHostDaemon = createRequire(
  resolve(process.cwd(), "apps", "host-daemon", "package.json"),
);
const pty = requireFromHostDaemon("node-pty");
const watcher = requireFromHostDaemon("@parcel/watcher");
const BetterSqlite3 = createRequire(
  resolve(process.cwd(), "packages", "db", "package.json"),
)("better-sqlite3");

const db = new BetterSqlite3(":memory:");
db.close();
process.stdout.write(`better-sqlite3 ok (ABI ${process.versions.modules})\n`);
process.stdout.write(`@parcel/watcher ok (${typeof watcher.subscribe})\n`);

const shell = process.platform === "win32" ? "cmd.exe" : "sh";
const args = process.platform === "win32" ? ["/d", "/c", "echo conpty-ok"] : ["-c", "echo conpty-ok"];
const child = pty.spawn(shell, args, { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
let output = "";
child.onData((chunk) => {
  output += chunk;
});
child.onExit(({ exitCode }) => {
  const ok = output.includes("conpty-ok");
  process.stdout.write(
    `node-pty ${ok ? "ok" : "FAILED"} (exit ${exitCode}, pid ${child.pid})\n`,
    () => {
      process.exit(ok ? 0 : 1);
    },
  );
});
```

The explicit `process.exit` after the write callback is required: on Windows node-pty's ConPTY keeps the event loop alive after the child exits, so a script that only sets `process.exitCode` never returns.

- [ ] **Step 3: Run it on Node 22 and on Node 24, record the result**

```powershell
node qa/windows/scripts/conpty-load-check.mjs 2>&1 | Tee-Object qa/windows/phase-0/11-native-modules.md
fnm use 24
node -v; node qa/windows/scripts/conpty-load-check.mjs 2>&1 | Tee-Object -Append qa/windows/phase-0/11-native-modules.md
fnm use 22.19.0
```

Expected on Node 22: three `ok` lines. The Node 24 run is informational: `better-sqlite3` has a `node-v137-win32-x64` prebuild upstream, `node-pty` is N-API, so both are expected to load after `pnpm install` under that Node; if `better-sqlite3` reports `NODE_MODULE_VERSION`, run `node scripts/ensure-native-modules.mjs` under Node 24 and record that it repaired it. Prepend a heading and the exact commands to `11-native-modules.md` by hand.

- [ ] **Step 4: Commit the check script only**

```bash
git add qa/windows/scripts/conpty-load-check.mjs
git commit -m "Add a Windows native add-on load check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Cover node-pty and @parcel/watcher in ensure-native-modules

**Files:**
- Modify: `scripts/ensure-native-modules.mjs` (module list lines 16-22, `verifyNativeModule` lines 55-63, `ensureNativeModules` signature lines 134-143, catch block line 166, node-gyp call lines 218-229)
- Modify: `turbo.json` (`//#ensure-native-modules` inputs)
- Test: `packages/scripts/test/ensure-native-modules.test.mjs`

**Interfaces:**
- Consumes: the existing injectable options `createRequire`, `execFileSync`, `verifyRepairedNativeModule`, `log`, `modules`, `repoRoot`, `checkOnly`.
- Produces: `ensureNativeModules({ ..., platform })` with `platform` defaulting to `process.platform`; module entries carry `repair: "prebuild-and-node-gyp" | "verify-only"`; exports `isWindowsPlatform(platform)` and `formatWindowsBuildGuidance({ detail, name })`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/scripts/test/ensure-native-modules.test.mjs`. The file already defines `createBetterSqliteRequire(initialError)` (returns `{ requireModule, state, clearConstructorError }`) and `createEnsureOptions(fakeRequire, execFileSync)` (returns injectable options with a `verifyRepairedNativeModule` fake and `log: vi.fn()`); reuse both.

```js
function createVerifyOnlyRequire(name, loadError) {
  function requireModule(request) {
    if (request !== name) {
      throw new Error(`Unexpected require: ${request}`);
    }
    if (loadError !== null) {
      throw loadError;
    }
    return {};
  }

  requireModule.resolve = (request) => {
    if (request === `${name}/package.json`) {
      return `/fake-node-modules/${name}/package.json`;
    }
    throw new Error(`Unexpected resolve: ${request}`);
  };

  return requireModule;
}

describe("verify-only native modules", () => {
  const verifyOnlyModules = [
    {
      name: "node-pty",
      resolveFrom: "apps/host-daemon/package.json",
      repair: "verify-only",
    },
  ];

  it("loads a verify-only module without running an installer", () => {
    const execFileSync = vi.fn();
    const log = vi.fn();

    ensureNativeModules({
      repoRoot: "/repo",
      modules: verifyOnlyModules,
      createRequire: () => createVerifyOnlyRequire("node-pty", null),
      execFileSync,
      log,
      platform: "linux",
    });

    expect(execFileSync).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("names the Windows build tools when a verify-only module fails on win32", () => {
    const execFileSync = vi.fn();
    const loadError = new Error("The specified module could not be found.");

    expect(() =>
      ensureNativeModules({
        repoRoot: "/repo",
        modules: verifyOnlyModules,
        createRequire: () => createVerifyOnlyRequire("node-pty", loadError),
        execFileSync,
        log: vi.fn(),
        platform: "win32",
      }),
    ).toThrow(/node-pty has no usable native binary on Windows[\s\S]*Visual Studio Build Tools[\s\S]*Original error: The specified module could not be found\./u);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("never runs an installer for a verify-only module, even on an ABI mismatch", () => {
    const loadError = new Error(
      "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127.",
    );
    const execFileSync = vi.fn();

    expect(() =>
      ensureNativeModules({
        repoRoot: "/repo",
        modules: verifyOnlyModules,
        createRequire: () => createVerifyOnlyRequire("node-pty", loadError),
        execFileSync,
        log: vi.fn(),
        platform: "linux",
      }),
    ).toThrow(loadError);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe("better-sqlite3 repair on win32", () => {
  it("names the Windows build tools when node-gyp fails", () => {
    const fake = createBetterSqliteRequire(
      new Error("was compiled against a different Node.js version using NODE_MODULE_VERSION 127"),
    );
    const execFileSync = vi.fn(() => {
      throw new Error("gyp ERR! find VS msvs_version not set from command line or npm config");
    });

    expect(() =>
      ensureNativeModules({
        ...createEnsureOptions(fake.requireModule, execFileSync),
        platform: "win32",
      }),
    ).toThrow(/better-sqlite3 has no usable native binary on Windows[\s\S]*Original error: gyp ERR! find VS/u);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- -t "verify-only native modules|repair on win32"`
Expected: FAIL. The first case passes already (`verifyNativeModule` only constructs `better-sqlite3`). The ABI-mismatch case fails with `Unexpected resolve: prebuild-install/bin.js` because today every module is repaired the same way. Both win32 cases fail because no guidance text exists.

- [ ] **Step 3: Rewrite the module list and add the Windows helpers**

Replace lines 16-22 of `scripts/ensure-native-modules.mjs` with:

```js
const WINDOWS_BUILD_TOOLS_URL =
  "https://visualstudio.microsoft.com/visual-cpp-build-tools/";

const nativeModules = [
  {
    name: "better-sqlite3",
    resolveFrom: "packages/db/package.json",
    binaryPath: "build/Release/better_sqlite3.node",
    repair: "prebuild-and-node-gyp",
  },
  {
    name: "node-pty",
    resolveFrom: "apps/host-daemon/package.json",
    repair: "verify-only",
  },
  {
    name: "@parcel/watcher",
    resolveFrom: "apps/host-daemon/package.json",
    repair: "verify-only",
  },
];

export function isWindowsPlatform(platform = process.platform) {
  return platform === "win32";
}

export function formatWindowsBuildGuidance({ detail, name }) {
  const lines = [
    `[ensure-native-modules] ${name} has no usable native binary on Windows.`,
    `Install the "Desktop development with C++" workload from Visual Studio Build Tools`,
    `(${WINDOWS_BUILD_TOOLS_URL}) plus Python 3.11 or newer,`,
    `then reinstall from a prompt with the tools on PATH: pnpm install --frozen-lockfile.`,
    `A plain reinstall also restores skipped optional packages (for example @parcel/watcher-win32-x64).`,
  ];
  if (detail !== undefined && detail !== "") {
    lines.push(`Original error: ${detail}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Inject `platform`, honour `repair`, and wrap the failure paths**

`verifyNativeModule` already returns after a bare `require` for every name other than `better-sqlite3`; leave it as it is.

Change the `ensureNativeModules` signature (lines 134-143) to add a `platform` option and compute `windows` once:

```js
export function ensureNativeModules({
  checkOnly = false,
  repoRoot = defaultRepoRoot,
  modules = nativeModules,
  createRequire: createRequireImpl = createRequire,
  execFileSync: execFileSyncImpl = execFileSync,
  verifyRepairedNativeModule:
    verifyRepairedNativeModuleImpl = getRepairedNativeModuleError,
  log = console.log,
  platform = process.platform,
} = {}) {
  const windows = isWindowsPlatform(platform);
  for (const {
    name,
    resolveFrom,
    binaryPath,
    repair = "prebuild-and-node-gyp",
  } of modules) {
```

Change the non-repairable branch (line 166, `if (!shouldRebuildNativeModule(message)) throw err;`) to:

```js
      if (repair === "verify-only" || !shouldRebuildNativeModule(message)) {
        if (windows) {
          throw new Error(
            formatWindowsBuildGuidance({ detail: message, name }),
          );
        }
        throw err;
      }
```

Wrap the node-gyp call (lines 218-229) so a Windows failure carries the guidance:

```js
      try {
        execFileSyncImpl(
          process.execPath,
          [
            pkgRequire.resolve("node-gyp/bin/node-gyp.js"),
            "rebuild",
            "--release",
          ],
          {
            cwd: pkgDir,
            stdio: "inherit",
          },
        );
      } catch (rebuildErr) {
        if (windows) {
          throw new Error(
            formatWindowsBuildGuidance({
              detail: formatChildProcessFailure(rebuildErr),
              name,
            }),
          );
        }
        throw rebuildErr;
      }
```

`formatChildProcessFailure` already exists in the file. Leave the `--check` branch and the post-rebuild verification unchanged.

- [ ] **Step 5: Add the host-daemon manifest to the Turbo inputs**

In `turbo.json`, `//#ensure-native-modules`:

```jsonc
    "//#ensure-native-modules": {
      "cache": false,
      "inputs": [
        "$TURBO_ROOT$/package.json",
        "$TURBO_ROOT$/apps/host-daemon/package.json",
        "$TURBO_ROOT$/packages/db/package.json",
        "$TURBO_ROOT$/pnpm-lock.yaml",
        "$TURBO_ROOT$/scripts/ensure-native-modules.mjs"
      ],
      "outputs": []
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec turbo run test --filter=@bb/scripts`
Expected: PASS, including every pre-existing `ensure-native-modules` case. Then run `node scripts/ensure-native-modules.mjs` on the reference desktop; expected: exit 0 with no output.

- [ ] **Step 7: Commit**

```bash
git add scripts/ensure-native-modules.mjs turbo.json packages/scripts/test/ensure-native-modules.test.mjs
git commit -m "Verify node-pty and @parcel/watcher in ensure-native-modules with Windows guidance

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Move vitest data directories off `/tmp` and add the config ratchet

**Files:**
- Create: `packages/test-helpers/src/tmp-root.ts`
- Modify: `packages/test-helpers/src/index.ts`
- Modify: `apps/server/vitest.config.ts:10`, `apps/host-daemon/vitest.config.ts:10`, `tests/integration/vitest.config.ts:13`
- Test: `packages/scripts/test/vitest-config-tmp-literals.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `tmpRoot(name: string): string` exported from `@bb/test-helpers` for test files; vitest configs use `node:os` directly so config loading never pulls a workspace package.

- [ ] **Step 1: Write the failing ratchet test**

Create `packages/scripts/test/vitest-config-tmp-literals.test.mjs`:

```js
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceGroups = ["apps", "packages", "plugins", "tests", "examples/plugins"];

function listVitestConfigs() {
  const configs = [];
  for (const group of workspaceGroups) {
    const groupDir = join(repoRoot, group);
    let entries;
    try {
      entries = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const packageDir = join(groupDir, entry);
      if (!statSync(packageDir).isDirectory()) continue;
      for (const file of readdirSync(packageDir)) {
        if (/^vitest(\.[\w-]+)?\.config\.(ts|mts|js|mjs)$/u.test(file)) {
          configs.push(join(packageDir, file));
        }
      }
    }
  }
  return configs;
}

describe("vitest configs", () => {
  it("never hardcode a /tmp data directory", () => {
    const offenders = listVitestConfigs().filter((configPath) =>
      /["'`]\/tmp(\/|["'`])/u.test(readFileSync(configPath, "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- -t "never hardcode a /tmp"`
Expected: FAIL listing the three config paths.

- [ ] **Step 3: Add the helper**

Create `packages/test-helpers/src/tmp-root.ts`:

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpRoot(name: string): string {
  return join(tmpdir(), name);
}
```

Append to `packages/test-helpers/src/index.ts`:

```ts
export { tmpRoot } from "./tmp-root.js";
```

- [ ] **Step 4: Rewrite the three configs**

`apps/server/vitest.config.ts`:

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    env: {
      BB_DATA_DIR: join(tmpdir(), "bb-server-test"),
      BB_SERVER_PORT: "49161",
      BB_HOST_DAEMON_PORT: "49162",
    },
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@bb/server",
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    }),
  },
});
```

`apps/host-daemon/vitest.config.ts`:

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    env: {
      BB_DATA_DIR: join(tmpdir(), "bb-host-daemon-test"),
      BB_SERVER_URL: "http://127.0.0.1:49161",
      BB_HOST_DAEMON_PORT: "49162",
    },
    testTimeout: 15_000,
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@bb/host-daemon",
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    }),
  },
});
```

`tests/integration/vitest.config.ts`: the head of the file becomes

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

const parsedTimeoutScale = Number(process.env.BB_TEST_TIMEOUT_SCALE ?? 1);
const timeoutScale =
  Number.isFinite(parsedTimeoutScale) && parsedTimeoutScale > 0
    ? parsedTimeoutScale
    : 1;

export default defineWorkspaceTestConfig({
  test: {
    hookTimeout: Math.ceil(60_000 * timeoutScale),
    env: {
      BB_DATA_DIR: join(tmpdir(), "bb-integration-test"),
      BB_SERVER_PORT: "49161",
      BB_SERVER_URL: "http://127.0.0.1:49161",
      BB_HOST_DAEMON_PORT: "49162",
    },
```

and the rest of the file (`silent`, `testTimeout`, both `projects` entries) stays exactly as it is.

- [ ] **Step 5: Run the ratchet and the affected suites**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- -t "never hardcode a /tmp"`
Expected: PASS.

Run: `pnpm exec turbo run typecheck --filter=@bb/test-helpers --filter=@bb/server --filter=@bb/host-daemon`
Expected: PASS.

Run on the reference desktop: `pnpm exec turbo run test --filter=@bb/host-daemon -- -t "host-platform"`
Expected: the suite starts and `BB_DATA_DIR` resolves under `C:\Users\<you>\AppData\Local\Temp\bb-host-daemon-test` (check with `node -p "require('node:os').tmpdir()"`).

- [ ] **Step 6: Commit**

```bash
git add packages/test-helpers/src/tmp-root.ts packages/test-helpers/src/index.ts apps/server/vitest.config.ts apps/host-daemon/vitest.config.ts tests/integration/vitest.config.ts packages/scripts/test/vitest-config-tmp-literals.test.mjs
git commit -m "Resolve vitest data directories through os.tmpdir()

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Lint rule `bb/no-tmp-path-literal`

**Files:**
- Modify: `scripts/oxlint-plugin.mjs` (rule and the `rules` map at lines 120-125)
- Modify: `.oxlintrc.json` (`rules` at line 11-13 and a new override)
- Test: `packages/scripts/test/oxlint-plugin.test.mjs`

**Interfaces:**
- Consumes: the plugin's rule shape `{ create(context) { return { NodeType(node) {} } } }` and `context.report({ node, message })`.
- Produces: `rules["no-tmp-path-literal"]`, enabled as `bb/no-tmp-path-literal: "error"` for product code, off for tests and stories.

- [ ] **Step 1: Write the failing test**

Create `packages/scripts/test/oxlint-plugin.test.mjs`:

```js
import { describe, expect, it } from "vitest";
import { rules } from "../../../scripts/oxlint-plugin.mjs";

function runRule(rule, nodes) {
  const reports = [];
  const visitor = rule.create({
    report(report) {
      reports.push(report);
    },
  });
  for (const node of nodes) {
    visitor[node.type]?.(node);
  }
  return reports;
}

function literal(value) {
  return { type: "Literal", value };
}

function templateElement(cooked) {
  return { type: "TemplateElement", value: { cooked, raw: cooked } };
}

describe("bb/no-tmp-path-literal", () => {
  const rule = rules["no-tmp-path-literal"];

  it("reports string literals under /tmp", () => {
    const reports = runRule(rule, [literal("/tmp/bb-server-test"), literal("/tmp")]);

    expect(reports).toHaveLength(2);
    expect(reports[0].message).toContain("os.tmpdir()");
  });

  it("reports template literal quasis under /tmp", () => {
    const reports = runRule(rule, [templateElement("/tmp/bb-")]);

    expect(reports).toHaveLength(1);
  });

  it("ignores other paths and non-string literals", () => {
    const reports = runRule(rule, [
      literal("/tmpfoo/bar"),
      literal("/var/tmp/x"),
      literal("tmp/relative"),
      literal(42),
      templateElement("/home/"),
    ]);

    expect(reports).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- -t "no-tmp-path-literal"`
Expected: FAIL with `Cannot read properties of undefined (reading 'create')`.

- [ ] **Step 3: Add the rule**

In `scripts/oxlint-plugin.mjs`, before `export const rules`:

```js
const tmpPathPattern = /^\/tmp(?:\/|$)/u;

const noTmpPathLiteral = {
  create(context) {
    function checkStringValue(node, value) {
      if (typeof value === "string" && tmpPathPattern.test(value)) {
        context.report({
          node,
          message:
            "Hardcoded /tmp paths break on Windows. Use os.tmpdir() (tmpRoot() from @bb/test-helpers in tests).",
        });
      }
    }

    return {
      Literal(node) {
        checkStringValue(node, node.value);
      },
      TemplateElement(node) {
        checkStringValue(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};
```

Add it to the map:

```js
export const rules = {
  "no-blocking-child-process-call": noBlockingChildProcessCall,
  "no-comments": noComments,
  "no-native-title-on-button": noNativeTitleOnButton,
  "no-native-title-with-aria-label": noNativeTitleWithAriaLabel,
  "no-tmp-path-literal": noTmpPathLiteral,
};
```

- [ ] **Step 4: Enable it**

In `.oxlintrc.json` change the top-level `rules` to:

```json
  "rules": {
    "bb/no-comments": "error",
    "bb/no-tmp-path-literal": "error"
  },
```

and add this override as the first entry of `overrides`:

```json
    {
      "files": [
        "**/*.test.{ts,tsx,mjs}",
        "**/test/**",
        "**/__tests__/**",
        "**/*.stories.tsx"
      ],
      "rules": {
        "bb/no-tmp-path-literal": "off"
      }
    },
```

- [ ] **Step 5: Run the test and the lint**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- -t "no-tmp-path-literal"`
Expected: PASS.

Run: `pnpm exec turbo run lint`
Expected: PASS for `@bb/app` and `@bb/mobile` (the only packages with a `lint` script). If a product-code `/tmp` literal is reported, replace it with `join(tmpdir(), ...)` in the same commit.

- [ ] **Step 6: Commit**

```bash
git add scripts/oxlint-plugin.mjs .oxlintrc.json packages/scripts/test/oxlint-plugin.test.mjs
git commit -m "Lint against hardcoded /tmp paths

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Portable package scripts and the QA runner

**Files:**
- Modify: `packages/connect-client/package.json:15`, `packages/secret-storage/package.json:14`, `packages/agent-runtime/package.json:23`
- Modify: `tests/qa/scripts/run-root-command.mjs:1-58`, `tests/qa/package.json` (devDependencies)

**Interfaces:**
- Consumes: root devDependency `rimraf` (available on every workspace package's PATH through pnpm), `cross-spawn` 7.x (already in the lockfile as a dependency of `@bb/process-utils`).
- Produces: `readParentPid(pid, platform)` and `run()` in the QA runner work from PowerShell.

- [ ] **Step 1: Replace `rm -rf` with `rimraf`**

`packages/connect-client/package.json` line 15 and `packages/secret-storage/package.json` line 14:

```json
    "clean": "rimraf dist tsconfig.tsbuildinfo",
```

- [ ] **Step 2: Double-quote the vitest exclude glob**

`packages/agent-runtime/package.json` line 23:

```json
    "test:unit": "vitest run --config vitest.config.ts --exclude \"**/integration/**\"",
```

The root `bb` script (root `package.json` line 48) redirects with `1>&2`; that syntax is valid in `cmd.exe`, which is the shell pnpm uses for package scripts on Windows, so it stays as it is.

- [ ] **Step 3: Add `cross-spawn` to `@bb/qa`**

In `tests/qa/package.json` `devDependencies` add `"cross-spawn": "^7.0.6",` (alphabetically after `@types/node`), then run `pnpm install` (not frozen; the lockfile gains one link to the already-present version).

- [ ] **Step 4: Rewrite the runner's process helpers**

Replace lines 1-2 and lines 31-58 of `tests/qa/scripts/run-root-command.mjs` so the file starts with:

```js
#!/usr/bin/env node
import crossSpawn from "cross-spawn";
```

and the helpers read:

```js
function readParentPid(pid, platform = process.platform) {
  const probe =
    platform === "win32"
      ? {
          command: "powershell.exe",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`,
          ],
        }
      : { command: "ps", args: ["-o", "ppid=", "-p", String(pid)] };
  const result = crossSpawn.sync(probe.command, probe.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  const parentPid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null;
}

function resolveStandaloneParentPid() {
  return readParentPid(process.ppid) ?? process.ppid;
}

function run(commandName, commandArgs, stdio, env = process.env) {
  const result = crossSpawn.sync(commandName, commandArgs, {
    env,
    stdio,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}
```

Keep `commandConfig`, `runTurboCheck` and `main` as they are.

- [ ] **Step 5: Verify on both platforms**

Run on the reference desktop (PowerShell):

```powershell
pnpm --filter @bb/connect-client run clean
pnpm --filter @bb/agent-runtime run test:unit -- --run --reporter=dot 2>&1 | Select-Object -Last 5
node tests/qa/scripts/run-root-command.mjs standalone:stop
node -e "console.log(require('child_process').spawnSync('pnpm.cmd', ['-v'], {shell:false}).error?.code)"
```

Expected: `clean` exits 0; `test:unit` runs and reports zero files from `integration/` (grep the output for `integration/`); the QA runner runs the `@bb/qa` typecheck through Turbo and then `standalone:stop` (exit 0 or a `no standalone instance` message, never `ENOENT`/`EINVAL`); the last line prints `EINVAL` (Node refuses to spawn a `.cmd` without a shell since the 2024 command-injection fix), which is why `cross-spawn` is required.

Run on Linux CI later (Task 11 dispatch): the `packages` test shard stays green.

- [ ] **Step 6: Commit**

```bash
git add packages/connect-client/package.json packages/secret-storage/package.json packages/agent-runtime/package.json tests/qa/scripts/run-root-command.mjs tests/qa/package.json pnpm-lock.yaml
git commit -m "Make package clean, unit-test and QA runner scripts shell-portable

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Line-ending rules for Windows batch files

**Files:**
- Modify: `.gitattributes`

- [ ] **Step 1: Add the rules**

`.gitattributes` becomes:

```
* text=auto eol=lf
*.cmd text eol=crlf
*.bat text eol=crlf
```

- [ ] **Step 2: Verify the attribute resolution**

Run: `git check-attr eol -- apps/cli/bin/bb.cmd scripts/x.ps1 scripts/y.sh`
Expected output:

```
apps/cli/bin/bb.cmd: eol: crlf
scripts/x.ps1: eol: lf
scripts/y.sh: eol: lf
```

- [ ] **Step 3: Commit**

```bash
git add .gitattributes
git commit -m "Check out Windows batch files with CRLF

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8a: Dev launcher pure helpers

**Files:**
- Create: `packages/scripts/src/lib/dev-app-launcher.ts`
- Test: `packages/scripts/test/dev-app-launcher.test.ts`

**Interfaces:**
- Consumes: `DevInstanceConfig` from `@bb/config/runtime` (`dataDir`, `ports.appPort`, `ports.serverPort`, `ports.hostDaemonPort`, `serverUrl`, `repoRoot`, `instanceId`).
- Produces (used by Tasks 8b, 8c and 8d):
  - `parseDevAppArgs(argv: readonly string[]): DevAppArgs` where `DevAppArgs = { command: "current" | "env" | "help" | "logs" | "status" | "stop"; desktop: boolean; logTarget: "desktop" | "dev"; open: boolean; powershell: boolean }`
  - `formatDevAppEnv(config: DevInstanceConfig, shell: "posix" | "powershell"): string` (the six lines the bash launcher's `env` printed, in the requested shell's syntax)
  - `resolveDevAppPaths(config: DevInstanceConfig, env: NodeJS.ProcessEnv): DevAppPaths` where `DevAppPaths = { desktopLogPath; desktopPidPath; desktopUserDataDir; devLogPath; devPidPath; logRoot }` (all `string`)
  - `assertDesktopNodeRuntime(args: { execPath: string; version: string }): void`
  - `resolveOpenUrlCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] }`
  - `DEV_SERVER_READY_PATTERN: RegExp`, `DEV_FAILURE_PATTERNS: readonly RegExp[]`, `desktopReadyPattern(appPort: number): RegExp`, `DEV_SERVER_READY_TIMEOUT_MS = 90_000`, `DESKTOP_READY_TIMEOUT_MS = 120_000`
  - `formatDevAppStatus(args: DevAppStatusArgs): string`

- [ ] **Step 1: Write the failing tests**

Create `packages/scripts/test/dev-app-launcher.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDevInstanceConfig } from "@bb/config/runtime";
import {
  DEV_FAILURE_PATTERNS,
  DEV_SERVER_READY_PATTERN,
  assertDesktopNodeRuntime,
  desktopReadyPattern,
  formatDevAppEnv,
  formatDevAppStatus,
  parseDevAppArgs,
  resolveDevAppPaths,
  resolveOpenUrlCommand,
} from "../src/lib/dev-app-launcher.js";

const homeDir = join("/", "home", "dev");
const repoRoot = join(homeDir, "work", "bb");
const config = resolveDevInstanceConfig({ homeDir, repoRoot });

const defaults = {
  desktop: false,
  logTarget: "dev",
  open: false,
  powershell: false,
} as const;

describe("parseDevAppArgs", () => {
  it("defaults to help and accepts flags anywhere", () => {
    expect(parseDevAppArgs([])).toEqual({ ...defaults, command: "help" });
    expect(parseDevAppArgs(["--desktop", "current", "--open"])).toEqual({
      ...defaults,
      command: "current",
      desktop: true,
      open: true,
    });
    expect(parseDevAppArgs(["status"])).toEqual({ ...defaults, command: "status" });
    expect(parseDevAppArgs(["--help"])).toEqual({ ...defaults, command: "help" });
    expect(parseDevAppArgs(["env", "--powershell"])).toEqual({
      ...defaults,
      command: "env",
      powershell: true,
    });
  });

  it("takes an optional log target for logs", () => {
    expect(parseDevAppArgs(["logs"])).toEqual({ ...defaults, command: "logs" });
    expect(parseDevAppArgs(["logs", "desktop"])).toEqual({
      ...defaults,
      command: "logs",
      logTarget: "desktop",
    });
    expect(() => parseDevAppArgs(["logs", "launcher"])).toThrow("Unknown log target: launcher");
  });

  it("rejects unknown commands and stray arguments", () => {
    expect(() => parseDevAppArgs(["main"])).toThrow("Unknown command: main");
    expect(() => parseDevAppArgs(["stop", "extra"])).toThrow("Unexpected arguments: extra");
  });
});

describe("formatDevAppEnv", () => {
  it("prints the six launcher env lines for a POSIX shell", () => {
    expect(formatDevAppEnv(config, "posix").split("\n")).toEqual([
      `export BB_SERVER_URL=${config.serverUrl}`,
      `export BB_HOST_DAEMON_PORT=${config.ports.hostDaemonPort}`,
      "export BB_PROJECT_ID=proj_personal",
      "unset BB_THREAD_ID",
      "unset BB_ENVIRONMENT_ID",
      "unset BB_THREAD_STORAGE",
    ]);
  });

  it("prints the same lines for PowerShell", () => {
    expect(formatDevAppEnv(config, "powershell").split("\n")).toEqual([
      `$env:BB_SERVER_URL = "${config.serverUrl}"`,
      `$env:BB_HOST_DAEMON_PORT = "${config.ports.hostDaemonPort}"`,
      '$env:BB_PROJECT_ID = "proj_personal"',
      "Remove-Item Env:BB_THREAD_ID -ErrorAction SilentlyContinue",
      "Remove-Item Env:BB_ENVIRONMENT_ID -ErrorAction SilentlyContinue",
      "Remove-Item Env:BB_THREAD_STORAGE -ErrorAction SilentlyContinue",
    ]);
  });
});

describe("resolveDevAppPaths", () => {
  it("scopes logs and pid files to the checkout instance", () => {
    const paths = resolveDevAppPaths(config, {});

    expect(paths.logRoot).toBe(join(config.dataDir, "dev-app"));
    expect(paths.devLogPath).toBe(join(config.dataDir, "dev-app", "dev.log"));
    expect(paths.desktopLogPath).toBe(join(config.dataDir, "dev-app", "desktop.log"));
    expect(paths.devPidPath).toBe(join(config.dataDir, "dev-supervisors", "dev-app-dev.pid"));
    expect(paths.desktopPidPath).toBe(join(config.dataDir, "dev-supervisors", "dev-app-desktop.pid"));
    expect(paths.desktopUserDataDir).toBe(join(config.dataDir, "desktop"));
  });

  it("honours BB_DESKTOP_USER_DATA_DIR", () => {
    const paths = resolveDevAppPaths(config, { BB_DESKTOP_USER_DATA_DIR: " /custom/desktop " });

    expect(paths.desktopUserDataDir).toBe("/custom/desktop");
  });
});

describe("assertDesktopNodeRuntime", () => {
  it("accepts Node 22.19 and newer on the 22 line", () => {
    expect(() => assertDesktopNodeRuntime({ execPath: "/n/node", version: "v22.19.0" })).not.toThrow();
    expect(() => assertDesktopNodeRuntime({ execPath: "/n/node", version: "v22.23.2" })).not.toThrow();
  });

  it("rejects other lines and older 22 releases", () => {
    for (const version of ["v22.18.9", "v24.12.0", "v20.19.0"]) {
      expect(() => assertDesktopNodeRuntime({ execPath: "/n/node", version })).toThrow(
        `needs Node 22.19 or newer on the 22 line (see .nvmrc); current ${version} at /n/node`,
      );
    }
  });
});

describe("resolveOpenUrlCommand", () => {
  it("picks the platform opener", () => {
    expect(resolveOpenUrlCommand("win32", "http://localhost:1")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "http://localhost:1"],
    });
    expect(resolveOpenUrlCommand("darwin", "http://localhost:1")).toEqual({
      command: "open",
      args: ["http://localhost:1"],
    });
    expect(resolveOpenUrlCommand("linux", "http://localhost:1")).toEqual({
      command: "xdg-open",
      args: ["http://localhost:1"],
    });
  });
});

describe("readiness patterns", () => {
  it("match the dev server and desktop banners and the known failures", () => {
    expect(DEV_SERVER_READY_PATTERN.test("[host-daemon] Host daemon started on 27001")).toBe(true);
    expect(desktopReadyPattern(11001).test("@bb/desktop: app http://localhost:11001 (Vite dev server — live reload)")).toBe(true);
    expect(desktopReadyPattern(11001).test("@bb/desktop: app http://localhost:11002")).toBe(false);
    expect(DEV_FAILURE_PATTERNS.some((pattern) => pattern.test("[dev] port 19001 is unavailable"))).toBe(true);
    expect(DEV_FAILURE_PATTERNS.some((pattern) => pattern.test("ELIFECYCLE Command failed"))).toBe(true);
    expect(DEV_FAILURE_PATTERNS.some((pattern) => pattern.test("ERROR  run failed: command exited (1)"))).toBe(true);
    expect(DEV_FAILURE_PATTERNS.some((pattern) => pattern.test("all good"))).toBe(false);
  });
});

describe("formatDevAppStatus", () => {
  it("prints the thirteen status lines", () => {
    const paths = resolveDevAppPaths(config, {});
    const status = formatDevAppStatus({
      branch: "main (abc1234)",
      codexVersion: "codex-cli 0.50.0",
      config,
      desktopState: "stopped",
      devState: "running",
      execPath: "/n/node",
      nodeAbi: "127",
      nodeVersion: "v22.19.0",
      paths,
    });

    expect(status.split("\n")).toEqual([
      `Repo: ${repoRoot}`,
      "Branch: main (abc1234)",
      "Node: v22.19.0 (ABI 127) at /n/node",
      "Codex: codex-cli 0.50.0",
      `Instance: ${config.instanceId}`,
      `Data dir: ${config.dataDir}`,
      `App: http://localhost:${config.ports.appPort}`,
      `Server: ${config.serverUrl}`,
      `Host daemon: http://127.0.0.1:${config.ports.hostDaemonPort}`,
      `Desktop user data: ${paths.desktopUserDataDir}`,
      "Dev session: running",
      "Desktop session: stopped",
      `Logs: ${paths.devLogPath}, ${paths.desktopLogPath}`,
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- dev-app-launcher`
Expected: FAIL with `Cannot find module '../src/lib/dev-app-launcher.js'`.

- [ ] **Step 3: Implement the helpers**

Create `packages/scripts/src/lib/dev-app-launcher.ts`:

```ts
import { join } from "node:path";
import type { DevInstanceConfig } from "@bb/config/runtime";

export type DevAppCommand =
  | "current"
  | "env"
  | "help"
  | "logs"
  | "status"
  | "stop";

export type DevAppLogTarget = "desktop" | "dev";

export interface DevAppArgs {
  command: DevAppCommand;
  desktop: boolean;
  logTarget: DevAppLogTarget;
  open: boolean;
  powershell: boolean;
}

export type DevAppEnvShell = "posix" | "powershell";

export interface DevAppPaths {
  desktopLogPath: string;
  desktopPidPath: string;
  desktopUserDataDir: string;
  devLogPath: string;
  devPidPath: string;
  logRoot: string;
}

export type DevAppProcessState = "running" | "stopped";

export interface DevAppStatusArgs {
  branch: string;
  codexVersion: string;
  config: DevInstanceConfig;
  desktopState: DevAppProcessState;
  devState: DevAppProcessState;
  execPath: string;
  nodeAbi: string;
  nodeVersion: string;
  paths: DevAppPaths;
}

export const DEV_SERVER_READY_PATTERN = /Host daemon started/u;

export const DEV_FAILURE_PATTERNS: readonly RegExp[] = [
  /port .* is unavailable/u,
  /ELIFECYCLE/u,
  /ERROR {2}run failed/u,
];

export const DEV_SERVER_READY_TIMEOUT_MS = 90_000;
export const DESKTOP_READY_TIMEOUT_MS = 120_000;

export function desktopReadyPattern(appPort: number): RegExp {
  return new RegExp(`@bb/desktop: app http://localhost:${appPort}(?![0-9])`, "u");
}

function parseLogTarget(word: string | undefined): DevAppLogTarget {
  if (word === undefined || word === "dev") {
    return "dev";
  }
  if (word === "desktop") {
    return "desktop";
  }
  throw new Error(`Unknown log target: ${word}`);
}

export function parseDevAppArgs(argv: readonly string[]): DevAppArgs {
  const flags = { desktop: false, open: false, powershell: false };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--desktop") {
      flags.desktop = true;
    } else if (arg === "--open") {
      flags.open = true;
    } else if (arg === "--powershell") {
      flags.powershell = true;
    } else {
      positional.push(arg);
    }
  }
  const [commandWord = "help", ...rest] = positional;
  if (commandWord === "logs") {
    const [targetWord, ...extra] = rest;
    if (extra.length > 0) {
      throw new Error(`Unexpected arguments: ${extra.join(" ")}`);
    }
    return { ...flags, command: "logs", logTarget: parseLogTarget(targetWord) };
  }
  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
  }
  switch (commandWord) {
    case "current":
    case "env":
    case "status":
    case "stop":
      return { ...flags, command: commandWord, logTarget: "dev" };
    case "help":
    case "-h":
    case "--help":
      return { ...flags, command: "help", logTarget: "dev" };
    default:
      throw new Error(`Unknown command: ${commandWord}`);
  }
}

export function formatDevAppEnv(
  config: DevInstanceConfig,
  shell: DevAppEnvShell,
): string {
  const assignments: Array<[string, string]> = [
    ["BB_SERVER_URL", config.serverUrl],
    ["BB_HOST_DAEMON_PORT", String(config.ports.hostDaemonPort)],
    ["BB_PROJECT_ID", "proj_personal"],
  ];
  const removals = ["BB_THREAD_ID", "BB_ENVIRONMENT_ID", "BB_THREAD_STORAGE"];
  if (shell === "powershell") {
    return [
      ...assignments.map(([key, value]) => `$env:${key} = "${value}"`),
      ...removals.map(
        (key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`,
      ),
    ].join("\n");
  }
  return [
    ...assignments.map(([key, value]) => `export ${key}=${value}`),
    ...removals.map((key) => `unset ${key}`),
  ].join("\n");
}

export function resolveDevAppPaths(
  config: DevInstanceConfig,
  env: NodeJS.ProcessEnv,
): DevAppPaths {
  const logRoot = join(config.dataDir, "dev-app");
  const pidRoot = join(config.dataDir, "dev-supervisors");
  const configuredUserDataDir = env.BB_DESKTOP_USER_DATA_DIR?.trim();
  return {
    desktopLogPath: join(logRoot, "desktop.log"),
    desktopPidPath: join(pidRoot, "dev-app-desktop.pid"),
    desktopUserDataDir:
      configuredUserDataDir !== undefined && configuredUserDataDir.length > 0
        ? configuredUserDataDir
        : join(config.dataDir, "desktop"),
    devLogPath: join(logRoot, "dev.log"),
    devPidPath: join(pidRoot, "dev-app-dev.pid"),
    logRoot,
  };
}

export function assertDesktopNodeRuntime(args: {
  execPath: string;
  version: string;
}): void {
  const match = /^v?(\d+)\.(\d+)\./u.exec(args.version);
  const major = match ? Number(match[1]) : Number.NaN;
  const minor = match ? Number(match[2]) : Number.NaN;
  if (major !== 22 || minor < 19) {
    throw new Error(
      `pnpm dev:desktop needs Node 22.19 or newer on the 22 line (see .nvmrc); current ${args.version} at ${args.execPath}`,
    );
  }
}

export function resolveOpenUrlCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function formatDevAppStatus(args: DevAppStatusArgs): string {
  return [
    `Repo: ${args.config.repoRoot}`,
    `Branch: ${args.branch}`,
    `Node: ${args.nodeVersion} (ABI ${args.nodeAbi}) at ${args.execPath}`,
    `Codex: ${args.codexVersion}`,
    `Instance: ${args.config.instanceId}`,
    `Data dir: ${args.config.dataDir}`,
    `App: http://localhost:${args.config.ports.appPort}`,
    `Server: ${args.config.serverUrl}`,
    `Host daemon: http://127.0.0.1:${args.config.ports.hostDaemonPort}`,
    `Desktop user data: ${args.paths.desktopUserDataDir}`,
    `Dev session: ${args.devState}`,
    `Desktop session: ${args.desktopState}`,
    `Logs: ${args.paths.devLogPath}, ${args.paths.desktopLogPath}`,
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- dev-app-launcher`
Expected: PASS (7 describe blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/scripts/src/lib/dev-app-launcher.ts packages/scripts/test/dev-app-launcher.test.ts
git commit -m "Add dev launcher argument, path, env and status helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8b: Dev launcher process control

**Files:**
- Modify: `packages/scripts/src/lib/dev-app-launcher.ts`
- Test: `packages/scripts/test/dev-app-launcher.test.ts`

**Interfaces:**
- Consumes: `spawnPortableProcess(request)` and `spawnPortableOutputProcess(request)` from `@bb/process-utils` (request fields `command`, `args`, `cwd`, `env`, `detached`, `stdio`; this task adds `windowsHide`); `readRunningPid({ pidPath, serviceName })` and `writePidFile({ pid, pidPath })` from `./pid-file.js`.
- Produces:
  - `PortableSpawnRequest.windowsHide?: boolean` in `packages/process-utils/src/index.ts`, passed straight to `cross-spawn`.
  - `startLoggedProcess(request: StartLoggedProcessArgs): Promise<number>` where `StartLoggedProcessArgs = { args: string[]; command: string; cwd: string; env: NodeJS.ProcessEnv; logPath: string; pidPath: string; platform: NodeJS.Platform }` (returns the pid; the child is unref'd, stdout+stderr go to `logPath`, which is truncated first; on POSIX it is a detached process-group leader, on win32 it is not detached but runs with `windowsHide` so its console is hidden and separate from the launcher's)
  - `waitForLogPattern(args: { description: string; failurePatterns: readonly RegExp[]; logPath: string; pollIntervalMs?: number; readyPattern: RegExp; timeoutMs: number }): Promise<void>`
  - `readTrackedProcessState(args: { pidPath: string; serviceName: string }): Promise<DevAppProcessState>`
  - `stopTrackedProcess(args: { pidPath: string; platform: NodeJS.Platform; serviceName: string }): Promise<"not-running" | "stopped">`
  - `followLogFile(args: { logPath: string; pollIntervalMs?: number; signal: AbortSignal; write: (chunk: string) => void }): Promise<void>` (prints what the file already holds, then every appended chunk, until the signal aborts; a missing file is waited for, not an error)

- [ ] **Step 1: Write the failing tests**

Append to `packages/scripts/test/dev-app-launcher.test.ts` (add `appendFileSync`, `mkdtempSync`, `rmSync`, `writeFileSync` from `node:fs`, `tmpdir` from `node:os`, and `followLogFile`, `readTrackedProcessState`, `startLoggedProcess`, `stopTrackedProcess`, `waitForLogPattern` to the imports):

```ts
describe("tracked processes", () => {
  it("starts a detached logged child, reports it, and stops its tree", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bb-dev-app-"));
    const logPath = join(tempRoot, "child.log");
    const pidPath = join(tempRoot, "child.pid");
    try {
      const pid = await startLoggedProcess({
        args: ["-e", "console.log('child ready'); setInterval(() => {}, 1000)"],
        command: process.execPath,
        cwd: tempRoot,
        env: process.env,
        logPath,
        pidPath,
        platform: process.platform,
      });
      expect(pid).toBeGreaterThan(0);

      await waitForLogPattern({
        description: "child",
        failurePatterns: [],
        logPath,
        pollIntervalMs: 50,
        readyPattern: /child ready/u,
        timeoutMs: 15_000,
      });
      expect(await readTrackedProcessState({ pidPath, serviceName: "child" })).toBe("running");

      expect(await stopTrackedProcess({ pidPath, platform: process.platform, serviceName: "child" })).toBe("stopped");
      expect(await readTrackedProcessState({ pidPath, serviceName: "child" })).toBe("stopped");
      expect(await stopTrackedProcess({ pidPath, platform: process.platform, serviceName: "child" })).toBe("not-running");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails fast on a failure pattern and times out otherwise", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bb-dev-app-"));
    const logPath = join(tempRoot, "child.log");
    const pidPath = join(tempRoot, "child.pid");
    try {
      await startLoggedProcess({
        args: ["-e", "console.log('port 1 is unavailable'); setInterval(() => {}, 1000)"],
        command: process.execPath,
        cwd: tempRoot,
        env: process.env,
        logPath,
        pidPath,
        platform: process.platform,
      });
      await expect(
        waitForLogPattern({
          description: "dev server",
          failurePatterns: [/port .* is unavailable/u],
          logPath,
          pollIntervalMs: 50,
          readyPattern: /never/u,
          timeoutMs: 15_000,
        }),
      ).rejects.toThrow(`dev server failed to start; see ${logPath}`);
      await expect(
        waitForLogPattern({
          description: "dev server",
          failurePatterns: [],
          logPath,
          pollIntervalMs: 50,
          readyPattern: /never/u,
          timeoutMs: 200,
        }),
      ).rejects.toThrow(`Timed out after 200 ms waiting for dev server; see ${logPath}`);
      await stopTrackedProcess({ pidPath, platform: process.platform, serviceName: "child" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("followLogFile", () => {
  it("replays existing content, streams appended chunks, and stops on abort", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bb-dev-app-"));
    const logPath = join(tempRoot, "dev.log");
    const chunks: string[] = [];
    const controller = new AbortController();
    try {
      const following = followLogFile({
        logPath,
        pollIntervalMs: 20,
        signal: controller.signal,
        write: (chunk) => {
          chunks.push(chunk);
        },
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
      writeFileSync(logPath, "first line\n");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
      appendFileSync(logPath, "second line\n");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
      controller.abort();
      await following;

      expect(chunks.join("")).toBe("first line\nsecond line\n");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- dev-app-launcher`
Expected: FAIL with the four new names missing from the module.

- [ ] **Step 3: Let the portable spawn helper hide the Windows console**

In `packages/process-utils/src/index.ts` add `windowsHide` to the request type and pass it through:

```ts
interface PortableSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  windowsHide?: boolean;
}
```

```ts
export function spawnPortableProcess(
  request: PortableSpawnRequest,
): PortableChildProcess {
  return crossSpawn(request.command, request.args, {
    cwd: request.cwd,
    detached: request.detached,
    env: request.env,
    stdio: request.stdio,
    windowsHide: request.windowsHide,
  });
}
```

Nothing else in `@bb/process-utils` changes; `windowsHide` is `undefined` for every existing caller, which is Node's default.

- [ ] **Step 4: Implement process control**

Add to `packages/scripts/src/lib/dev-app-launcher.ts` (imports at the top of the file):

```ts
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  spawnPortableOutputProcess,
  spawnPortableProcess,
} from "@bb/process-utils";
import { readRunningPid, writePidFile } from "./pid-file.js";
```

and the functions:

```ts
export interface StartLoggedProcessArgs {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  pidPath: string;
  platform: NodeJS.Platform;
}

export interface WaitForLogPatternArgs {
  description: string;
  failurePatterns: readonly RegExp[];
  logPath: string;
  pollIntervalMs?: number;
  readyPattern: RegExp;
  timeoutMs: number;
}

const STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export async function startLoggedProcess(
  request: StartLoggedProcessArgs,
): Promise<number> {
  await mkdir(dirname(request.logPath), { recursive: true });
  await rm(request.logPath, { force: true });
  const logHandle = await open(request.logPath, "a");
  try {
    const child = spawnPortableProcess({
      args: request.args,
      command: request.command,
      cwd: request.cwd,
      detached: request.platform !== "win32",
      env: request.env,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      windowsHide: true,
    });
    if (child.pid === undefined) {
      throw new Error(`Failed to start ${request.command}`);
    }
    child.unref();
    await writePidFile({ pid: child.pid, pidPath: request.pidPath });
    return child.pid;
  } finally {
    await logHandle.close();
  }
}

export async function waitForLogPattern(
  args: WaitForLogPatternArgs,
): Promise<void> {
  const deadline = Date.now() + args.timeoutMs;
  const pollIntervalMs = args.pollIntervalMs ?? 1_000;
  while (Date.now() <= deadline) {
    let text = "";
    try {
      text = await readFile(args.logPath, "utf8");
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
    if (args.readyPattern.test(text)) {
      return;
    }
    if (args.failurePatterns.some((pattern) => pattern.test(text))) {
      throw new Error(`${args.description} failed to start; see ${args.logPath}`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Timed out after ${args.timeoutMs} ms waiting for ${args.description}; see ${args.logPath}`,
  );
}

export async function readTrackedProcessState(args: {
  pidPath: string;
  serviceName: string;
}): Promise<DevAppProcessState> {
  try {
    await readRunningPid(args);
    return "running";
  } catch {
    return "stopped";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ESRCH")) {
      return false;
    }
    return true;
  }
}

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(STOP_POLL_MS);
  }
  return !isProcessAlive(pid);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isErrnoCode(error, "ESRCH")) {
      process.kill(pid, signal);
    }
  }
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnPortableOutputProcess({
      args: ["/PID", String(pid), "/T", "/F"],
      command: "taskkill.exe",
      cwd: process.cwd(),
      env: process.env,
    });
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", rejectPromise);
    child.once("exit", () => resolvePromise());
  });
}

export async function stopTrackedProcess(args: {
  pidPath: string;
  platform: NodeJS.Platform;
  serviceName: string;
}): Promise<"not-running" | "stopped"> {
  let pid: number;
  try {
    pid = await readRunningPid({ pidPath: args.pidPath, serviceName: args.serviceName });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.startsWith("No running ") ||
      message.startsWith("Stale PID file") ||
      message.startsWith("Invalid PID file")
    ) {
      return "not-running";
    }
    throw error;
  }
  if (args.platform === "win32") {
    await runTaskkill(pid);
    await waitForProcessGone(pid, STOP_GRACE_MS);
  } else {
    signalProcessGroup(pid, "SIGTERM");
    if (!(await waitForProcessGone(pid, STOP_GRACE_MS))) {
      signalProcessGroup(pid, "SIGKILL");
      await waitForProcessGone(pid, STOP_GRACE_MS);
    }
  }
  await rm(args.pidPath, { force: true });
  return "stopped";
}

export async function followLogFile(args: {
  logPath: string;
  pollIntervalMs?: number;
  signal: AbortSignal;
  write: (chunk: string) => void;
}): Promise<void> {
  const pollIntervalMs = args.pollIntervalMs ?? 500;
  let offset = 0;
  while (!args.signal.aborted) {
    let handle;
    try {
      handle = await open(args.logPath, "r");
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) {
        throw error;
      }
      await sleep(pollIntervalMs);
      continue;
    }
    try {
      const { size } = await handle.stat();
      if (size < offset) {
        offset = 0;
      }
      if (size > offset) {
        const buffer = Buffer.alloc(size - offset);
        await handle.read(buffer, 0, buffer.length, offset);
        offset = size;
        args.write(buffer.toString("utf8"));
      }
    } finally {
      await handle.close();
    }
    await sleep(pollIntervalMs);
  }
}
```

Amendment after measurement on the reference desktop (2026-09-11): the "not detached + `windowsHide`" spawn above is wrong on Windows. libuv places every non-detached child in a kill-on-close job object (with silent breakaway for grandchildren), so the tracked leader died seconds after the launcher exited while its grandchildren survived orphaned. A detached child, on the other hand, has no console, and a console grandchild it spawns without `CREATE_NO_WINDOW` gets a fresh visible window. The measured design that satisfies both constraints is a Windows session host:

- On win32, `startLoggedProcess` spawns `node <run-dev-app-session-host> <logPath> <command> <args...>` with `detached: true`, `windowsHide: true`, `stdio: "ignore"`, and records the host's pid. The host is described by a new required-on-win32 field `windowsSessionHost?: { command: string; args: string[] }` on `StartLoggedProcessArgs`; the command file passes `{ command: process.execPath, args: [...process.execArgv, sessionHostPath] }`, where `sessionHostPath` is `run-dev-app-session-host` next to `run-dev-app` with the same extension (`.ts` under tsx, `.js` in `dist`).
- The host (`packages/scripts/src/commands/run-dev-app-session-host.ts`, one screen of code) calls the lib's exported `runSessionHost({ args, command, cwd, env, logPath }): Promise<number>`, which opens the log, spawns the real command through `spawnPortableProcess` with `stdio: ["ignore", fd, fd]` and `windowsHide: true` (not detached, so the child sits in the host's job and dies with it), closes the fd, and resolves with the child's exit code; the host process exits with that code.
- `stopTrackedProcess` on win32 is unchanged: `taskkill /PID <host> /T /F` terminates host, `cmd.exe` shim, `conhost`, and every descendant (measured with a probe: all four processes ended, no visible window at any point, the leader survived the launcher's exit).
- POSIX keeps the direct detached group-leader spawn.

Task 8c re-measures `pnpm dev:app current` → launcher exits → `pnpm dev:status` still `running` → `pnpm dev:stop` leaves no listener, and records it in `qa/windows/phase-0/20-dev-app.txt`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- dev-app-launcher`
Expected: PASS on Linux/macOS and on the reference desktop (run it there too: the `taskkill` branch is only exercised on win32).

Run: `pnpm exec turbo run typecheck --filter=@bb/process-utils --filter=@bb/scripts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/process-utils/src/index.ts packages/scripts/src/lib/dev-app-launcher.ts packages/scripts/test/dev-app-launcher.test.ts
git commit -m "Add logged background process control for the dev launcher

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8c: `run-dev-app` command and root scripts

**Files:**
- Create: `packages/scripts/src/commands/run-dev-app.ts`
- Modify: `packages/scripts/package.json` (`bin`), root `package.json:19-21`, `apps/desktop/README.md:7-17`
- Test: `packages/scripts/test/run-dev-app.test.mjs`

`scripts/bb-dev-app` and its test `packages/scripts/test/bb-dev-app.test.mjs` stay in place until Task 8d has rewritten every reference to them.

**Interfaces:**
- Consumes: everything Task 8a and 8b produce; `resolveCurrentDevInstanceConfig(repoRoot)` and `stripThreadContextEnv(env)` from `@bb/config/runtime`; `runScriptProcess(request)` from `../lib/process-helpers.js`; `spawnPortableOutputProcess` from `@bb/process-utils`.
- Produces: `node --conditions=source --import tsx packages/scripts/src/commands/run-dev-app.ts <current|env|logs|status|stop|help> [--desktop] [--open] [--powershell] [dev|desktop]`, the built `dist/commands/run-dev-app.js`, and the root scripts `dev:app` (the launcher itself, for any subcommand), `dev:desktop`, `dev:status`, `dev:stop`.

- [ ] **Step 1: Write the failing test**

Create `packages/scripts/test/run-dev-app.test.mjs`:

```js
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const commandPath = join(repoRoot, "packages", "scripts", "src", "commands", "run-dev-app.ts");

function runDevApp(args, env) {
  return spawnSync(
    process.execPath,
    ["--conditions=source", "--import", "tsx", commandPath, ...args],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } },
  );
}

describe("run-dev-app", () => {
  it("reports status for a checkout with nothing running", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "bb-dev-app-home-"));
    try {
      const result = runDevApp(["status"], { HOME: tempHome, USERPROFILE: tempHome });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `Node: ${process.version} (ABI ${process.versions.modules}) at ${process.execPath}`,
      );
      expect(result.stdout).toContain("Dev session: stopped");
      expect(result.stdout).toContain("Desktop session: stopped");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("stops cleanly when nothing is running", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "bb-dev-app-home-"));
    try {
      const result = runDevApp(["stop"], { HOME: tempHome, USERPROFILE: tempHome });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("dev server: not running");
      expect(result.stderr).toContain("desktop: not running");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("prints usage and fails on an unknown command", () => {
    const result = runDevApp(["main"], {});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: main");
    expect(result.stderr).toContain("Usage: pnpm dev:desktop");
  });

  it("prints shell-specific env lines", () => {
    const posix = runDevApp(["env"], {});
    const powershell = runDevApp(["env", "--powershell"], {});

    expect(posix.status).toBe(0);
    expect(posix.stdout.split("\n")[0]).toMatch(/^export BB_SERVER_URL=http:\/\/127\.0\.0\.1:\d+$/u);
    expect(posix.stdout).toContain("unset BB_THREAD_STORAGE");
    expect(powershell.status).toBe(0);
    expect(powershell.stdout.split("\n")[0]).toMatch(/^\$env:BB_SERVER_URL = "http:\/\/127\.0\.0\.1:\d+"$/u);
  });

  it("pins the root engine floor for primary development", () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const nodePin = readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim();

    expect(packageJson.engines.node).toBe(`>=${nodePin}`);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- run-dev-app`
Expected: FAIL; the first four cases exit non-zero with `Cannot find module`.

- [ ] **Step 3: Write the command**

Create `packages/scripts/src/commands/run-dev-app.ts`:

```ts
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCurrentDevInstanceConfig,
  stripThreadContextEnv,
} from "@bb/config/runtime";
import type { DevInstanceConfig } from "@bb/config/runtime";
import {
  spawnPortableOutputProcess,
  spawnPortableProcess,
} from "@bb/process-utils";
import {
  DESKTOP_READY_TIMEOUT_MS,
  DEV_FAILURE_PATTERNS,
  DEV_SERVER_READY_PATTERN,
  DEV_SERVER_READY_TIMEOUT_MS,
  assertDesktopNodeRuntime,
  desktopReadyPattern,
  followLogFile,
  formatDevAppEnv,
  formatDevAppStatus,
  parseDevAppArgs,
  readTrackedProcessState,
  resolveDevAppPaths,
  resolveOpenUrlCommand,
  startLoggedProcess,
  stopTrackedProcess,
  waitForLogPattern,
} from "../lib/dev-app-launcher.js";
import type { DevAppPaths } from "../lib/dev-app-launcher.js";
import { runScriptProcess } from "../lib/process-helpers.js";

const commandsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(commandsDir, "..", "..", "..", "..");

const USAGE = [
  "Usage: pnpm dev:app <command> [flags] (shortcuts: pnpm dev:desktop | pnpm dev:status | pnpm dev:stop)",
  "  current [--desktop] [--open]   restart the source dev loop for this checkout",
  "  status                         print instance, ports and session state",
  "  stop                           stop the dev server and desktop sessions",
  "  env [--powershell]             print shell lines that target this checkout's dev server",
  "  logs [dev|desktop]             follow a session log",
].join("\n");

function log(message: string): void {
  process.stderr.write(`[dev-app] ${message}\n`);
}

function captureCommandOutput(
  command: string,
  args: string[],
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawnPortableOutputProcess({
      args,
      command,
      cwd: repoRoot,
      env: process.env,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => resolvePromise(null));
    child.once("close", (code) => {
      resolvePromise(
        code === 0 ? Buffer.concat(chunks).toString("utf8").trim() : null,
      );
    });
  });
}

async function runStep(
  description: string,
  command: string,
  args: string[],
): Promise<void> {
  log(description);
  const code = await runScriptProcess({
    args,
    command,
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (code !== 0) {
    throw new Error(`${description} failed with exit code ${code}`);
  }
}

async function ensureDependencies(desktop: boolean): Promise<void> {
  await runStep("Installing dependencies", "pnpm", ["install", "--frozen-lockfile"]);
  await runStep("Checking native modules", process.execPath, [
    join(repoRoot, "scripts", "ensure-native-modules.mjs"),
  ]);
  await runStep("Building the plugin SDK", "pnpm", [
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@get-bb/plugin-sdk",
    "--output-logs=new-only",
  ]);
  if (!desktop) {
    return;
  }
  const desktopRequire = createRequire(
    join(repoRoot, "apps", "desktop", "package.json"),
  );
  try {
    desktopRequire("electron");
  } catch {
    const installScript = desktopRequire.resolve("electron/install.js");
    await runStep("Installing the Electron binary", process.execPath, [installScript]);
  }
}

function childEnv(): NodeJS.ProcessEnv {
  return stripThreadContextEnv(process.env);
}

async function stopAll(paths: DevAppPaths): Promise<void> {
  const desktop = await stopTrackedProcess({
    pidPath: paths.desktopPidPath,
    platform: process.platform,
    serviceName: "desktop",
  });
  log(`desktop: ${desktop === "stopped" ? "stopped" : "not running"}`);
  const dev = await stopTrackedProcess({
    pidPath: paths.devPidPath,
    platform: process.platform,
    serviceName: "dev server",
  });
  log(`dev server: ${dev === "stopped" ? "stopped" : "not running"}`);
}

async function startDevServer(paths: DevAppPaths): Promise<void> {
  log(`Starting dev server, log ${paths.devLogPath}`);
  await startLoggedProcess({
    args: ["run", "dev"],
    command: "pnpm",
    cwd: repoRoot,
    env: childEnv(),
    logPath: paths.devLogPath,
    pidPath: paths.devPidPath,
    platform: process.platform,
  });
  await waitForLogPattern({
    description: "dev server",
    failurePatterns: DEV_FAILURE_PATTERNS,
    logPath: paths.devLogPath,
    readyPattern: DEV_SERVER_READY_PATTERN,
    timeoutMs: DEV_SERVER_READY_TIMEOUT_MS,
  });
}

async function startDesktop(
  config: DevInstanceConfig,
  paths: DevAppPaths,
): Promise<void> {
  log(`Starting desktop, log ${paths.desktopLogPath}`);
  await startLoggedProcess({
    args: ["exec", "turbo", "run", "dev", "--filter=@bb/desktop"],
    command: "pnpm",
    cwd: repoRoot,
    env: childEnv(),
    logPath: paths.desktopLogPath,
    pidPath: paths.desktopPidPath,
    platform: process.platform,
  });
  await waitForLogPattern({
    description: "desktop app",
    failurePatterns: DEV_FAILURE_PATTERNS,
    logPath: paths.desktopLogPath,
    readyPattern: desktopReadyPattern(config.ports.appPort),
    timeoutMs: DESKTOP_READY_TIMEOUT_MS,
  });
}

function openAppUrl(config: DevInstanceConfig): void {
  const url = `http://localhost:${config.ports.appPort}`;
  const opener = resolveOpenUrlCommand(process.platform, url);
  const child = spawnPortableProcess({
    args: opener.args,
    command: opener.command,
    cwd: repoRoot,
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.once("error", (error) => log(`Could not open ${url}: ${error.message}`));
  child.unref();
}

async function printStatus(
  config: DevInstanceConfig,
  paths: DevAppPaths,
): Promise<void> {
  const [branchName, commit, codexVersion, devState, desktopState] =
    await Promise.all([
      captureCommandOutput("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
      captureCommandOutput("git", ["rev-parse", "--short", "HEAD"]),
      captureCommandOutput("codex", ["--version"]),
      readTrackedProcessState({ pidPath: paths.devPidPath, serviceName: "dev server" }),
      readTrackedProcessState({ pidPath: paths.desktopPidPath, serviceName: "desktop" }),
    ]);
  process.stdout.write(
    `${formatDevAppStatus({
      branch: `${branchName ?? "unknown"} (${commit ?? "unknown"})`,
      codexVersion: codexVersion ?? "not installed",
      config,
      desktopState,
      devState,
      execPath: process.execPath,
      nodeAbi: process.versions.modules,
      nodeVersion: process.version,
      paths,
    })}\n`,
  );
}

async function main(): Promise<void> {
  const args = parseDevAppArgs(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const config = resolveCurrentDevInstanceConfig(repoRoot);
  const paths = resolveDevAppPaths(config, process.env);
  if (args.command === "status") {
    await printStatus(config, paths);
    return;
  }
  if (args.command === "stop") {
    await stopAll(paths);
    return;
  }
  if (args.command === "env") {
    process.stdout.write(
      `${formatDevAppEnv(config, args.powershell ? "powershell" : "posix")}\n`,
    );
    return;
  }
  if (args.command === "logs") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await followLogFile({
      logPath: args.logTarget === "desktop" ? paths.desktopLogPath : paths.devLogPath,
      signal: controller.signal,
      write: (chunk) => {
        process.stdout.write(chunk);
      },
    });
    return;
  }
  if (args.desktop) {
    assertDesktopNodeRuntime({
      execPath: process.execPath,
      version: process.version,
    });
  }
  await stopAll(paths);
  await ensureDependencies(args.desktop);
  await startDevServer(paths);
  if (args.desktop) {
    await startDesktop(config, paths);
  }
  if (args.open) {
    openAppUrl(config);
  }
  await printStatus(config, paths);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[dev-app] ${message}\n${USAGE}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Wire the scripts and delete the bash launcher**

`packages/scripts/package.json` `bin` gains (keep alphabetical order):

```json
    "bb-script-run-dev-app": "./dist/commands/run-dev-app.js",
```

Root `package.json` lines 19-21 become these four lines:

```json
    "dev:app": "cross-env NODE_ENV=development node --conditions=source --import tsx packages/scripts/src/commands/run-dev-app.ts",
    "dev:desktop": "cross-env NODE_ENV=development node --conditions=source --import tsx packages/scripts/src/commands/run-dev-app.ts current --desktop",
    "dev:status": "cross-env NODE_ENV=development node --conditions=source --import tsx packages/scripts/src/commands/run-dev-app.ts status",
    "dev:stop": "cross-env NODE_ENV=development node --conditions=source --import tsx packages/scripts/src/commands/run-dev-app.ts stop",
```

In `apps/desktop/README.md` replace lines 15-16 ("That starts the source dev server and the Electron shell through `scripts/bb-dev-app`.") with:

```markdown
That starts the source dev server and the Electron shell through the Node
launcher `packages/scripts/src/commands/run-dev-app.ts` (`pnpm dev:status`,
`pnpm dev:stop` and `pnpm dev:app <command>` drive the same sessions; logs
live under `~/.bb-dev/<checkout-instance>/dev-app/`). It works from
PowerShell as well as POSIX shells and needs Node 22.19 or newer on the 22
line.
```

- [ ] **Step 5: Run the tests, the build and a live cycle**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- run-dev-app`
Expected: PASS (5 cases).

Run: `pnpm exec turbo run build --filter=@bb/scripts && ls packages/scripts/dist/commands/run-dev-app.js`
Expected: the built entry exists.

Run on the reference desktop, from PowerShell with Node 22.19:

```powershell
pnpm dev:status
pnpm dev:desktop
```

Expected: `dev:status` prints the thirteen lines with both sessions `stopped`; `dev:desktop` installs, checks native modules, starts the dev server (`[dev-app] Starting dev server, log ...`), then Electron opens a window, and the final status shows `Dev session: running` and `Desktop session: running`. Then:

```powershell
pnpm dev:stop
tasklist /FI "IMAGENAME eq electron.exe" /FO CSV
tasklist /FI "IMAGENAME eq node.exe" /FO CSV
```

Expected: both sessions report `stopped`; no `electron.exe` remains and no `node.exe` listening on the instance ports (`netstat -ano | findstr :<serverPort>` is empty). Record the transcript in `qa/windows/phase-0/20-dev-app.txt` together with three observations that Task 10 documents:

1. whether any console window appeared while `pnpm dev:desktop` ran (expected: none, because of `windowsHide`);
2. whether both sessions were still running after the launcher process exited (`pnpm dev:status` from a second PowerShell window; expected: `running`);
3. whether both sessions survived closing the PowerShell window that ran `pnpm dev:desktop` (expected: `running`, because the hidden console is not the window's console).

Run on macOS or Linux (any contributor machine): the same three commands behave as the bash launcher did.

- [ ] **Step 6: Commit**

```bash
git add packages/scripts/src/commands/run-dev-app.ts packages/scripts/package.json package.json apps/desktop/README.md packages/scripts/test/run-dev-app.test.mjs
git commit -m "Add a Node dev-app launcher behind pnpm dev:app

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8d: Reference sweep and removal of the bash launcher

**Files:**
- Modify: `docs/debugging-and-qa.md:13-24`, `apps/mobile/README.md:324`, `apps/mobile/README.md:762`, `apps/mobile/e2e/manual/phase7-plugins-devserver.yaml:1-2`, `.bb/skills/verify-bb/SKILL.md:71,91,104,131,132,147,226,227`, `.bb/skills/verify-bb/features/desktop.md:9`, `.bb/skills/verify-bb/features/developer-fixtures.md:14`, `.bb/skills/plugin-guide-maintenance/SKILL.md:114`
- Delete: `scripts/bb-dev-app`, `packages/scripts/test/bb-dev-app.test.mjs`

**Interfaces:**
- Consumes: the root scripts `dev:app`, `dev:desktop`, `dev:status`, `dev:stop` from Task 8c and the launcher's `env --powershell` and `logs` subcommands.
- Produces: no reference to `scripts/bb-dev-app` outside `docs/superpowers/` and the historical record `.bb/skills/verify-bb/validation-2026-09-05.json`.

- [ ] **Step 1: Apply the replacement mapping**

| Old invocation | New invocation |
|---|---|
| `scripts/bb-dev-app status` (captured to a file) | `pnpm --silent dev:app status` |
| `scripts/bb-dev-app status` (interactive) | `pnpm --silent dev:app status` |
| `scripts/bb-dev-app current` | `pnpm dev:app current` (captured: `pnpm --silent dev:app current`) |
| `scripts/bb-dev-app current --desktop` | `pnpm dev:desktop` |
| `eval "$(scripts/bb-dev-app env)"` | `eval "$(pnpm --silent dev:app env)"` |
| `scripts/bb-dev-app stop` | `pnpm dev:stop` |
| `scripts/bb-dev-app logs dev` / `logs desktop` | `pnpm dev:app logs dev` / `pnpm dev:app logs desktop` |
| `scripts/bb-dev-app main`, `scripts/bb-dev-app branch <b>` | removed; switch branches with `git`, then `pnpm dev:app current` |
| `scripts/bb-dev-app` as a source pointer | `packages/scripts/src/commands/run-dev-app.ts` |

`--silent` matters wherever output is captured: without it pnpm prints its own `> bb@… dev:app` banner into the file.

Replace the "Local Dev QA Launcher" block in `docs/debugging-and-qa.md` (from the heading through the paragraph that ends "desktop-only change.") with:

```markdown
## Local Dev QA Launcher

Use `pnpm dev:app <command>` when validating changes in the desktop dev app or helping QA from this checkout. It runs `packages/scripts/src/commands/run-dev-app.ts`, which works from PowerShell and POSIX shells alike:

- `pnpm dev:status` (`pnpm dev:app status`) prints the active branch, Node runtime, dev URLs, data dir, and logs.
- `pnpm dev:app current` restarts the dev server on the checked-out branch. Switch branches with `git` first; the launcher does not fetch or check out.
- `pnpm dev:stop` (`pnpm dev:app stop`) stops the launcher-managed dev server and desktop.
- `pnpm --silent dev:app env` prints `export` lines that target this checkout's dev server; `--powershell` prints `$env:` lines. Use `eval "$(pnpm --silent dev:app env)"` in bash and `pnpm --silent dev:app env --powershell | Out-String | Invoke-Expression` in PowerShell.
- `pnpm dev:app logs dev` and `pnpm dev:app logs desktop` follow logs.

By default the launcher starts only the dev server (web frontend, server, host daemon) and prints the URL without opening a browser. Pass `--open` to open the browser after startup. Pass `--desktop` (`pnpm dev:desktop`, or `pnpm dev:app current --desktop`) to also launch the Electron desktop shell — only do this when the user is testing a desktop-only change.
```

Leave the paragraph that starts "The launcher uses the Node executable from the caller's `PATH`" and everything after it unchanged.

`.bb/skills/verify-bb/SKILL.md`, exact new lines:

```
71:  pnpm --silent dev:app status
91:  pnpm --silent dev:app status > "$BB_VERIFY_RUN/before-launch.txt"
104: pnpm --silent dev:app current > "$BB_VERIFY_RUN/launch.log" 2>&1
131: pnpm --silent dev:app status
132: eval "$(pnpm --silent dev:app env)"
147: `pnpm dev:app env` deliberately clears the parent thread context,
226: pnpm dev:stop
227: pnpm --silent dev:app status > "$BB_VERIFY_RUN/after-stop.txt"
```

`.bb/skills/verify-bb/features/desktop.md` line 9: `` `pnpm dev:desktop` in place of the web-only launch. Confirm``

`.bb/skills/verify-bb/features/developer-fixtures.md` line 14: ``- `packages/scripts/src/commands/run-dev-app.ts` ``

`.bb/skills/plugin-guide-maintenance/SKILL.md` line 114: `` `pnpm dev:app current`; inspect the affected entry and reachable actions``

`apps/mobile/README.md` line 324: `` `pnpm dev:app current` gives a server URL that works as-is. Physical`` and line 762: ``  (`pnpm dev:app current`; real builtin plugins, read-mostly) and is not``

`apps/mobile/e2e/manual/phase7-plugins-devserver.yaml` lines 1-2:

```yaml
# Phase 7 plugins against the checkout's dev server (`pnpm dev:app current`;
# server port 20304 for this worktree — edit SERVER_URL for another
```

- [ ] **Step 2: Confirm nothing else points at the bash launcher**

Run: `grep -rn "bb-dev-app" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.superpowers .`
Expected: only `docs/superpowers/` files and `.bb/skills/verify-bb/validation-2026-09-05.json` (a dated validation record; leave it).

- [ ] **Step 3: Delete the bash launcher and its test**

```bash
git rm scripts/bb-dev-app packages/scripts/test/bb-dev-app.test.mjs
```

- [ ] **Step 4: Run the suites that read the touched files**

Run: `pnpm exec turbo run test --filter=@bb/scripts --filter=@bb/plugin-api-map`
Expected: PASS (`@bb/plugin-api-map#test` declares `.bb/skills/plugin-guide-maintenance/**` as an input, so it reruns; `@bb/scripts` no longer has the bash test).

Run on the reference desktop: `pnpm --silent dev:app env --powershell | Out-String | Invoke-Expression; $env:BB_SERVER_URL`
Expected: the checkout's server URL prints.

- [ ] **Step 5: Commit**

```bash
git add docs/debugging-and-qa.md apps/mobile/README.md apps/mobile/e2e/manual/phase7-plugins-devserver.yaml .bb/skills/verify-bb/SKILL.md .bb/skills/verify-bb/features/desktop.md .bb/skills/verify-bb/features/developer-fixtures.md .bb/skills/plugin-guide-maintenance/SKILL.md
git commit -m "Point docs and skills at pnpm dev:app and remove the bash launcher

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(The two deletions are already staged by `git rm`.)

---

### Task 9: Non-required `windows-x64` CI job

**Files:**
- Modify: `.github/workflows/ci.yml` (append a job)
- Test: `packages/scripts/test/ci-workflow.test.ts`

**Interfaces:**
- Consumes: workflow env `PRIMARY_NODE_VERSION`, `PNPM_VERSION`; the SHA-pinned actions already used in `build-desktop.yml`.
- Produces: a job that reports install, typecheck, build and a per-package test baseline without gating merges.

- [ ] **Step 1: Write the failing test**

Append to `packages/scripts/test/ci-workflow.test.ts`:

```ts
it("keeps the Windows baseline leg non-blocking", () => {
  const workflow = readFileSync(
    resolve(repoRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const windowsJob = workflow.slice(workflow.indexOf("\n  windows-x64:\n"));

  expect(windowsJob).toContain("runs-on: windows-2025");
  expect(
    /- name: Test \(Windows baseline\)\n\s+id: windows-test\n\s+continue-on-error: true/u.test(
      windowsJob,
    ),
  ).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- ci-workflow`
Expected: FAIL (`windowsJob` is the whole file and lacks `windows-2025`).

- [ ] **Step 3: Append the job**

Add at the end of `.github/workflows/ci.yml`:

```yaml
  # Non-required: native Windows is a port in progress (see
  # docs/superpowers/specs/2026-09-11-native-windows-port-design.md), so this
  # leg reports a per-package failing-test baseline instead of gating merges.
  # It bypasses ./.github/actions/setup-workspace because install-pnpm.sh has
  # no MINGW64_NT case and no pnpm-win-x64 checksum, and it carries no Turbo
  # cache for the same reason the macOS legs do not.
  windows-x64:
    name: Windows x64 (windows-2025, Node 22.x)
    # Pinned rather than windows-latest so the toolchain the port is measured
    # against changes only when we choose it.
    runs-on: windows-2025
    timeout-minutes: 60

    steps:
      - name: Checkout repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Set up pnpm
        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
        with:
          version: ${{ env.PNPM_VERSION }}
          run_install: false

      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: ${{ env.PRIMARY_NODE_VERSION }}
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile --prefer-offline

      - name: Load native add-ons
        run: node qa/windows/scripts/conpty-load-check.mjs

      - name: Typecheck and build
        run: >-
          pnpm exec turbo run typecheck build
          --filter=@bb/domain
          --filter=@bb/process-utils
          --filter=@bb/host-daemon
          --filter=@bb/desktop
          --filter=@bb/scripts
          --output-logs=new-only

      # continue-on-error, not `|| true`: the step still renders as failed in
      # the run summary, so the baseline stays visible while the job stays
      # green. --continue so one package's failures do not hide the others'.
      - name: Test (Windows baseline)
        id: windows-test
        continue-on-error: true
        run: >-
          pnpm exec turbo run test
          --filter=@bb/domain
          --filter=@bb/process-utils
          --filter=@bb/host-daemon
          --filter=@bb/desktop
          --filter=@bb/scripts
          --continue
          --summarize
          --output-logs=new-only

      - name: Upload Windows test run summaries
        if: ${{ always() }}
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: windows-x64-test-results
          path: .turbo/runs/*.json
          if-no-files-found: warn
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- ci-workflow`
Expected: PASS, including the existing `--concurrency=4` assertion (it matches the first `- name: Test` step, which is unchanged).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml packages/scripts/test/ci-workflow.test.ts
git commit -m "Add a non-required Windows x64 CI leg

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Documentation

**Files:**
- Create: `docs/platform-windows.md`
- Modify: `docs/platform-support.md` (the "Maintainer-only or best-effort surfaces" list)

- [ ] **Step 1: Write `docs/platform-windows.md`**

```markdown
<!-- Diátaxis: reference -->

# Native Windows (port in progress)

Native Windows 11 x64 is being ported phase by phase; the design is
[docs/superpowers/specs/2026-09-11-native-windows-port-design.md](superpowers/specs/2026-09-11-native-windows-port-design.md).
Until Phase 3 lands, the supported Windows product path stays WSL2 as
described in [platform-support.md](platform-support.md). This page records
what has been measured on native Windows and what is known not to work.

## Status

| Phase | State |
|---|---|
| 0 Foundation and honest gating | landed; evidence under `qa/windows/phase-0/` |
| 1 Host identity and host-owned paths | not started |
| 2 Processes, environment, Git, hooks, open targets | not started |
| 3 ConPTY, providers, watcher, native `bb-app` | not started |
| 4 Windows Desktop | not started |
| 5 Persistent host and GA hardening | not started |

## Prerequisites for a source checkout

- Windows 11 x64 (build 26100 or newer).
- Node 22.19.x from `.nvmrc` through any Node manager whose switch is global
  (nvm-windows: `nvm install 22.19.0 && nvm use 22.19.0`; fnm works too but
  only in shells that evaluate its env), then pnpm 9.15.0 through
  `corepack enable`.
- Git for Windows 2.52 or newer with `git config --global core.longpaths true`
  and `core.symlinks true`; `LongPathsEnabled` set to `1` under
  `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem`; Developer Mode enabled
  for symlink creation without elevation.
- Visual Studio Build Tools (Desktop development with C++) and Python 3.11+
  are only needed when a native add-on has no usable prebuild;
  `scripts/ensure-native-modules.mjs` says so explicitly when that happens.

## Native add-ons

Measured on Windows 11 Pro 10.0.26200 (see `qa/windows/phase-0/11-native-modules.md`):

- `better-sqlite3@12.10.0` installs a `win32-x64` prebuild for Node ABI 137
  (Node 24) and 127 (Node 22), and for the Electron 41 ABI.
- `node-pty@1.2.0-beta.15` ships N-API prebuilds under `prebuilds/win32-x64/`
  (`conpty.node`, `conpty_console_list.node`, `conpty/conpty.dll`,
  `conpty/OpenConsole.exe`); no compiler is needed.
- `@parcel/watcher@2.5.6` resolves `@parcel/watcher-win32-x64`.

`node qa/windows/scripts/conpty-load-check.mjs` loads all three and echoes
through a real ConPTY; it runs in the `windows-x64` CI job.

## Known limitations after Phase 0

- The product still rejects drive-letter project paths; terminals, hooks and
  provider launch on native Windows arrive in Phases 1 to 3.
- `scripts/ensure-native-modules.mjs` cannot detach pnpm hardlinks on NTFS
  because Node reports `nlink` as 1 there; a repair rewrites the shared store
  copy. Reinstall from a clean store if two checkouts disagree on the ABI.
- `pnpm dev:desktop` starts its two sessions as hidden-console processes
  (`windowsHide`), not as detached processes; see
  `qa/windows/phase-0/20-dev-app.txt` for whether a console window appeared
  and whether the sessions survived the launcher exiting and its PowerShell
  window closing. Copy the three measured answers from that transcript into
  this bullet when writing the page.
- The `bb/no-tmp-path-literal` lint rule runs only in packages with a `lint`
  script (`@bb/app`, `@bb/mobile`); the vitest configs are covered by
  `packages/scripts/test/vitest-config-tmp-literals.test.mjs` instead.
- The Windows CI leg is not required and does not use the Turbo cache; its
  test step records a baseline and never fails the job.

## Evidence

`qa/windows/phase-0/` holds host facts, install output, the native add-on
check, the dev launcher transcript and the per-package test baseline.
```

- [ ] **Step 2: Point `platform-support.md` at it**

In `docs/platform-support.md`, under "Maintainer-only or best-effort surfaces", change the last bullet to:

```markdown
- native Windows PowerShell, CMD, and host-daemon runtime flows; the in-progress
  native port and its measured state are tracked in
  [platform-windows.md](platform-windows.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/platform-windows.md docs/platform-support.md
git commit -m "Document the native Windows port status and prerequisites

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11a: Fix the Windows path-separator check in plugin-build manifest validation

Added after Task 8c's measurement: `pnpm dev:desktop` fails on Windows before Electron starts because bundling the builtin plugins throws `manifest bb.server escapes the plugin directory: "./server.ts"` for every plugin.

**Files:**
- Modify: `packages/plugin-build/src/plugin-manifest.ts:2,27,79`
- Test: `packages/plugin-build/src/plugin-manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveManifestPath` and the symlink check accept nested entries on Windows; the Task 11 build gate can pass.

- [ ] **Step 1: Write the failing test**

Append to `packages/plugin-build/src/plugin-manifest.test.ts` (import `resolve` from `node:path` and `resolveManifestPath` from `./plugin-manifest.js` if the file does not already):

```ts
describe("resolveManifestPath", () => {
  const rootDir = resolve("plugins", "example");

  it("accepts nested entries using the platform separator", () => {
    expect(resolveManifestPath(rootDir, "./server.ts", "bb.server")).toBe(
      resolve(rootDir, "server.ts"),
    );
    expect(
      resolveManifestPath(rootDir, "icons/logo.svg", "bb.branding.logo"),
    ).toBe(resolve(rootDir, "icons", "logo.svg"));
  });

  it("rejects entries that leave the plugin directory, including sibling prefixes", () => {
    expect(() =>
      resolveManifestPath(rootDir, "../outside.ts", "bb.server"),
    ).toThrow("escapes the plugin directory");
    expect(() =>
      resolveManifestPath(rootDir, "../example-2/server.ts", "bb.server"),
    ).toThrow("escapes the plugin directory");
  });
});
```

- [ ] **Step 2: Run it to verify it fails on Windows**

Run: `pnpm exec turbo run test --filter=@bb/plugin-build -- -t "resolveManifestPath"`
Expected on the reference desktop: the first case FAILS with `manifest bb.server escapes the plugin directory: "./server.ts"` because `resolve()` returns backslash paths and the check compares against `rootDir + "/"`. On macOS/Linux both cases already pass; the Windows CI leg from Task 9 is the regression guard.

- [ ] **Step 3: Use the platform separator in both containment checks**

`packages/plugin-build/src/plugin-manifest.ts` line 2 becomes `import { isAbsolute, resolve, sep } from "node:path";`, line 27 becomes `if (resolved !== rootDir && !resolved.startsWith(rootDir + sep)) {` and line 79 becomes `if (realAsset !== realRoot && !realAsset.startsWith(realRoot + sep)) {`.

- [ ] **Step 4: Run the package suite and re-measure the desktop launch**

Run: `pnpm exec turbo run test --filter=@bb/plugin-build`
Expected: PASS on the reference desktop.

Run on the reference desktop: `pnpm dev:desktop`, then `pnpm dev:status`, then `pnpm dev:stop`. Append the outcome (Electron window or the first failing task's log tail, and the final status) under a heading "Desktop after the plugin-build fix" in `qa/windows/phase-0/20-dev-app.txt`. A desktop-app failure past the plugin bundling step is recorded, not fixed (Windows Desktop is Phase 4).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-build/src/plugin-manifest.ts packages/plugin-build/src/plugin-manifest.test.ts
git commit -m "Compare plugin manifest paths with the platform separator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Phase gate and evidence

**Files:**
- Create: `qa/windows/scripts/summarize-turbo-run.mjs`, `qa/windows/phase-0/00-host.md`, `10-install.txt`, `11-native-modules.md`, `20-dev-app.txt`, `30-build-typecheck.txt`, `31-test-baseline.md`, `40-ci-run.md`

**Interfaces:**
- Consumes: Turbo run summaries under `.turbo/runs/*.json` produced by `--summarize`.
- Produces: the baseline table the spec §7 Phase 0 gate requires.

- [ ] **Step 1: Write the summariser**

Create `qa/windows/scripts/summarize-turbo-run.mjs`:

```js
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const runsDir = resolve(process.argv[2] ?? join(process.cwd(), ".turbo", "runs"));
const latest = readdirSync(runsDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => join(runsDir, name))
  .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];

if (latest === undefined) {
  throw new Error(`No Turbo run summaries under ${runsDir}`);
}

const summary = JSON.parse(readFileSync(latest, "utf8"));
const rows = summary.tasks
  .filter((task) => task.task === "test")
  .map((task) => {
    const exitCode = task.execution?.exitCode;
    const state = exitCode === 0 ? "pass" : exitCode === undefined ? "skipped" : `fail (${exitCode})`;
    return `| ${task.package} | ${state} |`;
  })
  .sort();

process.stdout.write(
  ["| package | test task |", "|---|---|", ...rows, "", `Source: ${latest}`, ""].join("\n"),
);
```

- [ ] **Step 2: Build and typecheck on the reference desktop**

```powershell
fnm use 22.19.0
pnpm exec turbo run build typecheck --output-logs=new-only 2>&1 | Tee-Object qa/windows/phase-0/30-build-typecheck.txt
```

Expected: exit code 0 with every task passing. Any failure here blocks the gate: fix it in a follow-up task on this branch (each fix is its own commit) and rerun until green.

- [ ] **Step 3: Record the test baseline**

```powershell
pnpm exec turbo run test --continue --summarize --output-logs=errors-only 2>&1 | Tee-Object qa/windows/phase-0/31-test-output.txt
node qa/windows/scripts/summarize-turbo-run.mjs | Tee-Object qa/windows/phase-0/31-test-baseline.md
```

Expected: the summariser prints one row per package; failures are expected and are the baseline, not a gate failure. Add a heading with the date, Node version and commit SHA at the top of `31-test-baseline.md`. Delete `31-test-output.txt` if it exceeds 2 MB and keep only the last 200 lines under `31-test-output-tail.txt`.

- [ ] **Step 4: Run the Windows CI job**

Push the branch and dispatch the workflow on the fork:

```bash
git push -u origin windows-native/phase-0
gh workflow run ci.yml --ref windows-native/phase-0 -R OlegFM/bb
gh run list -R OlegFM/bb --workflow ci.yml --branch windows-native/phase-0 --limit 1
```

Expected: the `Windows x64 (windows-2025, Node 22.x)` job completes green with the test step marked as failed-but-continued or green. The `blacksmith-*` jobs stay queued on the fork because those runners exist only upstream; cancel the run with `gh run cancel <id> -R OlegFM/bb` once the Windows job has finished (`gh run view <id> -R OlegFM/bb --json jobs` shows per-job status), and record the run URL, the job result and the artifact name in `qa/windows/phase-0/40-ci-run.md`.

- [ ] **Step 5: Commit the evidence and summariser**

```bash
git add qa/windows/scripts/summarize-turbo-run.mjs qa/windows/phase-0
git commit -m "Record the Phase 0 Windows baseline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 6: Gate check**

Confirm all of the following before calling Phase 0 done:

- `qa/windows/phase-0/10-install.txt` ends with a successful install on Node 22.19.
- `11-native-modules.md` shows three `ok` lines on Node 22.
- `30-build-typecheck.txt` shows zero failed tasks.
- `31-test-baseline.md` lists every package with a `test` task.
- `40-ci-run.md` links a green `windows-x64` job.
- `pnpm exec turbo run test --filter=@bb/scripts --filter=bb-app` is green on a POSIX machine or in the upstream-style Ubuntu job (no regression from Tasks 1 to 9).

Then merge `windows-native/phase-0` into the fork's `main` and open Phase 1 planning.

---

### Task 11b: Resolve registry imports with POSIX paths in the plugin-registry build script

Added by the Phase 0 gate (Task 11): on the reference desktop `pnpm exec turbo run build typecheck` fails only in `@bb/plugin-registry#typecheck`, and `@bb/plugin-registry#test` crashes before vitest, both with `Error: item name collision: "toggle" from both components\ui\toggle.tsx and components/ui/toggle.tsx` thrown at `packages/plugin-registry/scripts/build-registry.mjs:152`.

**Files:**
- Modify: `packages/plugin-registry/scripts/build-registry.mjs:55-58`

**Interfaces:**
- Consumes: `registry.json` `uiItems` and import specifiers, both POSIX-style (`components/ui/<name>.tsx`, `./toggle`, `@/lib/utils`).
- Produces: `resolveLocal` returns POSIX-style app-src-relative paths on every platform, so `--check` passes on Windows and the generated `r/` output is byte-identical to a POSIX build.

Root cause: `resolveLocal` builds relative-import candidates with `path.join(path.dirname(importerRel), specifier)`; on win32 that returns `components\ui\toggle`, which no longer equals the POSIX `components/ui/toggle.tsx` that `uiItems` seeds, so the same file is seen twice under two spellings and `itemNameFor` reports a collision.

- [ ] **Step 1: Reproduce**

Run: `pnpm exec turbo run typecheck --filter=@bb/plugin-registry`
Expected: FAIL with the collision error above (save the output to `.superpowers/sdd/2026-09-11-native-windows-phase-0/task-11b-red.log`).

- [ ] **Step 2: Use the POSIX path API for the relative-import join**

Replace lines 56-58 of `packages/plugin-registry/scripts/build-registry.mjs`:

```js
    base = path.normalize(
      path.join(path.dirname(importerRel), specifier),
    );
```

with

```js
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(importerRel), specifier),
    );
```

No other line changes; `path.basename` (lines 106 and 115) already accepts forward slashes on win32, and `path.join(srcRoot, candidate)` on line 70 only feeds `existsSync`, which accepts mixed separators.

- [ ] **Step 3: Verify**

Run: `pnpm exec turbo run typecheck test --filter=@bb/plugin-registry`
Expected: `--check` passes, `typecheck` passes; vitest runs (record its `Test Files`/`Tests` lines; pre-existing Windows failures inside vitest are baseline, not this task's regression). Then `git status --short packages/plugin-registry/` must show nothing under `packages/plugin-registry/r/`: the generated registry is unchanged, which proves the Windows output now matches the committed POSIX output.

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-registry/scripts/build-registry.mjs
git commit -m "Resolve registry imports with POSIX paths in build-registry.mjs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11c: Run CI on pushes to `windows-native/**` branches

Added by the Phase 0 gate (Task 11): on the fork `gh workflow run ci.yml --ref windows-native/phase-0 -R OlegFM/bb` answers `HTTP 404: workflow ci.yml not found on the default branch` because GitHub registers a fork's workflow only after an event triggers it (`version-lockstep.yml`, which has a bare `push:` trigger, was registered by the branch push; `ci.yml`, which only pushes on `main`, was not). A push trigger for the phase branches runs `ci.yml`, including the `windows-x64` job, on every push of this branch and registers the workflow for later dispatches.

**Files:**
- Modify: `.github/workflows/ci.yml:4-7`
- Test: `packages/scripts/test/ci-workflow.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/scripts/test/ci-workflow.test.ts`:

```ts
it("runs CI on pushes to native Windows phase branches", () => {
  const workflow = readFileSync(
    resolve(repoRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const pushBranches = /on:\n  push:\n    branches:\n((?:      - .+\n)+)/u.exec(
    workflow,
  )?.[1];

  expect(pushBranches).toContain('      - "windows-native/**"\n');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- ci-workflow`
Expected: FAIL (`pushBranches` is `      - main\n`).

- [ ] **Step 3: Add the branch pattern**

In `.github/workflows/ci.yml`, change

```yaml
on:
  push:
    branches:
      - main
  pull_request:
```

to

```yaml
on:
  push:
    branches:
      - main
      - "windows-native/**"
  pull_request:
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec turbo run test --filter=@bb/scripts -- ci-workflow`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml packages/scripts/test/ci-workflow.test.ts
git commit -m "Run CI on pushes to windows-native branches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
