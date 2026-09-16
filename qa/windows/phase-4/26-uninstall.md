# Uninstall (Phase 4 gate, Step 10)

Raw transcript: `26-uninstall.txt`.

> ## Result: **PASS**
>
> `Uninstall bb.exe /S` removed the program directory, the `HKCU` registry entry and both shortcuts in
> **9.6 s**, with no elevation. `%APPDATA%\bb` survived, as designed, and `%USERPROFILE%\.bb` was untouched.
> One leftover the docs did not mention was found: `%LOCALAPPDATA%\@bbdesktop-updater\installer.exe`,
> 154 MiB, also survives uninstall.

## A precondition this gate had to create: `%APPDATA%\bb` was not empty when the gate began

`00-host.md` records that `%APPDATA%\bb` already existed before the gate — not from an installed copy
(there was none) but as the Electron `userData` written by today's earlier `win-unpacked` smokes and live
checks, run straight from `release/win-unpacked\bb.exe`.

An uninstall step whose whole point is "what does the uninstaller leave behind" cannot honestly run on top
of that, so before Step 5 the directory was **renamed aside, not deleted**:

```powershell
Rename-Item "$env:APPDATA\bb" -NewName "bb.pre-gate-20260916-145139"
```

```
BEFORE: exists=True
AFTER: appdata-bb exists=False
Name                        LastWriteTime
bb.pre-gate-20260916-145139 16.09.2026 12:07:57
```

So everything this file reports about `%APPDATA%\bb` describes **only** what this gate's own install and
runs produced. The pre-gate copy was put back at the end (bottom of this file). `%USERPROFILE%\.bb` was
never renamed, moved or deleted at any point: it is the user's real runtime data and the packaged app used
it live during Steps 6–9.

## Before the uninstall

```
Programs\bb exists=True
APPDATA\bb exists=True          # created by the gate's own first run of the installed app
USERPROFILE\.bb exists=True
BBCOUNT=0                       # nothing running; the app had been quit in Step 9
```

## The uninstall

```powershell
Start-Process -Wait -FilePath "$env:LOCALAPPDATA\Programs\bb\Uninstall bb.exe" -ArgumentList "/S"
```

```
UNINSTALL_SECONDS=9,6
```

No elevation prompt, in the same unelevated, UAC-filtered token as everything else in this gate.
9.6 s to remove 8 610 files.

## What is gone

```
Programs\bb exists=False
Get-ChildItem "$env:LOCALAPPDATA\Programs\bb"          -> (nothing; the directory itself is gone)
registry rows matching bb*                              -> 0
start menu shortcut exists=False
desktop shortcut exists=False
```

The desktop-shortcut check resolves the Desktop through `[Environment]::GetFolderPath("Desktop")` rather
than `%USERPROFILE%\Desktop`, because this host's Desktop is redirected into OneDrive
(`21-install-standard-user.md`); the uninstaller removed the shortcut from the redirected location
correctly.

## What survives

```
APPDATA\bb exists=True
USERPROFILE\.bb exists=True
updater cache exists=True
```

### `%APPDATA%\bb` — by design

```
Name              Length
blob_storage
Cache
Code Cache
DawnGraphiteCache
DawnWebGPUCache
GPUCache
Local Storage
Network
Session Storage
Shared Dictionary
WebStorage
.updaterId        36
DIPS              36864
Local State       490
Preferences       54
SharedStorage     4096
window-state.json 20

total: 14 757 122 bytes
```

`deleteAppDataOnUninstall: false` in `apps/desktop/electron-builder.config.json`, so a reinstall keeps the
window state and the cached Connect credential — the documented intent. Note `window-state.json` is 20
bytes here against 223 in the pre-gate copy: Step 9 closed the last window, which persists an **empty**
window set so the next launch opens the default window rather than restoring none. That is the documented
close-to-tray behaviour, visible in the file size.

`owned-runtime.json` is **not** in the list: the app removes it on a clean quit, so a surviving one would
have meant a runtime that was never stopped.

### `%USERPROFILE%\.bb` — untouched

Still present, with the host id, database, logs, plugins and thread storage the packaged app used during
Steps 6–9. The installer and uninstaller never write to it; it is bb's own data directory, not Electron's.

### `%LOCALAPPDATA%\@bbdesktop-updater\installer.exe` — an undocumented leftover

```
Name             Length
installer.exe 161914035
```

**154 MiB survives the uninstall.** This is not a downloaded update: electron-builder's NSIS target copies
the running installer into `updaterCacheDirName` at install time so that a later differential update has
its base file, and the uninstaller does not clear that directory. It was 161 924 387 bytes after the N
install and 161 914 035 after the N+1 install, i.e. always a copy of whichever installer last ran.

`docs/platform-windows.md` says what uninstall leaves behind and names only `%APPDATA%\bb`. That is
incomplete by 154 MiB, and it is worth a user knowing about, so the docs are corrected in the same commit
as this evidence. The directory is a cache with no user data in it and is safe to delete.

## Cleaning up after the gate

The gate's own `%APPDATA%\bb` and the updater cache were removed, and the pre-gate `userData` restored to
its original name:

```powershell
Remove-Item "$env:APPDATA\bb" -Recurse -Force                          # APPDATA\bb exists=False
Remove-Item "$env:LOCALAPPDATA\@bbdesktop-updater" -Recurse -Force     # updater cache exists=False
Rename-Item "$env:APPDATA\bb.pre-gate-20260916-145139" -NewName "bb"   # APPDATA\bb exists=True
```

```
Name LastWriteTime
bb   16.09.2026 12:07:57

Name              Length
blob_storage
Cache
Code Cache
DawnGraphiteCache
DawnWebGPUCache
GPUCache
Local Storage
Network
Session Storage
Shared Dictionary
.updaterId        36
DIPS              36864
Local State       490
Preferences       270
SharedStorage     4096
window-state.json 223
```

The restored directory is byte-for-byte the one the gate set aside — same `LastWriteTime` (12:07:57), same
`Preferences` (270 bytes) and `window-state.json` (223 bytes) it had before the gate, and without the
`WebStorage` subdirectory the gate's own runs added. The host is left exactly as the gate found it, with no
bb installed and no `bb.exe` running.
