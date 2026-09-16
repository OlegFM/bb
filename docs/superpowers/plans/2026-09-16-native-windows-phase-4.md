# Native Windows Port — Phase 4 (Windows Desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bb Desktop builds, installs, runs, updates and uninstalls natively on Windows 11 x64: electron-builder produces a per-user NSIS installer `bb-<version>-x64.exe` with `latest.yml` and `desktop-version-windows.json`, the packaged app stages the ConPTY natives and the Electron-ABI `better-sqlite3`, the Electron shell supervises `bb-app` as a hidden non-detached child and stops its whole process tree on Quit, closing the last window parks the app in the tray while the owned runtime keeps running, the window uses Windows 11 caption controls over the app's own chrome, updates install through electron-updater, `build-desktop.yml` gains a Windows job feeding the single publish job, and the `windows-x64` CI job smokes the packaged app and proves zero orphan processes after Quit.

**Architecture:** Every Windows branch is a `platform === "win32"` (Node) or `platform === "windows"` (desktop contract) arm beside untouched POSIX code; the POSIX and macOS behaviour of every shared module stays byte-identical to `windows-native/phase-3` (47bb778d8). The build scripts gain a `windows` build platform and a `windows` signing mode; the Electron main process gains a tray, a Windows quit policy, a `session-end` handler, a smoke-only quit-request file, a caption-overlay window frame and `setAppUserModelId`; `bb-process.ts` gains a win32 spawn/stop arm on top of Phase 2's `terminateProcessTree`; `bb-app` gains a win32 parent-PID watchdog so a crashed Desktop never leaves a runtime behind; the update stack flips the Windows arm on. Two smokes (`smoke:packaged` on `win-unpacked`, new `smoke:windows-processes`) run on the reference desktop and in CI.

**Tech Stack:** pnpm 9.15.0, Turbo, Vitest 4, TypeScript, zod, Electron 41.7.0 (ABI 145), electron-builder ^26.15.7 (app-builder-lib 26.15.7, NSIS target, Azure Trusted Signing options), electron-updater 6.8.3, node-pty 1.2.0-beta.15 (ConPTY-only win32 prebuild), better-sqlite3 12.10.0 (Electron v145 win32-x64 prebuild exists, HTTP 200), `@bb/process-utils` (Phase 2 `terminateProcessTree`, `queryWindowsProcess`), PowerShell 7 / Windows PowerShell 5.1.

**Spec:** `docs/superpowers/specs/2026-09-11-native-windows-port-design.md` (§4 Process rules, §5 seam "Process launch and stop", §6 "Desktop close policy", "Data directories", "Architecture and identity", "Signing", "Auto-update", §7 Phase 4, §8 Verification, §9 Risks "No Job Objects", "SmartScreen on unsigned builds", §10 Donor policy).

**Research (read-only, saved for the controller):** the session scratchpad `phase4-research/` holds `01-electron-builder-win.md`, `02-native-modules-smoke.md`, `03-bb-process-tray-runtime.md`, `04-updates-ci.md`, `05-gate-paths-host.md`, `06-controller-probes.md`. Every measured fact quoted below comes from those files; a task brief may quote them but never needs them.

## Global Constraints

- **User rule (binding, overrides the donor and any ruling):** POSIX and macOS behaviour of shared code stays byte-identical to 47bb778d8. New spawn options, new stop paths, new lifecycle handlers, new window options and new build-script branches exist only inside `platform === "win32"` / `platform === "windows"` arms or behind a `--win` build flag. A shared function may gain an optional `platform?: NodeJS.Platform` parameter defaulting to `process.platform` and an optional `env?: NodeJS.ProcessEnv` parameter defaulting to `process.env` (testability, not behaviour), and a shared module may gain a new export that POSIX callers do not call. Existing POSIX tests are not rewritten; when an existing POSIX test fails on the win32 host only because a default became platform-aware, pin `platform: "linux"` on that call and change nothing else. A reviewer treats "a POSIX or macOS user could notice this" as an Important finding. The donor's cross-platform `shouldAutoAttachToForeignRuntime` change is **not** ported.
- Platform is injected, never ambient: `process.platform` is read only as a default parameter value or at composition roots (`apps/desktop/src/main.ts`, `packages/bb-app/src/launcher.ts` `runBbApp`, script entry points under `apps/desktop/scripts/`, `.github/workflows/*.yml`) (spec §4).
- `shell: true` stays forbidden; the donor's `shell: true` for `.cmd`/`.bat` runtimes is not ported (`bb-process.ts` only ever spawns `process.execPath` or `BB_DESKTOP_NODE_EXEC_PATH`, both PE images). Background children (`bb-app`, probes, `taskkill`, `powershell.exe` in smokes) pass `windowsHide: true`; the user-facing app window is unaffected (spec §4).
- Windows system tools are spawned by absolute path from `resolveWindowsSystemToolPath(name, env)` inside `@bb/process-utils`; scripts under `apps/desktop/scripts/*.mjs` cannot import workspace packages and spawn `tasklist.exe`, `taskkill.exe` and `powershell.exe` through `join(env.SystemRoot ?? "C:\\Windows", "System32", …)` with `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass` for PowerShell.
- Tool output is never parsed for localized text; success is decided by exit codes, liveness re-checks and structured output (`tasklist /FO CSV /NH`, `Get-CimInstance … | ConvertTo-Json`).
- Stop sequence identity rules (spec §5) stay as Phase 2 implemented them; the Desktop win32 stop path reuses `terminateProcessTree` and never a bare-PID `taskkill /F` in product code (smoke scripts may `taskkill /T /F` a pid they spawned themselves as a last-resort cleanup after the graceful path failed, and that failure is a smoke failure).
- `HOST_DAEMON_PROTOCOL_VERSION` stays at 201. No task changes a wire field, a session payload, a WebSocket message or a host RPC command; the `terminal.exited` value normalisation in Task 9 changes a win32-only value inside the existing `number | null` type. If a task finds it must change a wire shape, it stops and reports.
- Code comments are forbidden in TypeScript, JavaScript and YAML-embedded scripts except semantic tool directives (`AGENTS.md`); the existing comments in `prepare-native-modules.cjs`, `run-electron-builder.mjs`, `desktop-release-channel.mjs` and the workflows are pre-existing and are neither extended nor removed. No `as X` casts outside boundary parsing.
- Builds, typechecks and tests run through Turbo: `pnpm exec turbo run <task> --filter=<pkg>`; single files may be run with `pnpm --filter <pkg> exec vitest run <file>` while iterating; every task ends with the Turbo `typecheck` of the touched packages and the Turbo `test` of every package whose tests changed. `@bb/app` DOM tests are slow: run changed files individually and pipe output to a scratchpad log.
- Measurement rule (spec §8): no Windows behaviour is claimed until it has run on Windows. Pure logic with injected platform runs everywhere; real process trees, real NSIS output, real Electron windows and real `tasklist` diffs are `it.runIf(process.platform === "win32")` or smoke scripts run on the reference desktop and the `windows-x64` CI job. An early `return` that leaves a test green is a bug; a test that cannot run on win32 is `skipIf` with the reason in its name.
- Formatter: `pnpm exec oxfmt <files>` on every touched `.ts`/`.tsx`/`.mjs`/`.cjs`/`.md`/`.json` file before committing; Windows literals in TypeScript use doubled backslashes; `.yml` is formatted by hand in the existing style.
- Donor policy (spec §10): fragments from `refs/remotes/upstream-pr/3188` (`git show refs/remotes/upstream-pr/3188:<path>`) are reading aids, never cherry-picks; not ported: `win-release.yml` and the `desktop-win-*` tags, the `cl.bb.wn`/`wbb` identity, `assets/icon.ico`, `shell: true` runtimes, the unconditional `process.execPath` electron-builder invocation, the bare `taskkill /T /F` stop, `shouldAutoAttachToForeignRuntime`, the donor's `windowsApplicationName` config key.
- Plugin API rules: this plan adds no `@get-bb/plugin-sdk` export, no `app.slots.*` method and no `BbPluginApi` property; `docs/api_to_audit.md`, `packages/plugin-api-map/src/surfaces.ts` and the bb-guide API indexes are untouched. New user-facing env knobs (`BB_DESKTOP_QUIT_REQUEST_FILE`, `BB_DESKTOP_PARENT_PID`) are documented per `docs/cli-guide-and-skill.md` in `docs/configuration.md` and `apps/desktop/README.md` (Task 12).
- Commits are grouped by seam; each task ends with one commit whose message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` followed by `Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4`.
- Phase gate (spec §7, restated in Task 13): as a standard user install, use, update N → N+1, uninstall; zero orphan processes after Quit (`tasklist` diff) while an unrelated process started during the run is still alive afterwards; SmartScreen state documented; macOS and Linux desktop builds unchanged (config diff + WSL suite); CI `Windows x64` green with the two new smokes.

## Rulings recorded before execution

Each resolves a place where the spec, the donor, the measured host and the current tree disagree. Each is binding for the task that cites it.

- **R1 Identity and artifact.** `appId` stays `dev.bb.desktop` (nightly `dev.bb.desktop.nightly`), `productName` `bb` (`bb Nightly`), executable `bb.exe` (`bb Nightly.exe`) under `release/win-unpacked/`, artifact `${productName}-${version}-${arch}.${ext}` → `bb-<version>-x64.exe` (nightly `bb-nightly-<version>-x64.exe`), x64 only. `app.setAppUserModelId` uses the same string, exposed as `createDesktopReleaseInfo(channel).appUserModelId`; dev (unpackaged) runs use `dev.bb.desktop.dev`. The donor's `cl.bb.wn`/`wbb`/`windowsApplicationName` are not ported.
- **R2 NSIS.** `win.target = [{ target: "nsis", arch: ["x64"] }]`, `nsis = { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, deleteAppDataOnUninstall: false }` (assisted per-user installer; default directory `%LOCALAPPDATA%\Programs\bb`; `%APPDATA%\bb` survives uninstall and is documented). `win.icon` points at the existing PNG (`assets/icon.png` / `assets/icon-nightly.png`); app-builder-lib 26.15.7 converts PNG → ICO itself (measured `WinPackager.getOrConvertIcon("ico")`); no `.ico` is checked in. rcedit metadata stamping stays on (`signAndEditExecutable` default).
- **R3 electron-builder invocation on Windows.** `node_modules/.bin/electron-builder` is a `.cmd` shim that `spawn` cannot run without a shell on Node 22. On `win32` only, `run-electron-builder.mjs` spawns `process.execPath` with `createRequire(import.meta.url).resolve("electron-builder/cli.js")`; POSIX keeps the `.bin` shim spawn byte-identical. The donor's unconditional swap is not ported.
- **R4 Build platform and update metadata.** `resolveDesktopBuildPlatform("win32")` returns `"windows"`; `updateMetadataFileNames.windows` is `latest.yml` (nightly `nightly.yml`), matching app-builder-lib's `${channel}${osSuffix}.yml` with an empty Windows suffix (measured `updateInfoBuilder.js:53`); `generate-version-feed.mts` therefore writes `desktop-version-windows.json` unchanged in shape (`packages/desktop-contract` already knows the platform and file name).
- **R5 Signing mode `windows`.** `run-electron-builder.mjs` gains `createWindowsSigningPlan(env)` beside the macOS plan: keys `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (read by Azure's `EnvironmentCredential`, never by bb), `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT_NAME`, `AZURE_SIGNING_CERTIFICATE_PROFILE`, `WINDOWS_PUBLISHER_NAME`. All seven present → mode `windows`: `win.azureSignOptions = { endpoint, certificateProfileName, codeSigningAccountName, publisherName }` and `win.publisherName = WINDOWS_PUBLISHER_NAME`. None present → mode `unsigned`: neither key is set (electron-updater 6.8.3 `NsisUpdater.verifySignature` returns `null` and accepts the download when `publisherName` is absent, measured `NsisUpdater.js:84-90`; setting a publisher without a certificate would fail every update). A partial set throws `Incomplete Windows signing environment. Present: …. Missing: ….`. The stable-channel refusal lives in `build-desktop.yml`'s publish plan (Windows binaries are withheld when `has_windows_signing_secrets` is false, exactly like the macOS gate); nightly and fork builds may publish unsigned. No certificate exists today; SmartScreen "More info → Run anyway" is documented.
- **R6 Native modules.** `asarUnpack: ["dist/bb-app-bridge.mjs", "node_modules/**"]` already stages every `node_modules` file outside asar, so `conpty.node`, `conpty_console_list.node`, `conpty/conpty.dll` and `conpty/OpenConsole.exe` ship under `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/` and node-pty's `loadNativeModule` finds them relative to `lib/` (measured `utils.js`). The spec's `winpty.dll`/`winpty-agent.exe` do not exist for node-pty 1.2.0-beta.15 (ConPTY-only prebuild) and are not staged. `prepare-native-modules.cjs` on `platform === "win32"` asserts those four files exist under every packaged node-pty and throws naming the missing file; `better-sqlite3` is fetched with `prebuild-install --runtime=electron --target=41.7.0 --arch=x64 --platform=win32` (asset exists, HTTP 200). The POSIX chmod list and the `unixTerminal.js` patch stay byte-identical (the patch also runs on the Windows copy because the file exists there and is unused).
- **R7 `bb-process.ts` win32 arm.** `startBbAppProcess` gains `platform?: NodeJS.Platform` (composition root `main.ts`). On win32 the child is spawned non-detached with `windowsHide: true` and env `BB_DESKTOP_PARENT_PID=<process.pid>`; `stop()` calls `terminateProcessTree({ child: childProcess, graceMs: WINDOWS_RUNTIME_STOP_GRACE_MS (1_000), platform: "win32", onSkippedProcess })` (Phase 2 semantics: snapshot descendants, `taskkill /T`, grace, force the leader through the held handle, force descendants by verified identity, log `pid-reused` skips into the runtime log buffer) and then waits `killTimeoutMs` for the handle to report exit; no SIGTERM is sent on win32 (Node's `kill("SIGTERM")` is `TerminateProcess` there and the launcher's signal handlers never run, measured in donor commit 2e8d2a957). POSIX keeps `kill(signal)` → timeout → `kill(killSignal)` byte-identical. `BB_DESKTOP_RUNTIME_ID` and a runtime id in the health response are **deferred** with a docs entry: on win32 `stopVerifiedProcess` already verifies by command line (`owned-runtime.json`'s `bridgePath`) and CIM `creationDate`, and a health-response field is a server wire change outside "Protocol: none".
- **R8 Parent-PID watchdog.** `packages/bb-app/src/parent-watchdog.ts` exports `resolveParentProcessPid({ env, platform })` (win32 only, `BB_DESKTOP_PARENT_PID` positive integer) and `startParentProcessWatchdog({ env, platform, intervalMs, isProcessAlive?, onParentExit })`; `runBbApp` starts it after signal forwarding with `intervalMs: 2_000` and calls `shutdown("SIGTERM")` (the launcher's existing graceful path) when the parent is gone. On POSIX the resolver returns `null` and nothing is scheduled. The timer is `unref()`ed.
- **R9 Tray and quit policy.** `desktop-tray.ts` (donor shape, `platform` injected) creates a tray on win32 only with tooltip = application name, menu `Open <name>` / separator / `Quit <name>`, click → focus or create a window; `desktop-runtime-policy.ts` exports `shouldQuitOnWindowAllClosed({ platform })` (`false` for darwin and win32, `true` otherwise — Linux unchanged) and `shouldHandleSessionEnd({ platform })` (win32 only). `window-all-closed` on win32 leaves the app running with the tray and the owned runtime (spec §6); Quit runs today's `finishQuit` → `stopOwnedRuntime`, which stops a spawned runtime and never an attached one (already true). `session-end` (Windows logoff/shutdown) runs `finishQuit` immediately. The donor's `shouldStopRuntimeOnQuit` duplicates the existing ownership check and is not ported.
- **R10 Quit-request file (smoke seam).** Windows has no signal the packaged smokes can send for a graceful Quit (Electron GUI processes have no console; `kill()` is `TerminateProcess`). `desktop-quit-request.ts` exports `resolveDesktopQuitRequestFile({ env, platform })` — the path in `BB_DESKTOP_QUIT_REQUEST_FILE` on win32 only, `null` elsewhere — and `watchDesktopQuitRequestFile({ filePath, onRequest, pollMs, fileExists? })` (500 ms poll, `unref`, fires once). `main.ts` wires it on win32 only and treats a request exactly like tray Quit (`app.quit()`). It is the Windows analogue of the SIGTERM the Linux smoke sends and is documented as a smoke/automation knob.
- **R11 Window frame.** On win32 the window is created with `titleBarStyle: "hidden"` and `titleBarOverlay: resolveWindowsTitleBarOverlay({ darkColors })` (`height: 48` = the app's `--bb-app-chrome-row-height` 3rem; dark `{ color: "#1f1f1f", symbolColor: "#e8e8e8" }`, light `{ color: "#f6f6f6", symbolColor: "#1f1f1f" }`); the `BB_DESKTOP_SET_THEME_CHANNEL` handler calls `setTitleBarOverlay` on every application window on win32 after switching `nativeTheme.themeSource`. macOS keeps `hiddenInset` + traffic lights and Linux keeps its frame flags byte-identical. App side: `shouldUseDesktopWindowChrome(desktopInfo)` (macos or windows) gates the drag regions the five chrome components already apply; `shouldReserveWindowsCaptionControls({ desktopInfo, windowState })` (windows and not full screen) adds `WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS = "pr-[138px]"` (three 46 px Windows 11 caption buttons) to the right edge of `AppPageHeader`'s content row and `ThreadSecondaryPanel`'s header row; the macOS traffic-light helpers stay macOS-only. The drag/no-drag class constants are renamed from `MACOS_*` to `DESKTOP_*` project-wide (values unchanged); `MACOS_TRAFFIC_LIGHT_*` and `MACOS_CHROME_CONTROL_AXIS_CLASS` keep their names.
- **R12 Second-instance argv and `bb://`.** Deferred with a docs entry: nothing in bb registers a protocol client or a file association today (`setAsDefaultProtocolClient`/`open-url` are absent from `main.ts`), so there is no argv to forward; the second-instance handler keeps focusing or creating a window, now through the shared `focusOrCreateApplicationWindow()` the tray also uses.
- **R13 Update support.** `resolveDesktopUpdateSupport` windows arm returns `{ autoUpdate: true, versionCheck: true }` (spec §6); the JSON feed URL becomes `…/desktop-latest/desktop-version-windows.json`; electron-updater reads `latest.yml` from the same release directory (`publish.url` unchanged). Before an install `main.ts` already runs `finishQuit()` (which stops the owned runtime tree) and then `quitAndInstall()` — the spec's "runtime tree stopped before installing" is satisfied by the existing handler plus R7 and is asserted by a test, not re-implemented. The `desktop-latest`/`desktop-v<version>` tags are shared with macOS and Linux; the donor's `desktop-win-*` tags are not ported.
- **R14 Packaged-build feed override for the gate.** No new code knob. electron-updater reads `resources/app-update.yml` from the installed copy; the gate points an installed N at a local HTTP server by editing that file's `url:` (unsigned build, no signature check per R5) and points the JSON feed with the existing `BB_DESKTOP_VERSION_FEED_URL`. Recorded as the QA procedure in `docs/platform-windows.md`.
- **R15 Packaged smokes.** `smoke-packaged-app.mjs` gains a win32 arm (binary under `win-unpacked`, expected desktop platform `windows`, graceful stop through the R10 quit-request file with `taskkill /PID <pid> /T /F` as the last resort that also fails the smoke); POSIX stop stays SIGTERM → SIGKILL byte-identical. New `smoke-windows-processes.mjs` (win32 only): starts an unrelated bystander `node.exe` first, snapshots processes through `Get-CimInstance Win32_Process` (`ProcessId`, `ParentProcessId`, `Name`, `CommandLine`, `CreationDate` as JSON), launches `win-unpacked\bb.exe` with a scratch `BB_DATA_DIR`, free `BB_SERVER_PORT`/`BB_HOST_DAEMON_PORT`, `BB_DESKTOP_ATTACH_WITHOUT_PROMPT=1`, `BB_DESKTOP_OPEN_DEVTOOLS=0` and the quit-request file, waits for `GET /health` 200 on the real owned runtime (startup timeout 120 s), records the app's descendant set, writes the quit file, waits for the app pid to exit (30 s), sleeps 2 s, re-snapshots and fails on any surviving descendant (same pid and `CreationDate`) or any new `node.exe`/`bb.exe`/`pwsh.exe`/`powershell.exe`/`cmd.exe`/`conhost.exe` whose command line names the scratch data dir or the bridge path; asserts the bystander is still alive, then kills it. Evidence (`before.json`, `during.json`, `after.json`, `summary.json`) goes to `--evidence-dir` (default `qa-artifacts/process-hygiene`).
- **R16 CI.** `ci.yml` `windows-x64` adds `Package Windows desktop (unpacked)` (`pnpm --filter @bb/desktop run package:windows`), `Smoke packaged desktop app` and `Smoke Windows process hygiene` after the tarball smoke, all with the workspace-local `TMP`/`TEMP` the tarball smoke already needs (runner temp ACLs), and uploads `qa-artifacts/**`. `build-desktop.yml` gains a `windows` job on `windows-2025` (the same pinned image as `ci.yml`; no Blacksmith Windows runner is in use anywhere in the repo) that validates the seven signing secrets (`has_windows_signing_secrets` output), runs `desktop:build:windows`, both smokes and the version feed, and uploads `bb-desktop-windows-x64` (`*.exe`, `*.blockmap`, `latest.yml`, `desktop-version-windows.json`); `publish` needs it, always publishes `desktop-version-windows.json`, and publishes `latest.yml` + `*.exe` + `*.blockmap` only when the Windows secrets are complete. The test baseline in `ci.yml` stays `continue-on-error` (Phase 5 flips it).
- **R17 Phase 3 carry-overs.** (a) App file names: `apps/app/src/lib/host-path.ts` exports `isWindowsAbsolutePath`, `hostPathSegments` and `hostPathBasename`; a drive-absolute (`C:\`, `C:/`) or UNC (`\\`) path splits on `[\\/]`, every other input splits on `/` exactly as before, so POSIX inputs are byte-identical; the nine `split("/")` file-name sites (`environment-queries.ts`, `project-queries.ts`, `api.ts`, `plugin-slot-resolvers.ts`, `file-opener-tabs.ts`, `rightPanelFileVisuals.ts`, `SkillDetailView.tsx`, `RootComposeView.tsx`, `ThreadDetailView.tsx`) use it. (b) Terminal exit code: `apps/host-daemon/src/terminals/terminal-exit-code.ts` exports `normalizeTerminalExitCode({ closeRequested, exitCode, platform })`; on win32 a bb-requested close (`session.closeReason !== null`) whose pty exit code is `-1073741510` (`STATUS_CONTROL_C_EXIT`, produced by node-pty's own `kill()`) reports `exitCode: null`, which the app already renders as `Terminal exited`; every other input passes through unchanged. No wire type changes (`exitCode` is already `number | null`).
- **R18 `@bb/process-utils` in Desktop.** `apps/desktop/package.json` adds `"@bb/process-utils": "workspace:*"` to `dependencies` (esbuild bundles workspace packages; `@bb/config` already depends on it, so the lockfile gains one link entry). `pnpm install` runs once in Task 5 and the lockfile change is committed with that task.
- **R19 Runner and shell for Windows CI scripts.** Workflow `run:` blocks on the Windows jobs are PowerShell (the runner default); they end with `exit $LASTEXITCODE` after a Turbo invocation piped through `Tee-Object`, as the Phase 3 steps do. Secret validation on Windows is written in PowerShell with `[string]::IsNullOrWhiteSpace`.
- **R20 Documentation timing.** Task 12 writes the Phase 4 section of `docs/platform-windows.md`, the Windows packaging/installing/updating sections of `apps/desktop/README.md`, the env knobs in `docs/configuration.md`, and the platform-support wording ("Windows Desktop (beta)"); the gate corrects any claim it disproves.

## File Structure

| Path                                                                                                                                                                   | Responsibility                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/desktop/scripts/desktop-release-channel.mjs` (+ `.d.mts`, new `test/desktop-release-channel.test.ts`)                                                            | `windows` build platform, `latest.yml`/`nightly.yml`                             |
| `apps/desktop/scripts/packaged-app-paths.mjs` (+ new `test/packaged-app-paths.test.ts`)                                                                                | `win-unpacked/<productName>.exe`                                                 |
| `apps/desktop/electron-builder.config.json`, `scripts/run-electron-builder.mjs`, `test/electron-builder-config.test.ts`, `package.json`, `turbo.json`                  | NSIS target, `--win` invocation, `windows` signing mode, scripts and Turbo tasks |
| `apps/desktop/scripts/prepare-native-modules.cjs` (+ `test/electron-builder-config.test.ts`)                                                                           | ConPTY prebuild assertion, win32 better-sqlite3 prebuild                         |
| `apps/desktop/src/desktop-update-provider.ts` (+ test)                                                                                                                 | windows update arm, `appUserModelId`                                             |
| `apps/desktop/src/bb-process.ts` (+ test)                                                                                                                              | win32 spawn options, parent pid env, tree stop                                   |
| `packages/bb-app/src/parent-watchdog.ts` (+ `test/parent-watchdog.test.ts`), `packages/bb-app/src/launcher.ts`                                                         | parent-PID watchdog                                                              |
| `apps/desktop/src/desktop-tray.ts`, `desktop-runtime-policy.ts`, `desktop-quit-request.ts` (+ tests), `src/main.ts`                                                    | tray, quit policy, `session-end`, quit-request file, `setAppUserModelId`         |
| `apps/desktop/src/desktop-window-frame.ts`, `desktop-window-factory.ts` (+ tests), `src/main.ts`; `apps/app/src/lib/bb-desktop.ts` (+ test) and five chrome components | caption overlay, drag regions, caption reserve                                   |
| `apps/app/src/lib/host-path.ts` (+ test) and nine call sites; `apps/host-daemon/src/terminals/terminal-exit-code.ts` (+ test), `terminal-manager.ts`                   | Phase 3 carry-overs                                                              |
| `apps/desktop/scripts/smoke-packaged-app.mjs`, new `scripts/smoke-windows-processes.mjs`, `scripts/run-packaged-app.mjs`                                               | packaged smoke on Windows, orphan-process smoke                                  |
| `.github/workflows/ci.yml`, `.github/workflows/build-desktop.yml`                                                                                                      | Windows packaging and smokes in CI, Windows desktop job feeding publish          |
| `docs/platform-windows.md`, `docs/platform-support.md`, `docs/configuration.md`, `apps/desktop/README.md`, `README.md`                                                 | documentation                                                                    |
| `qa/windows/phase-4/`                                                                                                                                                  | gate evidence                                                                    |

---

### Task 1: Windows build platform and packaged paths

**Files:**

- Modify: `apps/desktop/scripts/desktop-release-channel.mjs`, `apps/desktop/scripts/desktop-release-channel.d.mts`
- Modify: `apps/desktop/scripts/packaged-app-paths.mjs`
- Create: `apps/desktop/test/desktop-release-channel.test.ts`, `apps/desktop/test/packaged-app-paths.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces (used by Tasks 2, 4, 10, 11): `resolveDesktopBuildPlatform("win32") === "windows"`; `DesktopBuildPlatform = "macos" | "linux" | "windows"`; `DesktopUpdateMetadataFileNames.windows: "latest.yml" | "nightly.yml"`; `resolvePackagedAppBinary({ executableName, platform: "win32", productName, releaseDir })` → `join(releaseDir, "win-unpacked", `${productName}.exe`)`.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/desktop-release-channel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createDesktopReleaseConfig,
  resolveDesktopBuildPlatform,
} from "../scripts/desktop-release-channel.mjs";

describe("resolveDesktopBuildPlatform", () => {
  it("maps each supported Node platform to its desktop build platform", () => {
    expect(resolveDesktopBuildPlatform("darwin")).toBe("macos");
    expect(resolveDesktopBuildPlatform("linux")).toBe("linux");
    expect(resolveDesktopBuildPlatform("win32")).toBe("windows");
  });

  it("rejects platforms the desktop does not build for", () => {
    expect(() => resolveDesktopBuildPlatform("freebsd")).toThrow(
      "Desktop builds support darwin, linux and win32 only, got freebsd.",
    );
  });
});

describe("createDesktopReleaseConfig update metadata", () => {
  it("names the Windows updater metadata after the channel with no OS suffix", () => {
    expect(
      createDesktopReleaseConfig("latest").updateMetadataFileNames,
    ).toEqual({
      linux: "latest-linux.yml",
      macos: "latest-mac.yml",
      windows: "latest.yml",
    });
    expect(
      createDesktopReleaseConfig("nightly").updateMetadataFileNames,
    ).toEqual({
      linux: "nightly-linux.yml",
      macos: "nightly-mac.yml",
      windows: "nightly.yml",
    });
  });
});
```

`apps/desktop/test/packaged-app-paths.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePackagedAppBinary } from "../scripts/packaged-app-paths.mjs";

describe("resolvePackagedAppBinary", () => {
  it("points at the unpacked Linux executable", async () => {
    await expect(
      resolvePackagedAppBinary({
        executableName: "bb",
        platform: "linux",
        productName: "bb",
        releaseDir: "/tmp/release",
      }),
    ).resolves.toBe(join("/tmp/release", "linux-unpacked", "bb"));
  });

  it("points at the unpacked Windows executable named after the product", async () => {
    await expect(
      resolvePackagedAppBinary({
        executableName: "bb-nightly",
        platform: "win32",
        productName: "bb Nightly",
        releaseDir: "C:\\work\\release",
      }),
    ).resolves.toBe(
      join("C:\\work\\release", "win-unpacked", "bb Nightly.exe"),
    );
  });

  it("still rejects platforms without a packaged layout", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "bb-packaged-paths-"));
    try {
      await expect(
        resolvePackagedAppBinary({
          executableName: "bb",
          platform: "freebsd",
          productName: "bb",
          releaseDir,
        }),
      ).rejects.toThrow("Unsupported packaged desktop platform: freebsd");
    } finally {
      await rm(releaseDir, { force: true, recursive: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bb/desktop exec vitest run test/desktop-release-channel.test.ts test/packaged-app-paths.test.ts`
Expected: FAIL — `resolveDesktopBuildPlatform("win32")` throws `Desktop builds support darwin and linux only`, the `windows` key is missing, and the win32 path throws `Unsupported packaged desktop platform: win32`.

- [ ] **Step 3: Implement**

`desktop-release-channel.mjs`:

```js
export function resolveDesktopBuildPlatform(nodePlatform) {
  if (nodePlatform === "darwin") {
    return "macos";
  }
  if (nodePlatform === "linux") {
    return "linux";
  }
  if (nodePlatform === "win32") {
    return "windows";
  }

  throw new Error(
    `Desktop builds support darwin, linux and win32 only, got ${nodePlatform}.`,
  );
}
```

and in `createDesktopReleaseConfig` add `windows: "nightly.yml"` to the nightly `updateMetadataFileNames` and `windows: "latest.yml"` to the stable one (keys sorted `linux`, `macos`, `windows`).

`desktop-release-channel.d.mts`:

```ts
export type DesktopBuildPlatform = "macos" | "linux" | "windows";

export interface DesktopUpdateMetadataFileNames {
  linux: "latest-linux.yml" | "nightly-linux.yml";
  macos: "latest-mac.yml" | "nightly-mac.yml";
  windows: "latest.yml" | "nightly.yml";
}
```

`packaged-app-paths.mjs` — insert before the darwin guard:

```js
if (platform === "win32") {
  return join(releaseDir, "win-unpacked", `${productName}.exe`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bb/desktop exec vitest run test/desktop-release-channel.test.ts test/packaged-app-paths.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm exec turbo run typecheck --filter=@bb/desktop`, `pnpm exec oxfmt apps/desktop/scripts/desktop-release-channel.mjs apps/desktop/scripts/desktop-release-channel.d.mts apps/desktop/scripts/packaged-app-paths.mjs apps/desktop/test/desktop-release-channel.test.ts apps/desktop/test/packaged-app-paths.test.ts`

```bash
git add apps/desktop/scripts apps/desktop/test/desktop-release-channel.test.ts apps/desktop/test/packaged-app-paths.test.ts
git commit -m "Add the Windows desktop build platform and packaged executable path"
```

---

### Task 2: electron-builder Windows target, invocation and signing mode

**Files:**

- Modify: `apps/desktop/electron-builder.config.json`
- Modify: `apps/desktop/scripts/run-electron-builder.mjs`
- Modify: `apps/desktop/test/electron-builder-config.test.ts`
- Modify: `apps/desktop/package.json` (scripts, description), `turbo.json`

**Interfaces:**

- Consumes: Task 1 `createDesktopReleaseConfig(channel).iconFileName`.
- Produces (used by Tasks 10, 11, 13): scripts `desktop:build:windows` (`--win --x64 --publish never`), `dist:windows`, `package:windows` (`--win --dir --x64`), `start:windows`; Turbo tasks `@bb/desktop#desktop:build:windows` and `@bb/desktop#smoke:windows-processes` (script added in Task 10); resolved config `win`, `nsis`; signing plan modes `windows` | `unsigned` printed by `--print-config` runs through the `win` block only.

- [ ] **Step 1: Write the failing tests**

In `test/electron-builder-config.test.ts`:

1. Extend `electronBuilderConfigSchema` with

```ts
const winConfigSchema = z
  .object({
    azureSignOptions: z
      .object({
        certificateProfileName: z.string().min(1),
        codeSigningAccountName: z.string().min(1),
        endpoint: z.string().min(1),
        publisherName: z.string().min(1),
      })
      .optional(),
    icon: z.string().min(1),
    publisherName: z.string().min(1).optional(),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("x64")]),
          target: z.literal("nsis"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const nsisConfigSchema = z
  .object({
    allowToChangeInstallationDirectory: z.literal(true),
    createDesktopShortcut: z.literal(true),
    deleteAppDataOnUninstall: z.literal(false),
    oneClick: z.literal(false),
    perMachine: z.literal(false),
  })
  .passthrough();
```

and add `nsis: nsisConfigSchema, win: winConfigSchema` to the object.

2. Extend `signingEnvironmentKeys` with `"AZURE_CLIENT_ID"`, `"AZURE_CLIENT_SECRET"`, `"AZURE_SIGNING_ACCOUNT_NAME"`, `"AZURE_SIGNING_CERTIFICATE_PROFILE"`, `"AZURE_SIGNING_ENDPOINT"`, `"AZURE_TENANT_ID"`, `"WINDOWS_PUBLISHER_NAME"` (kept sorted).

3. Add tests:

```ts
it("packages a per-user Windows NSIS installer for x64", async () => {
  const configText = await readFile(
    resolve(desktopPackageRoot, "electron-builder.config.json"),
    "utf8",
  );
  const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

  expect(config.win.target).toEqual([{ arch: ["x64"], target: "nsis" }]);
  expect(config.nsis).toMatchObject({
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    deleteAppDataOnUninstall: false,
    oneClick: false,
    perMachine: false,
  });
  expect(config.artifactName).toBe("${productName}-${version}-${arch}.${ext}");
  await expect(
    access(resolve(desktopPackageRoot, config.win.icon)),
  ).resolves.toBeUndefined();
});

it("uses the nightly PNG icon for Windows builds", async () => {
  const { config } = await readResolvedConfig({
    BB_DESKTOP_RELEASE_CHANNEL: "nightly",
  });

  expect(config.win.icon).toBe("assets/icon-nightly.png");
});

it("keeps Windows builds unsigned and publisher-less without Azure signing secrets", async () => {
  const { config } = await readResolvedConfig({});

  expect(config.win).not.toHaveProperty("azureSignOptions");
  expect(config.win).not.toHaveProperty("publisherName");
});

it("signs Windows builds with Azure Trusted Signing when the secret set is complete", async () => {
  const { config } = await readResolvedConfig({
    AZURE_CLIENT_ID: "client",
    AZURE_CLIENT_SECRET: "secret",
    AZURE_SIGNING_ACCOUNT_NAME: "bb-signing",
    AZURE_SIGNING_CERTIFICATE_PROFILE: "bb-desktop",
    AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
    AZURE_TENANT_ID: "tenant",
    WINDOWS_PUBLISHER_NAME: "bb Desktop Publisher",
  });

  expect(config.win.azureSignOptions).toEqual({
    certificateProfileName: "bb-desktop",
    codeSigningAccountName: "bb-signing",
    endpoint: "https://weu.codesigning.azure.net",
    publisherName: "bb Desktop Publisher",
  });
  expect(config.win.publisherName).toBe("bb Desktop Publisher");
});

it("rejects partial Windows signing secret sets", async () => {
  const result = await runConfigScript({
    AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
    WINDOWS_PUBLISHER_NAME: "bb Desktop Publisher",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Incomplete Windows signing environment.");
  expect(result.stderr).toContain(
    "Present: AZURE_SIGNING_ENDPOINT, WINDOWS_PUBLISHER_NAME.",
  );
  expect(result.stderr).toContain(
    "Missing: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SIGNING_ACCOUNT_NAME, AZURE_SIGNING_CERTIFICATE_PROFILE.",
  );
});

it("leaves the macOS and Linux blocks untouched by the Windows target", async () => {
  const configText = await readFile(
    resolve(desktopPackageRoot, "electron-builder.config.json"),
    "utf8",
  );
  const baseConfig = electronBuilderConfigSchema.parse(JSON.parse(configText));
  const { config } = await readResolvedConfig({});

  expect(config.linux).toEqual({ ...baseConfig.linux, executableName: "bb" });
  expect(config.mac).toEqual({
    ...baseConfig.mac,
    icon: "assets/icon.icns",
    identity: undefined,
    notarize: false,
  });
});
```

The last assertion's `identity: undefined` relies on `toEqual` treating a missing key and `undefined` alike; keep it.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bb/desktop exec vitest run test/electron-builder-config.test.ts > <scratchpad>/task2-red.log 2>&1`
Expected: FAIL — schema parse fails on the missing `win`/`nsis` keys.

- [ ] **Step 3: Configuration**

`electron-builder.config.json` — insert after the `"linux"` block:

```json
  "win": {
    "icon": "assets/icon.png",
    "target": [{ "target": "nsis", "arch": ["x64"] }]
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "deleteAppDataOnUninstall": false
  },
```

- [ ] **Step 4: Script — signing plan, invocation, overrides**

In `run-electron-builder.mjs`:

```js
import { createRequire } from "node:module";

const windowsSigningEnvironmentKeys = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SIGNING_ACCOUNT_NAME",
  "AZURE_SIGNING_CERTIFICATE_PROFILE",
  "AZURE_SIGNING_ENDPOINT",
  "WINDOWS_PUBLISHER_NAME",
];

function createWindowsSigningPlan(env) {
  const presentKeys = presentEnvironmentKeys(
    windowsSigningEnvironmentKeys,
    env,
  );
  const missingKeys = missingEnvironmentKeys(
    windowsSigningEnvironmentKeys,
    env,
  );

  if (presentKeys.length > 0 && missingKeys.length > 0) {
    throw new Error(
      `Incomplete Windows signing environment. Present: ${formatEnvironmentKeyList(
        presentKeys,
      )}. Missing: ${formatEnvironmentKeyList(
        missingKeys,
      )}. Set all required keys for Azure Trusted Signing or unset all of them for an unsigned build.`,
    );
  }

  if (missingKeys.length === 0) {
    return {
      mode: "windows",
      azureSignOptions: {
        certificateProfileName: env.AZURE_SIGNING_CERTIFICATE_PROFILE.trim(),
        codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT_NAME.trim(),
        endpoint: env.AZURE_SIGNING_ENDPOINT.trim(),
        publisherName: env.WINDOWS_PUBLISHER_NAME.trim(),
      },
      publisherName: env.WINDOWS_PUBLISHER_NAME.trim(),
    };
  }

  return { mode: "unsigned", azureSignOptions: null, publisherName: null };
}

function logWindowsSigningPlan(windowsSigningPlan) {
  if (windowsSigningPlan.mode === "windows") {
    console.log(
      `Windows code signing enabled with Azure Trusted Signing publisher "${windowsSigningPlan.publisherName}".`,
    );
    return;
  }
  logWarning(
    "Windows signing skipped: no Azure Trusted Signing secrets found. The installer will be unsigned and SmartScreen will warn on first launch.",
  );
}

function resolveElectronBuilderInvocation(platform) {
  if (platform === "win32") {
    const requireFromScript = createRequire(import.meta.url);
    return {
      command: process.execPath,
      args: [requireFromScript.resolve("electron-builder/cli.js")],
    };
  }
  return { command: electronBuilderBin, args: [] };
}
```

`resolveElectronBuilderConfig` gains, after the `config.linux = …` assignment:

```js
const windowsSigningPlan = createWindowsSigningPlan(env);
const win = {
  ...config.win,
  icon: "assets/" + releaseConfig.iconFileName,
};
delete win.azureSignOptions;
delete win.publisherName;
if (windowsSigningPlan.mode === "windows") {
  win.azureSignOptions = windowsSigningPlan.azureSignOptions;
  win.publisherName = windowsSigningPlan.publisherName;
}
config.win = win;
```

and returns `{ config, releaseChannel, signingPlan, windowsSigningPlan }`. The Present/Missing order in the thrown message follows `windowsSigningEnvironmentKeys` order — the test above lists `AZURE_SIGNING_ENDPOINT, WINDOWS_PUBLISHER_NAME` as present and the other five in array order as missing; keep the array in exactly the order shown so the messages match.

`runElectronBuilder(args, signingPlan)` becomes:

```js
async function runElectronBuilder(args, signingPlan) {
  const invocation = resolveElectronBuilderInvocation(process.platform);
  const child = spawn(
    invocation.command,
    [...invocation.args, "--config", generatedConfigPath, ...args],
    {
      cwd: desktopPackageRoot,
      env: createElectronBuilderEnv(signingPlan),
      stdio: "inherit",
    },
  );
```

`main()` logging: after the existing Linux-only branch add a Windows branch so a `--win`-only build logs the Windows plan and skips the macOS one:

```js
if (
  electronBuilderArgs.includes("--linux") &&
  !electronBuilderArgs.includes("--mac")
) {
  console.log("macOS signing is not applicable for Linux-only builds.");
} else if (
  electronBuilderArgs.includes("--win") &&
  !electronBuilderArgs.includes("--mac")
) {
  logWindowsSigningPlan(windowsSigningPlan);
} else {
  logSigningPlan(signingPlan);
}
```

(`windowsSigningPlan` comes from the destructured `resolveElectronBuilderConfig` result.) The `--print-config` path is unchanged and prints the resolved `win` block.

- [ ] **Step 5: Scripts and Turbo**

`apps/desktop/package.json`: `"description": "macOS, Linux and Windows Electron shell for bb"`; add scripts (alphabetical position beside their siblings):

```json
    "desktop:build:windows": "pnpm run build && node scripts/run-electron-builder.mjs --win --x64 --publish never",
    "dist:windows": "pnpm run prepare-runtime && pnpm run desktop:build:windows",
    "package:windows": "pnpm run prepare-runtime && pnpm run build && node scripts/run-electron-builder.mjs --win --dir --x64",
    "smoke:windows-processes": "node scripts/smoke-windows-processes.mjs",
    "start:windows": "pnpm run package:windows && node scripts/run-packaged-app.mjs",
```

`turbo.json` after `@bb/desktop#desktop:build:linux`:

```json
    "@bb/desktop#desktop:build:windows": {
      "dependsOn": ["bb-app#build", "@bb/desktop#build"],
      "cache": false,
      "outputs": ["release/**"],
      "passThroughEnv": ["*"]
    },
```

and after `@bb/desktop#smoke:windows-conpty`:

```json
    "@bb/desktop#smoke:windows-processes": {
      "cache": false,
      "outputs": [],
      "passThroughEnv": ["*"]
    },
```

- [ ] **Step 6: Run to verify pass, then a real unpacked build**

Run: `pnpm --filter @bb/desktop exec vitest run test/electron-builder-config.test.ts > <scratchpad>/task2-green.log 2>&1`
Expected: PASS (all existing + 6 new).

Run on the reference desktop: `pnpm --filter @bb/desktop run package:windows > <scratchpad>/task2-package.log 2>&1` (first run downloads `winCodeSign` into `%LOCALAPPDATA%\electron-builder\Cache`; allow up to 10 minutes). Expected: exit 0, `apps/desktop/release/win-unpacked/bb.exe` exists, `release/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty.node` exists; the log shows `afterPack` running `prebuild-install` for better-sqlite3 (`--platform=win32`). Record the exit code and the two `ls` results in the report; if `afterPack` fails on the ConPTY assertion, that is Task 3's work — report it, do not fix here.

- [ ] **Step 7: Typecheck, format, commit**

Run: `pnpm exec turbo run typecheck --filter=@bb/desktop`; `pnpm exec oxfmt apps/desktop/electron-builder.config.json apps/desktop/scripts/run-electron-builder.mjs apps/desktop/test/electron-builder-config.test.ts apps/desktop/package.json turbo.json`

```bash
git add apps/desktop/electron-builder.config.json apps/desktop/scripts/run-electron-builder.mjs apps/desktop/test/electron-builder-config.test.ts apps/desktop/package.json turbo.json
git commit -m "Add the Windows NSIS target, native electron-builder invocation and Azure signing mode"
```

---

### Task 3: Native module staging for Windows

**Files:**

- Modify: `apps/desktop/scripts/prepare-native-modules.cjs`
- Modify: `apps/desktop/test/electron-builder-config.test.ts`

**Interfaces:**

- Consumes: `preparePackagedNativeModules(appOutDir, { arch, electronVersion?, platform })`, `parseStandaloneArguments`.
- Produces: on `platform === "win32"` a thrown `Error` naming the first missing ConPTY file; `module.exports.NODE_PTY_WINDOWS_PREBUILD_RELATIVE_PATHS`.

- [ ] **Step 1: Write the failing tests**

Add to `electron-builder-config.test.ts` a second runner that forwards extra arguments:

```ts
type RunNativePrepScriptWithArgs = (
  appOutDir: string,
  extraArguments: string[],
) => Promise<ScriptRunResult>;

const runNativePrepScriptWithArgs: RunNativePrepScriptWithArgs = async (
  appOutDir,
  extraArguments,
) => {
  const child = spawn(
    process.execPath,
    ["scripts/prepare-native-modules.cjs", appOutDir, ...extraArguments],
    { cwd: desktopPackageRoot },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });
  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });
  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};
```

and the tests:

```ts
it("passes win32 x64 through to better-sqlite3 prebuild-install", () => {
  expect(
    nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
      arch: "x64",
      electronVersion: "41.7.0",
      platform: "win32",
    }),
  ).toEqual([
    "--runtime=electron",
    "--target=41.7.0",
    "--arch=x64",
    "--platform=win32",
  ]);
});

it("accepts a Windows app output whose node-pty carries the ConPTY prebuild", async () => {
  const appOutDir = await mkdtemp(
    resolve(tmpdir(), "bb-desktop-native-modules-win-"),
  );
  const nodePtyPackageDir = resolve(
    appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
  );
  try {
    await mkdir(resolve(nodePtyPackageDir, "lib"), { recursive: true });
    await writeFile(
      resolve(nodePtyPackageDir, "lib", "unixTerminal.js"),
      "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
    );
    const prebuildDir = resolve(nodePtyPackageDir, "prebuilds", "win32-x64");
    await mkdir(resolve(prebuildDir, "conpty"), { recursive: true });
    for (const relativePath of [
      "conpty.node",
      "conpty_console_list.node",
      "conpty/conpty.dll",
      "conpty/OpenConsole.exe",
    ]) {
      await writeFile(resolve(prebuildDir, relativePath), "binary");
    }
    const result = await runNativePrepScriptWithArgs(appOutDir, [
      "--platform=win32",
      "--arch=x64",
    ]);

    expect(result.exitCode).toBe(0);
  } finally {
    await rm(appOutDir, { force: true, recursive: true });
  }
});

it("refuses a Windows app output whose ConPTY prebuild is incomplete", async () => {
  const appOutDir = await mkdtemp(
    resolve(tmpdir(), "bb-desktop-native-modules-win-"),
  );
  const nodePtyPackageDir = resolve(
    appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
  );
  try {
    await mkdir(resolve(nodePtyPackageDir, "lib"), { recursive: true });
    await writeFile(
      resolve(nodePtyPackageDir, "lib", "unixTerminal.js"),
      "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
    );
    const prebuildDir = resolve(nodePtyPackageDir, "prebuilds", "win32-x64");
    await mkdir(resolve(prebuildDir, "conpty"), { recursive: true });
    await writeFile(resolve(prebuildDir, "conpty.node"), "binary");
    await writeFile(resolve(prebuildDir, "conpty_console_list.node"), "binary");
    await writeFile(resolve(prebuildDir, "conpty", "conpty.dll"), "binary");
    const result = await runNativePrepScriptWithArgs(appOutDir, [
      "--platform=win32",
      "--arch=x64",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Packaged node-pty is missing");
    expect(result.stderr).toContain(
      join("prebuilds", "win32-x64", "conpty", "OpenConsole.exe"),
    );
  } finally {
    await rm(appOutDir, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bb/desktop exec vitest run test/electron-builder-config.test.ts -t "ConPTY" > <scratchpad>/task3-red.log 2>&1`
Expected: the "refuses" test FAILS (exit code 0, nothing asserted the files), the "accepts" test passes trivially; the win32 prebuild-arguments test passes already (record that; it is a regression guard).

- [ ] **Step 3: Implement**

In `prepare-native-modules.cjs` add `const { access } = require("node:fs/promises")` to the existing import line and:

```js
const NODE_PTY_WINDOWS_PREBUILD_RELATIVE_PATHS = [
  "conpty.node",
  "conpty_console_list.node",
  path.join("conpty", "conpty.dll"),
  path.join("conpty", "OpenConsole.exe"),
];

async function assertNodePtyWindowsPrebuild(packageDirectory, arch) {
  const prebuildDirectory = path.join(
    packageDirectory,
    "prebuilds",
    `win32-${arch}`,
  );
  for (const relativePath of NODE_PTY_WINDOWS_PREBUILD_RELATIVE_PATHS) {
    const filePath = path.join(prebuildDirectory, relativePath);
    try {
      await access(filePath);
    } catch {
      throw new Error(
        `Packaged node-pty is missing ${path.join("prebuilds", `win32-${arch}`, relativePath)} under ${packageDirectory}; the ConPTY prebuild must ship outside asar.`,
      );
    }
  }
}
```

In `preparePackagedNativeModules`, after `await Promise.all(nodePtyDirectories.map(prepareNodePtyPackageDirectory));`:

```js
if (options.platform === "win32") {
  await Promise.all(
    nodePtyDirectories.map((packageDirectory) =>
      assertNodePtyWindowsPrebuild(packageDirectory, options.arch),
    ),
  );
}
```

Export `NODE_PTY_WINDOWS_PREBUILD_RELATIVE_PATHS` beside the other exports.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bb/desktop exec vitest run test/electron-builder-config.test.ts > <scratchpad>/task3-green.log 2>&1`
Expected: PASS. Then re-run `pnpm --filter @bb/desktop run package:windows > <scratchpad>/task3-package.log 2>&1` on the reference desktop and confirm exit 0 with the assertion passing against the real prebuild; list `release/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node` and record its size.

- [ ] **Step 5: Commit**

```bash
pnpm exec oxfmt apps/desktop/scripts/prepare-native-modules.cjs apps/desktop/test/electron-builder-config.test.ts
git add apps/desktop/scripts/prepare-native-modules.cjs apps/desktop/test/electron-builder-config.test.ts
git commit -m "Assert the ConPTY prebuild ships in Windows desktop packages"
```

---

### Task 4: Windows update support and app identity

**Files:**

- Modify: `apps/desktop/src/desktop-update-provider.ts`
- Modify: `apps/desktop/test/desktop-update-provider.test.ts`, `apps/desktop/test/electron-builder-config.test.ts`

**Interfaces:**

- Consumes: Task 1 (`updateMetadataFileNames.windows`).
- Produces (used by Tasks 7, 13): `resolveDesktopUpdateSupport({ platform: "windows" })` → `{ autoUpdate: true, versionCheck: true }`; `DesktopReleaseInfo.appUserModelId: "dev.bb.desktop" | "dev.bb.desktop.nightly"`.

- [ ] **Step 1: Write the failing tests**

Replace the test `"disables update checks on Windows until the Windows feed ships"` with:

```ts
it("enables both update paths on Windows now that the NSIS feed ships", () => {
  expect(
    resolveDesktopUpdateSupport({
      canReplaceAppImage: () => {
        throw new Error("Windows must not consult the AppImage check");
      },
      env: {},
      platform: "windows",
    }),
  ).toEqual({ autoUpdate: true, versionCheck: true });
});

it("points the Windows JSON feed at the shared release tag", () => {
  expect(createDesktopUpdateFeedUrl("windows")).toBe(
    "https://github.com/get-bb/bb/releases/download/desktop-latest/desktop-version-windows.json",
  );
});
```

and a `createDesktopReleaseInfo` test:

```ts
describe("desktop release info", () => {
  it("carries the app user model id for each channel", () => {
    expect(createDesktopReleaseInfo("latest").appUserModelId).toBe(
      "dev.bb.desktop",
    );
    expect(createDesktopReleaseInfo("nightly").appUserModelId).toBe(
      "dev.bb.desktop.nightly",
    );
  });
});
```

In `electron-builder-config.test.ts`, extend `"creates a separate nightly app identity and update feed"` with `expect(config.appId).toBe(nightlyRelease.appUserModelId);` and add to the stable resolved-config test (`"signs local builds via keychain auto-discovery…"`) `expect(config.appId).toBe(createDesktopReleaseInfo("latest").appUserModelId);`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bb/desktop exec vitest run test/desktop-update-provider.test.ts`
Expected: FAIL — the windows arm returns `{ autoUpdate: false, versionCheck: false }`; `appUserModelId` is undefined.

- [ ] **Step 3: Implement**

`desktop-update-provider.ts`:

```ts
interface DesktopReleaseInfo {
  applicationName: "bb" | "bb Nightly";
  appUserModelId: "dev.bb.desktop" | "dev.bb.desktop.nightly";
  channel: DesktopReleaseChannel;
  iconFileName: "icon.png" | "icon-nightly.png";
  releaseTag: "desktop-latest" | "desktop-nightly";
  updateReleaseBaseUrl: string;
}
```

with `appUserModelId: nightly ? "dev.bb.desktop.nightly" : "dev.bb.desktop"` in `createDesktopReleaseInfo`, and

```ts
if (args.platform === "windows") {
  return { autoUpdate: true, versionCheck: true };
}
```

- [ ] **Step 4: Run to verify pass, typecheck, commit**

Run: `pnpm --filter @bb/desktop exec vitest run test/desktop-update-provider.test.ts test/electron-builder-config.test.ts > <scratchpad>/task4-green.log 2>&1`; `pnpm exec turbo run typecheck --filter=@bb/desktop`

```bash
pnpm exec oxfmt apps/desktop/src/desktop-update-provider.ts apps/desktop/test/desktop-update-provider.test.ts apps/desktop/test/electron-builder-config.test.ts
git add apps/desktop/src/desktop-update-provider.ts apps/desktop/test
git commit -m "Enable Windows desktop update checks and expose the app user model id"
```

---

### Task 5: `bb-process.ts` Windows runtime arm

**Files:**

- Modify: `apps/desktop/src/bb-process.ts`
- Modify: `apps/desktop/test/bb-process.test.ts`
- Modify: `apps/desktop/package.json` (dependency), `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `terminateProcessTree`, `TerminateProcessTreeChild`, `SkippedProcessEvent` from `@bb/process-utils` (Phase 2).
- Produces (used by Task 7's `main.ts` wiring): `StartBbAppProcessArgs.platform?: NodeJS.Platform`; `BB_DESKTOP_PARENT_PID_ENV_NAME = "BB_DESKTOP_PARENT_PID"` exported; `StopBbAppProcessArgs` unchanged; on win32 `stop()` never sends a signal.

- [ ] **Step 1: Adopt the donor's Windows test fixes and write the failing tests**

In `test/bb-process.test.ts` (donor commit 2e8d2a957 shape):

1. `"imports the bridge from the child AppImage mount"` → `it.skipIf(process.platform !== "linux")(…)` and delete the in-test `if (process.platform !== "linux") return;`.
2. `"escalates to SIGKILL when the bridge ignores SIGTERM"` → `it.skipIf(process.platform === "win32")(…)` and pass `platform: "linux"` to `startBbAppProcess` there (the POSIX stop path is what the test asserts).
3. New tests:

```ts
it("hides the console window and hands the parent pid to a Windows runtime", () => {
  const launch = createBbAppProcessLaunch({
    bridgePath: "C:\\bb\\bridge.mjs",
    env: { PATH: "C:\\Windows" },
    parentPid: 4242,
    platform: "win32",
    runtime: {
      executablePath: "C:\\bb\\bb.exe",
      kind: "direct",
      mode: "electron-node",
    },
  });

  expect(launch.env.BB_DESKTOP_PARENT_PID).toBe("4242");
  expect(launch.spawnOptions).toEqual({ windowsHide: true });
});

it("leaves POSIX launches without a parent pid or hidden-window option", () => {
  const launch = createBbAppProcessLaunch({
    bridgePath: "/opt/bb/bridge.mjs",
    env: { PATH: "/usr/bin" },
    parentPid: 4242,
    platform: "linux",
    runtime: {
      executablePath: "/opt/bb/bb",
      kind: "direct",
      mode: "electron-node",
    },
  });

  expect(launch.env).not.toHaveProperty("BB_DESKTOP_PARENT_PID");
  expect(launch.spawnOptions).toEqual({});
});

it.runIf(process.platform === "win32")(
  "stops the whole Windows process tree without the SIGTERM handshake",
  async () => {
    const script = await createTempScript({
      contents: `
import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore", windowsHide: true });
process.stdout.write(\`grandchild=\${grandchild.pid}\\n\`);
process.stdout.write("ready\\n");
setInterval(() => undefined, 1000);
`,
    });
    const processEntry = startBbAppProcess({
      bridgePath: script.path,
      cwd: script.root,
      env: process.env,
      logLineLimit: 20,
      platform: "win32",
      runtime: {
        executablePath: process.execPath,
        kind: "direct",
        mode: "node",
      },
    });
    processes.push(processEntry);
    await waitForLog({ process: processEntry, text: "ready" });
    const grandchildPid = Number(
      /grandchild=(\d+)/u.exec(processEntry.logs.text())?.[1],
    );
    expect(Number.isInteger(grandchildPid)).toBe(true);
    const killSpy = vi.spyOn(processEntry.childProcess, "kill");

    await processEntry.stop({
      killSignal: "SIGKILL",
      killTimeoutMs: 5_000,
      signal: "SIGTERM",
      timeoutMs: 5_000,
    });

    const exit = await processEntry.exit;
    expect(exit.code !== null || exit.signal !== null).toBe(true);
    expect(killSpy.mock.calls.some(([signal]) => signal === "SIGTERM")).toBe(
      false,
    );
    expect(isProcessAlive(grandchildPid)).toBe(false);
  },
);
```

with a helper in the test file:

```ts
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

The exit shape depends on which step ended the leader: `taskkill /T` (no `/F`) yields `{ code: 1, signal: null }` (measured in donor commit 2e8d2a957), while `terminateProcessTree`'s force step calls `child.kill("SIGKILL")` through the held handle (`packages/process-utils/src/windows-process-stop.ts:243`) and Node then synthesises `{ code: null, signal: "SIGKILL" }`; the test accepts either and the report records the observed shape. The `killSpy` assertion says the POSIX `SIGTERM` handshake never ran.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bb/desktop exec vitest run test/bb-process.test.ts > <scratchpad>/task5-red.log 2>&1`
Expected: FAIL — `parentPid`/`platform` unknown, `spawnOptions` undefined, and on the reference desktop the tree test fails because `stop()` sends SIGTERM and the grandchild survives.

- [ ] **Step 3: Add the dependency**

In `apps/desktop/package.json` `dependencies` add `"@bb/process-utils": "workspace:*"` (sorted), run `pnpm install --prefer-offline` from the repo root, confirm `pnpm-lock.yaml` changed only by the new importer link (`git diff --stat pnpm-lock.yaml`).

- [ ] **Step 4: Implement**

`bb-process.ts` changes:

```ts
import {
  terminateProcessTree,
  type SkippedProcessEvent,
} from "@bb/process-utils";

export const BB_DESKTOP_PARENT_PID_ENV_NAME = "BB_DESKTOP_PARENT_PID";
const WINDOWS_RUNTIME_STOP_GRACE_MS = 1_000;

interface StartBbAppProcessArgs {
  bridgePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logLineLimit: number;
  platform?: NodeJS.Platform;
  runtime: BbAppProcessRuntime;
}

interface CreateBbAppProcessLaunchArgs {
  bridgePath: string;
  env: NodeJS.ProcessEnv;
  parentPid?: number;
  platform?: NodeJS.Platform;
  runtime: BbAppProcessRuntime;
}

interface BbAppProcessSpawnOptions {
  windowsHide?: true;
}

interface BbAppProcessLaunch {
  args: string[];
  env: NodeJS.ProcessEnv;
  executablePath: string;
  spawnOptions: BbAppProcessSpawnOptions;
}
```

`createBbAppProcessLaunch`:

```ts
export function createBbAppProcessLaunch(
  args: CreateBbAppProcessLaunchArgs,
): BbAppProcessLaunch {
  const platform = args.platform ?? process.platform;
  const baseEnv = createBbAppProcessEnv({
    env: args.env,
    runtimeMode: args.runtime.mode,
  });
  const env =
    platform === "win32" && args.parentPid !== undefined
      ? { ...baseEnv, [BB_DESKTOP_PARENT_PID_ENV_NAME]: String(args.parentPid) }
      : baseEnv;
  const spawnOptions: BbAppProcessSpawnOptions =
    platform === "win32" ? { windowsHide: true } : {};
  if (args.runtime.kind === "direct") {
    return {
      args: [args.bridgePath],
      env,
      executablePath: args.runtime.executablePath,
      spawnOptions,
    };
  }
  … (AppImage branch unchanged, plus `spawnOptions`)
```

`startBbAppProcess`:

```ts
const platform = args.platform ?? process.platform;
const launch = createBbAppProcessLaunch({
  bridgePath: args.bridgePath,
  env: args.env,
  parentPid: process.pid,
  platform,
  runtime: args.runtime,
});
const childProcess = spawn(launch.executablePath, launch.args, {
  cwd: args.cwd,
  detached: args.runtime.kind === "appimage",
  env: launch.env,
  stdio: ["ignore", "pipe", "pipe"],
  ...launch.spawnOptions,
});
```

`stop`:

```ts
    async stop(stopArgs) {
      if (hasProcessExited(childProcess)) {
        return;
      }
      if (platform === "win32") {
        await terminateProcessTree({
          child: childProcess,
          graceMs: WINDOWS_RUNTIME_STOP_GRACE_MS,
          onSkippedProcess(event: SkippedProcessEvent) {
            logs.append(
              `bb desktop left pid ${String(event.pid)} alone: ${event.reason}\n`,
            );
          },
          platform: "win32",
        });
        await waitForProcessExitWithTimeout({
          childProcess,
          timeoutMs: stopArgs.killTimeoutMs,
        });
        return;
      }
      childProcess.kill(stopArgs.signal);
      … (unchanged)
```

`SkippedProcessEvent` (`packages/process-utils/src/windows-process-stop.ts:18`) is `{ pid: number; reason: "pid-reused"; expectedCreationDate: string | null; observedCreationDate: string | null }`, so the log line reads `bb desktop left pid <pid> alone: pid-reused`.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @bb/desktop exec vitest run test/bb-process.test.ts > <scratchpad>/task5-green.log 2>&1`
Expected: PASS on the reference desktop (the Linux-only tests skip with their names); the tree test proves the grandchild is gone.

- [ ] **Step 6: Typecheck, format, commit**

Run: `pnpm exec turbo run typecheck --filter=@bb/desktop`; `pnpm exec oxfmt apps/desktop/src/bb-process.ts apps/desktop/test/bb-process.test.ts apps/desktop/package.json`

```bash
git add apps/desktop/src/bb-process.ts apps/desktop/test/bb-process.test.ts apps/desktop/package.json pnpm-lock.yaml
git commit -m "Supervise the Windows bb-app runtime as a hidden child and stop its tree by identity"
```

---

### Task 6: `bb-app` parent-PID watchdog

**Files:**

- Create: `packages/bb-app/src/parent-watchdog.ts`, `packages/bb-app/test/parent-watchdog.test.ts`
- Modify: `packages/bb-app/src/launcher.ts` (`runBbApp`, around the `installTerminationSignalForwarding` call at :3535 and the `finally` at :3612)

**Interfaces:**

- Consumes: Task 5's `BB_DESKTOP_PARENT_PID` (string decimal pid) in the runtime env.
- Produces:
  - `resolveParentProcessPid({ env, platform }): number | null` — win32 only; `null` when unset, empty, non-integer or `<= 0`.
  - `startParentProcessWatchdog({ env, platform, intervalMs, isProcessAlive?, onParentExit }): () => void` — returns a `stop` function; schedules nothing when the pid is `null`.

- [ ] **Step 1: Write the failing tests**

`packages/bb-app/test/parent-watchdog.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveParentProcessPid,
  startParentProcessWatchdog,
} from "../src/parent-watchdog.js";

describe("resolveParentProcessPid", () => {
  it("reads the desktop parent pid on Windows", () => {
    expect(
      resolveParentProcessPid({
        env: { BB_DESKTOP_PARENT_PID: "4242" },
        platform: "win32",
      }),
    ).toBe(4242);
  });

  it("ignores the variable on POSIX where the desktop uses signals", () => {
    expect(
      resolveParentProcessPid({
        env: { BB_DESKTOP_PARENT_PID: "4242" },
        platform: "linux",
      }),
    ).toBeNull();
    expect(
      resolveParentProcessPid({
        env: { BB_DESKTOP_PARENT_PID: "4242" },
        platform: "darwin",
      }),
    ).toBeNull();
  });

  it("rejects malformed pids", () => {
    for (const value of ["", " ", "0", "-1", "12.5", "abc"]) {
      expect(
        resolveParentProcessPid({
          env: { BB_DESKTOP_PARENT_PID: value },
          platform: "win32",
        }),
      ).toBeNull();
    }
    expect(resolveParentProcessPid({ env: {}, platform: "win32" })).toBeNull();
  });
});

describe("startParentProcessWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once when the parent disappears and stops polling", () => {
    let alive = true;
    const checked: number[] = [];
    const onParentExit = vi.fn();
    const stop = startParentProcessWatchdog({
      env: { BB_DESKTOP_PARENT_PID: "4242" },
      intervalMs: 2_000,
      isProcessAlive(pid) {
        checked.push(pid);
        return alive;
      },
      onParentExit,
      platform: "win32",
    });

    vi.advanceTimersByTime(2_000);
    expect(onParentExit).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(2_000);
    expect(onParentExit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6_000);
    expect(onParentExit).toHaveBeenCalledTimes(1);
    expect(checked).toEqual([4242, 4242]);
    stop();
  });

  it("stops checking after stop() is called", () => {
    const isProcessAlive = vi.fn(() => false);
    const onParentExit = vi.fn();
    const stop = startParentProcessWatchdog({
      env: { BB_DESKTOP_PARENT_PID: "4242" },
      intervalMs: 2_000,
      isProcessAlive,
      onParentExit,
      platform: "win32",
    });

    stop();
    vi.advanceTimersByTime(10_000);
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(onParentExit).not.toHaveBeenCalled();
  });

  it("schedules nothing without a Windows parent pid", () => {
    const isProcessAlive = vi.fn(() => false);
    const stop = startParentProcessWatchdog({
      env: { BB_DESKTOP_PARENT_PID: "4242" },
      intervalMs: 2_000,
      isProcessAlive,
      onParentExit: vi.fn(),
      platform: "linux",
    });

    vi.advanceTimersByTime(10_000);
    expect(isProcessAlive).not.toHaveBeenCalled();
    stop();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter bb-app exec vitest run test/parent-watchdog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/bb-app/src/parent-watchdog.ts`:

```ts
const PARENT_PID_ENV_NAME = "BB_DESKTOP_PARENT_PID";

interface ResolveParentProcessPidArgs {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

interface StartParentProcessWatchdogArgs {
  env: NodeJS.ProcessEnv;
  intervalMs: number;
  isProcessAlive?: (pid: number) => boolean;
  onParentExit: () => void;
  platform: NodeJS.Platform;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function resolveParentProcessPid(
  args: ResolveParentProcessPidArgs,
): number | null {
  if (args.platform !== "win32") {
    return null;
  }
  const raw = args.env[PARENT_PID_ENV_NAME]?.trim();
  if (raw === undefined || !/^\d+$/u.test(raw)) {
    return null;
  }
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function startParentProcessWatchdog(
  args: StartParentProcessWatchdogArgs,
): () => void {
  const parentPid = resolveParentProcessPid({
    env: args.env,
    platform: args.platform,
  });
  if (parentPid === null) {
    return () => undefined;
  }
  const isProcessAlive = args.isProcessAlive ?? defaultIsProcessAlive;
  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) {
      return;
    }
    clearInterval(timer);
    args.onParentExit();
  }, args.intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
```

`launcher.ts` `runBbApp`: import `startParentProcessWatchdog` from `./parent-watchdog.js`; directly after the `const removeSignalForwarding = installTerminationSignalForwarding(…)` statement inside `runBbApp` add

```ts
const stopParentProcessWatchdog = startParentProcessWatchdog({
  env: runtime.env,
  intervalMs: 2_000,
  onParentExit() {
    log(dim("●"), "Desktop parent process exited; shutting down");
    void shutdown("SIGTERM");
  },
  platform: process.platform,
});
```

and in the same function's `finally` block, before `removeSignalForwarding();`, add `stopParentProcessWatchdog();`. `runBbApp` is the launcher's composition root, so `process.platform` is read there and nowhere else in this task. Verify `log`, `dim` and `shutdown` are in scope at that point (they are used a few lines below for the ready banner and at :3610).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter bb-app exec vitest run test/parent-watchdog.test.ts` → PASS (6 tests). Then `pnpm exec turbo run typecheck test --filter=bb-app > <scratchpad>/task6-bb-app.log 2>&1` (the tarball smoke test in this package is long; pipe it) → PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec oxfmt packages/bb-app/src/parent-watchdog.ts packages/bb-app/src/launcher.ts packages/bb-app/test/parent-watchdog.test.ts
git add packages/bb-app/src/parent-watchdog.ts packages/bb-app/src/launcher.ts packages/bb-app/test/parent-watchdog.test.ts
git commit -m "Shut bb-app down when its Windows desktop parent disappears"
```

---

### Task 7: Tray, quit policy, session end, quit-request file, app user model id

**Files:**

- Create: `apps/desktop/src/desktop-tray.ts`, `apps/desktop/src/desktop-runtime-policy.ts`, `apps/desktop/src/desktop-quit-request.ts`
- Create: `apps/desktop/test/desktop-tray.test.ts`, `apps/desktop/test/desktop-runtime-policy.test.ts`, `apps/desktop/test/desktop-quit-request.test.ts`
- Modify: `apps/desktop/src/main.ts` (imports :1-20 and the desktop module imports; `second-instance`/`window-all-closed` at :2039-2053; `finishQuit` at :1606-1617; `startOwnedRuntime` at :1751; the startup sequence around `app.setName` :2027-2031 and after `createDesktopWindowFactory` :2397-2422)

**Interfaces:**

- Consumes: Task 4 `DESKTOP_RELEASE_INFO.appUserModelId`; Task 5 `startBbAppProcess({ platform })`.
- Produces (used by Tasks 10, 13):
  - `desktop-runtime-policy.ts`: `shouldQuitOnWindowAllClosed({ platform }): boolean`, `shouldHandleSessionEnd({ platform }): boolean`.
  - `desktop-tray.ts`: `interface DesktopTrayHandle { destroy(): void; on(event: "click", listener: () => void): void; setContextMenu(menu: unknown): void; setToolTip(tooltip: string): void }`, `interface DesktopTrayMenuArgs { onQuit(): void; onShow(): void; quitLabel: string; showLabel: string }`, `interface DesktopTrayDeps { buildMenu(args: DesktopTrayMenuArgs): unknown; createIcon(imagePath: string): DesktopTrayHandle }`, `shouldCreateTrayIcon({ platform })`, `createDesktopTray({ applicationName, deps, iconPath, onQuit, onShow, platform }): DesktopTrayHandle | null`.
  - `desktop-quit-request.ts`: `DESKTOP_QUIT_REQUEST_FILE_ENV_NAME = "BB_DESKTOP_QUIT_REQUEST_FILE"`, `resolveDesktopQuitRequestFile({ env, platform }): string | null`, `watchDesktopQuitRequestFile({ fileExists?, filePath, onRequest, pollMs }): { stop(): void }`.

- [ ] **Step 1: Write the failing tests**

`test/desktop-runtime-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  shouldHandleSessionEnd,
  shouldQuitOnWindowAllClosed,
} from "../src/desktop-runtime-policy.js";

describe("shouldQuitOnWindowAllClosed", () => {
  it("keeps macOS running with no windows", () => {
    expect(shouldQuitOnWindowAllClosed({ platform: "darwin" })).toBe(false);
  });

  it("keeps Windows running with no windows so the tray owns the lifetime", () => {
    expect(shouldQuitOnWindowAllClosed({ platform: "win32" })).toBe(false);
  });

  it("still quits Linux with no windows", () => {
    expect(shouldQuitOnWindowAllClosed({ platform: "linux" })).toBe(true);
  });
});

describe("shouldHandleSessionEnd", () => {
  it("handles the Windows logoff event only on Windows", () => {
    expect(shouldHandleSessionEnd({ platform: "win32" })).toBe(true);
    expect(shouldHandleSessionEnd({ platform: "darwin" })).toBe(false);
    expect(shouldHandleSessionEnd({ platform: "linux" })).toBe(false);
  });
});
```

`test/desktop-tray.test.ts` (donor shape with the label args):

```ts
import { describe, expect, it } from "vitest";
import {
  createDesktopTray,
  shouldCreateTrayIcon,
  type DesktopTrayDeps,
  type DesktopTrayHandle,
  type DesktopTrayMenuArgs,
} from "../src/desktop-tray.js";

interface FakeTray extends DesktopTrayHandle {
  clicks: Array<() => void>;
  destroyed: number;
  menus: unknown[];
  tooltips: string[];
}

function createFakeTray(): FakeTray {
  const tray: FakeTray = {
    clicks: [],
    destroyed: 0,
    menus: [],
    tooltips: [],
    destroy() {
      tray.destroyed += 1;
    },
    on(event, listener) {
      expect(event).toBe("click");
      tray.clicks.push(listener);
    },
    setContextMenu(menu) {
      tray.menus.push(menu);
    },
    setToolTip(tooltip) {
      tray.tooltips.push(tooltip);
    },
  };
  return tray;
}

function createDeps(fake: FakeTray): DesktopTrayDeps & {
  builtMenus: DesktopTrayMenuArgs[];
  createdIcons: string[];
} {
  const builtMenus: DesktopTrayMenuArgs[] = [];
  const createdIcons: string[] = [];
  return {
    builtMenus,
    createdIcons,
    buildMenu(args) {
      builtMenus.push(args);
      return { kind: "fake-menu" };
    },
    createIcon(imagePath) {
      createdIcons.push(imagePath);
      return fake;
    },
  };
}

describe("shouldCreateTrayIcon", () => {
  it("creates a tray icon only on Windows", () => {
    expect(shouldCreateTrayIcon({ platform: "win32" })).toBe(true);
    expect(shouldCreateTrayIcon({ platform: "darwin" })).toBe(false);
    expect(shouldCreateTrayIcon({ platform: "linux" })).toBe(false);
  });
});

describe("createDesktopTray", () => {
  it("returns null off Windows without touching the deps", () => {
    const fake = createFakeTray();
    const deps = createDeps(fake);

    expect(
      createDesktopTray({
        applicationName: "bb",
        deps,
        iconPath: "/opt/bb/icon.png",
        onQuit() {},
        onShow() {},
        platform: "linux",
      }),
    ).toBeNull();
    expect(deps.createdIcons).toEqual([]);
  });

  it("builds a Windows tray named after the app whose click and menu reach the callbacks", () => {
    const fake = createFakeTray();
    const deps = createDeps(fake);
    const calls: string[] = [];

    const tray = createDesktopTray({
      applicationName: "bb Nightly",
      deps,
      iconPath: "C:\\bb\\icon.png",
      onQuit() {
        calls.push("quit");
      },
      onShow() {
        calls.push("show");
      },
      platform: "win32",
    });

    expect(tray).toBe(fake);
    expect(deps.createdIcons).toEqual(["C:\\bb\\icon.png"]);
    expect(fake.tooltips).toEqual(["bb Nightly"]);
    expect(fake.menus).toEqual([{ kind: "fake-menu" }]);
    expect(deps.builtMenus[0]?.showLabel).toBe("Open bb Nightly");
    expect(deps.builtMenus[0]?.quitLabel).toBe("Quit bb Nightly");
    deps.builtMenus[0]?.onShow();
    deps.builtMenus[0]?.onQuit();
    fake.clicks[0]?.();
    expect(calls).toEqual(["show", "quit", "show"]);
  });
});
```

`test/desktop-quit-request.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveDesktopQuitRequestFile,
  watchDesktopQuitRequestFile,
} from "../src/desktop-quit-request.js";

describe("resolveDesktopQuitRequestFile", () => {
  it("honours the request file only on Windows", () => {
    expect(
      resolveDesktopQuitRequestFile({
        env: { BB_DESKTOP_QUIT_REQUEST_FILE: "C:\\smoke\\quit" },
        platform: "win32",
      }),
    ).toBe("C:\\smoke\\quit");
    expect(
      resolveDesktopQuitRequestFile({
        env: { BB_DESKTOP_QUIT_REQUEST_FILE: "/tmp/quit" },
        platform: "linux",
      }),
    ).toBeNull();
    expect(
      resolveDesktopQuitRequestFile({
        env: { BB_DESKTOP_QUIT_REQUEST_FILE: "/tmp/quit" },
        platform: "darwin",
      }),
    ).toBeNull();
  });

  it("ignores an unset or blank variable", () => {
    expect(
      resolveDesktopQuitRequestFile({ env: {}, platform: "win32" }),
    ).toBeNull();
    expect(
      resolveDesktopQuitRequestFile({
        env: { BB_DESKTOP_QUIT_REQUEST_FILE: "   " },
        platform: "win32",
      }),
    ).toBeNull();
  });
});

describe("watchDesktopQuitRequestFile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once when the file appears and stops polling afterwards", () => {
    let exists = false;
    const fileExists = vi.fn(() => exists);
    const onRequest = vi.fn();
    const watcher = watchDesktopQuitRequestFile({
      fileExists,
      filePath: "C:\\smoke\\quit",
      onRequest,
      pollMs: 500,
    });

    vi.advanceTimersByTime(500);
    expect(onRequest).not.toHaveBeenCalled();
    exists = true;
    vi.advanceTimersByTime(500);
    expect(onRequest).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(fileExists).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("stops polling when stopped", () => {
    const fileExists = vi.fn(() => true);
    const watcher = watchDesktopQuitRequestFile({
      fileExists,
      filePath: "C:\\smoke\\quit",
      onRequest: vi.fn(),
      pollMs: 500,
    });

    watcher.stop();
    vi.advanceTimersByTime(5_000);
    expect(fileExists).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bb/desktop exec vitest run test/desktop-runtime-policy.test.ts test/desktop-tray.test.ts test/desktop-quit-request.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the modules**

`desktop-runtime-policy.ts`:

```ts
interface PlatformArgs {
  platform: NodeJS.Platform;
}

export function shouldQuitOnWindowAllClosed(args: PlatformArgs): boolean {
  return args.platform !== "darwin" && args.platform !== "win32";
}

export function shouldHandleSessionEnd(args: PlatformArgs): boolean {
  return args.platform === "win32";
}
```

`desktop-tray.ts`:

```ts
interface ShouldCreateTrayIconArgs {
  platform: NodeJS.Platform;
}

export interface DesktopTrayHandle {
  destroy(): void;
  on(event: "click", listener: () => void): void;
  setContextMenu(menu: unknown): void;
  setToolTip(tooltip: string): void;
}

export interface DesktopTrayMenuArgs {
  onQuit(): void;
  onShow(): void;
  quitLabel: string;
  showLabel: string;
}

export interface DesktopTrayDeps {
  buildMenu(args: DesktopTrayMenuArgs): unknown;
  createIcon(imagePath: string): DesktopTrayHandle;
}

interface CreateDesktopTrayArgs {
  applicationName: string;
  deps: DesktopTrayDeps;
  iconPath: string;
  onQuit(): void;
  onShow(): void;
  platform: NodeJS.Platform;
}

export function shouldCreateTrayIcon(args: ShouldCreateTrayIconArgs): boolean {
  return args.platform === "win32";
}

export function createDesktopTray(
  args: CreateDesktopTrayArgs,
): DesktopTrayHandle | null {
  if (!shouldCreateTrayIcon({ platform: args.platform })) {
    return null;
  }
  const tray = args.deps.createIcon(args.iconPath);
  tray.setToolTip(args.applicationName);
  tray.setContextMenu(
    args.deps.buildMenu({
      onQuit: args.onQuit,
      onShow: args.onShow,
      quitLabel: `Quit ${args.applicationName}`,
      showLabel: `Open ${args.applicationName}`,
    }),
  );
  tray.on("click", args.onShow);
  return tray;
}
```

`desktop-quit-request.ts`:

```ts
import { existsSync } from "node:fs";

export const DESKTOP_QUIT_REQUEST_FILE_ENV_NAME =
  "BB_DESKTOP_QUIT_REQUEST_FILE";

interface ResolveDesktopQuitRequestFileArgs {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

interface WatchDesktopQuitRequestFileArgs {
  fileExists?: (filePath: string) => boolean;
  filePath: string;
  onRequest(): void;
  pollMs: number;
}

interface DesktopQuitRequestWatcher {
  stop(): void;
}

export function resolveDesktopQuitRequestFile(
  args: ResolveDesktopQuitRequestFileArgs,
): string | null {
  if (args.platform !== "win32") {
    return null;
  }
  const raw = args.env[DESKTOP_QUIT_REQUEST_FILE_ENV_NAME]?.trim();
  return raw === undefined || raw.length === 0 ? null : raw;
}

export function watchDesktopQuitRequestFile(
  args: WatchDesktopQuitRequestFileArgs,
): DesktopQuitRequestWatcher {
  const fileExists = args.fileExists ?? existsSync;
  const timer = setInterval(() => {
    if (!fileExists(args.filePath)) {
      return;
    }
    clearInterval(timer);
    args.onRequest();
  }, args.pollMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
```

- [ ] **Step 4: Wire `main.ts`**

1. Imports: add `Menu`, `Tray` to the `electron` import; import `createDesktopTray`, `type DesktopTrayHandle` from `./desktop-tray.js`; `shouldHandleSessionEnd`, `shouldQuitOnWindowAllClosed` from `./desktop-runtime-policy.js`; `resolveDesktopQuitRequestFile`, `watchDesktopQuitRequestFile` from `./desktop-quit-request.js`.
2. Module state beside `desktopWindowFactory` (:319): `let desktopTray: DesktopTrayHandle | null = null;` and `let desktopQuitRequestWatcher: { stop(): void } | null = null;`.
3. Extract the second-instance body into a function next to `createApplicationWindow`:

```ts
function focusOrCreateApplicationWindow(): void {
  if (desktopWindowFactory?.focusFirstWindow() === true) {
    return;
  }
  void createApplicationWindow({
    initialUrl: currentWindowUrl,
    stateKey: null,
  });
}
```

and make `app.on("second-instance", () => { focusOrCreateApplicationWindow(); })` use it (behaviour identical).

4. `window-all-closed`:

```ts
app.on("window-all-closed", () => {
  if (shouldQuitOnWindowAllClosed({ platform: process.platform })) {
    app.quit();
  }
});
if (shouldHandleSessionEnd({ platform: process.platform })) {
  app.on("session-end", () => {
    quitting = true;
    stoppingForQuit = true;
    void finishQuit();
  });
}
```

5. `finishQuit`: after `desktopBrowserViewManager?.destroyAll();` add `desktopQuitRequestWatcher?.stop(); desktopQuitRequestWatcher = null; desktopTray?.destroy(); desktopTray = null;`.
6. `startOwnedRuntime` (:1751): pass `platform: process.platform` to `startBbAppProcess`.
7. Startup, right after `app.setName(applicationName);` (:2030):

```ts
if (process.platform === "win32") {
  app.setAppUserModelId(
    app.isPackaged ? DESKTOP_RELEASE_INFO.appUserModelId : "dev.bb.desktop.dev",
  );
}
```

8. After `installLogViewerIpcHandlers();` (:2422):

```ts
desktopTray = createDesktopTray({
  applicationName,
  deps: {
    buildMenu(menuArgs) {
      return Menu.buildFromTemplate([
        { click: menuArgs.onShow, label: menuArgs.showLabel },
        { type: "separator" },
        { click: menuArgs.onQuit, label: menuArgs.quitLabel },
      ]);
    },
    createIcon(imagePath) {
      return new Tray(
        nativeImage.createFromPath(imagePath).resize({ height: 16, width: 16 }),
      );
    },
  },
  iconPath,
  onQuit() {
    app.quit();
  },
  onShow: focusOrCreateApplicationWindow,
  platform: process.platform,
});
const quitRequestFile = resolveDesktopQuitRequestFile({
  env: process.env,
  platform: process.platform,
});
if (quitRequestFile !== null) {
  desktopQuitRequestWatcher = watchDesktopQuitRequestFile({
    filePath: quitRequestFile,
    onRequest() {
      app.quit();
    },
    pollMs: 500,
  });
}
```

`applicationName` is the `const` computed at :2027 (`bb`, `bb Nightly` or `bb-dev`); it is in scope for the whole of `runDesktopApp`. Electron's `Tray` satisfies `DesktopTrayHandle` structurally (`on("click")`, `setContextMenu`, `setToolTip`, `destroy`).

- [ ] **Step 5: Run to verify pass, typecheck, dev-mode check**

Run: `pnpm --filter @bb/desktop exec vitest run test/desktop-runtime-policy.test.ts test/desktop-tray.test.ts test/desktop-quit-request.test.ts` → PASS; `pnpm exec turbo run typecheck --filter=@bb/desktop` → PASS.

On the reference desktop: `pnpm --filter @bb/desktop run package:windows > <scratchpad>/task7-package.log 2>&1`, then from PowerShell:

```powershell
$env:BB_DESKTOP_QUIT_REQUEST_FILE = "$env:TEMP\bb-quit-request"
Remove-Item -ErrorAction SilentlyContinue $env:BB_DESKTOP_QUIT_REQUEST_FILE
$p = Start-Process -PassThru "apps\desktop\release\win-unpacked\bb.exe"
Start-Sleep -Seconds 20
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*bb-app-bridge.mjs*" } | Select-Object ProcessId, ParentProcessId
New-Item -ItemType File $env:BB_DESKTOP_QUIT_REQUEST_FILE | Out-Null
$p.WaitForExit(30000); $p.HasExited
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*bb-app-bridge.mjs*" } | Measure-Object | Select-Object -ExpandProperty Count
```

Expected: a tray icon with `Open bb` / `Quit bb` appears while the app runs; the bridge process is listed once before the quit request and zero times after; `HasExited` is `True`. Record the transcript in the report. If the first launch shows the existing-server dialog (a dev instance on 38886), set `BB_SERVER_PORT=48886` and `BB_HOST_DAEMON_PORT=48887` for the run.

- [ ] **Step 6: Commit**

```bash
pnpm exec oxfmt apps/desktop/src/desktop-tray.ts apps/desktop/src/desktop-runtime-policy.ts apps/desktop/src/desktop-quit-request.ts apps/desktop/src/main.ts apps/desktop/test/desktop-tray.test.ts apps/desktop/test/desktop-runtime-policy.test.ts apps/desktop/test/desktop-quit-request.test.ts
git add apps/desktop/src apps/desktop/test
git commit -m "Park the Windows desktop in the tray, handle session end and honour a quit request file"
```

---

### Task 8: Windows window frame and app chrome

**Files:**

- Modify: `apps/desktop/src/desktop-window-frame.ts`, `apps/desktop/src/desktop-window-factory.ts` (`CreateDesktopWindowFactoryArgs` :76-89, `CreateWindowOptionsArgs` :138-145, `createWindowOptions` :164-196, `DesktopBrowserWindow` :52-68, the `createWindow` call :235-243), `apps/desktop/src/main.ts` (`createDesktopWindowFactory` call :2397-2421, `BB_DESKTOP_SET_THEME_CHANNEL` handler :1659-1665)
- Modify: `apps/desktop/test/desktop-window-frame.test.ts`, `apps/desktop/test/desktop-window-factory.test.ts` (every `createDesktopWindowFactory({…})` literal gains `isWindows: false`; `FakeDesktopWindow` gains `setTitleBarOverlay`)
- Modify: `apps/app/src/lib/bb-desktop.ts`, `apps/app/src/lib/bb-desktop.test.ts`, `apps/app/src/components/layout/AppLayout.tsx`, `apps/app/src/components/layout/AppPageHeader.tsx`, `apps/app/src/components/secondary-panel/ThreadSecondaryPanel.tsx`, `apps/app/src/components/sidebar/AppSidebar.tsx`, `apps/app/src/components/sidebar/SectionSidebar.tsx`, plus every other importer of the renamed constants (`grep -rn "MACOS_WINDOW_DRAG_CLASS\|MACOS_APP_REGION_NO_DRAG_CLASS\|MACOS_WINDOW_NO_DRAG_CLASS\|MACOS_CHROME_CONTROL_NO_DRAG_CLASS" apps/app/src`)

**Interfaces:**

- Consumes: `resolveBbDesktopPlatform` (`windows`), `useDesktopWindowState().isFullScreen`.
- Produces:
  - `desktop-window-frame.ts`: `interface DesktopTitleBarOverlay { color: string; height: number; symbolColor: string }`, `WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = 48`, `resolveWindowsTitleBarOverlay({ darkColors }): DesktopTitleBarOverlay`, `shouldUseWindowsTitleBarOverlay({ platform }): boolean`.
  - `desktop-window-factory.ts`: `CreateDesktopWindowFactoryArgs.isWindows: boolean`, `CreateDesktopWindowFactoryArgs.darkColors(): boolean`, `DesktopBrowserWindow.setTitleBarOverlay(overlay: DesktopTitleBarOverlay): void`, `DesktopWindowFactory.applyTitleBarOverlay(overlay: DesktopTitleBarOverlay): void` (applies to every active window).
  - `apps/app/src/lib/bb-desktop.ts`: `DESKTOP_WINDOW_DRAG_CLASS`, `DESKTOP_APP_REGION_NO_DRAG_CLASS`, `DESKTOP_WINDOW_NO_DRAG_CLASS`, `DESKTOP_CHROME_CONTROL_NO_DRAG_CLASS` (renamed, values unchanged), `WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS = "pr-[138px]"`, `shouldUseWindowsDesktopChrome(desktopInfo)`, `shouldUseDesktopWindowChrome(desktopInfo)`, `shouldReserveWindowsCaptionControls({ desktopInfo, windowState })`.

- [ ] **Step 1: Write the failing tests (main process)**

`test/desktop-window-frame.test.ts` (append):

```ts
import {
  resolveWindowsTitleBarOverlay,
  shouldUseWindowsTitleBarOverlay,
  WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
} from "../src/desktop-window-frame.js";

describe("Windows title bar overlay", () => {
  it("is used on Windows only", () => {
    expect(shouldUseWindowsTitleBarOverlay({ platform: "win32" })).toBe(true);
    expect(shouldUseWindowsTitleBarOverlay({ platform: "darwin" })).toBe(false);
    expect(shouldUseWindowsTitleBarOverlay({ platform: "linux" })).toBe(false);
  });

  it("matches the app chrome row height and follows the theme", () => {
    expect(WINDOWS_TITLE_BAR_OVERLAY_HEIGHT).toBe(48);
    expect(resolveWindowsTitleBarOverlay({ darkColors: true })).toEqual({
      color: "#1f1f1f",
      height: 48,
      symbolColor: "#e8e8e8",
    });
    expect(resolveWindowsTitleBarOverlay({ darkColors: false })).toEqual({
      color: "#f6f6f6",
      height: 48,
      symbolColor: "#1f1f1f",
    });
  });
});
```

`test/desktop-window-factory.test.ts` — add `public readonly titleBarOverlays: DesktopTitleBarOverlay[] = [];` and `setTitleBarOverlay(overlay: DesktopTitleBarOverlay): void { this.titleBarOverlays.push(overlay); }` to `FakeDesktopWindow`, add `isWindows: false, darkColors() { return false; }` to every existing factory literal, and add:

```ts
it("hides the Windows title bar behind a caption overlay and updates it with the theme", async () => {
  const tempDir = await createTempDir();
  const createdWindows: FakeDesktopWindow[] = [];
  const browserWindowCreator: DesktopBrowserWindowCreator = {
    create(options) {
      const browserWindow = new FakeDesktopWindow({ options });
      createdWindows.push(browserWindow);
      return browserWindow;
    },
  };
  let darkColors = false;
  const factory = createDesktopWindowFactory({
    browserWindowCreator,
    createWindowStateKey() {
      return "windows-window";
    },
    darkColors() {
      return darkColors;
    },
    displayWorkAreas: [{ height: 900, width: 1440, x: 0, y: 0 }],
    icon: undefined,
    isLinuxFrameless: false,
    isLinuxTransparent: false,
    isMac: false,
    isQuitting() {
      return false;
    },
    isWindows: true,
    openExternalUrl() {},
    preloadPath: "C:\\bb\\preload.cjs",
    userDataPath: tempDir.path,
  });

  await factory.createWindow({ initialUrl: null, stateKey: null });
  darkColors = true;
  factory.applyTitleBarOverlay(resolveWindowsTitleBarOverlay({ darkColors }));

  expect(createdWindows[0]?.options.titleBarStyle).toBe("hidden");
  expect(createdWindows[0]?.options.titleBarOverlay).toEqual({
    color: "#f6f6f6",
    height: 48,
    symbolColor: "#1f1f1f",
  });
  expect(createdWindows[0]?.options).not.toHaveProperty("frame");
  expect(createdWindows[0]?.options).not.toHaveProperty("trafficLightPosition");
  expect(createdWindows[0]?.titleBarOverlays).toEqual([
    { color: "#1f1f1f", height: 48, symbolColor: "#e8e8e8" },
  ]);
});
```

The existing `"…Linux…"` test that asserts `not.toHaveProperty("titleBarStyle")` and the macOS `hiddenInset` test stay as they are and must still pass.

- [ ] **Step 2: Write the failing tests (app)**

`apps/app/src/lib/bb-desktop.test.ts` (append inside the existing describe or a new one):

```ts
import {
  shouldReserveWindowsCaptionControls,
  shouldUseDesktopWindowChrome,
  shouldUseWindowsDesktopChrome,
  WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS,
} from "./bb-desktop";

describe("Windows desktop chrome", () => {
  const windowsApi = createBbDesktopApi({
    ...desktopInfo,
    platform: "windows",
  });
  const macosApi = createBbDesktopApi(desktopInfo);

  it("treats macOS and Windows as desktop window chrome hosts", () => {
    expect(shouldUseWindowsDesktopChrome(null)).toBe(false);
    expect(shouldUseDesktopWindowChrome(null)).toBe(false);
    expect(shouldUseDesktopWindowChrome(macosApi)).toBe(true);
    expect(shouldUseDesktopWindowChrome(windowsApi)).toBe(true);
    expect(shouldUseWindowsDesktopChrome(macosApi)).toBe(false);
  });

  it("reserves the caption-control width on Windows only outside full screen", () => {
    expect(WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS).toBe("pr-[138px]");
    expect(
      shouldReserveWindowsCaptionControls({
        desktopInfo: windowsApi,
        windowState: { isFullScreen: false },
      }),
    ).toBe(true);
    expect(
      shouldReserveWindowsCaptionControls({
        desktopInfo: windowsApi,
        windowState: { isFullScreen: true },
      }),
    ).toBe(false);
    expect(
      shouldReserveWindowsCaptionControls({
        desktopInfo: macosApi,
        windowState: { isFullScreen: false },
      }),
    ).toBe(false);
  });
});
```

`desktopInfo` (a `BbDesktopInfo` with `platform: "macos"`) and `createBbDesktopApi` from `@/test/bb-desktop-test-utils` already exist at the top of that test file; reuse them. Update every renamed constant import in the test file.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @bb/desktop exec vitest run test/desktop-window-frame.test.ts test/desktop-window-factory.test.ts > <scratchpad>/task8-red-desktop.log 2>&1`; `pnpm --filter @bb/app exec vitest run src/lib/bb-desktop.test.ts > <scratchpad>/task8-red-app.log 2>&1`
Expected: FAIL — missing exports.

- [ ] **Step 4: Implement the main process**

`desktop-window-frame.ts` (append):

```ts
export const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = 48;

export interface DesktopTitleBarOverlay {
  color: string;
  height: number;
  symbolColor: string;
}

interface ResolveWindowsTitleBarOverlayArgs {
  darkColors: boolean;
}

interface ShouldUseWindowsTitleBarOverlayArgs {
  platform: NodeJS.Platform;
}

export function shouldUseWindowsTitleBarOverlay(
  args: ShouldUseWindowsTitleBarOverlayArgs,
): boolean {
  return args.platform === "win32";
}

export function resolveWindowsTitleBarOverlay(
  args: ResolveWindowsTitleBarOverlayArgs,
): DesktopTitleBarOverlay {
  return args.darkColors
    ? {
        color: "#1f1f1f",
        height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
        symbolColor: "#e8e8e8",
      }
    : {
        color: "#f6f6f6",
        height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
        symbolColor: "#1f1f1f",
      };
}
```

`desktop-window-factory.ts`: import `resolveWindowsTitleBarOverlay, type DesktopTitleBarOverlay` from `./desktop-window-frame.js`; add `darkColors(): boolean; isWindows: boolean;` to `CreateDesktopWindowFactoryArgs`, `isWindows: boolean; titleBarOverlay: DesktopTitleBarOverlay;` to `CreateWindowOptionsArgs`, `setTitleBarOverlay(overlay: DesktopTitleBarOverlay): void;` to `DesktopBrowserWindow`, `applyTitleBarOverlay(overlay: DesktopTitleBarOverlay): void;` to `DesktopWindowFactory`; in `createWindowOptions` add after the `isMac` spread:

```ts
    ...(args.isWindows
      ? {
          titleBarOverlay: args.titleBarOverlay,
          titleBarStyle: "hidden" as const,
        }
      : {}),
```

pass `isWindows: args.isWindows, titleBarOverlay: resolveWindowsTitleBarOverlay({ darkColors: args.darkColors() })` from `createWindow`, and implement

```ts
function applyTitleBarOverlay(overlay: DesktopTitleBarOverlay): void {
  for (const browserWindow of activeWindows.values()) {
    browserWindow.setTitleBarOverlay(overlay);
  }
}
```

returned beside the other factory methods.

`main.ts`: pass `darkColors() { return nativeTheme.shouldUseDarkColors; }` and `isWindows: shouldUseWindowsTitleBarOverlay({ platform: process.platform })` to `createDesktopWindowFactory`; in the `BB_DESKTOP_SET_THEME_CHANNEL` handler after `nativeTheme.themeSource = parsed.data;` add

```ts
if (shouldUseWindowsTitleBarOverlay({ platform: process.platform })) {
  desktopWindowFactory?.applyTitleBarOverlay(
    resolveWindowsTitleBarOverlay({
      darkColors: nativeTheme.shouldUseDarkColors,
    }),
  );
}
```

Electron's `BrowserWindow.setTitleBarOverlay` exists on Windows and Linux only; the call is reached only under the win32 guard.

- [ ] **Step 5: Implement the app side**

`apps/app/src/lib/bb-desktop.ts`: rename `MACOS_WINDOW_DRAG_CLASS` → `DESKTOP_WINDOW_DRAG_CLASS`, `MACOS_APP_REGION_NO_DRAG_CLASS` → `DESKTOP_APP_REGION_NO_DRAG_CLASS`, `MACOS_WINDOW_NO_DRAG_CLASS` → `DESKTOP_WINDOW_NO_DRAG_CLASS`, `MACOS_CHROME_CONTROL_NO_DRAG_CLASS` → `DESKTOP_CHROME_CONTROL_NO_DRAG_CLASS` (values unchanged; `MACOS_TRAFFIC_LIGHT_*`, `MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS`, `MACOS_CHROME_CONTROL_AXIS_CLASS`, `MACOS_CHROME_TRAFFIC_LIGHT_AXIS_NUDGE_CLASS` keep their names) and update every importer project-wide (source, tests, stories). Add:

```ts
export const WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS = "pr-[138px]";

export function shouldUseWindowsDesktopChrome(
  desktopInfo: BbDesktopInfoResult,
): boolean {
  return desktopInfo?.platform === "windows";
}

export function shouldUseDesktopWindowChrome(
  desktopInfo: BbDesktopInfoResult,
): boolean {
  return (
    shouldUseMacosDesktopChrome(desktopInfo) ||
    shouldUseWindowsDesktopChrome(desktopInfo)
  );
}

export function shouldReserveWindowsCaptionControls({
  desktopInfo,
  windowState,
}: {
  desktopInfo: BbDesktopInfoResult;
  windowState: BbDesktopWindowState;
}): boolean {
  return (
    shouldUseWindowsDesktopChrome(desktopInfo) && !windowState.isFullScreen
  );
}
```

Components: in `AppLayout.tsx`, `AppPageHeader.tsx`, `ThreadSecondaryPanel.tsx`, `AppSidebar.tsx`, `SectionSidebar.tsx` replace `const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);` with `shouldUseDesktopWindowChrome(desktopInfo)` (this variable gates only drag regions and the control-axis nudge; every `reserveMacosTrafficLights` use stays on the macOS helper). In `AppPageHeader.tsx` compute `const reserveWindowsCaptionControls = shouldReserveWindowsCaptionControls({ desktopInfo, windowState: desktopWindowState });` and add `reserveWindowsCaptionControls && WINDOWS_CAPTION_CONTROLS_RESERVE_CLASS` to the `app-page-header-content-row` `cn(...)`; in `ThreadSecondaryPanel.tsx` compute the same and add the class to the header row that carries `usesDesktopChrome && usesWindowChrome && DESKTOP_WINDOW_DRAG_CLASS` (:714). On macOS both new helpers return `false`, so the rendered class lists are unchanged; verify with the existing component tests.

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @bb/desktop exec vitest run test/desktop-window-frame.test.ts test/desktop-window-factory.test.ts > <scratchpad>/task8-green-desktop.log 2>&1` → PASS; `pnpm --filter @bb/app exec vitest run src/lib/bb-desktop.test.ts src/components/layout src/components/secondary-panel/ThreadSecondaryPanel.test.tsx src/components/sidebar > <scratchpad>/task8-green-app.log 2>&1` → PASS (adjust the file list to the tests that exist for those components); `pnpm exec turbo run typecheck --filter=@bb/desktop --filter=@bb/app` → PASS; `pnpm exec turbo run build --filter=@bb/app --filter=bb-app --output-logs=new-only` so the packaged app in Task 10 carries the new chrome.

On the reference desktop, after `pnpm --filter @bb/desktop run package:windows`, launch `release\win-unpacked\bb.exe`, switch the theme in Settings, and record: caption controls visible at the top right over the app chrome, no native title bar, the overlay colour follows the theme, the window drags by its header, no app control is hidden under the caption buttons (screenshot path in the report).

- [ ] **Step 7: Commit**

```bash
pnpm exec oxfmt <every touched file>
git add apps/desktop/src apps/desktop/test apps/app/src
git commit -m "Draw the Windows desktop window with a caption overlay over the app chrome"
```

---

### Task 9: Phase 3 carry-overs — host path file names and the ConPTY close exit code

**Files:**

- Create: `apps/app/src/lib/host-path.ts`, `apps/app/src/lib/host-path.test.ts`
- Modify: `apps/app/src/hooks/queries/environment-queries.ts:426`, `apps/app/src/hooks/queries/project-queries.ts:276`, `apps/app/src/lib/api.ts:239`, `apps/app/src/lib/plugin-slot-resolvers.ts:276`, `apps/app/src/components/plugin/file-opener-tabs.ts:46`, `apps/app/src/components/secondary-panel/rightPanelFileVisuals.ts:39`, `apps/app/src/components/tools/SkillDetailView.tsx:194`, `apps/app/src/views/RootComposeView.tsx:1617`, `apps/app/src/views/thread-detail/ThreadDetailView.tsx:2719`
- Create: `apps/host-daemon/src/terminals/terminal-exit-code.ts`, `apps/host-daemon/src/terminals/terminal-exit-code.test.ts`
- Modify: `apps/host-daemon/src/terminals/terminal-manager.ts:797-805`

**Interfaces:**

- Produces: `isWindowsAbsolutePath(path): boolean`, `hostPathSegments(path): string[]`, `hostPathBasename(path): string | undefined`; `WINDOWS_CONTROL_C_EXIT_CODE = -1073741510`, `normalizeTerminalExitCode({ closeRequested, exitCode, platform }): number | null`.

- [ ] **Step 1: Write the failing tests**

`apps/app/src/lib/host-path.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  hostPathBasename,
  hostPathSegments,
  isWindowsAbsolutePath,
} from "./host-path";

describe("host paths", () => {
  it("recognises drive-absolute and UNC paths as Windows paths", () => {
    expect(isWindowsAbsolutePath("C:\\Users\\olege\\notes.md")).toBe(true);
    expect(isWindowsAbsolutePath("c:/Users/olege/notes.md")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\notes.md")).toBe(true);
    expect(isWindowsAbsolutePath("/home/olege/notes.md")).toBe(false);
    expect(isWindowsAbsolutePath("src/notes.md")).toBe(false);
    expect(isWindowsAbsolutePath("C:notes.md")).toBe(false);
  });

  it("splits Windows paths on either separator", () => {
    expect(hostPathSegments("C:\\Users\\olege\\src\\app.ts")).toEqual([
      "C:",
      "Users",
      "olege",
      "src",
      "app.ts",
    ]);
    expect(hostPathSegments("C:/Users/olege/src/app.ts")).toEqual([
      "C:",
      "Users",
      "olege",
      "src",
      "app.ts",
    ]);
  });

  it("splits every other path on forward slashes exactly as before", () => {
    expect(hostPathSegments("/home/olege/src/app.ts")).toEqual([
      "",
      "home",
      "olege",
      "src",
      "app.ts",
    ]);
    expect(hostPathSegments("src/weird\\name.ts")).toEqual([
      "src",
      "weird\\name.ts",
    ]);
  });

  it("returns the last segment as the file name", () => {
    expect(hostPathBasename("C:\\Users\\olege\\notes.md")).toBe("notes.md");
    expect(hostPathBasename("/home/olege/notes.md")).toBe("notes.md");
    expect(hostPathBasename("notes.md")).toBe("notes.md");
    expect(hostPathBasename("")).toBe("");
  });
});
```

`apps/host-daemon/src/terminals/terminal-exit-code.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  normalizeTerminalExitCode,
  WINDOWS_CONTROL_C_EXIT_CODE,
} from "./terminal-exit-code.js";

describe("normalizeTerminalExitCode", () => {
  it("drops the ConPTY control-c code after a bb-requested close on Windows", () => {
    expect(WINDOWS_CONTROL_C_EXIT_CODE).toBe(-1073741510);
    expect(
      normalizeTerminalExitCode({
        closeRequested: true,
        exitCode: WINDOWS_CONTROL_C_EXIT_CODE,
        platform: "win32",
      }),
    ).toBeNull();
  });

  it("keeps the code when the shell died on its own or on any other code", () => {
    expect(
      normalizeTerminalExitCode({
        closeRequested: false,
        exitCode: WINDOWS_CONTROL_C_EXIT_CODE,
        platform: "win32",
      }),
    ).toBe(WINDOWS_CONTROL_C_EXIT_CODE);
    expect(
      normalizeTerminalExitCode({
        closeRequested: true,
        exitCode: 1,
        platform: "win32",
      }),
    ).toBe(1);
    expect(
      normalizeTerminalExitCode({
        closeRequested: true,
        exitCode: 0,
        platform: "win32",
      }),
    ).toBe(0);
  });

  it("never touches POSIX exit codes", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(
        normalizeTerminalExitCode({
          closeRequested: true,
          exitCode: WINDOWS_CONTROL_C_EXIT_CODE,
          platform,
        }),
      ).toBe(WINDOWS_CONTROL_C_EXIT_CODE);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bb/app exec vitest run src/lib/host-path.test.ts`; `pnpm --filter @bb/host-daemon exec vitest run src/terminals/terminal-exit-code.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`apps/app/src/lib/host-path.ts`:

```ts
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const WINDOWS_SEPARATOR_PATTERN = /[\\/]/u;

export function isWindowsAbsolutePath(path: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_PATTERN.test(path);
}

export function hostPathSegments(path: string): string[] {
  return isWindowsAbsolutePath(path)
    ? path.split(WINDOWS_SEPARATOR_PATTERN)
    : path.split("/");
}

export function hostPathBasename(path: string): string | undefined {
  return hostPathSegments(path).at(-1);
}
```

Call sites: `name: hostPathBasename(path)` (environment-queries, api), `name: hostPathBasename(requiredPath)` (project-queries), `hostPathBasename(path) ?? path` (plugin-slot-resolvers `getFileExtension`, SkillDetailView, RootComposeView `filenameOf`, ThreadDetailView `filenameOfPanelTab`), `title: hostPathBasename(file.path) ?? file.path` (file-opener-tabs), and in `rightPanelFileVisuals.ts` `hasPathDirectorySegment` becomes `hostPathSegments(path.toLowerCase()).slice(0, -1).includes(segment)`. Import paths are relative (`../../lib/host-path`, etc., matching each file's existing import style).

`apps/host-daemon/src/terminals/terminal-exit-code.ts`:

```ts
export const WINDOWS_CONTROL_C_EXIT_CODE = -1073741510;

interface NormalizeTerminalExitCodeArgs {
  closeRequested: boolean;
  exitCode: number;
  platform: NodeJS.Platform;
}

export function normalizeTerminalExitCode(
  args: NormalizeTerminalExitCodeArgs,
): number | null {
  if (
    args.platform === "win32" &&
    args.closeRequested &&
    args.exitCode === WINDOWS_CONTROL_C_EXIT_CODE
  ) {
    return null;
  }
  return args.exitCode;
}
```

`terminal-manager.ts` `pty.onExit` handler (:797-805):

```ts
                this.finishTerminalSession({
                  closeReason: session.closeReason ?? "process-exit",
                  exitCode: normalizeTerminalExitCode({
                    closeRequested: session.closeReason !== null,
                    exitCode: event.exitCode,
                    platform: this.platform,
                  }),
                  session,
                }),
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bb/app exec vitest run src/lib/host-path.test.ts src/lib/plugin-slot-resolvers.test.ts src/components/secondary-panel/rightPanelFileVisuals.test.ts src/components/plugin/file-opener-tabs.test.ts > <scratchpad>/task9-app.log 2>&1` (drop names that do not exist) → PASS; `pnpm --filter @bb/host-daemon exec vitest run src/terminals/terminal-exit-code.test.ts src/terminals/terminal-manager.test.ts > <scratchpad>/task9-daemon.log 2>&1` → PASS with the same skip set as before; `pnpm exec turbo run typecheck --filter=@bb/app --filter=@bb/host-daemon` → PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec oxfmt <every touched file>
git add apps/app/src apps/host-daemon/src
git commit -m "Show Windows file names in the app and hide the ConPTY close code"
```

---

### Task 10: Packaged-app smoke on Windows and the orphan-process smoke

**Files:**

- Modify: `apps/desktop/scripts/smoke-packaged-app.mjs`
- Create: `apps/desktop/scripts/smoke-windows-processes.mjs`
- Modify: `apps/desktop/scripts/run-packaged-app.mjs` (no change needed beyond Task 1's path resolver; verify `start:windows` launches)

**Interfaces:**

- Consumes: Task 1 `resolvePackagedAppBinary` win32 arm; Task 2 scripts `package:windows`, `smoke:windows-processes`; Task 7 `BB_DESKTOP_QUIT_REQUEST_FILE`.
- Produces (used by Tasks 11, 13): `smoke:packaged` passes on `win-unpacked`; `smoke:windows-processes [--evidence-dir <dir>]` exits 0 with `before.json`, `during.json`, `after.json`, `summary.json` in the evidence dir, prints `Process hygiene smoke passed: no leaked processes.`; any leak, a surviving app pid, or a dead bystander exits 1 with `FAILED process-hygiene: …` lines.

- [ ] **Step 1: `smoke-packaged-app.mjs` win32 arm**

Replace the platform guard and platform mapping:

```js
function resolveDesktopPlatform(platform) {
  if (platform === "darwin") {
    return "macos";
  }
  if (platform === "linux") {
    return "linux";
  }
  if (platform === "win32") {
    return "windows";
  }
  throw new Error(
    "Packaged desktop smoke only runs on macOS, Linux or Windows.",
  );
}
```

and in `smokePackagedApp()` use `const desktopPlatform = resolveDesktopPlatform(process.platform);` in place of the guard and the ternary. Add the quit-request file for Windows:

```js
const quitRequestFileName = "quit-request";

function windowsSystemToolPath(env, name) {
  return join(env.SystemRoot ?? "C:\\Windows", "System32", name);
}

function requestWindowsQuit(quitRequestFile) {
  return writeFile(quitRequestFile, "quit\n", "utf8");
}

function taskkillTree(pid) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      windowsSystemToolPath(process.env, "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", () => resolvePromise());
    child.once("exit", () => resolvePromise());
  });
}

async function stopPackagedApp(child, quitRequestFile) {
  if (await waitForProcessExit(child, 0)) {
    return;
  }

  if (process.platform === "win32") {
    await requestWindowsQuit(quitRequestFile);
    if (await waitForProcessExit(child, windowsQuitTimeoutMs)) {
      return;
    }
    if (child.pid !== undefined) {
      await taskkillTree(child.pid);
    }
    await waitForProcessExit(child, exitTimeoutMs);
    throw new Error(
      "Packaged Electron app ignored the quit request file and was force-killed.",
    );
  }

  child.kill("SIGTERM");
  if (await waitForProcessExit(child, exitTimeoutMs)) {
    return;
  }

  child.kill("SIGKILL");
  await waitForProcessExit(child, exitTimeoutMs);
}
```

with `const windowsQuitTimeoutMs = 30_000;`, `writeFile` added to the `node:fs/promises` import, `const quitRequestFile = join(smokeRoot, quitRequestFileName);` in `smokePackagedApp`, `...(process.platform === "win32" ? { BB_DESKTOP_QUIT_REQUEST_FILE: quitRequestFile } : {})` added to `childEnv`, and `await stopPackagedApp(child, quitRequestFile);` in the `finally`. Because the `finally` now can throw, wrap the smoke-server close and `rm` so they still run: put `stopPackagedApp` in its own `try { … } finally { await smokeServer.close(); await rm(smokeRoot, …); }`. On POSIX the stop sequence is unchanged.

Windows launch: `spawn(appBinary, args, { env: childEnv })` works for a GUI exe; keep it. The `rm(smokeRoot, { recursive: true, force: true })` on Windows can hit `EBUSY` while the app's log handles close — wrap it in the same three-attempt retry the Phase 3 tarball smoke uses (`packages/bb-app/scripts/smoke-tarball.mjs` has `removeWithRetry`; copy its shape, 3 attempts, 500 ms apart) on win32 only.

- [ ] **Step 2: `smoke-windows-processes.mjs`**

```js
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDesktopReleaseConfig,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";
import { createPackagedAppLaunchArguments } from "./packaged-app-launch.mjs";
import { resolvePackagedAppBinary } from "./packaged-app-paths.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDirectory, "..");
const releaseDir = join(desktopPackageRoot, "release");
const startupTimeoutMs = 120_000;
const quitTimeoutMs = 30_000;
const settleMs = 2_000;
const pollIntervalMs = 500;
const interestingImages = new Set([
  "bb.exe",
  "bb nightly.exe",
  "node.exe",
  "pwsh.exe",
  "powershell.exe",
  "cmd.exe",
  "conhost.exe",
]);

function sleep(delayMs) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

function parseEvidenceDir(argv) {
  const flagIndex = argv.indexOf("--evidence-dir");
  if (flagIndex !== -1 && flagIndex + 1 < argv.length) {
    return argv[flagIndex + 1];
  }
  return join("qa-artifacts", "process-hygiene");
}

function windowsSystemToolPath(name) {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

function runPowerShellJson(script) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      windowsSystemToolPath(
        join("WindowsPowerShell", "v1.0", "powershell.exe"),
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(
            `powershell exited with ${String(code)}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
        return;
      }
      const text = Buffer.concat(stdout).toString("utf8").trim();
      resolvePromise(text.length === 0 ? [] : JSON.parse(text));
    });
  });
}

async function snapshotProcesses() {
  const rows = await runPowerShellJson(
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, @{ Name = 'CreationDate'; Expression = { $_.CreationDate.ToString('o') } }) | ConvertTo-Json -Compress -Depth 2",
  );
  return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
    commandLine: typeof row.CommandLine === "string" ? row.CommandLine : "",
    creationDate: typeof row.CreationDate === "string" ? row.CreationDate : "",
    name: typeof row.Name === "string" ? row.Name.toLowerCase() : "",
    parentPid: Number(row.ParentProcessId),
    pid: Number(row.ProcessId),
  }));
}

function descendantsOf(rows, rootPid) {
  const children = new Map();
  for (const row of rows) {
    const siblings = children.get(row.parentPid) ?? [];
    siblings.push(row);
    children.set(row.parentPid, siblings);
  }
  const result = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop();
    for (const row of children.get(pid) ?? []) {
      result.push(row);
      pending.push(row.pid);
    }
  }
  return result;
}

async function findFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          rejectPromise(new Error("No TCP port allocated"));
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}

async function waitForHealth(serverUrl, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return false;
    }
    try {
      const response = await fetch(`${serverUrl}/health`);
      if (response.ok) {
        return true;
      }
    } catch {}
    await sleep(pollIntervalMs);
  }
  return false;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once("exit", onExit);
  });
}

function taskkillTree(pid) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      windowsSystemToolPath("taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", () => resolvePromise());
    child.once("exit", () => resolvePromise());
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function smokeWindowsProcesses() {
  if (process.platform !== "win32") {
    throw new Error(
      `The Windows process-hygiene smoke requires win32, got ${process.platform}.`,
    );
  }
  const evidenceDir = resolve(process.cwd(), parseEvidenceDir(process.argv));
  await mkdir(evidenceDir, { recursive: true });
  const releaseConfig = createDesktopReleaseConfig(
    resolveDesktopReleaseChannel(process.env),
  );
  const appBinary = await resolvePackagedAppBinary({
    executableName: releaseConfig.linuxExecutableName,
    platform: process.platform,
    productName: releaseConfig.applicationName,
    releaseDir,
  });
  const smokeRoot = await mkdtemp(join(tmpdir(), "bb-win-process-smoke-"));
  const dataDir = join(smokeRoot, "data");
  const userDataDir = join(smokeRoot, "user-data");
  const quitRequestFile = join(smokeRoot, "quit-request");
  const serverPort = await findFreePort();
  const daemonPort = await findFreePort();
  const serverUrl = `http://127.0.0.1:${String(serverPort)}`;
  const failures = [];

  const bystander = spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { stdio: "ignore", windowsHide: true },
  );
  if (bystander.pid === undefined) {
    throw new Error("Bystander process did not expose a PID.");
  }
  console.log(`Process hygiene smoke: bystander pid ${String(bystander.pid)}.`);

  const before = await snapshotProcesses();
  await writeJson(join(evidenceDir, "before.json"), before);

  const childEnv = {
    ...process.env,
    BB_DATA_DIR: dataDir,
    BB_DESKTOP_ATTACH_WITHOUT_PROMPT: "1",
    BB_DESKTOP_OPEN_DEVTOOLS: "0",
    BB_DESKTOP_QUIT_REQUEST_FILE: quitRequestFile,
    BB_HOST_DAEMON_PORT: String(daemonPort),
    BB_SERVER_PORT: String(serverPort),
  };
  delete childEnv.BB_DESKTOP_APP_URL;
  delete childEnv.BB_DESKTOP_NODE_EXEC_PATH;
  delete childEnv.BB_DESKTOP_VERSION_FEED_URL;
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(
    appBinary,
    createPackagedAppLaunchArguments({
      platform: process.platform,
      userDataDir,
    }),
    { env: childEnv, stdio: "ignore" },
  );
  if (child.pid === undefined) {
    throw new Error("Packaged app did not expose a PID.");
  }
  console.log(
    `Process hygiene smoke: app pid ${String(child.pid)} → ${serverUrl}`,
  );

  let during = [];
  try {
    const healthy = await waitForHealth(serverUrl, child, startupTimeoutMs);
    if (!healthy) {
      failures.push(
        `Owned runtime never answered ${serverUrl}/health within ${String(startupTimeoutMs)}ms (app exit code ${String(child.exitCode)}).`,
      );
    } else {
      const snapshot = await snapshotProcesses();
      during = descendantsOf(snapshot, child.pid);
      await writeJson(join(evidenceDir, "during.json"), during);
      console.log(
        `Process hygiene smoke: ${String(during.length)} descendant processes while running.`,
      );
      if (
        !during.some((row) => row.commandLine.includes("bb-app-bridge.mjs"))
      ) {
        failures.push("No bb-app bridge process found under the app.");
      }
      await writeFile(quitRequestFile, "quit\n", "utf8");
      const exited = await waitForExit(child, quitTimeoutMs);
      if (!exited) {
        failures.push(
          `App pid ${String(child.pid)} ignored the quit request within ${String(quitTimeoutMs)}ms.`,
        );
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await taskkillTree(child.pid);
      await waitForExit(child, 10_000);
    }
  }

  await sleep(settleMs);
  const after = await snapshotProcesses();
  await writeJson(join(evidenceDir, "after.json"), after);
  const afterByPid = new Map(after.map((row) => [row.pid, row]));
  const survivors = during.filter((row) => {
    const now = afterByPid.get(row.pid);
    return now !== undefined && now.creationDate === row.creationDate;
  });
  const beforePids = new Set(before.map((row) => row.pid));
  const strays = after.filter(
    (row) =>
      !beforePids.has(row.pid) &&
      row.pid !== process.pid &&
      row.pid !== bystander.pid &&
      interestingImages.has(row.name) &&
      (row.commandLine.includes(dataDir) ||
        row.commandLine.includes("bb-app-bridge.mjs") ||
        row.commandLine.includes(userDataDir)),
  );
  for (const row of [...survivors, ...strays]) {
    failures.push(
      `Leaked process after quit: ${row.name} (${String(row.pid)}) ${row.commandLine}`,
    );
  }
  if (!isAlive(bystander.pid)) {
    failures.push("The unrelated bystander process was killed during the run.");
  }
  bystander.kill();

  await writeJson(join(evidenceDir, "summary.json"), {
    appBinary,
    appPid: child.pid,
    bystanderPid: bystander.pid,
    descendantsWhileRunning: during.length,
    failures,
    serverUrl,
    strays: strays.map((row) => row.pid),
    survivors: survivors.map((row) => row.pid),
  });
  await rm(smokeRoot, { force: true, recursive: true }).catch(() => undefined);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`FAILED process-hygiene: ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Process hygiene smoke passed: no leaked processes.");
}

await smokeWindowsProcesses().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
```

The empty `catch {}` swallows connection refusals while the runtime boots. The `taskkillTree` in the `finally` only runs after the graceful path already failed and that failure is recorded — it is cleanup, not the stop path.

- [ ] **Step 3: Run both smokes on the reference desktop**

```
pnpm --filter @bb/desktop run package:windows > <scratchpad>/task10-package.log 2>&1
pnpm exec turbo run smoke:packaged --filter=@bb/desktop --force --output-logs=new-only > <scratchpad>/task10-smoke-packaged.log 2>&1
pnpm exec turbo run smoke:windows-processes --filter=@bb/desktop --output-logs=new-only -- --evidence-dir <scratchpad>/task10-hygiene > <scratchpad>/task10-smoke-processes.log 2>&1
```

Expected: `Packaged desktop smoke passed: …win-unpacked\bb.exe`; `Process hygiene smoke passed: no leaked processes.` with `during.json` listing at least the bridge (`node`-mode Electron) process, the server and the host daemon. Run the hygiene smoke three times and record all three exit codes. If a leak appears, the leaked command line tells which seam missed: a `bb-app-bridge.mjs` survivor means Task 5's tree stop failed (fix there, not by widening the smoke); a `pwsh.exe`/`conhost.exe` survivor is a terminal left by the server (record it; Phase 5 scope unless it is reproducible on every run, in which case stop and report).

- [ ] **Step 4: Commit**

```bash
pnpm exec oxfmt apps/desktop/scripts/smoke-packaged-app.mjs apps/desktop/scripts/smoke-windows-processes.mjs
git add apps/desktop/scripts/smoke-packaged-app.mjs apps/desktop/scripts/smoke-windows-processes.mjs
git commit -m "Smoke the packaged Windows desktop app and prove it leaves no processes behind"
```

---

### Task 11: CI — Windows packaging in `ci.yml` and a Windows job in `build-desktop.yml`

**Files:**

- Modify: `.github/workflows/ci.yml` (`windows-x64` job after `Smoke bb-app tarball`, and the upload step)
- Modify: `.github/workflows/build-desktop.yml` (new `windows` job; `publish` job `needs`, plan, download, globs, summary)

**Interfaces:**

- Consumes: Task 2 scripts and Turbo tasks, Task 10 smokes, Task 1 feed file names.
- Produces: workflow artifact `bb-desktop-windows-x64`; publish assets `desktop-version-windows.json` (always), `latest.yml`, `bb-<version>-x64.exe`, `bb-<version>-x64.exe.blockmap` (only with signing secrets); `ci.yml` artifact `windows-x64-test-results` also carries `qa-artifacts/process-hygiene/*.json`.

- [ ] **Step 1: `ci.yml`**

After the `Smoke bb-app tarball` step add (same `env:` block with the workspace-local `TMP`/`TEMP` on each of the three steps):

```yaml
- name: Package Windows desktop (unpacked)
  env:
    TMP: ${{ github.workspace }}\.smoke-temp
    TEMP: ${{ github.workspace }}\.smoke-temp
  run: |
    New-Item -ItemType Directory -Force "$env:TEMP" | Out-Null
    pnpm --filter @bb/desktop run package:windows
    exit $LASTEXITCODE

- name: Smoke packaged desktop app
  env:
    TMP: ${{ github.workspace }}\.smoke-temp
    TEMP: ${{ github.workspace }}\.smoke-temp
  run: |
    pnpm exec turbo run smoke:packaged --filter=@bb/desktop --force --output-logs=new-only
    exit $LASTEXITCODE

- name: Smoke Windows process hygiene
  env:
    TMP: ${{ github.workspace }}\.smoke-temp
    TEMP: ${{ github.workspace }}\.smoke-temp
  run: |
    pnpm exec turbo run smoke:windows-processes --filter=@bb/desktop --output-logs=new-only -- --evidence-dir qa-artifacts/process-hygiene
    exit $LASTEXITCODE
```

and add `qa-artifacts/process-hygiene/*.json` to the `Upload Windows test run summaries` `path:` list. Add one YAML comment above the packaging step in the existing style explaining that the unpacked build downloads `winCodeSign` on first use (comments are allowed in workflow YAML as the file already uses them).

- [ ] **Step 2: `build-desktop.yml` — `windows` job**

Insert after the `linux` job:

```yaml
windows:
  name: Windows x64 desktop artifacts
  # Pinned rather than windows-latest so the NSIS/Electron toolchain the
  # installer is measured against changes only when we choose it.
  runs-on: windows-2025
  timeout-minutes: 60
  outputs:
    has_windows_signing_secrets: ${{ steps.windows_signing.outputs.has_windows_signing_secrets }}

  steps:
    - name: Checkout repository
      uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        fetch-depth: 0

    - name: Set up pnpm
      uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
      with:
        version: ${{ env.PNPM_VERSION }}
        run_install: false

    - name: Set up Node.js
      uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
      with:
        node-version: ${{ env.NODE_VERSION }}
        cache: pnpm

    - name: Install dependencies
      run: pnpm install --frozen-lockfile --prefer-offline

    - name: Typecheck desktop and launcher
      run: pnpm exec turbo run typecheck --filter=@bb/desktop --filter=bb-app --output-logs=new-only

    - name: Build desktop
      run: pnpm exec turbo run build --filter=@bb/desktop --output-logs=new-only

    - name: Test desktop and launcher
      run: pnpm exec turbo run test --filter=@bb/desktop --filter=bb-app --force --output-logs=new-only

    - name: Validate Windows signing secrets
      id: windows_signing
      env:
        AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
        AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
        AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
        AZURE_SIGNING_ENDPOINT: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
        AZURE_SIGNING_ACCOUNT_NAME: ${{ secrets.AZURE_SIGNING_ACCOUNT_NAME }}
        AZURE_SIGNING_CERTIFICATE_PROFILE: ${{ secrets.AZURE_SIGNING_CERTIFICATE_PROFILE }}
        WINDOWS_PUBLISHER_NAME: ${{ secrets.WINDOWS_PUBLISHER_NAME }}
      run: |
        $required = @(
          "AZURE_TENANT_ID",
          "AZURE_CLIENT_ID",
          "AZURE_CLIENT_SECRET",
          "AZURE_SIGNING_ENDPOINT",
          "AZURE_SIGNING_ACCOUNT_NAME",
          "AZURE_SIGNING_CERTIFICATE_PROFILE",
          "WINDOWS_PUBLISHER_NAME"
        )
        $present = @($required | Where-Object { -not [string]::IsNullOrWhiteSpace((Get-Item -Path "Env:$_" -ErrorAction SilentlyContinue).Value) })
        $missing = @($required | Where-Object { $present -notcontains $_ })
        $has = "false"
        if ($present.Count -eq 0) {
          Write-Output "::warning::Windows signing secrets are not configured; building an unsigned NSIS installer that a publish run will withhold. The Windows version feed still publishes."
        } elseif ($missing.Count -eq 0) {
          Write-Output "Windows signing secrets are complete; the installer will be signed with Azure Trusted Signing."
          $has = "true"
        } else {
          Write-Output "::error::Incomplete Windows signing secret set. Present: $($present -join ', '). Missing: $($missing -join ', ')."
          exit 1
        }
        Add-Content -Path $env:GITHUB_OUTPUT -Value "has_windows_signing_secrets=$has"

    - name: Package x64 NSIS installer
      env:
        AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
        AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
        AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
        AZURE_SIGNING_ENDPOINT: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
        AZURE_SIGNING_ACCOUNT_NAME: ${{ secrets.AZURE_SIGNING_ACCOUNT_NAME }}
        AZURE_SIGNING_CERTIFICATE_PROFILE: ${{ secrets.AZURE_SIGNING_CERTIFICATE_PROFILE }}
        WINDOWS_PUBLISHER_NAME: ${{ secrets.WINDOWS_PUBLISHER_NAME }}
      run: |
        pnpm exec turbo run desktop:build:windows --filter=@bb/desktop --output-logs=new-only
        exit $LASTEXITCODE

    - name: Smoke test packaged desktop app
      env:
        TMP: ${{ github.workspace }}\.smoke-temp
        TEMP: ${{ github.workspace }}\.smoke-temp
      run: |
        New-Item -ItemType Directory -Force "$env:TEMP" | Out-Null
        pnpm exec turbo run smoke:packaged --filter=@bb/desktop --force --output-logs=new-only
        exit $LASTEXITCODE

    - name: Smoke test Windows process hygiene
      env:
        TMP: ${{ github.workspace }}\.smoke-temp
        TEMP: ${{ github.workspace }}\.smoke-temp
      run: |
        pnpm exec turbo run smoke:windows-processes --filter=@bb/desktop --output-logs=new-only -- --evidence-dir qa-artifacts/process-hygiene
        exit $LASTEXITCODE

    - name: Generate desktop version feed
      run: pnpm --dir apps/desktop run desktop:version-feed

    - name: Upload desktop workflow artifacts
      uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
      with:
        name: bb-desktop-windows-x64
        path: |
          apps/desktop/release/*.exe
          apps/desktop/release/*.blockmap
          apps/desktop/release/latest.yml
          apps/desktop/release/desktop-version-windows.json
          qa-artifacts/process-hygiene/*.json
        if-no-files-found: error
```

`desktop:build:windows` produces `release/win-unpacked/` as a by-product of the NSIS build, so the smokes run against the same bits the installer wraps; no separate `--dir` step.

- [ ] **Step 3: `build-desktop.yml` — `publish` job**

- `needs:` gains `- windows`.
- Plan step `env:` gains `HAS_WINDOWS_SIGNING_SECRETS: ${{ needs.windows.outputs.has_windows_signing_secrets }}`; the script computes

```bash
          PUBLISH_WINDOWS_BINARIES="false"
          if [[ "$HAS_WINDOWS_SIGNING_SECRETS" == "true" ]]; then
            PUBLISH_WINDOWS_BINARIES="true"
          elif [[ "$SHOULD_PUBLISH" == "true" ]]; then
            echo "::warning::Windows signing secrets are missing; publishing the Windows version feed only and withholding the unsigned .exe installer."
          fi
```

and appends `echo "publish_windows_binaries=$PUBLISH_WINDOWS_BINARIES"` to the outputs block.

- A `Download Windows desktop artifacts` step (same `if:`, `name: bb-desktop-windows-x64`, `path: release/windows`).
- In the publish script: `WINDOWS_DIR="release/windows"`, `PUBLISH_WINDOWS_BINARIES` env from the plan output, and after the Linux globs:

```bash
          add_required_glob "$WINDOWS_DIR/desktop-version-windows.json"
          if [[ "$PUBLISH_WINDOWS_BINARIES" == "true" ]]; then
            add_required_glob "$WINDOWS_DIR/latest.yml"
            add_required_glob "$WINDOWS_DIR"/*.exe
            add_required_glob "$WINDOWS_DIR"/*.blockmap
          else
            echo "Windows signing gate is closed; publishing the Windows version feed without the installer."
          fi
```

- Summary step: add `- x64 Windows .exe, latest.yml, and desktop-version-windows.json uploaded as workflow artifacts`, `- Windows release binary upload enabled: ${PUBLISH_WINDOWS_BINARIES}` and `- Windows feed URL: https://github.com/get-bb/bb/releases/download/desktop-latest/desktop-version-windows.json` with the matching `env:` entry.

- [ ] **Step 4: Validate and commit**

Run `node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/build-desktop.yml','utf8'))"` from a script file under the scratchpad (never inline paths through `node -e` in Git Bash; the `yaml` package resolves from `apps/desktop`), same for `ci.yml`; `pnpm exec oxfmt` does not format YAML — hand-check indentation against the neighbouring jobs.

```bash
git add .github/workflows/ci.yml .github/workflows/build-desktop.yml
git commit -m "Build, smoke and publish the Windows desktop installer in CI"
```

The push that triggers `ci.yml` happens in Task 13; `build-desktop.yml` is `workflow_dispatch` and is exercised by the gate with `publish=false`.

---

### Task 12: Documentation — Phase 4 section, desktop README, configuration knobs, platform support

**Files:**

- Modify: `docs/platform-windows.md` (intro :7-12 "Windows Desktop app (Phase 4) … have not landed" → Phase 5 only; Status table row for Phase 4; new section `## Windows Desktop (Phase 4)` before `## Known limitations after Phase 0`; new `## Known limitations after Phase 4` before `## Evidence`; Evidence paragraph for `qa/windows/phase-4/`; the "Known limitations after Phase 3" bullets on the exit code, the runtime-identity design and the six `split("/")` sites rewritten to state what landed; the Phase 2 bullet "Desktop runtime-identity design … deferred to Phase 4" rewritten)
- Modify: `apps/desktop/README.md` (description line; `## Packaging` gains `### Windows (NSIS, x64)`; `## Releasing`/`## Nightly channel` mention the Windows assets; `## Auto-update` gains the Windows paragraph; `## Debugging` gains the Windows launch line; a new `### Windows` subsection under `## Validation` listing the two smokes)
- Modify: `docs/configuration.md` (Desktop env knobs: `BB_DESKTOP_QUIT_REQUEST_FILE`, `BB_DESKTOP_PARENT_PID` — both marked internal/automation), `docs/platform-support.md` (native Windows paragraph: Desktop lands as beta; maintainers build with `dist:windows`), `README.md` (Native Windows (beta) bullet gains "Desktop installer (beta)").
- Verify (no edit expected): `docs/api_to_audit.md`, `packages/plugin-api-map/src/surfaces.ts`, bb-guide API indexes; `docs/superpowers/specs/2026-09-11-native-windows-port-design.md` §7 Phase 4 scope names `winpty.dll`/`winpty-agent.exe` — append "(not present in node-pty 1.2.0-beta.15; ConPTY-only prebuild, see R6)" to that line.

**Facts the Phase 4 section must state** (each measured or ruled; do not soften):

- Build: `pnpm --filter @bb/desktop run dist:windows` produces `release/bb-<version>-x64.exe`, `release/latest.yml` (nightly `bb-nightly-…`, `nightly.yml`) and `release/win-unpacked/`; electron-builder is invoked as `node electron-builder/cli.js` on Windows (the `.bin` shim is a `.cmd`); the first build downloads `winCodeSign` (and `nsis`) into `%LOCALAPPDATA%\electron-builder\Cache`; icons are the checked-in PNGs converted by electron-builder; the installer is assisted, per-user, default `%LOCALAPPDATA%\Programs\bb`, desktop shortcut on, `%APPDATA%\bb` (Electron `userData`: `owned-runtime.json`, window state, cached Connect credential) survives uninstall; `%USERPROFILE%\.bb` is the runtime data dir and is untouched by the installer.
- Signing: mode `windows` with the seven `AZURE_*`/`WINDOWS_PUBLISHER_NAME` keys; unsigned otherwise; no certificate exists; SmartScreen shows "Windows protected your PC" → More info → Run anyway on an unsigned installer (gate records the exact dialog); stable publish withholds unsigned Windows binaries and always publishes `desktop-version-windows.json`.
- Runtime: `bb-app` runs as a hidden, non-detached child of `bb.exe` with `BB_DESKTOP_PARENT_PID`; Quit stops the tree through `terminateProcessTree` (grace 1 s, then the leader through the held handle, then descendants by `creationDate`); a `pid-reused` skip is written to the runtime log; `bb-app` polls its parent every 2 s and shuts down when the parent is gone; no `BB_DESKTOP_RUNTIME_ID` yet (deferred, why).
- Tray and close policy: closing the last window keeps the app in the tray with the runtime alive; `Open bb`/`Quit bb`; Quit stops a spawned runtime and never an attached one; Windows logoff/shutdown (`session-end`) runs the same stop; `BB_DESKTOP_QUIT_REQUEST_FILE` (win32 only) is the automation hook the smokes use.
- Window: `titleBarStyle: "hidden"` with a 48 px caption overlay following the theme; the app reserves 138 px on the right of its header rows; drag regions match macOS; `dev.bb.desktop` is the AppUserModelID (nightly/dev variants).
- Updates: JSON feed `desktop-version-windows.json`, electron-updater `latest.yml`, both under `desktop-latest`; download on availability, install on quit or via Settings; the runtime tree is stopped before `quitAndInstall`; unsigned N → unsigned N+1 works because `publisherName` is unset; the QA feed override is editing `resources/app-update.yml` in the installed copy (R14).
- App file names on Windows hosts come from `hostPathBasename` (drive-absolute/UNC split on both separators); a bb-requested terminal close no longer shows `-1073741510`.
- CI: `windows-x64` packages the unpacked app and runs both smokes with a workspace-local temp root; `build-desktop.yml` builds the NSIS installer on `windows-2025` and the publish job includes the Windows assets.

**Known limitations after Phase 4** (bullets): no certificate / SmartScreen; `BB_DESKTOP_RUNTIME_ID` and the health-response runtime id deferred (verification uses command line + creation date); no `bb://` protocol client or argv forwarding (nothing consumes argv yet); Job Object not used (spec §9 trigger: repeated orphan-gate failures — record the gate's count); `%APPDATA%\bb` is left behind by uninstall by design; the caption overlay height/colours are fixed values (48 px, two theme colours) rather than derived from the app theme tokens; the tray icon is the 1024 px PNG downscaled to 16 px; Windows PowerShell 5.1 code-page and other Phase 3 limitations that still stand; `qa/windows/CHECKLIST.md` still Phase 5.

- [ ] **Step 1: Write the docs**; **Step 2:** `pnpm exec oxfmt` on every touched `.md`; run `pnpm --filter @bb/server exec vitest run test/services/plugins/plugin-authoring-docs.test.ts > <scratchpad>/task12-docs.log 2>&1` (must stay 22/22 green — this plan adds no SDK export, so an unexpected failure means a docs index was edited by mistake); **Step 3: Commit**

```bash
git add docs README.md apps/desktop/README.md
git commit -m "Document the native Windows desktop build, runtime and update path"
```

---

### Task 13: Phase gate and evidence

**Files:**

- Create: `qa/windows/phase-4/00-host.md`, `20-build-installer.md` (+ `.txt`), `21-install-standard-user.md` (+ screenshots `21-smartscreen.png`, `21-installer.png`), `22-use-installed-app.md` (+ `.txt`), `23-update-n-to-n1.md` (+ `.txt`), `24-quit-orphans.md` (+ `.txt`, `process-hygiene/*.json`), `25-close-to-tray.md`, `26-uninstall.md` (+ `.txt`), `27-window-chrome.png`, `30-build-typecheck.txt`, `31-test-results.md`, `31-test-output-tail.txt`, `40-posix-check.md`, `41-ci-run.md`, `42-build-desktop-run.md`
- Modify: `docs/platform-windows.md` only to correct a claim the gate disproves.

Every step records the exact command, its exit code captured in the same shell (`$LASTEXITCODE` in PowerShell, `echo "EXIT=$?"` in Git Bash), versions and pids. Programmatic where possible; a genuinely human-only step is recorded as `MANUAL — for the user` with exact instructions, never faked. The reference desktop user `olege` is a standard (non-admin) account with UAC on and SmartScreen at defaults; a per-user install needs no elevation.

- [ ] **Step 1 — `00-host.md`:** commit, `node -v`, `pnpm -v`, `git --version`, `[Environment]::OSVersion`, `$PSVersionTable.PSVersion`, `whoami /groups | Select-String S-1-5-32-544` (proves non-admin), `Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled` (or `MANUAL` if the cmdlet is blocked), `(Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer" -Name SmartScreenEnabled -ErrorAction SilentlyContinue).SmartScreenEnabled`, Electron/electron-builder versions from `apps/desktop/package.json`, `%LOCALAPPDATA%\electron-builder\Cache` contents, `%LOCALAPPDATA%\Programs\bb` absent, `%APPDATA%\bb` absent.
- [ ] **Step 2 — build/typecheck:** `pnpm exec turbo run build typecheck --output-logs=new-only > qa/windows/phase-4/30-build-typecheck.txt 2>&1`; expected all green.
- [ ] **Step 3 — tests:** `pnpm exec turbo run test --continue --summarize --output-logs=new-only > <scratchpad>/31-full.log 2>&1`, summarise with `node qa/windows/scripts/summarize-turbo-run.mjs` into `31-test-results.md` with the per-package table and a pass→fail delta against `qa/windows/phase-3/31-test-results.md`; every file that flipped pass→fail is re-run isolated and classified (regression → fix in this task with its own commit and re-review; load flake → recorded). `@bb/server` and `@bb/host-daemon` file by file when the full run is load-sensitive. `31-test-output-tail.txt` holds the last 200 lines.
- [ ] **Step 4 — installer build (`20-…`):** `pnpm --filter @bb/desktop run dist:windows 2>&1 | Tee-Object qa/windows/phase-4/20-build-installer.txt; $LASTEXITCODE`; list `release/*.exe`, `release/*.blockmap`, `release/latest.yml` (content: `version`, `path`, `sha512`), `Get-AuthenticodeSignature release\bb-<v>-x64.exe` (expect `NotSigned`), `pnpm --dir apps/desktop run desktop:version-feed` → `release/desktop-version-windows.json` (content). Keep the built `release/` as **build N**; copy `bb-<v>-x64.exe`, `.blockmap` and `latest.yml` to `<scratchpad>/feed-n/`.
- [ ] **Step 5 — install as a standard user (`21-…`):** `MANUAL — for the user` unless the controller can drive it: run `release\bb-<v>-x64.exe`, capture the SmartScreen dialog (`21-smartscreen.png`) and the exact text, click More info → Run anyway, accept the per-user install (default directory), finish with launch unchecked; then programmatically: `Test-Path "$env:LOCALAPPDATA\Programs\bb\bb.exe"`, `Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" | Where-Object DisplayName -like "bb*" | Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString`, Start Menu shortcut path, desktop shortcut path. Silent alternative for a repeatable run: `Start-Process -Wait release\bb-<v>-x64.exe -ArgumentList "/S"` (NSIS silent; SmartScreen still prompts once for the downloaded-file case only — a locally built file carries no Mark-of-the-Web, so document that the SmartScreen dialog must be reproduced with a copy that has MotW: `Set-Content -Path <copy> -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3"` before launching it).
- [ ] **Step 6 — use (`22-…`):** launch `"$env:LOCALAPPDATA\Programs\bb\bb.exe"` with `BB_DESKTOP_VERSION_FEED_URL` unset; wait for `http://127.0.0.1:38886/health` (stop the dev instance first, `pnpm dev:stop`); record `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq <bb.exe pid> -or $_.CommandLine -like "*bb-app-bridge*" }` (bridge, server, daemon pids; `bb.exe` renderer/GPU children); through the app's server: `bb project create --name phase4-gate --root C:\Users\olege\Work\phase4-gate --machine <host>` and one Codex turn (`bb thread spawn … --provider codex … --prompt "Create gate.txt containing 'phase 4'"`, `bb thread wait`), verify the file; open a terminal in the UI (`MANUAL`) or via `bb terminal create`, close it, and record the exit notice the app shows (expect `Terminal exited`, not the negative code); take `27-window-chrome.png` (caption controls over the header, theme switched once).
- [ ] **Step 7 — update N → N+1 (`23-…`):** in a scratch worktree of the same commit, bump `apps/desktop/package.json` and `packages/bb-app/package.json` versions to `<v>+patch` (lockstep; do not commit), `pnpm --filter @bb/desktop run dist:windows`, copy the N+1 `.exe`, `.blockmap` and `latest.yml` to `<scratchpad>/feed-n1/`, generate its `desktop-version-windows.json` there; serve `<scratchpad>/feed-n1/` with `npx --yes serve -l 47000 <dir>` (or `python -m http.server 47000`); edit `"$env:LOCALAPPDATA\Programs\bb\resources\app-update.yml"` → `url: http://127.0.0.1:47000/` (record the original); launch the installed N with `BB_DESKTOP_VERSION_FEED_URL=http://127.0.0.1:47000/desktop-version-windows.json`; observe Settings → Updates: "update available" → downloaded (electron-updater log under `%APPDATA%\bb\logs\` or the app log); click Install (or Quit); record that the runtime tree is gone before the installer runs (`tasklist` during the install), the relaunched app reports N+1 (`window.bbDesktop.version` via the About panel or `bb-app` health `version`), and the `Uninstall` registry entry shows N+1. Restore nothing (the installed copy is now N+1).
- [ ] **Step 8 — Quit and orphans (`24-…`):** start `node -e "setInterval(()=>{},1000)"` as the bystander (record its pid); launch the installed app, wait for health, `tasklist /FO CSV > before.csv`; Quit through the tray menu (`MANUAL` if the controller cannot click; otherwise use the quit-request file `BB_DESKTOP_QUIT_REQUEST_FILE` with the installed copy and note it is the same code path as tray Quit); after 5 s `tasklist /FO CSV > after.csv`; diff and assert zero `bb.exe`/`node.exe` rows from the app's tree remain while the bystander pid is alive; then run `pnpm exec turbo run smoke:windows-processes --filter=@bb/desktop -- --evidence-dir qa/windows/phase-4/process-hygiene` three times against `release/win-unpacked` and record the three exit codes. Also kill `bb.exe` with `taskkill /PID <pid> /F` (simulated Desktop crash) and prove the runtime exits within 5 s through the parent watchdog (`bb-app` log line `Desktop parent process exited`).
- [ ] **Step 9 — close to tray (`25-…`):** with the installed app running, close the window (`taskkill /PID <bb.exe pid>` without `/F` posts `WM_CLOSE`; or `MANUAL`); after 5 s assert `bb.exe` and the runtime pids are still alive and `/health` answers; click the tray icon (`MANUAL`) or send a second instance (`Start-Process bb.exe`) and assert a window reappears (`Get-Process bb | Select-Object MainWindowTitle`); Quit.
- [ ] **Step 10 — uninstall (`26-…`):** `Start-Process -Wait "$env:LOCALAPPDATA\Programs\bb\Uninstall bb.exe" -ArgumentList "/S"`; assert `Programs\bb` is gone, the registry entry is gone, shortcuts are gone, `%APPDATA%\bb` still exists (documented), `%USERPROFILE%\.bb` untouched; then remove `%APPDATA%\bb` manually and note it.
- [ ] **Step 11 — mac/Linux unchanged:** `node scripts/run-electron-builder.mjs --print-config` from `apps/desktop` with a clean env, diff the `mac`, `linux`, `dmg`, `publish`, `files`, `asarUnpack` blocks against 47bb778d8's output (`git stash`-free: run the same command in the WSL clone at the base commit) — identical; record in `40-posix-check.md`.
- [ ] **Step 12 — POSIX check (`40-…`):** in WSL (`~/bb-posix-check`, nvm Node 24.20.0, PATH without `/mnt/c`, `--concurrency=4`): fetch the branch, `pnpm install`, `pnpm exec turbo run typecheck --concurrency=4`, and `test` for `@bb/desktop`, `bb-app`, `@bb/app` (changed files individually), `@bb/host-daemon` (`terminal-*` files), `@bb/process-utils`, `@bb/config`; `pnpm --filter @bb/desktop run package:linux` is optional (FUSE) — at least the `electron-builder-config.test.ts` suite must pass there. Any POSIX failure not present at 47bb778d8 is a gate FAIL.
- [ ] **Step 13 — CI (`41-…`, `42-…`):** push `windows-native/phase-4`; cancel the queued non-Windows runs after the Windows job if they only burn minutes; record the run id, the `Windows x64` result and the three new steps' outcomes; then `gh workflow run build-desktop.yml --ref windows-native/phase-4 -f publish=false -f release_channel=qa` and record the `windows` job result, the artifact name/size list and the `publish` job's plan output (`should_publish=false`, `publish_windows_binaries=false`). If the macOS/Linux jobs fail on the fork for reasons unrelated to this branch (missing secrets, runner labels), record it and the `windows` job's own result.
- [ ] **Step 14 — cleanup and commit:** `pnpm dev:stop` if the dev instance was restarted, delete `C:\Users\olege\Work\phase4-gate`, remove the scratch worktree, restore nothing else; commit the evidence:

```bash
git add qa/windows/phase-4 docs/platform-windows.md
git commit -m "Record the Phase 4 Windows gate evidence"
```

Gate verdict in `31-test-results.md`'s header: PASS only when Steps 2–13 hold; a FAIL names the step and the fix commit that follows. A repeated orphan failure in Step 8 (two of three hygiene runs) triggers spec §9's Job Object response: stop, record, and report to the user rather than widening the smoke's allowlist.
