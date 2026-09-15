# PID-reuse stress under a tree kill (Phase 2 gate, Step 5)

Commit `7d0603bb4777132efd0e122ffc6d8064105333be`, node v22.19.0, the reference Windows desktop
(`00-host.md`). Raw capture: `21-pid-reuse-stress.txt`.

The stress case is not a standalone script. `qa/` belongs to no workspace package and the repo root declares
no workspace dependencies, so `node --import tsx qa/…` cannot import `@bb/process-utils` at all. The case
therefore lives in the package that owns the primitive, as the
`it.runIf(process.platform === "win32")` case
**`leaves unrelated processes alive while PIDs are recycled under a tree kill`** in
`packages/process-utils/test/windows-process-real.test.ts`. It starts an unrelated Node sleeper *before*
the recycle loop, starts a Node parent with a Node child, then runs 300 short-lived
`cmd.exe /d /c exit 0` spawns (from the absolute `%SystemRoot%\System32` path) concurrently with
`terminateProcessTree` on the parent, and prints one `PID_REUSE_EVIDENCE` line.

## Command and output

```powershell
pnpm --filter @bb/process-utils exec vitest run test/windows-process-real.test.ts 2>&1 | Tee-Object qa/windows/phase-2/21-pid-reuse-stress.txt; "EXIT=$LASTEXITCODE" | Tee-Object -Append qa/windows/phase-2/21-pid-reuse-stress.txt
```

```
 RUN  v4.1.1 C:/Users/olege/Work/bb/packages/process-utils

PID_REUSE_EVIDENCE {"leaderPid":24720,"grandchildPid":19904,"unrelatedPid":38188,"unrelatedAlive":true,"recycleIterations":300,"leaderExited":true,"descendantsKilled":[19904],"descendantsSkipped":[],"skipped":[]}
ENUMERATION_EVIDENCE {"directory":"C:\\Users\\olege\\AppData\\Local\\Temp\\bb-enum-demo-nXA6EI","enumerationMs":635,"underMatchPid":13760,"underMatchMissed":true,"overMatchPid":22172,"overMatchEvidence":"command-line","matchedPids":[22172,24476]}

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  00:22:41
   Duration  23.31s (transform 104ms, setup 0ms, import 243ms, tests 22.86s, environment 0ms)

EXIT=0
```

`@bb/process-utils`'s vitest config is `silent: "passed-only"`, so the default reporter prints no per-case
line. The file was therefore re-run once with `--reporter=verbose`, appended to the same `.txt`, to record
the case's own pass line:

```
 ✓ |@bb/process-utils| test/windows-process-real.test.ts > terminateProcessTree against real Windows processes > kills the grandchild and reports it 6658ms
 ✓ |@bb/process-utils| test/windows-process-real.test.ts > terminateProcessTree against real Windows processes > skips a descendant whose recorded CreationDate no longer matches 6434ms
PID_REUSE_EVIDENCE {"leaderPid":9932,"grandchildPid":25456,"unrelatedPid":38748,"unrelatedAlive":true,"recycleIterations":300,"leaderExited":true,"descendantsKilled":[25456],"descendantsSkipped":[],"skipped":[]}
 ✓ |@bb/process-utils| test/windows-process-real.test.ts > terminateProcessTree against real Windows processes > leaves unrelated processes alive while PIDs are recycled under a tree kill 7912ms
ENUMERATION_EVIDENCE {"directory":"C:\\Users\\olege\\AppData\\Local\\Temp\\bb-enum-demo-0XxA7K","enumerationMs":647,"underMatchPid":21020,"underMatchMissed":true,"overMatchPid":8652,"overMatchEvidence":"command-line","matchedPids":[8652,40656]}
 ✓ |@bb/process-utils| test/windows-process-real.test.ts > Windows process enumeration against real processes > documents an under-match and an over-match 1683ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  23.11s
EXIT_VERBOSE=0
```

Two independent solo runs, same conclusion in both.

## Reading of `PID_REUSE_EVIDENCE`

| field | run 1 | run 2 | expected | verdict |
|---|---|---|---|---|
| `recycleIterations` | 300 | 300 | 300 | as specified |
| `leaderExited` | `true` | `true` | `true` | the tree leader really exited |
| `descendantsKilled` | `[19904]` | `[25456]` | contains the grandchild | the grandchild pid, and only it |
| `descendantsSkipped` | `[]` | `[]` | `[]` on a clean run | clean run — no skip fired |
| `unrelatedAlive` | `true` | `true` | `true` | the sleeper started **before** the recycle loop is untouched |
| `skipped` (callback) | `[]` | `[]` | equal to `descendantsSkipped` | the `onSkippedProcess` callback saw exactly what the result reports |

The gate bullet reads "leaves every unrelated process alive **and logs `pid-reused` skips**". Both runs
produced an empty `descendantsSkipped`: no descendant's recorded `CreationDate` disagreed with the fresh
snapshot taken immediately before its own `taskkill`, so no skip was *due*. The brief anticipates this —
"`descendantsSkipped` an empty array on a clean run — record it as-is either way, since a non-empty
`descendantsSkipped` with a genuine `pid-reused` entry is also a valid (if less likely) outcome of a tight
PID-reuse race". The skip **mechanism** itself is not left unproven: the sibling case in the same file,
`skips a descendant whose recorded CreationDate no longer matches` (pass line above, 6434ms), drives a
real process tree through an injected `WindowsCommandRunner` that rewrites the enumerated `CreationDate`,
and asserts the descendant is skipped rather than killed and stays alive. That case is the deterministic
proof of the `pid-reused` skip; this case is the proof that under 300 real PID recycles nothing unrelated
is collateral.

## `tasklist` after the run

```powershell
C:\Windows\System32\tasklist.exe /FI "IMAGENAME eq node.exe" /FO CSV; "EXIT=$LASTEXITCODE"
```
```
"Image Name","PID","Session Name","Session#","Mem Usage"
"node.exe","34788","Console","1","2 796 K"
"node.exe","36708","Console","1","2 744 K"
"node.exe","29264","Console","1","1 732 K"
EXIT=0
```

All three are unrelated to bb. Command lines and start times read back with
`Get-CimInstance Win32_Process -Filter "ProcessId = <pid>"`:

```
ProcessId : 34788  CreationDate : 14.09.2026 12:59:51
CommandLine : "…\OpenAI\Codex\runtimes\cua_node\…\bin\node.exe" …\@oai\cua-repl\bin\cua-repl.mjs

ProcessId : 36708  CreationDate : 14.09.2026 12:59:51
CommandLine : "…\OpenAI\Codex\runtimes\cua_node\…\bin\node.exe" "C:\Program Files\WindowsApps\OpenAI.Codex_…\artifact-template-picker\server.mjs"

ProcessId : 29264  CreationDate : 14.09.2026 12:59:51
CommandLine : "…\OpenAI\Codex\runtimes\cua_node\…\bin\node.exe"  ./server.mjs
```

All three belong to the OpenAI Codex desktop app and were started 2026-09-14 12:59:51, roughly eleven hours
before this run. No leaked leader, no leaked descendant, no leaked sleeper: the test kills its own
`unrelated` sleeper at the end of the case.

## Behaviour under full-suite load (not a result, recorded for honesty)

In the Step 3 full-load run (23 packages' suites at once) this same case **failed** on its own 180 s
vitest timeout:

```
FAIL  |@bb/process-utils| test/windows-process-real.test.ts > terminateProcessTree against real Windows processes > leaves unrelated processes alive while PIDs are recycled under a tree kill
Error: Test timed out in 180000ms.
 ❯ test/windows-process-real.test.ts:175:22
```

with the file itself taking 222,167 ms. Solo it takes 7.9 s. 300 `cmd.exe` process creations plus a CIM
enumeration are starved when thirteen other vitest pools are competing for the same cores; that is the
same starvation class Phase 1 documented for `@bb/app` and `@bb/server`, not a defect in the primitive.
`31-test-results.md` records both numbers and treats the solo run as the measurement.

## The automations sweep counterpart

The same `terminateProcessTree` is what `plugins/automations` uses to reap a script's descendants. Its real
Windows case is recorded in `20-hook-stream-timeout-cancel.md` (`leaves no descendant when a .ps1 script
times out`) rather than duplicated here.
