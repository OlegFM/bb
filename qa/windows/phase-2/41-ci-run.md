# Windows CI run (Phase 2 gate, Step 12)

Date: 2026-09-15 (local), 2026-09-14T21:18Z (run timestamps)
Branch: `windows-native/phase-2` on the fork `OlegFM/bb`.
The local machine was used only to push and to poll; the job itself runs on GitHub's `windows-2025` runner
with its own Node 22.x.

## Push (code head)

```bash
git push origin windows-native/phase-2 2>&1; echo "EXIT=$?"
```
```
remote:
remote: Create a pull request for 'windows-native/phase-2' on GitHub by visiting:
remote:      https://github.com/OlegFM/bb/pull/new/windows-native/phase-2
remote:
To github.com:OlegFM/bb.git
 * [new branch]          windows-native/phase-2 -> windows-native/phase-2
EXIT=0
```

The push alone started the workflow — `ci.yml` carries the `windows-native/**` push trigger added in
Phase 0, Task 11c. No `gh workflow run` dispatch was issued; a second dispatch would have cancelled the
push-triggered run through `ci.yml`'s `concurrency` group.

## Run listing

```bash
gh run list -R OlegFM/bb --branch windows-native/phase-2 --limit 5 2>&1
```
```
queued		Narrow the pid-reused skip and .ps1 mapping claims in the Phase 2 docs	CI	windows-native/phase-2	push	34898040347	1m0s	2026-09-14T21:18:17Z
queued		Narrow the pid-reused skip and .ps1 mapping claims in the Phase 2 docs	Version Lockstep	windows-native/phase-2	push	34898040374	1m0s	2026-09-14T21:18:17Z
```

## Result

```bash
gh run view 34898040347 -R OlegFM/bb --json url,headSha,displayTitle,event,createdAt,jobs --jq '{url,headSha,displayTitle,event,createdAt, windows: (.jobs[]|select(.name|test("Windows"))|{name,status,conclusion,startedAt,completedAt,url,steps:[.steps[]|{name,conclusion}]})}' 2>&1
```
```
{"createdAt":"2026-09-14T21:18:17Z","displayTitle":"Narrow the pid-reused skip and .ps1 mapping claims in the Phase 2 docs","event":"push","headSha":"7d0603bb4777132efd0e122ffc6d8064105333be","url":"https://github.com/OlegFM/bb/actions/runs/34898040347","windows":{"completedAt":"2026-09-14T21:28:04Z","conclusion":"success","name":"Windows x64 (windows-2025, Node 22.x)","startedAt":"2026-09-14T21:18:20Z","status":"completed","steps":[{"conclusion":"success","name":"Set up job"},{"conclusion":"success","name":"Checkout repository"},{"conclusion":"success","name":"Set up pnpm"},{"conclusion":"success","name":"Set up Node.js"},{"conclusion":"success","name":"Install dependencies"},{"conclusion":"success","name":"Load native add-ons"},{"conclusion":"success","name":"Typecheck and build"},{"conclusion":"success","name":"Test (Windows baseline)"},{"conclusion":"success","name":"Upload Windows test run summaries"},{"conclusion":"success","name":"Post Set up Node.js"},{"conclusion":"success","name":"Post Set up pnpm"},{"conclusion":"success","name":"Post Checkout repository"},{"conclusion":"success","name":"Complete job"}],"url":"https://github.com/OlegFM/bb/actions/runs/34898040347/job/104156935122"}}
```

- Run id: **34898040347** — <https://github.com/OlegFM/bb/actions/runs/34898040347>
- Job URL: <https://github.com/OlegFM/bb/actions/runs/34898040347/job/104156935122>
- Measured SHA: `7d0603bb4777132efd0e122ffc6d8064105333be` (the code head; the evidence commit is measured
  in the second section below)
- Job: `Windows x64 (windows-2025, Node 22.x)` — **conclusion: `success`**, 21:18:20Z–21:28:04Z (9m44s)
- Every step concluded `success`, including `Typecheck and build`.

As in Phase 0 and Phase 1, the `Test (Windows baseline)` step's own `success` reflects its
`continue-on-error: true` in `ci.yml`; the uploaded run summary below is the real test signal.

## Artifact

```bash
gh api repos/OlegFM/bb/actions/runs/34898040347/artifacts --jq '.artifacts[]|{name,size_in_bytes,expired,id}' 2>&1
```
```
{"expired":false,"id":10369553722,"name":"windows-x64-test-results","size_in_bytes":34771}
```

```bash
gh run download 34898040347 -R OlegFM/bb -n windows-x64-test-results -D <scratch>/ci-artifact-p2 2>&1; echo "EXIT=$?"
```
```
EXIT=0
```

```powershell
node qa/windows/scripts/summarize-turbo-run.mjs <scratch>\ci-artifact-p2
```
```
| package | test task |
|---|---|
| @bb/desktop | fail (1) |
| @bb/domain | pass |
| @bb/host-daemon | fail (1) |
| @bb/process-utils | fail (1) |
| @bb/scripts | fail (1) |

Source: <scratch>\ci-artifact-p2\3JKskwA9ohsKM35Dh1e6vo98LkW.json
```

**Identical** to the Phase 0 CI baseline (`qa/windows/phase-0/40-ci-run.md`) and to both Phase 1 runs
(`qa/windows/phase-1/41-ci-run.md`): `@bb/domain` passes; `@bb/desktop`, `@bb/host-daemon`,
`@bb/process-utils` and `@bb/scripts` fail. No package changed state in the CI leg at this head.

Note on scope: the CI `Test (Windows baseline)` step runs a much smaller package set than this gate's
Step 3 filter list, and it does **not** include `@bb/server`, so the two newly failing test files this gate
found (`31-test-results.md`, Step 3) are not visible in the CI artifact. The green `windows-x64` job
therefore certifies typecheck+build and the CI baseline package set, not the whole Step 3 filter list.

## Cancellations

The fork cannot run the Blacksmith-hosted jobs (`Checks`, `Tests (*)`, `Package Smoke`, `Node Compatibility
Smoke`), so they queue indefinitely. Once the Windows job's conclusion and artifact were recorded, both runs
the push created were cancelled:

```bash
gh run cancel 34898040347 -R OlegFM/bb 2>&1; echo "EXIT_CI=$?"; gh run cancel 34898040374 -R OlegFM/bb 2>&1; echo "EXIT_VL=$?"
```
```
✓ Request to cancel workflow 34898040347 submitted.
EXIT_CI=0
✓ Request to cancel workflow 34898040374 submitted.
EXIT_VL=0
```

Cancelling the overall run after the fact does not change the `Windows x64` job's already-recorded
`success`.

---

# Second run: the evidence commit `082c97b55` (2026-09-15)

The section above measured CI at the **code** head `7d0603bb4`. This one measures it at the head after the
evidence commit, so CI has run on the final tip of the branch. That commit is markdown/txt only under
`qa/windows/phase-2/` — no code changed between the two runs.

## Push

```bash
git push origin windows-native/phase-2 2>&1; echo "EXIT=$?"
```
```
To github.com:OlegFM/bb.git
   7d0603bb4..082c97b55  windows-native/phase-2 -> windows-native/phase-2
EXIT=0
```

```bash
gh run list -R OlegFM/bb --branch windows-native/phase-2 --limit 4 2>&1
```
```
queued		Record the Phase 2 Windows gate evidence	CI	windows-native/phase-2	push	34934805691	23s	2026-09-15T05:56:47Z
queued		Record the Phase 2 Windows gate evidence	Version Lockstep	windows-native/phase-2	push	34934805689	23s	2026-09-15T05:56:47Z
completed	cancelled	Narrow the pid-reused skip and .ps1 mapping claims in the Phase 2 docs	Version Lockstep	windows-native/phase-2	push	34898040374	19m51s	2026-09-14T21:18:17Z
completed	cancelled	Narrow the pid-reused skip and .ps1 mapping claims in the Phase 2 docs	CI	windows-native/phase-2	push	34898040347	19m43s	2026-09-14T21:18:17Z
```

## Result

```bash
gh run view 34934805691 -R OlegFM/bb --json url,headSha,displayTitle,event,createdAt,jobs --jq '{url,headSha,displayTitle,event,createdAt, windows: (.jobs[]|select(.name|test("Windows"))|{name,status,conclusion,startedAt,completedAt,url,steps:[.steps[]|{name,conclusion}]})}'
```
```
{"createdAt":"2026-09-15T05:56:47Z","displayTitle":"Record the Phase 2 Windows gate evidence","event":"push","headSha":"082c97b555f001efc9febf0d925f82fb5e186896","url":"https://github.com/OlegFM/bb/actions/runs/34934805691","windows":{"completedAt":"2026-09-15T06:03:32Z","conclusion":"success","name":"Windows x64 (windows-2025, Node 22.x)","startedAt":"2026-09-15T05:56:50Z","status":"completed","steps":[{"conclusion":"success","name":"Set up job"},{"conclusion":"success","name":"Checkout repository"},{"conclusion":"success","name":"Set up pnpm"},{"conclusion":"success","name":"Set up Node.js"},{"conclusion":"success","name":"Install dependencies"},{"conclusion":"success","name":"Load native add-ons"},{"conclusion":"success","name":"Typecheck and build"},{"conclusion":"success","name":"Test (Windows baseline)"},{"conclusion":"success","name":"Upload Windows test run summaries"},{"conclusion":"success","name":"Post Set up Node.js"},{"conclusion":"success","name":"Post Set up pnpm"},{"conclusion":"success","name":"Post Checkout repository"},{"conclusion":"success","name":"Complete job"}],"url":"https://github.com/OlegFM/bb/actions/runs/34934805691/job/104270316741"}}
```

- Run id: **34934805691** — <https://github.com/OlegFM/bb/actions/runs/34934805691>
- Job URL: <https://github.com/OlegFM/bb/actions/runs/34934805691/job/104270316741>
- Measured SHA: `082c97b555f001efc9febf0d925f82fb5e186896` — the evidence commit, the branch tip
- Job: `Windows x64 (windows-2025, Node 22.x)` — **conclusion: `success`**, 05:56:50Z–06:03:32Z (6m42s)
- Every step `success`, including `Typecheck and build`

## Artifact

```bash
gh api repos/OlegFM/bb/actions/runs/34934805691/artifacts --jq '.artifacts[]|{name,size_in_bytes,expired,id}'
```
```
{"expired":false,"id":10383063039,"name":"windows-x64-test-results","size_in_bytes":34759}
```

```bash
gh run download 34934805691 -R OlegFM/bb -n windows-x64-test-results -D <scratch>/ci-artifact-p2b; echo "EXIT=$?"
```
```
EXIT=0
```

```powershell
node qa/windows/scripts/summarize-turbo-run.mjs <scratch>\ci-artifact-p2b
```
```
| package | test task |
|---|---|
| @bb/desktop | fail (1) |
| @bb/domain | pass |
| @bb/host-daemon | fail (1) |
| @bb/process-utils | fail (1) |
| @bb/scripts | fail (1) |

Source: <scratch>\ci-artifact-p2b\3JLtWHyu6QjoYUqNvxhgzUi4GWR.json
```

Identical to the first Phase 2 run, to both Phase 1 runs and to the Phase 0 CI baseline. No package changed
state in the CI leg.

## Cancellations

```bash
gh run cancel 34934805691 -R OlegFM/bb 2>&1; echo "EXIT_CI=$?"; gh run cancel 34934805689 -R OlegFM/bb 2>&1; echo "EXIT_VL=$?"
```
```
✓ Request to cancel workflow 34934805691 submitted.
EXIT_CI=0
✓ Request to cancel workflow 34934805689 submitted.
EXIT_VL=0
```

## Step 12 verdict

**PASS.** A green `windows-x64` job at both pushed SHAs, including the branch tip
`082c97b555f001efc9febf0d925f82fb5e186896`, with the CI test-artifact package set unchanged from Phase 0 and
Phase 1.

The scope caveat from the first section stands, and is worth repeating at the tip: CI's
`Test (Windows baseline)` step covers a far smaller package set than this gate's Step 3 filter list and does
**not** include `@bb/server`, so neither of the two regressions `31-test-results.md` records is visible in
this green job. A green `windows-x64` is necessary for the phase gate, not sufficient.
