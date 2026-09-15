# POSIX regression check in WSL (Phase 2 gate, Step 11)

Clone: `~/bb-posix-check` in WSL2 Ubuntu-24.04 (the same clone Phase 0 and Phase 1 used).
Checked-out SHA, read back from the clone at the end of this gate:

```bash
wsl.exe -e bash -c 'cd ~/bb-posix-check && git rev-parse HEAD > /tmp/p2head.txt; cat /tmp/p2head.txt'
wsl.exe -e bash -c 'cd ~/bb-posix-check && git log --oneline -1 > /tmp/p2log.txt; cat /tmp/p2log.txt'
```
```
7d0603bb4777132efd0e122ffc6d8064105333be
7d0603bb4 Narrow the pid-reused skip and .ps1 mapping claims in the Phase 2 docs
```

— the same commit measured on Windows in `30-build-typecheck.txt` and `31-test-results.md`.

## Environment caveats — stated up front

Two honest differences from the Phase 1 POSIX check, neither hidden:

1. **Node version.** Phase 1's WSL run used **v22.19.0** (`qa/windows/phase-1/40-posix-check.md`). The
   Phase 2 runs recorded below used **v24.20.0** — `nvm`'s `default -> lts/*` in this guest resolves to
   `N/A` and `node -> stable -> v24.20.0`, so an unpinned `nvm use` lands on 24. `v22.19.0` is still
   installed in the guest (`ls ~/.nvm/versions/node` → `v22.19.0`, `v24.20.0`). The Windows host ran
   v22.19.0 throughout. A Node-major difference can move test results on its own, so the comparison below
   is made **file by file against the Phase 1 POSIX run**, not by trusting aggregate counts.
2. **PATH.** The guest's inherited `PATH` carries `/mnt/c` entries, and a bare `pnpm`/`corepack` there
   resolves to the **Windows** binary — the first attempt failed with
   `/mnt/c/nvm4w/nodejs/corepack: cannot execute: required file not found`. Every command below therefore
   strips `/mnt/c` from `PATH` first:
   `export PATH=$(echo "$PATH" | tr ":" "\n" | grep -v "^/mnt/c" | paste -sd:)`.

## No differential path-identity re-run applies

`qa/windows/phase-1/40-posix-check.md` describes a 24-input differential check for path identity. **That
check has no Phase 2 equivalent seam.** Phase 2 touches processes, hooks, git invocation, secrets ACLs and
open targets — not path parsing — and `packages/domain/src/project-path.ts` is untouched between
`07fdce05b` and `7d0603bb4` apart from unrelated edits. No differential script was searched for or invented.

## Run 1 — at `604934bb1` (controller, recorded in `/tmp/bb-p2-posix.log`)

```
HEAD 604934bb1 node v24.20.0 pnpm 9.15.0 Linux 6.18.33.2-microsoft-standard-WSL2
== typecheck
 Tasks:    94 successful, 94 total
Cached:    94 cached, 94 total
  Time:    117ms >>> FULL TURBO

typecheck exit 0
== tests
• turbo 2.10.12

   • Packages in scope: @bb/cli, @bb/config, @bb/domain, @bb/host-workspace, @bb/local-open-targets, @bb/process-utils, @bb/secret-storage, @bb/templates, bb-app, bb-environment-provider-host, bb-plugin-automations, bb-plugin-environment-git-worktree, bb-plugin-github, bb-plugin-provider-claude-code
   • Running test in 14 packages
   • Remote caching disabled


 Tasks:    20 successful, 20 total
Cached:    18 cached, 20 total
  Time:    4.653s 

tests exit 0
```

**Typecheck 94/94, tests 20/20 across 14 packages, both exit 0.**

## Run 2 — at `7d0603bb4`, the gate head (controller, `/tmp/bb-p2-posix-final.log`)

```
HEAD 7d0603bb4
== typecheck
Cached:    36 cached, 94 total
  Time:    2m29.179s 

typecheck exit 0
== tests
• turbo 2.10.12

   • Packages in scope: @bb/cli, @bb/local-open-targets, @bb/plugin-api-map, @bb/templates, bb-plugin-automations, bb-plugin-provider-claude-code
   • Running test in 6 packages
   • Running test in 6 packages
   • Remote caching disabled


 Tasks:    12 successful, 12 total
Cached:    4 cached, 12 total
  Time:    1m9.518s 

tests exit 0
```

**Typecheck exit 0 across all 94 tasks; tests 12/12 across the 6 packages the final fix touched.**

## Run 3 — the gap the two runs above left, closed by this gate

The addenda's Step 11 list names **`@bb/host-daemon` (file by file)** among the packages to check on POSIX.
Neither controller run had it in scope — run 1 covered 14 packages and run 2 covered 6, and `@bb/host-daemon`
and `@bb/server` are in neither. Both were therefore run here:

```bash
wsl.exe -e bash -c 'export PATH=$(echo "$PATH" | tr ":" "\n" | grep -v "^/mnt/c" | paste -sd:); source ~/.nvm/nvm.sh; nvm use 24.20.0; cd ~/bb-posix-check && corepack pnpm exec turbo run test --continue --force --output-logs=errors-only --filter=@bb/host-daemon --filter=@bb/server > /tmp/p2-posix-extra.log 2>&1; echo "EXIT=$?"'
```
```
@bb/server:test:  Test Files  6 failed | 232 passed | 2 skipped (240)
 Tasks:    8 successful, 9 total
   Time:    3m56.216s 
 Failed:    @bb/server#test
EXIT=1
```

- **`@bb/host-daemon` passes on POSIX at this head.** It is not in `Failed:`, and 8 of 9 tasks succeeded
  with only `@bb/server#test` failing. This closes the addenda's named gap.
- **`@bb/server` fails 6 files.** File list, verbatim:

```
test/app/install-machine-script.test.ts > machine install script > starts a fresh macOS launch agent once and replaces it with one new process
test/app/install-machine-script.test.ts > machine install script > treats launch-agent readiness as authoritative after bootstrap
test/provider-corpus/timeline-perf.test.ts > timeline build micro-benchmark > projects every page of a 10000-event thread under 1500 ms
test/services/plugin-catalog/bb-official-generator.test.ts > bb-official marketplace generator > uses the first and last committer dates from plugin history
test/services/plugins/plugin-authoring-docs.test.ts > bb-plugin-authoring skill > accounts for every public backend and provider entrypoint export
test/services/threads/timeline-event-budget.test.ts > timeline event budget > preserves canonical rows through the client merge with tiny event windows
test/services/threads/timeline-in-turn-window.test.ts > in-turn timeline windows > keeps latest byte-page row identities stable while a turn grows
```

### Comparison against the Phase 1 POSIX run — one file is new, and it is a Phase 2 regression

`qa/windows/phase-1/40-posix-check.md` records `@bb/server` failing **seven** files in WSL at the Phase 1
head:

```
test/app/install-machine-script.test.ts
test/provider-corpus/timeline-perf.test.ts
test/public/public-thread-data.test.ts
test/services/plugin-catalog/bb-official-generator.test.ts
test/services/plugins/plugin-update.test.ts
test/services/threads/timeline-event-budget.test.ts
test/services/threads/timeline-in-turn-window.test.ts
```

| file | Phase 1 POSIX | Phase 2 POSIX | verdict |
|---|---|---|---|
| `test/app/install-machine-script.test.ts` | fail | fail | pre-existing (macOS launch agent on Linux) |
| `test/provider-corpus/timeline-perf.test.ts` | fail | fail | pre-existing (perf budget) |
| `test/public/public-thread-data.test.ts` | fail | **pass** | improved |
| `test/services/plugin-catalog/bb-official-generator.test.ts` | fail | fail | pre-existing (committer dates) |
| `test/services/plugins/plugin-update.test.ts` | fail | **pass** | improved |
| `test/services/threads/timeline-event-budget.test.ts` | fail | fail | pre-existing (timing) |
| `test/services/threads/timeline-in-turn-window.test.ts` | fail | fail | pre-existing (timing) |
| **`test/services/plugins/plugin-authoring-docs.test.ts`** | **pass** | **FAIL** | **newly failing — Phase 2 regression** |

7 − 2 + 1 = 6. **Exactly one POSIX file newly fails, and it is the same
`ExperimentalProcessWithCwd is not documented in the skill` regression `31-test-results.md` records on
Windows.** Its POSIX failure text, from `/tmp/p2-authoring-posix.log`:

```bash
corepack pnpm --filter @bb/server exec vitest run test/services/plugins/plugin-authoring-docs.test.ts
```
```
 ❯ test/services/plugins/plugin-authoring-docs.test.ts:570:63
    568|   it("accounts for every public backend and provider entrypoint export…
    569|     for (const name of PUBLIC_PLUGIN_SDK_EXPORT_NAMES) {
    570|       expect(skill, `${name} is not documented in the skill`).toContai…
       |                                                               ^
    571|     }
    572|   });

 Test Files  1 failed (1)
      Tests  1 failed | 21 passed (22)
   Duration  1.02s
EXIT=1
```

Deterministic in 1.02 s, on Linux, on node v24.20.0. The same file passes **22/22** at the Phase 1 base on
Windows (`31-test-results.md`), and `ExperimentalProcessWithCwd` does not exist at `07fdce05b` at all
(`git grep -l ExperimentalProcessWithCwd 07fdce05b` → no matches), so it cannot have been failing there on
any platform. This is a platform-independent regression, not a Windows or WSL artifact.

### The Windows-only regression is confirmed Windows-only

The gate's second regression, `apps/host-daemon/src/plugin-host-manager.test.ts`
(`PATH` vs `Path`), was also checked here:

```bash
corepack pnpm --filter @bb/host-daemon exec vitest run src/plugin-host-manager.test.ts
```
```
 Test Files  1 passed (1)
      Tests  19 passed (19)
   Duration  11.88s
EXIT=0
```

**19/19 on Linux.** The POSIX arm of `sanitizeInheritedChildProcessEnv` is byte-identical, exactly as the
phase's no-shared-behaviour-change rule requires; only the win32 arm moved, and only the win32 host sees the
test's stale `PATH` expectation. That is the correct shape for the change and the wrong shape for the test.

## Verdict

**FAIL for this step**, under the addenda's own rule: *"Any POSIX failure not present at the Phase 1 head is
a gate FAIL."* One such failure exists —
`test/services/plugins/plugin-authoring-docs.test.ts > accounts for every public backend and provider
entrypoint export`.

Everything else about the POSIX leg is clean and is worth stating plainly, because the failure is narrow:

- typecheck **94/94, exit 0** at both `604934bb1` and `7d0603bb4`;
- tests **20/20** across 14 packages and **12/12** across 6 packages, both exit 0;
- **`@bb/host-daemon` passes** — the package that carries the phase's PowerShell hook work;
- two `@bb/server` files that failed on POSIX at the Phase 1 head now pass;
- no POSIX suite regressed for a behavioural reason: the one new failure is a **documentation-index
  omission** (a new exported SDK type never added to the `bb-plugin-authoring` skill's backend symbol
  index), not a change in runtime behaviour.

Per the gate's standing instruction, this is recorded and **not fixed**.

---

# Gate run 2 — POSIX at `3e077adff` (2026-09-15)

Everything above measures gate run 1 (its own runs 1–3, at `604934bb1` and `7d0603bb4`). This section
measures the head after the three fix commits.

## Why this is a fresh run rather than a reading of the controller's log

The controller's post-fix POSIX log was named as `/tmp/bb-p2-posix-postgate.log` in the WSL guest. **It could
not be read, and it no longer exists.** WSL was in a failed state when gate run 2 started — every
`wsl.exe` invocation returned `Wsl/Service/E_UNEXPECTED` (a boot failure), which is also what hung
`@bb/scripts` for 24 minutes during Step 3 (`31-test-results.md`, "Method note"). Recovering it required
`wsl.exe --shutdown`, and the guest's `systemd` clears `/tmp` on boot, so all three earlier logs
(`bb-p2-posix.log`, `bb-p2-posix-final.log`, `bb-p2-posix-postgate.log`) were gone by the time the guest came
back:

```
$ ls -la /tmp/bb-p2-posix*.log
ls: cannot access '/tmp/bb-p2-posix*.log': No such file or directory
```

Rather than restate numbers from a log that cannot be produced, the whole check was re-run here from
scratch. The clone was fast-forwarded from the controller's `40c58854a` to the gate head first:

```bash
cd ~/bb-posix-check && git fetch origin windows-native/phase-2 && git checkout -q FETCH_HEAD
   40c58854a..3e077adff  windows-native/phase-2 -> origin/windows-native/phase-2
```

## Environment

Same guest and the same two caveats as gate run 1 (Node 24 in the guest vs 22 on the host; `/mnt/c` stripped
from `PATH`). Recorded at the top of the run:

```
HEAD 3e077adff799c5e54663bc1a9af0b51d2a97c51e
node v24.20.0 pnpm 9.15.0 Linux 6.18.33.2-microsoft-standard-WSL2
```

## Typecheck

```bash
corepack pnpm exec turbo run typecheck --output-logs=errors-only
```
```
 Tasks:    94 successful, 94 total
Cached:    94 cached, 94 total
  Time:    140ms >>> FULL TURBO
typecheck exit 0
```

**94/94, exit 0.**

## Tests — the five packages the fixes touch

```bash
corepack pnpm exec turbo run test --continue --force --output-logs=errors-only \
  --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/local-open-targets \
  --filter=bb-plugin-bb-guide --filter=@bb/templates
```
```
@bb/server:test:  Test Files  2 failed | 236 passed | 2 skipped (240)
@bb/server:test:       Tests  2 failed | 2452 passed | 2 skipped (2456)
@bb/server:test:    Duration  145.66s
 Tasks:    11 successful, 12 total
Cached:    0 cached, 12 total
   Time:    3m9.479s
 Failed:    @bb/server#test
tests exit 1
```

**11 of 12 tasks green**, everything forced (`Cached: 0`). `@bb/host-daemon`, `@bb/local-open-targets`,
`bb-plugin-bb-guide` and `@bb/templates` all pass on POSIX at this head. `@bb/server` fails **2 files**,
down from gate run 1's **6**.

## The two Phase 2 regressions on Linux

Both files were run directly, not inferred from the package total:

```bash
corepack pnpm --filter @bb/server exec vitest run test/services/plugins/plugin-authoring-docs.test.ts
corepack pnpm --filter @bb/host-daemon exec vitest run src/plugin-host-manager.test.ts
```
```
 Test Files  1 passed (1)    Tests  22 passed (22)    Duration  314ms     authoring-docs exit 0
 Test Files  1 passed (1)    Tests  20 passed (20)    Duration  5.22s     plugin-host-manager exit 0
```

- `plugin-authoring-docs.test.ts` was the **platform-independent** regression; gate run 1 measured it failing
  on Linux as well. It is **22/22 green on Linux** here — the same count the Windows host reports.
- `plugin-host-manager.test.ts` was the **Windows-only** regression; it was green on Linux at 19 tests before
  and is green at **20** now. The extra case (`builds a single Path key for the login-shell PATH on Windows`)
  is not `runIf`-gated — it passes an explicit `platform: "win32"` to
  `sanitizeInheritedChildProcessEnv`, so it runs and passes on **both** platforms. That is the stronger
  arrangement: the win32 arm now has POSIX coverage too, and the POSIX arm is pinned rather than
  platform-dependent.

## The remaining two `@bb/server` files, and the flake classification

```
FAIL  @bb/server  test/services/plugin-catalog/bb-official-generator.test.ts > bb-official marketplace generator > uses the first and last committer dates from plugin history
FAIL  @bb/server  test/services/threads/timeline-event-budget.test.ts > timeline event budget > preserves canonical rows through the client merge with tiny event windows
```

**Both were already failing in gate run 1's POSIX run 3** — they are two of the six files listed above, so
neither is new and neither can be attributed to the fix commits. Gate run 1's other four
(`install-machine-script.test.ts`, `timeline-perf.test.ts`, `timeline-in-turn-window.test.ts` and
`plugin-authoring-docs.test.ts`) are green here; only the last of those is a fix, the other three are the
same load-sensitive class described below.

### `bb-official-generator.test.ts` — a git-version rendering difference in the guest

```
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

The test expects git to render a committer date with a `Z` suffix; the guest's git renders the numeric
offset form:

```bash
$ git --version
git version 2.43.0
$ git log -1 --date=iso-strict --format='%cd'
2026-09-15T09:28:14+03:00
```

An ISO-8601 spelling difference produced by the guest's git, in a package nothing in Phase 2 touches. Not a
Phase 2 effect and not a Windows effect; recorded, not fixed.

### `timeline-event-budget.test.ts` — parallel-load flake, classified by isolation re-runs

Run twice, back to back, with nothing else running:

```bash
corepack pnpm --filter @bb/server exec vitest run test/services/threads/timeline-event-budget.test.ts   # x2
```
```
 Test Files  1 passed (1)    Tests  17 passed (17)    Duration  14.66s    teb-1 exit 0
 Test Files  1 passed (1)    Tests  17 passed (17)    Duration  15.57s    teb-2 exit 0
```

**17/17 both times, exit 0 both times**, against a failure inside a 240-file package run. The file is a
budget/ordering assertion over a synthetic event stream, its sibling `timeline-perf.test.ts` is an explicit
`under 1500 ms` micro-benchmark, and `timeline-in-turn-window.test.ts` is the third of the same family — all
three flip with scheduling pressure and all three are in gate run 1's POSIX list. Classification:
**parallel-load flake, unrelated to Phase 2.** This matches the same call made on the Windows side for
`builtin-plugins.test.ts` and `file-list.test.ts` (`31-test-results.md`), and it is made on the same
evidence — a timeout or budget failure under load, green on repeat in isolation.

## Step 11 run-2 verdict

**PASS.** Typecheck 94/94 exit 0; 11 of 12 test tasks green with nothing cached; `@bb/server`'s POSIX
failures down from 6 files to 2; both Phase 2 regressions confirmed fixed on Linux at their own files
(22/22 and 20/20); and the two files that remain were both already failing before the fixes — one a git
rendering difference in the guest, one a parallel-load flake that passes twice in isolation.

Method caveat, stated plainly: the controller's post-fix POSIX log was destroyed by the `wsl --shutdown`
needed to recover the guest, so nothing in this section is quoted from it. Every number above was produced
by the re-run recorded here, at `3e077adff`, and the raw log is
`/tmp/bb-p2-posix-run2.log` in the guest (copied to the agent scratchpad as `r2-posix.log`).
