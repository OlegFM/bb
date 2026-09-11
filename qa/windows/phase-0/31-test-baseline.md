# Test baseline (task 11)

Date: 2026-09-11
node -v: v22.19.0
git rev-parse HEAD (at test run time, confirmed by the Turbo run summary's `scm.sha`): 0eeb71c286cf701b921434a488ca11e1c86197bb
Machine: reference desktop, Windows 11 Pro 10.0.26200

Command:

```powershell
pnpm exec turbo run test --continue --summarize --output-logs=errors-only 2>&1 | Tee-Object qa/windows/phase-0/31-test-output.txt
```

Run in the background (90-minute cap, monitored for a 15-minute no-growth stall). It completed normally in 11m58s without stalling, so no process had to be killed and no `--filter` was re-run in isolation. `EXIT=1` (turbo's own summary exit code — expected, since failing test tasks are the baseline, not a gate failure).

`qa/windows/phase-0/31-test-output.txt` was 2,077,802 bytes, over the brief's 2 MB threshold (interpreting "2 MB" as 2,000,000 bytes, consistent with treating the run summary JSON's "1 MB" threshold below the same way); it was deleted and replaced with the last 200 lines in `qa/windows/phase-0/31-test-output-tail.txt`. Both tables below were extracted from the full log before it was deleted.

The Turbo run summary JSON (`Summary:` line pointed at `.turbo/runs/3JCJmN4A9Jbd1T1sT5hhkeoIRc1.json`, 1,245,572 bytes) is over the 1 MB threshold in amendment C, so it was **not** copied to `qa/windows/phase-0/31-turbo-run-summary.json`; `.turbo/` is gitignored so it remains only in the local Turbo cache.

Summariser field-shape check (per amendment A): opened the run summary JSON and compared a cache-`MISS` test task (e.g. `@bb/agent-runtime#test`) against the one cache-`HIT` test task (`@bb/plugin-api-map#test`). Both carry `execution.exitCode` with the same shape (`{ startTime, endTime, exitCode }`, plus `error` on failing tasks). `task.execution?.exitCode` in the summariser matches this shape correctly for both cached and freshly-executed tasks, so **no script change was needed**.

Turbo footer: `Tasks: 52 successful, 90 total`, `Cached: 8 cached, 90 total`, `Time: 11m58.025s`. 38 of 81 packages with a `test` task failed.

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
| @bb/plugin-registry | fail (1) |
| @bb/process-utils | fail (1) |
| @bb/provider-bridge-acp | fail (1) |
| @bb/provider-bridge-protocol | fail (1) |
| @bb/provider-parity | fail (1) |
| @bb/qa | fail (1) |
| @bb/scripts | fail (1) |
| @bb/sdk | pass |
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

Source: C:\Users\olege\Work\bb\.turbo\runs\3JCJmN4A9Jbd1T1sT5hhkeoIRc1.json

## Table 2: failing-test detail per failing package (vitest summary lines)

One row per package whose `test` task failed (38 packages). Counts are copied verbatim from each package's `Test Files` / `Tests` vitest summary line in the (now-deleted) `31-test-output.txt`, parsed with a small script rather than transcribed by hand.

`@bb/plugin-registry` failed before vitest ever ran: its `test` script is `node ./scripts/build-registry.mjs --check && vitest run --config vitest.config.ts`, and the `--check` step throws `Error: item name collision: "toggle" from both components\ui\toggle.tsx and components/ui/toggle.tsx` — the same Windows path-separator bug that failed `@bb/plugin-registry#typecheck` in `30-build-typecheck.txt`. It has no Test Files/Tests line and is listed separately below instead of in the table.

| package | test files (failed/passed) | tests (failed/passed) |
|---|---|---|
| @bb/agent-runtime | 4/18 | 12/306 |
| @bb/app | 10/497 | 18/4306 |
| @bb/cli | 11/44 | 25/541 |
| @bb/config | 1/6 | 8/101 |
| @bb/desktop | 6/36 | 14/309 |
| @bb/host-daemon | 21/28 | 65/524 |
| @bb/host-watcher | 2/4 | 4/43 |
| @bb/host-workspace | 4/4 | 23/139 |
| @bb/integration-tests | 24/5 | 69/12 |
| @bb/local-open-targets | 1/0 | 6/51 |
| @bb/logger | 1/0 | 2/5 |
| @bb/mobile | 2/44 | 5/326 |
| @bb/plugin-build | 3/7 | 3/138 |
| @bb/plugin-registry | crashed before vitest ran (see note above) | crashed before vitest ran (see note above) |
| @bb/process-utils | 1/0 | 1/11 |
| @bb/provider-bridge-acp | 7/11 | 28/284 |
| @bb/provider-bridge-protocol | 1/19 | 1/237 |
| @bb/provider-parity | 1/0 | 48/8 |
| @bb/qa | 2/1 | 8/18 |
| @bb/scripts | 6/20 | 15/144 |
| @bb/secret-storage | 2/0 | 2/4 |
| @bb/server | 44/191 | 222/2167 |
| @bb/templates | 1/6 | 0/42 |
| @get-bb/plugin-sdk | 1/22 | 1/248 |
| bb-app | 2/3 | 9/71 |
| bb-plugin-account-pool | 1/9 | 1/278 |
| bb-plugin-automations | 3/5 | 9/71 |
| bb-plugin-browser-automation | 3/3 | 11/25 |
| bb-plugin-echo-provider | 2/4 | 3/12 |
| bb-plugin-environment-git-worktree | 1/3 | 8/28 |
| bb-plugin-environment-personal-workspace | 1/1 | 2/8 |
| bb-plugin-environment-project-checkout | 1/2 | 6/22 |
| bb-plugin-github | 2/6 | 10/36 |
| bb-plugin-provider-claude-code | 2/23 | 3/345 |
| bb-plugin-provider-codex | 7/20 | 18/254 |
| bb-plugin-provider-pi | 16/11 | 42/113 |
| bb-plugin-tasks | 1/35 | 1/387 |
| bb-plugin-workflows | 1/13 | 1/221 |

## Comparison against the earlier order-of-magnitude hints

Amendment C gave rough earlier-task figures for four packages, explicitly "do not copy, measure." Measured here:

| package | amendment hint | measured |
|---|---|---|
| @bb/scripts | 13 failed tests / 5 files | 15 failed tests / 6 files |
| @bb/agent-runtime | 138 failed / 180 passed | 12 failed / 306 passed |
| @bb/process-utils | 1 failed | 1 failed |
| @bb/plugin-build | 1 failed | 3 failed |

`@bb/scripts`, `@bb/process-utils`, and `@bb/plugin-build` are the same order of magnitude as the hint. `@bb/agent-runtime` is not (12 measured vs. ~138 hinted, an 11x difference) — plausibly because Tasks 1-10 on this branch (session-host, path-separator, and process-spawning fixes) already fixed most of what was failing when the hint was written, but this is a guess, not something verified in this task; flagged for the controller.

## Stalled

No stall: the run completed in 11m58s against the 90-minute cap, and the log kept growing throughout (confirmed by the background stall monitor, which was stopped once the run finished normally without ever detecting 15 minutes of no growth).
