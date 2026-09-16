# Windows CI runs (Phase 3 gate, Step 12)

Branch `windows-native/phase-3` on the fork `OlegFM/bb`. The local machine was used only to push and to
poll; the job runs on GitHub's `windows-2025` runner with its own Node 22.x.

Pushing the branch starts `ci.yml` by itself — the `windows-native/**` push trigger added in Phase 0,
Task 11c. No `gh workflow run` dispatch was issued in any round; a second dispatch would have cancelled the
push-triggered run through `ci.yml`'s `concurrency` group.

> ## Verdict: **PASS** at run 4.
>
> `Windows x64 (windows-2025, Node 22.x)` — **conclusion `success`**, every step green, including all three
> steps Phase 3 added: `Smoke ConPTY`, `--filter=bb-app` inside `Typecheck and build` / `Test (Windows
> baseline)`, and `Smoke bb-app tarball`.
>
> Runs 1–3 failed on `Smoke bb-app tarball`. Each failure was a distinct, real defect; each was diagnosed
> from the job log and fixed in its own commit before the next push. They are all recorded below rather
> than summarised away.

## Run index

| run | id | head | `Windows x64` | failing step | fix that followed |
|---|---|---|---|---|---|
| 1 | 35028876525 | `05138a11e` | **failure** | `Smoke bb-app tarball` | `c3a02ba15` |
| 2 | 35031701885 | `c3a02ba15` | **failure** | `Smoke bb-app tarball` | `e5d59dc7e` |
| 3 | 35035599668 | `e5d59dc7e` | **failure** | `Smoke bb-app tarball` | `72605c433` |
| 4 | 35036927190 | `72605c433` | **success** | — | — |

Every run's `Smoke ConPTY`, `Typecheck and build`, `Test (Windows baseline)` and `Load native add-ons`
steps concluded `success`. As in Phases 0–2, `Test (Windows baseline)`'s own `success` reflects its
`continue-on-error: true` in `ci.yml`; the uploaded run summary is the real test signal.

---

## Run 1 — 35028876525 (`05138a11e`)

```bash
git push origin windows-native/phase-3 2>&1; echo "EXIT=$?"
```
```
 * [new branch]          windows-native/phase-3 -> windows-native/phase-3
EXIT=0
```

Steps:

```
Set up job                      success
Checkout repository             success
Set up pnpm                     success
Set up Node.js                  success
Install dependencies            success
Load native add-ons             success
Smoke ConPTY                    success
Typecheck and build             success
Test (Windows baseline)         success
Smoke bb-app tarball            failure
Upload Windows test run summaries success
```

Failure, from the job log (`gh api repos/OlegFM/bb/actions/jobs/104582407649/logs`):

```
bb-app tarball smoke: provider bridge bundles 1.7s
Error: Codex provider-bridge artifact model/list did not return a model/list response
stdout:
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":2, … }}
{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Command codex was not found on Path"}}
```

**Root cause, traced.** `smokeProviderBridgeBundles` allows an unavailable provider only when the bridge's
message matches
`/(?:Native CLI binary|Claude Code executable).*not found|could not find the (?:Claude Code|Codex|pi) CLI/iu`.
Phase 3 commit `988826803` gave `resolveCodexAppServerLaunch` a win32 arm that calls
`resolveSpawnPlanOrThrow` **before** spawning, so on Windows a missing CLI now raises the resolver's own
`Command codex was not found on Path` instead of ever reaching the spawn failure that
`describeCodexLaunchError` maps to `MISSING_CODEX_CLI_GUIDANCE`. `git show 9a07e6994:…/bridge.ts` has no
`resolveCodexAppServerLaunch` at all, so this is a **Phase 3 regression** — and not only in the smoke: a
Windows user without Codex lost the actionable install guidance the POSIX path still gives.

Fix `c3a02ba15` restores it inside the existing win32 arm, on the failure path only:

```ts
  try {
    return await resolveSpawnPlanOrThrow({ command: launch.command, args: launch.args, env, platform });
  } catch (error) {
    if (resolveExecutableSync({ command: launch.command, env, platform }) === null) {
      throw new Error(MISSING_CODEX_CLI_GUIDANCE);
    }
    throw error;
  }
```

The `platform !== "win32"` early return above it is untouched, so POSIX never reaches this code. The
launcher-specific reasons (`Windows launcher <path> cannot be started directly`) still surface unchanged;
only the `not_found` case is remapped. `app-server-launch.test.ts` now covers both.

---

## Run 2 — 35031701885 (`c3a02ba15`)

`Smoke bb-app tarball` got past the bridge bundles (`provider bridge bundles 1.5s`) and failed later, at
`full stack`:

```
bb-app tarball smoke: full stack 2.6s
Error: bb-app full stack exited before http://127.0.0.1:59083/health became healthy
stdout:
  ○  Starting server
  ✗  Server failed to start
     Server failed to become healthy: Process exited before becoming healthy
     Check logs: C:\Users\RUNNER~1\AppData\Local\Temp\bb-app-tarball-pMsORR\full-stack-data-1\logs/
```

The smoke printed only the launcher's stdout, and the smoke deletes its temp root in a `finally`, so the
server's own log was gone before any artifact step could collect it — the failure was **undiagnosable from
CI alone**. Two hypotheses were tested locally and both were disproved before touching anything:

- 8.3 short paths (`C:\Users\RUNNER~1\…`): `bb-app` was started locally with
  `--data-dir C:\Users\olege\AppData\Local\Temp\BB-SHO~1\stackdata` and came up normally
  (`✓ Server listening`, `✓ Host daemon running`).
- the local smoke: `pnpm exec turbo run smoke:tarball --filter=bb-app` reached
  `bb-app tarball smoke passed in 134.6s` — `full stack` passes on this desktop.

Fix `e5d59dc7e` therefore made the smoke say what happened, by reusing the log files it **already** reads
for port-collision detection: `readPortCollisionDetails` was split into `readProcessDiagnostics` (the
sections) plus the pattern test, and both the "exited before healthy" and "timed out waiting" errors now
carry those sections. The same commit fixes the unrelated Windows `EBUSY` in the smoke's cleanup
(`24-npx-bb-app-clean-shell.md`).

---

## Run 3 — 35035599668 (`e5d59dc7e`)

Same step, and now the log names the cause (`gh api repos/OlegFM/bb/actions/jobs/104603894966/logs`):

```
C:\Users\RUNNER~1\AppData\Local\Temp\bb-app-tarball-oD2FBw\full-stack-data-1\logs\server-stdio.log:
Error: The secret file "C:\Users\RUNNER~1\AppData\Local\Temp\bb-app-tarball-oD2FBw\full-stack-data-1\auth-secret.4f0dffd06890.tmp"
is not restricted to runnervmvmocb\runneradmin: NT AUTHORITY\SYSTEM:(F), BUILTIN\Administrators:(F), runnervmvmocb\runneradmin:(F).
Store the bb data directory on an NTFS volume where icacls can set permissions.
    at assertSecretFileAclIsPrivate (…/server/dist/start-server.js:306750:9)
    at ensureSecretFileIsPrivate (…)
    at async createPrivateSecretFile (…)
    at async createMachineAuthService (…)
```

**Root cause.** `ensureSecretFileIsPrivate` runs
`icacls <file> /inheritance:r /grant:r *<sid>:F` and then re-reads the ACL;
`assertSecretFileAclIsPrivate` requires **exactly one** ACE, the owner with `(F)`
(`packages/secret-storage/src/windows-acl.ts:285`). Under the runner's profile temp the tighten returns
exit 0 yet the read-back still shows three explicit ACEs, so the server refuses to start.

**This is not a Phase 3 regression.** `git log 9a07e6994..HEAD -- packages/secret-storage/src/windows-acl.ts`
is **empty** — the check is Phase 2 code, byte-identical at the baseline. What Phase 3 changed is that the
Windows CI job now starts a real bb server (the `Smoke bb-app tarball` step), which no earlier phase's CI
ever did, so the condition had never been exercised on a runner. On this desktop the same code produces a
single ACE (`probe.tmp OMEN\olege:(F)`), and the account is a non-elevated user whose Administrators
membership is "Group used for deny only" — the runner's `runneradmin` is a full administrator.

Fix `72605c433` is **CI wiring only**, confined to the `windows-x64` job: the smoke step gets a
workspace-local temp root instead of the runner's profile temp.

```yaml
      - name: Smoke bb-app tarball
        env:
          TMP: ${{ github.workspace }}\.smoke-temp
          TEMP: ${{ github.workspace }}\.smoke-temp
        run: |
          New-Item -ItemType Directory -Force "$env:TEMP" | Out-Null
          pnpm exec turbo run smoke:tarball --filter=bb-app --output-logs=new-only
          exit $LASTEXITCODE
```

No product code was touched and no security check was weakened. The underlying limitation is real and is
**handed to the controller, not closed here**: on a Windows machine where `icacls /inheritance:r /grant:r`
leaves `NT AUTHORITY\SYSTEM` and `BUILTIN\Administrators` on the file — a fully-privileged administrator
account — bb's server cannot create its private secret file and will not start, and the error text
("Store the bb data directory on an NTFS volume…") misdiagnoses the cause, because that runner volume *is*
NTFS. Whether the check should accept SYSTEM/Administrators is a security decision that belongs to whoever
owns the Phase 2 hardening.

---

## Run 4 — 35036927190 (`72605c433`) — green

```bash
gh run view 35036927190 -R OlegFM/bb --json url,headSha,displayTitle,event,createdAt,jobs \
  --jq '{url,headSha,displayTitle,event,createdAt, windows: (.jobs[]|select(.name|test("Windows"))|{name,status,conclusion,startedAt,completedAt,url,steps:[.steps[]|{name,conclusion}]})}'
```
```json
{"createdAt":"2026-09-15T23:43:23Z",
 "displayTitle":"Give the Windows tarball smoke a workspace-local temp root",
 "event":"push","headSha":"72605c43339500d2bba0168f9c4b2264ac97609f",
 "url":"https://github.com/OlegFM/bb/actions/runs/35036927190",
 "windows":{"name":"Windows x64 (windows-2025, Node 22.x)",
   "status":"completed","conclusion":"success",
   "startedAt":"2026-09-15T23:43:26Z","completedAt":"2026-09-16T00:01:40Z",
   "url":"https://github.com/OlegFM/bb/actions/runs/35036927190/job/104608004204",
   "steps":[{"conclusion":"success","name":"Set up job"},
            {"conclusion":"success","name":"Checkout repository"},
            {"conclusion":"success","name":"Set up pnpm"},
            {"conclusion":"success","name":"Set up Node.js"},
            {"conclusion":"success","name":"Install dependencies"},
            {"conclusion":"success","name":"Load native add-ons"},
            {"conclusion":"success","name":"Smoke ConPTY"},
            {"conclusion":"success","name":"Typecheck and build"},
            {"conclusion":"success","name":"Test (Windows baseline)"},
            {"conclusion":"success","name":"Smoke bb-app tarball"},
            {"conclusion":"success","name":"Upload Windows test run summaries"},
            {"conclusion":"success","name":"Post Set up Node.js"},
            {"conclusion":"success","name":"Post Set up pnpm"},
            {"conclusion":"success","name":"Post Checkout repository"},
            {"conclusion":"success","name":"Complete job"}]}}
```

- Run id: **35036927190** — <https://github.com/OlegFM/bb/actions/runs/35036927190>
- Job: <https://github.com/OlegFM/bb/actions/runs/35036927190/job/104608004204>
- Measured SHA: `72605c43339500d2bba0168f9c4b2264ac97609f`
- `Windows x64 (windows-2025, Node 22.x)` — **`success`**, 23:43:26Z–00:01:40Z (18m14s)

### The three Phase 3 steps

| step | run 1 | run 2 | run 3 | run 4 |
|---|---|---|---|---|
| `Load native add-ons` | success | success | success | success |
| `Smoke ConPTY` | success | success | success | success |
| `Typecheck and build` (now with `--filter=bb-app`) | success | success | success | success |
| `Test (Windows baseline)` (now with `--filter=bb-app`) | success | success | success | success |
| `Smoke bb-app tarball` | **failure** | **failure** | **failure** | **success** |

## Artifacts

```bash
gh api repos/OlegFM/bb/actions/runs/35031701885/artifacts --jq '.artifacts[]|{name,size_in_bytes,expired,id}'
```
```json
{"expired":false,"id":10421368959,"name":"windows-x64-test-results","size_in_bytes":36792}
```

`qa-artifacts/conpty-smoke.txt` was downloaded from run 2 and run 4 (`gh run download … -n
windows-x64-test-results`, `DL_EXIT=0` both times). Run 4's copy:

```
check spawn-echo: ok pid=6384
check utf8: ok
check resize: ok
check ctrl-c: ok
check close: ok pid=5696 exitCode=-1073741510 reaped
check tree: ok parent=1520 child=8856 reaped
conpty smoke: 6/6
  Time:    23.395s
```

Run 2's copy is quoted in `25-conpty-smoke.md`. 6/6 on the runner in every round.

## Cancellations

Once the `Windows x64` job of run 4 had completed, the unrelated Linux/macOS legs of the CI runs and every
queued Version Lockstep run this gate's four pushes had started were cancelled, as Phases 0–2 did:

```bash
for r in 35036927190 35036927185 35035599636 35031701669 35028876463; do gh run cancel $r -R OlegFM/bb; done
```
```
✓ Request to cancel workflow 35036927190 submitted.   EXIT=0
✓ Request to cancel workflow 35036927185 submitted.   EXIT=0
✓ Request to cancel workflow 35035599636 submitted.   EXIT=0
✓ Request to cancel workflow 35031701669 submitted.   EXIT=0
✓ Request to cancel workflow 35028876463 submitted.   EXIT=0
```

Runs 1–3's CI workflows had already been auto-cancelled by `ci.yml`'s concurrency group when the next push
arrived; in each case the `Windows x64` job had already **completed** and its recorded conclusion stands —
cancelling the overall run afterwards does not change it, the same point Phase 2 made.

## The evidence commit's run

The evidence commit is pushed after this file is written, so the branch tip on the fork matches the local
tip. It changes only `qa/windows/phase-3/**`, no product code and no workflow, so its CI run is not part of
this gate's verdict; its id is recorded at the bottom of `31-test-results.md`.
