# `bb` from PowerShell (Phase 2 gate, Step 9)

Commit `7d0603bb4777132efd0e122ffc6d8064105333be`, node v22.19.0, pwsh 7.6.6, the reference Windows desktop
(`00-host.md`). Every block below is the command as issued and its verbatim output; `EXIT_*` is
`$LASTEXITCODE` read in the same shell immediately after.

## Install into a directory whose path contains a space

```powershell
$dest = "C:\Users\olege\Work\bb space test\cli"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "C:\Users\olege\Work\bb\apps\cli\bin" -Destination $dest -Recurse -Force
Copy-Item "C:\Users\olege\Work\bb\apps\cli\dist" -Destination $dest -Recurse -Force
Get-ChildItem $dest | Select-Object Name
```
```
copied

Name
----
bin
dist
```

The CLI was built by the gate's Step 2 run (`pnpm exec turbo run build typecheck`,
`Tasks: 144 successful, 144 total`, `EXIT=0` — `30-build-typecheck.txt`), so no separate
`turbo run build --filter=@bb/cli` was needed.

The shim being exercised is `apps/cli/bin/bb.cmd`, a single line:

```
@node "%~dp0..\dist\index.js" %*
```

## `--version` from PowerShell and from `cmd.exe`

```powershell
& "$dest\bin\bb.cmd" --version
"EXIT_PWSH=$LASTEXITCODE"
cmd.exe /d /c "`"$dest\bin\bb.cmd`" --version"
"EXIT_CMD=$LASTEXITCODE"
```
```
--- version from pwsh ---
0.0.0-dev
EXIT_PWSH=0
--- version from cmd.exe ---
0.0.0-dev
EXIT_CMD=0
```

**PASS.** The version prints identically from both shells, and the space in
`C:\Users\olege\Work\bb space test\cli` is handled: `%~dp0` expands with the space and the quoted
`"%~dp0..\dist\index.js"` survives `cmd.exe`'s own re-parse. No `'C:\Users\olege\Work\bb'` truncation,
which is the classic unquoted-shim failure.

## `bb project list --json` against the dev instance

The dev instance was running (`pnpm dev:app current`, instance `work-bb-21d97a8d7c85`). Its environment was
taken from the launcher itself rather than assumed:

```powershell
$lines = pnpm --silent dev:app env --powershell | Out-String
$lines
Invoke-Expression $lines
```
```
$env:BB_SERVER_URL = "http://127.0.0.1:23813"
$env:BB_HOST_DAEMON_PORT = "31813"
$env:BB_PROJECT_ID = "proj_personal"
Remove-Item Env:BB_THREAD_ID -ErrorAction SilentlyContinue
Remove-Item Env:BB_ENVIRONMENT_ID -ErrorAction SilentlyContinue
Remove-Item Env:BB_THREAD_STORAGE -ErrorAction SilentlyContinue
```

Then, from the spaced install directory:

```powershell
& "$dest\bin\bb.cmd" project list --json
"EXIT_PROJECT_LIST=$LASTEXITCODE"
```
```
[
  {
    "id": "proj_x4gdw7vz68",
    "kind": "standard",
    "name": "phase1-ui",
    "gitRemoteUrl": null,
    "createdAt": 1789296184785,
    "updatedAt": 1789296184785,
    "sources": [
      {
        "id": "src_hcc6h4h2ax",
        "projectId": "proj_x4gdw7vz68",
        "type": "local_path",
        "hostId": "host_45kqba73eq",
        "path": "C:\\Users\\olege\\Work\\phase1-ui",
        "isDefault": true,
        "createdAt": 1789296184785,
        "updatedAt": 1789296184785
      }
    ]
  },
  {
    "id": "proj_j3jwwb7f8v",
    "kind": "standard",
    "name": "phase1-cli",
    …
        "path": "C:\\Users\\olege\\Work\\phase1-cli",
    …
  },
  {
    "id": "proj_tqqsn3xw8q",
    "kind": "standard",
    "name": "phase1-missing",
    …
        "path": "C:\\Users\\olege\\Work\\phase1-missing",
    …
  }
]
EXIT_PROJECT_LIST=0
```

**PASS.** The dev instance's projects come back as JSON, with Windows paths correctly escaped in the JSON
output, from a CLI installed under a path with a space. (The three projects are Phase 1's leftovers in the
dev database; see `qa/windows/phase-1/00-host.md`.)

Two more commands exercised the same install during Step 4 and are recorded here as additional coverage of
`bb` from PowerShell:

```powershell
& "$dest\bin\bb.cmd" project create --name "phase2-hook" --root "C:\Users\olege\Work\phase2-hook" --json
```
```
{ "id": "proj_ffz6bbwjau", "name": "phase2-hook", … "path": "C:\\Users\\olege\\Work\\phase2-hook" … }
EXIT_CREATE=0
```

```powershell
& "$dest\bin\bb.cmd" thread stop thr_kwxi54ybzq
```
```
Thread thr_kwxi54ybzq stopped
EXIT_STOP=0
```

And the destructive-action guard behaves correctly when the CLI is not attached to an interactive terminal —
worth recording because it is a Windows-console-detection path:

```powershell
& "$dest\bin\bb.cmd" project delete proj_ffz6bbwjau --json
```
```
Error: Refusing destructive action without an interactive terminal. Re-run with --yes to confirm.
EXIT_DELETE=1
```

## Ctrl+C through `bb.cmd` — MANUAL (for the user)

Sending a real `Ctrl+C` to a console process is **not scriptable** from this agent: `taskkill`,
`Stop-Process` and `GenerateConsoleCtrlEvent` through a spawned shell either terminate without the
console control path or affect the agent's own console group. The behaviour is therefore recorded as
MANUAL with the exact steps and the expected result.

**Steps for the user**

1. Open Windows Terminal (or any interactive `pwsh`/`cmd` console).
2. `cd "C:\Users\olege\Work\bb space test\cli"` (or wherever a built CLI lives).
3. Run a command that stays in the foreground, e.g. `.\bin\bb.cmd thread watch <threadId>` or simply
   `.\bin\bb.cmd --help | more` and leave it at the pager.
4. Press `Ctrl+C`.

**Expected, and accepted per the phase ruling**: `cmd.exe` prints

```
Terminate batch job (Y/N)?
```

and waits for a keypress before the prompt returns. This is `cmd.exe`'s own batch-file behaviour for any
`.cmd` wrapper — it is not something `bb` emits and not something `bb` can suppress from inside the batch
file. The Node process itself receives the `SIGINT` and shuts down first; the prompt is only about
`cmd.exe` unwinding the batch script. The ruling for this phase is that this is **accepted Windows
behaviour**, not a defect: every npm-, pnpm- and yarn-generated `.cmd` shim behaves the same way, and the
alternative (a native `.exe` launcher) is out of phase.

If the user sees anything other than that prompt — in particular a hung console, a second `bb` process left
running, or no shutdown of the Node process — that **is** a finding and should be reported.

## npm-style shim (documented packaging limitation)

The addenda asks for a simulation of an npm-generated `bb.cmd` whose target is the POSIX `bin/bb` shell
script rather than `dist/index.js`. Written to `<dest>\npm-shim\bb.cmd`:

```
@ECHO off
SETLOCAL
SET "_prog=node"
SET PATHEXT=%PATHEXT:;.JS;=;%
"%_prog%"  "%~dp0\..\bin\bb" %*
ENDLOCAL
```

### Invoked directly — raw `SyntaxError`, as documented

```powershell
& "$dest\npm-shim\bb.cmd" --version
```
```
C:\Users\olege\Work\bb space test\cli\bin\bb:2
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
                        ^^

SyntaxError: missing ) after argument list
    at wrapSafe (node:internal/modules/cjs/loader:1638:18)
    at Module._compile (node:internal/modules/cjs/loader:1680:20)
    at Object..js (node:internal/modules/cjs/loader:1839:10)
    at Module.load (node:internal/modules/cjs/loader:1441:32)
    at Function._load (node:internal/modules/cjs/loader:1263:12)
    at TracingChannel.traceSync (node:diagnostics_channel:322:14)
    at wrapModuleLoad (node:internal/modules/cjs/loader:237:24)
```

Node is handed a `/bin/sh` script and parses it as JavaScript. This is the documented packaging limitation:
bb ships its own `bb.cmd` pointing at `dist/index.js`; an npm-generated shim that points at the POSIX
`bin/bb` cannot work on Windows. **Evidence only — no fix in this phase.**

### Reached through `BB_CLI` — refused with a named error, not a `SyntaxError`

```powershell
$env:BB_CLI = "$dest\npm-shim\bb.cmd"
& "$dest\bin\bb.cmd" --version
"EXIT_BBCLI=$LASTEXITCODE"
```
```
BB_CLI=C:\Users\olege\Work\bb space test\cli\npm-shim\bb.cmd
bb: failed to re-exec BB_CLI=C:\Users\olege\Work\bb space test\cli\npm-shim\bb.cmd: Windows launcher C:\Users\olege\Work\bb space test\cli\npm-shim\bb.cmd is not a Node shim bb can start directly
EXIT_BBCLI=1
```

This is **better than the addenda predicted**. The addenda expected the raw `SyntaxError` to leak through
the `BB_CLI` re-exec path too; commit `e802eca88` ("Gate the .ps1 interpreter mapping on Windows and harden
the cmd shim") makes the re-exec inspect the launcher first and refuse it with a diagnosable message naming
the offending path. The raw `SyntaxError` now appears only when the bad shim is invoked directly, where bb
is not in the call chain at all and has nothing to intercept. Recorded here as a positive delta against the
implementation-time expectation.

## Cleanup

```powershell
foreach ($p in "C:\Users\olege\Work\phase2-hook","C:\Users\olege\Work\phase2 open targets","C:\Users\olege\Work\bb space test") { if (Test-Path $p) { Remove-Item -Recurse -Force $p -Confirm:$false }; "Test-Path $p : " + (Test-Path $p) }
```
```
Test-Path C:\Users\olege\Work\phase2-hook : False
Test-Path C:\Users\olege\Work\phase2 open targets : False
Test-Path C:\Users\olege\Work\bb space test : False
```

The `phase2-hook` **project row** was left in the dev database: `pnpm dev:stop` had already run when the
delete was attempted, and the CLI correctly refused the destructive action without an interactive terminal.
This matches Phase 1, which also left its QA project rows in the dev database
(`qa/windows/phase-1/00-host.md`, "Dev instance state left behind"). The project's source directory no
longer exists, so the row is inert QA state.

## Gate bullet

> "`bb` runs from PowerShell" (including a directory with a space)

**PASS.** `bb.cmd --version` returns `0.0.0-dev` with `EXIT=0` from both PowerShell and `cmd.exe` out of
`C:\Users\olege\Work\bb space test\cli`, and `bb project list --json`, `bb project create --json` and
`bb thread stop` all work against the dev instance from that same install. Ctrl+C is MANUAL (steps above);
the npm-style shim limitation is documented, not fixed.
