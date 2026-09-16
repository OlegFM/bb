# Installer build, build N (Phase 4 gate, Step 4)

Raw transcript: `20-build-installer.txt` (the whole command output plus the `DIST_WINDOWS_EXIT=` line, both
captured in the same shell).

> ## Result: **PASS**
>
> `pnpm --filter @bb/desktop run dist:windows` → **`DIST_WINDOWS_EXIT=0`** in about 5 minutes, producing
> `bb-0.42.1-x64.exe` (154 MiB), its `.blockmap`, `latest.yml` and `win-unpacked/`.
> `Get-AuthenticodeSignature` reports **`NotSigned`** and `desktop:version-feed` writes a
> `desktop-version-windows.json` whose `sha512`, `size` and `path` match `latest.yml` exactly.
>
> One docs correction came out of this step: the build **does not** download `winCodeSign`. See
> "A claim this step disproves" below.

## The command

```powershell
pnpm --filter @bb/desktop run dist:windows 2>&1 | Tee-Object -FilePath qa\windows\phase-4\20-build-installer.txt
"DIST_WINDOWS_EXIT=$LASTEXITCODE"
```

```
DIST_WINDOWS_EXIT=0
```

Started 14:43 local, finished 14:48 local — about **5 minutes** with a warm Electron download cache and a
cold NSIS cache. `dist:windows` is `prepare-runtime && build && run-electron-builder.mjs --win --x64
--publish never`; `prepare-runtime` was a complete Turbo cache hit because Step 2 had just built everything:

```
 Tasks:    47 successful, 47 total
Cached:    47 cached, 47 total
  Time:    739ms >>> FULL TURBO
```

## The electron-builder run, verbatim

```
> @bb/desktop@0.42.1 desktop:build:windows C:\Users\olege\Work\bb\apps\desktop
> pnpm run build && node scripts/run-electron-builder.mjs --win --x64 --publish never

> @bb/desktop@0.42.1 build C:\Users\olege\Work\bb\apps\desktop
> node scripts/build.mjs

@bb/desktop: built Electron entries
Windows signing skipped: no Azure Trusted Signing secrets found. The installer will be unsigned and SmartScreen will warn on first launch.
  • electron-builder  version=26.15.7 os=10.0.26200
  • loaded configuration  file=C:\Users\olege\Work\bb\apps\desktop\.electron-builder.generated.json
  • author is missed in the package.json  appPackageFile=C:\Users\olege\Work\bb\apps\desktop\package.json
  • packageManager not detected by file, falling back to environment detection  resolvedPackageManager=pnpm detected=C:\Users\olege\Work\bb\apps\desktop
  • skipped dependencies rebuild  reason=npmRebuild is set to false
  • packaging       platform=win32 arch=x64 electron=41.7.0 appOutDir=release\win-unpacked
  • downloaded      label=electron progress=100%
  • downloaded electron zip extracted successfully  output=C:\Users\olege\Work\bb\apps\desktop\release\win-unpacked
  • searching for node modules  pm=pnpm searchDir=C:\Users\olege\Work\bb\apps\desktop
  • platform-specific optional dependencies not bundled … dependencies=["@parcel/watcher-android-arm64@2.5.6", …]
  • updating asar integrity executable resource  executablePath=release\win-unpacked\bb.exe
  • signing with signtool.exe  path=release\win-unpacked\bb.exe
  • signing with signtool.exe  path=release\win-unpacked\resources\app.asar.unpacked\node_modules\node-pty\third_party\conpty\1.25.260303002\win10-x64\OpenConsole.exe
  • signing with signtool.exe  path=release\win-unpacked\resources\app.asar.unpacked\node_modules\node-pty\third_party\conpty\1.25.260303002\win10-arm64\OpenConsole.exe
  • signing with signtool.exe  path=release\win-unpacked\resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\conpty\OpenConsole.exe
  • signing with signtool.exe  path=release\win-unpacked\resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-arm64\conpty\OpenConsole.exe
  • signing with signtool.exe  path=release\win-unpacked\resources\app.asar.unpacked\node_modules\node-pty\build\Release\conpty\OpenConsole.exe
  • building        target=nsis file=release\bb-0.42.1-x64.exe archs=x64 oneClick=false perMachine=false
  • downloaded      label=nsis-3.0.4.1.7z progress=100%
  • downloaded      label=7zip-win-x64.tar.gz progress=100%
  • directory rename failed, retrying  src=C:\Users\olege\AppData\Local\electron-builder\Cache\nsis-3.0.4.1\nsis-3.0.4.1-1mx3n.tmp dest=…\nsis-3.0.4.1-1mx3n code=EPERM
  • signing with signtool.exe  path=release\win-unpacked\resources\elevate.exe
  • downloaded      label=nsis-resources-3.4.1.7z progress=100%
  • signing with signtool.exe  path=release\bb-0.42.1-x64.__uninstaller.exe
  • signing with signtool.exe  path=release\bb-0.42.1-x64.exe
  • building block map  blockMapFile=release\bb-0.42.1-x64.exe.blockmap
DIST_WINDOWS_EXIT=0
```

Three lines are expected noise rather than findings, and two of the three are already documented:

- **`Windows signing skipped: …`** — `run-electron-builder.mjs`'s own warning for the no-secrets case. It
  is the reason `publisherName` is absent from the generated config and the reason the `.exe` below is
  `NotSigned`.
- **`signing with signtool.exe`, eight times** — electron-builder announces the step even with nothing to
  sign with. `Get-AuthenticodeSignature` proves it was a no-op, as `docs/platform-windows.md` says.
- **`directory rename failed, retrying … code=EPERM`** — a transient rename race while extracting the NSIS
  toolchain into the shared cache (Defender or the indexer holding the temp directory for a moment).
  electron-builder retried and the build continued without a second complaint. Recorded so a later gate
  does not treat it as new.

`author is missed in the package.json` and the `@parcel/watcher-*` optional-dependency notice are
pre-existing and appear on macOS and Linux builds too.

## What `release/` holds

```powershell
Get-ChildItem release -File | Select-Object Name, Length, LastWriteTime
```

```
Name                          Length LastWriteTime
----                          ------ -------------
bb-0.42.1-x64.exe          161924387 16.09.2026 14:48:02
bb-0.42.1-x64.exe.blockmap    168458 16.09.2026 14:48:16
builder-debug.yml               7722 16.09.2026 14:48:17
latest.yml                       332 16.09.2026 14:48:17
```

plus the `win-unpacked/` directory and, after `desktop:version-feed` below,
`desktop-version-windows.json`. The installer is **161 924 387 bytes ≈ 154 MiB**; the unpacked `bb.exe` is
223 081 984 bytes, which is the Electron binary with the asar appended.

This exact set — `*.exe`, `*.blockmap`, `latest.yml`, `desktop-version-windows.json` — is what
`build-desktop.yml`'s `windows` job globs into its `bb-desktop-windows-x64` artifact
(`42-build-desktop-run.md`).

## `latest.yml`

```yaml
version: 0.42.1
files:
  - url: bb-0.42.1-x64.exe
    sha512: FnvQvTTysLRf4C8Knm9MdRt35kLZiDjWVGMlTz1uR/kCiK29AS6YkKckP64idxNGjgY5P4ZYbXFu+ttgKI+IQw==
    size: 161924387
path: bb-0.42.1-x64.exe
sha512: FnvQvTTysLRf4C8Knm9MdRt35kLZiDjWVGMlTz1uR/kCiK29AS6YkKckP64idxNGjgY5P4ZYbXFu+ttgKI+IQw==
releaseDate: "2026-09-16T11:48:17.017Z"
```

`latest.yml`, not `nightly.yml`, because no `BB_DESKTOP_RELEASE_CHANNEL` was set and the stable channel's
`updateMetadataFileNames.windows` is `latest.yml`.

## Signature: `NotSigned`

```powershell
$sig = Get-AuthenticodeSignature release\bb-0.42.1-x64.exe
"Status: $($sig.Status)"; "SignerCertificate: $(if ($null -eq $sig.SignerCertificate) { '(none)' } else { $sig.SignerCertificate.Subject })"
```

```
Status: NotSigned
SignerCertificate: (none)
```

(`StatusMessage` is the localised "file is not digitally signed" text; the host is a Russian-locale
Windows.) This is the expected state — no Windows code-signing certificate exists yet — and it is what
makes the SmartScreen behaviour in `21-install-standard-user.md` the real user experience rather than a
hypothetical.

## The JSON version feed

```powershell
pnpm --dir apps/desktop run desktop:version-feed
"FEED_EXIT=$LASTEXITCODE"
```

```
> @bb/desktop@0.42.1 desktop:version-feed C:\Users\olege\Work\bb\apps\desktop
> tsx scripts/generate-version-feed.mts

Wrote C:\Users\olege\Work\bb\apps\desktop\release\desktop-version-windows.json
FEED_EXIT=0
```

```json
{
  "schemaVersion": 1,
  "channel": "latest",
  "platform": "windows",
  "version": "0.42.1",
  "releaseDate": "2026-09-16T11:48:17.017Z",
  "releaseName": "bb desktop 0.42.1",
  "releaseNotes": null,
  "minimumSystemVersion": null,
  "files": [
    {
      "url": "bb-0.42.1-x64.exe",
      "sha512": "FnvQvTTysLRf4C8Knm9MdRt35kLZiDjWVGMlTz1uR/kCiK29AS6YkKckP64idxNGjgY5P4ZYbXFu+ttgKI+IQw==",
      "size": 161924387
    }
  ],
  "path": "bb-0.42.1-x64.exe",
  "sha512": "FnvQvTTysLRf4C8Knm9MdRt35kLZiDjWVGMlTz1uR/kCiK29AS6YkKckP64idxNGjgY5P4ZYbXFu+ttgKI+IQw==",
  "stagingPercentage": null
}
```

`platform: "windows"` comes from `resolveDesktopBuildPlatform("win32")`, the mapping this phase added;
`sha512`, `size` and `path` are read out of `latest.yml` and the generator throws if its `version` and
`apps/desktop/package.json`'s disagree, which is the lockstep guard the N+1 build in
`23-update-n-to-n1.md` relies on.

## node-pty's ConPTY prebuild in the packaged tree

```powershell
Get-ChildItem release\win-unpacked\resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64 -Recurse -File
```

```
…\prebuilds\win32-x64\conpty_console_list.node      134656
…\prebuilds\win32-x64\conpty.node                   291328
…\prebuilds\win32-x64\conpty\conpty.dll             110152
…\prebuilds\win32-x64\conpty\OpenConsole.exe       1062472
```

Exactly the four files `prepare-native-modules.cjs` asserts on win32, no `winpty.dll` and no
`winpty-agent.exe`, as `docs/platform-windows.md` records.

## `app-update.yml` as shipped

```
channel: latest
provider: generic
url: https://github.com/get-bb/bb/releases/download/desktop-latest/
updaterCacheDirName: '@bbdesktop-updater'
```

This is the file `23-update-n-to-n1.md` edits inside the **installed** copy to point electron-updater at the
local QA feed, and restores nothing afterwards because the installed copy becomes N+1.

## Build N kept for the update test

```powershell
Copy-Item release\bb-0.42.1-x64.exe, release\bb-0.42.1-x64.exe.blockmap, release\latest.yml, release\desktop-version-windows.json <scratch>\feed-n\
```

```
Name                            Length
----                            ------
bb-0.42.1-x64.exe            161924387
bb-0.42.1-x64.exe.blockmap      168458
desktop-version-windows.json       595
latest.yml                         332
```

## A claim this step disproves

`docs/platform-windows.md` said, under **Build**:

> The first build downloads `winCodeSign` — and `nsis` for a full `dist:windows` — into
> `%LOCALAPPDATA%\electron-builder\Cache`, which is why even an unsigned `--dir` package pays for that
> cache miss once.

Measured on this host, the `winCodeSign` half is wrong. Before this gate the cache held only the two
entries today's `package:windows` (`--dir`) runs created:

```
Name        LastWriteTime
downloads   16.09.2026 8:21:29
icons@1.2.1 16.09.2026 8:21:29
```

and after this full `dist:windows`:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache" | Select-Object Name, LastWriteTime
Test-Path "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
Select-String -Path qa\windows\phase-4\20-build-installer.txt -Pattern "winCodeSign"
```

```
Name                 LastWriteTime
----                 -------------
7zip@1.0.0           16.09.2026 14:46:45
downloads            16.09.2026 14:47:58
icons@1.2.1          16.09.2026 8:21:29
nsis-3.0.4.1         16.09.2026 14:46:46
nsis-resources-3.4.1 16.09.2026 14:47:58

False
(no matches)
```

No `winCodeSign` directory, and the string never appears in the build transcript. electron-builder 26.15.7
signs on a Windows host through the system `signtool.exe`, so the `winCodeSign` bundle — which exists for
cross-building Windows targets from macOS and Linux — is never fetched here. What a full `dist:windows`
_does_ pay for on a cold cache is `nsis-3.0.4.1`, `7zip@1.0.0` and `nsis-resources-3.4.1`, and an unsigned
`--dir` package pays for **neither** set: `package:windows` downloaded only the Electron zip and the icon
tool.

`docs/platform-windows.md` is corrected accordingly in the same commit as this evidence.
