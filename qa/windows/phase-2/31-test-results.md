# Tests on the reference Windows desktop (Phase 2 gate, Step 3)

**Commit:** `7d0603bb4777132efd0e122ffc6d8064105333be` (`windows-native/phase-2`)
**Node:** v22.19.0 · **pnpm:** 9.15.0 · **pwsh:** 7.6.6 · **OS:** Windows 11 Pro 10.0.26200 (`00-host.md`)
**Branch base for comparison:** `07fdce05b` (Phase 1 head), checked out in a **separate worktree**
(`git worktree add`, `pnpm install --offline`, `pnpm exec turbo run build`), never in the main checkout.
The worktree was removed at the end of the gate (`git worktree remove` / `git worktree prune`).

> ## Verdict: **FAIL**
>
> Two test files that pass at the branch base fail at this head, both deterministically and for code
> reasons, not load:
>
> 1. `apps/server/test/services/plugins/plugin-authoring-docs.test.ts` — **platform-independent**
>    (fails on Linux too, `40-posix-check.md`).
> 2. `apps/host-daemon/src/plugin-host-manager.test.ts` — **Windows-only** (passes 19/19 on Linux).
>
> Detail in "Two newly failing test files" below. Per the gate's standing instruction they are recorded and
> **not fixed**. Everything else in this step is clean or improved against both baselines.

## Method, and why isolation runs are the measurement

Phase 1 established that full-load Turbo runs on this desktop inflate failure counts through vitest
fork-pool starvation — at the Phase 1 refresh-3 gate, `@bb/app` reported 492 of 507 files because fifteen
never started a worker. That is worse here: this gate's filter list is **23 packages**, ten more than
Phase 1's thirteen. So the procedure is Phase 1's:

1. one full-load run with the brief's filter list, for the summariser table and the run summary JSON;
2. **isolation re-runs** of every package that moved, and those numbers are authoritative;
3. the same packages re-run at the base worktree, so "pre-existing" is measured rather than assumed.

All 23 package names were re-checked against their `package.json` before building the `--filter` flags
(`bb-environment-provider-host`, `bb-plugin-automations`, `bb-plugin-github`,
`bb-plugin-provider-claude-code`, `bb-app` are not `@bb/…`), because a stale name makes Turbo silently skip
the package.

## Full-load run

```powershell
pnpm exec turbo run test --continue --summarize --output-logs=errors-only --filter=@bb/domain --filter=@bb/db --filter=@bb/host-daemon-contract --filter=@bb/desktop-contract --filter=@bb/server-contract --filter=@bb/config --filter=@bb/scripts --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/app --filter=@bb/desktop --filter=bb-plugin-environment-git-worktree --filter=bb-plugin-environment-personal-workspace --filter=@bb/process-utils --filter=@bb/host-workspace --filter=bb-environment-provider-host --filter=@bb/secret-storage --filter=@bb/local-open-targets --filter=@bb/cli --filter=bb-plugin-automations --filter=bb-plugin-github --filter=bb-plugin-provider-claude-code --filter=bb-app 2>&1 | Tee-Object qa/windows/phase-2/31-test-output.txt; "EXIT=$LASTEXITCODE" | Tee-Object -Append qa/windows/phase-2/31-test-output.txt
```
```
  Tasks:    15 successful, 31 total
 Cached:    7 cached, 31 total
   Time:    7m57.893s 
Summary:    C:\Users\olege\Work\bb\.turbo\runs\3JKrwwED587vxSvZcNRW04gnnSh.json
 Failed:    @bb/app#test, @bb/cli#test, @bb/config#test, @bb/db#test, @bb/desktop#test, @bb/host-daemon#test, @bb/host-workspace#test, @bb/local-open-targets#test, @bb/process-utils#test, @bb/scripts#test, @bb/server#test, bb-app#test, bb-plugin-automations#test, bb-plugin-environment-personal-workspace#test, bb-plugin-github#test, bb-plugin-provider-claude-code#test

 ERROR  run failed: command  exited (1)
EXIT=1
```

`31-test-output.txt` was 1,492,832 bytes; its last 200 lines are kept as `31-test-output-tail.txt` and the
full file was deleted, as in every earlier round. The run summary JSON (1 MB+) was **not** copied into the
repo.

### Table 1: pass/fail per package (summariser output)

```powershell
node qa/windows/scripts/summarize-turbo-run.mjs; "EXIT=$LASTEXITCODE"
```

| package | test task |
|---|---|
| @bb/app | fail (1) |
| @bb/cli | fail (1) |
| @bb/config | fail (1) |
| @bb/db | fail (1) |
| @bb/desktop | fail (1) |
| @bb/desktop-contract | pass |
| @bb/domain | pass |
| @bb/host-daemon | fail (1) |
| @bb/host-daemon-contract | pass |
| @bb/host-workspace | fail (1) |
| @bb/local-open-targets | fail (1) |
| @bb/process-utils | fail (1) |
| @bb/scripts | fail (1) |
| @bb/secret-storage | pass |
| @bb/server | fail (1) |
| @bb/server-contract | pass |
| bb-app | fail (1) |
| bb-environment-provider-host | pass |
| bb-plugin-automations | fail (1) |
| bb-plugin-environment-git-worktree | pass |
| bb-plugin-environment-personal-workspace | fail (1) |
| bb-plugin-github | fail (1) |
| bb-plugin-provider-claude-code | fail (1) |

Source: `C:\Users\olege\Work\bb\.turbo\runs\3JKrwwED587vxSvZcNRW04gnnSh.json`
EXIT=0 (summariser)

All 23 filters resolved — no package was silently skipped.

**The six pure packages the brief requires to still pass all pass**: `@bb/domain`, `@bb/db`(¹),
`@bb/host-daemon-contract`, `@bb/desktop-contract`, `@bb/server-contract`, `@bb/config`(²).

¹ `@bb/db` shows `fail (1)` under load on a single 5 s timeout in `test/migration-journal.test.ts`; at the
Phase 1 refresh-3 gate the same file failed under load and the package passed 34/34 alone. Same here, see
Table 3.
² `@bb/config` fails 1 file / 8 tests — **byte-identical** to the Phase 0 baseline and to every Phase 1
refresh. Not a regression; it is the package's known Windows baseline.

Three packages that Phase 1 never ran pass outright here: **`@bb/secret-storage`**,
**`bb-environment-provider-host`** and **`bb-plugin-environment-git-worktree`** — and the last one *failed*
at the Phase 1 refresh-3 gate (1 file / 8 tests in `host.test.ts`), so Phase 2 improved it.

### Table 2: vitest summaries, full-load run

| package | test files (failed/passed/skipped) | tests (failed/passed/skipped) |
|---|---|---|
| @bb/app | 10 / 497 (507) | 17 / 4333 / 3 |
| @bb/cli | 10 / 45 / 1 (56) | 20 / 556 / 10 |
| @bb/config | 1 / 6 (7) | 8 / 108 |
| @bb/db | 1 / 33 (34) | 1 / 496 |
| @bb/desktop | 8 / 35 (43) | 16 / 310 / 1 |
| @bb/host-daemon | 21 / 31 / 1 (53) | 60 / 577 / 8 |
| @bb/host-workspace | 6 / 2 (8) | 37 / 136 / 4 |
| @bb/local-open-targets | 1 / 0 (1) | 7 / 77 / 1 |
| @bb/process-utils | 1 / 4 / 1 (6) | 1 / 90 / 12 |
| @bb/scripts | 5 / 21 (26) | 10 / 156 / 2 |
| @bb/server | 44 / 194 / 2 (240) | 197 / 2253 / 6 |
| bb-app | 3 / 2 (5) | 10 / 72 |
| bb-plugin-automations | 3 / 5 (8) | 6 / 90 |
| bb-plugin-environment-personal-workspace | 1 / 2 (3) | 1 / 13 / 1 |
| bb-plugin-github | 2 / 6 (8) | 11 / 37 |
| bb-plugin-provider-claude-code | 2 / 23 (25) | 3 / 347 / 1 |

## Table 3: isolation re-runs (authoritative)

| run | command shape | result |
|---|---|---|
| `@bb/server` alone | `turbo run test --filter=@bb/server --force` | **19 failed** / 219 passed / 2 skipped (240); 133 / 2317 / 6 tests; 2m55.027s |
| `@bb/app` alone | `turbo run test --filter=@bb/app --force` | **8 failed** / 499 passed (507); 14 / 4336 / 3 tests; 5m29.568s; **zero `vitest-pool` errors — all 507 files ran** |
| `@bb/host-daemon` alone | `turbo run test --filter=@bb/host-daemon --force` | **19 failed** / 33 passed / 1 skipped (53); 54 / 583 / 8 tests; 1m40.953s |
| `@bb/host-workspace` alone | `turbo run test --filter=@bb/host-workspace --force` | **5 failed** / 3 passed (8); 26 / 147 / 4 tests; 1m16.47s |
| `bb-plugin-automations` alone | `vitest run --reporter=verbose` | **3 failed** / 5 passed (8); 5 / 91 tests; 15.99s |
| small batch (6 pkgs) | `@bb/local-open-targets`, `@bb/secret-storage`, `bb-environment-provider-host`, `bb-plugin-environment-git-worktree`, `bb-plugin-environment-personal-workspace`, `@bb/config` | 21.411s; `@bb/local-open-targets` **1 file / 6 tests**; `@bb/config` 1 / 8; `bb-plugin-environment-personal-workspace` 1 / 1; other three **pass** |
| batch E (8 pkgs) | `@bb/cli`, `@bb/desktop`, `bb-app`, `bb-plugin-github`, `bb-plugin-provider-claude-code`, `@bb/db`, `@bb/scripts`, `@bb/process-utils` | 4m45.481s; see Table 4 |
| `@bb/process-utils` real file, twice | `vitest run test/windows-process-real.test.ts` (plain, then `--reporter=verbose`) | **4 passed (4)**, `EXIT=0` both times, 23.31s / 23.11s |

Batch E per-package: `@bb/cli` **4 failed** / 51 / 1 (56), 11 / 565 / 10 · `@bb/desktop` **7 failed** / 36
(43), 15 / 311 / 1 · `@bb/db` 1 / 33 (34), 1 / 496 · `@bb/scripts` **6 failed** / 20 (26), 11 / 155 / 2 ·
`bb-app` **3 failed** / 2 (5), 10 / 72 · `bb-plugin-github` **2 failed** / 6 (8), 11 / 37 ·
`bb-plugin-provider-claude-code` **2 failed** / 23 (25), 3 / 347 / 1 · **`@bb/process-utils` passed**.

## Two newly failing test files

### 1. `apps/server/test/services/plugins/plugin-authoring-docs.test.ts` — Phase 2 regression, all platforms

```powershell
pnpm --filter @bb/server exec vitest run test/services/plugins/plugin-authoring-docs.test.ts --reporter=verbose
```
```
 FAIL  |@bb/server| test/services/plugins/plugin-authoring-docs.test.ts > bb-plugin-authoring skill > accounts for every public backend and provider entrypoint export
AssertionError: ExperimentalProcessWithCwd is not documented in the skill: expected '# Backend API symbol index\n\nUse thi…' to contain 'ExperimentalProcessWithCwd'

 ❯ test/services/plugins/plugin-authoring-docs.test.ts:570:63
    568|   it("accounts for every public backend and provider entrypoint export…
    569|     for (const name of PUBLIC_PLUGIN_SDK_EXPORT_NAMES) {
    570|       expect(skill, `${name} is not documented in the skill`).toContai…
       |                                                               ^
    571|     }
    572|   });

 Test Files  1 failed (1)
      Tests  1 failed | 21 passed (22)
   Duration  401ms
EXIT=1
```

**At the base (`07fdce05b`, separate worktree, same host, same node):**

```
 Test Files  1 passed (1)
      Tests  22 passed (22)
   Duration  2.14s
EXIT=0
```

Root cause, traced rather than guessed. Phase 2 commit `1a93c5ce3` ("Terminate and sweep Windows process
trees with creation-date identity checks") added a new public plugin-SDK export:

```
packages/plugin-sdk/src/host.ts:56: export type { ProcessWithCwd as ExperimentalProcessWithCwd } from "@bb/process-utils";
packages/plugin-api-map/src/surfaces.ts:800: "ExperimentalProcessWithCwd",
docs/api_to_audit.md:1168: `ExperimentalProcessWithCwd` (`@get-bb/plugin-sdk/host`, …
```

`git grep -l ExperimentalProcessWithCwd 07fdce05b` returns **nothing** — the symbol does not exist at the
base. It was added to `surfaces.ts` and to `docs/api_to_audit.md` but **not** to
`plugins/bb-guide/skills/bb-plugin-authoring/references/backend-api-index.md`, whose
`## @get-bb/plugin-sdk/host` section did gain the sibling function added by the same work
(`experimental_killProcessesWithCwdUnder`) but not the type:

```
- `experimental_killProcessesWithCwdUnder` — reap processes whose cwd is under a
  workspace a provider is tearing down, before removing the directory
…
- `ExperimentalHostWatchEvent`
- `ExperimentalHostWatchListener`
…                                    <-- `ExperimentalProcessWithCwd` belongs here
- `ExperimentalVendorPluginRootsArgs`
```

401 ms, deterministic, no load sensitivity, and it reproduces on Linux (`40-posix-check.md`). This is the
repo's own guard for the AGENTS.md rule *"New public plugin API members … require … an entry in
`docs/api_to_audit.md`"* and its companion *"The Plugin Guide is the only plugin API documentation"* —
working as designed and catching a real omission.

### 2. `apps/host-daemon/src/plugin-host-manager.test.ts` — Phase 2 regression, Windows only

```
 FAIL  |@bb/host-daemon| src/plugin-host-manager.test.ts > host plugin worker env > uses the login-shell PATH without forwarding daemon BB variables
AssertionError: expected { HOME: '/Users/test', …(2) } to deeply equal { HOME: '/Users/test', …(2) }

- Expected
+ Received

  {
    "GH_TOKEN": "user-token",
    "HOME": "/Users/test",
-   "PATH": "/Users/test/bin:/usr/bin",
+   "Path": "/Users/test/bin:/usr/bin",
  }

 ❯ src/plugin-host-manager.test.ts:644:7
```

**At the base:** `Test Files 1 passed (1)`, `Tests 19 passed (19)`, `EXIT=0`.
**On Linux at this head:** `Test Files 1 passed (1)`, `Tests 19 passed (19)`, `EXIT=0` (`40-posix-check.md`).

Root cause: neither `apps/host-daemon/src/plugin-host-manager.ts` nor its test changed in Phase 2
(`git log 07fdce05b..HEAD -- <both files>` is empty). What changed is the primitive they call —
`sanitizeInheritedChildProcessEnv` in `packages/process-utils/src/index.ts`:

```diff
 export function sanitizeInheritedChildProcessEnv(
   args: SanitizeInheritedChildProcessEnvArgs,
 ): NodeJS.ProcessEnv {
+  const platform = args.platform ?? process.platform;
+  const dropPathVariants = platform === "win32" && args.shellPath !== undefined;
…
   if (args.shellPath !== undefined) {
+    if (platform === "win32") {
+      sanitizedEnv.Path = args.shellPath;
+      return sanitizedEnv;
+    }
     sanitizedEnv.PATH = args.shellPath;
   }
```

The behaviour change is correct and correctly gated — `platform` defaults to `process.platform`, and the
POSIX arm is untouched, which is why Linux stays green. The defect is that the **test** calls
`sanitizeInheritedChildProcessEnv({ env: …, shellPath: "/Users/test/bin:/usr/bin" })` with no `platform`
argument and asserts `PATH`, so on a win32 host it takes the new win32 arm and fails. A one-line
`platform: "linux"` (or a win32 expectation) would settle it — **not done here**, per the gate's standing
instruction.

`@bb/local-open-targets` has a sibling case,
`builds a single Path key for the shell PATH on Windows`, which *does* pin the platform and passes — so the
pattern exists in the codebase and this one file simply missed it.

## Table 4: comparison against the baselines

Packages Phase 1 ran: compared against `qa/windows/phase-1/31-test-results.md` **gate refresh 3**
(`c3e4a8590`, 2026-09-14). Packages Phase 1 never ran: compared against a **fresh run at the branch base
`07fdce05b`**, since `qa/windows/phase-0/31-test-baseline.md` is a different commit under different load.

| package | Phase 1 refresh-3 | base `07fdce05b` | this head | newly failing file? |
|---|---|---|---|---|
| @bb/domain | pass | — | **pass** | no |
| @bb/host-daemon-contract | pass | — | **pass** | no |
| @bb/desktop-contract | pass | — | **pass** | no |
| @bb/server-contract | pass | — | **pass** | no |
| @bb/config | 1 file / 8 tests | — | **1 / 8** | no — identical |
| @bb/db | 1 under load, 34/34 alone | — | 1 under load (`migration-journal`, 5 s timeout) | no — same file, same reason |
| @bb/scripts | 5 alone (6 under load) | — | 6 in an 8-package batch | no — the 6th is `provider-literal-ratchet`, the documented under-load extra |
| @bb/server | **22** alone | — | **19** alone | **yes — 1** (`plugin-authoring-docs`) |
| @bb/host-daemon | **21** | — | **19** | **yes — 1** (`plugin-host-manager`) |
| @bb/app | 7 alone | — | **8 alone** | no — `useThreadStorageBrowser` flake, see below |
| @bb/desktop | 6 | 6 | **7** | no — `foreign-runtime` flake, see below |
| bb-plugin-environment-git-worktree | 1 file / 8 tests | — | **pass** | no — **fixed** |
| bb-plugin-environment-personal-workspace | 1 file / 1 test | — | **1 / 1** | no — same `host.test.ts` |
| @bb/process-utils | never run | 1 file / 1 test | **pass** | no — **fixed** |
| @bb/host-workspace | never run | **not measured** | 5 files / 26 tests | no evidence of one — see the caveat below |
| @bb/local-open-targets | never run | 1 file / **7** tests | 1 file / **6** tests | no — **improved** |
| @bb/secret-storage | never run | pass | **pass** | no |
| bb-environment-provider-host | never run | pass | **pass** | no |
| @bb/cli | never run | 7 files / 20 tests | **4 files / 11 tests** | no — **improved** |
| bb-plugin-automations | never run | 3 files / **9** tests | 3 files / **5** tests | no — **improved** |
| bb-plugin-github | never run | 2 files / 11 tests | **2 / 11, identical test names** | no |
| bb-plugin-provider-claude-code | never run | 2 files / 3 tests | **2 / 3, identical test names** | no |
| bb-app | never run | 3 files / 10 tests | **3 / 10, identical test names** | no |

### `@bb/server`: 22 → 19

`comm` of the refresh-3 solo list against this head's solo list:

**Four files fixed since refresh-3:**

```
test/services/plugins/builtin-plugins.test.ts
test/services/plugins/first-party-provider-plugins.test.ts
test/services/plugins/plugin-settings-storage.test.ts
test/services/threads/timeline-in-turn-window.test.ts
```

**One file newly failing:** `test/services/plugins/plugin-authoring-docs.test.ts` (the regression above).

22 − 4 + 1 = 19. **The lowest `@bb/server` count this port has measured** — the series under solo
conditions is 52 (Phase 0 full load) → 31 → 29 → 25 → 22 → **19**. The other eighteen are the documented
Windows baseline classes (fake-host RPC queue timeouts, `spawn sh`/`spawn npm` ENOENT, the
`git ls-remote` `C:` drive-letter-as-port bug).

### `@bb/host-daemon`: 21 → 19

**Three files fixed since refresh-3** — and one of them is a Phase 2 seam:

```
src/command-handlers/file-list.test.ts
src/environment-lifecycle-script.test.ts      <-- Phase 2's PowerShell hook work; now 9 passed / 7 skipped, EXIT=0
test/command/thread-stop-races.test.ts
```

**One file newly failing:** `src/plugin-host-manager.test.ts` (the regression above).
21 − 3 + 1 = 19.

`src/command-handlers/path-mutations.test.ts` — the junction file — is in **neither** failing list, at either
commit (`23-junctions.md`).

### `@bb/app`: 7 → 8, and `@bb/desktop`: 6 → 7 — both flakes, both in untouched packages

`git diff --name-only 07fdce05b..HEAD` touches **no file under `apps/app` or `apps/desktop`**. Neither
package can have regressed from this branch's code.

`@bb/app` solo failing files — refresh-3's seven plus one:

```
src/components/plugin/management/BrowsePluginsTab.test.tsx
src/components/plugin/management/UpdatePluginDialog.test.tsx
src/components/secondary-panel/FilePreview.test.tsx
src/components/secondary-panel/useThreadStorageBrowser.test.tsx      <-- the extra
src/components/settings/UsageLimitsSettingsSection.test.tsx
src/components/settings/browser-import-wizard.test.ts
src/components/thread/WorkspaceChangesList.test.tsx
src/hooks/cache-owners/cache-owner-registry.test.ts
```

`useThreadStorageBrowser.test.tsx` fails on `AssertionError: expected null not to be null` inside a DOM
query — the expiring-`findBy*` class. It is in Phase 1 refresh-2's nine and in the Phase 0 baseline's ten;
refresh-3 happened to catch it green. Reason histogram for the solo run is the two documented classes only:

```
      4 Error: ENOENT: no such file or directory, scandir 'C:\C:\Users\olege\Work\bb\apps\app\src'
      7 TestingLibraryElementError: Unable to find …
      3 AssertionError: …
```

The `C:\C:\…` doubled-drive `scandir` is the pre-existing Windows-baseline defect in the import-wizard and
cache-owner fixtures.

`@bb/desktop` — base's six plus `test/foreign-runtime.test.ts`:

```
FAIL  test/foreign-runtime.test.ts > stopForeignRuntime > escalates to SIGKILL when the process outlives SIGTERM
AssertionError: expected { kind: 'still-running', pid: 4242 } to deeply equal { kind: 'stopped' }
 ❯ test/foreign-runtime.test.ts:201:6
    199|         timeoutMs: 1_000,
```

A 1000 ms escalation budget. `test/bb-process.test.ts > escalates to SIGKILL when the bridge ignores
SIGTERM` — the same class — fails at **both** the base and this head; `foreign-runtime` is its twin and
lost the race once. Every other `@bb/desktop` failing test name is character-identical between base and
head.

### `@bb/host-workspace` (5 files / 26 tests alone)

Phase 1 never ran it; Phase 0's full-load baseline was 4 files / 22 tests at a different commit. Failing
files here: `test/workspace-diff.test.ts`, `test/workspace.test.ts`, `test/git-host-upstream.test.ts`,
`test/git-host.test.ts`, `test/git.test.ts`. The reason histogram is entirely POSIX-ism and
environment classes, with **no** Path/PATH or separator assertion among them:

```
     19 Error: Test timed out in Nms.                      (under load; 26 tests at solo)
      5 AssertionError: expected "vi.fn()" to be called with arguments: [ 'gh', …(N) ]
      3 WorkspaceError: git hash-object -t tree \\.\nul failed: fatal: could not open '\\.\nul'
      1 Error: spawn /bin/sh ENOENT
      1 Error: spawn which ENOENT
      1 Error: spawn git ENOENT                            (a fixture fake `git` with no .exe extension)
      … Error: EBUSY: resource busy or locked, rmdir 'C:\…\bb-workspace-repo-…'
```

`gh` is not installed on this desktop, `/bin/sh` does not exist, `\\.\nul` is the POSIX `/dev/null`
spelling, and `EBUSY` on temp-directory teardown is the standing Windows class. `@bb/host-workspace` passed
in WSL at both controller POSIX runs (`40-posix-check.md`), which is the cross-check that these are
environment, not logic.

**Caveat, stated rather than papered over:** `@bb/host-workspace` is the one package in the filter list for
which **no base measurement was taken** — it was not in the base worktree's batch, and Phase 1 never ran it,
so there is no per-file baseline to diff against. The "no newly failing file" entry for it rests on three
indirect arguments, not a direct comparison: (a) every failing reason is an environment class listed above,
none of them a path, separator or `Path`/`PATH` assertion; (b) the package passes in WSL at this head; and
(c) Phase 2's `packages/host-workspace/src/git.ts` changes are win32-gated arms. If the user wants this
tightened, the direct check is `pnpm exec turbo run test --filter=@bb/host-workspace --force` in a worktree
at `07fdce05b` and a `comm` of the two failing-test lists.

### Phase-2 seam packages: every `it.runIf(win32)` case added in Tasks 1–13 passes

| seam | case | result |
|---|---|---|
| `@bb/process-utils` | `kills the grandchild and reports it` | ✓ 6658ms |
| `@bb/process-utils` | `skips a descendant whose recorded CreationDate no longer matches` | ✓ 6434ms |
| `@bb/process-utils` | `leaves unrelated processes alive while PIDs are recycled under a tree kill` | ✓ 7912ms (`21-pid-reuse-stress.md`) |
| `@bb/process-utils` | `documents an under-match and an over-match` | ✓ 1683ms (`26-process-enumeration.md`) |
| `@bb/host-daemon` | `streams PowerShell hook output` | ✓ 427ms |
| `@bb/host-daemon` | `times out a sleeping PowerShell hook` | ✓ 4491ms |
| `@bb/host-daemon` | `reports the exit code of a failing PowerShell hook` | ✓ 351ms |
| `@bb/host-daemon` | `cancels a PowerShell hook and leaves no descendant` | ✓ 5224ms (`20-hook-stream-timeout-cancel.md`) |
| `@bb/host-daemon` | the three `junctions` cases | ✓ (`23-junctions.md`) |
| `@bb/secret-storage` | all seven `secret files on real NTFS` cases | ✓ (`22-secret-acl.md`) |
| `bb-plugin-automations` | `leaves no descendant when a .ps1 script times out` | ✓ 13832ms |
| `bb-plugin-automations` | `runs a stored .ps1 script through PowerShell` | ✓ 416ms |
| `bb-plugin-provider-claude-code` | `links the skills directory as a junction on Windows` | ✓ 27ms |
| `@bb/local-open-targets` | `lists the real open targets of this desktop` | ✓ 718ms (solo; times out under 23-package load) |
| `@bb/local-open-targets` | `leaves a live interactive console behind for the terminal fallback` (`BB_QA_REAL_LAUNCH=1`) | ✓ at `--testTimeout=30000`; **✗ on vitest's default 5 s** — see `24-open-targets.md` |

The last row is the one qualification: that gated case cannot fit its own fixed waits (2000 ms + 700 ms plus
two ~640 ms CIM snapshots) into the default 5000 ms budget and declares no timeout of its own. The launcher
behaviour it checks is correct; the case's budget is not. Recorded, not fixed.

### Load-sensitivity notes worth keeping

- `@bb/process-utils`'s PID-reuse case **failed under 23-package load** on its own 180 s timeout
  (`Error: Test timed out in 180000ms`, file duration 222,167 ms) and passes in **7.9 s** solo. 300
  `cmd.exe` creations plus CIM enumeration cannot get scheduled against thirteen competing vitest pools.
- `@bb/local-open-targets` showed **7** failing tests under load and **6** solo; the seventh was
  `lists the real open targets of this desktop` timing out at 5 s. The six are the macOS terminal
  `cd`-quoting assertions — the exact six of the Phase 0 baseline, and one fewer than the base's seven
  (`uses bundled macOS editor CLIs when shell commands are unavailable` now passes).
- `@bb/cli` showed **10** failing files under load, **7** at the base in an 8-package batch, and **4** at
  this head in the same 8-package batch: `command-output/browser`, `command-output/marketplace`,
  `command-output/plugin-catalog`, `plugin-new`. The base's `bin.test.ts`, `startup-graph.test.ts` and
  `plugin-build.test.ts` all pass now.

## Step 3 verdict

**FAIL**, on the brief's own criterion — *"no test file that passed at Phase 1 refresh-3 fails now"*. Two
do, both traced to Phase 2 changes, both reproduced deterministically at this head and shown green at
`07fdce05b`.

Everything else in this step is at or better than both baselines: `@bb/server` at its lowest ever (19),
`@bb/host-daemon` at 19 with the lifecycle-hook file **fixed**, `bb-plugin-environment-git-worktree` and
`@bb/process-utils` moved from failing to passing, `@bb/cli`, `bb-plugin-automations` and
`@bb/local-open-targets` all improved against the base, the six pure packages still passing, and every
win32-only case the phase added passing on this host bar one test-budget defect.

---

# Gate run 2 — at `3e077adff` (2026-09-15)

**Commit:** `3e077adff799c5e54663bc1a9af0b51d2a97c51e` (`windows-native/phase-2`), i.e. the run-1 evidence
commit `8996c0a70` plus the three fix commits `9e63ded65`, `40c58854a`, `3e077adff`.
**Node:** v22.19.0 · **pnpm:** 9.15.0 · **pwsh:** 7.6.6 · **OS:** Windows 11 Pro 10.0.26200 — same host.

> ## Verdict: **PASS**
>
> Both files that failed in run 1 pass here. No test file moved from pass to fail for a code reason.
>
> Two files appear in the run-2 isolation lists that were not in run 1's — `builtin-plugins.test.ts`
> (`@bb/server`) and `command-handlers/file-list.test.ts` (`@bb/host-daemon`). Both are **timeouts**, both
> were **already failing at the Phase 1 refresh-3 baseline** (run 1 lists them among the files that had
> flipped green), and both **pass twice in isolation** at this head. They are the same flake class run 1
> documented for `@bb/app` and `@bb/desktop`, not a new state.

## The two previously failing files

### 1. `apps/server/test/services/plugins/plugin-authoring-docs.test.ts` — fixed by `9e63ded65`

```powershell
pnpm --filter @bb/server exec vitest run test/services/plugins/plugin-authoring-docs.test.ts
```
```
 RUN  v4.1.1 C:/Users/olege/Work/bb/apps/server

 Test Files  1 passed (1)
      Tests  22 passed (22)
   Start at  09:32:33
   Duration  425ms (transform 69ms, setup 0ms, import 145ms, tests 60ms, environment 0ms)
EXIT=0
```

Run 1: `1 failed`, `1 failed | 21 passed (22)`, EXIT=1. The missing index entry
(`ExperimentalProcessWithCwd` in `plugins/bb-guide/skills/bb-plugin-authoring/references/backend-api-index.md`)
is present at this head.

### 2. `apps/host-daemon/src/plugin-host-manager.test.ts` — fixed by `40c58854a`

```powershell
pnpm --filter @bb/host-daemon exec vitest run src/plugin-host-manager.test.ts --reporter=verbose
```
```
 ✓ … > host plugin worker env > uses the login-shell PATH without forwarding daemon BB variables 0ms
 ✓ … > host plugin worker env > builds a single Path key for the login-shell PATH on Windows 0ms

 Test Files  1 passed (1)
      Tests  20 passed (20)
   Duration  7.05s (transform 756ms, setup 0ms, import 2.20s, tests 4.63s, environment 0ms)
EXIT=0
```

19 → **20** tests: the POSIX case is now pinned to a platform and a win32 `Path` case was added beside it,
which is the pattern `@bb/local-open-targets` already used. All 20 pass on this host; the file also passes
on Linux (see `40-posix-check.md`, gate run 2).

## Full-load run 2

Same 23-package filter list, verified again in the header line
(`• Running test in 23 packages`), so no package was silently skipped.

```
  Tasks:    17 successful, 31 total
 Cached:    15 cached, 31 total
   Time:    29m34.486s
Summary:    C:\Users\olege\Work\bb\.turbo\runs\3JM0hK81CoEuD2ZWRV2xTYn9sC3.json
 Failed:    @bb/app#test, @bb/cli#test, @bb/config#test, @bb/desktop#test, @bb/host-daemon#test, @bb/host-workspace#test, @bb/local-open-targets#test, @bb/scripts#test, @bb/server#test, bb-app#test, bb-plugin-automations#test, bb-plugin-environment-personal-workspace#test, bb-plugin-github#test, bb-plugin-provider-claude-code#test

 ERROR  run failed: command  exited (1)
EXIT=1
```

Run 1 failed 16 packages; run 2 fails 14. The two that dropped out are `@bb/db` and `@bb/process-utils`,
both of which were **cache hits** this time (15 cached vs run 1's 7) because run 1's isolation re-runs had
already recorded them green. That is a cache effect, not a measurement: both are recorded as passing solo in
run 1's Table 3/Table 4 and neither is re-measured under load here. Stated rather than counted as an
improvement.

### Table 1 (run 2): pass/fail per package (summariser output)

```powershell
node qa/windows/scripts/summarize-turbo-run.mjs; "EXIT=$LASTEXITCODE"
```

| package | run 1 | run 2 |
|---|---|---|
| @bb/app | fail (1) | fail (1) |
| @bb/cli | fail (1) | fail (1) |
| @bb/config | fail (1) | fail (1) |
| @bb/db | fail (1) | **pass** (cache hit) |
| @bb/desktop | fail (1) | fail (1) |
| @bb/desktop-contract | pass | pass |
| @bb/domain | pass | pass |
| @bb/host-daemon | fail (1) | fail (1) |
| @bb/host-daemon-contract | pass | pass |
| @bb/host-workspace | fail (1) | fail (1) |
| @bb/local-open-targets | fail (1) | fail (1) |
| @bb/process-utils | fail (1) | **pass** (cache hit) |
| @bb/scripts | fail (1) | fail (1) |
| @bb/secret-storage | pass | pass |
| @bb/server | fail (1) | fail (1) |
| @bb/server-contract | pass | pass |
| bb-app | fail (1) | fail (1) |
| bb-environment-provider-host | pass | pass |
| bb-plugin-automations | fail (1) | fail (1) |
| bb-plugin-environment-git-worktree | pass | pass |
| bb-plugin-environment-personal-workspace | fail (1) | fail (1) |
| bb-plugin-github | fail (1) | fail (1) |
| bb-plugin-provider-claude-code | fail (1) | fail (1) |

Source: `C:\Users\olege\Work\bb\.turbo\runs\3JM0hK81CoEuD2ZWRV2xTYn9sC3.json`
EXIT=0 (summariser)

**No package moved from pass to fail.** The six pure packages the brief requires to still pass all pass.

### Table 2 (run 2): vitest summaries, full-load run

| package | files run 1 | files run 2 | tests run 1 | tests run 2 |
|---|---|---|---|---|
| @bb/app | 10 / 497 (507) | **9** / 498 (507) | 17 / 4333 / 3 | 15 / 4335 / 3 |
| @bb/cli | 10 / 45 / 1 (56) | **8** / 47 / 1 (56) | 20 / 556 / 10 | 19 / 557 / 10 |
| @bb/config | 1 / 6 (7) | 1 / 6 (7) | 8 / 108 | 8 / 108 |
| @bb/db | 1 / 33 (34) | cache hit | 1 / 496 | — |
| @bb/desktop | 8 / 35 (43) | **7** / 36 (43) | 16 / 310 / 1 | 15 / 311 / 1 |
| @bb/host-daemon | 21 / 31 / 1 (53) | **20** / 32 / 1 (53) | 60 / 577 / 8 | 60 / 578 / 8 |
| @bb/host-workspace | 6 / 2 (8) | **5** / 3 (8) | 37 / 136 / 4 | 25 / 148 / 4 |
| @bb/local-open-targets | 1 / 0 (1) | 1 / 0 (1) | 7 / 77 / 1 (85) | 7 / 80 / 1 (**88**) |
| @bb/process-utils | 1 / 4 / 1 (6) | cache hit | 1 / 90 / 12 | — |
| @bb/scripts | 5 / 21 (26) | 5 / 21 (26) | 10 / 156 / 2 | 10 / 156 / 2 |
| @bb/server | 44 / 194 / 2 (240) | **39** / 199 / 2 (240) | 197 / 2253 / 6 | 182 / 2268 / 6 |
| bb-app | 3 / 2 (5) | 3 / 2 (5) | 10 / 72 | 10 / 72 |
| bb-plugin-automations | 3 / 5 (8) | 3 / 4 (**7**) | 6 / 90 | 6 / 88 |
| bb-plugin-environment-personal-workspace | 1 / 2 (3) | 1 / 2 (3) | 1 / 13 / 1 | 1 / 13 / 1 |
| bb-plugin-github | 2 / 6 (8) | 2 / 4 (**6**) | 11 / 37 | 11 / 31 |
| bb-plugin-provider-claude-code | 2 / 23 (25) | 2 / 23 (25) | 3 / 347 / 1 | 3 / 347 / 1 |

Two reading notes, both about the *denominator* rather than the failures:

- `bb-plugin-automations` (8 → 7 files) and `bb-plugin-github` (8 → 6) ran **fewer files** than in run 1.
  Files that never start a worker are the fork-pool starvation this document opens with; the failing counts
  did not rise. Their authoritative numbers stay run 1's isolation figures.
- `@bb/local-open-targets` grew from 85 to **88** tests: `40c58854a` added three win32 cases to
  `test/workspace-open-targets.test.ts`. The failing count is unchanged at 7 under load (6 solo, below).

### Method note: a 24-minute stall in `@bb/scripts`, and what caused it

Run 2's wall time is 29m34s against run 1's 7m58s. Almost all of the difference is one stalled package, and
the cause is environmental and worth recording because it can bite any Windows run of this suite:

`@bb/scripts` sat with a **0-byte** `packages/scripts/.turbo/turbo-test.log` for 24 minutes, its vitest main
process at 9.06 s of total CPU (i.e. idle). The stuck frame was a single grandchild:

```
vitest worker 32492
└─ bash.exe 7868   bash -c "gh() { printf '%s\n' \"$*\"; } … gh pr comment … gh pr close …"
   └─ wsl.exe 18792
```

A `@bb/scripts` test shells out to `bash -c "<workflow script>"`. On this desktop bare `bash` resolves to
`C:\Windows\System32\bash.exe`, which is the **WSL** launcher — and WSL was in a failed state at the time
(`wsl.exe --list` → `Wsl/Service/E_UNEXPECTED`, a boot failure), so the call blocked forever instead of
erroring. The tree was killed at its root (`taskkill /PID 7868 /T /F`, 4 processes terminated), after which
`@bb/scripts` completed normally and reported numbers **identical to run 1**:

```
@bb/scripts:test:  Test Files  5 failed | 21 passed (26)
@bb/scripts:test:       Tests  10 failed | 156 passed | 2 skipped (168)
```

WSL was separately recovered with `wsl.exe --shutdown` before Step 11 (see `40-posix-check.md`). This is a
host-environment condition, not a property of the branch: no Phase 2 commit touches `packages/scripts`, and
the same test file produced the same result once the hung `bash`/`wsl.exe` pair was cleared.

## Table 3 (run 2): isolation re-runs (authoritative)

```powershell
pnpm exec turbo run test --filter=@bb/server --force
pnpm exec turbo run test --filter=@bb/host-daemon --force
pnpm exec turbo run test --filter=@bb/local-open-targets --force
```

| run | run 1 | run 2 |
|---|---|---|
| `@bb/server` alone | 19 failed / 219 / 2 (240); 133 / 2317 / 6; 2m55.027s | **19 failed** / 219 / 2 (240); **130** / 2320 / 6; 3m11.321s |
| `@bb/host-daemon` alone | 19 failed / 33 / 1 (53); 54 / 583 / 8; 1m40.953s | **19 failed** / 33 / 1 (53); 54 / 584 / 8; 1m57.629s |
| `@bb/local-open-targets` alone | 1 file / 6 tests | **1 file / 6 tests** (6 / 81 / 1 of 88) |

`@bb/local-open-targets`' six are the same six macOS terminal `cd`-quoting assertions as run 1, verbatim:

```
opens local directories in Terminal with a short cd command
opens local directories in iTerm2 with a short cd command
opens local files in Terminal with a resolved terminal editor command
opens local files in iTerm2 with a resolved terminal editor command
inserts terminal editor location args before explicit editor args separator
opens local files in Terminal at the containing directory when no terminal editor is available
```

The three cases `40c58854a` added all pass, so the package absorbed +3 tests without adding a failure.

### Composition diff — the point of this run

The two counts stayed at 19, so the interesting fact is *which* files, not how many.

**`@bb/server`, 19 → 19:**

```
- test/services/plugins/plugin-authoring-docs.test.ts     (run 1 fail → run 2 PASS, the fix)
+ test/services/plugins/builtin-plugins.test.ts           (run 1 pass → run 2 fail)
```

**`@bb/host-daemon`, 19 → 19:**

```
- src/plugin-host-manager.test.ts                         (run 1 fail → run 2 PASS, the fix)
+ src/command-handlers/file-list.test.ts                  (run 1 pass → run 2 fail)
```

Every other file in both lists is character-identical between run 1 and run 2.

### The two files that flipped the other way are flakes, and the reruns say so

Neither is a Phase 2 regression, on three independent grounds: both were **already failing at Phase 1
refresh-3** (run 1's own text lists `builtin-plugins.test.ts` among `@bb/server`'s "four files fixed since
refresh-3" and `file-list.test.ts` among `@bb/host-daemon`'s "three files fixed since refresh-3"); both fail
on a **timeout**, not an assertion about behaviour; and both **pass twice in isolation** here.

`@bb/server` — `test/services/plugins/builtin-plugins.test.ts`:

```
FAIL  |@bb/server:isolated| … > builtin plugin reconciliation > installs and loads a packaged builtin whose source files are omitted
Error: Test timed out in 5000ms.
FAIL  … (same test)
Error: ENOTEMPTY: directory not empty, rmdir 'C:\Users\olege\AppData\Local\Temp\bb-builtin-plugins-IaMH7B\builtin-plugins'
```

`@bb/host-daemon` — `src/command-handlers/file-list.test.ts`:

```
FAIL  |@bb/host-daemon| … > listPathsRecursively > does not overflow the call stack merging a large subdirectory
Error: Test timed out in 60000ms.
```

Isolation re-runs, twice each:

```powershell
pnpm --filter @bb/server exec vitest run test/services/plugins/builtin-plugins.test.ts        # x2
pnpm --filter @bb/host-daemon exec vitest run src/command-handlers/file-list.test.ts          # x2
```
```
 Test Files  1 passed (1)   Tests  31 passed (31)   Duration  27.24s   BP1_EXIT=0
 Test Files  1 passed (1)   Tests  31 passed (31)   Duration  26.63s   BP2_EXIT=0
 Test Files  1 passed (1)   Tests  17 passed (17)   Duration  57.42s   FL1_EXIT=0
 Test Files  1 passed (1)   Tests  17 passed (17)   Duration  58.54s   FL2_EXIT=0
```

`file-list.test.ts` is the clearer of the two: it needs **55.6–56.8 s of test time against its own 60 s
timeout** even with nothing else running. A margin that thin fails whenever the disk is busy — which is
exactly the condition a 53-file package run creates. `ENOTEMPTY` on `rmdir` of a temp directory is the
standing Windows teardown class already documented for `@bb/host-workspace`.

## Step 3 run-2 verdict

**PASS.** The two run-1 regressions are gone, measured directly and at their own file. Against the run-1
table no package moved from pass to fail, no failing count rose, `@bb/server` (44 → 39 under load),
`@bb/cli`, `@bb/desktop`, `@bb/app` and `@bb/host-workspace` all improved under load, and the only two
files that changed state in the other direction are pre-existing timeout flakes that pass twice in
isolation. The `@bb/scripts` stall was a WSL-in-a-failed-state condition on the host, cleared and recorded,
after which that package reported run 1's numbers exactly.
