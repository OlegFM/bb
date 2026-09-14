<!-- Diátaxis: reference -->

# Native Windows (port in progress)

Native Windows 11 x64 is being ported phase by phase; the design is
[docs/superpowers/specs/2026-09-11-native-windows-port-design.md](superpowers/specs/2026-09-11-native-windows-port-design.md).
Until Phase 3 lands, the supported Windows product path stays WSL2 as
described in [platform-support.md](platform-support.md). This page records
what has been measured on native Windows and what is known not to work.

## Status

| Phase                                              | State                                        |
| -------------------------------------------------- | -------------------------------------------- |
| 0 Foundation and honest gating                     | landed; evidence under `qa/windows/phase-0/` |
| 1 Host identity and host-owned paths               | landed; evidence under `qa/windows/phase-1/` |
| 2 Processes, environment, Git, hooks, open targets | landed; evidence under `qa/windows/phase-2/` |
| 3 ConPTY, providers, watcher, native `bb-app`      | not started                                  |
| 4 Windows Desktop                                  | not started                                  |
| 5 Persistent host and GA hardening                 | not started                                  |

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

## Host identity and paths (Phase 1)

- A native Windows daemon reports `platform: "win32"` (`HOST_DAEMON_PROTOCOL_VERSION`
  200); WSL daemons keep reporting `wsl`. The Machines settings label it
  "Windows".
- Project and environment paths may be drive-absolute (`C:\Users\me\repo`,
  `C:/Users/me/repo`). UNC (`\\server\share`), device (`\\.\`) and
  extended-length (`\\?\`) paths — everything that starts with two
  backslashes — are rejected with a message naming an absolute path of either
  flavor as the remedy. A path that starts with two forward slashes is a POSIX
  path, not a UNC path, and stays accepted on POSIX hosts. The request schema
  refuses UNC, device, relative and root paths — a bare drive letter (`C:`)
  counts as a root — with
  HTTP 400 `invalid_request` before any daemon call; for paths that do reach
  it (the environment directory tool and the shape check the server runs
  itself), the local check refuses UNC, device, relative and bare-drive input
  as HTTP 400 `invalid_path` on any host, and the win32 daemon additionally
  refuses a POSIX-shaped path on Windows. A provider-produced path
  the daemon refuses by shape is not a 400: the server binds it as typed with
  trailing separators removed, the value the pre-port server stored.
- The host daemon owns canonical paths: `host.canonicalize_path` returns
  `{ path, pathKey }`. On Windows it resolves the on-disk casing and links
  with `fs.realpath.native` and strips any `\\?\` prefix; when the path does
  not exist yet (`ENOENT`, `ENOTDIR`) it returns the normalized spelling
  instead, so nothing in bb requires a path to exist. On a POSIX host it
  validates the shape only and returns the path as typed with trailing
  separators removed — no `realpath`, no existence check, exactly as before
  the Windows port. `path_key` is the comparison key stored next to `path` on
  `project_sources` and `environments` (`\` → `/`, lower-cased on Windows;
  unchanged on POSIX). `C:/Work/bb`, `C:\Work\bb` and `c:\work\BB` resolve to
  one project and one live environment (partial unique index
  `environments_live_path_key_idx`).
- Only a host whose daemon reports `win32` is asked to canonicalize. A POSIX
  host never receives `host.canonicalize_path`: the server computes the shape
  result itself, which is what that daemon would have returned and what the
  pre-port server stored. An offline host of any flavor takes the same local
  path, so its stored spelling and its shape-derived key follow the rule the
  migration backfill applies and projects can still be registered for a
  disconnected machine. On a `win32` host the daemon's canonical form is
  stored; an `invalid_path` refusal is surfaced as HTTP 400, while a transport
  failure or timeout degrades to the local shape result instead of failing the
  request. The local shape check enforces the same shapes as the daemon — UNC,
  device, relative and bare-drive input is refused — even though no filesystem
  lookup runs. Because the server does not know an offline host's flavor, its
  UNC refusal names an absolute path of either flavor, while a `win32` daemon
  names a drive-letter path.
- Messages for POSIX-shaped input are the pre-port messages, including the
  `experimental_claimPath` refusal a provider sees for a relative claim
  (`Invalid string: must start with "/"`); a drive-absolute claim is accepted
  in addition.
- Creating a project on a connected host looks its source up by shape key
  first; on a miss, it canonicalizes the path — through the daemon on a
  `win32` host, locally everywhere else. Re-adding an existing project whose
  directory was later removed still returns the existing project, and a
  directory that does not exist yet is registered under its normalized
  spelling; only a refused shape returns 400 `invalid_path`.
- `deriveRepoDirName` in the workspace plugins and `deriveProjectNameFromPath`
  accept drive-letter paths with either separator; UNC sources are refused
  (`invalid_source_path` in the plugins).
- The app accepts `C:\...` and `C:/...` file paths and renders them as
  `file:///C:/...` links.
- Managed worktrees and personal workspaces are derived with the host's
  native separator under the provider plugin's host-data directory inside
  the daemon data dir (`%USERPROFILE%\.bb` in production,
  `%USERPROFILE%\.bb-dev\<instance>` for a dev app). The gate observed
  `<data dir>\plugins\environment-git-worktree\host-data\worktrees\<thread>-<attempt>\<repo>`
  (`qa/windows/phase-1/22-managed-worktree.md`). The server's managed-root
  containment check still compares against `<data dir>\worktrees` and
  `<data dir>\personal-workspaces`, the legacy roots, on every platform; that
  mismatch predates this branch and is not changed by it.

## Processes, hooks, git and open targets (Phase 2)

- **Environment hooks.** The Windows hook contract is `.bb-env-setup.ps1` and
  `.bb-env-teardown.ps1` (`packages/domain/src/setup-script.ts`), run through
  `pwsh.exe` when present, else `powershell.exe`, with
  `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <abs>`. cwd,
  the sanitized environment (`BB_*` and `NODE_ENV` stripped, PATH resolved),
  the 15-minute timeout, transcript streaming, and cancellation are the same as
  POSIX; cancellation and timeout stop the hook's process tree through
  `terminateProcessTree` instead of a signal. A workspace that has only the
  `.sh` hook on Windows fails setup with a message naming the `.ps1` contract
  (`.bb-env-setup.sh is a POSIX shell script; on Windows bb runs
.bb-env-setup.ps1 instead (pwsh.exe or powershell.exe)`) rather than
  skip-and-continue; a `.sh`-only teardown hook reports the same failure with
  the teardown names (`.bb-env-teardown.sh is a POSIX shell script; on Windows
bb runs .bb-env-teardown.ps1 instead (pwsh.exe or powershell.exe)`) without
  blocking worktree removal. There is no Git Bash fallback for hooks.
- **Git layer.** `detectSquashMerge` (`packages/host-workspace/src/workspace.ts`)
  pipes `git diff`/`git log -p` into `git patch-id` through
  `runGitOutputPipeline` on win32 instead of `runShellPipeline`'s POSIX
  `sh -c 'a | b'`: the win32 path spawns both git processes directly (no
  shell) and treats either one failing as a pipeline failure, so a failing
  `git diff` correctly makes `detectSquashMerge` return `false`. On POSIX,
  `sh -c` reports only the last command's exit status, so the same failing
  `git diff` piped into a succeeding, empty-output `git patch-id` reads as
  "squash-merged" (`true`) instead. A `maxBuffer` overflow on the win32
  pipeline is reported as `shell_pipeline_failed`, matching the POSIX error
  code for the equivalent failure. `findWorktreeForBranch`
  (`packages/environment-provider-host/src/git.ts`) needs no Windows-specific
  parsing: `git worktree list --porcelain` already emits `/`-separated,
  `C:/`-shaped paths on Windows, so the porcelain parse is unchanged; it is
  `detectLinkedWorktree`'s `isLinkedWorktreeGitDir`
  (`packages/host-workspace/src/git.ts`) that normalizes `\` to `/` in
  `git rev-parse --git-dir` output before checking for `/worktrees/`, since
  that command's output is not guaranteed forward-slash-only the way
  `worktree list --porcelain` is.
- **PATH resolution.** `runtime-shell-env.ts` on win32 reads
  `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path` and
  `HKCU\Environment\Path` through `reg.exe query … /v Path` (REG_EXPAND_SZ
  expanded against the daemon's own environment), joins machine then user,
  then runs a PowerShell profile probe (`pwsh.exe` if found, else
  `powershell.exe`) that prints `__BB_SHELL_ENV_START__`, base64
  `Name=Value` pairs, `__BB_SHELL_ENV_END__`. Precedence: the probe's `Path`
  wins when the last marker pair parses; otherwise the registry PATH;
  otherwise the previously resolved `Path` cached by the daemon's shell-path
  resolver (`createUserShellPathResolver`'s `previousPath`, seeded from an
  earlier successful resolution); otherwise the daemon's own inherited
  `Path`. The probe timeout is 8 seconds
  (PowerShell cold start measured at about 2.6 s). An `SHELL` variable
  pointing at an sh-like shell is ignored on win32 — bb's own probes never run
  Git Bash.
- **Stop sequence.** `terminateProcessTree` implements the identity rules from
  spec §5 on win32: the leader is asked to exit through
  `taskkill.exe /PID <leader> /T` (no `/F`), then force-killed only through
  the `ChildProcess` handle bb still holds and only while
  `exitCode === null && signalCode === null` — a PID cannot be recycled while
  a handle to it is open. Descendants are re-snapshotted after the grace
  period and each one is force-killed individually (`taskkill.exe /PID <pid>
/F`) only when its `CreationDate` still matches the snapshot taken before
  the leader was signalled; a mismatch is skipped and reported through
  `onSkippedProcess({ pid, reason: "pid-reused", expectedCreationDate,
observedCreationDate })`, which the daemon logs as `pid-reused`. No forced
  kill ever targets a bare PID whose identity was not re-verified. On win32,
  `killProcessGroup` stays `child.kill(signal)` and is leader-only there — it
  does not walk descendants; callers that need the full tree use
  `terminateProcessTree`. There is no Job Object in this phase: a descendant
  bb never observed (never snapshotted, so it has no recorded `CreationDate`
  to verify against) can still escape the tree and is not swept by the stop
  sequence — this is the risk spec §9 records as open, closed only for the
  recycled-PID case, not the escaped-descendant case; the trigger to add a
  native Job Object helper is a repeated Phase 4 "zero orphans after Quit"
  gate failure. `terminateProcessTree` never rejects on a Windows enumeration
  failure — the leader stop still runs and the result carries an
  `enumerationError` with empty descendant arrays — but the sweep below
  propagates enumeration failure as an error instead of returning an empty
  list, because a silent `[]` would read as "nothing to kill".
- **Process sweep.** `killProcessesWithCwdUnder` (used to reap a managed
  workspace before removing it) enumerates with `Get-CimInstance
Win32_Process` (measured cost about 0.55 s here; cold PowerShell start about
  2.6 s) instead of reading `cwd` from `/proc`, so every Windows match carries
  `approximateCwd: true` and a `matchEvidence` of `"spawn-registry"` (bb
  itself spawned the process with a known cwd), `"executable-path"` (the
  process's own exe path is under the directory), `"command-line"` (the
  directory string appears in the process's command line, reported by
  `listProcessesWithCwdUnder` but never killed by the sweep — an editor or
  terminal opened on the worktree carries the path in argv), or `"descendant"`
  (a child of an already-matched process). Each kill candidate's
  `CreationDate` is re-verified against a fresh snapshot immediately before
  its own `taskkill /PID <pid> /F`; a mismatch is skipped and reported through
  `onSkippedProcess` rather than killed blind — there is no graceful signal
  step on this path, unlike POSIX's SIGTERM-then-SIGKILL. A 10-second
  enumeration timeout is an error (`WindowsProcessEnumerationError`), never an
  empty list — an empty list would look like "nothing to kill" and leave a
  live tree behind. `killProcessesWithCwdUnder` matches with
  `includeCommandLineEvidence: false`, so only `spawn-registry`,
  `executable-path` and `descendant` evidence actually gets a process killed;
  a `command-line`-only match surfaces through `listProcessesWithCwdUnder`
  (and its `matchEvidence`) but is never itself a kill target. Because there
  is no real cwd query, two mismatches are possible and are reproduced in
  `qa/windows/phase-2/26-process-enumeration.md`: an **under-match**, a
  process whose cwd is genuinely under the directory but whose command line
  and executable path do not mention it (a real target the sweep misses,
  regardless of evidence kind), and an **over-match** on the kill path, a
  process whose own executable happens to live under the directory (for
  example a locally built binary still running from a different cwd) and so
  matches on `executable-path` evidence even though its cwd is elsewhere (a
  false positive the sweep kills). A `command-line`-only false positive is a
  reporting-only over-match: `listProcessesWithCwdUnder` shows it, but the
  sweep does not kill it. Consequence: a process the user started themselves
  with a cwd under a worktree is not stopped and worktree removal fails with
  EBUSY.
- **Secrets.** `@bb/secret-storage` on win32 creates a secret file empty with
  `wx`, tightens it with `icacls.exe <file> /inheritance:r /grant:r *<SID>:F`
  (the SID from `whoami.exe /user /fo csv`, cached per process), and reads the
  ACL back: the output must be exactly one ACE line whose identity is the
  current account name or SID and whose rights are `(F)`, or the write is
  rejected. Only after that read-back succeeds are the secret bytes written (a
  staged temp file, tightened and verified, then published onto the final path
  with a hard link so concurrent creators agree on one value and the final
  path is never observed empty). An existing file is tightened and verified
  the same way on first read per process, and the verification is cached for
  the process lifetime. A legacy empty file is repaired by moving it aside,
  and `readSecretFile` still returns `""` for it, matching POSIX. Any failure
  in this sequence removes the empty or staged file and throws an error
  naming the path and the remedy: put the data directory on an NTFS volume.
  Secret file names must be ASCII; with a non-ASCII Windows account name,
  `icacls`/`whoami` output may show replacement characters. `plugins/account-pool`,
  `plugins/secrets`, and the host daemon's own `auth-state.ts` and
  `identity.ts` files are out of scope — see Known limitations.
- **Junctions.** `path-mutations.ts` already refuses every reparse point
  (`fs.lstat().isSymbolicLink()` is `true` for a Windows junction) for move
  and remove, because `requireExistingWithin` resolves the target through
  `fs.realpath` first — lifting that guard would mutate the junction's target
  directory instead of the link itself. Phase 2 adds win32 tests for remove,
  move, and a junction-substitution race, each asserting the target directory
  is untouched; nothing in the refusal logic changed.
- **Open targets and picker.** `local-open-targets` gains a `windows`
  launch-adapter arm beside `macos`: Explorer (`explorer.exe /select,<path>`
  for a file, `explorer.exe <dir>` for a directory; exit code 1 counts as
  success only when the path exists — Explorer's own quirk), Windows Terminal
  (`wt.exe -d <dir>`) with a visible `pwsh.exe`/`powershell.exe` console as
  the fallback when `wt.exe` is not installed, VS Code family discovery
  through `resolveExecutable` (a `Path` + `PATHEXT` walk, no `where.exe`), the
  `HKLM`/`HKCU
\Software\Microsoft\Windows\CurrentVersion\App Paths\<exe>` registry keys,
  and `%LOCALAPPDATA%\Programs` / `%ProgramFiles%`, JetBrains Toolbox under
  `%LOCALAPPDATA%\JetBrains\Toolbox`, the default app through
  `explorer.exe <file>` (ShellExecute — not `cmd.exe /c start`), and `.cmd`
  editor shims launched through `readNodeCmdShim` first, falling back to
  `cmd.exe /d /s /c <shim>` for a shim that is not a recognized node wrapper.
  Icons are the static per-adapter icon; nothing is extracted from the target
  executable. The folder picker gains a win32 arm that runs a PowerShell
  `System.Windows.Forms.FolderBrowserDialog` under `-STA`; the desktop app on
  Windows uses this daemon picker the same way it already uses the daemon's
  `osascript` picker on macOS, rather than an Electron dialog.
- **The `bb` launcher.** `apps/cli/bin/bb` is unchanged: it is still the POSIX
  `#!/bin/sh` script that `exec`s node on the built CLI entry. Windows is
  served by a sibling `apps/cli/bin/bb.cmd`, a one-line
  `@node "%~dp0..\dist\index.js" %*` shim, so `bb` works unmodified from
  `cmd.exe` and PowerShell (both find `.cmd` through PATHEXT) while `bb.cmd`
  is the name to call explicitly from a script that must not rely on PATHEXT.
  `apps/cli/bin/title.cmd` is `@title %*`, using cmd's own built-in. The
  daemon bundle and the `bb-app` host package ship a `bb.cmd` of their own
  (`@node "%~dp0bb" %*`, pointing at the bundled entry beside it); automations
  and other spawners that need bb's own path read `BB_CLI`, which on win32
  points at the `bb.cmd` shim. Nothing in bb runs a `.cmd` through `cmd.exe`
  or through a shell: a `.cmd` on `BB_CLI` is parsed with `readNodeCmdShim`
  and started as `node <script>`, and a `.cmd` that is not a Node shim is
  refused with `Windows launcher <path> is not a Node shim bb can start
directly`.
- **Automations interpreters.** `automationScriptInterpreterSchema` gains
  `"powershell"`, mapped from a `.ps1` script file. On win32, `bbBinaryCandidates`
  adds `bb.cmd` beside `bb` for `BB_CLI_DIR` and every PATH entry (the
  Homebrew fallback paths are POSIX-only and are not tried); each interpreter
  resolves through its own mechanism instead of a bare spawned name:
  `resolveWindowsInterpreterCommand` in `plugins/automations/src/script-files.ts`
  uses the daemon's own `process.execPath` for `node` (no PATH walk),
  `resolvePowerShellExecutable` for `powershell` (a `pwsh.exe` PATH scan,
  then `%ProgramFiles%\PowerShell\7\pwsh.exe`, then Windows PowerShell 5.1 at
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`), and
  `resolveExecutable` (a `Path` + `PATHEXT` walk) for `bash`, `sh`, and
  `python3` (falling back to `python`). `"powershell"` on POSIX resolves to
  `pwsh`. The extension mapping is not
  Windows-only: on macOS and Linux a stored `.ps1` automation that previously
  fell through to the default `bash` interpreter now runs under `pwsh` and
  fails with a spawn error when PowerShell 7 is not installed. Set
  `--interpreter bash` explicitly on such an automation, or rename the script.
- **Skill scripts.** bb never spawns an agent skill's own script itself —
  agents run their skill scripts through whatever shell the agent's own
  session uses — so this is guidance for agents on Windows, not a code path
  bb owns (see Known limitations). Per spec §6: a `.ps1` script runs through
  PowerShell with the same flags as bb's own probes; `.cmd`/`.bat` run through
  `cmd.exe /d /c <file> args…` with the file path as its own argv element;
  `.js`/`.mjs`/`.cjs` run through node; `.sh` and extensionless shebang files
  run through `sh.exe` from Git for Windows when it is present, otherwise the
  agent should fail loudly naming the file and the remedy (install Git for
  Windows, or provide a `.ps1`/`.cmd` equivalent).

## Known limitations after Phase 0

- Project paths became drive-letter aware in Phase 1 (see "Host identity and
  paths" above); terminals, hooks and provider launch on native Windows still
  arrive in Phases 2 and 3.
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

## Known limitations after Phase 1

- Environment claims (`experimental_claimPath`) are keyed by path shape on
  the server, since a claimed path may not exist yet. At bind time, the
  daemon-canonical key replaces the row's own claim only when the provider
  produced exactly the path it claimed (the produced path's shape key equals
  the claim); any other mismatch is refused as before.
- `isBbManagedWorkspacePath` containment compares the daemon-canonical
  candidate against roots built from the daemon-canonical data directory (one
  extra `host.canonicalize_path` call, with a shape-based fallback when the
  host is offline or the daemon refuses the data directory), but the thread
  placement pre-check still compares the raw data directory against the raw
  candidate path. With a symlinked or junctioned data directory, a request
  can pass the placement pre-check and then be refused at provisioning with a
  provisioning error instead of a clean 409.
- `listEnvironments`'s `path` query filter compares raw paths, not path keys.
- App views that derive a file name with `split("/")`
  (`environment-queries.ts`, `project-queries.ts`, `api.ts`,
  `plugin-slot-resolvers.ts`, `file-opener-tabs.ts`, `rightPanelFileVisuals.ts`)
  show the full Windows path until Phase 3.
- The host directory browser cannot switch drives.
- The native folder picker was macOS-only after Phase 1; Phase 2 adds the
  Windows picker — see "Open targets and picker" above.
- The workspace plugin `host.test.ts` suites still shell out to `mkdir -p`/
  `sleep` and fail on Windows (Phase 2).
- `resolveInheritedDevSkillsRootPaths` is measured only on the reference
  desktop.
- Provider environment creation makes two canonicalization calls per create
  (the produced path and the data directory); the data directory answer is
  not cached per session.
- Provider containment (`findProviderEnvironmentContainingPathKey`) uses a
  `LIKE key || '/%'` prefix match: a provider owning a filesystem or drive
  root never matches its children, and `_`/`%` characters in a key are
  treated as wildcards (pre-existing behavior, now applied to path keys).

## Known limitations after Phase 2

- The Desktop runtime-identity design (`BB_DESKTOP_RUNTIME_ID`,
  `BB_DESKTOP_PARENT_PID`, a parent-PID watchdog) that spec §5 describes for
  verified process stop is deferred to Phase 4, where Desktop's owned-runtime
  policy needs it; Phase 2's `verified-process-stop.ts` win32 arm verifies
  through `queryWindowsProcess` instead.
- `plugins/account-pool`, `plugins/secrets`, and the host daemon's own
  `auth-state.ts` and `identity.ts` own their secret files directly and are
  not ACL-hardened by this phase.
- `pnpm dev:stop` still force-kills the pid recorded in a session's pid file
  after checking only that the pid exists; verifying process identity before
  a forced kill is developer tooling, not a product seam, and stays
  unverified.
- `apps/server/src/services/plugins/update-resolver.ts` calls
  `git ls-remote <url>` with a Windows path as the URL when a plugin update
  source is a local path; this is a pre-existing upstream finding, not fixed
  in this phase.
- `plugins/github/server.ts`'s `run()` helper spawns `gh` with an unsanitized
  inherited environment; this is a pre-existing upstream finding, not fixed
  in this phase.
- `provider-maintenance-kit`'s `experimental_resolveExecutablePath` and its
  PATHEXT-aware installer commands arrive in Phase 3 alongside provider
  launch.
- Terminal sweep-root registration (`registerSweepRootProcess` wired to
  node-pty's reported pid) arrives in Phase 3 with ConPTY.
- Open targets on Windows use static per-adapter icons; there is no icon
  extraction from the target executable the way some platforms support.
- JetBrains Toolbox version selection under
  `%LOCALAPPDATA%\JetBrains\Toolbox\apps` picks lexicographically, not by
  parsed version number.

## Evidence

`qa/windows/phase-0/` holds host facts, install output, the native add-on
check, the dev launcher transcript and the per-package test baseline.

`qa/windows/phase-1/` holds host facts (`00-host.md`), the build and
typecheck log (`30-build-typecheck.txt`), the per-package test results and
output tail (`31-test-results.md`, `31-test-output-tail.txt`), a UI- and
CLI-created project on `C:\` (`20-project-on-c.md`), three path spellings
resolving to one project id plus a UNC 400 (`21-path-identity.md`), a managed
worktree provisioned and removed (`22-managed-worktree.md`), the WSL POSIX
test run (`40-posix-check.md`), and the `windows-x64` CI run
(`41-ci-run.md`).

`qa/windows/phase-2/` holds host facts (`00-host.md`), the build/typecheck log
and per-package test results (`30-build-typecheck.txt`, `31-test-results.md`,
`31-test-output-tail.txt`), a hook that streams, times out (or is cancelled)
and leaves no descendants (`20-hook-stream-timeout-cancel.md`), a PID-reuse
stress run (`21-pid-reuse-stress.md`), a secret file's ACL read-back
(`22-secret-acl.md`), the junction test summary (`23-junctions.md`), open
targets opened from Explorer, VS Code and Windows Terminal
(`24-open-targets.md`), `bb` run from PowerShell including a directory with a
space (`25-bb-from-powershell.md`), process enumeration over-match and
under-match cases (`26-process-enumeration.md`), the WSL POSIX test run
(`40-posix-check.md`), and the `windows-x64` CI run (`41-ci-run.md`).
