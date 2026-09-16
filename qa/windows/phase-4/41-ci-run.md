# Windows CI run (Phase 4 gate, Step 13)

Branch `windows-native/phase-4` on the fork `OlegFM/bb` (`git@github.com:OlegFM/bb.git`, a fork of
`get-bb/bb`). The local machine was used only to push and to poll; the job runs on GitHub's `windows-2025`
runner with its own Node 22.x.

Pushing the branch starts `ci.yml` and `version-lockstep.yml` by themselves — the `windows-native/**` push
trigger added in Phase 0, Task 11c. No `gh workflow run` dispatch was issued against `ci.yml`; a dispatch
would have cancelled the push-triggered run through `ci.yml`'s `concurrency` group.

> ## Verdict: **PASS** on the first and only round.
>
> `Windows x64 (windows-2025, Node 22.x)` — **conclusion `success`**, every one of its 18 steps green,
> including the three Phase 4 added: `Package Windows desktop (unpacked)`, `Smoke packaged desktop app` and
> `Smoke Windows process hygiene`.
>
> **Wall time 17 min 09 s** (11:04:00Z → 11:21:09Z) against the 90-minute budget the phase brief set — 19 %
> of it. No gate fix commit was needed; unlike Phase 3, the branch was green on its first push.

## The push

```bash
git push -u origin windows-native/phase-4 2>&1; echo "EXIT=$?"
```

```
remote: Create a pull request for 'windows-native/phase-4' on GitHub by visiting:
remote:      https://github.com/OlegFM/bb/pull/new/windows-native/phase-4
branch 'windows-native/phase-4' set up to track 'origin/windows-native/phase-4'.
To github.com:OlegFM/bb.git
 * [new branch]          windows-native/phase-4 -> windows-native/phase-4
EXIT=0
```

The branch had never been pushed before, so this is a `[new branch]` push and no force was used anywhere in
this gate.

## Run index

| run | id          | workflow         | head        | `Windows x64`        | wall time                |
| --- | ----------- | ---------------- | ----------- | -------------------- | ------------------------ |
| 1   | 35088312655 | CI               | `11dfe15db` | **success**          | 17m09s                   |
| —   | 35088312636 | Version Lockstep | `11dfe15db` | n/a (no Windows job) | never started, see below |

<https://github.com/OlegFM/bb/actions/runs/35088312655>

## The `Windows x64` job

```bash
gh run view 35088312655 --json jobs --jq '.jobs[] | select(.name|startswith("Windows")) | {name,conclusion,startedAt,completedAt,databaseId}'
```

```json
{
  "name": "Windows x64 (windows-2025, Node 22.x)",
  "conclusion": "success",
  "startedAt": "2026-09-16T11:04:00Z",
  "completedAt": "2026-09-16T11:21:09Z",
  "databaseId": 104768327102
}
```

<https://github.com/OlegFM/bb/actions/runs/35088312655/job/104768327102>

Steps, in order, with their conclusions:

```
Set up job                          success
Checkout repository                 success
Set up pnpm                         success
Set up Node.js                      success
Install dependencies                success
Load native add-ons                 success
Smoke ConPTY                        success
Typecheck and build                 success
Test (Windows baseline)             success
Smoke bb-app tarball                success
Package Windows desktop (unpacked)  success      <- Phase 4
Smoke packaged desktop app          success      <- Phase 4
Smoke Windows process hygiene       success      <- Phase 4
Upload Windows test run summaries   success
Post Set up Node.js                 success
Post Set up pnpm                    success
Post Checkout repository            success
Complete job                        success
```

As in Phases 0–3, `Test (Windows baseline)`'s own `success` reflects its `continue-on-error: true` in
`ci.yml`; the uploaded run summary is the real test signal and is read below.

### The three Phase 4 steps, from the job log

`Package Windows desktop (unpacked)` runs `pnpm --filter @bb/desktop run package:windows` with `TMP`/`TEMP`
redirected to `D:\a\bb\bb\.smoke-temp` (the runner temp-ACL workaround Phase 3 introduced), 11:18:14Z →
11:19:16Z.

`Smoke packaged desktop app`:

```
##[group]Run pnpm exec turbo run smoke:packaged --filter=@bb/desktop --force --output-logs=new-only
> @bb/desktop@0.42.1 smoke:packaged D:\a\bb\bb\apps\desktop
> node scripts/smoke-packaged-app.mjs

Packaged desktop smoke passed: D:\a\bb\bb\apps\desktop\release\win-unpacked\bb.exe

 Tasks:    1 successful, 1 total
  Time:    2.915s
```

`Smoke Windows process hygiene`:

```
##[group]Run pnpm exec turbo run smoke:windows-processes --filter=@bb/desktop --output-logs=new-only -- --evidence-dir qa-artifacts/process-hygiene
> @bb/desktop@0.42.1 smoke:windows-processes D:\a\bb\bb\apps\desktop
> node scripts/smoke-windows-processes.mjs "--evidence-dir" "qa-artifacts/process-hygiene"

Process hygiene smoke: bystander pid 4332.
Process hygiene smoke: app pid 1736 → http://127.0.0.1:65478
Process hygiene smoke: 7 descendant processes while running.
Process hygiene smoke passed: no leaked processes.

 Tasks:    1 successful, 1 total
  Time:    11.492s
```

Note the two-element quoting `"--evidence-dir" "qa-artifacts/process-hygiene"` in the echoed command: Turbo
passes the trailing arguments through as separate argv entries, and the script resolves the directory
against `apps/desktop` (its `process.cwd()` under Turbo), which is why CI's upload path is
`apps/desktop/qa-artifacts/process-hygiene/*.json` and why the local runs in `24-quit-orphans.md` pass an
absolute path.

### `Smoke ConPTY`, unchanged from Phase 3

Downloaded from the run's artifact (`gh run download 35088312655 -n windows-x64-test-results`, `DL_EXIT=0`):

```
check spawn-echo: ok pid=4624
check utf8: ok
check resize: ok
check ctrl-c: ok
check close: ok pid=5656 exitCode=-1073741510 reaped
check tree: ok parent=7176 child=7592 reaped
conpty smoke: 6/6
  Time:    24.585s
```

`exitCode=-1073741510` is the raw ConPTY close code; `normalizeTerminalExitCode` maps it to `null` inside
the daemon, which is what `22-use-installed-app.md` measures on a real terminal.

### The uploaded process-hygiene evidence

`apps/desktop/qa-artifacts/process-hygiene/summary.json` from the same artifact:

```json
{
  "appBinary": "D:\\a\\bb\\bb\\apps\\desktop\\release\\win-unpacked\\bb.exe",
  "appPid": 1736,
  "bystanderPid": 4332,
  "descendantsWhileRunning": 7,
  "failures": [],
  "serverUrl": "http://127.0.0.1:65478",
  "strays": [],
  "survivors": []
}
```

Empty `failures`, `strays` and `survivors` on the runner, matching the three local runs in
`24-quit-orphans.md`. `before.json`, `during.json` and `after.json` are in the same artifact.

### `Test (Windows baseline)` on the runner

```bash
node qa/windows/scripts/summarize-turbo-run.mjs <artifact>/.turbo/runs
```

```
| package | test task |
|---|---|
| @bb/desktop | fail (1) |
| @bb/domain | pass |
| @bb/host-daemon | fail (1) |
| @bb/process-utils | fail (1) |
| @bb/scripts | fail (1) |
| bb-app | fail (1) |
```

The runner's `@bb/desktop` failures are exactly the five files the local win32 baseline carries
(`app-paths.test.ts` ×4 tests, `browser-import.test.ts` ×2, `electron-builder-config.test.ts` ×1,
`foreign-runtime.test.ts` ×1, `desktop-browser-view-manager.test.ts` ×2). The runner's `@bb/host-daemon`
column is much redder than the local one (17 files) because the hosted runner is slower and more
contended than the reference desktop; this step is non-gating for exactly that reason, and Phases 0–3
recorded the same shape.

## Non-Windows jobs: never started on this fork

Thirteen of the run's fourteen jobs were still `queued` 33 minutes after the push, while the `windows-2025`
job had started within 3 seconds and finished:

```bash
gh run view 35088312655 --json jobs --jq '.jobs[] | "\(.name): \(.status) \(.conclusion)"'
```

```
Checks (ubuntu-latest, Node 22.x): queued
Node Compatibility Smoke (blacksmith-6vcpu-macos-15, Node 24.x): queued
Node Compatibility Smoke (blacksmith-6vcpu-macos-15, Node 26.x): queued
Node Compatibility Smoke (blacksmith-4vcpu-ubuntu-2404, Node 26.x): queued
Package Smoke (blacksmith-6vcpu-macos-15, Node 22.x): queued
Tests (app-1, ubuntu-latest, Node 22.x): queued
Tests (server, ubuntu-latest, Node 22.x): queued
Windows x64 (windows-2025, Node 22.x): completed success
Tests (app-2, ubuntu-latest, Node 22.x): queued
Tests (integration, ubuntu-latest, Node 22.x): queued
Node Compatibility Smoke (blacksmith-4vcpu-ubuntu-2404, Node 24.x): queued
Tests (app-3, ubuntu-latest, Node 22.x): queued
Tests (packages, ubuntu-latest, Node 22.x): queued
Package Smoke (blacksmith-4vcpu-ubuntu-2404, Node 22.x): queued
```

The `blacksmith-*` labels are the upstream repository's self-hosted runner pool and no such runner is
attached to the fork, so those five jobs can never start here — the same fact Phases 0–3 recorded. The
`ubuntu-latest` jobs and the two Version Lockstep jobs were still queued as well; they are hosted-runner
jobs and would eventually start, but the POSIX side of this branch is measured directly in
`40-posix-check.md` rather than through them. None of this is caused by the branch.

Per the phase brief, they were cancelled once the `Windows x64` job had completed rather than left to burn
runner minutes, exactly as Phases 0–3 did. What was cancelled is listed under "Cancellations" below.

## Cancellations

Once the `Windows x64` job had completed, both runs this push started were cancelled rather than left to
sit in the hosted-runner queue, as Phases 0–3 did:

```bash
gh run cancel 35088312655; echo "EXIT1=$?"
gh run cancel 35088312636; echo "EXIT2=$?"
```

```
✓ Request to cancel workflow 35088312655 submitted.
EXIT1=0
✓ Request to cancel workflow 35088312636 submitted.
EXIT2=0
```

Afterwards:

```bash
gh run view 35088312655 --json status,conclusion
gh run view 35088312655 --json jobs --jq '.jobs[] | select(.name|startswith("Windows")) | "\(.status) \(.conclusion)"'
gh run view 35088312636 --json status,conclusion
```

```
run 35088312655: completed cancelled
Windows x64: completed success
run 35088312636: completed cancelled
```

| run         | workflow         | what was cancelled                                                                                                                                                                                                     |
| ----------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 35088312655 | CI               | the 13 jobs still queued — `Checks`, five `Tests (…)`, four `Node Compatibility Smoke (…)` and two `Package Smoke (…)`. The `Windows x64` job had already **completed successfully** and its conclusion is unaffected. |
| 35088312636 | Version Lockstep | both jobs, `Check plugin SDK version bump` and `Check bb-app and desktop versions`, still queued after 33 minutes.                                                                                                     |

The run-level conclusion is therefore `cancelled` for both, while the **job** this gate measures reads
`success`. That is the same point Phases 2 and 3 made: cancelling a run after a job has finished does not
retroactively change that job's conclusion, and `gh run view … --json jobs` is where the gate's claim comes
from.

The Version Lockstep run never executed, so the lockstep between `apps/desktop/package.json` and
`packages/bb-app/package.json` was **not** verified by CI in this gate. It was verified locally instead, by
construction: `23-update-n-to-n1.md` bumps both to `0.42.2` together, and
`apps/desktop/scripts/generate-version-feed.mts` throws unless `latest.yml`'s version matches
`apps/desktop/package.json`'s — which it did, for both `0.42.1` and `0.42.2`.

## The evidence commit's run

The evidence commit is pushed after this file is written, so the branch tip on the fork matches the local
tip. It changes only `qa/windows/phase-4/**` and `docs/platform-windows.md` — no product code and no
workflow — so its CI run is not part of this gate's verdict; its id is recorded at the bottom of
`31-test-results.md`.
