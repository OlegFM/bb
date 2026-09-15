# `.bb-env-setup.ps1`: streams, times out, cancels, leaves no descendant (Phase 2 gate, Step 4)

Commit `7d0603bb4777132efd0e122ffc6d8064105333be`, node v22.19.0, pwsh 7.6.6, the reference Windows desktop
(`00-host.md`). Raw test capture: `20-hook-stream-timeout-cancel.txt`.

This file records **three** things: a real end-to-end run in the dev instance (a worktree environment whose
`.bb-env-setup.ps1` streams output and is then cancelled while its spawned sleeper is alive), and the two
real-process test cases that cover the timeout branch and the automations sweep.

## 1. End-to-end: a worktree environment with a streaming, sleeping hook

### The scratch repository

```bash
d="/c/Users/olege/Work/phase2-hook"; rm -rf "$d"; git init -q "$d"
# .bb-env-setup.ps1 written, README.md written
git -C "$d" -c core.hooksPath= add .bb-env-setup.ps1 README.md
git -C "$d" -c core.hooksPath= -c user.name="Phase2 QA" -c user.email="olegefm@gmail.com" commit -q -m "Initial commit"
git -C "$d" log --oneline; git -C "$d" rev-parse --abbrev-ref HEAD
```
```
warning: in the working copy of '.bb-env-setup.ps1', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
7f038f8 Initial commit
master
EXIT=0
```

`.bb-env-setup.ps1`:

```powershell
Write-Output "phase2 hook line 1"
Start-Sleep -Seconds 1
Write-Output "phase2 hook line 2"
Start-Sleep -Seconds 1
Write-Output "phase2 hook line 3"
Start-Process -NoNewWindow -FilePath node -ArgumentList "-e","setTimeout(()=>{},600000)"
Start-Sleep -Seconds 600
```

### Project and thread

The dev instance was started with `pnpm dev:app current` (instance `work-bb-21d97a8d7c85`, server
`http://127.0.0.1:23813`, daemon `http://127.0.0.1:31813`). Note for the record: the brief's
`$env:BB_DATA_DIR = "…\phase2-secrets-qa"` has **no effect on `pnpm dev:app`** — the dev launcher derives
its own per-checkout instance directory (`C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85`) and ignores
`BB_DATA_DIR`. `22-secret-acl.md` records the ACL evidence against that real instance directory instead.

Project created through the CLI (the same route the UI uses):

```powershell
& "<cli>\bin\bb.cmd" project create --name "phase2-hook" --root "C:\Users\olege\Work\phase2-hook" --json
```
```
{ "id": "proj_ffz6bbwjau", "name": "phase2-hook", …,
  "sources": [ { "id": "src_i5v9wspvqi", "type": "local_path", "hostId": "host_45kqba73eq",
                 "path": "C:\\Users\\olege\\Work\\phase2-hook", "isDefault": true } ] }
EXIT_CREATE=0
```

Thread started with the Worktree environment provider. Same UI substitution as Phase 1's
`22-managed-worktree.md`: `POST /api/v1/threads` is the route the UI's thread composer calls.

```powershell
$body = '{"projectId":"proj_ffz6bbwjau","origin":"sdk","providerId":"codex","title":"Phase 2 hook check","input":[{"type":"text","text":"Phase 2 hook stream and cancel check."}],"environment":{"type":"provider","environmentProviderId":"git-worktree","machine":{"type":"existing","hostId":"host_45kqba73eq"},"inputs":{"branch":{"kind":"default"}}}}'
$t = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/threads" -Method Post -ContentType "application/json" -Body $body
```
```
id=thr_kwxi54ybzq status=starting environmentId=
```

### `tasklist` BEFORE

```powershell
C:\Windows\System32\tasklist.exe /FI "IMAGENAME eq node.exe" /FO CSV
```
```
"Image Name","PID","Session Name","Session#","Mem Usage"
"node.exe","17352", … "node.exe","24148", … "node.exe","22440", … "node.exe","10604",
"node.exe","3816",  … "node.exe","9148",  … "node.exe","32780", … "node.exe","25092",
"node.exe","30180", … "node.exe","30520", … "node.exe","10424", … "node.exe","22708",
"node.exe","24172", … "node.exe","9412",  … "node.exe","33636", … "node.exe","33408",
"node.exe","23340"
COUNT_BEFORE=17
```

(Full CSV kept verbatim in the agent scratchpad; the seventeen PIDs are the dev instance's own supervisor,
server, daemon, vite and plugin-worker processes plus three unrelated OpenAI Codex desktop processes.)

### Streaming: the provisioning transcript

`GET /api/v1/threads/thr_kwxi54ybzq/timeline` (the route the UI's transcript renders; it exists —
`packages/server-contract/src/public-api.ts:1399` declares `/threads/:id/timeline`, and
`timelineSystemOperationKindValues` carries `"thread-provisioning"`). The `thread-provisioning` row's
`detail`, verbatim:

```
Preparing workspace
Preparing Worktree…
Creating worktree
HEAD is now at 7f038f8 Initial commit
Preparing worktree (new branch 'bb/phase-2-hook-check-thr_kwxi54ybzq')
Created worktree
Using workspace: C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_kwxi54ybzq-1\phase2-hook
Running .bb-env-setup.ps1
phase2 hook line 1
phase2 hook line 2
phase2 hook line 3
```

**All three `Write-Output` lines stream through**, in order, behind the `Running .bb-env-setup.ps1` progress
marker. The hook then blocked on `Start-Sleep -Seconds 600`, so no "finished" marker follows — which is the
state this step needs in order to cancel mid-hook.

### The hook's own processes, mid-run

```powershell
Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object { $_.CommandLine -like "*bb-env-setup*" }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*setTimeout(()=>{},600000)*" }
```
```
ProcessId       : 33292
ParentProcessId : 33408
CreationDate    : 15.09.2026 8:44:37
CommandLine     : "C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_kwxi54ybzq-1\phase2-hook\.bb-env-setup.ps1

ProcessId       : 3760
ParentProcessId : 33292
CreationDate    : 15.09.2026 8:44:39
CommandLine     : "C:\nvm4w\nodejs\node.exe" -e setTimeout(()=>{},600000)
```

Two things worth recording from this line alone: the hook really is launched as
`-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>` (the non-interactive PowerShell
command shape Task 5 built), and the sleeper is a **grandchild** of the daemon — the exact shape
`terminateProcessTree` has to reap.

### Cancel

```powershell
& "<cli>\bin\bb.cmd" thread stop thr_kwxi54ybzq
```
```
Thread thr_kwxi54ybzq stopped
EXIT_STOP=0
```

A `tasklist` taken **in the same command, immediately after the CLI returned**, still showed pid `3760`.
That is not a leak: `thread stop` returns as soon as the server accepts the request, and the cancellation
then has to travel server → daemon → in-flight `environment.attach` RPC → `terminateProcessTree`. The
server log shows the round trip and how long it took:

```
[08:45:32] DEBUG: [host-daemon] Online host RPC {"commandType":"environment.attach","errorCode":"provision_cancelled","handlerMs":54773.5,"ok":false}
[08:45:32] DEBUG: [server] Live environment provisioning cancelled {"commandType":"environment.attach","environmentId":"env_ug3v639xg4","errorCode":"provision_cancelled","errorMessage":"Workspace provisioning was cancelled","errorStatus":502,"executionId":"rpc_c0b53236-e934-454e-9b3f-cd33fb09db88","hostId":"host_45kqba73eq","initiatorThreadId":"thr_kwxi54ybzq","provisioningId":"tpv_pctftjikza"}
```

### `tasklist` AFTER (settled)

```powershell
C:\Windows\System32\tasklist.exe /FI "IMAGENAME eq node.exe" /FO CSV
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*setTimeout(()=>{},600000)*" } | Measure-Object
Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object { $_.CommandLine -like "*bb-env-setup*" } | Measure-Object
```
```
COUNT_AFTER=18
--- any hook descendant left? ---
0
--- any hook pwsh left? ---
0
```

**The hook's PowerShell (33292) and its `node` sleeper (3760) are both gone.** The `18` versus `17` is not a
leak either: the seventeen BEFORE pids are all still present, and the one extra pid is `22292`, identified
with `Get-CimInstance`:

```
ProcessId       : 22292
Name            : node.exe
CreationDate    : 15.09.2026 8:44:35
ParentProcessId : 33408
CommandLine     : C:\nvm4w\nodejs\node.exe --conditions=source --import tsx …\apps\host-daemon\src\plugin-host-worker.ts …\environment-git-worktree\…\host.mjs environment-git-worktree 27734f22-… …
```

— the daemon's own `environment-git-worktree` **plugin host worker**, started at 08:44:35 to serve the
provisioning RPC. It is daemon-owned and idles out on its own (the same log shows `keep-awake`,
`concurrency-limit` and `provider-acp` workers stopping at `uptimeMs ≈ 300000`). It is not a hook
descendant.

**Step 4's cancellation bullet: PASS.** Cancelling mid-hook leaves no descendant.

### Teardown, and one observation

```powershell
POST /api/v1/environments/env_ug3v639xg4/archive-threads  -> {"ok":true,"archivedThreadIds":["thr_kwxi54ybzq"]}
DELETE /api/v1/environments/env_ug3v639xg4                -> {"ok":true}
GET /api/v1/environments?projectId=proj_ffz6bbwjau        -> []
Test-Path …\worktrees\thr_kwxi54ybzq-1                    -> False
git -C C:\Users\olege\Work\phase2-hook worktree list      -> C:/Users/olege/Work/phase2-hook  7f038f8 [master]
```

The managed worktree directory is gone and the source repository carries no stale worktree registration.

**Observation (not a Phase 2 gate item, recorded for the record):** the server logged

```
[08:45:32] INFO: [server] Environment lifecycle event not applied {"detail":"no transition for provision.cancelled from status ready","environmentId":"env_ug3v639xg4","event":"provision.cancelled","reason":"illegal-transition"}
```

The environment row had already advanced to `status: "ready"` before the cancel landed, so the
`provision.cancelled` lifecycle event had no legal transition and was dropped. The process cleanup still
happened (proved above) and the later `DELETE` tore the environment down cleanly, so nothing leaked — but a
worktree environment whose setup hook was cancelled is left displaying `ready`. This is server-side
environment-lifecycle state, not a Windows seam, and it is out of Phase 2's scope; flagged here so it is not
lost.

## 2. Timeout branch — the host-daemon real-process cases

`plugins/environment-git-worktree/server.ts` hardcodes `CREATE_TIMEOUT_MS = 15 * 60 * 1000` with no
server-exposed override, so waiting out the real timeout is not required. The timeout path shares the same
`terminateProcessTree` cancellation code as the cancel path measured above, and Task 5's real-process case
covers the branch with a shortened timeout. Whole file run (`20-hook-stream-timeout-cancel.txt`):

```powershell
pnpm --filter @bb/host-daemon exec vitest run src/environment-lifecycle-script.test.ts
```
```
 Test Files  1 passed (1)
      Tests  9 passed | 7 skipped (16)
   Duration  12.64s
EXIT_LIFECYCLE=0
```

Per-case lines from the `--reporter=verbose` re-run appended to the same `.txt` (the seven `↓` are the
POSIX-only cases, correctly skipped on win32):

```
 ✓ … windows environment scripts > fails setup when only the POSIX hook exists on Windows 9ms
 ✓ … windows environment scripts > reports a POSIX-only teardown on Windows without blocking removal 3ms
 ✓ … windows environment scripts > prefers the PowerShell hook when both hooks exist 3ms
 ✓ … windows environment scripts > builds a non-interactive PowerShell -File command 1ms
 ✓ … windows environment scripts > builds the teardown command and refuses a POSIX teardown hook 1ms
 ✓ … windows environment scripts > streams PowerShell hook output 427ms
 ✓ … windows environment scripts > times out a sleeping PowerShell hook 4491ms
 ✓ … windows environment scripts > reports the exit code of a failing PowerShell hook 351ms
 ✓ … windows environment scripts > cancels a PowerShell hook and leaves no descendant 5224ms
EXIT_LIFECYCLE_VERBOSE=0
```

- **`times out a sleeping PowerShell hook`** writes a `Start-Sleep -Seconds 30` hook, calls `runSetupScript`
  with `timeoutMs: 1_000` and asserts the rejection carries `timed out after 1000ms`. It reaches the same
  `terminateProcessTree` the 15-minute constant would.
- **`cancels a PowerShell hook and leaves no descendant`** is the real-process twin of section 1 at unit
  scale — and section 1 above is the real-process proof for **both** paths on this desktop, since the
  timeout and the cancel converge on one cancellation implementation.

## 3. Automations descendant reap (`.ps1` script timeout)

The same primitive backs `plugins/automations`' script runner. Solo run
(`pnpm --filter bb-plugin-automations exec vitest run --reporter=verbose`):

```
 ✓ src/automations.test.ts > PowerShell automation scripts > runs a stored .ps1 script through PowerShell 416ms
 ✓ src/automations.test.ts > PowerShell automation scripts > leaves no descendant when a .ps1 script times out 13832ms
 ✓ src/automations.test.ts > Windows automation interpreters > maps .ps1 to the powershell interpreter on win32 0ms
 ✓ src/automations.test.ts > Windows automation interpreters > keeps the pre-Windows POSIX extension fallback for .ps1 0ms
 ✓ src/automations.test.ts > Windows bb probe and script spawn > hides the console window only on win32 1ms
```

`leaves no descendant when a .ps1 script times out` starts a `.ps1` that spawns two Node helpers, lets the
runner time out, and asserts both descendant pids are gone afterwards. Passes on this desktop.

The package's other failures in that run (`5 failed | 91 passed`) are pre-existing Windows classes and are
**fewer** than at the branch base — at `07fdce05b` the same package failed 9 tests, at this head 5, with no
new failing test. Detail in `31-test-results.md`. The one containment case that does fail,
`script process containment > terminates descendant processes when a script times out`, fails on
`EBUSY: resource busy or locked, rmdir '…\bb-auto-process-group-MVVtCn\scripts'` — a temp-directory cleanup
race, not a containment failure, and it fails identically at the base.

## Gate bullet

> "a worktree with `.bb-env-setup.ps1` streams output, times out and cancels; cancellation leaves no
> descendants (`tasklist` before/after)"

**PASS.** Streaming shown end-to-end in the dev instance's provisioning transcript; cancellation shown
end-to-end with `tasklist` before/after and every hook process gone; the timeout branch shown by the
real-process case that drives the same cancellation code with a 1 s budget, plus the automations `.ps1`
timeout reap.
