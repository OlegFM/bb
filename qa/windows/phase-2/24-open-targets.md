# Open targets (Phase 2 gate, Step 8)

Commit `7d0603bb4777132efd0e122ffc6d8064105333be`, node v22.19.0, the reference Windows desktop
(`00-host.md`). Raw capture: `24-open-targets.txt`.

`docs/platform-windows.md` words this bullet as "open targets opened from Explorer, **VS Code** and Windows
Terminal". **VS Code is not installed on this desktop** (`Get-Command code` returns nothing). Per the
addenda, an editor that *is* installed was used instead — **Zed** — and that substitution is recorded here
rather than silently swapped.

## Discovered targets on this desktop

Through the package's real exported runtime (`listWorkspaceOpenTargets()`, `execFile` real, no fakes):

```powershell
node --conditions=source --import tsx <script calling listWorkspaceOpenTargets()>
```
```
LIST_MS 327          (a second run measured 495 ms)
zed            | editor       | Zed
pycharm        | editor       | PyCharm
rider          | editor       | Rider
antigravity    | editor       | Antigravity
default-app    | default-app  | Default App
file-manager   | file-manager | File Manager
terminal       | terminal     | Terminal
```

Through the daemon's local API, on a path that contains spaces:

```powershell
GET http://127.0.0.1:31813/workspace-open-targets?path=C%3A%5CUsers%5Colege%5CWork%5Cphase2%20open%20targets%5Ca%20folder
```
```
ROUTE_MS=534
zed | editor | Zed
pycharm | editor | PyCharm
rider | editor | Rider
antigravity | editor | Antigravity
default-app | default-app | Default App
file-manager | file-manager | File Manager
terminal | terminal | Terminal
```

**Listing time on this desktop after the App Paths probe restriction: 327–534 ms** (in-process 327 ms and
495 ms; 534 ms including the daemon HTTP round trip). Four editors are discovered and no probe wanders
outside the adapters that declare Windows install paths — the behaviour
`probes App Paths only for adapters that declare Windows install paths` asserts, and the reason the listing
is a third of a second rather than seconds.

`zed` and `antigravity` additionally advertise `remoteSshCapabilities`; `pycharm` and `rider` do not.

## Explorer reveal of a FILE under a directory whose name contains a space

Fixture: `C:\Users\olege\Work\phase2 open targets\a folder\reveal me.txt` — a space in the grandparent, a
space in the parent, and a space in the file name.

```powershell
$sh = New-Object -ComObject Shell.Application
@($sh.Windows()) | ForEach-Object { $_.LocationURL }        # BEFORE
node --conditions=source --import tsx <script calling openPathInTarget({targetId:"file-manager", path:<the file>})>
@($sh.Windows()) | ForEach-Object { $_.LocationURL }        # AFTER
```
```
--- explorer windows BEFORE ---
(none)
--- launch ---
OPEN targetId=file-manager path=C:\Users\olege\Work\phase2 open targets\a folder\reveal me.txt
OPEN_OK ms=852
EXIT=0
--- explorer windows AFTER ---
file:///C:/Users/olege/Work/phase2%20open%20targets/a%20folder
```

**The observed `LocationURL` is the parent folder of the file** — a *reveal*, not an open — and both spaces
survive as `%20`. The call returned in 852 ms; `explorer.exe` does not block.

Closed afterwards:

```powershell
foreach ($w in @($sh.Windows())) { if ($w.LocationURL -eq $target) { $w.Quit() } }
```
```
closed=1
--- explorer windows AFTER QUIT ---
(none)
```

The same target through the daemon route, on the directory:

```powershell
POST http://127.0.0.1:31813/open-in-target
{"lineNumber":null,"columnNumber":null,"path":"C:\\Users\\olege\\Work\\phase2 open targets\\a folder","targetId":"file-manager"}
```
```
RESPONSE: {}
--- explorer AFTER ---
file:///C:/Users/olege/Work/phase2%20open%20targets/a%20folder
```

`{}` on success, as the route contract says. Window closed again afterwards (`explorer_closed=1`, then
`(end)` with no windows listed).

## Terminal — with `wt.exe` present

`wt.exe` **is** installed here:

```powershell
(Get-Command wt.exe).Source                     -> C:\Users\olege\AppData\Local\Microsoft\WindowsApps\wt.exe
Get-AppxPackage -Name Microsoft.WindowsTerminal -> Microsoft.WindowsTerminal_1.24.11911.0_x64__8wekyb3d8bbwe
```

so `resolveWindowsTerminalInvocation` takes the `wt -d <directory>` branch rather than the `cmd /d /s /c
start "" "<pwsh>" -NoLogo` fallback.

Through the daemon route:

```powershell
POST http://127.0.0.1:31813/open-in-target
{"columnNumber":null,"path":"C:\\Users\\olege\\Work\\phase2 open targets\\a folder","targetId":"terminal","lineNumber":null}
```
```
RESPONSE: {}
```

Process snapshot afterwards:

```
ProcessId ParentProcessId Name                CreationDate
    11912            2252 WindowsTerminal.exe 15.09.2026 8:26:57
    12252           11912 pwsh.exe            15.09.2026 8:26:58
    30356           11912 pwsh.exe            15.09.2026 8:41:41   <-- opened by this request
```

**A new `pwsh.exe` tab appeared under the already-running `WindowsTerminal.exe`.** That is the correct
`wt -d` behaviour: it hands the request to the existing Terminal window rather than starting a second one.
An earlier in-process run of the same target produced the same shape (new `pwsh.exe` pid 30820, parent
`WindowsTerminal.exe` 22732) and returned in **90 ms** — `wt.exe` exits immediately after the handoff.

Both tabs were closed afterwards with `taskkill /PID <pid> /F` (absolute `C:\Windows\System32\taskkill.exe`),
and the snapshot returned to the two tabs that were open before this gate started.

## Terminal — with `wt.exe` absent (the fallback console), gated real launch

```powershell
$env:BB_QA_REAL_LAUNCH="1"
pnpm --filter @bb/local-open-targets exec vitest run test/workspace-open-targets.test.ts -t "leaves a live interactive console behind for the terminal fallback" --reporter=verbose
```

The case builds a runtime whose env carries only `SystemRoot`, so `wt` cannot be resolved and the launcher
takes the `cmd.exe /d /s /c "start "" "<pwsh>" -NoLogo"` fallback; it then snapshots processes, kills what
it started, and asserts it is gone.

**First run — the launch worked, the case failed on its own budget:**

```
stdout | … > leaves a live interactive console behind for the terminal fallback
terminal fallback consoles: pid=26416 started=2026-09-15T08:42:57.0566900+03:00

 × … > leaves a live interactive console behind for the terminal fallback 5013ms
   → Test timed out in 5000ms.
 Test Files  1 failed (1)
      Tests  1 failed | 84 skipped (85)
EXIT=1
```

The console **was** launched and identified (pid 26416, started 08:42:57), matching the resolved PowerShell
executable. What failed is the case's own time budget: its body waits 2000 ms for the console, then 700 ms
after killing it, and takes two to three real `Get-CimInstance Win32_Process` snapshots at ~600 ms each
(`26-process-enumeration.md` measures 635–647 ms per snapshot). That is ≈ 4.5–5.1 s against vitest's default
5000 ms, and the case declares **no** timeout argument of its own — so under `BB_QA_REAL_LAUNCH=1` it is at
best marginal and here it lost. **This is a test-authoring defect in the gated QA case, not a launcher
defect**, and it is recorded as a finding rather than waved through.

**Same case, same head, with the budget it needs:**

```powershell
pnpm --filter @bb/local-open-targets exec vitest run test/workspace-open-targets.test.ts -t "leaves a live interactive console behind for the terminal fallback" --testTimeout=30000
```
```
 Test Files  1 passed (1)
      Tests  1 passed | 84 skipped (85)
   Duration  7.94s
EXIT_TIMEOUT30=0
```

**No console remains** after either run:

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -like "*-NoLogo*" }
```
```
(no rows)
```

and `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'"` lists only the dev-app supervisor tree, the
agent's own shells and unrelated system processes — no stray `cmd /c start` shim. The timed-out first run
still cleaned up: its `finally` block ran after the abort and pid 26416 was gone on the next check.

## Editor launch (VS Code substitute: Zed)

In-process, on the spaced directory:

```
OPEN targetId=zed path=C:\Users\olege\Work\phase2 open targets\a folder
```
```
ProcessId      : 38380
CreationDate   : 15.09.2026 0:46:56
ExecutablePath : C:\Users\olege\AppData\Local\Programs\Zed\Zed.exe
CommandLine    : "\\?\C:\Users\olege\AppData\Local\Programs\Zed\Zed.exe" zed-cli://8f8fc098-5d69-4e6f-baea-33255b91de74

ProcessId      : 22892
ExecutablePath : C:\Users\olege\AppData\Local\Programs\Zed\Zed.exe
CommandLine    : "…\Zed.exe" --crash-handler "C:\Users\olege\AppData\Local\Zed\zed-crash-handler-38380"
```

Zed launched and opened. Closed through `taskkill` at the absolute System32 path, as the addenda requires:

```powershell
C:\Windows\System32\taskkill.exe /PID 38380 /F
```
```
SUCCESS: The process with PID 38380 has been terminated.
--- zed after ---
0
```

### Finding: an editor target does not return until the editor exits

The in-process call reported `OPEN_OK ms=324814` — it resolved **only when Zed was killed**, 5 m 25 s later.
Reproduced at the product level through the daemon route:

```powershell
POST http://127.0.0.1:31813/open-in-target
{"targetId":"zed","lineNumber":null,"path":"C:\\Users\\olege\\Work\\phase2 open targets\\a folder","columnNumber":null}
```
```
NO RESPONSE after 20056 ms: The request was canceled due to the configured HttpClient.Timeout of 20 seconds elapsing.
--- zed processes ---
25572  15.09.2026 8:42:14  C:\Users\olege\AppData\Local\Programs\Zed\Zed.exe
10528  15.09.2026 8:42:14  C:\Users\olege\AppData\Local\Programs\Zed\Zed.exe
```

Zed started immediately and the editor window is usable, but `POST /open-in-target` was still open at 20 s.
Cause: `execInvocation` in `packages/local-open-targets/src/index.ts` is

```ts
await runtime.execFile(invocation.file, invocation.args, { env: invocation.env });
```

— it awaits child exit, and the Windows editor invocations set no `detached`. The `file-manager` and
`terminal` invocations are unaffected because `explorer.exe` and `wt.exe` exit right after handing off (852 ms
and 90 ms measured above), and the console fallback sets `detached: true` explicitly. On macOS the editor
path goes through `open -a`, which also returns immediately — so this is a **Windows-only** characteristic of
editor targets whose CLI stays attached for the editor's lifetime.

Scope call: this is **not** counted as a failure of the Step 8 gate bullet — the target does open, on a
spaced path, and the gate bullet is about opening. It is recorded as a Phase 2 finding for the phase report
and for `docs/platform-windows.md`'s known-limitations list, because a UI "Open in Zed" click leaves the
daemon request hanging for the editor's whole lifetime. Zed was killed to release it; nothing leaked.

## Folder picker — MANUAL (for the user)

Captured programmatically, from the running daemon:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:31813/status" -Method Get | ConvertTo-Json -Depth 5
```
```
{
  "hostId": "host_45kqba73eq",
  "connected": true,
  "protocolVersion": 200,
  "serverUrl": "http://127.0.0.1:23813",
  "supportsNativeFolderPicker": true,
  "platform": "win32"
}
```

`supportsNativeFolderPicker: true` on `platform: "win32"` — the R12 change is live in the running daemon.

The dialog itself needs a human: it is a `System.Windows.Forms.FolderBrowserDialog` run under `-STA`, it is
modal, and neither "pick a folder" nor "cancel" can be driven from this agent without synthesising input to
another process's window. **It was deliberately not opened.** Exact steps for the user:

1. Start the dev app: `pnpm dev:app current`, then open `http://localhost:15813`.
2. Go to **Settings → Projects → Add project** (or the "+" in the project sidebar) and click the
   **Browse…**/folder button next to the project path field.
3. **Expected:** a native Windows folder-browser dialog opens (not an in-app path text box). If the app
   shows a plain text input instead, `supportsNativeFolderPicker` did not reach the frontend — report that.
4. Navigate to a folder whose **name contains a space** — e.g. create `C:\Users\olege\Work\my project (x)`
   first — select it and confirm.
   **Expected:** the path field is filled with the full path including the space, unquoted and untruncated
   (`C:\Users\olege\Work\my project (x)`, never `C:\Users\olege\Work\my`). Create the project and check
   `bb project list --json` shows that exact `path`.
5. Open the picker a second time and press **Cancel**.
   **Expected:** the dialog closes, the path field keeps whatever it had, no error toast appears, and the
   app stays responsive. In `pnpm dev:logs dev` there should be no unhandled rejection from the picker
   command; a cancel is a normal empty result, not a failure.
6. Afterwards, check with `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'"` that no
   `-STA` PowerShell process is left behind.

## Gate bullet

> "Open in Explorer, VS Code and Windows Terminal work"

**PASS, with one substitution and two recorded findings.**

- Explorer: reveals a spaced file at its parent folder, 852 ms, `{}` from the daemon route. PASS.
- Windows Terminal: `wt -d` opens a new tab in the running Terminal at the spaced directory, 90 ms, `{}`
  from the daemon route; the `wt`-absent fallback launches a real live console and leaves none behind. PASS.
- Editor: **Zed instead of VS Code** (not installed here) — opens the spaced directory correctly, but the
  call does not return until the editor exits (finding above). PASS for "works", with the finding recorded.
- The gated liveness case cannot pass under vitest's default 5 s timeout as written (finding above); it
  passes at `--testTimeout=30000`.
- Folder picker: MANUAL, steps above; `supportsNativeFolderPicker: true` captured programmatically.
