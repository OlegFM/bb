<!-- Diátaxis: reference -->

# Native Windows (port in progress)

Native Windows 11 x64 is being ported phase by phase; the design is
[docs/superpowers/specs/2026-09-11-native-windows-port-design.md](superpowers/specs/2026-09-11-native-windows-port-design.md).
Until Phase 3 lands, the supported Windows product path stays WSL2 as
described in [platform-support.md](platform-support.md). This page records
what has been measured on native Windows and what is known not to work.

## Status

| Phase | State |
|---|---|
| 0 Foundation and honest gating | landed; evidence under `qa/windows/phase-0/` |
| 1 Host identity and host-owned paths | not started |
| 2 Processes, environment, Git, hooks, open targets | not started |
| 3 ConPTY, providers, watcher, native `bb-app` | not started |
| 4 Windows Desktop | not started |
| 5 Persistent host and GA hardening | not started |

## Prerequisites for a source checkout

- Windows 11 x64 (build 26100 or newer).
- Node 22.19.x from `.nvmrc` through any Node manager whose switch is global
  (nvm-windows: `nvm install 22.19.0 && nvm use 22.19.0`), then pnpm 9.15.0
  through `corepack enable`.
- Git for Windows 2.52 or newer with `git config --global core.longpaths true`
  and `core.symlinks true`; `LongPathsEnabled` set to `1` under
  `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem`; Developer Mode enabled
  for symlink creation without elevation.
- Visual Studio Build Tools (Desktop development with C++) and Python 3.11+
  are only needed when a native add-on has no usable prebuild;
  `scripts/ensure-native-modules.mjs` says so explicitly when that happens.

## Native add-ons

Measured on Windows 11 Pro 10.0.26200 (see `qa/windows/phase-0/11-native-modules.md`
and `12-prebuild-inventory.md`):

- `better-sqlite3@12.10.0` installs a `win32-x64` prebuild for Node ABI 137
  (Node 24) and 127 (Node 22).
- `node-pty@1.2.0-beta.15` ships N-API prebuilds under `prebuilds/win32-x64/`
  (`conpty.node`, `conpty_console_list.node`, `conpty/conpty.dll`,
  `conpty/OpenConsole.exe`); no compiler is needed.
- `@parcel/watcher@2.5.6` resolves `@parcel/watcher-win32-x64`.

`node qa/windows/scripts/conpty-load-check.mjs` loads all three and echoes
through a real ConPTY; it runs in the `windows-x64` CI job.

## Known limitations after Phase 0

- The product still rejects drive-letter project paths; terminals, hooks and
  provider launch on native Windows arrive in Phases 1 to 3.
- `packages/bb-app` and `apps/desktop` now list `win32` in their `os` fields
  (spec §7), so `npx bb-app` installs on native Windows but its runtime does
  not work until Phases 1 to 3 land; the supported product path stays WSL2
  per [platform-support.md](platform-support.md).
- `scripts/ensure-native-modules.mjs` detaches a pnpm-hardlinked
  `better-sqlite3` binary before repairing it; on the reference desktop that
  binary was not hardlinked (`nlink` = 1 in
  `qa/windows/phase-0/11-native-modules.md`), so the detach path has not yet
  been exercised on NTFS.
- ConPTY keeps the Node event loop alive after the child exits, so a script
  that spawns through `node-pty` must call `process.exit` itself;
  `qa/windows/scripts/conpty-load-check.mjs` does.
- On Windows the launcher starts each session through a detached, hidden
  Node "session host" (`packages/scripts/src/commands/run-dev-app-session-host.ts`)
  because libuv puts every non-detached child in a kill-on-close job object;
  `pnpm dev:stop` runs `taskkill /T` on the host. Measured on the reference
  desktop (`qa/windows/phase-0/20-dev-app.txt` §6, §9, §12): no console
  window appears; the dev server keeps answering `/health` and
  `pnpm dev:status` still reports it running after the launcher exits; and
  the session survived closing the PowerShell window that started it.
- `pnpm dev:stop` force-kills the pid recorded in a session's pid file after
  checking only that the pid exists (`taskkill /T /F` on Windows, `SIGTERM`
  then `SIGKILL` on POSIX); verifying the process identity (start time) before
  a forced kill arrives with Phase 2's process primitives (spec §5), so delete
  a stale pid file by hand after a crash or reboot before running `dev:stop`.
- A cold `pnpm dev:desktop` exceeds the launcher's 120 s desktop wait: the
  launcher exits 1 with "Timed out ... waiting for desktop app" while the
  detached build keeps running, and the Electron window opened about
  3 min 14 s after launch (§11). Run `pnpm dev:status` until it reports the
  desktop session running instead of relaunching.
- `pnpm install` prints `WARN Failed to create bin ... .EXE` for every
  workspace bin whose `dist/` has not been built yet; pnpm cannot create the
  `.bin` shim until the package builds. Everything measured in this phase
  ran after an install that printed them (`10-install.txt`, then
  `20-dev-app.txt`).
- The `bb/no-tmp-path-literal` lint rule runs only in packages with a `lint`
  script (`@bb/app`, `@bb/mobile`); the vitest configs are covered by
  `packages/scripts/test/vitest-config-tmp-literals.test.mjs` instead.
- The Windows CI leg (`windows-x64` in `.github/workflows/ci.yml`) is not a
  required check and carries no Turbo cache; its test step runs with
  `continue-on-error: true`, so it records a baseline and never fails the
  job.

## Evidence

`qa/windows/phase-0/` holds host facts, install output, the native add-on
check, the dev launcher transcript and the per-package test baseline.
