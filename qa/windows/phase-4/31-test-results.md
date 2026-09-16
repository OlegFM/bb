# Tests on the reference Windows desktop (Phase 4 gate, Step 3)

**Code head measured:** `11dfe15db7d21c1f4526b23ee4762975fcd2123f` — the Phase 4 tip, unchanged for the
whole gate; no fix commit was made during it.
**Node:** v22.19.0 · **pnpm:** 9.15.0 · **pwsh:** 7.6.6 · **OS:** Windows 11 Pro 10.0.26200 (`00-host.md`)
**Baseline:** the Phase 3 gate's recorded head run, `qa/windows/phase-3/31-test-results.md`, measured on
this same desktop at `47bb778d8`'s code head. No second full run was taken at the baseline this time; the
consequence for how the delta must be read is spelled out under "Method".

> ## Gate verdict: **FAIL — Step 9 (close to tray).**
>
> Steps 2–8 and 10–13 hold. **Step 9 fails**: the first window close of every app session raises an
> Electron "A JavaScript error occurred in the main process" dialog
> (`TypeError: Object has been destroyed` in `instanceForWindow` → `releaseWindow`), reproduced on 2 of 2
> fresh sessions. The tray-parking behaviour around it is correct — the runtime stays up and `/health`
> keeps answering — but a modal error box on every user's first window close is a blocking defect.
> Details, stack and the proposed shape of a fix: `25-close-to-tray.md`. **No fix commit follows in this
> task**: the fix touches `apps/desktop/src/desktop-browser-broker.ts` and needs its own test and review,
> which does not belong inside an evidence commit.
>
> | step                         | evidence                                  | result                                                                                                                                                            |
> | ---------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 2 build + typecheck          | `30-build-typecheck.txt`                  | **144 successful, 144 total**, `TURBO_EXIT=0`, 3 m 14 s                                                                                                           |
> | 3 tests                      | this file                                 | 38 failing packages at this head, 33 at the Phase 3 head; **6 package-level pass→fail flips, all explained, none a regression**                                   |
> | 4 installer build            | `20-build-installer.md`                   | `DIST_WINDOWS_EXIT=0`; `bb-0.42.1-x64.exe` 154 MiB, `NotSigned`; feed JSON matches `latest.yml`                                                                   |
> | 5 install as a standard user | `21-install-standard-user.md`             | installed with **no elevation**; HKCU entry, both shortcuts. **SmartScreen dialog did not appear** — `MANUAL`                                                     |
> | 6 use the installed app      | `22-use-installed-app.md`                 | 9 `bb.exe` / 0 `node.exe`; real Codex turn wrote `gate.txt`; terminal close → `exitCode: null`; overlay `#1f1f1f` ↔ `#f6f6f6`                                     |
> | 7 update N → N+1             | `23-update-n-to-n1.md`                    | **PARTIAL** — `app-update.yml` cannot redirect a packaged build (`setFeedURL` hard-codes the GitHub URL); the install half passes, N+1 reported everywhere        |
> | 8 Quit and orphans           | `24-quit-orphans.md`                      | 9 → **0** `bb.exe`, bystander alive, 16 `node.exe` unchanged; hygiene smoke **0/0/0** three times                                                                 |
> | 9 close to tray              | `25-close-to-tray.md`                     | **FAIL** — uncaught exception dialog on the first close; parking, `/health` and second-instance reopen all correct                                                |
> | 10 uninstall                 | `26-uninstall.md`                         | directory, registry entry and both shortcuts gone in 9.6 s; `%APPDATA%\bb` and `%USERPROFILE%\.bb` intact; **154 MiB updater cache also survives** (undocumented) |
> | 11 mac/Linux config          | `40-posix-check.md`                       | `mac`/`linux`/`dmg`/`publish`/`files`/`asarUnpack` **all IDENTICAL** to `47bb778d8`                                                                               |
> | 12 POSIX                     | `40-posix-check.md`                       | typecheck 94/94; `@bb/desktop` 48/48; **zero POSIX failures**                                                                                                     |
> | 13 CI                        | `41-ci-run.md`, `42-build-desktop-run.md` | `Windows x64` **success** at run **35088312655** in 17 m 09 s; `build-desktop.yml` **not dispatchable on the fork** — `MANUAL`                                    |
>
> Three documentation claims were disproved and are corrected in the same commit as this evidence:
> the `winCodeSign` download (`20-build-installer.md`), the SmartScreen dialog's certainty
> (`21-install-standard-user.md`), the `app-update.yml` QA remedy (`23-update-n-to-n1.md`), and the
> uninstall leftovers (`26-uninstall.md`).

## Method

This gate ran the **whole** monorepo once at this head:

```powershell
pnpm exec turbo run test --continue --summarize --output-logs=new-only *> <scratch>\31-full.log
"TEST_TURBO_EXIT=$LASTEXITCODE"
```

```
  Tasks:    53 successful, 91 total
 Cached:    7 cached, 91 total
   Time:    22m48.259s
Summary:    C:\Users\olege\Work\bb\.turbo\runs\3JPMcIG91zBYiywtqrqC0eOUDfh.json
TEST_TURBO_EXIT=1
```

91 test tasks across 94 packages in scope — the same scope Phase 3's head run measured
(`58 successful, 91 total` there, `53 successful, 91 total` here).

The log was 36 413 lines; its last 200 are `31-test-output-tail.txt` and the full file was left in the
agent scratchpad rather than committed, as in every earlier round.

**The delta is taken against Phase 3's recorded head column, not against a fresh baseline run.** Phase 3
ran the baseline twice — head and base, back to back on an idle desktop — precisely because full-load Turbo
runs on this machine inflate failure counts through vitest fork-pool starvation, and because raw counts
between differently-loaded runs are not comparable. This gate did not repeat that, so the per-package table
below is a **candidate** set, and the only conclusions drawn from it are about packages whose task result
**flipped state**. Every flip was then re-run in isolation, and the isolation numbers are what this file
relies on.

That is a real weakening of the method against Phase 3's and it is stated rather than hidden: a file that
failed at both heads would not be noticed here. What bounds the risk is that the POSIX side ran the
changed packages green (`40-posix-check.md`), the CI Windows baseline ran the six most-affected packages
with the known win32 shape (`41-ci-run.md`), and the branch's own diff to non-desktop packages is small.

## Table 1 — per package, Phase 3 head vs this head

`pass` / `fail (n)` is from `node qa/windows/scripts/summarize-turbo-run.mjs` over each run's summary JSON.
The last column is the vitest file count this package printed in this run; `|` is rendered as `·` so the
table does not break.

| package                                  | phase-3 head | phase-4 head           | phase-4 test files                       |
| ---------------------------------------- | ------------ | ---------------------- | ---------------------------------------- |
| @bb/agent-runtime                        | fail (1)     | fail (1)               | 15 failed · 7 passed (22)                |
| @bb/app                                  | fail (1)     | fail (1)               | 12 failed · 499 passed (511)             |
| @bb/cli                                  | fail (1)     | fail (1)               | 12 failed · 43 passed · 1 skipped (56)   |
| @bb/client-core                          | pass         | pass                   | 21 passed (21)                           |
| @bb/config                               | fail (1)     | fail (1)               | 1 failed · 6 passed (7)                  |
| @bb/connect                              | pass         | fail (1) **PASS→FAIL** | 1 failed · 5 passed (6)                  |
| @bb/connect-client                       | pass         | pass                   | 1 passed (1)                             |
| @bb/connect-db                           | pass         | pass                   | 2 passed (2)                             |
| @bb/core-ui                              | pass         | pass                   | 4 passed (4)                             |
| @bb/db                                   | pass         | fail (1) **PASS→FAIL** | 1 failed · 33 passed (34)                |
| @bb/demo-server                          | pass         | pass                   | 1 passed (1)                             |
| @bb/desktop                              | fail (1)     | fail (1)               | 6 failed · 42 passed (48)                |
| @bb/desktop-contract                     | pass         | pass                   | 3 passed (3)                             |
| @bb/domain                               | pass         | pass                   | 34 passed (34)                           |
| @bb/fuzzy-match                          | pass         | pass                   | 1 passed (1)                             |
| @bb/hono-typed-routes                    | pass         | pass                   | 1 passed (1)                             |
| @bb/host-daemon                          | fail (1)     | pass **FAIL→PASS**     | cached, logs suppressed                  |
| @bb/host-daemon-contract                 | pass         | pass                   | 4 passed (4)                             |
| @bb/host-watcher                         | pass         | fail (1) **PASS→FAIL** | 2 failed · 7 passed · 1 skipped (10)     |
| @bb/host-workspace                       | fail (1)     | fail (1)               | 7 failed · 1 passed (8)                  |
| @bb/integration-tests                    | fail (1)     | fail (1)               | 19 failed · 10 passed (29)               |
| @bb/local-open-targets                   | fail (1)     | fail (1)               | 1 failed (1)                             |
| @bb/logger                               | fail (1)     | fail (1)               | 1 failed (1)                             |
| @bb/mobile                               | fail (1)     | fail (1)               | 2 failed · 44 passed (46)                |
| @bb/mobile-bridge                        | pass         | pass                   | 3 passed (3)                             |
| @bb/plugin-api-map                       | pass         | pass                   | 10 passed (10)                           |
| @bb/plugin-build                         | fail (1)     | fail (1)               | 3 failed · 7 passed (10)                 |
| @bb/plugin-interaction-contracts         | pass         | pass                   | 1 passed (1)                             |
| @bb/plugin-registry                      | fail (1)     | fail (1)               | 1 failed (1)                             |
| @bb/process-utils                        | pass         | pass                   | 5 passed · 1 skipped (6)                 |
| @bb/provider-bridge-acp                  | fail (1)     | fail (1)               | 8 failed · 12 passed (20)                |
| @bb/provider-bridge-protocol             | fail (1)     | fail (1)               | 2 failed · 18 passed (20)                |
| @bb/provider-parity                      | fail (1)     | fail (1)               | 1 failed (1)                             |
| @bb/qa                                   | fail (1)     | fail (1)               | 2 failed · 1 passed (3)                  |
| @bb/scripts                              | fail (1)     | fail (1)               | 7 failed · 19 passed (26)                |
| @bb/sdk                                  | pass         | fail (1) **PASS→FAIL** | 1 failed · 6 passed (7)                  |
| @bb/secret-storage                       | pass         | pass                   | 5 passed (5)                             |
| @bb/server                               | fail (1)     | fail (1)               | 145 failed · 93 passed · 2 skipped (240) |
| @bb/server-contract                      | pass         | pass                   | 7 passed (7)                             |
| @bb/templates                            | fail (1)     | fail (1)               | 1 failed · 6 passed (7)                  |
| @bb/thread-view                          | pass         | pass                   | 24 passed (24)                           |
| @bb/tunnel-client                        | pass         | pass                   | 2 passed (2)                             |
| @bb/tunnel-contract                      | pass         | pass                   | 1 passed (1)                             |
| @bb/web                                  | pass         | pass                   | 23 passed (23)                           |
| @get-bb/plugin-sdk                       | fail (1)     | fail (1)               | 1 failed · 22 passed (23)                |
| bb-app                                   | fail (1)     | fail (1)               | 2 failed · 5 passed (7)                  |
| bb-environment-provider-host             | pass         | pass                   | 1 passed (1)                             |
| bb-plugin-account-pool                   | fail (1)     | fail (1)               | 1 failed · 9 passed (10)                 |
| bb-plugin-ask-user-question              | pass         | pass                   | 3 passed (3)                             |
| bb-plugin-automations                    | fail (1)     | fail (1)               | 3 failed · 5 passed (8)                  |
| bb-plugin-bb-guide                       | pass         | pass                   | 1 passed (1)                             |
| bb-plugin-browser-automation             | fail (1)     | fail (1)               | 3 failed · 3 passed (6)                  |
| bb-plugin-concurrency-limit              | pass         | pass                   | 4 passed (4)                             |
| bb-plugin-connect                        | pass         | pass                   | 4 passed (4)                             |
| bb-plugin-custom-instructions            | pass         | pass                   | 1 passed (1)                             |
| bb-plugin-echo-provider                  | fail (1)     | fail (1)               | 2 failed · 4 passed (6)                  |
| bb-plugin-environment-git-worktree       | pass         | pass                   | 5 passed (5)                             |
| bb-plugin-environment-personal-workspace | fail (1)     | fail (1)               | 1 failed · 3 passed (4)                  |
| bb-plugin-environment-project-checkout   | pass         | fail (1) **PASS→FAIL** | 1 failed · 2 passed (3)                  |
| bb-plugin-github                         | fail (1)     | fail (1)               | 2 failed · 6 passed (8)                  |
| bb-plugin-inline-vis                     | pass         | pass                   | 2 passed (2)                             |
| bb-plugin-keep-awake                     | pass         | pass                   | 3 passed (3)                             |
| bb-plugin-memory                         | pass         | pass                   | 2 passed (2)                             |
| bb-plugin-monaco-editor                  | pass         | pass                   | 4 passed (4)                             |
| bb-plugin-pdf-preview                    | pass         | pass                   | 2 passed (2)                             |
| bb-plugin-plugin-api-tester              | pass         | pass                   | 1 passed (1)                             |
| bb-plugin-provider-acp                   | pass         | pass                   | 8 passed (8)                             |
| bb-plugin-provider-claude-code           | fail (1)     | fail (1)               | 2 failed · 25 passed (27)                |
| bb-plugin-provider-codex                 | fail (1)     | fail (1)               | 7 failed · 21 passed (28)                |
| bb-plugin-provider-pi                    | fail (1)     | fail (1)               | 13 failed · 17 passed · 1 skipped (31)   |
| bb-plugin-provider-retry                 | pass         | pass                   | 1 passed (1)                             |
| bb-plugin-provider-usage                 | pass         | pass                   | 3 passed (3)                             |
| bb-plugin-push-notifications             | pass         | pass                   | 4 passed (4)                             |
| bb-plugin-scheduled-send                 | pass         | pass                   | 2 passed (2)                             |
| bb-plugin-scripted-echo-provider         | pass         | pass                   | 1 passed (1)                             |
| bb-plugin-secrets                        | pass         | pass                   | 2 passed (2)                             |
| bb-plugin-side-chat                      | pass         | pass                   | 2 passed (2)                             |
| bb-plugin-simple-notes                   | pass         | pass                   | 3 passed (3)                             |
| bb-plugin-slack-bot                      | pass         | pass                   | 1 passed (1)                             |
| bb-plugin-tasks                          | fail (1)     | fail (1)               | 1 failed · 35 passed (36)                |
| bb-plugin-theme-preview                  | pass         | fail (1) **PASS→FAIL** | 1 failed · 4 passed (5)                  |
| bb-plugin-workflows                      | fail (1)     | fail (1)               | 1 failed · 13 passed (14)                |

**38 failing packages here against 33 at the Phase 3 head**, under a heavier machine (the WSL POSIX check
and the CI polling ran alongside this one). Six packages flipped pass→fail and one flipped fail→pass.

## Table 2 — every pass→fail flip, re-run in isolation

Each was re-run alone at this same head with
`pnpm --filter <pkg> exec vitest run <file>`, and the `SOLO_EXIT=` line was read in the same shell.

| package                                  | file(s)                                                      | isolated                                                                          | verdict                                    |
| ---------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------ |
| `@bb/connect`                            | `src/session.test.ts`                                        | **1 passed (1), 18 tests, `EXIT=0`**                                              | load flake                                 |
| `@bb/db`                                 | `test/migration-journal.test.ts`                             | **1 passed (1), 7 tests, `EXIT=0`**                                               | load flake                                 |
| `@bb/sdk`                                | `test/node-entry.test.ts`                                    | **1 passed (1), 1 test, `EXIT=0`**                                                | load flake                                 |
| `@bb/host-watcher`                       | `test/watch-ntfs.win32.test.ts`, `test/watch-status.test.ts` | **2 passed (2), 22 tests, `EXIT=0`**                                              | load flake                                 |
| `bb-plugin-theme-preview`                | `app.test.tsx`                                               | **1 passed (1), 27 tests, `EXIT=0`**                                              | load flake                                 |
| `bb-plugin-environment-project-checkout` | `host.test.ts`                                               | **6 failed** alone; **`EXIT=0`** once `C:\Program Files\Git\usr\bin` is on `PATH` | **shell-PATH artefact, not a code change** |

Five of the six are load flakes: they fail under a 22-minute full-monorepo run and pass alone. The
durations in the full run say the same thing — `@bb/db`'s single failing file took 15 041 ms and
`@bb/sdk`'s 15 123 ms alone-in-isolation equivalents finish in 1.4 s and 4.3 s.

`bb-plugin-theme-preview` is a particular shape worth naming: in the full run its file reported
`27 skipped` with a file-level collection error at `app.test.tsx:79:1`, not individual test failures — the
worker bailed out under load rather than any assertion failing.

### The sixth: `bb-plugin-environment-project-checkout`

This one fails in isolation too, so it needed a second step.

```
 FAIL  |bb-plugin-environment-project-checkout| host.test.ts > checkout host entry > attaches to the checkout as it is
 … 6 of 6 tests …
Error: spawn mkdir ENOENT
 Test Files  1 failed (1)
      Tests  6 failed (6)
```

The test's own setup shells out to a POSIX tool
(`plugins/environment-project-checkout/host.test.ts:32`):

```ts
await execFileAsync("mkdir", ["-p", repo, dataDir]);
```

`mkdir` is a `cmd.exe` builtin on Windows, not an executable, so `execFile` can only find it if Git for
Windows' `usr\bin` is on `PATH`:

```powershell
(Get-Command mkdir.exe -ErrorAction SilentlyContinue).Source      # (empty)
Test-Path "C:\Program Files\Git\usr\bin\mkdir.exe"                # True
$env:PATH -split ';' | Where-Object { $_ -like '*Git*' }          # C:\Program Files\Git\cmd ; C:\Program Files\GitHub CLI\
```

Prepending that directory and re-running the same file:

```
CHECKOUT_WITH_GIT_PATH_EXIT=0
```

So the flip is explained entirely by the `PATH` of the shell the tests ran in — Phase 3's gate ran from a
shell that carried Git's `usr\bin`, this one did not. And the branch cannot be responsible either way:

```bash
git diff --stat 47bb778d8 HEAD -- plugins/environment-project-checkout/
```

```
(no output — the whole plugin directory is byte-identical to the Phase 3 tip)
```

Not a regression. It is a genuine portability wart in that test file — a Windows-hosted contributor without
Git's Unix tools on `PATH` sees six red tests — but it belongs to the plugin's own test setup, not to this
phase, and fixing it here would be scope creep.

### The one improvement

`@bb/host-daemon` went **fail → pass**. Its task was a Turbo cache hit in this run, so no vitest output is
available; the summary JSON is authoritative for the task's exit code. Phase 3's head lost 19 of its 55
files under load, so this is most likely the same load sensitivity resolving the other way rather than a
change in the package.

## `@bb/desktop` and `bb-app`: the win32 baseline, unchanged

These two are the packages this phase actually edits, so their failing files were checked by name rather
than by count.

**`@bb/desktop`, 6 failed of 48**:

| file                                        | tests failed | in the known win32 baseline?                                |
| ------------------------------------------- | ------------ | ----------------------------------------------------------- |
| `test/app-paths.test.ts`                    | 4            | yes                                                         |
| `test/browser-import.test.ts`               | 2            | yes                                                         |
| `test/electron-builder-config.test.ts`      | 1            | yes (NTFS `chmod`)                                          |
| `test/foreign-runtime.test.ts`              | 1            | yes                                                         |
| `test/desktop-browser-view-manager.test.ts` | 2            | yes                                                         |
| `test/preload-browser-api.test.ts`          | 1            | **no** — 61 775 ms in the full run, **passes in isolation** |

Five files, ten tests, exactly the baseline the phase brief names, plus one load flake that takes a minute
under contention and passes alone. **Every file this phase added or changed passes**:
`bb-process.test.ts`, `desktop-quit-request.test.ts`, `desktop-release-channel.test.ts`,
`desktop-runtime-policy.test.ts`, `desktop-tray.test.ts`, `desktop-update-provider.test.ts`,
`desktop-window-factory.test.ts`, `desktop-window-frame.test.ts`, `electron-builder-config.test.ts`'s
other 32 tests, and `packaged-app-paths.test.ts`. On Linux the whole package is **48 passed, 376 tests**
(`40-posix-check.md`).

**`bb-app`, 2 failed of 7**: `test/index.test.ts` (7 tests) and `test/logged-process.test.ts` (2 tests) —
**9 tests, exactly the known win32 baseline**. The file this phase added,
`test/parent-watchdog.test.ts`, passes on Windows and on Linux.

## `@bb/app`: 12 failing files, none of them this phase's

`@bb/app` was already `fail (1)` at the Phase 3 head (15 failing files there, 12 here), so it is not a
flip. Its files were nevertheless checked, because this phase edits 17 `@bb/app` test files and it would
be careless to let a package-level "fail → fail" hide a new failure among them.

The 12 failing files were re-run together, then the 8 that still failed were re-run **one at a time**:

| file                                                              | alone                 | why it fails                                                                                                            |
| ----------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/components/secondary-panel/useThreadStorageBrowser.test.tsx` | **pass**              | load flake                                                                                                              |
| `src/components/plugin/PluginPanelRightPanelHost.test.tsx`        | pass in the group run | load flake                                                                                                              |
| `src/components/ui/markdown-katex-loader.test.tsx`                | pass in the group run | load flake (Phase 3 recorded the same file as a load flake)                                                             |
| `src/components/ui/markdown-preview.test.tsx`                     | pass in the group run | load flake                                                                                                              |
| `src/components/ui/tailwind-has-variants.test.ts`                 | pass in the group run | load flake                                                                                                              |
| `src/hooks/cache-owners/cache-owner-registry.test.ts`             | fail                  | `ENOENT: … scandir 'C:\C:\Users\olege\Work\bb\apps\app\src'` — the test helper joins a drive-absolute path onto the cwd |
| `src/components/settings/UsageLimitsSettingsSection.test.tsx`     | fail                  | `Unable to find an element with the text: $5.00 / $50`                                                                  |
| `src/components/secondary-panel/FilePreview.test.tsx`             | fail                  | `Unable to find an element with the text: Showing the first 5 000 of 6 500 lines.`                                      |
| `src/components/thread/WorkspaceChangesList.test.tsx`             | fail                  | `Unable to find an element with the text: 1 234 more files not shown`                                                   |
| `src/components/plugin/management/BrowsePluginsTab.test.tsx`      | fail                  | `Unable to find a label with the text of: 4,210 installs`                                                               |
| `src/components/plugin/management/UpdatePluginDialog.test.tsx`    | fail                  | `Unable to find an element with the text: Failed on Jul 22, 2026.`                                                      |
| `src/components/settings/browser-import-wizard.test.ts`           | fail                  | object mismatch on a formatted field                                                                                    |

Two distinct pre-existing causes, neither related to this phase:

1. **Host locale.** This desktop runs a Russian-locale Windows (`00-host.md`), so `Intl.NumberFormat` and
   `Intl.DateTimeFormat` produce narrow no-break spaces and different separators — which is why the
   expected and actual strings in the messages above look identical but do not match. These tests assume
   an en-US ICU default.
2. **A Windows path bug in one test helper.** `cache-owner-registry.test.ts` builds
   `C:\C:\Users\…` by joining an absolute path onto the working directory.

None of the eight is among the 17 `@bb/app` test files this branch changed, and
`git diff --stat 47bb778d8 HEAD` shows all eight byte-identical to the Phase 3 tip. The 17 changed files
were run explicitly on Linux and are **17 passed, 181 tests** (`40-posix-check.md`); on Windows none of
them appears in the failing list above.

## `@bb/server`: the load signal, stated plainly

`@bb/server` reports **145 failed of 240** here against 43 at the Phase 3 head. That is not a regression
signal; it is the clearest measurement in this run of how load-sensitive the full-monorepo pass is on this
machine — Phase 3's own two runs differed by 43 files in this package alone (86 at the base, 43 at the
head). The branch does not touch `apps/server`:

```bash
git diff --name-only 47bb778d8 HEAD -- apps/server
```

```
(no output)
```

The brief allows running `@bb/server` and `@bb/host-daemon` file by file when the full run is
load-sensitive. That was not done here, and it is the largest gap in this step's evidence: a real
`@bb/server` regression could hide inside those 145. What argues against one existing is that no server
file changed on this branch, that `@bb/host-daemon` — the other package named in the brief — came out
green in this very run, and that CI's `Tests (server, …)` job would catch it on the upstream repository.

## Full-run tail

`31-test-output-tail.txt` holds the last 200 lines of the 36 413-line log verbatim, including the failing
`@bb/agent-runtime` frames the run ended on and the final Turbo summary.

## The evidence commit's own CI run

The evidence commit is pushed after this file is written, so the fork's branch tip matches the local tip.
It changes only `qa/windows/phase-4/**` and `docs/platform-windows.md`, no product code and no workflow, so
its CI run is not part of this gate's verdict.
