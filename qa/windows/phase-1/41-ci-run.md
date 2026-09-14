# Windows CI run (Phase 1 gate, Step 8)

Date: 2026-09-13
Measured SHA (pushed branch head at the time of the run): `203acb2738135c9b7ab1e2824da949223aa0dbc1`
Branch: `windows-native/phase-1` on the fork `OlegFM/bb`.
Local machine used only to push and to poll; the job itself runs on GitHub's `windows-2025` runner with its
own Node 22.x.

## Push

Command (Git Bash, in `C:\Users\olege\Work\bb`):

```bash
git push -u origin windows-native/phase-1 2>&1; echo "EXIT=$?"
```

Output:

```
remote:
remote: Create a pull request for 'windows-native/phase-1' on GitHub by visiting:
remote:      https://github.com/OlegFM/bb/pull/new/windows-native/phase-1
remote:
branch 'windows-native/phase-1' set up to track 'origin/windows-native/phase-1'.
To github.com:OlegFM/bb.git
 * [new branch]          windows-native/phase-1 -> windows-native/phase-1
EXIT=0
```

The push alone started the workflow (`ci.yml` carries the `windows-native/**` push trigger added in Phase 0,
Task 11c); no `gh workflow run` dispatch was needed, and none was issued — a second dispatch would have
cancelled the push-triggered run through `ci.yml`'s `concurrency` group.

## Run listing

Command:

```bash
gh run list -R OlegFM/bb --branch windows-native/phase-1 --limit 5 2>&1; echo "EXIT=$?"
```

Output:

```
queued		Clarify which layer refuses a bare drive letter on Windows	Version Lockstep	windows-native/phase-1	push	34751658100	12s	2026-09-13T10:21:58Z
queued		Clarify which layer refuses a bare drive letter on Windows	CI	windows-native/phase-1	push	34751658093	12s	2026-09-13T10:21:58Z
EXIT=0
```

## Result

Command:

```bash
gh run view 34751658093 -R OlegFM/bb --json url,headSha,displayTitle,event,createdAt,jobs --jq '{url,headSha,displayTitle,event,createdAt, windows: (.jobs[]|select(.name|test("Windows"))|{name,status,conclusion,startedAt,completedAt,url,steps:[.steps[]|{name,conclusion}]})}' 2>&1
```

Output:

```
{"createdAt":"2026-09-13T10:21:58Z","displayTitle":"Clarify which layer refuses a bare drive letter on Windows","event":"push","headSha":"203acb2738135c9b7ab1e2824da949223aa0dbc1","url":"https://github.com/OlegFM/bb/actions/runs/34751658093","windows":{"completedAt":"2026-09-13T10:30:45Z","conclusion":"success","name":"Windows x64 (windows-2025, Node 22.x)","startedAt":"2026-09-13T10:22:00Z","status":"completed","steps":[{"conclusion":"success","name":"Set up job"},{"conclusion":"success","name":"Checkout repository"},{"conclusion":"success","name":"Set up pnpm"},{"conclusion":"success","name":"Set up Node.js"},{"conclusion":"success","name":"Install dependencies"},{"conclusion":"success","name":"Load native add-ons"},{"conclusion":"success","name":"Typecheck and build"},{"conclusion":"success","name":"Test (Windows baseline)"},{"conclusion":"success","name":"Upload Windows test run summaries"},{"conclusion":"success","name":"Post Set up Node.js"},{"conclusion":"success","name":"Post Set up pnpm"},{"conclusion":"success","name":"Post Checkout repository"},{"conclusion":"success","name":"Complete job"}],"url":"https://github.com/OlegFM/bb/actions/runs/34751658093/job/103709131628"}}
```

- Run URL: <https://github.com/OlegFM/bb/actions/runs/34751658093>
- Job URL: <https://github.com/OlegFM/bb/actions/runs/34751658093/job/103709131628>
- Job: `Windows x64 (windows-2025, Node 22.x)` — **conclusion: `success`**, 10:22:00Z–10:30:45Z (8m45s).
- Every step of that job concluded `success`, including `Typecheck and build`.

As in Phase 0, the `Test (Windows baseline)` step's own `success` reflects its `continue-on-error: true` in
`ci.yml`; the uploaded run summary below is the real test signal.

## Artifact

Command:

```bash
gh api repos/OlegFM/bb/actions/runs/34751658093/artifacts --jq '.artifacts[]|{name,size_in_bytes,expired,id}' 2>&1
```

Output:

```
{"expired":false,"name":"windows-x64-test-results","size_in_bytes":34354,"id":10316401394}
```

Artifact name: `windows-x64-test-results` (34,354 bytes, not expired).

Downloaded and summarised:

```bash
gh run download 34751658093 -R OlegFM/bb -n windows-x64-test-results -D <scratch>/ci-artifact-phase1 2>&1; echo "EXIT=$?"
```
```
EXIT=0
```

```powershell
node qa/windows/scripts/summarize-turbo-run.mjs C:\...\scratchpad\ci-artifact-phase1; "EXIT=$LASTEXITCODE"
```
```
| package | test task |
|---|---|
| @bb/desktop | fail (1) |
| @bb/domain | pass |
| @bb/host-daemon | fail (1) |
| @bb/process-utils | fail (1) |
| @bb/scripts | fail (1) |

Source: C:\...\scratchpad\ci-artifact-phase1\3JGlbQI917KTpnox4Nmonrc39Ie.json
EXIT=0
```

Identical to the Phase 0 CI baseline in `qa/windows/phase-0/40-ci-run.md` (`@bb/domain` passes;
`@bb/desktop`, `@bb/host-daemon`, `@bb/process-utils`, `@bb/scripts` fail) — the CI leg shows no newly
failing package at this HEAD.

## Cancellations

The fork cannot run the Blacksmith-hosted jobs (`Checks`, `Tests (*)`, `Package Smoke`, `Node Compatibility
Smoke`), so they queue indefinitely. Once the Windows job's own conclusion was recorded, both runs the push
created were cancelled:

```bash
gh run cancel 34751658093 -R OlegFM/bb 2>&1; echo "EXIT_CI=$?"; gh run cancel 34751658100 -R OlegFM/bb 2>&1; echo "EXIT_VL=$?"
```
```
✓ Request to cancel workflow 34751658093 submitted.
EXIT_CI=0
✓ Request to cancel workflow 34751658100 submitted.
EXIT_VL=0
```

Cancelling the overall run after the fact does not change the `Windows x64` job's already-recorded
`success`.

---

# Gate refresh at `e976524b488483fd583de42c8dce13ac6d6ac0cd` (2026-09-13)

The section above measured the CI leg at `203acb273`. This one measures it at the head after the final fix
round. The push carried three commits (`94f5c40eb`, `bb472301a`, `e976524b4`) plus the first evidence commit
`489cd5abc`.

## Push

```bash
git push origin windows-native/phase-1 2>&1; echo "EXIT=$?"
```
```
To github.com:OlegFM/bb.git
   489cd5abc..e976524b4  windows-native/phase-1 -> windows-native/phase-1
EXIT=0
```

```bash
gh run list -R OlegFM/bb --branch windows-native/phase-1 --limit 3 2>&1
```
```
queued		Use the flavor-neutral UNC refusal in the environment directory tool	Version Lockstep	windows-native/phase-1	push	34758768285	10s	2026-09-13T13:03:30Z
queued		Use the flavor-neutral UNC refusal in the environment directory tool	CI	windows-native/phase-1	push	34758768292	10s	2026-09-13T13:03:30Z
completed	cancelled	Record the Phase 1 Windows gate evidence	Version Lockstep	windows-native/phase-1	push	34755007328	24s	2026-09-13T11:39:27Z
```

## Result

```bash
gh run view 34758768292 -R OlegFM/bb --json url,headSha,displayTitle,event,createdAt,jobs --jq '{url,headSha,displayTitle,event,createdAt, windows: (.jobs[]|select(.name|test("Windows"))|{name,status,conclusion,startedAt,completedAt,url,steps:[.steps[]|{name,conclusion}]})}' 2>&1
```
```
{"createdAt":"2026-09-13T13:03:30Z","displayTitle":"Use the flavor-neutral UNC refusal in the environment directory tool","event":"push","headSha":"e976524b488483fd583de42c8dce13ac6d6ac0cd","url":"https://github.com/OlegFM/bb/actions/runs/34758768292","windows":{"completedAt":"2026-09-13T13:11:32Z","conclusion":"success","name":"Windows x64 (windows-2025, Node 22.x)","startedAt":"2026-09-13T13:04:06Z","status":"completed","steps":[{"conclusion":"success","name":"Set up job"},{"conclusion":"success","name":"Checkout repository"},{"conclusion":"success","name":"Set up pnpm"},{"conclusion":"success","name":"Set up Node.js"},{"conclusion":"success","name":"Install dependencies"},{"conclusion":"success","name":"Load native add-ons"},{"conclusion":"success","name":"Typecheck and build"},{"conclusion":"success","name":"Test (Windows baseline)"},{"conclusion":"success","name":"Upload Windows test run summaries"},{"conclusion":"success","name":"Post Set up Node.js"},{"conclusion":"success","name":"Post Set up pnpm"},{"conclusion":"success","name":"Post Checkout repository"},{"conclusion":"success","name":"Complete job"}],"url":"https://github.com/OlegFM/bb/actions/runs/34758768292/job/103727698948"}}
```

- Run URL: <https://github.com/OlegFM/bb/actions/runs/34758768292>
- Job URL: <https://github.com/OlegFM/bb/actions/runs/34758768292/job/103727698948>
- Measured SHA: `e976524b488483fd583de42c8dce13ac6d6ac0cd`
- Job: `Windows x64 (windows-2025, Node 22.x)` — **conclusion: `success`**, 13:04:06Z–13:11:32Z (7m26s)
- Every step `success`, including `Typecheck and build`.

## Artifact

```bash
gh api repos/OlegFM/bb/actions/runs/34758768292/artifacts --jq '.artifacts[]|{name,size_in_bytes,expired,id}' 2>&1
```
```
{"expired":false,"id":10318023408,"name":"windows-x64-test-results","size_in_bytes":34353}
```

Artifact name: `windows-x64-test-results` (34,353 bytes, not expired). Downloaded (`EXIT=0`) and summarised:

```powershell
node qa/windows/scripts/summarize-turbo-run.mjs C:\...\scratchpad\ci-artifact-refresh; "EXIT=$LASTEXITCODE"
```
```
| package | test task |
|---|---|
| @bb/desktop | fail (1) |
| @bb/domain | pass |
| @bb/host-daemon | fail (1) |
| @bb/process-utils | fail (1) |
| @bb/scripts | fail (1) |

Source: C:\...\scratchpad\ci-artifact-refresh\3JH5KGbyg1EryDqYkxOsFv0nQJw.json
EXIT=0
```

Identical to both the Phase 0 CI baseline and this branch's earlier run at `203acb273` — no package changed
state in the CI leg.

## Cancellations

```bash
gh run cancel 34758768292 -R OlegFM/bb 2>&1; echo "EXIT_CI=$?"; gh run cancel 34758768285 -R OlegFM/bb 2>&1; echo "EXIT_VL=$?"
```
```
✓ Request to cancel workflow 34758768292 submitted.
EXIT_CI=0
✓ Request to cancel workflow 34758768285 submitted.
EXIT_VL=0
```

Cancelling the overall run afterwards does not change the `Windows x64` job's recorded `success`.


---

# Gate refresh 3 at `c3e4a8590` (2026-09-14)

The sections above measured the CI leg at `203acb273` and at `e976524b4`. This one measures it at the head
after the POSIX-parity round. The push carried four commits on top of the previously pushed `81bed7a61`:
`783b01ac1`, `59ee6327f`, `c3e4a8590`, and (in the later evidence push) this round's evidence commit.

## Push

```powershell
git -C C:\Users\olege\Work\bb rev-parse HEAD; git -C C:\Users\olege\Work\bb push origin windows-native/phase-1 2>&1; "EXIT=$LASTEXITCODE"
```
```
c3e4a8590ccb28c4f2110fc0137a2cdb29d0104a
To github.com:OlegFM/bb.git
   81bed7a61..c3e4a8590  windows-native/phase-1 -> windows-native/phase-1
EXIT=0
```

```powershell
gh run list --repo OlegFM/bb --branch windows-native/phase-1 --limit 6
```
```
queued		Degrade only on host RPC failures when canonicalizing paths	Version Lockstep	windows-native/phase-1	push	34817953533	45s	2026-09-14T07:27:35Z
queued		Degrade only on host RPC failures when canonicalizing paths	CI	windows-native/phase-1	push	34817953559	45s	2026-09-14T07:27:35Z
completed	cancelled	Keep separator-only, relative and backslash inputs behaving as before…	Version Lockstep	windows-native/phase-1	push	34812886219	5m49s	2026-09-14T06:18:14Z
completed	cancelled	Keep separator-only, relative and backslash inputs behaving as before…	CI	windows-native/phase-1	push	34812886132	5m55s	2026-09-14T06:18:14Z
completed	cancelled	Record the POSIX re-check after the final fix round	Version Lockstep	windows-native/phase-1	push	34760418490	26s	2026-09-13T13:38:42Z
completed	cancelled	Record the POSIX re-check after the final fix round	CI	windows-native/phase-1	push	34760418527	35s	2026-09-13T13:38:42Z
```

As in every earlier round, only the `Windows x64` job actually runs on this fork — the Blacksmith-hosted
jobs stay `queued` forever because the fork has no Blacksmith runners.

## Result

```bash
gh run view 34817953559 -R OlegFM/bb --json url,headSha,displayTitle,event,createdAt,jobs --jq '{url,headSha,displayTitle,event,createdAt, windows: (.jobs[]|select(.name|test("Windows"))|{name,status,conclusion,startedAt,completedAt,url,steps:[.steps[]|{name,conclusion}]})}' 2>&1; echo "EXIT=$?"
```
```
{"createdAt":"2026-09-14T07:27:35Z","displayTitle":"Degrade only on host RPC failures when canonicalizing paths","event":"push","headSha":"c3e4a8590ccb28c4f2110fc0137a2cdb29d0104a","url":"https://github.com/OlegFM/bb/actions/runs/34817953559","windows":{"completedAt":"2026-09-14T07:35:27Z","conclusion":"success","name":"Windows x64 (windows-2025, Node 22.x)","startedAt":"2026-09-14T07:27:37Z","status":"completed","steps":[{"conclusion":"success","name":"Set up job"},{"conclusion":"success","name":"Checkout repository"},{"conclusion":"success","name":"Set up pnpm"},{"conclusion":"success","name":"Set up Node.js"},{"conclusion":"success","name":"Install dependencies"},{"conclusion":"success","name":"Load native add-ons"},{"conclusion":"success","name":"Typecheck and build"},{"conclusion":"success","name":"Test (Windows baseline)"},{"conclusion":"success","name":"Upload Windows test run summaries"},{"conclusion":"success","name":"Post Set up Node.js"},{"conclusion":"success","name":"Post Set up pnpm"},{"conclusion":"success","name":"Post Checkout repository"},{"conclusion":"success","name":"Complete job"}],"url":"https://github.com/OlegFM/bb/actions/runs/34817953559/job/103892680345"}}
EXIT=0
```

- Run URL: <https://github.com/OlegFM/bb/actions/runs/34817953559>
- Job URL: <https://github.com/OlegFM/bb/actions/runs/34817953559/job/103892680345>
- Measured SHA: `c3e4a8590ccb28c4f2110fc0137a2cdb29d0104a`
- Job: `Windows x64 (windows-2025, Node 22.x)` — **conclusion: `success`**, 07:27:37Z–07:35:27Z (**7m50s**)
- Every step `success`, including `Typecheck and build` and `Test (Windows baseline)`.

`Test (Windows baseline)` carries `continue-on-error: true` in `ci.yml`, so its own `success` is weak
evidence on its own; the uploaded artifact below is the real signal. `Typecheck and build` does **not**
carry that flag, so its `success` means the whole workspace built and typechecked on a clean
`windows-2025` runner at this head.

## Artifact

```powershell
gh api repos/OlegFM/bb/actions/runs/34817953559/artifacts --jq '.artifacts[] | "\(.name)\t\(.size_in_bytes)\t\(.id)"'
```
```
windows-x64-test-results	34352	10337640355
```

Downloaded (`EXIT=0`) and summarised:

```bash
node qa/windows/scripts/summarize-turbo-run.mjs <scratch>/ci-artifact-r3; echo "EXIT=$?"
```
```
| package | test task |
|---|---|
| @bb/desktop | fail (1) |
| @bb/domain | pass |
| @bb/host-daemon | fail (1) |
| @bb/process-utils | fail (1) |
| @bb/scripts | fail (1) |

Source: <scratch>\ci-artifact-r3\3JJFZjXx12rWZ0Q8tKT9Xhy8oL3.json
EXIT=0
```

**Identical, package for package, to the Phase 0 CI baseline, to this branch's run at `203acb273`, and to
refresh 1 at `e976524b4`.** No package changed state in the CI leg across the whole POSIX-parity round.
`@bb/domain` — the package that owns the shared path helpers the round rewrote — still passes on the CI
runner.

## Cancellations

```bash
gh run cancel 34817953559 -R OlegFM/bb 2>&1; echo "EXIT_CI=$?"; gh run cancel 34817953533 -R OlegFM/bb 2>&1; echo "EXIT_VL=$?"
```
```
✓ Request to cancel workflow 34817953559 submitted.
EXIT_CI=0
✓ Request to cancel workflow 34817953533 submitted.
EXIT_VL=0
```

Cancelling the overall run afterwards does not change the `Windows x64` job's recorded `success` — the job
had already completed when the cancellation was submitted.

The evidence push for this round queues one more CI run and one more Version Lockstep run; both are
cancelled the same way immediately after that push, and the command and its output are recorded in
`.superpowers/sdd/2026-09-13-native-windows-phase-1/task-11-report.md` (they happen after this file is
committed, so they cannot appear here).
