# Using the installed app (Phase 4 gate, Step 6)

Raw transcript: `22-use-installed-app.txt`. Screenshots: `27-window-chrome.png` (dark) and
`27-window-chrome-light-overlay.png` (the same window after the OS theme flip).

> ## Result: **PASS**
>
> The installed build N (`0.42.1`) started from `%LOCALAPPDATA%\Programs\bb\bb.exe`, answered
> `/health` on 38886, and ran a real Codex turn that wrote `gate.txt`. The packaged process tree is
> **nine `bb.exe` rows and zero `node.exe` rows**, exactly as `docs/platform-windows.md` describes. A
> machine-scoped terminal closed with **`exitCode: null`**, which is the `-1073741510` normalisation this
> phase added. The caption overlay measured **`#1f1f1f` with `#e8e8e8` symbols** in dark and
> **`#f6f6f6` with `#1f1f1f` symbols** in light, and re-applied itself on an OS theme change and back.

## Launch and health

No `bb.exe` was running and neither 38886 nor 38887 was held before the launch, so the one-instance rule
held. `BB_DESKTOP_VERSION_FEED_URL` was explicitly removed from the environment for this step.

```
BBCOUNT_BEFORE=0
(no listeners)
APP_PID=42468
HEALTH_OK=True elapsedTo=2026-09-16T14:57:47.5172847+03:00
{"ok":true,"launchId":"e7643fd5-b2eb-42de-b624-c280336f6717"}
```

The dev instance was never started during this gate (`00-host.md`), so `pnpm dev:stop` was not needed and
38886/38887 were free.

## The packaged process tree

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -like "bb*.exe" -or $_.CommandLine -like "*bb-app-bridge*" }
```

| pid       | parent                      | what it is                                                                  |
| --------- | --------------------------- | --------------------------------------------------------------------------- |
| 42468     | 41408 (the launching shell) | the Desktop process — the only one with a window                            |
| 48348     | 42468                       | `--type=gpu-process`                                                        |
| 47644     | 42468                       | `--type=utility --utility-sub-type=network.mojom.NetworkService`            |
| 45436     | 42468                       | `--type=renderer`                                                           |
| **15352** | 42468                       | **the runtime leader**: `bb.exe …\app.asar.unpacked\dist\bb-app-bridge.mjs` |
| **29248** | 15352                       | **the server** — owns port **38886**                                        |
| **39408** | 15352                       | **the host daemon** — owns port **38887**                                   |
| 44756     | 39408                       | daemon child                                                                |
| 42060     | 39408                       | daemon child                                                                |

```powershell
@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*bb*" -and $_.CommandLine -notlike "*Codex*" }).Count
```

```
0
```

**Nine `bb.exe`, zero `node.exe`.** The bridge, server and daemon are all `bb.exe` running with
`ELECTRON_RUN_AS_NODE`, which is why the process-hygiene smoke identifies the bridge by the
`bb-app-bridge.mjs` string in its command line rather than by image name. Only one row has a window title
(`bb`, pid 42468); every other row is windowless, which matters for the Quit path — `taskkill`'s close
request has nothing to deliver to them.

```powershell
Get-NetTCPConnection -State Listen -LocalPort 38886,38887
```

```
LocalPort OwningProcess
    38887         39408
    38886         29248
```

`owned-runtime.json` names the leader the desktop will verify before stopping it:

```json
{
  "bridgePath": "C:\\Users\\olege\\AppData\\Local\\Programs\\bb\\resources\\app.asar.unpacked\\dist\\bb-app-bridge.mjs",
  "pid": 15352,
  "serverUrl": "http://127.0.0.1:38886",
  "startedAt": "2026-09-16T11:57:40.298Z"
}
```

## A real Codex turn through the installed app

The repo's CLI was pointed at the **installed app's** server, not the dev instance:

```powershell
$env:BB_SERVER_URL = "http://127.0.0.1:38886"
node apps/cli/dist/index.js machine list --json          # MACHINE_EXIT=0
```

```json
[{ "id": "host_ag23qwqrfb", "name": "OMEN", "status": "connected", "type": "persistent", "maxPermissionMode": "full", … }]
```

This is a **different host id** from the dev instance's (`host_45kqba73eq` in
`qa/windows/phase-3/00-host.md`): the packaged app runs its own daemon against `%USERPROFILE%\.bb`, and it
enrolled its own machine row. `codex` reports `available: true`.

```powershell
node apps/cli/dist/index.js project create --name phase4-gate --root C:\Users\olege\Work\phase4-gate --machine OMEN --json
```

```json
{
  "id": "proj_jfy2xm4a6x",
  "name": "phase4-gate",
  "sources": [
    {
      "id": "src_bjwat4z3qy",
      "type": "local_path",
      "hostId": "host_ag23qwqrfb",
      "path": "C:\\Users\\olege\\Work\\phase4-gate",
      "isDefault": true
    }
  ]
}
```

The backslash path was accepted by `project create --root` and stored as typed — Phase 1's canonicalisation
path, end to end through the packaged daemon.

### One finding worth recording: `thread spawn --environment` refuses a backslash path

```powershell
node apps/cli/dist/index.js thread spawn … --environment "C:\Users\olege\Work\phase4-gate" … --json
```

```
Error: Invalid ID from --environment flag: "C:\Users\olege\Work\phase4-gate". IDs must contain only letters, digits, hyphens, and underscores.
SPAWN_EXIT=1
```

The same path with forward slashes is accepted:

```powershell
node apps/cli/dist/index.js thread spawn --project proj_jfy2xm4a6x --provider codex --environment "C:/Users/olege/Work/phase4-gate" --prompt "Create gate.txt containing 'phase 4'" --json
```

```json
{ "id": "thr_5b6g7c66wx", "providerId": "codex", "status": "starting",
  "titleFallback": "Create gate.txt containing 'phase 4'", … }
```

```
SPAWN_EXIT=0
```

`--environment` takes "an existing environment ID **or** an unmanaged workspace path", and its
id-or-path discriminator treats a drive-absolute path with **backslashes** as a malformed id instead of a
path, while the forward-slash spelling of the same path is routed correctly. Both spellings are accepted
everywhere else this gate touched (`project create --root`, `terminal create --cwd`). This is a **CLI
flag-parsing gap, not a daemon or server problem**, and it is cosmetic in the sense that a working
spelling exists — but a Windows user's natural spelling is the one that fails, and the error message
("IDs must contain only letters, digits…") does not hint that a path was expected. It is not a Phase 4
regression: the flag's discriminator predates this phase and is unchanged by it. Recorded here so it can
be picked up as its own change rather than lost.

### The turn, and the file it wrote

```powershell
node apps/cli/dist/index.js thread wait thr_5b6g7c66wx --status idle --timeout 420 --json   # WAIT_EXIT=0
```

```json
{
  "threadId": "thr_5b6g7c66wx",
  "matched": true,
  "target": { "kind": "status", "status": "idle" }
}
```

```powershell
Test-Path "C:\Users\olege\Work\phase4-gate\gate.txt"
Get-Content "C:\Users\olege\Work\phase4-gate\gate.txt" -Raw
```

```
True
phase 4
```

A real Codex agent, running under the packaged host daemon on native Windows, created the file the prompt
asked for. 7 bytes: `phase 4` and a newline.

## Terminal exit code

The brief asks for the exit notice the app shows when a terminal is closed — `Terminal exited`, not the
negative code. The renderer's text was not captured (that is the `MANUAL` item below), but the value the
renderer formats **was**, straight out of the packaged daemon:

```powershell
node apps/cli/dist/index.js terminal create --machine OMEN --cwd "C:/Users/olege/Work/phase4-gate" --title "phase4-gate terminal" --json
```

```json
{
  "id": "term_tspsq8dcib",
  "status": "running",
  "exitCode": null,
  "closeReason": null,
  "cols": 80,
  "rows": 24
}
```

```powershell
node apps/cli/dist/index.js terminal close term_tspsq8dcib --json     # CLOSE_EXIT=0
node apps/cli/dist/index.js terminal show  term_tspsq8dcib --json     # SHOW_EXIT=0
node apps/cli/dist/index.js terminal list  --machine OMEN --json      # LIST_EXIT=0
```

```json
{ "id": "term_tspsq8dcib", "status": "exited", "exitCode": null, "closeReason": "user", … }
{ "sessions": [] }
```

**`exitCode: null` with `closeReason: "user"`** is exactly what
`normalizeTerminalExitCode` produces on win32 for a close bb itself requested: the raw ConPTY code is
`-1073741510` (visible in the CI ConPTY smoke, `41-ci-run.md`), and the daemon maps it to `null` only for
this case. A `null` exit code is what the app renders as `Terminal exited`; the number would have appeared
had the mapping not run. The session is also gone from `terminal list`, so nothing leaked.

### `MANUAL — for the user`

To confirm the rendered string rather than the value behind it: with the app running, open a terminal in
the UI (thread view → terminal), close it with the tab's close control, and confirm the pane shows
**`Terminal exited`** and not `Terminal exited with code -1073741510`. One screenshot is enough.

## Window chrome and the caption overlay

`27-window-chrome.png` is the window as it normally looks on this host: `titleBarStyle: "hidden"` with the
48 px caption overlay at the top right, the three Windows 11 caption buttons drawn over the app's own
header, and the right-panel toggle sitting clear of them — the 138 px reserve `AppPageHeader` applies.

Captures use **`PrintWindow`**, which asks the window to render itself into a bitmap, rather than
`CopyFromScreen`, which photographs the screen rectangle and returns whatever window happens to be on top.
This is recorded because the first attempt used the latter and produced an unrelated window's content;
any later gate driving this app should use `PrintWindow`.

The theme was switched once, through the **OS** setting, which is the path
`docs/platform-windows.md` names for the `nativeTheme` `updated` event:

```powershell
$key = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize"
(Get-ItemProperty $key -Name AppsUseLightTheme).AppsUseLightTheme    # 0
Set-ItemProperty $key -Name AppsUseLightTheme -Value 1               # flip to light
… capture …
Set-ItemProperty $key -Name AppsUseLightTheme -Value 0               # restored
```

Sampling the captured bitmaps inside the overlay band and on the close glyph:

| capture                                 | overlay background (x = 1450 … 1610, y = 8) | close glyph (1584, 30) |
| --------------------------------------- | ------------------------------------------- | ---------------------- |
| dark, before the flip                   | `#1F1F1F` at all four points                | `#E8E8E8`              |
| after `AppsUseLightTheme = 1`           | `#F6F6F6` at all four points                | `#1F1F1F`              |
| after restoring `AppsUseLightTheme = 0` | `#1F1F1F` at all four points                | `#E8E8E8`              |

The measured values are exactly the documented pair — dark `#1f1f1f` with `#e8e8e8` symbols, light
`#f6f6f6` with `#1f1f1f` symbols — and the overlay follows the OS change **in both directions** without a
restart.

`27-window-chrome-light-overlay.png` shows something the table alone does not: during the flip the
**overlay** went light while the **web content stayed dark**. That is not a fault. The overlay follows
`nativeTheme`, while the renderer follows the app's own appearance preference, which on this fresh
`userData` was an explicit dark rather than "follow the system". The screenshot is kept because it is the
clearest single image of the overlay re-applying, and because a reader who sees that combination in the
wild should know it is expected rather than a half-applied theme.

The OS theme was restored to its original value (`AppsUseLightTheme = 0`) immediately, and the final
capture confirms the overlay returned to `#1F1F1F`.
