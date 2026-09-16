# Terminals on native Windows: Ctrl+C, resize, UTF-8 (Phase 3 gate, Step 4)

Host and dev instance: `00-host.md`. Machine `host_45kqba73eq` ("OMEN"), dev server
`http://127.0.0.1:23813`, daemon port `31813`. CLI invoked as `node apps/cli/dist/index.js …`.
Raw transcript: `20-terminal-ctrl-c-resize-utf8.txt` (two runs, A and B).

Scripts were run with **`pwsh`**, not `powershell` — see `00-host.md`, "Shells".

## Result

| check | outcome |
|---|---|
| create on `C:\Users\olege\Work` at 80×24 | `status: running`, `CREATE_EXIT=0` |
| shell pid observable and reaped | pid `4564`, in `tasklist` before close, **gone** after |
| resize to 120×40 | `RESIZE_EXIT=0`; `show` reports `cols=120 rows=40`; pty emitted `ESC[8;40;120t` |
| UTF-8 round trip | `Привет` echoed and printed — `CONTAINS_PRIVET=True` |
| Ctrl+C (raw `0x03`) interrupts `Start-Sleep -Seconds 30` | prompt back in **804 ms** (budget 5 s) |
| terminal usable after Ctrl+C | `Write-Output GATE-MARKER` ran — `CONTAINS_MARKER=True` |
| close | `status: exited`, `exitCode: -1073741510`, `closeReason: "user"`, `CLOSE_EXIT=0` |
| list after close | `{"sessions": []}` |

## Create, resize, UTF-8

```powershell
node apps/cli/dist/index.js terminal create --machine host_45kqba73eq --cwd C:\Users\olege\Work --title gate --cols 80 --rows 24 --json
```
```json
{"id":"term_iws53k3mq9","hostId":"host_45kqba73eq","title":"gate","initialCwd":"C:\\Users\\olege\\Work","cols":80,"rows":24,"status":"running","exitCode":null,"closeReason":null,"lastUserInputAt":null}
```
```
CREATE_EXIT=0
PWSH_PIDS_BEFORE=7480,12252,16700,21500
PWSH_PIDS_AFTER=4564,7480,12252,16700,21500
TERMINAL_SHELL_PID=4564
```

The pid is not on the terminal payload (`terminal show --json` carries no `pid` field), so it was taken by
differencing `Get-Process pwsh` across the create — recorded because a later gate needs the same trick.

```powershell
node apps/cli/dist/index.js terminal resize term_iws53k3mq9 --cols 120 --rows 40
```
```
Resized terminal term_iws53k3mq9 to 120x40
RESIZE_EXIT=0
AFTER_RESIZE cols=120 rows=40
```

```powershell
node apps/cli/dist/index.js terminal send term_iws53k3mq9 --text "Write-Output ('При' + 'вет')`r"
node apps/cli/dist/index.js terminal output term_iws53k3mq9 --json
```

Scrollback, base64-decoded from the chunk payloads (escape bytes stripped for readability):

```
]0;C:\Program Files\PowerShell\7\pwsh.exe …PS C:\Users\olege\Work> [8;40;120t
…
[1;25HWrite-Output ('При' + 'вет')
Привет
]133;D;0 …PS C:\Users\olege\Work>
```
```
SEND_EXIT=0
OUTPUT_EXIT=0
CONTAINS_PRIVET=True
```

`ESC[8;40;120t` is the pty reporting the new 40×120 geometry — the resize reached ConPTY, not just the
daemon's record. The Cyrillic string survives the CLI → server → daemon → ConPTY → scrollback round trip
byte-for-byte.

## Ctrl+C

The interrupt was sent as a **raw `0x03` byte** through `bb terminal send --stdin`, redirected from a
one-byte file so nothing in the shell could re-encode it:

```powershell
[System.IO.File]::WriteAllBytes("$env:TEMP\bb-gate-ctrl-c.bin", [byte[]](3))
cmd /c "node apps\cli\dist\index.js terminal send term_iws53k3mq9 --stdin < `"$env:TEMP\bb-gate-ctrl-c.bin`""
```

Before the interrupt the pty was inside `Start-Sleep -Seconds 30`:

```
PRE_CTRLC_TEXT=
Start-Sleep -Seconds 30[K
```

After it, polling `terminal output --since-seq` every 100 ms:

```
POST_CTRLC_TEXT=
]133;D; …PS C:\Users\olege\Work>
PROMPT_RETURNED=True ELAPSED_MS=804
CTRLC_SEND_EXIT=0
```

804 ms from the send returning to a fresh prompt in the scrollback — the Task 3 shape ("the interrupt is
observed as a new prompt before the marker command is sent"). The follow-up marker then ran in the same
terminal:

```
MARKER_TEXT=
Write-Output GATE-MARKER
GATE-MARKER
CONTAINS_MARKER=True
```

## Close, and what `terminal.exited` carried

```powershell
cmd /c "tasklist /FI `"PID eq 4564`" /NH"     # before close
node apps/cli/dist/index.js terminal close term_iws53k3mq9 --json
cmd /c "tasklist /FI `"PID eq 4564`" /NH"     # after close
node apps/cli/dist/index.js terminal list --machine host_45kqba73eq --json
```
```
pwsh.exe                      4564 Console                    1    107 748 K

{"id":"term_iws53k3mq9", … "status":"exited","exitCode":-1073741510,"closeReason":"user", …}
CLOSE_EXIT=0

INFO: No tasks are running which match the specified criteria.

{"sessions": []}
LIST_EXIT=0
```

`-1073741510` is `0xC000013A` (`STATUS_CONTROL_C_EXIT`) — the same code the ConPTY smoke's `close` check
accepts (`25-conpty-smoke.md`, Task 11). The shell process is gone from `tasklist`, and the session is gone
from `terminal list`.

## Finding: `bb terminal send --enter` does not submit a line on a Windows terminal

**Not a regression against `9a07e6994`** — there were no Windows terminals at the Phase 2 tip. Recorded as
a Phase 3 gap in the CLI surface, not fixed in this gate.

Run A followed the brief literally and sent the command with a trailing **LF**
(`--text "…`n"`, which is exactly what `--enter` appends —
`apps/cli/src/commands/terminal.ts:468` concatenates `Buffer.from("\n", "utf8")`). The command never ran;
PSReadLine took the LF as a *continuation*, and the scrollback shows `>>` prompts stacking up:

```
[?25l[1;25H[28X[37m
>> [93mWrite-Output [37m([36m'При' [90m+ [36m'вет'[37m)
…
>> [93mStart-Sleep [90m-Seconds [97m30
>> [93mWrite-Output [37m(…
```
```
CONTAINS_PRIVET=False
CONTAINS_MARKER=False
```

Run B sent the identical text with a trailing **CR** (`\r`) and every command ran (the table above). On a
POSIX pty the slave's `ICRNL` termios flag maps CR to NL on input, so `\n` is accepted there; ConPTY has no
termios layer, so the Enter key is `\r` and only `\r`. The app's own terminal panel is unaffected — xterm.js
sends `\r` — so this is specific to `bb terminal send --enter` / `--text` against a win32 host.

Whoever owns the Enter byte (CLI, server, or daemon) is a design decision, so no fix was attempted here.

## MANUAL — for the user (R8)

The gate proves the daemon and CLI paths. The **app panel** path needs a human at the desktop. Exact steps:

1. `pnpm dev:app current`, then open `http://localhost:15813` (the port `pnpm --silent dev:app env` prints).
2. Open any thread, then its terminal panel.
3. In the panel type `Start-Sleep -Seconds 30` and press Enter. While it runs, press **Ctrl+C**.
   *Record:* does the prompt come back, and roughly how fast?
4. Resize the browser/app window (or drag the panel divider) while the terminal is open.
   *Record:* does the terminal reflow to the new size, and does `ESC[8;<rows>;<cols>t` show no visual
   corruption (no duplicated prompt lines, no truncated right edge)?
5. Type `echo Привет` and press Enter.
   *Record:* is `Привет` rendered correctly in the panel (not `Ð¿Ñ€Ð¸Ð²ÐµÑ‚` and not `??????`)?
6. Close the terminal from the panel's close control.
   *Record:* what the panel shows afterwards (an "exited" state, a blank pane, or the session disappearing
   from the terminal list), and whether a `pwsh.exe` for it survives in Task Manager.

Nothing in this file is inferred from the app UI; only the CLI/daemon behaviour above was measured.
