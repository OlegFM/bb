# Host facts (Phase 4 gate, Task 13)

Machine: the same reference Windows desktop used for Phase 0 through Phase 3
(`qa/windows/phase-0/00-host.md` … `qa/windows/phase-3/00-host.md`) — Windows 11 Pro, OS version
`10.0.26200.0`, node from `C:\nvm4w\nodejs`. Branch `windows-native/phase-4`, stacked on
`windows-native/phase-3`.

Every command in this gate was run in a single shell and the `EXIT=` line after each block is
`$LASTEXITCODE` (PowerShell) or `$?` (Git Bash) read in that same shell immediately after the command.
The prose was composed by the agent from the captured output below; the fenced blocks are verbatim.

## Commit measured

| commit      | what it is                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `11dfe15db` | Phase 4 tip after the final whole-branch review and the docs corrections. Every step of this gate — build, typecheck, tests, installer, install/use/update/quit/tray/uninstall, POSIX check and CI — measures this commit. |
| `47bb778d8` | Phase 3 tip, the base commit for the mac/Linux `--print-config` comparison in `40-posix-check.md`.                                                                                                                         |

No gate fix commits were needed: the working tree was clean at `11dfe15db` when the gate started and the
only commit this task adds is the evidence commit itself.

## Toolchain and commit

Command:

```powershell
Get-Date -Format "o"; git rev-parse HEAD; git rev-parse --abbrev-ref HEAD; node -v; pnpm -v; git --version; "$([System.Environment]::OSVersion.Version)"; (Get-Command node).Source; "pwsh $($PSVersionTable.PSVersion)"; "EXIT=$LASTEXITCODE"
```

Output:

```
2026-09-16T14:04:59.1507886+03:00
11dfe15db7d21c1f4526b23ee4762975fcd2123f
windows-native/phase-4
v22.19.0
9.15.0
git version 2.52.0.windows.1
10.0.26200.0
C:\nvm4w\nodejs\node.exe
pwsh 7.6.6
EXIT=0
```

Identical to the Phase 3 gate host block except for the commit: same Node, pnpm, git, OS build, node
install location and PowerShell build (`7.6.6`).

## Account: standard user, UAC on

Command:

```powershell
whoami /groups | Select-String "S-1-5-32-544" | ForEach-Object { $_.Line }; "WHOAMI_EXIT=$LASTEXITCODE"
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

Output (the group name is localised on this host):

```
BUILTIN\Администраторы                                               Alias            S-1-5-32-544                                                                                                Group used for deny only
WHOAMI_EXIT=0
False
```

Read carefully: the account **is** a member of the local Administrators alias, but the line ends with
**`Group used for deny only`** — this is the UAC-filtered token every non-elevated process on this host
receives, and `IsInRole(Administrator)` is `False` in it. Every shell, install, uninstall and app launch in
this gate ran in exactly this token. So the install/uninstall evidence is an **unelevated, effectively
standard-user** run: no UAC prompt was accepted anywhere in this gate, and none appeared. What this host
does _not_ prove is the stricter case of an account with no Administrators membership at all, where the
filtered token also lacks the deny-only SID; a per-user NSIS install writes only to `%LOCALAPPDATA%` and
`HKCU`, so no step of this gate would have needed the difference, but it is untested here.

## Defender and SmartScreen

Command:

```powershell
Get-MpComputerStatus | Select-Object -ExpandProperty RealTimeProtectionEnabled; "MP_EXIT=$LASTEXITCODE"
(Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer" -Name SmartScreenEnabled -ErrorAction SilentlyContinue).SmartScreenEnabled
(Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\AppHost" -Name EnableWebContentEvaluation -ErrorAction SilentlyContinue).EnableWebContentEvaluation
(Get-ItemProperty "HKLM:\SOFTWARE\Policies\Microsoft\Windows\System" -Name EnableSmartScreen -ErrorAction SilentlyContinue).EnableSmartScreen
```

Output:

```
True
MP_EXIT=0
SmartScreenEnabled: (value not present)
EnableWebContentEvaluation: (value not present)
EnableSmartScreen policy: (value not present)
```

Defender real-time protection is **on**. None of the three SmartScreen knobs carries an explicit value:
the legacy `HKLM\…\Explorer\SmartScreenEnabled` value does not exist under that key at all (its property
list, printed in full, holds `ActiveSetupDisabled`, `FileOpenDialog`, `ShowRecommendations` … and no
`SmartScreenEnabled`), the per-user App Host toggle is unset, and no `EnableSmartScreen` policy is
applied. That combination is the shipped default — SmartScreen for apps and files is **on at its default
"Warn" setting**, configured through Windows Security rather than through any of these values. The
consequence for Step 5 is recorded there: the Mark-of-the-Web decides whether the reputation dialog
appears, not these registry values.

## Electron toolchain

Command:

```powershell
node -e "const p=require('./apps/desktop/package.json'); console.log(p.name, p.version, p.devDependencies.electron, p.devDependencies['electron-builder'], p.dependencies['electron-updater'])"
node -e "const p=require('./packages/bb-app/package.json'); console.log('bb-app', p.version)"
```

Output:

```
@bb/desktop 0.42.1
electron 41.7.0
electron-builder ^26.15.7
electron-updater ^6.8.3
bb-app 0.42.1
```

`0.42.1` is **build N** for the update test in `23-update-n-to-n1.md`; `0.42.2` is built there as N+1.
The two package versions are in lockstep, as the version-lockstep CI job requires.

## electron-builder cache

Command:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache" | Select-Object Name, LastWriteTime
```

Output:

```
Name        LastWriteTime
----        -------------
downloads   16.09.2026 8:21:29
icons@1.2.1 16.09.2026 8:21:29
```

`downloads/` holds the Electron 41.7.0 win32-x64 zip fetched by today's earlier `package:windows` smoke,
and `icons@1.2.1/` the icon tool bundle (`icon-tool.js`, `resvg.wasm`, `vips.wasm`). Both were already
warm, so the installer builds in Steps 4 and 7 did not download an Electron runtime; a cold host would add
that download to their wall time.

## Pre-existing state the gate had to account for

Command:

```powershell
"LOCALAPPDATA\Programs\bb exists=" + (Test-Path "$env:LOCALAPPDATA\Programs\bb")
"APPDATA\bb exists=" + (Test-Path "$env:APPDATA\bb")
Get-ChildItem "$env:APPDATA\bb" | Select-Object Name, Length, LastWriteTime
"USERPROFILE\.bb exists=" + (Test-Path "$env:USERPROFILE\.bb")
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" | Where-Object { $_.DisplayName -like "bb*" } | Select-Object DisplayName, DisplayVersion
```

Output:

```
LOCALAPPDATA\Programs\bb exists=False
APPDATA\bb exists=True

Name              Length LastWriteTime
----              ------ -------------
blob_storage             16.09.2026 11:54:44
Cache                    16.09.2026 9:24:27
Code Cache               16.09.2026 9:24:27
DawnGraphiteCache        16.09.2026 9:24:27
DawnWebGPUCache          16.09.2026 9:24:27
GPUCache                 16.09.2026 9:24:27
Local Storage            16.09.2026 9:24:27
Network                  16.09.2026 10:39:44
Session Storage          16.09.2026 11:54:51
Shared Dictionary        16.09.2026 9:24:27
.updaterId        36     16.09.2026 9:24:27
DIPS              36864  16.09.2026 12:07:57
Local State       490    16.09.2026 9:24:37
Preferences       270    16.09.2026 11:54:54
SharedStorage     4096   16.09.2026 9:54:39
window-state.json 223    16.09.2026 12:07:53

USERPROFILE\.bb exists=True

(no rows)
```

Three facts, each with a consequence for a later step:

- **`%LOCALAPPDATA%\Programs\bb` absent and no `bb*` Uninstall registry row** — the host carried no
  installed copy when the gate started, as the brief expects, so Step 5 is a genuine first install.
- **`%APPDATA%\bb` present.** This is not a leftover from a previous _install_; it is the Electron
  `userData` directory written by today's earlier Task 11/12 `win-unpacked` smokes and live checks, run
  from `release/win-unpacked\bb.exe` before this gate began. Its contents are the Chromium profile
  (`Cache`, `Code Cache`, `GPUCache`, `Local Storage`, `Network`, `Session Storage`), the Electron
  `Preferences` / `Local State` pair, the app's `window-state.json`, and `.updaterId`. Because
  `26-uninstall.md` has to assert what the uninstaller leaves behind, this directory was **renamed aside**
  before Step 5 rather than deleted, so the install/uninstall claims describe only what this gate's own
  install and run produced. The rename is recorded in `26-uninstall.md` along with the disposition.
- **`%USERPROFILE%\.bb` present and left untouched.** It is the user's real workspace state, not gate
  state. No step of this gate wrote to it, and Step 10 asserts the uninstaller did not touch it.

## Ports and processes at the start

Command:

```powershell
"BBCOUNT=" + (@(Get-Process bb -ErrorAction SilentlyContinue).Count)
Get-NetTCPConnection -State Listen -LocalPort 38886,38887,15813,23813,31813 -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess
```

Output:

```
BBCOUNT=0
(no listeners)
```

No `bb.exe` was running and neither the packaged ports (38886 app / 38887 server) nor the dev instance
ports (15813 / 23813 / 31813) were held, so `pnpm dev:stop` was not needed at the start of the gate and
the dev instance was never restarted during it. The gate enforces **one bb instance at a time**: every
launch below is preceded by a `bb.exe` count of 0.
