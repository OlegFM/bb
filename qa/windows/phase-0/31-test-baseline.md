# Test baseline (task 11, fix round 1)

Date: 2026-09-12
node -v: v22.19.0
git rev-parse HEAD: 363e830c0c37d667935e4759919d59993069b49a
Machine: reference desktop, Windows 11 Pro 10.0.26200

Command:

```powershell
pnpm exec turbo run test --continue --summarize --output-logs=errors-only 2>&1 | Tee-Object qa/windows/phase-0/31-test-output.txt
node qa/windows/scripts/summarize-turbo-run.mjs | Tee-Object qa/windows/phase-0/31-test-baseline.md
```

Run in the background (90-minute cap, watched by a stall monitor for 15 minutes of no log growth). Finished normally in 10m42.812s — no stall. `EXIT=1` (turbo's own summary exit code — expected; failing test tasks are the baseline, not a gate failure).

`31-test-output.txt` was 2,147,395 bytes, over the 2 MB threshold; deleted and replaced with `31-test-output-tail.txt` (last 200 lines) after both tables below were extracted. The run summary JSON (`.turbo/runs/3JCZa7TiuAFLh046hYvAUA4NlUP.json`, 1,252,975 bytes) is over the 1 MB threshold, so it was **not** copied into the repo.

Turbo footer: `Tasks: 52 successful, 90 total`, `Cached: 50 cached, 90 total`, `Time: 10m42.812s`. 37 of 81 packages with a `test` task failed (down from 38).

## Previous run (9ca4e933a, pre-fix) for comparison

38 of 81 failed. Full tables in that commit's version of this file (`git show 9ca4e933a:qa/windows/phase-0/31-test-baseline.md`). Notable deltas from Tasks 11b/11d/11e:

- **`@bb/plugin-registry`: fail → pass.** It used to crash before vitest even ran (`build-registry.mjs --check` item-name collision); Task 11b's `path.posix` fix resolved that, and its `test` task is no longer in the failing list at all.
- **`@bb/scripts`: still fails, counts changed** (was 6 files / 15 tests failed; now 5 files / 10 tests failed). Task 11d removed the `codex` literal from `run-dev-app.ts` (fixing the provider-literal-ratchet failure this task's POSIX check found), and Task 11e made the ratchet CLI's own ratchet ratchet-CLI tests actually spawn the CLI on Windows instead of skipping/faking it, which changed which of that file's sub-tests pass. Net: fewer failures than before, but not zero — the remaining ones are pre-existing Windows-specific issues (see Table 2 below), not something this task's fix rounds targeted.
- **`@bb/sdk`: pass → fail** (1 file / 1 test now fails, `1/103`). New in this run; not something either fix round targeted or explained. Recorded here as an observed change, not investigated further (out of this task's scope to fix or root-cause product code).
- All other previously-failing packages are still failing at roughly the same magnitude (see Table 2); this task did not investigate whether their individual counts moved by a test or two run-to-run.

## Table 1: pass/fail per package (summariser output)

| package | test task |
|---|---|
| @bb/agent-runtime | fail (1) |
| @bb/app | fail (1) |
| @bb/cli | fail (1) |
| @bb/client-core | pass |
| @bb/config | fail (1) |
| @bb/connect | pass |
| @bb/connect-client | pass |
| @bb/connect-db | pass |
| @bb/core-ui | pass |
| @bb/db | pass |
| @bb/demo-server | pass |
| @bb/desktop | fail (1) |
| @bb/desktop-contract | pass |
| @bb/domain | pass |
| @bb/fuzzy-match | pass |
| @bb/hono-typed-routes | pass |
| @bb/host-daemon | fail (1) |
| @bb/host-daemon-contract | pass |
| @bb/host-watcher | fail (1) |
| @bb/host-workspace | fail (1) |
| @bb/integration-tests | fail (1) |
| @bb/local-open-targets | fail (1) |
| @bb/logger | fail (1) |
| @bb/mobile | fail (1) |
| @bb/mobile-bridge | pass |
| @bb/plugin-api-map | pass |
| @bb/plugin-build | fail (1) |
| @bb/plugin-interaction-contracts | pass |
| @bb/plugin-registry | pass |
| @bb/process-utils | fail (1) |
| @bb/provider-bridge-acp | fail (1) |
| @bb/provider-bridge-protocol | fail (1) |
| @bb/provider-parity | fail (1) |
| @bb/qa | fail (1) |
| @bb/scripts | fail (1) |
| @bb/sdk | fail (1) |
| @bb/secret-storage | fail (1) |
| @bb/server | fail (1) |
| @bb/server-contract | pass |
| @bb/templates | fail (1) |
| @bb/thread-view | pass |
| @bb/tunnel-client | pass |
| @bb/tunnel-contract | pass |
| @bb/web | pass |
| @get-bb/plugin-sdk | fail (1) |
| bb-app | fail (1) |
| bb-plugin-account-pool | fail (1) |
| bb-plugin-ask-user-question | pass |
| bb-plugin-automations | fail (1) |
| bb-plugin-bb-guide | pass |
| bb-plugin-browser-automation | fail (1) |
| bb-plugin-concurrency-limit | pass |
| bb-plugin-connect | pass |
| bb-plugin-custom-instructions | pass |
| bb-plugin-echo-provider | fail (1) |
| bb-plugin-environment-git-worktree | fail (1) |
| bb-plugin-environment-personal-workspace | fail (1) |
| bb-plugin-environment-project-checkout | fail (1) |
| bb-plugin-github | fail (1) |
| bb-plugin-inline-vis | pass |
| bb-plugin-keep-awake | pass |
| bb-plugin-memory | pass |
| bb-plugin-monaco-editor | pass |
| bb-plugin-pdf-preview | pass |
| bb-plugin-plugin-api-tester | pass |
| bb-plugin-provider-acp | pass |
| bb-plugin-provider-claude-code | fail (1) |
| bb-plugin-provider-codex | fail (1) |
| bb-plugin-provider-pi | fail (1) |
| bb-plugin-provider-retry | pass |
| bb-plugin-provider-usage | pass |
| bb-plugin-push-notifications | pass |
| bb-plugin-scheduled-send | pass |
| bb-plugin-scripted-echo-provider | pass |
| bb-plugin-secrets | pass |
| bb-plugin-side-chat | pass |
| bb-plugin-simple-notes | pass |
| bb-plugin-slack-bot | pass |
| bb-plugin-tasks | fail (1) |
| bb-plugin-theme-preview | pass |
| bb-plugin-workflows | fail (1) |

Source: C:\Users\olege\Work\bb\.turbo\runs\3JCZa7TiuAFLh046hYvAUA4NlUP.json

## Table 2: failing-test detail per failing package (vitest summary lines)

One row per package whose `test` task failed (37 packages). Counts parsed from each package's `Test Files` / `Tests` vitest summary line in the (now-deleted) `31-test-output.txt` with the same small script used in the original run, not hand-transcribed.

| package | test files (failed/passed) | tests (failed/passed) |
|---|---|---|
| @bb/agent-runtime | 4/18 | 12/306 |
| @bb/app | 10/496 | 22/4295 |
| @bb/cli | 10/45 | 23/543 |
| @bb/config | 1/6 | 8/101 |
| @bb/desktop | 6/36 | 14/309 |
| @bb/host-daemon | 21/28 | 65/524 |
| @bb/host-watcher | 2/4 | 4/43 |
| @bb/host-workspace | 4/4 | 22/140 |
| @bb/integration-tests | 24/5 | 69/12 |
| @bb/local-open-targets | 1/0 | 6/51 |
| @bb/logger | 1/0 | 2/5 |
| @bb/mobile | 2/44 | 5/326 |
| @bb/plugin-build | 5/5 | 9/132 |
| @bb/process-utils | 1/0 | 1/11 |
| @bb/provider-bridge-acp | 7/11 | 34/278 |
| @bb/provider-bridge-protocol | 1/19 | 1/237 |
| @bb/provider-parity | 1/0 | 49/7 |
| @bb/qa | 2/1 | 6/20 |
| @bb/scripts | 5/21 | 10/150 |
| @bb/sdk | 1/6 | 1/103 |
| @bb/secret-storage | 2/0 | 2/4 |
| @bb/server | 52/183 | 249/2140 |
| @bb/templates | 2/5 | 1/41 |
| @get-bb/plugin-sdk | 1/22 | 1/248 |
| bb-app | 2/3 | 9/71 |
| bb-plugin-account-pool | 1/9 | 1/278 |
| bb-plugin-automations | 3/5 | 9/71 |
| bb-plugin-browser-automation | 3/3 | 11/25 |
| bb-plugin-echo-provider | 2/4 | 3/12 |
| bb-plugin-environment-git-worktree | 1/3 | 8/28 |
| bb-plugin-environment-personal-workspace | 1/1 | 2/8 |
| bb-plugin-environment-project-checkout | 1/2 | 6/22 |
| bb-plugin-github | 2/6 | 9/37 |
| bb-plugin-provider-claude-code | 2/23 | 3/345 |
| bb-plugin-provider-codex | 6/21 | 16/256 |
| bb-plugin-provider-pi | 16/11 | 42/113 |
| bb-plugin-tasks | 1/35 | 1/387 |
| bb-plugin-workflows | 1/13 | 1/221 |
