# N → N+1 update (Phase 4 gate, Step 7)

Raw transcript: `23-update-n-to-n1.txt`.

> ## Result: **PARTIAL — a product finding, not a pass.**
>
> | sub-claim                                                                               | result                                                                                                                                                                                                                                                                                              |
> | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | build N+1 (`0.42.2`) in a scratch worktree, lockstep bump, never committed              | **PASS**                                                                                                                                                                                                                                                                                            |
> | the JSON feed half (`BB_DESKTOP_VERSION_FEED_URL`) reaches a local feed                 | **PASS** — the server logged four polls                                                                                                                                                                                                                                                             |
> | the electron-updater half reaches a local feed after editing `resources/app-update.yml` | **FAIL — the documented remedy does not work.** The app calls `autoUpdater.setFeedURL()` with a **hard-coded** GitHub release URL at startup, which overrides `app-update.yml`; every check went to `https://github.com/get-bb/bb/releases/download/desktop-latest/latest.yml` and returned **404** |
> | "update available" → downloaded → Install                                               | **not reachable** on this host, because of the row above                                                                                                                                                                                                                                            |
> | the runtime tree is gone before the installer runs                                      | **PASS** — 19 `bb.exe` → 0 in 4.57 s, then the installer ran with zero `bb.exe` alive                                                                                                                                                                                                               |
> | the relaunched app reports N+1                                                          | **PASS** — `0.42.2` in `bb.exe`, in the packaged `bb-app`, and in the registry                                                                                                                                                                                                                      |
> | the `Uninstall` registry entry shows N+1                                                | **PASS** — `bb 0.42.2`                                                                                                                                                                                                                                                                              |
>
> The upgrade itself was therefore performed by **running the N+1 installer directly** — the same NSIS
> installer `quitAndInstall` would have launched, after the same quit sequence — and that half is fully
> measured. What is **not** measured is electron-updater's own download and hand-over. `docs/platform-windows.md`
> is corrected in the same commit as this evidence.

## Building N+1

A scratch worktree at the same commit, a lockstep patch bump, never committed:

```bash
git worktree add C:\Users\olege\Work\bb-phase4-n1 11dfe15db
# node one-liner bumps the patch of apps/desktop/package.json and packages/bb-app/package.json
git -C C:\Users\olege\Work\bb-phase4-n1 status --short
```

```
HEAD is now at 11dfe15db Correct the Windows docs on the stop bound, the tray and the reserves
apps/desktop/package.json -> 0.42.2
packages/bb-app/package.json -> 0.42.2
 M apps/desktop/package.json
 M packages/bb-app/package.json
```

`pnpm install --offline --config.confirmModulesPurge=false` completed in **1 m 15.8 s**, `INSTALL_EXIT=0`,
with seven `Failed to create bin … .js.EXE` warnings for `@bb/scripts` bins — the known Windows shim
warning, harmless for a desktop build and present in every worktree install this port has done.

```bash
pnpm --filter @bb/desktop run dist:windows      # N1_DIST_EXIT=0
pnpm run desktop:version-feed                   # N1_FEED_EXIT=0
```

```
bb-0.42.2-x64.exe            161914035
bb-0.42.2-x64.exe.blockmap      168090
desktop-version-windows.json       595
latest.yml                         332
```

`desktop:version-feed` succeeding is itself the lockstep check: the generator throws unless `latest.yml`'s
version and `apps/desktop/package.json`'s agree. N+1 is 10 352 bytes smaller than N, which is ordinary
compression variance between two builds of nearly identical inputs.

The worktree was removed at the end of the gate and nothing in it was ever committed.

## The local feed

`<scratch>/feed-n1/` holds the four N+1 files and is served by a 60-line static Node server with
`Content-Length`, `Accept-Ranges` and `206` support, so a differential download would have worked had one
been attempted:

```
feed server on http://127.0.0.1:47000/ serving …\feed-n1
```

```powershell
(Invoke-WebRequest -Uri "http://127.0.0.1:47000/latest.yml" -UseBasicParsing).Content        # version: 0.42.2 …
(Invoke-WebRequest -Uri "http://127.0.0.1:47000/desktop-version-windows.json" -UseBasicParsing).StatusCode   # 200
```

## `resources/app-update.yml` is overridden by the app

The installed copy's file was edited exactly as `docs/platform-windows.md` prescribes, and the original
recorded first:

```
# before
channel: latest
provider: generic
url: https://github.com/get-bb/bb/releases/download/desktop-latest/
updaterCacheDirName: '@bbdesktop-updater'

# after
channel: latest
provider: generic
url: http://127.0.0.1:47000/
updaterCacheDirName: '@bbdesktop-updater'
```

The app was then launched three separate times with
`BB_DESKTOP_VERSION_FEED_URL=http://127.0.0.1:47000/desktop-version-windows.json`. Across all three, the
feed server received:

```
2026-09-16T12:03:50.677Z GET /latest.yml                     -> 200 (332 bytes)
2026-09-16T12:03:50.745Z GET /desktop-version-windows.json   -> 200 (595 bytes)
2026-09-16T12:04:02.433Z GET /desktop-version-windows.json   -> 200 (595 bytes)
2026-09-16T12:07:30.922Z GET /desktop-version-windows.json   -> 200 (595 bytes)
2026-09-16T12:11:11.034Z GET /desktop-version-windows.json   -> 200 (595 bytes)
```

Four JSON-feed polls — the `BB_DESKTOP_VERSION_FEED_URL` half works — and **one** `latest.yml` request, on
the app's very first launch after the edit, never repeated. No request for `bb-0.42.2-x64.exe` or its
blockmap was ever made.

Meanwhile every electron-updater check failed, and the failure names the URL it really used:

```
Checking for update
Error: Error: Cannot find channel "latest.yml" update info: HttpError: 404
"method: GET url: https://github.com/get-bb/bb/releases/download/desktop-latest/latest.yml?noCache=1k2l21ips …"
Headers: { … "server": "github.com", "x-github-request-id": "FF4B:32F50:C304382:B26FBBD:6AAA875F" … }
Desktop auto-update error; preserving current update state. Cannot check for updates: …
Desktop auto-update check failed; update installation remains disabled until a later check succeeds: …
```

`server: github.com` in the response headers settles it: the request went to GitHub, not to
`127.0.0.1:47000`. The cause is in the product code, not in the test setup —
`apps/desktop/src/desktop-auto-update.ts` does this unconditionally when auto-update is enabled:

```ts
args.updater.setLogger(logger);
args.updater.setFeedURL(DESKTOP_AUTO_UPDATE_FEED_CONFIG);
args.updater.setAutoDownload(false);
```

and `DESKTOP_AUTO_UPDATE_FEED_CONFIG` (`apps/desktop/src/desktop-update-provider.ts`) is built from
`updateReleaseBaseUrl: \`https://github.com/get-bb/bb/releases/download/${releaseTag}/\``. `setFeedURL`
takes precedence over `resources/app-update.yml`, so editing that file cannot redirect a **packaged**
build. The only other knob, `forceDevUpdateConfig`, is gated on `!app.isPackaged && BB_DESKTOP_AUTO_UPDATE === "1"`
(`apps/desktop/src/main.ts`), so it is unavailable in a packaged install by construction.

Two notes on scope, so this is not over-read:

- **This is not a Phase 4 regression.** `setFeedURL(DESKTOP_AUTO_UPDATE_FEED_CONFIG)` predates this phase
  and is unchanged by it; Phase 4's diff to `desktop-update-provider.ts` is the `appUserModelId` field and
  flipping `resolveDesktopUpdateSupport` for `windows` from `{autoUpdate: false, versionCheck: false}` to
  `{autoUpdate: true, versionCheck: true}`. What Phase 4 changed is that Windows now _reaches_ this code,
  and the phase's docs then prescribed a QA procedure that does not work.
- **It does not affect real users.** A shipped build wants exactly this URL. What it breaks is QA: there is
  no supported way to point an installed Windows build at a test feed, so the update path can only be
  exercised against a real `desktop-latest` / `desktop-nightly` release.
- The single `/latest.yml` 200 at 12:03:50.677 is the app's very first launch on a fresh `userData`, and
  no later launch repeated it. It is recorded as observed; the mechanism (a first-launch check resolving
  from `app-update.yml` before `setFeedURL` was applied) was not confirmed, and it did not lead to a
  download either way.

### `MANUAL — for the user`

Exercising electron-updater's download and `quitAndInstall` on Windows needs one of:

1. **A real QA release.** Run `build-desktop.yml` with `release_channel=qa` on `get-bb/bb` (see
   `42-build-desktop-run.md`), publish the resulting `latest.yml` + `.exe` to the `desktop-latest` release,
   install an older build, and watch Settings → Updates.
2. **A hosts-file redirect**, which needs an elevated shell this gate deliberately did not take: point
   `github.com` at a local listener serving the N+1 feed over HTTPS with a trusted certificate.
3. **A product change** that would make this testable — an env override for the electron-updater feed URL
   next to `BB_DESKTOP_VERSION_FEED_URL`, e.g. `BB_DESKTOP_UPDATE_FEED_URL`, honoured only when set.
   Option 3 is the one worth considering on its own merits; it is out of scope for this gate.

## The upgrade that was performed

With the electron-updater path unavailable, the upgrade ran the way `quitAndInstall` would have: the quit
sequence first, then the NSIS installer.

**Quit first** — through `BB_DESKTOP_QUIT_REQUEST_FILE`, which `docs/platform-windows.md` states is
"exactly the tray Quit path":

```
COUNT_BEFORE=19            # 19 bb.exe rows, the desktop + renderers + the runtime tree
QUIT_SECONDS=4,57
tasklist /FI "IMAGENAME eq bb.exe" /FO CSV
INFO: No tasks are running which match the specified criteria.
COUNT_AFTER=0
listeners on 38886/38887: 0
```

4.57 s from writing the flag to the last process exiting, which includes up to 500 ms of poll latency
before the quit even starts. That sits inside the documented bound
(`OWNED_RUNTIME_STOP_TIMEOUT_MS` 6 s + `OWNED_RUNTIME_KILL_TIMEOUT_MS` 1 s = 7 s).

**Then the installer**, with a `tasklist` taken immediately before it and immediately after:

```powershell
Start-Process -Wait -FilePath <scratch>\feed-n1\bb-0.42.2-x64.exe -ArgumentList "/S"
```

```
INSTALL_SECONDS=112,0
tasklist /FI "IMAGENAME eq bb.exe" /FO CSV
INFO: No tasks are running which match the specified criteria.
```

**Zero `bb.exe` rows for the whole install window** — the claim the brief asks for. 112 s is the NSIS
silent install writing 8 610 files.

## N+1 in place

```powershell
(Get-Item "$env:LOCALAPPDATA\Programs\bb\bb.exe").VersionInfo.FileVersion
(Get-Content "…\resources\app.asar.unpacked\node_modules\bb-app\package.json" -Raw | ConvertFrom-Json).version
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" | Where-Object DisplayName -like "bb*"
```

```
0.42.2
0.42.2
DisplayName     : bb 0.42.2
DisplayVersion  : 0.42.2
UninstallString : "C:\Users\olege\AppData\Local\Programs\bb\Uninstall bb.exe" /currentuser
```

All three agree on `0.42.2`, and the in-place upgrade reused the same install directory, the same registry
key (`2d84d6a4-3903-54d3-a782-c944fbc4ea95`) and the same shortcuts rather than creating a second entry.

The relaunched app answered health as N+1:

```
DESKTOP_PID=49552
HEALTH_OK=True
{"ok":true,"launchId":"0269915c-358a-434f-ae31-8e2f17939e45"}
```

Two side observations:

- The N+1 installer **replaced** `resources/app-update.yml` with the shipped GitHub URL, so the QA edit
  does not survive an upgrade even where it would have worked.
- `%LOCALAPPDATA%\@bbdesktop-updater\installer.exe` holds a copy of the installer that last ran
  (161 924 387 bytes after N, 161 914 035 after N+1). That is the NSIS target seeding the updater cache
  so a later differential update has its base file; it is **not** a downloaded update. It survives
  uninstall and is removed explicitly in `26-uninstall.md`.

Per the brief, nothing was restored: the installed copy is now N+1, and it is what Steps 8, 9 and 10 run
against.
