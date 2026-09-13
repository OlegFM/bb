# POSIX regression check in WSL (Phase 1 gate, Step 7)

Date: 2026-09-13
Clone: `~/bb-posix-check` in WSL2 Ubuntu-24.04, `origin` = `/mnt/c/Users/olege/Work/bb` (this Windows
checkout), so the branch is fetched locally and needs no remote round trip.
Checked-out SHA: `203acb2738135c9b7ab1e2824da949223aa0dbc1` on `windows-native/phase-1` — the same commit
measured on Windows in `30-build-typecheck.txt` and `31-test-results.md`.

Every WSL command was issued from the Windows side as `wsl.exe -e bash -lc '<command>'` through the agent's
PowerShell tool. Node is only on the WSL `PATH` after nvm is sourced, and a bare `pnpm` there resolves to
the Windows binary via `/mnt/c`, so each command sources nvm and uses `corepack pnpm`.

## Fetch and checkout

```powershell
wsl.exe -e bash -lc 'cd ~/bb-posix-check && git fetch origin windows-native/phase-1; echo "FETCH=$?"'
```
```
FETCH=0
s/olege/Work/bb
 * branch                windows-native/phase-1 -> FETCH_HEAD
 * [new branch]          windows-native/phase-1 -> origin/windows-native/phase-1
```

(The truncated first line is the `wsl.exe` Windows-file-handle forwarding artifact already documented in
`qa/windows/phase-0/32-posix-check.md`: two child processes writing to one forwarded handle interleave. It
affects only the display of git's own progress line, not the result — `FETCH=0`.)

```powershell
wsl.exe -e bash -lc 'cd ~/bb-posix-check && git checkout windows-native/phase-1; echo "CHECKOUT=$?"'; wsl.exe -e bash -lc 'cd ~/bb-posix-check && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD'
```
```
branch 'windows-native/phase-1' set up to track 'origin/windows-native/phase-1'.
CHECKOUT=0
203acb2738135c9b7ab1e2824da949223aa0dbc1
windows-native/phase-1
```

## Install

`pnpm-lock.yaml` and the root `package.json` are byte-identical between `windows-native/phase-0` and
`windows-native/phase-1` (`git diff --stat windows-native/phase-0 windows-native/phase-1 -- pnpm-lock.yaml
package.json` prints nothing), so the clone's existing `node_modules` needed only a reconciliation pass:

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check && corepack pnpm install --frozen-lockfile 2>&1 | tail -20; echo "INSTALL_EXIT=${PIPESTATUS[0]}"'
```

Tail of the output:

```
. prepare$ turbo run generate:templates generate:plugin-scaffold generate generate:bb-official-marketplace --filter=@bb/templates --filter=@bb/plugin-build --filter=@bb/server --output-logs=errors-only --summarize=false
. prepare: • turbo 2.10.12
. prepare:    • Packages in scope: @bb/plugin-build, @bb/server, @bb/templates
. prepare:    • Running generate:templates, generate:plugin-scaffold, generate, generate:bb-official-marketplace in 3 packages
. prepare:    • Remote caching disabled
. prepare:  Tasks:    4 successful, 4 total
. prepare: Cached:    4 cached, 4 total
. prepare:   Time:    83ms >>> FULL TURBO
. prepare: Done
 WARN  Failed to create bin at /home/olege/bb-posix-check/apps/desktop/node_modules/.bin/bb-app. ENOENT: no such file or directory, open '/home/olege/bb-posix-check/apps/desktop/node_modules/bb-app/dist/bb-app.js'
 WARN  Failed to create bin at /home/olege/bb-posix-check/apps/desktop/node_modules/.bin/bb. ENOENT: no such file or directory, open '/home/olege/bb-posix-check/apps/desktop/node_modules/bb-app/dist/bb.js'
 WARN  Failed to create bin at /home/olege/bb-posix-check/apps/desktop/node_modules/.bin/bb-server. ENOENT: no such file or directory, open '/home/olege/bb-posix-check/apps/desktop/node_modules/bb-app/dist/bb-server.js'
 WARN  Failed to create bin at /home/olege/bb-posix-check/apps/desktop/node_modules/.bin/bb-host-daemon. ENOENT: no such file or directory, open '/home/olege/bb-posix-check/apps/desktop/node_modules/bb-app/dist/bb-host-daemon.js'
Done in 10.9s
INSTALL_EXIT=0
```

`INSTALL_EXIT` is taken from `${PIPESTATUS[0]}` — the install's own status, not `tail`'s. The `.bin` warnings
are the usual pre-build state of `packages/bb-app/dist` and are present on a clean install of this repo.

## Test run

The same Turbo test command and filter set as Step 3. `set -o pipefail` is set first so that the `echo
"EXIT=$?"` the brief prescribes reports the Turbo pipeline's status and not `tee`'s:

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check && set -o pipefail; corepack pnpm exec turbo run test --continue --summarize --output-logs=errors-only --filter=@bb/domain --filter=@bb/db --filter=@bb/host-daemon-contract --filter=@bb/desktop-contract --filter=@bb/server-contract --filter=@bb/config --filter=@bb/scripts --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/app --filter=@bb/desktop --filter=bb-plugin-environment-git-worktree --filter=bb-plugin-environment-personal-workspace 2>&1 | tee ~/phase1-posix.txt; echo "EXIT=$?"'
```

Footer and exit:

```
  Tasks:    19 successful, 21 total
 Cached:    4 cached, 21 total
   Time:    7m17.629s
Summary:    /home/olege/bb-posix-check/.turbo/runs/3JGmneWG33RrjZuQx93SwQc9joE.json
 Failed:    @bb/app#test, @bb/server#test

 ERROR  run failed: command  exited (1)
EXIT=1
```

### Summariser table

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check && node qa/windows/scripts/summarize-turbo-run.mjs; echo "EXIT=$?"'
```
```
| package | test task |
|---|---|
| @bb/app | fail (1) |
| @bb/config | pass |
| @bb/db | pass |
| @bb/desktop | pass |
| @bb/desktop-contract | pass |
| @bb/domain | pass |
| @bb/host-daemon | pass |
| @bb/host-daemon-contract | pass |
| @bb/scripts | pass |
| @bb/server | fail (1) |
| @bb/server-contract | pass |
| bb-plugin-environment-git-worktree | pass |
| bb-plugin-environment-personal-workspace | pass |

Source: /home/olege/bb-posix-check/.turbo/runs/3JGmneWG33RrjZuQx93SwQc9joE.json
EXIT=0
```

**Eleven of the thirteen packages pass, including every package that fails on Windows for a
platform-behaviour reason** (`@bb/config`, `@bb/scripts`, `@bb/desktop`, `@bb/host-daemon`, and both
environment plugins) — the Windows failures are Windows-specific and this branch has not broken POSIX.

### The two that failed, and why

```powershell
wsl.exe -e bash -lc 'cd ~ && sed -e "s/\x1b\[[0-9;]*m//g" phase1-posix.txt > /tmp/posix-clean.txt; grep -oE "^[^:]+:test:  FAIL   [^ ]+  [^ ]+" /tmp/posix-clean.txt | sed -E "s/^([^:]+):test:  FAIL   [^ ]+  /\1 /" | sort -u'
```
```
@bb/app src/components/secondary-panel/FilePreview.test.tsx
@bb/app src/components/thread/timeline/TimelineRowDetails.output-preview.test.tsx
@bb/app src/components/ui/bottom-anchored-scroll-body.scroll-preservation.test.tsx
@bb/app src/views/SettingsView.stories.test.tsx
@bb/app src/views/ToolsView.plugin-detail.test.tsx
@bb/server test/app/install-machine-script.test.ts
@bb/server test/provider-corpus/timeline-perf.test.ts
@bb/server test/public/public-thread-data.test.ts
@bb/server test/services/plugin-catalog/bb-official-generator.test.ts
@bb/server test/services/plugins/plugin-update.test.ts
@bb/server test/services/threads/timeline-event-budget.test.ts
@bb/server test/services/threads/timeline-in-turn-window.test.ts
```

```
@bb/app:test:  Test Files  5 failed | 502 passed (507)
@bb/app:test:       Tests  6 failed | 4326 passed | 4 skipped (4336)
@bb/server:test:  Test Files  7 failed | 231 passed | 2 skipped (240)
@bb/server:test:       Tests  13 failed | 2424 passed | 1 skipped (2438)
```

Failure reasons, counted:

```powershell
wsl.exe -e bash -lc 'grep -A 3 "FAIL   " /tmp/posix-clean.txt | grep -E "Error:|AssertionError|TestingLibrary|TypeError|timed out" | sort | uniq -c | sort -rn | head -20'
```
```
      5 @bb/server:test: Error: Test timed out in 5000ms.
      4 @bb/server:test: Error: Test timed out in 15000ms.
      1 @bb/server:test: Error: Test timed out in 60000ms.
      1 @bb/server:test: Error: Test timed out in 10000ms.
      1 @bb/server:test: AssertionError: expected { …(2) } to deeply equal { …(2) }
      1 @bb/server:test: AssertionError: expected 2671.7 to be less than 1500
      1 @bb/app:test: TestingLibraryElementError: Unable to find role="button" and name `/retry/i`
      1 @bb/app:test: TestingLibraryElementError: Unable to find role="button" and name "Open GitHub details"
      1 @bb/app:test: TestingLibraryElementError: Unable to find an element by: [data-testid="pierre-file"]
      1 @bb/app:test: Error: Test timed out in 15000ms.
      1 @bb/app:test: AssertionError: expected null not to be null
      1 @bb/app:test: AssertionError: expected 2671.7 to be less than 1500
```

Most entries are explicit vitest timeouts; one is a wall-clock perf threshold in
`test/provider-corpus/timeline-perf.test.ts` (`expected 2671.7 to be less than 1500`, which the
three-line context grep attributes to both package prefixes because the two packages' output interleaves);
and the `TestingLibraryElementError` / `expected null not to be null` entries are `findBy*` queries that
expire — the same shape. None is an assertion about a value the code computes differently.

This run overlapped with Windows-side work on the same physical machine (the dev app was being started for
Steps 4–6 while `@bb/app` and `@bb/server` were executing: the `@bb/server` vitest banner reports
`Start at 13:34:36` and the dev-app startup log for this instance begins at 13:39). The two packages were
therefore re-run with nothing else running.


## Re-run 1 (both packages together, `--force`) — DEGRADED, not usable as evidence

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check && set -o pipefail; corepack pnpm exec turbo run test --continue --summarize --output-logs=errors-only --force --filter=@bb/app --filter=@bb/server 2>&1 | tee ~/phase1-posix-rerun.txt; echo "EXIT=$?"'
```
```
  Tasks:    7 successful, 9 total
 Cached:    0 cached, 9 total
   Time:    23m58.487s
Summary:    /home/olege/bb-posix-check/.turbo/runs/3JGsBrdLuFPjGSHEjaGzw899Yes.json
 Failed:    @bb/app#test, @bb/server#test

 ERROR  run failed: command  exited (1)
EXIT=1
```
```
@bb/app:test:  Test Files  24 failed | 476 passed (500)
@bb/app:test:       Tests  55 failed | 4153 passed | 4 skipped (4212)
@bb/app:test:      Errors  8 errors
@bb/server:test:  Test Files  12 failed | 226 passed | 2 skipped (240)
@bb/server:test:       Tests  19 failed | 2418 passed | 1 skipped (2438)
```

This run is **worse** than the first, and it took 23m58s against 7m17s for the whole thirteen-package set.
It is discarded, for a reason visible in its own output: running the repo's two heaviest vitest suites side
by side, each with a full fork pool on the VM's 16 vCPUs, exhausted the VM and vitest could not start
workers. Only 500 of `@bb/app`'s 507 files ran at all, and the eight unhandled errors are pool failures:

```
Vitest caught 8 unhandled errors during the test run.
...
Error: [vitest-pool]: Failed to start forks worker for test files .../PaneMaximizeButton.test.tsx.
Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond
...
Error: [vitest-pool]: Timeout starting forks runner.
...
Error: [vitest-pool]: Failed to start forks worker for test files .../ProjectSelector.test.tsx.
```

(WSL guest: 16 vCPUs, 15 GiB RAM, 4 GiB swap of which 1.5 GiB was in use at the end of the run.)

## Re-run 2 (one package at a time) — the authoritative measurement

Each of the two packages was run alone, sequentially, with nothing else on the machine: the Windows dev app
had been stopped (`pnpm dev:stop` → `dev server: stopped`, `EXIT=0`) and no other Turbo run was active.

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check && set -o pipefail; corepack pnpm exec turbo run test --filter=@bb/server --force --output-logs=errors-only 2>&1 | tee ~/phase1-posix-server.txt; echo "SERVER_EXIT=$?"; corepack pnpm exec turbo run test --filter=@bb/app --force --output-logs=errors-only 2>&1 | tee ~/phase1-posix-app.txt; echo "APP_EXIT=$?"'
```


### `@bb/server` alone

```
@bb/server:test:  Test Files  5 failed | 233 passed | 2 skipped (240)
@bb/server:test:       Tests  8 failed | 2429 passed | 1 skipped (2438)
 Tasks:    7 successful, 8 total
Failed:    @bb/server#test
SERVER_EXIT=1
```

Failing files:

```
test/app/install-machine-script.test.ts
test/provider-corpus/timeline-perf.test.ts
test/services/plugin-catalog/bb-official-generator.test.ts
test/services/threads/timeline-event-budget.test.ts
test/services/threads/timeline-in-turn-window.test.ts
```

Reasons:

```
      3 @bb/server:test: Error: Test timed out in 5000ms.
      3 @bb/server:test: Error: Test timed out in 15000ms.
      1 @bb/server:test: AssertionError: expected { …(2) } to deeply equal { …(2) }
      1 @bb/server:test: AssertionError: expected 2309.9 to be less than 1500
```

The one non-timing assertion is a date-format difference, not a path or platform behaviour:

```
 FAIL   @bb/server  test/services/plugin-catalog/bb-official-generator.test.ts > bb-official marketplace generator > uses the first and last committer dates from plugin history
AssertionError: expected { …(2) } to deeply equal { …(2) }

- Expected
+ Received

  {
-   "publishedAt": "2026-01-02T03:04:05Z",
-   "updatedAt": "2026-02-03T04:05:06Z",
+   "publishedAt": "2026-01-02T03:04:05+00:00",
+   "updatedAt": "2026-02-03T04:05:06+00:00",
  }
```

### `@bb/app` alone

```
@bb/app:test:  Test Files  1 failed | 506 passed (507)
@bb/app:test:       Tests  1 failed | 4331 passed | 4 skipped (4336)
 Tasks:    4 successful, 5 total
  Time:    3m36.712s
Failed:    @bb/app#test
APP_EXIT=1
```

All 507 files ran (against 500 in the degraded re-run), in 3m36s against 23m58s, and exactly one test failed:

```
 FAIL   @bb/app:isolated  src/views/ToolsView.plugin-detail.test.tsx > BB Official plugin detail routing > preserves Browse and restores card focus across the real app routes
TestingLibraryElementError: Unable to find role="button" and name "Open GitHub details"
```

## Phase 0 versus Phase 1, file by file — the decisive comparison

The question the POSIX check exists to answer is whether this branch broke anything on POSIX. The six files
that still failed when each package ran alone were therefore run directly, by filename filter, at the Phase 0
head `779b0a127f2494582ecb7ebb9e25419886f3a7b6` and at this branch's head
`203acb2738135c9b7ab1e2824da949223aa0dbc1`, in the same clone, the same shell form, nothing else running.

### At Phase 0 (`779b0a127`)

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check && git checkout windows-native/phase-0 2>&1 | tail -2; echo "CHECKOUT=$?"; git rev-parse HEAD'
```
```
Switched to branch 'windows-native/phase-0'
Your branch is up to date with 'origin/windows-native/phase-0'.
CHECKOUT=0
779b0a127f2494582ecb7ebb9e25419886f3a7b6
```

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check/apps/app && set -o pipefail; corepack pnpm exec vitest run --config vitest.config.ts ToolsView.plugin-detail 2>&1 | sed -e "s/\x1b\[[0-9;]*m//g" | tail -20; echo "EXIT=$?"'
```
```
 ✓  @bb/app:isolated  src/views/ToolsView.plugin-detail.test.tsx (39 tests) 6426ms
     ...
     ✓ preserves Browse and restores card focus across the real app routes  1009ms
     ...
 Test Files  1 passed (1)
      Tests  39 passed (39)
   Duration  15.57s
EXIT=0
```

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check/apps/server && set -o pipefail; corepack pnpm exec vitest run --config vitest.config.ts install-machine-script timeline-perf bb-official-generator timeline-event-budget timeline-in-turn-window 2>&1 | sed -e "s/\x1b\[[0-9;]*m//g" | tail -25; echo "EXIT=$?"'
```
```
 Test Files  1 failed | 4 passed (5)
      Tests  1 failed | 76 passed (77)
   Duration  26.19s
EXIT=1
```
The one failure is `bb-official-generator.test.ts`, with the same `"…Z"` versus `"…+00:00"` diff quoted
above.

### At Phase 1 (`203acb273`)

```powershell
wsl.exe -e bash -lc '… git checkout windows-native/phase-1 …; git rev-parse HEAD; cd apps/server && set -o pipefail; corepack pnpm exec vitest run --config vitest.config.ts install-machine-script timeline-perf bb-official-generator timeline-event-budget timeline-in-turn-window 2>&1 | … | tail -12; echo "EXIT=$?"'
```
```
Switched to branch 'windows-native/phase-1'
Your branch is up to date with 'origin/windows-native/phase-1'.
203acb2738135c9b7ab1e2824da949223aa0dbc1
...
 Test Files  1 failed | 4 passed (5)
      Tests  1 failed | 76 passed (77)
   Duration  26.03s
EXIT=1
```

```powershell
wsl.exe -e bash -lc '… cd ~/bb-posix-check/apps/app && set -o pipefail; corepack pnpm exec vitest run --config vitest.config.ts ToolsView.plugin-detail 2>&1 | … | tail -18; echo "EXIT=$?"'
```
```
 ✓  @bb/app:isolated  src/views/ToolsView.plugin-detail.test.tsx (39 tests) 6359ms
     ...
     ✓ preserves Browse and restores card focus across the real app routes  1035ms
     ...
 Test Files  1 passed (1)
      Tests  39 passed (39)
   Duration  15.47s
EXIT=0
```

### Result

| file | Phase 0 (`779b0a127`) | Phase 1 (`203acb273`) |
|---|---|---|
| `apps/app/src/views/ToolsView.plugin-detail.test.tsx` | 39 passed | 39 passed |
| `apps/server/test/app/install-machine-script.test.ts` | pass | pass |
| `apps/server/test/provider-corpus/timeline-perf.test.ts` | pass | pass |
| `apps/server/test/services/plugin-catalog/bb-official-generator.test.ts` | **fail** (`Z` vs `+00:00`) | **fail** (identical diff) |
| `apps/server/test/services/threads/timeline-event-budget.test.ts` | pass | pass |
| `apps/server/test/services/threads/timeline-in-turn-window.test.ts` | pass | pass |

**Phase 1 introduces no POSIX regression.** Every file that failed in WSL either passes at both heads when
run on its own — meaning its full-suite failure was a vitest timeout or a pool-starvation artifact of this
machine, not behaviour — or fails identically at both heads. The single reproducible WSL failure,
`bb-official-generator.test.ts`, is pre-existing at the Phase 0 head and is an environment difference in the
committer-date format this WSL guest's git emits (`+00:00` instead of `Z`); nothing in Phase 1 touches that
generator.

## Step 7 verdict

- Eleven of the thirteen packages the brief lists pass outright in a single WSL run of the brief's exact
  command; the summariser table above is that run's.
- The remaining two (`@bb/app`, `@bb/server`) fail only on timing, and shrink to 1 and 5 files when each runs
  alone.
- File-by-file against the Phase 0 head, this branch changes nothing in WSL.

The literal wording "every listed package passes" is not met, because one pre-existing, environment-dependent
`@bb/server` file (`bb-official-generator.test.ts`) fails at both heads and because `@bb/app` and `@bb/server`
are timing-sensitive on this machine under load. The substantive question — did Phase 1 break POSIX — is
answered no, with the A/B table above as the evidence.


---

# Gate refresh at `6d8071e93` (POSIX) — 2026-09-13

Everything above this line is the original POSIX measurement at `203acb273`. This section re-checks POSIX
after the final fix round, because that round touched cross-platform code and not only Windows paths:
`packages/domain/src/host-path.ts` (the new `isBareDriveHostPath` classifier, `isWindowsHostPath` made
module-private, `dirnameHostPath` removed), `apps/app/src/lib/absolute-file-path.ts` (delegates to
`@bb/domain` now), `apps/host-daemon/src/command-handlers/canonicalize-path.ts` (`invalid_path` raised as
`ExpectedCommandDispatchError`) and `apps/server/src/services/plugins/manifest.ts` (the asset-guard
separator fix).

Measured SHA: `6d8071e93c026e4066209d0bb7ec5fd40a433e25` (one docs commit on top of the refresh evidence
commit `9a2109ad3`). Clone `~/bb-posix-check`, WSL2 Ubuntu-24.04, node v22.19.0, `corepack pnpm` 9.15.0.

## Fetch, checkout, install

```powershell
wsl.exe -e bash -lc 'cd ~/bb-posix-check && git fetch origin windows-native/phase-1; echo "FETCH=$?"'
```
```
FETCH=0
t/c/Users/olege/Work/bb
 * branch                windows-native/phase-1 -> FETCH_HEAD
   203acb273..6d8071e93  windows-native/phase-1 -> origin/windows-native/phase-1
```

(`origin` for this clone is the Windows checkout at `/mnt/c/Users/olege/Work/bb`, so the fetch reaches
`6d8071e93` even though the fork's branch head was still `9a2109ad3` at this point. The mangled first line
is the `wsl.exe` handle-forwarding artifact documented earlier in this file.)

```powershell
wsl.exe -e bash -lc 'cd ~/bb-posix-check && git checkout -q 6d8071e93; echo "CHECKOUT=$?"; git rev-parse HEAD; git status --porcelain | head -3'
```
```
CHECKOUT=0
6d8071e93c026e4066209d0bb7ec5fd40a433e25
```

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check && corepack pnpm install --frozen-lockfile 2>&1 | tail -8; echo "INSTALL_EXIT=${PIPESTATUS[0]}"'
```
```
. prepare: Cached:    3 cached, 4 total
. prepare:   Time:    598ms
. prepare: Done
 WARN  Failed to create bin at /home/olege/bb-posix-check/apps/desktop/node_modules/.bin/bb-app. ENOENT: no such file or directory, open '/home/olege/bb-posix-check/apps/desktop/node_modules/bb-app/dist/bb-app.js'
 WARN  Failed to create bin at /home/olege/bb-posix-check/apps/desktop/node_modules/.bin/bb. ENOENT: no such file or directory, open '/home/olege/bb-posix-check/apps/desktop/node_modules/bb-app/dist/bb.js'
 WARN  Failed to create bin at /home/olege/bb-posix-check/apps/desktop/node_modules/.bin/bb-server. ENOENT: no such file or directory, open '/home/olege/bb-posix-check/apps/desktop/node_modules/bb-app/dist/bb-server.js'
 WARN  Failed to create bin at /home/olege/bb-posix-check/apps/desktop/node_modules/.bin/bb-host-daemon. ENOENT: no such file or directory, open '/home/olege/bb-posix-check/apps/desktop/node_modules/bb-app/dist/bb-host-daemon.js'
Done in 11.4s
INSTALL_EXIT=0
```

## Test run

Run as a background job; `set -o pipefail` first so the prescribed `echo "EXIT=$?"` reports the Turbo
pipeline's status rather than `tee`'s:

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check && set -o pipefail; corepack pnpm exec turbo run test --filter=@bb/domain --filter=@bb/host-daemon-contract --filter=@bb/server-contract --filter=@bb/host-daemon --filter=@bb/server --filter=@bb/app 2>&1 | tee ~/phase1-posix-refresh.txt; echo "EXIT=$?"'
```

```
 Tasks:    11 successful, 13 total
Cached:    4 cached, 13 total
  Time:    7m24.391s
Failed:    @bb/app#test

 ERROR  run failed: command  exited (1)
EXIT=1
```

### Per-package pass/fail

The summariser cannot be used for this run: the command carries no `--summarize`, so Turbo wrote no run
summary, and `summarize-turbo-run.mjs` reads the newest JSON in `.turbo/runs` — which here is
`3JGsBrdLuFPjGSHEjaGzw899Yes.json` dated `2026-09-13T14:23`, the earlier degraded re-run, not this one:

```powershell
wsl.exe -e bash -lc 'ls -lt --time-style=+%Y-%m-%dT%H:%M ~/bb-posix-check/.turbo/runs | head -4'
```
```
total 668
-rw-r--r-- 1 olege olege 279199 2026-09-13T14:23 3JGsBrdLuFPjGSHEjaGzw899Yes.json
-rw-r--r-- 1 olege olege 397618 2026-09-13T13:39 3JGmneWG33RrjZuQx93SwQc9joE.json
```

Running it would have reported a stale, unrelated result, so the table below comes from the vitest summary
lines in this run's own output, as the refresh instructions allow:

```powershell
wsl.exe -e bash -lc 'sed -e "s/\x1b\[[0-9;]*m//g" ~/phase1-posix-refresh.txt > /tmp/r-clean.txt; grep -E "Test Files |      Tests " /tmp/r-clean.txt'
```
```
@bb/domain:test:  Test Files  34 passed (34)
@bb/domain:test:       Tests  213 passed (213)
@bb/host-daemon-contract:test:  Test Files  4 passed (4)
@bb/host-daemon-contract:test:       Tests  56 passed (56)
@bb/server-contract:test:  Test Files  7 passed (7)
@bb/server-contract:test:       Tests  67 passed (67)
@bb/host-daemon:test:  Test Files  52 passed (52)
@bb/host-daemon:test:       Tests  606 passed | 2 skipped (608)
@bb/app:test:  Test Files  4 failed | 503 passed (507)
@bb/app:test:       Tests  5 failed | 4342 passed | 4 skipped (4351)
```

| package | test task | files | tests |
|---|---|---|---|
| @bb/domain | **pass** | 34 passed (34) | 213 passed (213) |
| @bb/host-daemon-contract | **pass** | 4 passed (4) | 56 passed (56) |
| @bb/server-contract | **pass** | 7 passed (7) | 67 passed (67) |
| @bb/host-daemon | **pass** | 52 passed (52) | 606 passed, 2 skipped (608) |
| @bb/app | fail | 4 failed \| 503 passed (507) | 5 failed \| 4342 passed \| 4 skipped (4351) |
| @bb/server | **did not finish** — see below | — | — |

`@bb/domain` and `@bb/host-daemon` are the two packages the fix round changed most on the POSIX side
(`host-path.ts`'s new classifier; `canonicalize-path.ts`'s expected-error class). Both are fully green in
WSL: 34/34 and 52/52 files.

### `@bb/server` was cut off, not failing

The prescribed command has no `--continue`, so when `@bb/app#test` failed Turbo stopped the run and killed
the in-flight `@bb/server#test` — which is why the footer reads `11 successful, 13 total` with only one
task in `Failed:`, and why `@bb/server` has no vitest summary. Its output is present in the log up to the
point it was killed, with no summary line:

```powershell
wsl.exe -e bash -lc 'grep -nE "@bb/server:test: *(Test Files|      Tests )" /tmp/r-clean.txt | tail -5; echo "--- last server lines ---"; grep -n "@bb/server:test" /tmp/r-clean.txt | tail -2'
```
```
--- last server lines ---
3773:@bb/server:test:      ✓ refuses an npm package whose derived id shadows a builtin before install  536ms
3774:@bb/server:test:      ✓ the bb plugin new scaffold installs and loads through the plugin service  2167ms
```

It was therefore re-run on its own, with `--force`:

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check && set -o pipefail; corepack pnpm exec turbo run test --filter=@bb/server --force --output-logs=errors-only 2>&1 | tee ~/phase1-posix-refresh-server.txt; echo "EXIT=$?"'
```
```
@bb/server:test:  Test Files  5 failed | 233 passed | 2 skipped (240)
@bb/server:test:       Tests  5 failed | 2439 passed | 1 skipped (2445)
 Tasks:    7 successful, 8 total
Failed:    @bb/server#test
EXIT=1
```

## The failures, each re-run alone

### `@bb/app` — 4 files, all pass in isolation

```
src/components/plugin/management/BrowsePluginsTab.test.tsx
src/components/secondary-panel/FilePreview.test.tsx
src/components/thread/timeline/TimelineRowDetails.output-preview.test.tsx
src/components/ui/bottom-anchored-scroll-body.scroll-preservation.test.tsx
```
```
      1 @bb/app:test: TestingLibraryElementError: Unable to find role="heading" and name "New & notable"
      1 @bb/app:test: TestingLibraryElementError: Unable to find role="button" and name `/retry/i`
      1 @bb/app:test: TestingLibraryElementError: Unable to find an element by: [data-testid="pierre-file"]
      1 @bb/app:test: AssertionError: expected null not to be null
      1 @bb/app:test: AssertionError: expected 400 to be 300 // Object.is equality
```

Every one is the expiring-`findBy*` / timing shape this file already characterised. Re-run together on
their own:

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check/apps/app && set -o pipefail; corepack pnpm exec vitest run --config vitest.config.ts BrowsePluginsTab FilePreview TimelineRowDetails.output-preview bottom-anchored-scroll-body.scroll-preservation 2>&1 | sed -e "s/\x1b\[[0-9;]*m//g" | tail -14; echo "EXIT=$?"'
```
```
 ✓  @bb/app:isolated  src/components/plugin/management/BrowsePluginsTab.test.tsx (16 tests) 4589ms
     ...
 Test Files  4 passed (4)
      Tests  68 passed (68)
   Duration  9.79s
EXIT=0
```

**All four pass, 68/68.**

### `@bb/server` — 5 files, four pass in isolation

```
test/provider-corpus/timeline-perf.test.ts
test/public/public-thread-data.test.ts
test/services/plugin-catalog/bb-official-generator.test.ts
test/services/threads/timeline-event-budget.test.ts
test/services/threads/timeline-in-turn-window.test.ts
```
```
      2 @bb/server:test: Error: Test timed out in 5000ms.
      1 @bb/server:test: Error: Test timed out in 10000ms.
      1 @bb/server:test: AssertionError: expected { …(2) } to deeply equal { …(2) }
      1 @bb/server:test: AssertionError: expected 1678.1000000000001 to be less than 1500
```

```powershell
wsl.exe -e bash -lc 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 22.19.0 >/dev/null 2>&1; cd ~/bb-posix-check/apps/server && set -o pipefail; corepack pnpm exec vitest run --config vitest.config.ts timeline-perf public-thread-data bb-official-generator timeline-event-budget timeline-in-turn-window 2>&1 | sed -e "s/\x1b\[[0-9;]*m//g" | tail -16; echo "EXIT=$?"'
```
```
 ❯ test/services/plugin-catalog/bb-official-generator.test.ts:187:33
    185|     });
    186|
    187|     expect(dates.get("sample")).toEqual({
       |                                 ^
    188|       publishedAt: "2026-01-02T03:04:05Z",
    189|       updatedAt: "2026-02-03T04:05:06Z",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 4 passed (5)
      Tests  1 failed | 136 passed (137)
   Duration  28.31s
EXIT=1
```

**Four of the five pass.** The one that does not is `bb-official-generator.test.ts`, failing on exactly the
committer-date format assertion (`"…Z"` expected, `"…+00:00"` received) that the A/B section above already
showed fails **identically at the Phase 0 head `779b0a127`** — an environment difference in this WSL
guest's git, unrelated to any commit on this branch.

## Comparison against the earlier WSL A/B

| file | Phase 0 `779b0a127` | Phase 1 `203acb273` | this head `6d8071e93` |
|---|---|---|---|
| `apps/server/test/services/plugin-catalog/bb-official-generator.test.ts` | **fail** (`Z` vs `+00:00`) | **fail** (identical) | **fail** (identical) |
| `apps/server/test/provider-corpus/timeline-perf.test.ts` | pass alone | pass alone | pass alone |
| `apps/server/test/services/threads/timeline-event-budget.test.ts` | pass alone | pass alone | pass alone |
| `apps/server/test/services/threads/timeline-in-turn-window.test.ts` | pass alone | pass alone | pass alone |
| `apps/server/test/public/public-thread-data.test.ts` | (not failing then) | (not failing then) | pass alone |
| `apps/server/test/app/install-machine-script.test.ts` | pass alone | pass alone | not failing now |
| `apps/app/src/views/ToolsView.plugin-detail.test.tsx` | 39 passed | 39 passed | not failing now |
| `apps/app/src/components/…/BrowsePluginsTab.test.tsx` | (not failing then) | (not failing then) | pass alone |
| `apps/app/src/components/secondary-panel/FilePreview.test.tsx` | — | failed under load | pass alone |
| `apps/app/src/components/thread/timeline/TimelineRowDetails.output-preview.test.tsx` | — | failed under load | pass alone |
| `apps/app/src/components/ui/bottom-anchored-scroll-body.scroll-preservation.test.tsx` | — | failed under load | pass alone |

Which files land in the load-sensitive set shifts run to run — that is what "load-sensitive" means — but the
set of files that fail *reproducibly* has not changed: it is still exactly
`bb-official-generator.test.ts`, and it still fails the same way at the Phase 0 head.

## Verdict

**No POSIX regression at `6d8071e93`.** Four of the six packages — including `@bb/domain` and
`@bb/host-daemon`, the two the fix round changed most on the POSIX side — are completely green
(34/34, 4/4, 7/7, 52/52 files). Every failure in `@bb/app` and `@bb/server` is either a vitest
timeout/`findBy*` expiry that passes when the file is run on its own, or the single pre-existing
`bb-official-generator.test.ts` date-format failure that this file already proved fails identically at the
Phase 0 head.

