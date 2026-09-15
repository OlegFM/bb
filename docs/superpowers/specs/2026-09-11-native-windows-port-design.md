# Native Windows 11 port — design

Date: 2026-09-11
Status: approved design; implementation plans are written per phase.
Scope owner: OlegFM/bb fork, intended for later upstream slicing into get-bb/bb.

## Sources

- Upstream proposal: get-bb/bb issue #1206 (design attachment
  `Native Windows 11 support for bb and bb Desktop.md`, verification
  attachment). Its five seams, six phases, non-goals and definition of done
  are the program this document adapts.
- Donor branch: get-bb/bb PR #3188 (`zqkra/bb-wn:feat/windows-nativo-bb-wn`,
  head `e6b387b76a90491ad5d8d67aff7be719d14c1aba`, base
  `6cdb4ba6125514b7660332cf311037bc09c82b0e`; 290 files, +21,489/-1,579;
  measured on Windows 11 Pro build 26200). Closed by the contributor gate,
  not for technical reasons. Fetched locally as `refs/remotes/upstream-pr/3188`.
- Earlier cut: get-bb/bb PR #1426 (head
  `a98bdebacc0994dc24ac500bcf15c3688735280a`), fetched as
  `refs/remotes/upstream-pr/1426`; its `plans/windows-native-later.md` is the
  roadmap split we reuse.
- Current `main` facts this design is written against:
  `HOST_DAEMON_PROTOCOL_VERSION` is 199
  (`packages/host-daemon-contract/src/protocol.ts`); hook execution lives in
  `apps/host-daemon/src/environment-lifecycle-script.ts` (moved out of
  `packages/host-workspace/src/provisioning.ts` after the donor's base);
  environment provisioning was consolidated in #3443; a dry-run merge of the
  donor onto `main` conflicts in 22 files.
- Review: an adversarial Codex review of this document (2026-09-11) found
  three fail-open decisions (secret ACLs, junction mutations, forced kill by
  bare PID) and an under-specified `path_key` migration. All four are folded
  into §4, §5, §6 and the phase gates below.

## 1. Goal

One bb runtime (`bb-app` = server + host daemon, the `bb` CLI, and bb Desktop)
runs natively on Windows 11 x64 without WSL2. WSL stays a separate Linux host
identity: no automatic fallback, and no native code path ever spawns
`wsl.exe`.

Landing strategy: fork first, upstream later. Work is grouped by seam so it can
be sliced into upstream pull requests once the program is proven.

Approach: port PR #3188 seam by seam onto current `main`, phase by phase per
#1206, verifying each phase on a real Windows 11 desktop (the same OS build the
donor was measured on). Gaps in phases 4 and 5 that the donor never finished
(signing mode, Windows update feed, required CI, persistent-host hardening)
are written fresh.

## 2. Definition of done

Native Windows 11 is documented as supported when all of the following hold:

| Area | Done when |
|---|---|
| Package | `npx bb-app` installs and starts from native PowerShell without WSL |
| Desktop | Installs from a per-user NSIS package, supervises a native `bb-app`, updates through `latest.yml` on the `desktop-latest` release |
| Paths | Projects on `C:\` and other local drive letters work; server code no longer constructs or validates host-native paths with POSIX assumptions |
| Workspaces | Managed worktrees are derived and secured by the host daemon; Git for Windows workflows pass |
| Terminals | PowerShell and CMD run through ConPTY |
| Hooks | `.bb-env-setup.ps1` / `.bb-env-teardown.ps1` work with timeout, streaming and cancellation |
| Providers | Detection and installation are native and capability-aware; Codex and Claude Code first |
| Native deps | Validated under both the Node and Electron ABIs |
| Watching | File watching works on NTFS |
| Open targets | Explorer, Windows Terminal and editor open targets work |
| Lifecycle | Desktop quit and update leave no orphan bb, provider or tool processes |
| Persistent host | Enrolls through PowerShell and restarts at logon |
| Gates | Windows x64 checks, package smoke and installer smoke are required; a clean Windows 11 machine with WSL disabled passes the full supported-workflow suite |
| Regression | macOS, Linux and WSL product paths stay green through every phase |
| Signing | Builds are signed when signing secrets are configured; unsigned builds are allowed only on the nightly channel and on the fork |

## 3. Non-goals

From #1206 §13 plus what the code survey found:

- WSL as an automatic runtime fallback, or a Local/WSL selector in Desktop.
- Windows ARM64 artifacts; Windows 10.
- UNC paths, device paths (`\\.\`, `\\?\GLOBALROOT`), network-share guarantees,
  NTFS per-directory case-sensitive mode. Drive-letter input only.
- MSI, MSIX, Microsoft Store, per-machine install, a machine-wide Windows
  service.
- Bundling Git, Node, or provider CLIs into the installer.
- Emulating a POSIX shell through Git Bash for bb's own runtime.
- Sandbox parity (Claude sandbox is macOS/Linux/WSL only).
- DevBrowser / browser-automation on win32 (no upstream artifact exists).
- Browser cookie import on Windows (Chrome App-Bound Encryption).
- Windows-native install of an upstream provider without a verified native
  executable.

## 4. Architecture principles

**Topology is unchanged.** Desktop → `bb-app` → server + host daemon. The
server owns product policy; the host daemon owns host-local primitives and
workspace execution. Windows branches live in the daemon, Desktop and CLI, not
in the server.

**Platform is injected, never ambient.** Any function whose behaviour depends
on the OS takes `platform` as a parameter. `process.platform` is read only at
composition roots: daemon start, Desktop `main.ts`, CLI entry, script entry
points. This makes every win32 branch testable from Linux CI.

**Three path classes.** Host-absolute (`C:\src\repo`, `/home/me/repo`),
repository-relative (always `/`-separated, as git emits), and URL/resource. Only
host-absolute paths branch on platform. A host path belongs to the *host*, not
to the process validating it: the browser may register `C:\project` on a
Windows host from macOS, so contracts validate shape permissively
(POSIX-absolute or drive-absolute), and the daemon validates strictly.

**Host-owned canonical paths.** The daemon returns
`{ path: string; pathKey: string }`. `path` is the canonical native display
path from `fs.realpath.native` with normalized separators and no trailing
separator (drive roots preserved, `\\?\` never persisted). `pathKey` is the
comparison key: on win32 it is `path` with `\` replaced by `/` and lower-cased,
on POSIX it is `path` unchanged. Keys therefore always use `/`, so the
existing SQL containment shape `LIKE key || '/%'` stays valid on every host.
The server stores both as opaque strings and never derives one from the
other. Managed paths (`%USERPROFILE%\.bb\worktrees\<env>\<repo>`,
`%USERPROFILE%\.bb\personal-workspaces\<env>`) are derived by the host-side
provider code, never by the server.

`path_key` migration, all in one Drizzle migration plus one application
change set:

1. Add nullable `path_key` to `project_sources` and `environments`; backfill
   with the POSIX rule (`path_key = path`), so no existing row can collide
   except exact duplicates that are already legal today.
2. Move every path-equality and containment query to `path_key`:
   `findEnvironmentByPath`, `findProviderEnvironmentContainingPath`
   (`eq(path_key)` or `LIKE path_key || '/%'`), the pre-insert existence check
   in the environment transaction, and `findProjectBySource`
   (`packages/db/src/data/environments.ts`, `projects.ts`). Raw-path equality
   remains only for display.
3. Indexes: `environments_host_path_key_idx` on `(host_id, path_key)`;
   `project_sources_host_path_key_idx` on `(host_id, path_key)`; a partial
   unique index `environments_live_path_key_idx` on
   `(project_id, host_id, path_key)` where `status != 'destroyed'` and
   `path_key IS NOT NULL`, which turns today's check-then-insert into a
   database guarantee under concurrency. `project_sources` keeps its existing
   `(project_id, host_id)` partial unique index; cross-project reuse of one
   path stays legal because it is legal today.
4. Collision policy: the migration counts live rows that would violate the new
   unique index before creating it and fails loudly with the colliding ids
   instead of choosing a survivor.
5. Application writes require `pathKey`; the server contract accepts an
   incoming `pathKey` only from the daemon, never from clients. Nullability
   is tightened in a later cleanup.

Test: two concurrent create requests for `C:\Work\bb` and `c:/work/bb/` on
the same host and project produce one environment; the second returns the
existing one.

**Contracts widen, they do not break.** `HostPlatform` gains `"win32"`
(`packages/host-daemon-contract/src/local.ts`); the desktop platform enum gains
`"windows"` (`packages/desktop-contract/src/info.ts`, `version-feed.ts`).
`HOST_DAEMON_PROTOCOL_VERSION` is bumped once per phase that changes wire
meaning, in one commit, never per file.

**Process rules.** `shell: true` stays forbidden. `.cmd`/`.bat` are run only
when the operation is explicitly a CMD command. PowerShell scripts run with
`-File` and separate arguments. Background helpers, provider processes, git
probes and cleanup processes use `windowsHide: true`; user-facing editor and
terminal launches stay visible.

## 5. The five seams

| Seam | Owner modules | Decisions |
|---|---|---|
| Host paths | `packages/domain/src/project-path.ts` (shape), `apps/server/src/services/hosts/host-paths.ts` (server-side opaque helpers, from the donor), daemon canonicalization, `plugins/environment-git-worktree/host/paths.ts`, `plugins/environment-personal-workspace/host/paths.ts` | Drive-absolute only; UNC rejected with a clear message; `pathKey` case-insensitive; every server POSIX gate (`workspace-paths.ts`, `thread-environment-directory.ts`, `environment-engine.ts` claimPath, `path-admission.ts`, `commands.ts` secret `serverPath`) routes through `host-paths.ts` |
| Executable and environment discovery | `packages/process-utils` (`resolveExecutable`), `packages/provider-bridge-protocol/src/bridge-kit/portable-executable.ts` (donor), `apps/host-daemon/src/runtime-shell-env.ts` | PATHEXT-aware lookup; npm `.cmd` shims are read and the target script is spawned as `node.exe <script>` directly, never through `cmd.exe /c` (Defender scores caret-escaped command lines as obfuscation); PATH on win32 comes from HKLM+HKCU `Environment\Path` plus a user-profile PowerShell probe anchored on the *last* marker pair; child env blocks carry exactly one `Path` key; executability is decided by extension and PATHEXT, not `access(X_OK)` |
| Process launch and stop | `packages/process-utils` (`spawnPortable*`, `terminateProcessTree`, enumeration), `apps/desktop/src/bb-process.ts`, `packages/config/src/verified-process-stop.ts` | Stop sequence with identity checks: (1) protocol-aware graceful shutdown; (2) snapshot the descendant tree as `{ pid, ppid, creationDate }` and send `taskkill /PID <leader> /T`; (3) after the grace period, the leader is force-killed only through the `ChildProcess` handle bb still holds (a PID cannot be recycled while a handle to it is open) and only while `exitCode === null`; descendants are re-snapshotted and each pid is force-killed individually only when its `creationDate` matches the earlier snapshot, mismatches are skipped and logged as `pid-reused`; no forced kill ever targets a bare PID whose identity was not re-verified; enumeration via `Get-CimInstance Win32_Process` with a 10 s timeout, a spawn registry, PPID walk and `matchEvidence` (`spawn-registry`, `executable-path`, `command-line`, `descendant`), `approximateCwd: true` declared in the type; a timeout is an error, never an empty list; Desktop runtime identity (`BB_DESKTOP_RUNTIME_ID`, `BB_DESKTOP_PARENT_PID`, runtime id in the health response, parent-PID watchdog in `bb-app`) replaces `ps`-based verification; no Job Object dependency in v1 |
| Terminal and shell | `apps/host-daemon/src/terminals/terminal-manager.ts`, `apps/host-daemon/src/provider-installation.ts` | ConPTY through node-pty; shell order `pwsh.exe`, then Windows PowerShell 5.1, then `ComSpec`, then `cmd.exe`; interactive terminals load the user profile (`-NoLogo` only, parity with POSIX `-lc`); bb's own probes, hooks and skill scripts use `-NoProfile -NonInteractive -ExecutionPolicy Bypass`; the PTY pid is registered as a sweep root once node-pty reports a non-zero pid; input is written as explicit UTF-8 bytes; kill degrades from two-stage to single close and the code says so |
| Open and reveal | `packages/local-open-targets` | A `windows` launch-adapter arm beside `macos`: Explorer (`explorer.exe /select,<path>` and `explorer.exe <dir>`), Windows Terminal (`wt.exe -d <dir>`) with PowerShell fallback, VS Code family via registry `App Paths` and `%LOCALAPPDATA%\Programs`, JetBrains Toolbox under `%LOCALAPPDATA%\JetBrains\Toolbox\apps`, default app via `ShellExecute`; `.cmd` editor shims launched through the seam-2 shim reader; icons fall back to built-in symbols |

## 6. Cross-cutting decisions

- **Environment hooks.** On win32 exactly one hook contract:
  `.bb-env-setup.ps1` and `.bb-env-teardown.ps1`, run by `pwsh.exe` if
  available, else `powershell.exe`, with
  `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <abs>`.
  cwd, sanitized env (`BB_*` and `NODE_ENV` stripped, resolved PATH), 15-minute
  timeout, streamed transcript and cancellation are byte-identical to POSIX;
  cancellation and timeout use `terminateProcessTree`. A `.sh` hook on win32
  fails provisioning with a message naming the `.ps1` contract; there is no
  Git Bash fallback for hooks. The four fixed names stay in
  `packages/domain/src/setup-script.ts`; no `.ts`, `.cmd` or `.bat` hook
  variants.
- **Skill scripts** (user content, not bb's runtime) follow the donor's launch
  matrix in `apps/host-daemon/src/skill-script-launch.ts`: `.ps1` runs through
  PowerShell with the flags above; `.cmd`/`.bat` through `cmd.exe /d /c` with
  the raw path as its own argv element; `.js`/`.mjs`/`.cjs` through the
  daemon's node; `.sh` and extensionless shebang files through `sh.exe` from
  Git for Windows when present, otherwise a loud error naming the file and the
  remedy. Automations scripts gain a `.ps1` interpreter and discover `bb.cmd`.
- **Desktop close policy.** Closing the last window on Windows minimizes to a
  tray icon and keeps the owned runtime alive so in-flight agent turns are not
  cut (donor `desktop-tray.ts`, `desktop-runtime-policy.ts`). Explicit Quit
  stops a *spawned* runtime and never touches an *attached* one.
- **Data directories.** Production `%USERPROFILE%\.bb`, development
  `%USERPROFILE%\.bb-dev\<instance>`, identical to POSIX. The donor's
  daemon-only `%APPDATA%\bb` redirect is not ported. Electron `userData`
  (`%APPDATA%\bb`) remains a separate thing and is documented as such.
- **Secrets.** `mode: 0o600` is a no-op on NTFS, so `packages/secret-storage`
  fails closed on win32. `readOrCreateSecretFile` and `writeSecretFile`
  create the file empty with `wx`, run
  `icacls <file> /inheritance:r /grant:r <sid>:F`, read the ACL back
  (`icacls <file>` output must list exactly the current user's SID with full
  control and nothing else), and only then write the secret bytes; the
  temp-and-rename path does the same on the temp file before the rename. Any
  failure removes the empty or temp file and throws an error naming the path
  and the remedy (a data directory on an NTFS volume). Existing secret files
  are checked the same way on first read and tightened; a file whose ACL
  cannot be tightened is an error, not a warning. `icacls` ships in
  `System32` on every supported Windows, so there is no fallback mode. Tests
  on win32 assert the ACL read-back and the no-content-before-ACL ordering;
  POSIX tests keep asserting mode bits. Desktop credentials already use
  Electron `safeStorage` (DPAPI) and need no change. Consumers today: the
  machine-auth secret, plugin HTTP tokens, plugin secret settings, the
  telemetry id.
- **Line endings.** `.gitattributes` gains `*.cmd text eol=crlf` and
  `*.bat text eol=crlf`; `.ps1` stays LF. The daemon's file-write path does not
  rewrite line endings of existing files; providers own their edits. Recorded
  as a known limitation, not changed here.
- **Symlinks and junctions.** bb never creates symlinks on win32;
  `prepare-plugin-runtime.ts` keeps `"junction"`. `path-mutations.ts` keeps
  refusing every reparse point (symlinks and junctions alike) for move and
  remove: its `requireExistingWithin` resolves the target through
  `fs.realpath` before `rename`/`rm`, so lifting the guard would delete or
  move the junction's target directory instead of the link. Junctions remain
  readable and listable. win32 tests cover remove, move and a
  junction-substitution race, each asserting the target directory is
  untouched. Repositories that contain symlinks depend on Developer Mode and
  `core.symlinks`; documented.
- **Architecture and identity.** x64 only. Desktop keeps `dev.bb.desktop` /
  `bb` (and the nightly variants); the donor's `bb wn` / `cl.bb.wn` identity is
  not ported. Windows artifact name `bb-<version>-x64.exe`, NSIS per-user
  (`oneClick: false`, `perMachine: false`,
  `allowToChangeInstallationDirectory: true`).
- **Signing.** A third signing mode `windows` beside `environment`,
  `keychain`, `disabled` in `apps/desktop/scripts/run-electron-builder.mjs`,
  implemented with electron-builder Azure Trusted Signing options and driven
  by CI secrets. No secrets means an unsigned build, permitted only for the
  nightly channel and fork builds; the stable channel refuses to publish
  unsigned. SmartScreen behaviour of unsigned builds is documented. No
  certificate exists today.
- **Auto-update.** `resolveDesktopUpdateSupport` gains a `windows` arm with
  `autoUpdate: true`; `updateMetadataFileNames` gains `windows: latest.yml`;
  the version feed gains `desktop-version-windows.json`; before installing an
  update the runtime tree is stopped so no file is locked.
- **WSL.** `resolveHostPlatform` keeps `"wsl"` for Linux-under-WSL daemons.
  A native Windows daemon reports `"win32"`. Nothing spawns `wsl.exe`.

## 7. Phases

Each phase is one branch in the fork, one implementation plan, one measured
gate on the reference desktop before the next phase starts. "Donor" names the
#3188 files consulted or cherry-picked; every ported fragment is read, adapted
to current `main`, and covered by a test.

### Phase 0 — Foundation and honest gating

Scope: remove `os: ["darwin","linux"]` from `packages/bb-app/package.json`
and `apps/desktop/package.json` (update `packages/bb-app/test/index.test.ts`
and `scripts/build-host.mjs`); measure `node-pty@1.2.0-beta.15` on Node 24
and record whether a win32-x64 prebuild exists (decision recorded in
`docs/platform-windows.md`: pin a version with prebuilds, add a
`prebuild-install`-style step to `bb-app`, or ship a doctor check naming the
Build Tools prerequisite); replace `/tmp/` in
`apps/server/vitest.config.ts`, `apps/host-daemon/vitest.config.ts`,
`tests/integration/vitest.config.ts` with a `tmpRoot()` helper in
`@bb/test-helpers` and add an oxlint rule banning `"/tmp/` literals (the
sweep of the remaining files proceeds package by package as their suites are
enabled on Windows); replace the bash `scripts/bb-dev-app` with a Node
supervisor behind `dev:desktop`, `dev:status`, `dev:stop`; fix the `rm -rf`
`clean` scripts, the single-quoted `--exclude` glob, the `1>&2` redirect, and
the `ps` shell-out in `tests/qa/scripts/run-root-command.mjs`; add
`.gitattributes` CRLF rules; add a non-required `windows-x64` job (pinned
`windows-2025` image, pnpm via `pnpm/action-setup` or a Windows case in
`install-pnpm.sh`) running install, typecheck, build and the tests of
`@bb/domain`, `@bb/process-utils`, `@bb/host-daemon`, `@bb/desktop`; document
prerequisites (`core.longpaths`, `core.symlinks` or Developer Mode,
`LongPathsEnabled`, Build Tools when needed).

Donor: `scripts/ensure-native-modules.mjs`, `.github/workflows/win-native.yml`.
Protocol: no bump.
Gate: `pnpm install` and `pnpm exec turbo run build typecheck` green on the
reference desktop and on the Windows job; failing-test count per package
recorded as the baseline in `qa/windows/phase-0/`.

### Phase 1 — Host identity and host-owned paths

Scope: `win32` in `resolveHostPlatform`, the contract enum, the server system
route and the Machines settings UI; `windows` in the desktop contract and
`resolveBbDesktopPlatform`; `project-path.ts` accepts drive-absolute paths,
rejects UNC, derives project names from either separator; every server POSIX
gate listed in §5 routes through `host-paths.ts`; daemon canonicalization
returning `{ path, pathKey }`; Drizzle migration adding `path_key` to
`project_sources` and `environments` with backfill; managed-path derivation in
`environment-git-worktree` and `environment-personal-workspace` host code
without `path.posix`; app-side `absolute-file-path.ts`,
`markdown-local-file-link.ts`, `RemotePathBrowser`, `ProjectPathDialog`,
`ProjectMachineSetupDialog`, `useLocalPathPicker`;
`resolveInheritedDevSkillsRootPaths` in `@bb/config` stops rejoining with `/`.

Donor: `apps/server/src/services/hosts/host-paths.ts`,
`packages/domain/src/project-path.ts`, `apps/app/src/lib/absolute-file-path.ts`,
`apps/app/src/components/ui/markdown-local-file-link*.ts`.
Protocol: bump 1 (`statusResponse.platform` domain, provision payload).
Gate: a project on `C:\` is created from the UI and the CLI; a managed
worktree of a hook-less repository provisions and is removed; `C:/x`, `C:\x`
and `c:\X` resolve to one project identity; two concurrent creates of
equivalent paths yield one environment (the §4 test); the migration's
collision check is exercised against a fixture with duplicate live rows;
POSIX suites unchanged.

### Phase 2 — Processes, environment, Git, hooks, open targets

Scope: `packages/process-utils` win32 arm (`resolveExecutable`,
`terminateProcessTree`, CIM enumeration with timeout and `matchEvidence`,
spawn registry, `windowsHide` defaults, single `Path` key in
`sanitizeInheritedChildProcessEnv` and the four `{ ...process.env, PATH }`
sites); `runtime-shell-env.ts` Windows PATH resolution; git layer:
`runShellPipeline` reimplemented without `/bin/sh` (node-side pipe of
`git diff` into `git patch-id`), `detectLinkedWorktree` separator-neutral,
`findWorktreeForBranch` CR-tolerant, `gh.exe` discovery in the GitHub plugin
and `git-host.ts`; `.ps1` hooks in `environment-lifecycle-script.ts`;
`skill-script-launch.ts`; automations `.ps1` interpreter and `bb.cmd`
discovery; `apps/cli/bin/bb.cmd` plus a launch spec where Node always spawns
`process.execPath` with the JS entry and only agent shells see `bb.cmd`;
`verified-process-stop.ts` replaced by runtime identity; `local-open-targets`
Windows arm; native folder picker on win32 through a PowerShell
`FolderBrowserDialog` (Desktop keeps using Electron's dialog).

Donor: `packages/process-utils/src/index.ts`,
`packages/provider-bridge-protocol/src/bridge-kit/portable-executable.ts`,
`packages/host-workspace/src/portable-command.ts`,
`apps/host-daemon/src/skill-script-launch.ts`,
`apps/host-daemon/src/runtime-shell-env.ts`,
`packages/local-open-targets/src/index.ts`, `apps/cli/bin/bb.cmd`,
`apps/host-daemon/src/command-handlers/native-folder-picker.ts`.
Protocol: bump 2 if any wire field changes; otherwise none.
Gate: a worktree with `.bb-env-setup.ps1` streams output, times out and
cancels; cancellation leaves no descendants (`tasklist` before/after in
`qa/windows/phase-2/`); a PID-reuse stress test (a spawn-and-exit loop
running while a tree is force-killed) leaves every unrelated process alive
and logs `pid-reused` skips; secret files created on win32 read back an ACL
containing only the current user; junction remove, move and substitution are
refused with the target untouched; Open in Explorer, VS Code and Windows
Terminal work; `bb` runs from PowerShell; process enumeration over-match and
under-match cases are reproduced and documented.

### Phase 3 — ConPTY, providers, watcher, native `bb-app`

Scope: `terminal-manager.ts` Windows shell resolution, ConPTY spawn with a
profile-loading interactive shell, resize, kill semantics, sweep-root
registration, UTF-8 input; `provider-installation.ts` through ConPTY;
`provider-maintenance-kit.ts` (`where`, PATHEXT, shim reading, install
commands without `sh -c`/`curl`); launch specs for Codex (`codex.exe`),
Claude Code (`claude.exe`), Pi (`pi.exe`/`bun.exe`) and ACP agents; provider
install matrix limited to verified native installers, with a capability
message instead of a doomed button; `host-watcher` ignore-list separator test
and fix; `apps/desktop/src/log-viewer.ts` incremental reader without `tail`;
`bb-app` tarball smoke on the Windows job; `docs/platform-support.md`,
`README.md` and `packages/bb-app/README.md` declare native Windows a beta
runtime.

Donor: `apps/host-daemon/src/terminals/terminal-manager.ts`,
`packages/provider-bridge-protocol/src/bridge-kit/provider-maintenance-kit.ts`,
`apps/desktop/scripts/smoke-windows-conpty.mjs`, `apps/desktop/src/log-viewer.ts`,
`packages/host-watcher/src/watch-event-path.ts`, provider plugin
`provider-maintenance.ts` files.
Protocol: bump if any wire field changes.
Gate: the in-app terminal handles Ctrl+C, resize and UTF-8 echo; a real Codex
turn and a real Claude Code turn read and write files under a `C:\` project;
watcher events fire on NTFS; `npx bb-app` starts from a clean PowerShell
session; ConPTY smoke 6/6 (spawn-echo, utf8, resize, ctrl-c, close, tree).

### Phase 4 — Windows Desktop

Scope: electron-builder `win` target (NSIS per-user x64, `.ico` assets,
`artifactName`), `resolveDesktopBuildPlatform` and `packaged-app-paths`
windows arms, `app.setAppUserModelId`, `prepare-native-modules.cjs` staging
ConPTY natives (`conpty.node`, `conpty_console_list.node`, `winpty.dll`,
`winpty-agent.exe`) outside asar and fetching the Electron-ABI
`better-sqlite3`; `bb-process.ts` Windows runtime (non-detached child,
`windowsHide`, runtime id and parent pid, tree-kill on quit, no SIGTERM path);
tray and runtime policy; `session-end` handling; second-instance argv
forwarding; `titleBarStyle: "hidden"` with `titleBarOverlay`; signing mode
`windows`; update support, `latest.yml`, version feed; `build-desktop.yml`
windows job feeding the single publish job; packaged-app smoke on Windows;
`electron-builder-config.test.ts` assertions for the new target.

Donor: `apps/desktop/src/bb-process.ts`, `desktop-tray.ts`,
`desktop-runtime-policy.ts`, `desktop-update-provider.ts`,
`scripts/run-electron-builder.mjs`, `scripts/prepare-native-modules.cjs`,
`scripts/smoke-windows-processes.mjs`, `.github/workflows/win-release.yml`.
Protocol: none expected.
Gate: as a standard user, install, use, update N to N+1, uninstall; zero
orphan processes after Quit (`tasklist` diff) while an unrelated process
started during the run is still alive afterwards; SmartScreen state
documented; macOS and Linux desktop builds unchanged.

### Phase 5 — Persistent host and GA hardening

Scope: `apps/server/src/assets/install-machine.ps1` served at
`GET /install.ps1` (per-server data dir, private npm prefix, artifact
download with SHA-256 verification, Scheduled Task at logon with a per-user
`Run` key fallback, port-collision handling with a running Desktop), the
PowerShell command in `AddMachineDialog`, `bb connect` machine-code pairing
on Windows, `docs/multiple-devices.md`; Windows jobs promoted to required
(`Checks (windows-2025)`, `Package Smoke (windows-2025)`, desktop build), the
branch-protection list in `docs/platform-support.md` updated; the clean-VM
checklist executed with the WSL feature disabled and evidence stored in
`qa/windows/phase-5/`; docs flip from beta to supported; the
`skipIf(win32)` audit closed.

Donor: `apps/server/src/assets/install-machine.ps1`,
`apps/app/src/components/dialogs/AddMachineDialog.tsx`,
`docs/multiple-devices.md`, `qa/CHECKLIST-WIN11.md`.
Protocol: none expected.
Gate: every row of §2 is true.

## 8. Verification and CI

**Measurement rule.** No Windows behaviour is claimed until it has run on
Windows. A Linux test asserting "`powershell.exe` was requested with these
arguments" verifies the contract, not the behaviour; where the difference
matters the test is `win32`-gated and runs on the Windows job and on the
reference desktop.

| Layer | Runs on | Proves |
|---|---|---|
| Unit tests with injected platform | Linux CI, both branches | win32 logic, parsing, path math |
| `win32`-gated real tests and smoke scripts | Windows CI and the reference desktop | ConPTY, `taskkill`, CIM, NSIS, real processes |

- Every existing `skipIf(process.platform === "win32")` either gets a Windows
  equivalent or an entry in `docs/platform-windows.md` stating why the
  behaviour is unreachable. An early `return` that leaves a test green is a
  bug.
- Smoke scripts become Turbo tasks with explicit inputs and outputs.
- Evidence per phase lives in `qa/windows/<phase>/`: `tasklist` snapshots,
  transcripts, versions, the exact commands run.
- The Windows runner image is pinned (`windows-2025`); Ubuntu stays the
  required gate until Phase 5. macOS/Linux/WSL regression uses the existing
  required checks on every phase.
- Turbo caching stays platform-keyed through `BB_BUILD_TOOLCHAIN`.

## 9. Risks and prepared responses

- **node-pty prebuilds.** If no win32-x64 prebuild exists for Node 24 or the
  Electron 41 ABI, `npx bb-app` on a clean machine fails at build. Phase 0
  decides between pinning a version with prebuilds, a `prebuild-install`-style
  step in `bb-app`, or a doctor check naming Build Tools. Decided by
  measurement.
- **No Job Objects.** Without a Job Object, descendants bb never observed
  can escape the tree, and a forced kill by PID can hit a recycled PID. The
  §5 identity checks (held handle for the leader, `creationDate` match for
  descendants, skip on mismatch) close the recycled-PID case; the escaped
  descendant case stays open. Trigger to add a native Job Object helper: the
  Phase 4 "zero orphans after Quit" gate fails repeatedly.
- **CIM probe latency (about 1.2 s).** Cache per sweep interval, 10 s timeout,
  degrade to an error rather than an empty list.
- **NTFS locks on worktree removal** (`EBUSY` from `node_modules`, editors).
  Retry with backoff, then a clear error naming the holders when known.
- **MAX_PATH** in the pnpm store. `LongPathsEnabled` and `core.longpaths` are
  prerequisites checked by the doctor step.
- **`core.autocrlf=true` on developer machines.** `.gitattributes` forces LF;
  hook and script tests include a CRLF-input case.
- **Repository symlinks** need Developer Mode; documented, not worked around.
- **SmartScreen on unsigned builds.** "More info, Run anyway" documented until
  a certificate exists.
- **Donor quality.** The donor was produced by thirteen parallel agents;
  every ported fragment is read and tested rather than trusted.
- **Upstream drift.** `main` moves about 150 commits a month; phases are short
  and rebased onto fork `main` before each gate.

## 10. Donor policy and upstream slicing

- The #3188 diff is MIT and is the primary donor. Cherry-pick where it applies
  cleanly; hand-port where `main` moved (provisioning, routes, protocol).
- Not ported: the `bb wn` / `cl.bb.wn` identity, root `ASSUMPTIONS.md`,
  `DECISIONS.md`, `KNOWN-ISSUES.md`, the `qa-evidence/` tree, the
  `%APPDATA%\bb` daemon redirect, the `-NoProfile` interactive terminal.
- Known limitations live in `docs/platform-windows.md`; the manual checklist
  lives in `qa/windows/CHECKLIST.md`.
- Commits are grouped by seam within each phase so the fork history can later
  be sliced into upstream pull requests of reviewable size. Upstream requires
  contributor approval before a pull request; that step is outside this
  design.

## 11. Work structure

- This document is the umbrella spec. Each phase gets its own implementation
  plan under `docs/superpowers/plans/` and its own branch
  `windows-native/phase-<n>` in the fork, merged into fork `main` after its
  gate.
- Reference desktop: Windows 11 Pro 10.0.26200, Node 24.12, pnpm 9.15 via
  corepack, Git for Windows 2.52, PowerShell 7.6 and 5.1, Visual Studio 2026
  Build Tools, Python 3.13, native `codex.exe` and `claude.exe` installed,
  WSL present (so the Phase 5 no-WSL run uses a separate clean VM).
- The fork is public, so GitHub-hosted Windows runners are free.
