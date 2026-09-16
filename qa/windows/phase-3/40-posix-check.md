# POSIX regression check in WSL (Phase 3 gate, Step 11)

Clone: `~/bb-posix-check` in WSL2 Ubuntu-24.04 — the same clone Phases 0–2 used, with `origin` =
`/mnt/c/Users/olege/Work/bb`.

> ## Verdict: **PASS** — no POSIX failure that is absent at `9a07e6994`.
>
> Typecheck 94/94 green. Every package in the brief's Step 11 list runs; the only test file that fails
> **deterministically** on Linux at this head —
> `apps/server/test/services/plugin-catalog/bb-official-generator.test.ts` — fails identically at the
> Phase 2 tip `9a07e6994`, measured in the same clone, on the same host, the same evening. Everything else
> that failed under load passed when re-run in isolation.

## Environment and incantation

Node is **not** on the guest's login PATH, and the inherited PATH carries `/mnt/c` entries where a bare
`pnpm`/`corepack` resolves to the **Windows** binary. Every command below therefore strips `/mnt/c` first,
exactly as `qa/windows/phase-2/40-posix-check.md:101` records:

```bash
wsl.exe -e bash -c 'export PATH=$(echo "$PATH" | tr ":" "\n" | grep -v "^/mnt/c" | paste -sd:);
  source ~/.nvm/nvm.sh; nvm use 24.20.0; cd ~/bb-posix-check && corepack pnpm exec turbo run <task> …'
```

Logs live under `~/` in the guest, not `/tmp`.

```
72605c43339500d2bba0168f9c4b2264ac97609f     # git rev-parse HEAD after the fetch
v24.20.0                                     # node
9.15.0                                       # corepack pnpm
```

The guest runs **Node 24.20.0** while the Windows host runs 22.19.0 — the same Node-major difference Phase 2
declared (`nvm`'s unpinned default in this guest resolves to 24). Every comparison below is therefore made
**against the same guest at `9a07e6994`**, never against the Windows numbers.

```bash
git fetch origin windows-native/phase-3 && git checkout -q FETCH_HEAD    # 72605c433
corepack pnpm install                                                   # INSTALL_EXIT=0, Done in 9.5s
```

### A host-capacity note, recorded because it cost this gate an hour

The first attempt ran `turbo run typecheck` at Turbo's default concurrency. The WSL VM climbed to **14.2 GB**
resident (host free memory fell to 1.58 GB of 31 GB), started thrashing, and the distro stopped accepting
new `wsl.exe` connections entirely (`Wsl/Service/0x8007274c`) for more than 25 minutes. The run was killed,
the distro terminated (`wsl.exe --terminate Ubuntu-24.04`, memory back to 3.95 GB), and every command below
was then run with **`--concurrency=4`**, which completes in about two minutes. There is no `.wslconfig` on
this host, so WSL2 takes its default ~50 % memory cap. This is a host capacity fact, not a product finding.

## Typecheck

```bash
corepack pnpm exec turbo run typecheck --concurrency=4 --output-logs=errors-only
```
```
 Tasks:    94 successful, 94 total
Cached:    42 cached, 94 total
  Time:    2m2.885s

TYPECHECK_EXIT=0
```

**94/94, exit 0** — including the four packages the gate's fix commits touched
(`bb-plugin-provider-codex`, `@bb/host-daemon`, `bb-app`, and the workflow file, which typecheck ignores).

## Batch 1 — 13 packages, all green

```bash
corepack pnpm exec turbo run test --continue --concurrency=4 --output-logs=errors-only \
  --filter=@bb/process-utils --filter=@bb/provider-bridge-protocol --filter=@bb/provider-bridge-acp \
  --filter=bb-plugin-provider-codex --filter=bb-plugin-provider-claude-code --filter=bb-plugin-provider-pi \
  --filter=bb-plugin-provider-acp --filter=@bb/host-watcher --filter=@bb/desktop --filter=bb-app \
  --filter=bb-plugin-environment-git-worktree --filter=bb-plugin-environment-personal-workspace --filter=@bb/cli
```
```
   • Packages in scope: @bb/cli, @bb/desktop, @bb/host-watcher, @bb/process-utils, @bb/provider-bridge-acp,
     @bb/provider-bridge-protocol, bb-app, bb-plugin-environment-git-worktree,
     bb-plugin-environment-personal-workspace, bb-plugin-provider-acp, bb-plugin-provider-claude-code,
     bb-plugin-provider-codex, bb-plugin-provider-pi
   • Running test in 13 packages

 Tasks:    18 successful, 18 total
Cached:    4 cached, 18 total
  Time:    1m19.02s

B1_EXIT=0
```

All thirteen pass, including the two packages whose Windows arms Phase 3 rewrote most heavily
(`@bb/process-utils`, `@bb/provider-bridge-acp`), all four provider plugins, `@bb/host-watcher`,
`@bb/desktop` and `bb-app`. The POSIX arms are untouched.

## Batch 2 — `@bb/host-daemon`

```bash
corepack pnpm exec turbo run test --continue --concurrency=4 --output-logs=new-only --filter=@bb/host-daemon
```
```
@bb/host-daemon:test:  Test Files  53 passed | 2 skipped (55)
@bb/host-daemon:test:       Tests  680 passed | 18 skipped (698)
 Tasks: 7 successful, 7 total
 Time: 19.184s

B2_EXIT=0
```

The package passes whole, so the brief's "file by file" fallback was not needed. This also confirms gate fix
`fd84ca436` (`apps/host-daemon/src/app.test.ts` now derives the expected provider `PATH`/`Path` key from
`process.platform`): on Linux the key is `PATH` and the two model-listing tests pass, exactly as before the
fix.

## Batch 3 — `@bb/app` and `@bb/server`

```bash
corepack pnpm exec turbo run test --continue --concurrency=4 --output-logs=new-only --filter=@bb/app --filter=@bb/server
```
```
@bb/app:test:     Test Files  5 failed | 502 passed (507)
@bb/app:test:          Tests  6 failed | 4348 passed | 4 skipped (4358)
@bb/server:test:  Test Files  9 failed | 229 passed | 2 skipped (240)
@bb/server:test:       Tests  16 failed | 2438 passed | 2 skipped (2456)
 Tasks: 7 successful, 9 total
 Time: 4m56.285s
 Failed: @bb/app#test, @bb/server#test

B3_EXIT=1
```

Both were re-run **in isolation**, which is the authoritative measurement (Phase 1 and Phase 2 both record
that full-load Turbo runs inflate failure counts through vitest fork-pool starvation).

### `@bb/app` — all five are load flakes

```bash
cd apps/app && corepack pnpm exec vitest run \
  src/views/SkillsView.test.tsx src/views/ToolsView.plugin-detail.test.tsx \
  src/components/secondary-panel/FilePreview.test.tsx \
  src/components/ui/bottom-anchored-scroll-body.scroll-preservation.test.tsx \
  src/components/plugin/management/BrowsePluginsTab.test.tsx
```
```
 Test Files  5 passed (5)
      Tests  138 passed (138)
APP_ISO_EXIT=0
```

### `@bb/server` — eight of nine are load flakes

```bash
cd apps/server && corepack pnpm exec vitest run \
  test/app/install-machine-script.test.ts test/provider-corpus/timeline-perf.test.ts \
  test/threads/system-message-taxonomy-stamping.test.ts \
  test/services/plugin-catalog/bb-official-generator.test.ts \
  test/services/plugins/update-resolver.test.ts test/services/threads/timeline-event-budget.test.ts \
  test/services/threads/timeline-in-turn-window.test.ts test/public/public-thread-data.test.ts \
  test/services/plugins/plugin-update.test.ts
```
```
 FAIL  @bb/server  test/services/plugin-catalog/bb-official-generator.test.ts
       > bb-official marketplace generator > uses the first and last committer dates from plugin history
 Test Files  1 failed | 8 passed (9)
      Tests  1 failed | 208 passed (209)
SERVER_ISO_EXIT=1
```

### The one deterministic failure is pre-existing

Same clone, same host, same evening, same command, at the Phase 2 tip:

```bash
git checkout -q 9a07e6994 && corepack pnpm install
cd apps/server && corepack pnpm exec vitest run test/services/plugin-catalog/bb-official-generator.test.ts
```
```
9a07e6994d797e6359da5e3f52b4a3bc3029adee
 FAIL  @bb/server  test/services/plugin-catalog/bb-official-generator.test.ts
       > bb-official marketplace generator > uses the first and last committer dates from plugin history
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
BASE_GEN_EXIT=1
```

Identical file, identical test name, identical outcome at the baseline. **Pre-existing, not a Phase 3
regression** — it reads committer dates out of the repository's own plugin history and this clone's history
does not satisfy it. It is not in any Windows-specific code path.

The clone was returned to the branch tip afterwards:

```
72605c43339500d2bba0168f9c4b2264ac97609f
RESTORE_EXIT=0
```

## Summary against the brief's Step 11 list

| package | POSIX result at `72605c433` | new since `9a07e6994`? |
|---|---|---|
| `@bb/process-utils` | pass | no |
| `@bb/host-daemon` | pass (53 files, 680 tests) | no |
| `@bb/provider-bridge-protocol` | pass | no |
| `@bb/provider-bridge-acp` | pass | no |
| `bb-plugin-provider-codex` | pass | no |
| `bb-plugin-provider-claude-code` | pass | no |
| `bb-plugin-provider-pi` | pass | no |
| `bb-plugin-provider-acp` | pass | no |
| `@bb/host-watcher` | pass | no |
| `@bb/desktop` | pass | no |
| `bb-app` | pass | no |
| `@bb/cli` | pass | no |
| `@bb/app` | pass in isolation (5 load flakes under load) | no |
| `@bb/server` | 1 file fails, and fails at the baseline too | **no** |
| `bb-plugin-environment-git-worktree` | pass | no |
| `bb-plugin-environment-personal-workspace` | pass | no |

The brief anticipated "`@bb/server` (known 2 pre-existing failing files)"; this run found **one**, which is
an improvement on that expectation, not a shortfall — the Phase 2 POSIX run recorded 6 failing `@bb/server`
files under load.
