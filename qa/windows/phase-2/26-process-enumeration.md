# Process enumeration: over-match and under-match (Phase 2 gate, Step 10)

Commit `7d0603bb4777132efd0e122ffc6d8064105333be`, node v22.19.0, the reference Windows desktop
(`00-host.md`). Raw capture: `21-pid-reuse-stress.txt` (Steps 5 and 10 share one test file, so the file is
run once and both evidence lines are read out of the same capture).

Windows exposes no per-process current working directory. `killProcessesWithCwdUnder` — used to reap a
managed workspace before removing it — therefore enumerates with `Get-CimInstance Win32_Process` and
*approximates* cwd from four kinds of evidence: `spawn-registry` (bb itself spawned the process with a
known cwd), `executable-path` (the process's own exe lives under the directory), `command-line` (the
directory string appears in the process's argv), and `descendant` (a child of an already-matched process).
Every Windows match therefore carries `approximateCwd: true`. Two mismatches follow directly from that,
and both are reproduced below against real processes.

## Evidence generator

The demonstration lives in the package that owns the primitive (`qa/` is in no workspace package and cannot
import `@bb/process-utils`), as the `it.runIf(process.platform === "win32")` case
**`documents an under-match and an over-match`** in
`packages/process-utils/test/windows-process-real.test.ts`. It starts one Node process whose cwd is a fresh
temp directory and whose argv never names that directory, starts a second Node process **elsewhere** whose
argv does contain that directory path, takes a real `Win32_Process` snapshot, and prints one
`ENUMERATION_EVIDENCE` line.

```powershell
pnpm --filter @bb/process-utils exec vitest run test/windows-process-real.test.ts 2>&1 | Tee-Object qa/windows/phase-2/21-pid-reuse-stress.txt; "EXIT=$LASTEXITCODE" | Tee-Object -Append qa/windows/phase-2/21-pid-reuse-stress.txt
```

Case pass line (from the `--reporter=verbose` re-run appended to the same `.txt`; the package's vitest
config is `silent: "passed-only"`, so the default reporter prints no per-case line):

```
 ✓ |@bb/process-utils| test/windows-process-real.test.ts > Windows process enumeration against real processes > documents an under-match and an over-match 1683ms
```

`Test Files 1 passed (1)`, `Tests 4 passed (4)`, `EXIT=0` in both runs.

## `ENUMERATION_EVIDENCE`

Run 1:

```
ENUMERATION_EVIDENCE {"directory":"C:\\Users\\olege\\AppData\\Local\\Temp\\bb-enum-demo-nXA6EI","enumerationMs":635,"underMatchPid":13760,"underMatchMissed":true,"overMatchPid":22172,"overMatchEvidence":"command-line","matchedPids":[22172,24476]}
```

Run 2 (verbose re-run):

```
ENUMERATION_EVIDENCE {"directory":"C:\\Users\\olege\\AppData\\Local\\Temp\\bb-enum-demo-0XxA7K","enumerationMs":647,"underMatchPid":21020,"underMatchMissed":true,"overMatchPid":8652,"overMatchEvidence":"command-line","matchedPids":[8652,40656]}
```

| field | run 1 | run 2 | meaning |
|---|---|---|---|
| `underMatchPid` | 13760 | 21020 | a real Node process whose **cwd is the demo directory** |
| `underMatchMissed` | `true` | `true` | it is **not** in `matchedPids` — the documented under-match |
| `overMatchPid` | 22172 | 8652 | a Node process running **elsewhere**, with the directory only in its argv |
| `overMatchEvidence` | `"command-line"` | `"command-line"` | it *is* matched, and only because of argv — the documented over-match |
| `matchedPids` | `[22172,24476]` | `[8652,40656]` | the over-match plus the vitest worker that also carries the path |
| `enumerationMs` | 635 | 647 | observational cost of one real `Get-CimInstance Win32_Process` snapshot |

### Under-match

`underMatchMissed: true` in both runs. The process's cwd genuinely *is* the directory, but Windows never
reports cwd, its executable is `C:\nvm4w\nodejs\node.exe` (not under the directory), and its command line
is `node -e "setTimeout(() => {}, 60000)"` (which never names the directory). No evidence kind can see it,
so the sweep misses it — regardless of whether `includeCommandLineEvidence` is on or off.

**Consequence in the product**: a process the *user* started themselves with a cwd under a worktree is not
stopped, and worktree removal then fails with `EBUSY`. That is the failure mode `docs/platform-windows.md`
records; this file is its reproduction.

### Over-match

`overMatchEvidence: "command-line"` in both runs, and the over-matched pid is in `matchedPids`. The process
runs with `cwd = the repo`, nowhere near the demo directory; it is matched purely because the directory
string appears in its argv. In real use this is an editor or a terminal *opened on* the worktree.

**This one is listed but never killed.** `killProcessesWithCwdUnder` matches with
`includeCommandLineEvidence: false`, so only `spawn-registry`, `executable-path` and `descendant` evidence
can make a process a kill target; a `command-line`-only match surfaces through
`listProcessesWithCwdUnder` (carrying its `matchEvidence`) and is never itself killed. The test uses the
listing path deliberately, so the recorded over-match is the **reporting-only** one. The kill-path
over-match that remains possible is a different shape — a process whose own executable happens to live
under the directory (for example a locally built binary still running from a different cwd) matching on
`executable-path` evidence — and it is not reproduced here because manufacturing it requires installing a
binary under a temp worktree; it is documented, not measured.

## Per-pass verification residual window

`killWindowsProcessesWithCwdUnder` runs up to `WINDOWS_SWEEP_MAX_ROUNDS = 5` passes, each shaped as:

1. take a `Win32_Process` snapshot and match targets against it;
2. take a **second, fresh** verification snapshot;
3. iterate the targets, and for each one compare its `CreationDate` against that verification snapshot —
   a mismatch is a `pid-reused` skip, a match is a `taskkill /PID <pid> /F`;
4. `await delay(WINDOWS_SWEEP_SETTLE_MS)` (50 ms) and repeat.

The verification snapshot in step 2 is taken **once per pass**, not once per candidate. The residual window
for any one candidate is therefore the interval between that snapshot completing and that candidate's own
`taskkill` being issued — which, for the last target in a pass, includes every preceding `taskkill`
round-trip in the same pass. Measured here, one snapshot costs **635–647 ms** (the `enumerationMs` figures
above; the spec's ~1.2 s CIM cost is the pessimistic figure and is not contradicted — this is an
observational data point on a warm process, not a strict assertion, and `docs/platform-windows.md` quotes
about 0.55 s warm and about 2.6 s for a cold PowerShell start). A pid recycled inside that window is killed
blind. Two mitigations bound the damage: the window is opened *after* matching, so it covers only
already-selected pids; and on this path no caller wires `onSkippedProcess`, so a `pid-reused` skip here is
silent and the later `EBUSY` is the visible symptom.

`terminateProcessTree` (the tree-kill path, Step 5) has the same shape with the same single post-kill
verification snapshot, but it *does* offer `onSkippedProcess` and both `20-hook-stream-timeout-cancel.md`
and `21-pid-reuse-stress.md` show a caller reading it.

## Verdict

**PASS.** Both documented mismatches reproduced against real processes on this desktop, in two independent
runs, with the evidence line printed by the test rather than reconstructed by hand:
`underMatchMissed: true`, `overMatchEvidence: "command-line"`.
