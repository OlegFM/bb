# Quit and orphans (Phase 4 gate, Step 8)

Raw transcript: `24-quit-orphans.txt`. Smoke evidence: `process-hygiene/run1/`, `run2/`, `run3/`
(`before.json`, `during.json`, `after.json`, `summary.json` in each).

> ## Result: **PASS**
>
> Quit removed **every** process of the app's tree — 9 `bb.exe` → **0** — while the bystander and all 16
> unrelated `node.exe` rows survived untouched, and `/health` stopped answering. The process-hygiene smoke
> passed **three times out of three**, each with empty `failures`, `strays` and `survivors`. Killing the
> Desktop process outright left **no** runtime behind either.
>
> Spec §9's Job Object response is **not** triggered: there was no orphan in any run.

## Quit through the tray-Quit code path

The bystander first, so that "everything died" can be distinguished from "the app's tree died":

```powershell
$bystander = Start-Process -FilePath "C:\nvm4w\nodejs\node.exe" -ArgumentList "-e","setInterval(()=>{},1000)" -PassThru -WindowStyle Hidden
```

```
BYSTANDER_PID=37240
```

The installed **N+1** (`0.42.2`) was launched with `BB_DESKTOP_QUIT_REQUEST_FILE` pointing at a fresh path.
`docs/platform-windows.md` states this hook "calls `app.quit()` once — exactly the tray Quit path", so the
measurement below is the tray Quit measurement; clicking the tray item is the `MANUAL` item at the end.

```
before.csv:  BEFORE_BB=9   BEFORE_NODE=16   BYSTANDER_ALIVE_BEFORE=1
<write the quit flag>
after.csv (5 s later):  AFTER_BB=0   AFTER_NODE=16   BYSTANDER_ALIVE_AFTER=1   ELAPSED=5,95
```

The `node.exe` pid lists are **byte-identical** before and after:

```
before: 4592,31708,28308,33576,25792,17360,43988,39052,34012,44556,26176,4964,36752,30380,35916,37240
after : 4592,31708,28308,33576,25792,17360,43988,39052,34012,44556,26176,4964,36752,30380,35916,37240
```

All 16 are unrelated to bb — the agent host's own Node runtimes plus the gate's bystander (37240) and the
gate's feed server (35916). The app contributes **no** `node.exe` row at all, because its runtime runs as
`bb.exe` with `ELECTRON_RUN_AS_NODE` (`22-use-installed-app.md`). So the assertion "zero `bb.exe`/`node.exe`
rows from the app's tree remain" holds on both images, and the bystander proves the check has teeth.

Health confirms the server is really gone, not merely unlisted:

```
health unreachable: Подключение не установлено, т.к. конечный компьютер отверг запрос на подключение. (127.0.0.1:38886)
```

### How long Quit takes, four times over

The same quit path was exercised four times across Steps 7–9, each timed from writing the flag to the last
`bb.exe` exiting:

| when                                       | build        | seconds  |
| ------------------------------------------ | ------------ | -------- |
| Step 7, before the update run              | N `0.42.1`   | **4.59** |
| Step 7, immediately before the N+1 install | N `0.42.1`   | **4.57** |
| Step 9, after the tray test                | N+1 `0.42.2` | **4.14** |
| Step 9, end                                | N+1 `0.42.2` | **4.39** |

Every one is inside the documented worst case of `OWNED_RUNTIME_STOP_TIMEOUT_MS` (6 s) +
`OWNED_RUNTIME_KILL_TIMEOUT_MS` (1 s) = **7 s**, and each includes up to 500 ms of poll latency before the
quit even begins, since the flag file is polled at that interval. The spread 4.14–4.59 s is tight across
two builds.

`QUIT_FILE_STILL_EXISTS=True` after every run: the app does not delete the flag, exactly as documented, so
each launch in this gate used a fresh path.

## The process-hygiene smoke, three runs

Run against `apps/desktop/release/win-unpacked` (build N, `0.42.1`), each into its own evidence directory:

```powershell
$turboArgs = @('run','smoke:windows-processes','--filter=@bb/desktop','--force','--output-logs=new-only','--','--evidence-dir',$dir)
pnpm exec turbo @turboArgs
```

| run | descendants while running | result                                               | exit  |
| --- | ------------------------- | ---------------------------------------------------- | ----- |
| 1   | 6                         | `Process hygiene smoke passed: no leaked processes.` | **0** |
| 2   | 7                         | `Process hygiene smoke passed: no leaked processes.` | **0** |
| 3   | 8                         | `Process hygiene smoke passed: no leaked processes.` | **0** |

`summary.json` for each:

```json
{ "appBinary": "C:\\Users\\olege\\Work\\bb\\apps\\desktop\\release\\win-unpacked\\bb.exe",
  "appPid": 37416, "bystanderPid": 30932, "descendantsWhileRunning": 6,
  "failures": [], "serverUrl": "http://127.0.0.1:60635", "strays": [], "survivors": [] }
{ … "appPid": 42928, "bystanderPid": 38368, "descendantsWhileRunning": 7,
  "failures": [], "serverUrl": "http://127.0.0.1:54539", "strays": [], "survivors": [] }
{ … "appPid": 45216, "bystanderPid": 28596, "descendantsWhileRunning": 8,
  "failures": [], "serverUrl": "http://127.0.0.1:50779", "strays": [], "survivors": [] }
```

Three runs, **`failures: []`, `strays: []`, `survivors: []`** every time. The descendant count varies
6/7/8 because Chromium spawns utility processes on demand; the smoke snapshots pid plus creation date
rather than counting, so the variation is expected and is itself worth recording — a later gate seeing 6
where CI saw 7 (`41-ci-run.md`) should not read that as a change.

`smoke:packaged` was run once alongside, also against `win-unpacked`:

```
Packaged desktop smoke passed: C:\Users\olege\Work\bb\apps\desktop\release\win-unpacked\bb.exe
 Tasks:    1 successful, 1 total    Time: 3.562s
SMOKE_PACKAGED_EXIT=0
```

### A shell trap worth writing down

The first attempt at the three runs failed before the smoke started:

```powershell
pnpm exec turbo run smoke:windows-processes --filter=@bb/desktop --force --output-logs=new-only -- --evidence-dir $dir
```

```
    --anon-profile [<ANON_PROFILE>]
    --summarize [<SUMMARIZE>]
    --parallel <PARALLEL>
For more information, try '--help'.
HYGIENE_RUN1_EXIT=1
```

PowerShell dropped the bare `--` separator, so turbo parsed `--evidence-dir` as one of its own options and
rejected it. The identical line works in CI because there it is a `run:` block handed to `pwsh -command`
rather than typed into an interactive pipeline. Building the argument vector as an **array** with `'--'`
as an element passes it through intact, which is what the three runs above used. Nothing about the product
is involved; recorded so a later gate does not spend the same ten minutes on it.

## Simulated Desktop crash

```powershell
# app launched, health OK, 7 bb.exe rows, bridge pid 47224
taskkill /PID 1844 /F
```

```
SUCCESS: The process with PID 1844 has been terminated.
TASKKILL_EXIT=0
BBCOUNT_NOW=0
RUNTIME_GONE_SECONDS=0,62
health unreachable
```

**The whole tree was gone 0.62 s after the Desktop process was force-killed**, well inside the 5 s the
brief allows.

Read carefully, because it is not the mechanism the docs describe: 0.62 s is **faster than the parent
watchdog's first poll**. `startParentProcessWatchdog` (`packages/bb-app/src/parent-watchdog.ts`) is armed
with `intervalMs: 2_000`, so it cannot have fired before the tree was already collected. Something else
removed the runtime — a broken stdio pipe to the dead parent is the most likely candidate, since the
launcher's stdout is a pipe into the Desktop process — but this gate did not determine which, and it does
not claim to.

The consequence for the documented behaviour is that the watchdog is a **fallback** on this host rather
than the observed mechanism. Its own log line, `Desktop parent process exited; shutting down`, could not
be captured here for the same reason the tree died so fast: `log()` writes to the launcher's stdout, and
that stdout is a pipe whose reader — the Desktop process — is the thing that was just killed. The line is
reachable in a dev run where the launcher's stdout is a console, and the watchdog's behaviour is covered
by `packages/bb-app/test/parent-watchdog.test.ts`, which passes on both Windows and Linux
(`31-test-results.md`, `40-posix-check.md`).

What matters for the gate's actual question — does a killed Desktop leave a runtime behind — is answered
without ambiguity: it does not, on any of the four occasions a Desktop process was force-killed during
this gate (two `Stop-Process -Force`, one `taskkill /F`, and the three smoke runs' own teardown).

### `MANUAL — for the user`

The tray menu itself was not clicked. With the app running, right-click the bb tray icon and confirm the
menu reads **`Open bb`**, a separator, **`Quit bb`**, and that `Quit bb` empties `tasklist /FI "IMAGENAME
eq bb.exe"` within a few seconds. The quit-request file exercised above is documented as the same
`app.quit()` call, so this confirms the menu wiring rather than the stop itself.
