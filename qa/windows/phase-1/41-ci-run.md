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

