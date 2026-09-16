# @bb/desktop

macOS, Linux and Windows Electron shell for bb. The desktop app loads the
existing bb web UI and uses the packaged `bb-app` launcher for server and
host-daemon lifecycle.

## Development

From the repo root, the full source dev loop is:

```bash
pnpm dev:desktop
```

That starts the source dev server and the Electron shell through the Node
launcher `packages/scripts/src/commands/run-dev-app.ts` (`pnpm dev:status`,
`pnpm dev:stop` and `pnpm dev:app <command>` drive the same sessions; logs
live under `~/.bb-dev/<checkout-instance>/dev-app/`). It works from
PowerShell as well as POSIX shells and needs Node 22.19 or newer on the 22
line. To run only the desktop package task directly:

```bash
pnpm exec turbo run dev --filter=@bb/desktop
```

The dev script builds `bb-app`, compiles the Electron main/preload files, and
opens Electron directly. By default it uses the same checkout-scoped
`~/.bb-dev/<checkout-instance>` data directory and deterministic high ports as
the main repo dev launcher; it prints the resolved data dir, server URL, and
Electron user-data dir at startup. It intentionally overwrites inherited
`BB_DATA_DIR`, `BB_SERVER_PORT`, `BB_SERVER_URL`, and `BB_HOST_DAEMON_PORT` so a
desktop dev run launched from an existing bb session still targets the current
checkout. Set `BB_DESKTOP_USER_DATA_DIR` to override only Electron's user-data
directory.

The launcher probes the checkout's Vite app port at startup and adapts:

- **`pnpm dev` is already running** (Vite reachable): the shell loads the Vite
  dev URL, so you get live source and HMR for `@bb/app` changes — no rebuild
  needed. It still attaches to the same running server/daemon for all API/WS
  traffic. The launcher prints `app <url> (Vite dev server — live reload)`. This
  is the fast loop for iterating on the desktop UI.
- **`pnpm dev` is not running**: the shell starts its own `bb-app` runtime and
  loads the built UI it serves, so you must rebuild (re-run this task) to pick up
  source changes. The launcher prints `app (own bb-app runtime — …)`.

The override is plumbed via `BB_DESKTOP_APP_URL`, which the launcher only sets
when Vite is confirmed reachable; it is never set in packaged builds, so
production always loads the server's own built UI.

To run the slower unpacked Electron Builder app, which more closely matches the
packaged runtime and keeps native dependencies rebuilt for Electron's bundled
Node runtime:

```bash
pnpm exec turbo run start --filter=@bb/desktop
```

Electron is pinned to `41.7.0`, the highest stable line verified to rebuild the
packaged native modules with the current dependency set. Electron 42.2.0 was
tested, but `better-sqlite3@12.10.0` does not compile against Electron ABI 146.
Revisit the pin when `better-sqlite3` ships support or prebuilds for that ABI.

## Validation

```bash
pnpm exec turbo run typecheck --filter=@bb/desktop --filter=bb-app
pnpm exec turbo run build --filter=@bb/desktop
pnpm exec turbo run test --filter=@bb/desktop --filter=bb-app --force
pnpm exec turbo run dev --filter=@bb/desktop
```

### Windows

Two smokes run against a packaged Windows build and must both pass before a
Windows change is called done. Package first — either `package:windows` for an
unpacked tree or `dist:windows` for the installer, which leaves the same
`release/win-unpacked/` behind — then:

```powershell
pnpm exec turbo run smoke:packaged --filter=@bb/desktop --force
pnpm exec turbo run smoke:windows-processes --filter=@bb/desktop
```

`smoke:packaged` launches `release/win-unpacked/bb.exe` against a stub server,
checks the preload surface and then quits the app through the quit-request
file described under Debugging, force-killing the tree only as a last resort
that also fails the smoke.

`smoke:windows-processes` is the orphan check. It starts an unrelated
bystander process, snapshots `Win32_Process` through
`Get-CimInstance`, launches the packaged app with a scratch data directory and
free ports, waits for the owned runtime's `/health`, records the app's whole
descendant set, quits through the quit-request file, and then fails if any
descendant survives with the same pid and creation date, if any new bb-looking
process mentions the scratch directories or the bridge, or if the bystander
was killed. It writes `before.json`, `during.json`, `after.json` and
`summary.json` to `--evidence-dir` (default `qa-artifacts/process-hygiene`);
under Turbo that path resolves against `apps/desktop`, not the repo root.

## Packaging

```bash
pnpm exec turbo run desktop:build --filter=@bb/desktop
pnpm exec turbo run smoke:packaged --filter=@bb/desktop
```

Artifacts are written under `apps/desktop/release/`. The macOS build is Apple
Silicon arm64-only; Intel Macs are not a target. Without signing secrets, local builds
sign with a code-signing identity auto-discovered from the keychain and skip
notarization. A valid signature matters even for local builds: macOS
provenance-tracks unsigned apps, forcing syspolicyd to evaluate every exec in
the app's process tree, which can stall process launches system-wide. On
machines with no keychain identity (or with `CSC_IDENTITY_AUTO_DISCOVERY=false`,
as CI sets for workflow-artifact-only builds), artifacts remain unsigned and
macOS shows the normal Gatekeeper warning on first launch.

### Linux (AppImage, x64)

Linux packaging targets x64 glibc-based distributions. Install `python3`,
`make`, and `g++` so node-gyp can build node-pty during dependency installation.

From the repo root, build an unpacked app, an AppImage distribution, or smoke
test the current packaged output with:

```bash
pnpm --filter @bb/desktop run package:linux
pnpm --filter @bb/desktop run dist:linux
pnpm --filter @bb/desktop run smoke:packaged
```

Running an AppImage normally requires FUSE and, on some distributions, the
`libfuse2` compatibility package. If FUSE is unavailable, launch it with
`--appimage-extract-and-run` instead.

Linux users whose window manager supplies all window controls can remove the
native Electron title bar with `--no-window-frame`:

```bash
./bb-x86_64.AppImage --no-window-frame
```

The native frame remains the default. Changing this startup option requires a
full desktop app restart.

Linux users can opt into a transparent Electron window with
`--transparent-window`:

```bash
./bb-x86_64.AppImage --transparent-window
```

The window remains opaque by default. Transparency also requires a compositor
that supports it, and Electron documents limitations including unsupported
window shaping and unreliable resize behavior on some platforms. The flag can
be combined with `--no-window-frame`, and changing it requires a full desktop
app restart.

CI builds Linux artifacts on the pinned `ubuntu-22.04` runner. The AppImage
links against the build machine's glibc, so that pin sets the oldest
distribution that can run a published build. Raise it deliberately.

Linux gets both update paths, but they are not equivalent:

- The JSON version feed (`desktop-version-linux.json`) is polled on every Linux
  install and reports that a newer release exists.
- Self-installing auto-update runs only inside an AppImage whose directory the
  app can write to. electron-updater detects the AppImage through the `APPIMAGE`
  environment variable, and its install step unlinks the running file _before_
  moving the replacement in — so a read-only directory would delete the app and
  leave nothing behind. Both the startup check and the install handler verify
  write and search access on the parent directory first.
- Everything else — an extracted directory, a distribution package, or an
  AppImage in a read-only location — reports new versions without installing
  them.

The Linux AppImage is unsigned, and electron-updater performs no signature
check on Linux: it verifies only the SHA-512 recorded in the update metadata
that ships beside it. macOS installs through Squirrel, which additionally
requires the replacement to satisfy the running app's code-signing
requirement. Write access to the release assets is therefore sufficient to
push code to Linux clients. Treat the release token accordingly.

### Windows (NSIS, x64)

Windows packaging targets Windows 11 x64. No compiler is needed: node-pty
ships a ConPTY-only N-API prebuild and `better-sqlite3` has an Electron-ABI
prebuild for `win32-x64`.

From the repo root, build an unpacked app or the installer with:

```powershell
pnpm --filter @bb/desktop run package:windows
pnpm --filter @bb/desktop run dist:windows
```

`dist:windows` writes `release/bb-<version>-x64.exe`, its `.blockmap`,
`release/latest.yml` and `release/win-unpacked/`; the nightly channel names
them `bb-nightly-<version>-x64.exe` and `nightly.yml`. Both scripts go through
`scripts/run-electron-builder.mjs`, which on Windows starts electron-builder
as `node electron-builder/cli.js` because `node_modules/.bin/electron-builder`
is a `.cmd` shim that cannot be spawned without a shell. The first build on a
machine downloads the `winCodeSign` toolchain — and `nsis` for the installer —
into `%LOCALAPPDATA%\electron-builder\Cache`, so budget several minutes for it
and much less for later builds. The window icon comes from the checked-in
`assets/icon.png`; app-builder-lib converts it to `.ico` itself, so no `.ico`
is checked in. Expect electron-builder to log "signing with signtool.exe" even
without signing secrets: it is a no-op and the executable stays unsigned.

The installer is assisted rather than one-click and per-user rather than
per-machine, so a standard account installs it without elevation. It defaults
to `%LOCALAPPDATA%\Programs\bb`, lets the user change that, and creates a
desktop shortcut. `%APPDATA%\bb` — Electron's `userData`, holding the
owned-runtime record, the window state and the cached Connect credential —
deliberately survives uninstall, and `%USERPROFILE%\.bb`, bb's own runtime
data directory, is never touched by the installer or the uninstaller.

Closing the last window on Windows does not quit the app: it parks in the
tray with the owned `bb-app` runtime still running. The tray menu offers
`Open bb` and `Quit bb`, and Quit stops the whole runtime process tree —
identity-verified, never a blind `taskkill` — before the app exits. Windows
logoff and shutdown run that same stop.

### Windows signing

Windows artifacts are signed through Azure Trusted Signing when all seven of
these are set, and are unsigned otherwise:

| Secret                              | Value                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `AZURE_TENANT_ID`                   | Entra tenant for the signing account; read by Azure's own credential chain, never by bb. |
| `AZURE_CLIENT_ID`                   | Service principal application id.                                                        |
| `AZURE_CLIENT_SECRET`               | Service principal secret.                                                                |
| `AZURE_SIGNING_ENDPOINT`            | Trusted Signing account endpoint URL.                                                    |
| `AZURE_SIGNING_ACCOUNT_NAME`        | Trusted Signing account name.                                                            |
| `AZURE_SIGNING_CERTIFICATE_PROFILE` | Certificate profile inside that account.                                                 |
| `WINDOWS_PUBLISHER_NAME`            | Publisher common name; also written as `publisherName`.                                  |

A partial set is a build failure, not a silent unsigned build: the script
aborts with `Incomplete Windows signing environment`, naming what is present
and what is missing. In unsigned mode `publisherName` is deliberately left
unset, which is what lets one unsigned build update to the next — see
Auto-update below.

No certificate exists today, so local and CI builds are unsigned and Windows
SmartScreen shows "Windows protected your PC" on first launch; clearing it
takes More info → Run anyway. Because of that, the publish job withholds the
unsigned `.exe` from `desktop-latest` and publishes only the Windows version
feed.

## Releasing

`bb-app` and `@bb/desktop` versions are LOCKED in lockstep. The desktop package
depends on `bb-app: workspace:*`, and the displayed release version string must
match `packages/bb-app/package.json`.

To bump for a release:

```bash
node scripts/bump-version.mjs <new-version>
```

Then commit and ship through the normal `sawyer-next` → `main` flow. You can also
use `--patch`, `--minor`, or `--major` instead of an explicit version.

CI enforces this lockstep. Direct edits that leave
`packages/bb-app/package.json` and `apps/desktop/package.json` with different
versions fail the build. Never edit either package version directly for a
release; use `scripts/bump-version.mjs` so both files move together.

The desktop release tag uses the locked version: `desktop-v<version>` for
immutable releases and `desktop-latest` for the moving pointer.

`build-desktop.yml` builds macOS, Linux and Windows in parallel jobs, then
publishes all three from one job. The moving release resets all of its assets
on each publish, so a single publisher is what keeps one platform from deleting
another's binaries. Each platform has its own update feed file inside the same
release tag:

| Platform | Artifacts              | electron-updater metadata | Version feed                   |
| -------- | ---------------------- | ------------------------- | ------------------------------ |
| macOS    | `.dmg`, `.zip` (arm64) | `latest-mac.yml`          | `desktop-version.json`         |
| Linux    | `.AppImage` (x64)      | `latest-linux.yml`        | `desktop-version-linux.json`   |
| Windows  | `.exe` (NSIS, x64)     | `latest.yml`              | `desktop-version-windows.json` |

Two unsuffixed names sit in that table and they are not the same thing. macOS
keeps the unsuffixed **version feed** name because released macOS builds
already request it. Windows keeps the unsuffixed **electron-updater metadata**
name because app-builder-lib gives Windows an empty OS suffix.

Linux artifacts are unsigned and publish on their own. The macOS binaries wait
on the Apple signing secrets, and the Windows binaries wait on the Azure
Trusted Signing secrets the same way: when either gate is closed the publish
job still uploads that platform's version feed and withholds its unsigned
binaries.

The Windows job runs on the pinned `windows-2025` image — the same image the
`windows-x64` CI job uses — validates the seven signing secrets, builds the
installer, runs `smoke:packaged` and `smoke:windows-processes`, generates the
version feed, and uploads two artifacts: `bb-desktop-windows-x64` with the
release assets, and `bb-desktop-windows-x64-process-hygiene` with the smoke's
JSON evidence. They are separate on purpose: `upload-artifact` roots an
artifact at the least common ancestor of its matched paths, and the publish job
reads the release files from the top level of its download. It runs no test
step, unlike the macOS and Linux jobs: the Windows desktop and launcher suites
are still a non-gating baseline measured by `ci.yml`'s `windows-x64` job, and
gating the release workflow on them would let a red Windows assertion withhold
the macOS and Linux assets.

## Nightly channel

The scheduled `publish-bb-app.yml` workflow runs from `main` every day at
3:00 AM Pacific (`America/Los_Angeles`, including daylight-saving changes). It
derives a unique version such as `0.34.1-nightly.<run-id>.<attempt>` without
committing that version, publishes `bb-app` with the npm `nightly` dist-tag,
and builds the desktop app from that same lockstep version.

To publish or dry-run the channel manually from `main`, dispatch the same
workflow with `npm_tag=nightly`. A non-dry run publishes both npm and desktop;
a dry run validates only the npm package path.

A stable release also refreshes the channel. A non-dry `npm_tag=latest` run
publishes the release, then derives the next nightly version from the release
commit and publishes npm and desktop nightly again. Without this step the
nightly channel stays below `latest` until the next scheduled run.

The nightly desktop is a separate installation:

- product name: `bb Nightly`
- bundle identifier: `dev.bb.desktop.nightly`, which is also the Windows
  AppUserModelID, so Windows taskbar grouping and notifications keep the two
  channels apart
- Linux binary name: `bb-nightly`, so it never shadows stable `bb` on PATH
- Windows installer and executable: `bb-nightly-<version>-x64.exe` and
  `bb Nightly.exe`
- app/update release: `desktop-nightly`
- update metadata: `nightly-mac.yml`, `nightly-linux.yml` and `nightly.yml`
  (Windows)
- version feeds: `desktop-version.json` (macOS),
  `desktop-version-linux.json` (Linux) and `desktop-version-windows.json`
  (Windows)
- icon: `assets/icon-nightly.icns` and `assets/icon-nightly.png`

Download it from
[`desktop-nightly`](https://github.com/get-bb/bb/releases/tag/desktop-nightly)
or run the CLI build with:

```bash
npx bb-app@nightly
```

Stable and nightly desktop bundles can coexist. Electron-owned preferences,
window state, and process supervision use separate application data
directories; the embedded bb runtime still uses the normal `~/.bb` data and
default server port unless the corresponding environment variables are
overridden.

Nightly builds set `BB_DESKTOP_RELEASE_CHANNEL=nightly` at build time. The value
is baked into the Electron main/preload bundles and selects the nightly product
identity, yellow icon, and update URLs. Omit the variable (or set it to
`latest`) for stable and local builds.

## About panel

The app menu's About item opens a message box listing the facts a bug report
needs: version, build type, commit, build date and how old that build is
("3 days old"), plugin SDK version, Electron version, and OS. Its **Copy**
button puts that whole block on the clipboard. The age is computed when the
dialog opens, so a long-running session still reports it correctly.

The native About panel is populated too, minus the age, since Electron takes
those options once at startup. `scripts/build.mjs` bakes the build-time half of
the facts into the bundles:

| Variable                | Default when unset                                    |
| ----------------------- | ----------------------------------------------------- |
| `BB_DESKTOP_COMMIT`     | `GITHUB_SHA`, else `git rev-parse HEAD`, else unknown |
| `BB_DESKTOP_BUILD_DATE` | The build's own timestamp, ISO 8601                   |

The plugin SDK version is read from `packages/plugin-sdk/package.json` at build
time. A checkout with no git metadata reports `Commit: unknown` rather than
failing the build.

## macOS signing + notarization

The desktop package is ready for Developer ID signing and Apple notarization.
Local builds with no secrets sign via keychain auto-discovery and skip
notarization. To activate signed and notarized release artifacts, add these
GitHub Actions secrets:

| Secret                       | Value                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12`      | Base64-encoded `.p12` exported from Keychain Access for a `Developer ID Application` certificate and its private key. On macOS: `base64 -i DeveloperID.p12 -o certificate.base64.txt`. |
| `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12`.                                                                                                                                               |
| `MACOS_CERTIFICATE_NAME`     | Optional certificate common name, without the `Developer ID Application:` prefix. Leave unset when the `.p12` contains a single usable identity and electron-builder can derive it.    |
| `APPLE_ID`                   | Apple ID email for the Developer Program account.                                                                                                                                      |
| `APPLE_APP_PASSWORD`         | App-specific password from `appleid.apple.com` under Sign-In and Security.                                                                                                             |
| `APPLE_TEAM_ID`              | Developer Team ID from `developer.apple.com/account` membership details.                                                                                                               |

Once those secrets are present, the next `Build Desktop` workflow run with
`publish=true` and `release_channel=stable` signs the `.app`, notarizes it, and
publishes the signed `.dmg` / `.zip` assets to `desktop-latest`. If no required
signing secrets are configured, the workflow still builds unsigned artifacts, but
the release job publishes only `desktop-version.json` and withholds unsigned
binaries from `desktop-latest`. If only some required signing secrets are set,
the workflow fails before packaging so a misconfigured release cannot silently
produce unsigned or signed-but-not-notarized artifacts.

## Auto-update

The renderer update toast keeps using `desktop-version.json` as the lightweight
feature surface. The installer path uses `electron-updater` against the same
`desktop-latest` release asset directory and reads `latest-mac.yml`. These
checks run in parallel on launch, hourly, and when the app becomes active: the
JSON feed can show "update available" even when CI has published metadata only,
while the Electron updater only flips the toast to "ready to install" after a
signed update has actually downloaded. Local dev builds skip Electron auto-update
unless `BB_DESKTOP_AUTO_UPDATE=1` is set.

`bb Nightly` follows the equivalent isolated `desktop-nightly` release and
`nightly-mac.yml`; it never reads or moves the stable feed. The scheduled
workflow requires the complete signing/notarization secret set before
publishing nightly desktop assets.

Windows gets both paths too. The renderer toast reads
`desktop-version-windows.json` and electron-updater reads `latest.yml` from
the same `desktop-latest` directory. An available update downloads on its own
and installs on quit or from Settings; the install handler runs the normal
quit sequence first, so the whole `bb-app` runtime tree is already stopped
before `quitAndInstall` hands the installer over. An unsigned build updates to
the next unsigned build precisely because `publisherName` is unset:
electron-updater's NSIS signature check accepts a download when no publisher
name is configured, so setting a publisher without a certificate would break
every update rather than harden it. There is no environment override for the
electron-updater half — to point an installed build at a test feed, edit
`url:` in `resources/app-update.yml` inside the installed copy, and record the
original. The JSON half still follows `BB_DESKTOP_VERSION_FEED_URL`.

To verify a downloaded or unpacked build:

```bash
spctl --assess --verbose /path/to/bb.app
codesign --verify --deep --strict --verbose=2 /path/to/bb.app
```

## Debugging

Use the View menu to toggle DevTools. To open them automatically on launch, set
`BB_DESKTOP_OPEN_DEVTOOLS=1`:

```bash
BB_DESKTOP_OPEN_DEVTOOLS=1 apps/desktop/release/mac-arm64/bb.app/Contents/MacOS/bb
```

On Windows the packaged binary is `bb.exe` under `release/win-unpacked/`, or
`bb.exe` under the install directory for an installed copy:

```powershell
$env:BB_DESKTOP_OPEN_DEVTOOLS = "1"; apps\desktop\release\win-unpacked\bb.exe
```

When the desktop app spawns `bb-app`, server and daemon logs land under
`~/.bb/logs/` or `$BB_DATA_DIR/logs/` when `BB_DATA_DIR` is set.

Two Windows-only environment variables exist for automation, not for users.
Neither is a product feature and neither does anything on macOS or Linux:

- `BB_DESKTOP_QUIT_REQUEST_FILE` names a file path the app polls every 500 ms;
  the first poll that finds the file quits the app once, on exactly the tray
  Quit path. It exists because an Electron GUI process on Windows has no
  console to receive a signal, so the packaged smokes need some way to ask for
  a graceful quit. The app never deletes the file, so a script must use a
  fresh path per run or delete a stale one before launching.
- `BB_DESKTOP_PARENT_PID` is set by the desktop app on the `bb-app` child it
  spawns. The launcher polls that pid every 2 seconds and shuts itself down
  when the parent is gone, so a Desktop crash cannot leave a runtime behind.
  Setting it by hand on a launcher bb did not spawn just ties that launcher's
  lifetime to an unrelated process.

To verify attach-if-found manually, start a compatible bb first, then launch the
desktop app:

```bash
npx bb-app@latest
pnpm exec turbo run dev --filter=@bb/desktop
```

The desktop supervisor handles normal quits plus `SIGINT` and `SIGTERM`, and it
writes a PID file so the next launch can reap a stale Electron-owned `bb-app`
launcher. Hard crashes such as process aborts, segfaults, or kernel-level kills
cannot run cleanup in the crashing process; the startup PID-file reap is the
recovery path for those cases.
