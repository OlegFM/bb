# Windows CI run (task 11, fix round 1)

Date: 2026-09-12
node -v: v22.19.0 (this machine's own tools; the CI job uses its own runner-installed Node 22.x)
git rev-parse HEAD (the pushed and measured SHA): 363e830c0c37d667935e4759919d59993069b49a
Machine: reference desktop, Windows 11 Pro 10.0.26200 (dispatch/polling only; the job itself runs on `windows-2025`)

## Registration

The original `HTTP 404: workflow ci.yml not found on the default branch` from the first evidence round is resolved: Task 11c added a `windows-native/**` push-trigger branch to `ci.yml`, so `git push` of this branch now starts the workflow on its own — no `gh workflow run` needed. After the push-triggered run appeared, I also confirmed the fix directly: `gh workflow run ci.yml --ref windows-native/phase-0 -R OlegFM/bb` now succeeds and returns a run URL (`gh workflow list -R OlegFM/bb --all` also now lists `CI` as `active`, alongside `Version Lockstep`), whereas before it 404'd. (Full original root-cause trail — same-day fork, GitHub only registers a workflow once some event has actually triggered it — is preserved in the `git show 9ca4e933a:qa/windows/phase-0/40-ci-run.md` version of this file.)

**Caveat learned the hard way**: `ci.yml`'s `concurrency` group (`ci-${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress: true` off `main`) means dispatching a second run for the same branch while the push-triggered one is in flight cancels the first. My confirmation dispatch did exactly that to the run I needed to measure; I cancelled the stray dispatched run and used `gh run rerun` on the original run ID to get a clean, uninterrupted measurement instead of pushing another commit.

## Push and run

```bash
git push   # 9ca4e933a..363e830c0
```

`gh run list -R OlegFM/bb --branch windows-native/phase-0 --workflow ci.yml --limit 3` showed the push-triggered run (`34654743994`) for SHA `363e830c0...` within about a minute.

## Result

- Run URL: https://github.com/OlegFM/bb/actions/runs/34654743994
- Job: `Windows x64 (windows-2025, Node 22.x)` — **conclusion: success**
- Steps (all `success`; job ran 22:38:44Z-22:47:58Z, about 9m14s):

| step | conclusion |
|---|---|
| Set up job | success |
| Checkout repository | success |
| Set up pnpm | success |
| Set up Node.js | success |
| Install dependencies | success |
| Load native add-ons | success |
| Typecheck and build | success |
| Test (Windows baseline) | success |
| Upload Windows test run summaries | success |
| Post Set up Node.js | success |
| Post Set up pnpm | success |
| Post Checkout repository | success |
| Complete job | success |

The `Test (Windows baseline)` step's own `conclusion` is `success` because of its `continue-on-error: true` in `ci.yml` — that reports the job as unblocked, not that every test passed. The CI baseline table below (from the uploaded artifact) is the real signal, and it shows real failures, consistent with this task's local Windows run.

Overall run: I cancelled it (`gh run cancel 34654743994`) once the Windows job's own conclusion was set, so the Blacksmith-only jobs (checks/tests/smoke, all queued and unrunnable on this fork) stop consuming the queue; the run's overall `conclusion` is `cancelled`, which does not retroactively change the Windows job's already-recorded `success`.

Artifact: `windows-x64-test-results` (34,179 bytes, not expired).

## CI test baseline (from the artifact)

Downloaded via `gh run download 34654743994 -R OlegFM/bb -n windows-x64-test-results -D <scratch dir>` and summarised with `node qa/windows/scripts/summarize-turbo-run.mjs <scratch dir>`:

| package | test task |
|---|---|
| @bb/desktop | fail (1) |
| @bb/domain | pass |
| @bb/host-daemon | fail (1) |
| @bb/process-utils | fail (1) |
| @bb/scripts | fail (1) |

Source: C:\Users\olege\AppData\Local\Temp\claude\C--Users-olege-Work-bb\fae45475-6759-4fe1-972b-fb198493f6ff\scratchpad\ci-artifact-fix1\3JCZ5sQNuyXoxFaMJ3y5fbGHGj6.json

5 packages have a `test` task in this filter set; 4 fail (`@bb/desktop`, `@bb/host-daemon`, `@bb/process-utils`, `@bb/scripts`) and 1 passes (`@bb/domain`) — matches this task's full local Windows run in `31-test-baseline.md` (the same four packages fail there too), so the CI leg's narrower baseline is consistent with the fuller local measurement.
