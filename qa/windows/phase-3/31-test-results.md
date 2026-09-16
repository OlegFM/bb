# Tests on the reference Windows desktop (Phase 3 gate, Step 3)

**Code head measured:** `c3a02ba154ace7cda222ba7e022febd7dc6066a9` (full run) — the gate's later commits
(`fd84ca436`, `e5d59dc7e`, `72605c433`) touch one test file, one QA script and one workflow file; each was
verified in isolation and none of them can move another package's numbers.
**Node:** v22.19.0 · **pnpm:** 9.15.0 · **pwsh:** 7.6.6 · **OS:** Windows 11 Pro 10.0.26200 (`00-host.md`)
**Baseline:** `9a07e6994` (Phase 2 tip), in a **separate worktree** at `C:\Users\olege\Work\bb-p2-base`
(`git worktree add`, `pnpm install --offline`, `turbo run build`), never in the main checkout. Removed at
Step 13.

> ## Gate verdict: **PASS**
>
> Steps 2–12 all hold.
>
> | step | evidence | result |
> |---|---|---|
> | 2 build + typecheck | `30-build-typecheck.txt` | **144 successful, 144 total**, `EXIT=0` |
> | 3 tests | this file | 33 failing packages at head, 33 at the baseline; **one** newly-failing test file, fixed |
> | 4 terminal | `20-terminal-ctrl-c-resize-utf8.md` | Ctrl+C then prompt in **804 ms**; UTF-8 and resize verified |
> | 5 Codex turn | `21-codex-turn-on-c.md` | real turn wrote the file; `git diff` shows it |
> | 6 Claude Code turn | `22-claude-code-turn-on-c.md` | real turn wrote the file; **R14 contingency not needed** |
> | 7 watcher | `23-watcher-ntfs.md` | create seen in 683 ms, case-only rename in 644 ms |
> | 8 `npx bb-app` | `24-npx-bb-app-clean-shell.md` | smoke `48/48`, `EXIT=0`; clean-shell run gives HTTP 200; stop `EXIT=0` |
> | 9 ConPTY smoke | `25-conpty-smoke.md` | **6/6 three times**, `EXIT=0` each |
> | 10 provider installation | `26-provider-installation.md` | statuses and reasons measured; the one failure is upstream, proved outside bb |
> | 11 POSIX | `40-posix-check.md` | typecheck 94/94; **no POSIX failure absent at `9a07e6994`** |
> | 12 CI | `41-ci-run.md` | `Windows x64` **success** at run **35036927190** |
>
> Four fix commits were made during the gate; each is described where it was found
> (`41-ci-run.md` for 1, 3 and 4, this file for 2, `24-npx-bb-app-clean-shell.md` for 3's second half).
>
> | commit | what | why it cannot move POSIX |
> |---|---|---|
> | `c3a02ba15` | Codex bridge keeps the install guidance when Windows cannot find the CLI | inside the existing `platform !== "win32"` early-return guard |
> | `fd84ca436` | `apps/host-daemon/src/app.test.ts` expects the host's provider PATH key | **test file only**, no product code |
> | `e5d59dc7e` | tarball smoke: retry the temp-root delete, print launcher logs on failure | `rm` retries fire only on `EBUSY`/`ENOTEMPTY`/`EPERM`/`EMFILE`/`ENFILE`; the diagnostics run only on an already-failing path |
> | `72605c433` | workspace-local temp root for the `windows-x64` tarball smoke step | **CI wiring**, inside the `windows-x64` job only |

## Method

This gate ran the **whole** monorepo (`turbo run test`, 91 test tasks), not Phase 2's 23-package filter
list, and ran it **twice** — once at this head and once at `9a07e6994` in the base worktree, back to back
on an otherwise idle desktop. Phase 1 and Phase 2 both established that full-load Turbo runs on this machine
inflate failure counts through vitest fork-pool starvation, so:

1. the two full runs give the per-package table and the *candidate* set of changes;
2. every test file that fails at this head and **not** at the baseline is re-run **in isolation**, and those
   numbers are authoritative;
3. anything still failing in isolation is then run at the baseline, in isolation, before it is called a
   regression.

Running the baseline as a fresh full run — rather than comparing against
`qa/windows/phase-2/31-test-results.md` — is what makes the delta meaningful: this run's scope includes some
60 packages Phase 2 never measured, under a heavier load than Phase 2's filter list, so its raw numbers are
not comparable to Phase 2's by construction. Phase 2's own table is compared separately at the end.

## The two full runs

```bash
pnpm exec turbo run test --continue --summarize --output-logs=new-only > <scratch>/31-full.log 2>&1
```

| | head `c3a02ba15` | base `9a07e6994` |
|---|---|---|
| started | 2026-09-16T01:39:17+03:00 | 2026-09-16T01:55:13+03:00 |
| tasks | **58 successful, 91 total** | **58 successful, 91 total** |
| cached | 7 | 16 |
| wall time | **14m35.065s** | 14m13.869s |
| failing packages | **33** | **33** |
| failing test files | **217** | **252** |
| exit | `TEST_EXIT=1` | `BASE_TEST_EXIT=1` |

Run summaries: `C:\Users\olege\Work\bb\.turbo\runs\3JNsPB9arGQvb0BlvZ9kY1e99zk.json` (head) and
`C:\Users\olege\Work\bb-p2-base\.turbo\runs\3JNuIjY1FxVTgmokpWEfHwPM4IG.json` (base). Neither JSON was
copied into the repository. The head run's log was 29 696 lines; its last 200 lines are
`31-test-output-tail.txt` and the full file was deleted, as in every earlier round.

**35 fewer failing test files at this head than at the baseline**, under the same load on the same machine.

## Table 1 — per package, baseline vs head

`pass` / `fail (n)` comes from `node qa/windows/scripts/summarize-turbo-run.mjs` over each run's summary
JSON (`EXIT=0` both times). The vitest columns are the file counts each package printed; where a package's
task was a Turbo **cache hit** its logs are suppressed by `--output-logs=new-only`, which is noted rather
than guessed at — its pass/fail is still authoritative from the summary JSON.

| package | base task | head task | base test files | head test files |
|---|---|---|---|---|
| @bb/agent-runtime | fail (1) | fail (1) | 11 failed · 11 passed (22) | 15 failed · 7 passed (22) |
| @bb/app | fail (1) | fail (1) | 12 failed · 495 passed (507) | 15 failed · 492 passed (507) |
| @bb/cli | fail (1) | fail (1) | 7 failed · 48 passed · 1 skipped (56) | 12 failed · 43 passed · 1 skipped (56) |
| @bb/client-core | pass | pass | 21 passed (21) | 21 passed (21) |
| @bb/config | fail (1) | fail (1) | 1 failed · 6 passed (7) | 1 failed · 6 passed (7) |
| @bb/connect | pass | pass | 6 passed (6) | 6 passed (6) |
| @bb/connect-client | pass | pass | 1 passed (1) | 1 passed (1) |
| @bb/connect-db | pass | pass | 2 passed (2) | 2 passed (2) |
| @bb/core-ui | pass | pass | 4 passed (4) | 4 passed (4) |
| @bb/db | pass | pass | cached, logs suppressed | 34 passed (34) |
| @bb/demo-server | pass | pass | 1 passed (1) | 1 passed (1) |
| @bb/desktop | fail (1) | fail (1) | 6 failed · 37 passed (43) | 6 failed · 37 passed (43) |
| @bb/desktop-contract | pass | pass | cached, logs suppressed | 3 passed (3) |
| @bb/domain | pass | pass | cached, logs suppressed | 34 passed (34) |
| @bb/fuzzy-match | pass | pass | 1 passed (1) | 1 passed (1) |
| @bb/hono-typed-routes | pass | pass | 1 passed (1) | 1 passed (1) |
| @bb/host-daemon | fail (1) | fail (1) | 19 failed · 33 passed · 1 skipped (53) | 19 failed · 35 passed · 1 skipped (55) |
| @bb/host-daemon-contract | pass | pass | cached, logs suppressed | 4 passed (4) |
| @bb/host-watcher | fail (1) | pass **improved** | 2 failed · 4 passed · 1 skipped (7) | 9 passed · 1 skipped (10) |
| @bb/host-workspace | fail (1) | fail (1) | 5 failed · 3 passed (8) | 5 failed · 3 passed (8) |
| @bb/integration-tests | fail (1) | fail (1) | 22 failed · 7 passed (29) | 24 failed · 5 passed (29) |
| @bb/local-open-targets | fail (1) | fail (1) | 1 failed (1) | 1 failed (1) |
| @bb/logger | fail (1) | fail (1) | 1 failed (1) | 1 failed (1) |
| @bb/mobile | fail (1) | fail (1) | 1 failed · 45 passed (46) | 1 failed · 45 passed (46) |
| @bb/mobile-bridge | pass | pass | 3 passed (3) | 3 passed (3) |
| @bb/plugin-api-map | pass | pass | 10 passed (10) | 10 passed (10) |
| @bb/plugin-build | fail (1) | fail (1) | 4 failed · 6 passed (10) | 4 failed · 6 passed (10) |
| @bb/plugin-interaction-contracts | pass | pass | 1 passed (1) | 1 passed (1) |
| @bb/plugin-registry | pass | fail (1) **NEW** | 1 passed (1) | 1 failed (1) |
| @bb/process-utils | pass | pass | cached, logs suppressed | 5 passed · 1 skipped (6) |
| @bb/provider-bridge-acp | fail (1) | fail (1) | 10 failed · 8 passed (18) | 9 failed · 11 passed (20) |
| @bb/provider-bridge-protocol | fail (1) | fail (1) | 1 failed · 19 passed (20) | 2 failed · 18 passed (20) |
| @bb/provider-parity | fail (1) | fail (1) | 1 failed (1) | 1 failed (1) |
| @bb/qa | fail (1) | fail (1) | 2 failed · 1 passed (3) | 2 failed · 1 passed (3) |
| @bb/scripts | fail (1) | fail (1) | 6 failed · 20 passed (26) | 4 failed · 22 passed (26) |
| @bb/sdk | pass | pass | 7 passed (7) | 7 passed (7) |
| @bb/secret-storage | pass | pass | cached, logs suppressed | 5 passed (5) |
| @bb/server | fail (1) | fail (1) | 86 failed · 152 passed · 2 skipped (240) | 43 failed · 195 passed · 2 skipped (240) |
| @bb/server-contract | pass | pass | cached, logs suppressed | 7 passed (7) |
| @bb/templates | fail (1) | fail (1) | 2 failed · 5 passed (7) | 1 failed · 6 passed (7) |
| @bb/thread-view | pass | pass | 24 passed (24) | 24 passed (24) |
| @bb/tunnel-client | pass | pass | 2 passed (2) | 2 passed (2) |
| @bb/tunnel-contract | pass | pass | 1 passed (1) | 1 passed (1) |
| @bb/web | pass | pass | 23 passed (23) | 23 passed (23) |
| @get-bb/plugin-sdk | fail (1) | fail (1) | 1 failed · 22 passed (23) | 1 failed · 22 passed (23) |
| bb-app | fail (1) | fail (1) | 3 failed · 2 passed (5) | 2 failed · 4 passed (6) |
| bb-environment-provider-host | pass | pass | cached, logs suppressed | 1 passed (1) |
| bb-plugin-account-pool | fail (1) | fail (1) | 1 failed · 9 passed (10) | 1 failed · 9 passed (10) |
| bb-plugin-ask-user-question | pass | pass | 3 passed (3) | 3 passed (3) |
| bb-plugin-automations | fail (1) | fail (1) | 3 failed · 5 passed (8) | 3 failed · 5 passed (8) |
| bb-plugin-bb-guide | pass | pass | 1 passed (1) | 1 passed (1) |
| bb-plugin-browser-automation | fail (1) | fail (1) | 3 failed · 3 passed (6) | 3 failed · 3 passed (6) |
| bb-plugin-concurrency-limit | pass | pass | 4 passed (4) | 4 passed (4) |
| bb-plugin-connect | pass | pass | 4 passed (4) | 4 passed (4) |
| bb-plugin-custom-instructions | pass | pass | 1 passed (1) | 1 passed (1) |
| bb-plugin-echo-provider | fail (1) | fail (1) | 2 failed · 4 passed (6) | 2 failed · 4 passed (6) |
| bb-plugin-environment-git-worktree | pass | pass | cached, logs suppressed | 5 passed (5) |
| bb-plugin-environment-personal-workspace | fail (1) | fail (1) | 1 failed · 2 passed (3) | 1 failed · 3 passed (4) |
| bb-plugin-environment-project-checkout | pass | pass | 3 passed (3) | 3 passed (3) |
| bb-plugin-github | fail (1) | fail (1) | 2 failed · 6 passed (8) | 2 failed · 6 passed (8) |
| bb-plugin-inline-vis | pass | pass | 2 passed (2) | 2 passed (2) |
| bb-plugin-keep-awake | pass | pass | 3 passed (3) | 3 passed (3) |
| bb-plugin-memory | pass | pass | 2 passed (2) | 2 passed (2) |
| bb-plugin-monaco-editor | pass | pass | 4 passed (4) | 4 passed (4) |
| bb-plugin-pdf-preview | pass | pass | 2 passed (2) | 2 passed (2) |
| bb-plugin-plugin-api-tester | pass | pass | 1 passed (1) | 1 passed (1) |
| bb-plugin-provider-acp | pass | pass | 8 passed (8) | 8 passed (8) |
| bb-plugin-provider-claude-code | fail (1) | fail (1) | 2 failed · 23 passed (25) | 2 failed · 25 passed (27) |
| bb-plugin-provider-codex | fail (1) | fail (1) | 6 failed · 21 passed (27) | 7 failed · 21 passed (28) |
| bb-plugin-provider-pi | fail (1) | fail (1) | 16 failed · 11 passed (27) | 15 failed · 15 passed · 1 skipped (31) |
| bb-plugin-provider-retry | pass | pass | 1 passed (1) | 1 passed (1) |
| bb-plugin-provider-usage | pass | pass | 3 passed (3) | 3 passed (3) |
| bb-plugin-push-notifications | pass | pass | 4 passed (4) | 4 passed (4) |
| bb-plugin-scheduled-send | pass | pass | 2 passed (2) | 2 passed (2) |
| bb-plugin-scripted-echo-provider | pass | pass | 1 passed (1) | 1 passed (1) |
| bb-plugin-secrets | pass | pass | 2 passed (2) | 2 passed (2) |
| bb-plugin-side-chat | pass | pass | 2 passed (2) | 2 passed (2) |
| bb-plugin-simple-notes | pass | pass | 3 passed (3) | 3 passed (3) |
| bb-plugin-slack-bot | pass | pass | 1 passed (1) | 1 passed (1) |
| bb-plugin-tasks | fail (1) | fail (1) | 1 failed · 35 passed (36) | 1 failed · 35 passed (36) |
| bb-plugin-theme-preview | pass | pass | 5 passed (5) | 5 passed (5) |
| bb-plugin-workflows | fail (1) | fail (1) | 1 failed · 13 passed (14) | 1 failed · 13 passed (14) |

Exactly **two** packages change state between the runs:

- **`@bb/host-watcher`: `fail (1)` → `pass`.** Phase 3 fixed it. At the baseline it lost
  `test/parcel-watcher-proxy.test.ts` and `test/watch-path.test.ts` (2 files / 4 tests); at this head it is
  9 passed / 1 skipped (10 files), 74 passed / 3 skipped. This is the package behind `23-watcher-ntfs.md`.
- **`@bb/plugin-registry`: `pass` → `fail (1)`.** One file, one test. It **passes in isolation at this
  head** (below), so it is a load flake, not a regression.

## Table 2 — every test file that fails at this head and not at the baseline

`comm` of the two runs' failing-file lists gives 24 candidates. Each was re-run in isolation at this head.

| package | file | isolated at head | verdict |
|---|---|---|---|
| `@bb/agent-runtime` | `src/runtime-thread-rewind.test.ts` | pass | load flake |
| `@bb/agent-runtime` | `src/runtime.input-accepted.test.ts` | pass | load flake |
| `@bb/agent-runtime` | `src/runtime.interactive-requests.test.ts` | pass | load flake |
| `@bb/agent-runtime` | `src/runtime.turn-start-watchdog.test.ts` | pass | load flake |
| `@bb/app` | `src/components/plugin/PluginPanelRightPanelHost.test.tsx` | pass | load flake |
| `@bb/app` | `src/components/ui/bottom-anchored-scroll-body.scroll-preservation.test.tsx` | pass | load flake |
| `@bb/app` | `src/components/ui/markdown-katex-loader.test.tsx` | pass | load flake |
| `@bb/cli` | `src/__tests__/bin.test.ts` | pass | load flake |
| `@bb/cli` | `src/__tests__/docs-official-plugin-bundle.test.ts` | pass | load flake |
| `@bb/cli` | `src/__tests__/packaged-plugin-build.test.ts` | pass | load flake |
| `@bb/cli` | `src/__tests__/plugin-scaffold-dependencies.test.ts` | pass | load flake |
| `@bb/cli` | `src/__tests__/plugin-server-build.test.ts` | pass | load flake |
| **`@bb/host-daemon`** | **`src/app.test.ts`** | **2 failed** | **REGRESSION — fixed, `fd84ca436`** |
| `@bb/integration-tests` | `fake/harness.test.ts` | pass | load flake |
| `@bb/integration-tests` | `fake/recovery/idle-error-reconciliation.test.ts` | pass | load flake |
| `@bb/plugin-registry` | `src/__tests__/vendor-all-items.test.ts` | pass | load flake |
| `@bb/provider-bridge-acp` | `src/probe.test.ts` | pass | load flake |
| `@bb/provider-bridge-protocol` | `src/bridge-kit/provider-maintenance-kit.test.ts` | pass | load flake |
| `@bb/server` | `test/services/plugin-catalog/plugin-catalog-service.test.ts` | pass | load flake |
| `@bb/server` | `test/services/plugins/plugin-agent-tools.test.ts` | pass | load flake |
| `@bb/server` | `test/services/plugins/plugin-app-bundle.test.ts` | pass | load flake |
| `@bb/server` | `test/services/threads/timeline-in-turn-window.test.ts` | pass | load flake |
| `bb-plugin-provider-codex` | `src/bridge/bridge.recorded-conformance.test.ts` | pass | load flake |
| `bb-plugin-provider-pi` | `src/bridge/catalog.test.ts` | pass | load flake |

The isolation commands and their `EXIT=` lines were run in batches per package, e.g.

```bash
pnpm --filter @bb/agent-runtime exec vitest run src/runtime-thread-rewind.test.ts src/runtime.input-accepted.test.ts src/runtime.interactive-requests.test.ts src/runtime.turn-start-watchdog.test.ts
#  Test Files 4 passed (4)   EXIT=0
pnpm --filter @bb/cli exec vitest run src/__tests__/bin.test.ts … src/__tests__/plugin-server-build.test.ts
#  Test Files 5 passed (5)   EXIT=0
pnpm --filter @bb/server exec vitest run test/services/plugin-catalog/plugin-catalog-service.test.ts …
#  Test Files 4 passed (4)   EXIT=0
```

**23 of 24 pass in isolation.** Only one is real.

## The one regression: `apps/host-daemon/src/app.test.ts`

```bash
pnpm --filter @bb/host-daemon exec vitest run src/app.test.ts --reporter=verbose
```
```
 FAIL   @bb/host-daemon  src/app.test.ts > createHostDaemonApp > refreshes runtime shell env before provider model listing
 FAIL   @bb/host-daemon  src/app.test.ts > createHostDaemonApp > reuses freshly resolved startup shell env for immediate model listing
AssertionError: expected { …(11) } to deeply equal ObjectContaining{…}

- ObjectContaining {
+ {
    "env": {
+     "Path": "/shell/bin:/usr/bin",
+   },
+   "shellEnv": {
      "PATH": "/shell/bin:/usr/bin",
    },
  }

 ❯ src/app.test.ts:479:38
 Test Files  1 failed (1)
      Tests  2 failed | 10 passed (12)
   Duration  9.53s
EXIT=1
```

**At the baseline (`9a07e6994`, base worktree, same host, same node):**

```bash
pnpm --filter @bb/host-daemon exec vitest run src/app.test.ts
#  Test Files 1 passed (1)   EXIT=0
```

Root cause, traced rather than guessed. Phase 3 commit `28854d943` ("Give provider processes a single Path
key on Windows and report sweep skips") routed `providerProcessEnvFromShellEnv`
(`apps/host-daemon/src/runtime-manager.ts:246`) through `assignPathEnv`, which on win32 writes `Path` and
on every other platform writes `PATH`:

```ts
function providerProcessEnvFromShellEnv(
  shellEnv: NonNullable<AgentRuntimeOptions["shellEnv"]>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> | null {
  …assignPathEnv({ env: {}, path: shellEnv.PATH, platform })…
```

The product behaviour is correct and correctly gated — `docs/platform-windows.md` states it, and Linux is
untouched, which is why the POSIX run stays green. The defect is in the **test**: it drives the whole
daemon through `createHostDaemonApp`, which has no `platform` option to thread down to
`RuntimeManagerOptions.platform`, and then asserts the literal key `PATH`. On a win32 host it therefore
takes the new win32 arm and fails.

The standing ruling for this gate is to pin `platform: "linux"` and change nothing else. There is no pin
seam at this level, so the fix uses the pattern the repository already uses where a value's shape follows
the host (`apps/host-daemon/src/command-handlers/canonicalize-path.test.ts:216`): derive the expected key
from `process.platform`. **No product code was touched**, so POSIX behaviour is byte-identical by
construction, and `40-posix-check.md` confirms `@bb/host-daemon` is 53 files / 680 tests green on Linux
after the fix.

```ts
const providerPathEnvKey = process.platform === "win32" ? "Path" : "PATH";
…
          env: {
            [providerPathEnvKey]: "/shell/bin:/usr/bin",
          },
```

After the fix: `Test Files 1 passed (1)`, `EXIT=0` on Windows.

This is the same class as the Phase 2 finding in `apps/host-daemon/src/plugin-host-manager.test.ts`
(recorded, not fixed, at that gate). That file now pins `platform: "linux"` at line 642 and passes here.

## `@bb/desktop` — the failing-test **name** diff the carry required

Phase 2 recorded 6 failing `@bb/desktop` *files* (7 with the `foreign-runtime` flake) but never the names;
Task 10 counted 12 failing tests at this head. Both ends were therefore re-run **in isolation** and the
names compared:

```bash
cd C:/Users/olege/Work/bb-p2-base && pnpm exec turbo run test --filter=@bb/desktop --force   # BASE_DESKTOP_EXIT=1
cd C:/Users/olege/Work/bb        && pnpm exec turbo run test --filter=@bb/desktop --force   # HEAD_DESKTOP_EXIT=1
```

| | base `9a07e6994` | head |
|---|---|---|
| files | **6 failed / 37 passed (43)** | **6 failed / 37 passed (43)** |
| tests | **12 failed / 314 passed / 1 skipped (327)** | 12 failed / 324 passed / 4 skipped (340) |

The twelve names are **identical sets** — same files, same test titles, same order:

| file | test |
|---|---|
| `test/app-paths.test.ts` | resolves the packaged bb-app bridge beside the active asar |
| `test/app-paths.test.ts` | resolves the universal packaged bb-app bridge beside the selected arch asar |
| `test/app-paths.test.ts` | uses the release-specific icon inside packaged apps |
| `test/app-paths.test.ts` | keeps the development icon independent of the release channel |
| `test/bb-process.test.ts` | imports the bridge from the child AppImage mount |
| `test/bb-process.test.ts` | escalates to SIGKILL when the bridge ignores SIGTERM |
| `test/browser-import.test.ts` | parses Firefox profiles.ini and keeps them inside the root |
| `test/browser-import.test.ts` | imports through the service into a session and reports rejected writes |
| `test/electron-builder-config.test.ts` | patches packaged node-pty helper path handling |
| `test/foreign-runtime.test.ts` | escalates to SIGKILL when the process outlives SIGTERM |
| `test/desktop-browser-view-manager.test.ts` | preserves same-server reconnect tabs but clears them before a different server registration (local daemon) |
| `test/desktop-browser-view-manager.test.ts` | preserves same-server reconnect tabs but clears them before a different server registration (enrolled daemon) |

**Zero names new since `9a07e6994`, zero fixed.** Phase 3 added no `@bb/desktop` failure and removed none.
The head run also shows **10 more passing tests and 3 more skipped** in the same 43 files — Phase 3 added
tests here, and all of them pass. Note that Phase 2's "6" was a *file* count and Task 10's "12" a *test*
count; both are correct and describe the same set. The `foreign-runtime` case Phase 2 called a flake
(6 files vs 7) is in the deterministic set at **both** ends of this comparison, so on this host it is
baseline, not flake.

## Table 3 — against Phase 2's own numbers (`qa/windows/phase-2/31-test-results.md`)

Only the 23 packages Phase 2 measured can be compared, and only loosely: Phase 2's filter list put ~23
packages under load, this run put 91 tasks under load, so a larger number here is expected wherever the
package is load-sensitive. Phase 2's "isolation re-runs are authoritative" caveat applies to both columns.

| package | Phase 2 (alone, or its batch) | this gate's base `9a07e6994` full run | this gate's head full run | reading |
|---|---|---|---|---|
| `@bb/domain` | pass | pass | **pass** | unchanged |
| `@bb/host-daemon-contract` | pass | pass | **pass** | unchanged |
| `@bb/desktop-contract` | pass | pass | **pass** | unchanged |
| `@bb/server-contract` | pass | pass | **pass** | unchanged |
| `@bb/secret-storage` | pass | pass | **pass** | unchanged |
| `bb-environment-provider-host` | pass | pass | **pass** | unchanged |
| `bb-plugin-environment-git-worktree` | pass | pass | **pass** | unchanged |
| `@bb/config` | 1 file / 8 tests | 1 / 8 | **1 / 8** | byte-identical, the package's known Windows baseline |
| `@bb/db` | 1 under load, 34/34 alone | pass | **pass** | improved under this load |
| `@bb/process-utils` | pass | pass | **pass** | unchanged |
| `@bb/local-open-targets` | 1 file / 6 tests | 1 / 7 | **1 / 7** | unchanged against this gate's own base |
| `@bb/scripts` | 6 in an 8-package batch | 6 files | **4 files** | improved |
| `@bb/desktop` | 7 under load, 6 alone | 6 alone | **6 alone, identical names** | unchanged |
| `@bb/host-daemon` | 19 alone | 19 | **19** (35 tests vs 57 at base) — **18 after `fd84ca436`** | one file fewer than the base once the gate's own fix lands, 22 fewer failing tests |
| `@bb/server` | 19 alone | 86 under this load | **43 under this load** | far better than the base under identical load |
| `@bb/app` | 8 alone | 12 | **15** | all three extra pass in isolation |
| `@bb/host-workspace` | 5 files / 26 tests | 5 / 28 | **5 / 25** | unchanged files, 3 fewer failing tests |
| `@bb/cli` | 4 files / 11 tests | 7 | **12** | all five extra pass in isolation |
| `bb-plugin-automations` | 3 files / 5 tests | 3 / 6 | **3 / 5** | unchanged |
| `bb-plugin-github` | 2 files / 11 tests | 2 / 11 | **2 / 9** | 2 fewer failing tests |
| `bb-plugin-provider-claude-code` | 2 files / 3 tests | 2 / 3 | **2 / 3** | identical |
| `bb-plugin-environment-personal-workspace` | 1 file / 1 test | 1 / 1 | **1 / 1** | identical |
| `bb-app` | 3 files / 10 tests | 3 / 10 | **2 / 9** | improved |

Nothing in this table is a Phase 3 regression: every row that moved up is covered by Table 2's isolation
re-runs, and every row that moved down is an improvement.

## Baseline items confirmed, not fixed

- `packages/templates/test/plugin-scaffold-external.test.ts` — `spawn npm ENOENT` from a bare
  `execFile("npm")`. Fails at **both** ends: the base run lost 2 `@bb/templates` files, this head loses 1,
  and `@bb/templates` is `fail (1)` in both summaries. Pre-existing, unrelated to Phase 3, as the carry
  predicted.
- `apps/host-daemon/src/terminals/terminal-manager.test.ts` — the 2 darwin spawn-helper mode-bit tests
  (NTFS has no mode bits). It fails at the **base** and **passes at this head**: Phase 3's Task 5 skipped
  the darwin checks off macOS, so this one is **fixed**, not merely recorded.
- `@bb/config` 1 file / 8 tests — identical to Phase 0, Phase 1 and Phase 2. Known Windows baseline.

## The evidence commit

`Record the Phase 3 Windows gate evidence` adds only `qa/windows/phase-3/**`. It is pushed so the fork's
branch tip matches the local tip; it changes no product code, no test and no workflow, so the CI run it
starts is not part of this verdict. Its run id is recorded in the gate report at
`.superpowers/sdd/2026-09-15-native-windows-phase-3/task-14-report.md`.
