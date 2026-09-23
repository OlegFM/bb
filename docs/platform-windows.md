<!-- Diátaxis: reference -->

# Native Windows (beta)

Native Windows 11 x64 is being ported phase by phase; the design is
[docs/superpowers/specs/2026-09-11-native-windows-port-design.md](superpowers/specs/2026-09-11-native-windows-port-design.md).
Phase 3 landed terminals, provider launch and installation, the file watcher
and the native `bb-app` runtime, and Phase 4 landed the Windows Desktop app:
the server, the host daemon, terminals and providers run directly on Windows
without WSL2, and the Electron shell packages, installs, supervises, updates
and uninstalls that runtime from a per-user NSIS installer. Phase 5 adds the
PowerShell persistent-host installer and explicit target-shell pairing UI;
its real logon, clean-VM, live Connect, and full regression acceptance remain
pending. That path is beta: no Windows code-signing certificate exists yet,
and WSL2 stays the stable Windows path described in
[platform-support.md](platform-support.md). This page records what has been
measured on native Windows and what is known not to work.

## Status

| Phase                                              | State                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| 0 Foundation and honest gating                     | landed; evidence under `qa/windows/phase-0/`                                |
| 1 Host identity and host-owned paths               | landed; evidence under `qa/windows/phase-1/`                                |
| 2 Processes, environment, Git, hooks, open targets | landed; evidence under `qa/windows/phase-2/`                                |
| 3 ConPTY, providers, watcher, native `bb-app`      | landed; evidence under `qa/windows/phase-3/`                                |
| 4 Windows Desktop                                  | landed; evidence under `qa/windows/phase-4/`                                |
| 5 Persistent host and GA hardening                 | installer/UI and local regression hardening implemented; acceptance pending |

## Persistent execution machine (beta)

Settings → Machines → Add machine has an explicit **Windows PowerShell**
choice; **macOS / Linux** remains the default regardless of the browser or
server OS. The Windows choice downloads `/install.ps1` into a unique temporary
`.ps1`, invokes `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy
Bypass -File` with single-quoted named arguments, checks the child exit, and
removes only the downloaded file in `finally`. Download errors terminate the
command. This does not change the user's persistent execution policy or PATH.

Enrollment requires Windows 11 x64, Windows PowerShell 5.1 or PowerShell 7,
Node 22.19+ with npm available alongside Node, and drive-local NTFS storage
whose user-only ACL can be enforced. Install provider CLIs separately; the
source-checkout prerequisites below are only needed for source development or
native dependency compilation when a prebuild is unavailable.

The installer accepts:

| Flag                     | Behavior                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `-JoinCode <code>`       | Required server-issued enrollment code.                                                                                           |
| `-HostId <id>`           | Required host identity returned with the join code.                                                                               |
| `-Server <origin>`       | Required HTTP(S) origin; credentials, paths, queries, and fragments are rejected.                                                 |
| `-MachineCode <code>`    | Optional one-time Connect machine code for the account-gated server URL.                                                          |
| `-HostDaemonPort <port>` | Optional loopback API port, `1`–`65535` except Desktop's `38887`; fail if an unrelated listener owns an explicitly selected port. |
| `-Help` / `-h`           | Print usage without enrolling.                                                                                                    |

`bb machine join-code --json` and `sdk.hosts.createJoinCode()` supply
`{joinCode, hostId, expiresAt}`. For Connect, the server must already be paired;
`bb connect machine-code --json` currently also requires the **Mobile app**
experiment (`bb settings experiment mobileApp true`). Use the returned `code`
and `serverUrl` for `-MachineCode` and `-Server`. The equivalent existing SDK
operation is the Connect `createMachineCode` RPC through `sdk.plugins.callRpc`;
the Add machine UI calls it directly. See
[multiple-devices.md](multiple-devices.md#pair-through-cli-or-sdk) for inputs and
code expiry. Direct reachable origins omit `-MachineCode`.

The installer only installs the exact host-only `/install/bb-app.tgz` served by
this server and requires its SHA-256 header before npm runs. It never reuses a
global `bb-app` or falls back to a registry. Conditional artifact reuse requires
a complete local install and its saved digest. The private npm prefix is
`<data>\npm`; the daemon's launcher enables `--auto-update` against its own
server and restarts it after exit.

Storage defaults to
`%USERPROFILE%\.bb-machines\<SHA-256-of-normalized-server-origin>`, with logs,
identity, configuration, port metadata, and launcher isolated per server.
Set `$env:BB_DATA_DIR` before running the installer to choose a custom absolute
drive-local directory. Drive roots, UNC/device paths, reparse points, alternate
streams, quotes, percent signs, and control characters are unsupported. The
installer refuses incompatible existing host/server enrollment. Ports are
atomically reserved under `%USERPROFILE%\.bb-machines\host-daemon-ports`, even
for custom data; selection starts at `38888`. A stale occupied port is
reassigned when no explicit port was requested. It never stops unrelated
listeners. The full app/Desktop data directory `~/.bb` remains separate.

After matching host/server connected status is confirmed, the installer
registers a limited per-user Scheduled Task at logon named
`bb-host-daemon-<origin-hash>`. If registration is denied, the same name is used
under `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run`. Reruns keep one
startup registration. A hidden supervisor uses absolute executable paths and
the enrollment's environment; no join or machine code is saved in the launcher.
Logs append to `<data>\logs\host-daemon.log` and
`<data>\logs\supervisor.log`.

Desktop broker discovery recognizes the origin-hash directory names produced
by PowerShell 5.1 and 7, including their IDN and IPv6 spellings. A custom data
directory must still be supplied explicitly. The broker descriptor is
published with a current-user-only ACL before token content is written;
Desktop checks its owner, permissions, file type and content through the same
opened handle. The [local hardening report](../qa/windows/phase-5/05-local-hardening.md)
records native discovery, rejection, reconnect and replacement-contention
tests. These tests do not replace the pending Desktop coexistence acceptance.

Use the exact data and service names printed by the installer. To restart,
stop its verified supervisor with the generated helper, then start the launcher
hidden:

```powershell
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '<data>\stop-host-daemon.ps1'
Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<data>\start-host-daemon.ps1"' -WindowStyle Hidden
```

The stop helper verifies the supervisor PID, executable, and start time before
stopping its process tree; an identity mismatch stops nothing. For removal,
follow the installer's printed commands in order: unregister its Scheduled
Task and matching HKCU Run entry, run `stop-host-daemon.ps1`, then remove only
that enrollment's data directory and its exact port reservation file. Remove
the machine from Settings or with `bb machine remove <id-or-name>`, and revoke
its Connect credential in the getbb.app dashboard when applicable. Startup
removal alone leaves the current supervisor running and preserves data.

Fixture tests of these commands do not establish real user logon restart,
clean-VM installation with WSL disabled, live Connect pairing, or Desktop
coexistence. Those gates, signing, full Windows baseline remediation, and
external required-check configuration remain pending in
[qa/windows/CHECKLIST.md](../qa/windows/CHECKLIST.md). Native Windows remains
beta until measured acceptance closes them.

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
  201; it was 200 through Phase 2 and Phase 3 bumped it for the provider
  installation status field described below); WSL daemons keep reporting
  `wsl`. The Machines settings label it "Windows".
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
  the leader was signalled; a mismatch is skipped and offered to an optional
  `onSkippedProcess({ pid, reason: "pid-reused", expectedCreationDate,
observedCreationDate })` callback. The skip is reported only where a caller
  wires that callback — the environment hook runner
  (`apps/host-daemon/src/environment-lifecycle-script.ts`), which writes it to
  the provisioning transcript, and, since Phase 3, the worktree and
  personal-workspace sweeps, which write it to the plugin host's stderr. The
  callers that still do not wire it — provider installation cancel
  (`apps/host-daemon/src/provider-installation.ts`), the shell-environment
  probe (`runtime-shell-env.ts`), the automations script runner and
  `stopVerifiedProcess` — skip silently, and on a sweep path the later `EBUSY`
  on the directory is the visible symptom. No forced
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
  its own `taskkill /PID <pid> /F`; a mismatch is skipped rather than killed
  blind and offered to the same optional `onSkippedProcess` callback, which
  both sweep callers wire since Phase 3 (see "Sweep skip reporting" below), so
  a recycled-PID skip on this path is printed to the plugin host's stderr
  rather than leaving the later `EBUSY` as the only symptom. There is no
  graceful signal step
  on this path, unlike POSIX's SIGTERM-then-SIGKILL. A 10-second
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
  That remedy does not cover every failure. On an account with full
  administrator rights the read-back can still show
  `NT AUTHORITY\SYSTEM:(F), BUILTIN\Administrators:(F), <user>:(F)` after a
  successful tighten, on NTFS, and the server then refuses to start —
  measured on a GitHub `windows-2025` runner during the Phase 3 gate
  (`qa/windows/phase-3/41-ci-run.md`). Keep such a data directory out of the
  administrator profile's temp directory until the check is revisited.
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
  `pwsh`. `.ps1` files select the `powershell` interpreter automatically on
  Windows; on macOS/Linux pass `--interpreter powershell` (or store it)
  explicitly. The extension mapping is gated on `platform === "win32"` in both
  `plugins/automations/src/script-files.ts` and
  `plugins/automations/src/cli.ts`, so a stored macOS or Linux automation
  whose script file ends in `.ps1` and whose `interpreter` column is empty
  keeps falling through to `bash` exactly as it did before Phase 2.
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

## Terminals, providers, watcher and native `bb-app` (Phase 3)

- **Terminal shell.** `resolveDefaultTerminalShell`
  (`apps/host-daemon/src/terminals/terminal-manager.ts`) takes the first of:
  `pwsh` resolved from `Path`, accepted only when the resolved file is a
  console image (`.exe` or `.com`); `%ProgramFiles%\PowerShell\7\pwsh.exe`;
  Windows PowerShell 5.1 at
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`; `ComSpec`;
  and `%SystemRoot%\System32\cmd.exe`. When none exists the open fails with
  error code `shell_unavailable` and the message `No terminal shell was found:
tried pwsh.exe, powershell.exe, ComSpec and cmd.exe`. The app renders the
  message and ignores the code, so the new code needed no protocol bump.
- **Start modes.** An interactive terminal starts with `-NoLogo` on PowerShell
  and no arguments at all on `cmd.exe`. There is no `-NoProfile`: the user's
  profile runs exactly as it does in their own terminal, which also means a
  profile that emits OSC or CSI sequences emits them into the session. bb
  answers only the primary device attributes query (DA1) itself, and never
  replays a query back to the shell; the reply is written as UTF-8 bytes on
  Windows and as a string on POSIX. `command` mode is
  `-NoLogo -Command <command>` on PowerShell and `/s /c <command>` on
  `cmd.exe` (`terminalSpawnArgsForStart`); there is no login-shell equivalent
  of the POSIX `-lc`.
- **Console code page.** bb runs no `chcp` bootstrap. pwsh 7 is UTF-8, so
  non-ASCII input and output round-trip there. Windows PowerShell 5.1 and
  `cmd.exe` keep whatever console code page the machine has, and non-ASCII
  text can garble in those two shells.
- **Terminal environment.** `buildTerminalEnv` merges the sanitized inherited
  environment, the daemon's resolved shell environment and bb's own terminal
  variables, then passes the result through `assignPathEnv`, so a Windows
  terminal child receives exactly one search-path key, `Path`.
- **Closing a terminal.** node-pty 1.2.0-beta.15 rejects every signal on
  Windows: `pty.kill(signal)` is deferred, so before the pty is ready it does
  not throw at the call site but later, as an uncaught
  `Signals not supported on windows.` The win32 arm therefore never passes a
  signal — `terminalCloseSupportsForceKill` is false on win32 and close is a
  single `pty.kill()`. The close grace timer no longer force-kills; it only
  finishes the session and logs "Terminal did not exit after close; finishing
  session (single close on this platform)". A user-initiated close reports
  exit code `-1073741510` (`0xC000013A`), and the app may display it; hiding
  it in the terminal panel is Phase 4 UX.
- **Terminal sweep roots.** Once node-pty reports a pid, the PTY is registered
  with `registerSweepRootProcess` so a later worktree sweep recognises it as
  `spawn-registry` evidence. `pty.pid` is 0 for roughly 100–200 ms after spawn
  (90–178 ms measured), so registration retries every 250 ms up to 12 times
  and warns when the pid never arrives. A detached grandchild survives
  `pty.kill()` and is reaped only by the worktree sweep, and only when it
  matches the sweep's evidence rules from "Process sweep" above — never
  blind.
- **Failed terminal open.** On Windows a failure after the pty spawned
  unregisters the sweep root, disposes the listeners and kills the orphan pty.
  The POSIX arm still leaks that pty; it is a pre-existing upstream finding,
  not changed by this phase. `node-pty-fd-leak.test.ts` stays POSIX-only
  because it counts `/dev/ptmx` handles with `lsof`, and ConPTY exposes no
  equivalent signal yet.
- **Provider launch.** `resolveSpawnPlan` and `resolveSpawnPlanOrThrow`
  (`packages/process-utils/src/resolve-executable.ts`) turn the bare command a
  bridge wants into one `CreateProcess` can start: on win32, the first `Path`
  entry whose `PATHEXT` candidate exists, with a Node `.cmd`/`.bat` shim
  rewritten to `node.exe <script>` and the caller's arguments appended.
  `readNodeCmdShim` recognises npm's own `npm.cmd`/`npx.cmd` launcher shape
  (`SET "NPM_CLI_JS=%~dp0…"`) as well as the `node_modules\.bin` wrapper
  shapes. A `.cmd` that is not a Node shim keeps the Phase 2 refusal,
  `Windows launcher <path> is not a Node shim bb can start directly`
  (`not_node_shim`); a resolved file that is neither a PE image nor a shim —
  a `.ps1` reached through `PATHEXT`, for example — is refused as
  `Windows launcher <path> cannot be started directly` (`not_executable`);
  and an unresolvable name is `Command <name> was not found on Path`
  (`not_found`). On every other platform the plan is the identity, computed
  with no filesystem access at all.
- **Provider executables.** Codex spawns `codex.exe`; Claude Code resolves
  `claude` on `Path` first and then the well-known
  `%USERPROFILE%\.local\bin\claude.exe` and
  `%USERPROFILE%\.claude\local\claude.exe`; Pi spawns `pi.exe`; ACP agents
  spawn their own resolved executable. Every win32 provider spawn sets
  `windowsHide: true`. Pi's five-pipe stdio
  (`["pipe", "pipe", "pipe", "pipe", "pipe"]`, file descriptors 3 and 4 as the
  side channel) works on Windows — verified with a Node child, since Pi itself
  is not installed on the reference desktop. The Claude Agent SDK spawns the
  resolved `claude.exe` itself; bb installs its own `spawnClaudeCodeProcess`
  only when provider-bridge recording is on.
- **Provider environment.** `providerProcessEnvFromShellEnv`
  (`apps/host-daemon/src/runtime-manager.ts`) now goes through
  `assignPathEnv`, closing the last pre-`assignPathEnv` PATH site: a provider
  child on Windows receives a single `Path` key and any other case variant
  from the shell environment is dropped. The daemon's own internal shell
  environment still carries `PATH`.
- **Provider installation.** `streamProviderInstallation`
  (`apps/host-daemon/src/provider-installation.ts`) runs an install command
  through ConPTY so the CLI's own progress output reaches the app. On win32
  the command is resolved with `resolveSpawnPlanOrThrow` before the pty spawn,
  because ConPTY cannot start a `.cmd` at all; a resolution failure is written
  to the stream as an `error` event carrying the message above instead of an
  opaque spawn failure. `npm install -g <package>@latest` therefore runs as
  `node.exe <npm-cli.js> install -g <package>@latest`. Cancelling calls
  `pty.kill()` and then `terminateProcessTree` on the reported pid with
  `graceMs: 0`, so descendants are re-verified by `CreationDate` and killed
  individually; cancelling inside the ≈100–200 ms window where the pty still
  reports pid 0 kills only the leader, and the tree sweep runs after the
  stream closes rather than being awaited.
- **Install availability.** `ProviderInstallationStatus.installUnavailableReason`
  is the one sentence the app, the CLI and the SDK show in place of an install
  button. `experimental_installerUnavailableReason` writes it for a vendor
  shell installer bb cannot run on Windows — "bb cannot run the Claude Code
  shell installer on Windows. Install Claude Code from
  https://claude.com/claude-code, then reload." — which is what the Claude
  Code bridge and the Cursor ACP dialect use, since
  `downloadedInstallerCommand` returns `null` on win32. Pi writes its own
  reason, "bb needs bun or npm on Path to install Pi on Windows. Install
  Node.js or Bun, then reload."; Codex keeps `null`.
  `bb machine provider-cli status` prints the reason to stderr in its default
  (non-`--json`) output. Adding this required key to the bridge status is why
  `HOST_DAEMON_PROTOCOL_VERSION` is 201.
- **Watcher.** `@parcel/watcher@2.5.6` resolves its `win32-x64` prebuild and
  delivers event paths with backslashes, so `normalizeWatchEventPath`
  (`packages/host-watcher/src/watch-event-path.ts`) resolves a relative event
  against its root with `path.win32`. Containment (`isWatchPathWithinRoot`)
  and the root-relative key (`toWatchRootRelativeKey`) match the root
  case-insensitively, and `dedupeWatchPathChanges` folds case outright, which
  collapses the duplicate events an NTFS case-only rename produces. An event
  path that arrives extended-length (`\\?\`, `\\.\`) is passed through
  unchanged; the prefix is stripped only when comparing against or relativizing
  to a root, never in the path bb reports. Glob ignore handling is the POSIX
  behaviour unchanged. The
  watch-count ceiling test reads `/proc/self/fdinfo` for `inotify wd:` entries
  and is Linux-only by design.
- **Desktop log viewer.** On Windows `createLogTailer`
  (`apps/desktop/src/log-viewer.ts`) follows each component log by byte
  offset instead of spawning `tail`: the initial read takes the last 400
  complete lines and records the offset of the last newline, so a half-written
  final line is re-read on the next append rather than shown split. Appends
  are read on the same directory watch and 2-second rotation poll the POSIX
  path already used, and a file that shrinks — or whose mtime moves while its
  size is unchanged — is treated as rotated and re-read from zero. The initial
  refresh is gated on Windows only. POSIX keeps `tail -n 400 -F`.
- **`bb-app` on Windows.** The tarball smoke
  (`pnpm exec turbo run smoke:tarball --filter=bb-app`) runs on Windows by
  launching npm and npx through Node's own bundled CLIs —
  `node.exe <dirname(node.exe)>\node_modules\npm\bin\npm-cli.js` and
  `npx-cli.js` (`packages/bb-app/scripts/npm-launch.mjs`) — because npm's
  `.cmd` shims are not spawnable directly, and it runs the installed
  package's bin through the JS entry named in that package's `bin` map rather
  than through npm's `.bin\bb-app` shim. It measured 110 s on the reference
  desktop. `npx bb-app` from a clean PowerShell session is the Phase 3 gate
  evidence.
- **ConPTY smoke.** `apps/desktop/scripts/smoke-windows-conpty.mjs` is the
  Turbo task `@bb/desktop#smoke:windows-conpty` and has six checks:
  `spawn-echo`, `utf8`, `resize`, `ctrl-c`, `close`, `tree`. The `close` check
  accepts exit codes `0` and `-1073741510` and prints the code it saw; the
  `ctrl-c` check waits for the prompt to reappear before sending its follow-up
  command, and observes the interrupt as a new prompt rather than as a
  message. On a non-win32 host it prints `conpty smoke: skipped (not win32)`
  and exits 0. The gate reads `conpty smoke: 6/6`.
- **Sweep skip reporting.** The worktree and personal-workspace sweeps now
  wire the `onSkippedProcess` callback: both write
  `bb sweep left pid <pid> alone: process id reused` to the plugin host's
  stderr, which the daemon captures, so a recycled-PID skip on those paths is
  no longer silent.
- **Skill scripts.** Unchanged from Phase 2 — bb still never spawns an agent
  skill's own script — with one addition from provider launch: an agent that
  starts a provider-style CLI on Windows should resolve it through `Path` and
  `PATHEXT` itself and start a Node `.cmd` shim as `node <script>`, rather
  than running the shim through `cmd.exe`, which re-parses arguments.
- **CI.** The `windows-x64` job (`.github/workflows/ci.yml`) installs, loads
  the native add-ons, runs the ConPTY smoke (teed to
  `qa-artifacts/conpty-smoke.txt` and uploaded with the Turbo run summaries),
  typechecks/builds, and runs the `bb-app` tarball smoke. Phase 4 added Desktop
  packaging and the packaged-app/process-hygiene smokes. Phase 5 adds
  failing-on-error workspace, open-target, secret-storage, Desktop,
  plugin-build, Pi and full server tests, with focused daemon broker, CLI and
  app-dialog coverage. Only the remaining baseline step has
  `continue-on-error: true`. The
  [hardening report](../qa/windows/phase-5/05-local-hardening.md) distinguishes
  local verification from unrun external CI. These source changes do not
  configure a required check or change Windows beta status.

## Windows Desktop (Phase 4)

- **Build.** `pnpm --filter @bb/desktop run dist:windows` produces
  `release/bb-<version>-x64.exe`, `release/latest.yml` and
  `release/win-unpacked/`; the nightly channel produces
  `bb-nightly-<version>-x64.exe` and `nightly.yml`. On Windows
  `scripts/run-electron-builder.mjs` starts electron-builder as
  `node electron-builder/cli.js` (resolved through `createRequire`), because
  `node_modules/.bin/electron-builder` is a `.cmd` shim that `spawn` cannot
  start without a shell; POSIX keeps the `.bin` spawn unchanged. A full
  `dist:windows` downloads `nsis`, `7zip` and `nsis-resources` into
  `%LOCALAPPDATA%\electron-builder\Cache` on a cold cache; an unsigned `--dir`
  `package:windows` downloads neither those nor `winCodeSign`, only the
  Electron zip and the icon tool. `winCodeSign` is **not** fetched on a
  Windows host at all — electron-builder signs through the system
  `signtool.exe` there, and the `winCodeSign` bundle exists for cross-building
  Windows targets from macOS and Linux
  (`qa/windows/phase-4/20-build-installer.md` measures the cache before and
  after). `package:windows` was measured at a few minutes on the reference
  desktop, the first run being the slow one. Icons are the checked-in PNGs (`assets/icon.png`,
  `assets/icon-nightly.png`); app-builder-lib converts them to `.ico` itself
  and no `.ico` is checked in. Two log lines are expected noise rather than
  findings: electron-builder reports "signing with signtool.exe" even with no
  secrets configured, where it is a no-op and the executable stays unsigned,
  and `prebuild-install`'s `better-sqlite3` fetch prints below npmlog's notice
  level, so it does not appear in the build transcript at all.
- **Installer.** The NSIS target is assisted rather than one-click, per-user
  rather than per-machine, and therefore needs no elevation: a standard
  account can install it. The default directory is
  `%LOCALAPPDATA%\Programs\bb` and the user may change it; a desktop shortcut
  is created. `%APPDATA%\bb` — Electron's `userData`, holding
  `owned-runtime.json`, the window state and the cached Connect credential —
  survives uninstall by design (`deleteAppDataOnUninstall: false`).
  `%USERPROFILE%\.bb` is bb's own runtime data directory and the installer
  never touches it.
- **Signing.** `run-electron-builder.mjs` gains a `windows` signing mode
  beside the macOS one. All seven of `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`,
  `AZURE_SIGNING_ACCOUNT_NAME`, `AZURE_SIGNING_CERTIFICATE_PROFILE` and
  `WINDOWS_PUBLISHER_NAME` are required together, and they are read only for a
  build that targets Windows (`--win` among the electron-builder arguments), so
  a macOS or Linux build ignores them exactly as it did before Phase 4. For a
  Windows build a partial set aborts with
  `Incomplete Windows signing environment`, naming the present and the missing
  keys. With none of them set the build is unsigned and
  `publisherName` is deliberately left unset — `publisherName` is written only
  in signed mode. No certificate exists today, so every build produced so far
  is unsigned. An unsigned installer is the case SmartScreen's "Windows
  protected your PC" dialog exists for, and a user who meets it clears it with
  More info → Run anyway — but the Phase 4 gate could not reproduce the dialog
  on the reference desktop: a locally built installer carrying a synthetic
  `Zone.Identifier` (`ZoneId=3`) ran straight through with SmartScreen enabled
  and its host process live. `qa/windows/phase-4/21-install-standard-user.md`
  records that measurement, the SmartScreen settings behind it and what is
  still needed to capture the dialog; there is no screenshot of it yet. A
  stable publish withholds unsigned Windows binaries and always publishes
  `desktop-version-windows.json`.
- **Native modules.** node-pty's Windows prebuild is ConPTY-only: four files,
  `conpty.node`, `conpty_console_list.node`, `conpty/conpty.dll` and
  `conpty/OpenConsole.exe`. `winpty.dll` and `winpty-agent.exe`, which the
  design spec's Phase 4 scope names, do not exist in node-pty 1.2.0-beta.15
  and are not staged. `asarUnpack` already places every `node_modules` file
  outside asar, so those four ship under
  `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/`;
  on win32 `scripts/prepare-native-modules.cjs` asserts all four exist under
  every packaged node-pty and throws naming the missing file.
  `better-sqlite3` is fetched for the Electron ABI with `prebuild-install`.
- **Runtime supervision.** The packaged app runs `bb-app` as a hidden
  (`windowsHide: true`), non-detached child of `bb.exe` carrying
  `BB_DESKTOP_PARENT_PID`. Quit stops that tree through Phase 2's
  `terminateProcessTree`: a 1-second grace after `taskkill /PID <leader> /T`,
  then the leader through the `ChildProcess` handle bb still holds, then each
  descendant whose `CreationDate` still matches the pre-stop snapshot. A
  recycled-PID skip is written into the runtime log buffer as
  `bb desktop left pid <pid> alone: pid-reused`. A typical Quit spends about
  2.8 seconds stopping the tree, because the windowless Node leader has no
  window to receive `taskkill`'s close request and is therefore ended through
  the held handle once the grace expires; the worst case is bounded by the
  stop's own budget, `timeoutMs` plus `killTimeoutMs`, which is 6 s + 1 s = 7 s
  for an owned runtime (`OWNED_RUNTIME_STOP_TIMEOUT_MS` and
  `OWNED_RUNTIME_KILL_TIMEOUT_MS` in `apps/desktop/src/main.ts`). When
  `timeoutMs` expires before the sweep answers, the stop logs
  `bb desktop gave up waiting for the runtime tree after <N> ms` and force-kills
  the leader through the held `ChildProcess` handle rather than waiting on the
  sweep. The descendant sweep also runs when the leader has already exited on
  its own, so a runtime that dies mid-quit still has its children collected.
  No SIGTERM is sent on win32: Node's
  `kill("SIGTERM")` is `TerminateProcess` there, so the launcher's signal
  handlers would never run. POSIX keeps its signal-then-timeout path
  byte-identical.
- **Parent watchdog.** `bb-app` reads `BB_DESKTOP_PARENT_PID` on win32 only
  and polls that pid every 2 seconds; when the parent is gone it logs
  "Desktop parent process exited; shutting down" and runs its normal graceful
  shutdown. That is the recovery path when the Desktop process is killed
  outright rather than quit. There is no `BB_DESKTOP_RUNTIME_ID` yet, and the
  health response carries no runtime id: on win32 `stopVerifiedProcess`
  already verifies an owned runtime by command line (the `bridgePath` recorded
  in `owned-runtime.json`) and CIM `creationDate`, and adding a runtime id to
  the health response would be a server wire change this phase deliberately
  did not make.
- **Packaged process tree.** In a packaged Windows install the bridge, the
  server and the host daemon all run as `bb.exe` with `ELECTRON_RUN_AS_NODE`
  set; there are no `node.exe` rows to look for. The process-hygiene smoke
  therefore identifies the bridge by the `bb-app-bridge.mjs` string in its
  command line and identifies every process by pid plus creation date.
- **Tray and close policy.** On win32 the tray is created before the first
  window is restored, so the app always has a tray to park in; closing the last
  window parks it there with the owned runtime still running and still
  answering `/health`. `window-all-closed` quits only when there is no tray,
  which is a safety net rather than a supported mode — a tray that cannot be
  created throws into the startup error path instead. Closing that window also
  persists an empty window set, so the next
  launch opens the default window rather than restoring none. The tray tooltip
  is the application name and its menu is
  `Open bb` then a separator then `Quit bb` (`bb Nightly` on the nightly
  channel); clicking the tray icon focuses an existing window or creates one.
  Quit stops a spawned runtime and never an attached one — the ownership check
  is the same one macOS and Linux already use.
  The first-close exception found in the initial Phase 4 gate is fixed on
  Windows: the browser broker retains the live renderer identity and safely
  revokes browser-control leases after the window is destroyed. The installed
  build passed three close/reopen cycles with runtime health preserved; see
  `qa/windows/phase-4/43-continuation.md`.
- **Session end.** Windows logoff and shutdown run the same stop as Quit, but
  the wiring is not obvious: Electron 41 has no App-level `session-end`; it is
  a `BrowserWindow` event. The desktop attaches it per window on win32 only,
  through `browser-window-created`, with a guard so that several open windows
  still trigger one stop. A logoff while the app is parked in the tray with
  zero windows therefore fires nothing at all; the runtime is ended in that
  case by Windows ending the session's processes and by the `bb-app` parent
  watchdog described above.
- **`BB_DESKTOP_QUIT_REQUEST_FILE`.** This is the automation hook the packaged
  smokes use in place of a signal, since an Electron GUI process on Windows
  has no console to receive one. It is read on win32 only, polled every
  500 ms, and the first poll that finds the file calls `app.quit()` once —
  exactly the tray Quit path. The app does not delete the file, so automation
  must use a fresh path per run or remove a stale file before launching.
- **Window.** The window is created with `titleBarStyle: "hidden"` and a 48 px
  caption overlay whose colours follow the theme: dark `#1f1f1f` with
  `#e8e8e8` symbols, light `#f6f6f6` with `#1f1f1f` symbols. The overlay is
  re-applied both when the app switches its own theme and when the OS theme
  changes (`nativeTheme`'s `updated` event). On the app side, `AppPageHeader`
  reserves 138 px on the right — three 46 px Windows 11 caption buttons — and
  the secondary-panel header reserves 154 px, the same 138 px plus a 16 px
  gutter beside the band, because that row carries its own padding. Only the
  header that owns the window's top-right corner takes the reserve: in a split
  the top-right pane takes it, and a thread header whose secondary panel is
  open inline cedes it to the panel header. The right-panel toggles are offset
  by 138 px plus 1 rem so they never sit under the caption controls. The
  drag-region class constants were renamed
  from `MACOS_*` to `DESKTOP_*` project-wide with their values unchanged,
  because the same drag and no-drag regions now serve both platforms; the
  macOS traffic-light reserves stay macOS-only. `dev.bb.desktop` is the
  AppUserModelID (`dev.bb.desktop.nightly` for nightly builds,
  `dev.bb.desktop.dev` for an unpackaged dev run).
- **Updates.** Windows gets both update paths. The lightweight JSON feed is
  `desktop-version-windows.json` and electron-updater reads `latest.yml`
  (`nightly.yml` on the nightly channel); the stable pair lives in the
  `desktop-latest` release directory beside the macOS and Linux metadata, the
  nightly pair in `desktop-nightly`. An
  available update downloads automatically and installs on quit or from
  Settings. The install handler runs the normal quit sequence first, so the
  runtime tree is already stopped before `quitAndInstall` hands over to the
  installer. An unsigned build updates to the next unsigned build because
  `publisherName` is unset: electron-updater's NSIS signature verification
  accepts a download when no publisher name is configured, which is also why
  setting a publisher without a certificate would break every update. The JSON
  half follows `BB_DESKTOP_VERSION_FEED_URL`, and a packaged build's
  electron-updater half has no shipped test-feed override: the
  desktop calls `autoUpdater.setFeedURL()` with the built-in
  `https://github.com/get-bb/bb/releases/download/<tag>/` base at startup,
  which takes precedence over `resources/app-update.yml`, and
  `forceDevUpdateConfig` is gated on an unpackaged run. Editing
  `app-update.yml` inside an installed copy therefore has no effect —
  `qa/windows/phase-4/23-update-n-to-n1.md` measures the resulting requests
  going to `github.com`. Local QA can instead use the main-process Inspector
  to replace the existing updater adapter's feed in memory after startup
  configuration and before its first check. This is test instrumentation,
  not a supported configuration setting. The continuation procedure and its
  measured limits are in `qa/windows/phase-4/43-continuation.md`.
- **App file names.** File names shown in the app come from `hostPathBasename`
  (`apps/app/src/lib/host-path.ts`): a drive-absolute (`C:\`, `C:/`) or UNC
  (`\\`) path splits on either separator, and every other input splits on `/`
  exactly as before, so POSIX inputs are byte-identical. Eight of the nine
  sites that derived a file name with `split("/")` now use it;
  `rightPanelFileVisuals.ts` uses the same module's `hostPathSegments` for its
  directory-segment check.
- **Terminal exit.** `normalizeTerminalExitCode`
  (`apps/host-daemon/src/terminals/terminal-exit-code.ts`) maps
  `-1073741510` to `null` on win32 only, and only when bb itself requested the
  close, so the app shows `Terminal exited` instead of the number. Any other
  exit code, and the same code on a close bb did not request, passes through
  unchanged. `HOST_DAEMON_PROTOCOL_VERSION` stays at 201 for this change: the
  field's type (`number | null`) and the meaning of `null` are unchanged and
  only a value a Windows daemon emits moves, so an older enrolled Windows
  daemon merely renders the negative code as it did before.
- **CI.** The `windows-x64` job in `.github/workflows/ci.yml` packages the
  unpacked app with `pnpm --filter @bb/desktop run package:windows` — there is
  no Turbo task for that script — and then runs `smoke:packaged` and
  `smoke:windows-processes` through Turbo, all three steps with `TMP` and
  `TEMP` redirected to a workspace-local directory because of the runner's
  temp-directory ACLs. `smoke:windows-processes --evidence-dir <dir>` resolves
  `<dir>` against `apps/desktop` under Turbo, so CI uploads
  `apps/desktop/qa-artifacts/process-hygiene/*.json` inside the
  `windows-x64-test-results` artifact. `.github/workflows/build-desktop.yml`
  gains a `windows` job on the pinned `windows-2025` image that validates the
  seven signing secrets, builds the NSIS installer, runs both smokes and the
  version feed, and uploads `bb-desktop-windows-x64` (the release assets) plus
  a separate `bb-desktop-windows-x64-process-hygiene` artifact for the smoke
  evidence. The single publish job needs that job, always publishes
  `desktop-version-windows.json`, and publishes `latest.yml`, the `.exe` and
  its `.blockmap` only when the Windows signing secrets are complete.
- **Measured on the reference desktop, 2026-09-16.** `smoke:packaged` exited
  0, three `smoke:windows-processes` runs exited 0, 0 and 0, and no leaked
  processes were observed in any of them.

## Known limitations after Phase 0

- Project paths became drive-letter aware in Phase 1 (see "Host identity and
  paths" above); hooks arrived in Phase 2 — see "Processes, hooks, git and
  open targets (Phase 2)" above — and terminals, provider launch and
  installation, the watcher and the native `bb-app` runtime arrived in Phase 3
  (see "Terminals, providers, watcher and native `bb-app` (Phase 3)" above).
- `packages/bb-app` and `apps/desktop` list `win32` in their `os` fields
  (spec §7), and since Phase 3 the runtime that `npx bb-app` installs on
  native Windows works: it is the beta product path described in
  [platform-support.md](platform-support.md), beside WSL2, which stays the
  stable one.
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
  then `SIGKILL` on POSIX). Phase 2 shipped the identity-verified process
  primitives (spec §5) but deliberately left `dev:stop` on the unverified
  path — see "Known limitations after Phase 2" below — so delete a stale pid
  file by hand after a crash or reboot before running `dev:stop`.
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
- The original Windows CI test baseline used `continue-on-error: true`.
  Phase 5 adds separate failing-on-error regression steps; the remaining
  baseline packages keep that exemption. See the
  [current hardening report](../qa/windows/phase-5/05-local-hardening.md).
  This local work does not enable a remote required check.

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
- App views that derived a file name with `split("/")` showed the full Windows
  path through Phase 3. Phase 4 replaced that split with
  `apps/app/src/lib/host-path.ts` at all nine sites — `hostPathBasename` at
  eight of them and `hostPathSegments` in `rightPanelFileVisuals.ts`, whose
  check is on directory segments rather than the file name. The nine sites are
  the six named here through Phase 3 (`environment-queries.ts`,
  `project-queries.ts`,
  `api.ts`, `plugin-slot-resolvers.ts`, `file-opener-tabs.ts`,
  `rightPanelFileVisuals.ts`) plus `SkillDetailView.tsx`,
  `RootComposeView.tsx` and `ThreadDetailView.tsx`, so a Windows path now
  renders as its file name and a POSIX path renders exactly as it did before.
- The host directory browser cannot switch drives.
- The native folder picker was macOS-only after Phase 1; Phase 2 adds the
  Windows picker — see "Open targets and picker" above.
- The `environment-project-checkout` and `environment-personal-workspace`
  `host.test.ts` suites still shell out to `mkdir -p`/`sleep` and fail on
  Windows; `environment-git-worktree`'s suite no longer does (Phase 2).
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
  verified process stop was deferred out of Phase 2, where
  `verified-process-stop.ts`'s win32 arm verifies through
  `queryWindowsProcess` instead. Phase 4 landed the `BB_DESKTOP_PARENT_PID`
  half and the watchdog — see "Runtime supervision" and "Parent watchdog"
  above — and left `BB_DESKTOP_RUNTIME_ID` and a health-response runtime id
  unimplemented, because command line plus creation date already identify an
  owned runtime and a health-response field would change the server wire.
- `plugins/account-pool`, `plugins/secrets`, and the host daemon's own
  `auth-state.ts` and `identity.ts` own their secret files directly and are
  not ACL-hardened by this phase.
- `pnpm dev:stop` still force-kills the pid recorded in a session's pid file
  after checking only that the pid exists; verifying process identity before
  a forced kill is developer tooling, not a product seam, and stays
  unverified.
- Local Git plugin sources were still broken after Phase 2. Phase 5 hardening
  recognizes drive-absolute paths, preserves their entered spelling and uses
  a bounded, separate cache namespace, including for range and nested-plugin
  installs. Native install/update/marketplace evidence is recorded in
  [the local hardening report](../qa/windows/phase-5/05-local-hardening.md).
- `plugins/github/server.ts`'s `run()` helper spawns `gh` with an unsanitized
  inherited environment; this is a pre-existing upstream finding, not fixed
  in this phase.
- `provider-maintenance-kit`'s `experimental_resolveExecutablePath` and its
  PATHEXT-aware installer commands landed in Phase 3 alongside provider
  launch — see "Provider launch" and "Install availability" above.
- Terminal sweep-root registration (`registerSweepRootProcess` wired to
  node-pty's reported pid) landed in Phase 3 with ConPTY — see "Terminal
  sweep roots" above.
- Open targets on Windows use static per-adapter icons; there is no icon
  extraction from the target executable the way some platforms support.
- JetBrains Toolbox version selection under
  `%LOCALAPPDATA%\JetBrains\Toolbox\apps` picks lexicographically, not by
  parsed version number.
- Editor and app open targets on Windows are launched detached, so the open
  request returns once the process is spawned and reports only spawn failures
  (as macOS `open -a` does), not the editor's exit status. An editor started
  through a `.cmd` shim keeps a hidden, detached `cmd.exe` alive for the
  editor's lifetime.
- A `pid-reused` skip was reported only where a caller wires the
  `onSkippedProcess` callback, which through Phase 2 was the environment hook
  runner alone. Phase 3 wired the worktree and personal-workspace sweeps to
  write `bb sweep left pid <pid> alone: process id reused` to the plugin
  host's stderr; provider installation cancel, the shell-environment probe,
  the automations script runner and `stopVerifiedProcess` still do not wire
  it, so their skips stay silent.
- `providerProcessEnvFromShellEnv` in `apps/host-daemon/src/runtime-manager.ts`
  overlaid a bare `PATH` for provider processes instead of going through
  `assignPathEnv`, so on Windows a provider child could receive both `Path`
  and `PATH`. It was the remaining pre-`assignPathEnv` PATH site; Phase 3
  converted it alongside provider launch.

## Known limitations after Phase 3

- bb runs no `chcp` bootstrap, so a terminal that falls through to Windows
  PowerShell 5.1 or `cmd.exe` keeps the machine's console code page and
  non-ASCII text can garble there. Install PowerShell 7 for a UTF-8 terminal.
- A user-initiated terminal close still reports exit code `-1073741510`
  (`0xC000013A`) out of node-pty, because the single `pty.kill()` is the only
  stop it offers on Windows. Phase 3 let the app show that number; Phase 4
  hides it — `normalizeTerminalExitCode` maps it to `null` on win32 when bb
  itself requested the close, so the app renders `Terminal exited`. The raw
  code still reaches bb, and it is still reported when the same code arrives
  from a close bb did not request.
- A terminal open that fails after the pty spawned leaks the pty on POSIX. The
  win32 arm kills the orphan; the POSIX leak is a pre-existing upstream
  finding and is deliberately not changed here.
- Pi is not installed on the reference desktop, so Pi's native Windows launch
  is unverified live. What is verified is the shape: `pi` resolves to
  `pi.exe`, and the five-pipe stdio the bridge needs works on Windows with a
  Node child standing in for the CLI.
- bb does not install `spawnClaudeCodeProcess` on win32 outside provider-bridge
  recording; the Claude Agent SDK owns that spawn. If
  `resolveClaudeCodeExecutable` returns a `.cmd` — the npm-global Claude Code
  install shape — the SDK may be unable to start it, and bb has no seam in
  front of that spawn to rewrite it to `node.exe <script>`.
- `readNodeCmdShim` recognises npm's own `npm.cmd`/`npx.cmd` launcher shape
  and the `node_modules\.bin` wrapper shapes only. A launcher that shells out
  to python, bun or a native wrapper is refused rather than run through
  `cmd.exe`; that refusal is deliberate, since `cmd.exe /c` re-parses
  arguments.
- Extended-length watch **roots** (`\\?\C:\...`) are not a supported path:
  nothing in bb passes one to `watchPathRoot` today, and the one NTFS
  subscription measured against such a root reached `@parcel/watcher` without
  going through `watchPathRoot`. It is missing coverage rather than a known
  defect — `path.resolve` does preserve a genuine `\\?\` prefix on Node
  22.19.0, and `normalizeWatchEventPath` has an explicit extended-length-root
  arm. Extended-length paths in event data under an ordinary root are handled
  and tested.
- The manual Windows QA checklist that spec §10 names now exists at
  `qa/windows/CHECKLIST.md`; its unexecuted acceptance rows remain pending.
- The secrets limitations from Phase 2 stand unchanged:
  `plugins/account-pool`, `plugins/secrets`, and the host daemon's own
  `auth-state.ts` and `identity.ts` own their secret files directly and are
  not ACL-hardened.
- The Desktop runtime-identity design (`BB_DESKTOP_RUNTIME_ID`,
  `BB_DESKTOP_PARENT_PID`, a parent-PID watchdog) was Phase 4 work, as "Known
  limitations after Phase 2" records. Phase 4 shipped
  `BB_DESKTOP_PARENT_PID` and the watchdog; `BB_DESKTOP_RUNTIME_ID` and the
  health-response runtime id remain unimplemented and are carried into "Known
  limitations after Phase 4" below.
- `pnpm dev:stop` still force-kills the pid in a session's pid file after
  checking only that the pid exists. It is developer tooling, not a product
  seam, and stays unverified.

## Known limitations after Phase 4

- No Windows code-signing certificate exists, so every installer built so far
  is unsigned and SmartScreen may warn on first launch; users clear that with
  More info → Run anyway. The Phase 4 gate did not reproduce the warning on the
  reference desktop, so how often a real download trips it is unmeasured
  (`qa/windows/phase-4/21-install-standard-user.md`). A stable publish
  withholds the unsigned `.exe` and
  publishes only `desktop-version-windows.json`, so there is no published
  Windows download yet; maintainers build one with
  `pnpm --filter @bb/desktop run dist:windows`. Because that is the permanent
  state rather than a transient one, a source-built Windows install sees
  "update available" from `desktop-version-windows.json` while
  electron-updater finds no `latest.yml` to download; the nightly and QA feeds,
  which do publish unsigned binaries, are the working update path until a
  certificate exists.
- The `bb-app` parent watchdog tests the desktop pid with `process.kill(pid, 0)`
  and nothing else, so it cannot tell an exited desktop from a recycled pid: if
  Windows reassigns that pid, the watchdog keeps treating the parent as alive
  and never shuts the runtime down. Quit and `session-end` are the normal
  paths; the watchdog is only the recovery path for a killed desktop.
- `session-end` runs the same 7 s bounded stop as Quit, which exceeds Windows'
  default logoff budget of roughly 5 s. A logoff can therefore end the session
  before the stop finishes, leaving the runtime tree to Windows' own session
  teardown rather than to bb's stop.
- `BB_DESKTOP_RUNTIME_ID` and a runtime id in the health response are not
  implemented. An owned runtime is verified by its command line and its
  process creation date instead, which is enough for the stop path but does
  not survive a case where two runtimes share both.
- There is no `bb://` protocol client and no argv forwarding. Nothing in bb
  registers a protocol client or a file association today, so a second
  instance has no argv to forward; it focuses an existing window or creates
  one, which is the same thing the tray does.
- No Job Object is used, so the escaped-descendant risk spec §9 records stays
  open on the Desktop stop path exactly as it does elsewhere on Windows. The
  spec's trigger for adding a native Job Object helper is a repeated "zero
  orphans after Quit" gate failure. Three process-hygiene runs on the
  reference desktop all exited 0 with no leaked processes, so the trigger has
  not fired; the gate records its own count in
  `qa/windows/phase-4/24-quit-orphans.md`.
- Uninstall leaves `%APPDATA%\bb` behind by design, so a reinstall keeps the
  window layout, the owned-runtime record and the cached Connect credential.
  Removing it is a manual step. It also leaves
  `%LOCALAPPDATA%\@bbdesktop-updater\installer.exe` — a ~154 MiB copy of the
  installer that last ran, which the NSIS target seeds so a later differential
  update has its base file. That directory holds no user data and is safe to
  delete; `qa/windows/phase-4/26-uninstall.md` measures both.
- The caption overlay's height and colours are fixed values — 48 px and one
  colour pair per theme — rather than being derived from the app's theme
  tokens, so a theme whose chrome row or surface colour differs from those
  constants will not match the caption band exactly.
- The tray icon is the same 1024 px PNG the app ships, downscaled to 16 px at
  runtime rather than a purpose-drawn small icon.
- The Phase 3 limitations that Phase 4 did not touch still stand, including
  the console code page: bb runs no `chcp` bootstrap, so a terminal that falls
  through to Windows PowerShell 5.1 or `cmd.exe` keeps the machine's code page
  and non-ASCII text can garble there.
- The manual Windows QA checklist that spec §10 names exists at
  `qa/windows/CHECKLIST.md`; real clean-VM/logon/live-Connect and remaining
  baseline acceptance are not established by its presence.

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

`qa/windows/phase-3/` holds host facts (`00-host.md`), the build/typecheck log
and per-package test results (`30-build-typecheck.txt`, `31-test-results.md`,
`31-test-output-tail.txt`), an in-app terminal handling Ctrl+C, resize and
UTF-8 echo (`20-terminal-ctrl-c-resize-utf8.md`), a real Codex turn and a real
Claude Code turn writing files under a `C:\` project (`21-codex-turn-on-c.md`,
`22-claude-code-turn-on-c.md`), watcher events on NTFS including a case-only
rename (`23-watcher-ntfs.md`), `npx bb-app` started from a clean PowerShell
session (`24-npx-bb-app-clean-shell.md`), three ConPTY smoke runs
(`25-conpty-smoke.md`), provider installation status and reasons
(`26-provider-installation.md`), the WSL POSIX test run (`40-posix-check.md`),
and the `windows-x64` CI run (`41-ci-run.md`). The gate run that writes this
directory is the last commit of Phase 3.

`qa/windows/phase-4/` holds host facts (`00-host.md`), the build/typecheck log
and per-package test results (`30-build-typecheck.txt`, `31-test-results.md`,
`31-test-output-tail.txt`), the NSIS installer build with the release listing
and signature state (`20-build-installer.md` and `.txt`), the standard-user
install with the installer's finish page and the SmartScreen measurement
(`21-install-standard-user.md`, `21-installer.png`; there is no
`21-smartscreen.png`, and that file says why), the installed app creating a
project and running a provider turn (`22-use-installed-app.md` and `.txt`), the
N → N+1 update and the local-feed finding (`23-update-n-to-n1.md` and `.txt`),
the Quit orphan diff with the three process-hygiene smoke runs
(`24-quit-orphans.md`, `.txt` and `process-hygiene/run{1,2,3}/*.json`), closing
the last window to the tray with the defect it exposed (`25-close-to-tray.md`,
`25-close-to-tray-error.png`), uninstall and what it leaves behind
(`26-uninstall.md` and `.txt`), the caption overlay over the app chrome
(`27-window-chrome.png` and `27-window-chrome-light-overlay.png`), the WSL POSIX
test run and the macOS/Linux config diff (`40-posix-check.md`), the
`windows-x64` CI run (`41-ci-run.md`) and why `build-desktop.yml` could not be
dispatched on the fork (`42-build-desktop-run.md`). These files preserve the
initial gate, including its failures. `43-continuation.md` records the later
Windows broker fix, rebuilt installer, installed lifecycle verification,
updater instrumentation and controlled server-test follow-up.

[Phase 5 native integration](../qa/windows/phase-5/03-native-integration.md)
and its [redacted structured results](../qa/windows/phase-5/04-native-integration.json)
record real isolated server/artifact enrollment through PowerShell 5.1 and 7,
CLI/SDK issuance, actual Scheduled Task registration, controlled registered-action
restart, private ACLs, installed native bindings and identity-safe cleanup.
The final local run exited 0 at head `43ff7f339`. Actual logon restart, clean VM
with WSL disabled, live Connect, Desktop coexistence, signing and same-head
external regression jobs remain pending; these measurements do not change
native Windows from beta to supported.

[Phase 5 local hardening](../qa/windows/phase-5/05-local-hardening.md) records
the 2026-09-23 regression baseline and subsequent fixes, with test selections,
exit status and the acceptance checks that remain open.
