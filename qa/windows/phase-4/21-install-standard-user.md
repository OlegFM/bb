# Installing as a standard user (Phase 4 gate, Step 5)

Screenshot: `21-installer.png` (the installer's finish page, captured with `PrintWindow`).
There is **no `21-smartscreen.png`** — see "SmartScreen did not appear" below; the brief's screenshot is
recorded as a `MANUAL — for the user` item rather than faked.

> ## Result: **PASS** for the install itself; the SmartScreen half is **unmeasurable on this host**.
>
> The unsigned, locally built `bb-0.42.1-x64.exe` installed **without any elevation prompt** into
> `%LOCALAPPDATA%\Programs\bb`, wrote an `HKCU` uninstall entry, and created both a Start-Menu and a
> desktop shortcut. The token it ran under is the UAC-filtered one described in `00-host.md`
> (`BUILTIN\Администраторы … Group used for deny only`, `IsInRole(Administrator) = False`).
>
> The **"Windows protected your PC" dialog did not appear**, even with a Mark-of-the-Web applied, so the
> exact dialog text and its screenshot could not be captured here.

## The account the install ran under

From `00-host.md`: the shell was not elevated, `IsInRole(Administrator)` was `False`, and the
Administrators SID carried `Group used for deny only`. No UAC consent prompt appeared at any point of the
install, which is the claim the per-user NSIS target exists to support.

## SmartScreen did not appear

A locally built file has no Mark-of-the-Web, so the brief's own remedy was applied first — a copy carrying
an explicit `ZoneId=3` alternate data stream:

```powershell
Copy-Item release\bb-0.42.1-x64.exe <scratch>\motw\bb-0.42.1-x64.exe
Set-Content -Path <copy> -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3"
Get-Content -Path <copy> -Stream Zone.Identifier
Get-Item <copy> -Stream * | Select-Object Stream, Length
```

```
[ZoneTransfer]
ZoneId=3

Stream             Length
------             ------
:$DATA          161924387
Zone.Identifier        26
```

That copy was then launched through the shell (`Start-Process`, which uses `ShellExecute` and therefore
does put the file through SmartScreen's app-reputation check):

```powershell
$proc = Start-Process -FilePath <copy> -PassThru; "STARTED pid=$($proc.Id)"
Start-Sleep -Seconds 6
<enumerate every visible top-level window>
```

```
STARTED pid=31980
…
HWND=12718056 PID=31980 TITLE=Установка bb
…
```

The only new window was the installer itself. No "Windows protected your PC" / "Система Windows защитила
ваш компьютер" window existed at any point, and the installer proceeded straight to copying files.

SmartScreen is not switched off on this host — its host process was running throughout:

```powershell
Get-Process smartscreen | Select-Object Id, ProcessName
```

```
   Id ProcessName
   -- -----------
46568 smartscreen
```

and the Mark-of-the-Web survived the run:

```powershell
Get-Content -Path <copy> -Stream Zone.Identifier
```

```
[ZoneTransfer]
ZoneId=3
```

Every SmartScreen configuration value is at its shipped default and none is explicitly set
(`00-host.md`): no `SmartScreenEnabled` under `HKLM\…\Explorer`, no
`HKCU\…\AppHost\EnableWebContentEvaluation`, no `EnableSmartScreen` policy, no
`HKLM\SOFTWARE\Microsoft\Windows Defender Security Center\App and Browser protection` values, and no
`ShellSmartScreenLevel` policy. Defender real-time protection is on, `MAPSReporting=2`,
`DisableBlockAtFirstSeen=False`.

So what this gate measured is: **an unsigned installer with a synthetic Mark-of-the-Web did not trip the
SmartScreen warning on this host.** A synthetic `Zone.Identifier` carries no `HostUrl`/`ReferrerUrl` and no
browser download provenance, and SmartScreen's reputation verdict is a cloud decision that can come back
"allow" — so this single negative observation does **not** prove the dialog never appears for a user who
downloads the installer from a browser. It does mean this gate cannot honestly claim to have reproduced it.

`docs/platform-windows.md` stated the dialog as a certainty and promised this file's screenshot; it is
corrected in the same commit as this evidence to say what was actually measured.

### `MANUAL — for the user`

To capture `21-smartscreen.png` and the dialog's exact wording, on this same reference desktop:

1. Publish or copy `apps/desktop/release/bb-0.42.1-x64.exe` somewhere it can be fetched over HTTPS (a
   GitHub release asset from the `build-desktop.yml` QA run in `42-build-desktop-run.md` is the natural
   source once that workflow can be dispatched).
2. Download it with Edge or Chrome, so the file gets a real `Zone.Identifier` with `HostUrl`/`ReferrerUrl`
   rather than the synthetic one above.
3. Double-click it in Explorer. Expect **"Windows protected your PC"** with a **"More info"** link that
   reveals `App: bb-0.42.1-x64.exe`, `Publisher: Unknown publisher`, and a **"Run anyway"** button.
4. Screenshot the dialog **before** clicking anything, save it as
   `qa/windows/phase-4/21-smartscreen.png`, and paste the dialog's exact text into this file.
5. Click **More info → Run anyway** and let the install proceed.

If the dialog still does not appear, that is itself the answer and should replace this item.

## The install, as it actually ran

The installer is the assisted (non-one-click) NSIS target, so it shows pages. It was driven to completion
without synthetic mouse input: the finish page's controls were addressed directly by handle
(`BM_SETCHECK` / `BM_CLICK`), which is deterministic regardless of window z-order.

```powershell
<enumerate the dialog's child controls>
```

```
TOP HWND=12718056 TITLE=Установка bb
  HWND=23990392 ID=3    CLASS=Button VIS=True TEXT=[< &Назад]
  HWND=13570432 ID=1    CLASS=Button VIS=True TEXT=[&Готово]
  HWND=39128980 ID=2    CLASS=Button VIS=True TEXT=[Отмена]
  HWND=16387304 ID=1028 CLASS=Static VIS=False TEXT=[bb 0.42.1]
  HWND=32313242 ID=1201 CLASS=Static VIS=True  TEXT=[Завершение работы мастера установки bb]
  HWND=15667494 ID=1202 CLASS=Static VIS=True  TEXT=[Установка bb выполнена.
                                                     Нажмите кнопку "Готово" для выхода из программы установки.]
  HWND=311365140 ID=1203 CLASS=Button VIS=True TEXT=[&Запустить bb] checked=1
```

The **"Запустить bb"** ("Run bb") checkbox was unchecked and **"Готово"** ("Finish") pressed, so the
install finished without launching the app — the brief's requirement:

```
BEFORE checked=1
AFTER checked=0
CLICK HWND=13570432 ID=1 TEXT=[&Готово]
installer alive=0
BBCOUNT=0
```

`BBCOUNT=0` five seconds after Finish proves the app did not start.

Recorded honestly: the pages **before** the finish page were not captured. The first capture attempt used
`CopyFromScreen`, which photographs the screen rectangle rather than the window, and returned the content
of an unrelated window that was on top; by the time the capture was switched to `PrintWindow` — which asks
the window to draw itself and works whatever the z-order — the installer had already advanced to the
file-copy page and then to the finish page. So the directory page's default path was verified from the
**result** (`%LOCALAPPDATA%\Programs\bb`, below) rather than from a screenshot of the page. The
`MANUAL` item above is the opportunity to capture the earlier pages too.

## What the install produced

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\bb\bb.exe"
Get-ChildItem "$env:LOCALAPPDATA\Programs\bb" | Select-Object Name, Length
"{0:N0} bytes in {1} files" -f ((Get-ChildItem … -Recurse -File | Measure-Object Length -Sum).Sum), (…).Count
```

```
True

Name                    Length
----                    ------
locales
resources
bb.exe                  223081984
chrome_100_percent.pak  116089
chrome_200_percent.pak  187558
d3dcompiler_47.dll      4741480
dxcompiler.dll          25666560
dxil.dll                1503600
ffmpeg.dll              3096576
icudtl.dat              10822192
libEGL.dll              522752
libGLESv2.dll           7963648
LICENSE.electron.txt    1096
LICENSES.chromium.html  19474757
resources.pak           6794158
snapshot_blob.bin       341312
Uninstall bb.exe        202988
v8_context_snapshot.bin 715208
vk_swiftshader_icd.json 106
vk_swiftshader.dll      5624320
vulkan-1.dll            954880

645 959 288 bytes in 8610 files
```

The default directory was accepted, so the install landed exactly where
`docs/platform-windows.md` says it does, and `Uninstall bb.exe` is the per-user uninstaller Step 10 runs.

### The registry entry (HKCU, not HKLM)

```powershell
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" |
  Where-Object DisplayName -like "bb*" |
  Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString, Publisher, EstimatedSize, PSChildName
```

```
DisplayName     : bb 0.42.1
DisplayVersion  : 0.42.1
InstallLocation :
UninstallString : "C:\Users\olege\AppData\Local\Programs\bb\Uninstall bb.exe" /currentuser
Publisher       :
EstimatedSize   : 630621
PSChildName     : 2d84d6a4-3903-54d3-a782-c944fbc4ea95
```

Under `HKCU`, with `/currentuser` on the uninstall string — the per-user install this target is configured
for. Two fields are **empty**, and both follow from the build being unsigned and from the electron-builder
config: `Publisher` is blank because `publisherName` is deliberately unset without a certificate, and
`InstallLocation` is blank because the NSIS template does not write it for a per-user install. Neither is a
defect, but a tool that reads `InstallLocation` to find the app will not find it here.

### Shortcuts

```powershell
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Filter "bb*" -Recurse
[Environment]::GetFolderPath("Desktop")
Get-ChildItem ([Environment]::GetFolderPath("Desktop")) -Filter "*.lnk"
$shell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\bb.lnk")
```

```
C:\Users\olege\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\bb.lnk   2243 bytes

C:\Users\olege\OneDrive\Рабочий стол
… bb.lnk   16.09.2026 14:54:27 …

TargetPath:       C:\Users\olege\AppData\Local\Programs\bb\bb.exe
WorkingDirectory: C:\Users\olege\AppData\Local\Programs\bb
Description:      macOS, Linux and Windows Electron shell for bb
```

Both shortcuts exist. Worth recording because it nearly read as a failure: this host's Desktop is
**redirected into OneDrive**, so `"$env:USERPROFILE\Desktop"` is empty and only
`[Environment]::GetFolderPath("Desktop")` finds `bb.lnk`. NSIS resolves the shell folder correctly;
a check that hard-codes `%USERPROFILE%\Desktop` would wrongly report a missing shortcut.

### `%APPDATA%` and `%USERPROFILE%\.bb` immediately after the install

```
APPDATA\bb exists=False
USERPROFILE\.bb exists=True
```

The installer creates **no** `userData` directory — `%APPDATA%\bb` appears on first run, not at install
time — and it does not touch `%USERPROFILE%\.bb`. (The pre-existing `%APPDATA%\bb` from today's earlier
unpacked smokes had been renamed aside before this step; see `00-host.md` and `26-uninstall.md`.)
