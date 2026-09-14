# Native Windows Port — Phase 2 (Processes, environment, Git, hooks, open targets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a native Windows host the daemon can start, watch and stop process trees without leaving descendants or killing recycled PIDs, resolve the user's PATH and executables the Windows way, run `.bb-env-setup.ps1`/`.bb-env-teardown.ps1` hooks, run git and `gh` without `/bin/sh`, run automations through PowerShell, launch `bb` from PowerShell, protect secret files with an NTFS ACL, refuse junction mutations, and open a workspace in Explorer, VS Code or Windows Terminal.

**Architecture:** Every Windows branch is a `platform === "win32"` arm beside untouched POSIX code; the POSIX behaviour of every shared module stays byte-identical to `windows-native/phase-1` (07fdce05b). `@bb/process-utils` gains the Windows process primitives (`resolveExecutable`, `terminateProcessTree`, CIM enumeration with identity checks, a spawn registry, a single-`Path` env normaliser) and every other seam consumes them: the daemon's shell-env resolver, the hook runner, the git layer, automations, the CLI launcher, `verified-process-stop`, `local-open-targets` and the folder picker. Windows system tools (`taskkill.exe`, `icacls.exe`, `whoami.exe`, `reg.exe`, `powershell.exe`) are spawned by absolute `%SystemRoot%\System32` path, never through `cmd.exe`, never with `shell: true`.

**Tech Stack:** pnpm 9.15.0, Turbo, Vitest 4, TypeScript, zod, cross-spawn (already a `@bb/process-utils` dependency), PowerShell 7 / Windows PowerShell 5.1, node-pty (unchanged).

**Spec:** `docs/superpowers/specs/2026-09-11-native-windows-port-design.md` (§4 Process rules, §5 seams "Executable and environment discovery", "Process launch and stop", "Open and reveal", §6 Environment hooks, Skill scripts, Secrets, Symlinks and junctions, §7 Phase 2, §8 Verification, §9 Risks).

## Global Constraints

- **User rule (binding, overrides the donor and any ruling):** POSIX behaviour of shared code stays byte-identical to 07fdce05b. New validation, new spawn paths, new identity checks and new env normalisation exist only inside `platform === "win32"` arms. A shared function may gain an optional `platform?: NodeJS.Platform` parameter defaulting to `process.platform` (testability, not behaviour), and a shared module may gain a new export that POSIX callers do not call. Existing POSIX tests are not rewritten; they may only be split so that a mode-bit or `/bin/sh` assertion stays on POSIX. A reviewer treats "a POSIX user could notice this" as an Important finding.
- Platform is injected, never ambient: `process.platform` is read only as a default parameter value or at composition roots (daemon start, CLI entry `apps/cli/src/index.ts`, script entry points) (spec §4).
- `shell: true` stays forbidden everywhere. `.cmd`/`.bat` files run only when the operation is explicitly a CMD command (`cmd.exe /d /c <file> args…` with the file path as its own argv element). PowerShell scripts run with `-File` and separate arguments; bb's own probes use `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass`. Background helpers, probes, git and cleanup processes pass `windowsHide: true`; user-facing editor and terminal launches stay visible (spec §4).
- Windows system tools are spawned by absolute path from `resolveWindowsSystemToolPath(name, env)` (`%SystemRoot%\System32\<name>`, default `C:\Windows`), because Git Bash and other shims put same-named POSIX tools first on PATH (measured: `whoami` on the reference desktop resolves to GNU coreutils).
- Tool output is never parsed for localized text: success and failure are decided by exit codes, liveness re-checks and structured output (`ConvertTo-Json`, `/fo csv`). Measured: `taskkill` prints its messages in the console code page (Russian on the reference desktop).
- Stop sequence identity rules (spec §5): the leader is force-killed only through the `ChildProcess` handle bb holds and only while `exitCode === null && signalCode === null`; descendants are force-killed individually by PID only when their `CreationDate` equals the one recorded in the earlier snapshot; a mismatch is skipped and reported as `pid-reused`; a CIM enumeration timeout (10 s) is an error, never an empty list; Windows sweep results carry `approximateCwd: true` and a `matchEvidence`.
- `HOST_DAEMON_PROTOCOL_VERSION` stays 200 unless a task changes a server/daemon wire field; the plan expects no bump (the automations interpreter enum is a plugin RPC type, the local daemon HTTP status is not the daemon protocol, hook progress is unchanged). If a task finds it must change a wire field, it bumps once in that task's commit and says so in its report.
- Code comments are forbidden in TypeScript and JavaScript except semantic tool directives (`AGENTS.md`). No `as X` casts outside boundary parsing.
- Builds, typechecks and tests run through Turbo: `pnpm exec turbo run <task> --filter=<pkg>`; single files may be run with `pnpm --filter <pkg> exec vitest run <file>` while iterating; every task ends with the Turbo `typecheck` of the touched packages and the Turbo `test` of every package whose tests changed. `@bb/server` and `@bb/host-daemon` suites are load-sensitive on Windows: run changed files individually there.
- Measurement rule (spec §8): no Windows behaviour is claimed until it has run on Windows. Pure logic with injected platform/runner runs everywhere; real-process, ACL, junction, registry and dialog behaviour is `it.runIf(process.platform === "win32")` and runs on the reference desktop and the `windows-x64` CI job. An early `return` that leaves a test green is a bug.
- Formatter: run `pnpm exec oxfmt <files>` on every touched `.ts`/`.mjs`/`.md` file before committing; Windows literals in TypeScript use doubled backslashes; Windows-line-ending files are only `*.cmd`/`*.bat` (`.gitattributes` already forces CRLF for them); `.ps1` stays LF (spec §6).
- Donor policy (spec §10): fragments from `refs/remotes/upstream-pr/3188` are read, adapted and tested, never applied blindly; the donor's `shell: true` spawn options, its skip-and-continue for `.sh` hooks on Windows, its `cmd.exe /c start` default-app launch and its bare-PID `taskkill /F`-first stop are not ported. Known limitations go to `docs/platform-windows.md`, evidence to `qa/windows/phase-2/`.
- Commits are grouped by seam; each task ends with one commit whose message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` followed by `Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4`.
- Phase gate (spec §7): a worktree with `.bb-env-setup.ps1` streams output, times out and cancels; cancellation leaves no descendants (`tasklist` before/after); a PID-reuse stress test leaves every unrelated process alive and logs `pid-reused` skips; secret files created on win32 read back an ACL containing only the current user; junction remove, move and substitution are refused with the target untouched; Open in Explorer, VS Code and Windows Terminal work; `bb` runs from PowerShell (including from a directory with a space); process enumeration over-match and under-match cases are reproduced and documented; POSIX suites unchanged (WSL run).

## Rulings recorded before execution

These resolve every place where the spec, the donor and the current tree disagree. Each is binding for the task that cites it.

- **R1 Platform injection.** `@bb/process-utils` request/argument types gain `platform?: NodeJS.Platform` (default `process.platform`) and `supportsProcessGroups(platform?)`, `isProcessGroupAlive(child, platform?)` gain the same optional parameter. `PortableSpawnRequest.windowsHide` stays (the dev launcher uses it); on win32 an `undefined` value becomes `true`; on POSIX the field is passed through unchanged.
- **R2 `runShellPipeline` stays on POSIX.** The `/bin/sh` implementation, its error codes and its tests are untouched. A new `runGitOutputPipeline(producerArgs, consumerArgs, options)` pipes two `git` processes in Node and maps failures to the same `shell_pipeline_timeout` / `shell_pipeline_failed` / `provision_cancelled` codes; `Workspace.detectSquashMerge` calls it only when `platform === "win32"`.
- **R3 Stop sequence.** New `terminateProcessTree` implements the spec's identity rules on win32; `stopProcessGroupLeaderFirst` and the hook runner's cancel/timeout path delegate to it on win32; `killProcessGroup` on win32 keeps today's `child.kill(signal)` (synchronous callers) and is documented as leader-only there. The sweep (`killProcessesWithCwdUnder`) verifies `CreationDate` against a fresh snapshot immediately before each per-PID `taskkill /F` and reports skips through an optional `onSkippedProcess` callback that the daemon wires to its logger as `pid-reused`. No `/T` force kill by bare PID anywhere.
- **R4 Executable resolution.** `resolveExecutable({ command, env, platform, cwd? })` lives in `@bb/process-utils`; on POSIX it mirrors `which` (PATH walk, `X_OK`); on win32 it walks `Path` with `PATHEXT` (default `.COM;.EXE;.BAT;.CMD;.PS1`) and decides executability by extension only. `readNodeCmdShim(shimPath)` parses npm-style `.cmd` shims (`@node "%~dp0…" %*`, `"%dp0%\node.exe" "%dp0%\..\x.js" %*` and the `%~dp0` forms) into `{ command: process.execPath, args: [script] }` or `null`. `experimental_resolveExecutablePath` in `provider-maintenance-kit` is Phase 3 and is not touched.
- **R5 PATH on win32.** `resolveUserShellPath` on win32 first reads `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path` and `HKCU\Environment\Path` through `reg.exe query … /v Path` (REG_EXPAND_SZ expanded against the daemon env), joins machine then user, then runs the PowerShell profile probe (`pwsh.exe` if found, else `powershell.exe`, `-NoLogo -Command <script>` printing `__BB_SHELL_ENV_START__`, base64 `Name=Value` pairs, `__BB_SHELL_ENV_END__`) and prefers the probe's `Path` when the last marker pair parses; otherwise the registry PATH; otherwise the inherited `Path`. The win32 probe timeout is 8 s (PowerShell cold start measured at about 2.6 s). An `SHELL` pointing at an sh-like shell on win32 is ignored (bb's probes never run Git Bash).
- **R6 Hooks.** Exactly one hook contract on win32: `.bb-env-setup.ps1` / `.bb-env-teardown.ps1`, names exported from `packages/domain/src/setup-script.ts` beside the POSIX names. A workspace that has only the `.sh` hook on win32 fails provisioning with a message naming the `.ps1` contract (setup) or reports the teardown failure without blocking removal (teardown), never skip-and-continue. The interpreter is `pwsh.exe` when found, else `powershell.exe`, with `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <abs>`.
- **R7 Skill scripts.** bb never spawns skill scripts itself (agents run them through their own shell), so the donor's unwired `skill-script-launch.ts` is not ported. The launch matrix from spec §6 is documented in `docs/platform-windows.md` as guidance for agents on Windows; Phase 3 revisits it with the provider launch specs.
- **R8 Automations.** `automationScriptInterpreterSchema` gains `"powershell"`; `.ps1` maps to it; on win32 `bbBinaryCandidates` adds `bb.cmd` beside `bb` for `BB_CLI_DIR` and every PATH entry and drops the Homebrew fallbacks; `isExecutableFile` on win32 decides by extension; interpreter commands are resolved through `resolveExecutable` on win32 (`node`, `python3` then `python`, `pwsh` then `powershell`); POSIX keeps bare command names. The `powershell` interpreter on POSIX resolves to `pwsh`.
- **R9 CLI launcher.** `apps/cli/bin/bb` and `apps/cli/bin/title` stay exactly the `#!/bin/sh` files they are today — no Node rewrite, no extra process, no changed signal delivery on POSIX. Windows gets two new sibling shims: `apps/cli/bin/bb.cmd` is `@node "%~dp0..\dist\index.js" %*` and `apps/cli/bin/title.cmd` is `@title %*` (cmd's built-in `title` sets the console title and Windows Terminal keeps it after the shim exits); the `bin` field is unchanged. The daemon bundle writes its own `dist/bb.cmd` (`@node "%~dp0bb" %*`) and `dist/title.cmd`, because the bundle's relative target differs from the checkout's, and the bb-app host package ships `host-daemon/dist/bb.cmd`. `runBundledCliCommand`, `maybeReexecViaBbCli` and `resolveBbAppProcessSpawnOptions`-style helpers never use `shell: true` and never go through `cmd.exe`: on win32 a target ending in `.cmd`/`.bat` is parsed with `readNodeCmdShim` and spawned as `process.execPath <script> <argv…>`, and a shim that does not parse is an error, `Windows launcher <path> is not a Node shim bb can start directly`. Every other target, and every POSIX target, is spawned as-is.
- **R10 Verified stop.** `verified-process-stop.ts` keeps its `VerifiedProcessOps` seam and the POSIX `ps` implementation; `createNodeVerifiedProcessOps(platform?)` returns a win32 implementation that reads `CommandLine` and `CreationDate` from `Get-CimInstance Win32_Process -Filter "ProcessId = N"` and collapses the two-stage signal to one `process.kill(pid)` after verification. The spec's `BB_DESKTOP_RUNTIME_ID` / parent-PID watchdog design is deferred to Phase 4 (Desktop) where the owned-runtime policy needs it; recorded in `docs/platform-windows.md`.
- **R11 Open targets.** The donor's `windows` launch-adapter arm is ported and extended: `explorer.exe /select,<path>` for files (the donor opened only the directory), a `terminal` target `wt.exe -d <dir>` with a visible `pwsh.exe`/`powershell.exe` console fallback, VS Code family discovery from `resolveExecutable` (a `Path` + `PATHEXT` walk, never `where.exe`), `HKLM/HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\<exe>` (`reg.exe query`) and `%LOCALAPPDATA%\Programs` / `%ProgramFiles%`, JetBrains Toolbox from `%LOCALAPPDATA%\JetBrains\Toolbox`, default app via `explorer.exe <file>` (ShellExecute; the donor's `cmd.exe /c start` is not ported), `.cmd` editor shims through `readNodeCmdShim` first and `cmd.exe /d /c <shim>` otherwise, icons from the static adapter icon. `explorer.exe` exit code 1 is success only when the path exists.
- **R12 Folder picker.** `pickHostFolder` gains a win32 arm running a PowerShell `System.Windows.Forms.FolderBrowserDialog` under `-STA`; `supportsNativeFolderPicker` becomes `platform === "darwin" || platform === "win32"`. Desktop on Windows uses the daemon picker like it uses the daemon's `osascript` picker on macOS today; no Electron dialog wiring in this phase.
- **R13 Secrets.** `@bb/secret-storage` gains a win32 arm: the current user's SID and account name come from `%SystemRoot%\System32\whoami.exe /user /fo csv` (cached per process); tightening is `icacls.exe <file> /inheritance:r /grant:r *<SID>:F`; read-back is `icacls.exe <file>` parsed as exactly one ACE line whose identity equals the account name (case-insensitive) or the raw SID and whose rights are `(F)`; ordering is create-empty-`wx` → tighten → verify → write bytes (temp file for `writeSecretFile`, then rename); any failure removes the empty/temp file and throws an error naming the path and the remedy (a data directory on an NTFS volume); an existing file is tightened and verified on the first read per process. A new `readSecretFile(path)` export replaces the raw `readFile` in `plugin-settings.ts` (POSIX body is the same `readFile`). Out of scope and documented: `plugins/account-pool`, `plugins/secrets`, the host daemon's `auth-state.ts` and `identity.ts` own their files.
- **R14 Junctions.** Measured on the reference desktop: `fs.lstat` reports a junction as `isSymbolicLink() === true`, so `path-mutations.ts` already refuses junctions; the task adds win32 tests (remove, move, substitution race) and changes nothing in the POSIX test. `plugins/provider-claude-code/src/bridge/skill-plugins.ts` creates its skills link as `"junction"` on win32 (a `"dir"` symlink needs Developer Mode) and keeps `"dir"` elsewhere.
- **R15 Single `Path` key.** `sanitizeInheritedChildProcessEnv` gains `platform?`; on win32 with `shellPath` it removes every case variant of `PATH` and sets `Path`; without `shellPath` it copies keys as they are. A new `assignPathEnv({ env, path, platform })` returns `{ ...env, PATH: path }` on POSIX (byte-identical to today's spreads) and the single-`Path` block on win32; the four spread sites (`command-dispatch.ts`, `protocol-self-update.ts`, `local-open-targets/src/index.ts`, `plugins/automations/src/script-runner.ts`) call it. `docs/api_to_audit.md` records the win32 arm of the SDK-visible `experimental_sanitizeInheritedChildProcessEnv`.
- **R16 Git worktree helpers.** `detectLinkedWorktree` normalises `\` to `/` only when `platform === "win32"`; `findWorktreeForBranch` is unchanged because `git worktree list --porcelain` emits LF and `/`-separated paths on Windows (measured); a test pins the `C:/` parse. `readEmptyTreeSha` keeps `os.devNull` (measured: native git accepts `NUL`). The worktree plugin's `host.test.ts` fixtures replace `mkdir -p` and `sleep` with `fs.mkdir` and a Node sleeper.
- **R17 `gh`.** `gh.exe` is a real executable, so bare `gh` already spawns on Windows; `plugins/github/server.ts` `resolveGh` gains win32 candidates (`resolveExecutable("gh")`, `%ProgramFiles%\GitHub CLI\gh.exe`, `%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe`) and keeps the POSIX list; `git-host.ts` is unchanged. Its unsanitized `run()` env is a pre-existing upstream finding, not fixed here.
- **R18 Dev launcher.** `pnpm dev:stop`'s unverified `taskkill` stays a documented limitation; it is developer tooling outside the product seams.

## File Structure

| Path                                                                                                                                                                                                                                                                           | Responsibility                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/process-utils/src/index.ts`                                                                                                                                                                                                                                          | Platform-injected spawn helpers, `windowsHide` default, `assignPathEnv`, win32 `sanitizeInheritedChildProcessEnv`, re-exports of the new modules |
| `packages/process-utils/src/windows-system-tools.ts`                                                                                                                                                                                                                           | `resolveWindowsSystemToolPath`, `resolvePowerShellExecutable`                                                                                    |
| `packages/process-utils/src/resolve-executable.ts` (+ `test/resolve-executable.test.ts`)                                                                                                                                                                                       | `resolveExecutable`, `readNodeCmdShim`, `windowsExecutableExtensions`                                                                            |
| `packages/process-utils/src/windows-process-snapshot.ts` (+ test)                                                                                                                                                                                                              | CIM enumeration request, JSON parse with `CreationDate`, 10 s timeout as error, spawn registry, `matchWindowsProcessesUnderDirectory`            |
| `packages/process-utils/src/windows-process-stop.ts` (+ test)                                                                                                                                                                                                                  | `terminateProcessTree`, win32 arms of `stopProcessGroupLeaderFirst`, `listProcessesWithCwdUnder`, `killProcessesWithCwdUnder`                    |
| `packages/process-utils/test/windows-process-real.test.ts`                                                                                                                                                                                                                     | `it.runIf(win32)` real tree termination, PID-reuse skip, hidden window                                                                           |
| `apps/host-daemon/src/command-dispatch.ts`, `src/protocol-self-update.ts`, `packages/local-open-targets/src/index.ts`, `plugins/automations/src/script-runner.ts`                                                                                                              | Child env through `assignPathEnv`                                                                                                                |
| `apps/host-daemon/src/runtime-shell-env.ts` (+ test)                                                                                                                                                                                                                           | win32 registry PATH, PowerShell profile probe anchored on the last marker pair, `bb.cmd` names                                                   |
| `packages/domain/src/setup-script.ts`                                                                                                                                                                                                                                          | `WINDOWS_ENV_SETUP_SCRIPT_NAME`, `WINDOWS_ENV_TEARDOWN_SCRIPT_NAME`                                                                              |
| `apps/host-daemon/src/environment-lifecycle-script.ts` (+ test)                                                                                                                                                                                                                | `.ps1` resolution and command on win32, `.sh`-only failure message, `terminateProcessTree` on cancel/timeout                                     |
| `packages/host-workspace/src/git.ts`, `src/workspace.ts` (+ tests)                                                                                                                                                                                                             | `runGitOutputPipeline`, win32 `detectLinkedWorktree`                                                                                             |
| `packages/environment-provider-host/test/git.test.ts`                                                                                                                                                                                                                          | `findWorktreeForBranch` pins `C:/` porcelain paths                                                                                               |
| `plugins/environment-git-worktree/host.test.ts`                                                                                                                                                                                                                                | Portable fixtures                                                                                                                                |
| `plugins/github/server.ts` (+ test)                                                                                                                                                                                                                                            | win32 `gh` candidates                                                                                                                            |
| `plugins/automations/src/rpc-types.ts`, `src/script-files.ts`, `src/script-runner.ts`, `src/cli.ts`, `skills/automations/SKILL.md` (+ tests)                                                                                                                                   | `powershell` interpreter, win32 `bb.cmd` discovery                                                                                               |
| `apps/cli/bin/bb.cmd`, `bin/title.cmd`, `apps/cli/src/bb-cli-reexec.ts`, `apps/cli/src/index.ts` (+ tests), `apps/host-daemon/scripts/build-bundles.mjs`, `packages/bb-app/scripts/build-host.mjs`, `packages/bb-app/package.json`, `packages/bb-app/src/launcher.ts` (+ test) | `.cmd` shims beside the untouched `#!/bin/sh` launchers, bundle shims, shim-reading spawn plans                                                  |
| `packages/config/src/verified-process-stop.ts` (+ `test/app-runtime-file.test.ts`)                                                                                                                                                                                             | win32 `VerifiedProcessOps`                                                                                                                       |
| `packages/local-open-targets/src/index.ts`, `src/types.ts`, `src/macos-launch-adapters.ts`, `src/windows-launch.ts` (+ test)                                                                                                                                                   | Windows arm                                                                                                                                      |
| `apps/host-daemon/src/command-handlers/native-folder-picker.ts` (+ test), `src/local-api.ts` (+ test)                                                                                                                                                                          | win32 picker, capability flag                                                                                                                    |
| `packages/secret-storage/src/secret-file.ts`, `src/windows-acl.ts` (+ tests), `apps/server/src/services/plugins/plugin-settings.ts`                                                                                                                                            | NTFS ACL arm, `readSecretFile`                                                                                                                   |
| `apps/host-daemon/src/command-handlers/path-mutations.test.ts`, `plugins/provider-claude-code/src/bridge/skill-plugins.ts` (+ test)                                                                                                                                            | Junction tests, junction link on win32                                                                                                           |
| `docs/platform-windows.md`, `docs/platform-support.md`, `docs/worktrees.md`, `docs/configuration.md`, `docs/cli-guide-and-skill.md`, `docs/api_to_audit.md`, `packages/templates/src/templates/bb-guide-environments.md`, `plugins/bb-guide/skills/bb-cli/*`                   | Phase 2 status, hook contract on Windows, known limitations                                                                                      |
| `qa/windows/phase-2/*`                                                                                                                                                                                                                                                         | Gate evidence                                                                                                                                    |

---

### Task 1: `@bb/process-utils` foundations for Windows

**Files:**

- Modify: `packages/process-utils/src/index.ts` (re-exports at the top; `PortableSpawnRequest` 18–26; `PortablePipedSpawnRequest` 30–36; `KillProcessGroupArgs` 50–56; `SanitizeInheritedChildProcessEnvArgs` 83–86; `spawnPortableProcess` 136–146; `supportsProcessGroups` 186–188; `killProcessGroup` 190–198; `isProcessGroupAlive` 200–212; `sanitizeInheritedChildProcessEnv` 451–468)
- Create: `packages/process-utils/src/windows-system-tools.ts`
- Create: `packages/process-utils/src/resolve-executable.ts`
- Create: `packages/process-utils/test/resolve-executable.test.ts`
- Modify: `packages/process-utils/test/index.test.ts` (`it.skipIf` guard on `resolves paths that stay within the configured root` at 257 and `rejects root and escaped paths` at 266 with their bodies untouched, two new portable variants beside them, new win32 env tests after `scrubs inherited bb runtime env vars and node mode` at 281)

**Interfaces:**

- Consumes: nothing new; `cross-spawn` and `node:fs`/`node:path` only.
- Produces, from `@bb/process-utils`:
  - `resolveWindowsSystemToolPath(name: string, env?: NodeJS.ProcessEnv): string`
  - `resolvePowerShellExecutable(env?: NodeJS.ProcessEnv): string`
  - `POWERSHELL_NONINTERACTIVE_ARGS: readonly string[]`
  - `readWindowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined`
  - `splitWindowsPathList(value: string | undefined): string[]`
  - `joinExecutablePath(platform: NodeJS.Platform, base: string, ...segments: string[]): string`
  - `windowsExecutableExtensions(pathext?: string): string[]`
  - `resolveExecutable(args: { command: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; cwd?: string }): Promise<string | null>`
  - `readNodeCmdShim(shimPath: string): Promise<NodeCmdShimTarget | null>` with `NodeCmdShimTarget = { command: string; args: string[] }`
  - `assignPathEnv(args: { env: NodeJS.ProcessEnv; path: string; platform?: NodeJS.Platform }): NodeJS.ProcessEnv` and `AssignPathEnvArgs`
  - `PortableSpawnRequest.platform?`, `PortablePipedSpawnRequest.platform?`, `KillProcessGroupArgs.platform?`, `SanitizeInheritedChildProcessEnvArgs.platform?`, `supportsProcessGroups(platform?)`, `isProcessGroupAlive(child, platform?)`.

`readWindowsEnvValue`, `splitWindowsPathList` and `joinExecutablePath` are not in `shared-interfaces.md`; they are added because `resolve-executable.ts` and `windows-system-tools.ts` both need case-insensitive `Path`/`SystemRoot` lookup, `;`-splitting and separator-preserving joins, and duplicating them would be worse. All three live in `windows-system-tools.ts` and `resolve-executable.ts` imports them, so the dependency stays one-directional. `shared-interfaces.md` writes `resolveWindowsSystemToolPath` with `join`; this task uses `path.win32.join` so the function returns the same Windows string on a Linux or macOS test host — that function only builds a string, it never probes the filesystem.

Every candidate path that is then probed with `existsSync`/`access` is built by preserving the separator flavour of the directory entry (`joinExecutablePath`) instead of `path.win32.join`, because `path.win32.join("/tmp/x", "pwsh.exe")` returns `\tmp\x\pwsh.exe` (measured on Node 22.19) and no such file exists on a POSIX test host. A real Windows `Path` entry always uses `\`, so production behaviour is `C:\dir\tool.exe`; a POSIX test host's `mkdtemp` directory uses `/`, so the same code probes `/tmp/x/tool.exe` and the whole module is testable on every OS. The Win32 API accepts both separators, so nothing is lost on Windows. This is why `resolvePowerShellExecutable` joins its `pwsh.exe` candidates with `joinExecutablePath` and keeps `path.win32.join` only for the `powershell.exe` last resort, which is returned without probing.

- [ ] **Step 1: Write the failing tests**

Create `packages/process-utils/test/resolve-executable.test.ts`:

```ts
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  POWERSHELL_NONINTERACTIVE_ARGS,
  readNodeCmdShim,
  resolveExecutable,
  resolvePowerShellExecutable,
  resolveWindowsSystemToolPath,
  windowsExecutableExtensions,
} from "../src/index.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bb-resolve-exec-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("windowsExecutableExtensions", () => {
  it("defaults to the documented PATHEXT and lower-cases every entry", () => {
    expect(windowsExecutableExtensions()).toEqual([
      ".com",
      ".exe",
      ".bat",
      ".cmd",
      ".ps1",
    ]);
    expect(windowsExecutableExtensions("")).toEqual([
      ".com",
      ".exe",
      ".bat",
      ".cmd",
      ".ps1",
    ]);
  });

  it("keeps the configured order, adds missing dots and drops duplicates", () => {
    expect(windowsExecutableExtensions(".CMD;EXE; .cmd ;.PS1")).toEqual([
      ".cmd",
      ".exe",
      ".ps1",
    ]);
  });
});

describe("resolveWindowsSystemToolPath", () => {
  it("anchors system tools on SystemRoot in either casing", () => {
    expect(
      resolveWindowsSystemToolPath("taskkill.exe", { SystemRoot: "D:\\Win" }),
    ).toBe("D:\\Win\\System32\\taskkill.exe");
    expect(
      resolveWindowsSystemToolPath("whoami.exe", { SYSTEMROOT: "D:\\Win" }),
    ).toBe("D:\\Win\\System32\\whoami.exe");
    expect(resolveWindowsSystemToolPath("icacls.exe", {})).toBe(
      "C:\\Windows\\System32\\icacls.exe",
    );
  });
});

describe("resolvePowerShellExecutable", () => {
  it("pins the non-interactive argument list", () => {
    expect([...POWERSHELL_NONINTERACTIVE_ARGS]).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
    ]);
  });

  it("falls back to Windows PowerShell when no pwsh.exe exists", () => {
    expect(
      resolvePowerShellExecutable({
        Path: "C:\\missing-one;C:\\missing-two",
        ProgramFiles: "C:\\missing-three",
        SystemRoot: "D:\\Win",
      }),
    ).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("prefers a pwsh.exe found on the Path", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "pwsh.exe"), "");
    expect(resolvePowerShellExecutable({ Path: `C:\\missing;${root}` })).toBe(
      join(root, "pwsh.exe"),
    );
  });
});

describe("resolveExecutable on posix", () => {
  it("walks PATH and returns the first executable file", async () => {
    const root = await makeRoot();
    const target = join(root, "git");
    await writeFile(target, "");
    await chmod(target, 0o755);
    await expect(
      resolveExecutable({
        command: "git",
        env: { PATH: `/definitely-missing:${root}` },
        platform: "linux",
      }),
    ).resolves.toBe(target);
    await expect(
      resolveExecutable({
        command: "git",
        env: { PATH: "/definitely-missing" },
        platform: "linux",
      }),
    ).resolves.toBeNull();
  });

  it("checks an explicit path instead of walking PATH", async () => {
    const root = await makeRoot();
    const target = join(root, "tool");
    await writeFile(target, "");
    await chmod(target, 0o755);
    await expect(
      resolveExecutable({ command: target, env: {}, platform: "linux" }),
    ).resolves.toBe(target);
    await expect(
      resolveExecutable({
        command: join(root, "absent"),
        env: {},
        platform: "linux",
      }),
    ).resolves.toBeNull();
  });

  it("ignores PATHEXT and never appends an extension", async () => {
    const root = await makeRoot();
    const target = join(root, "tool.exe");
    await writeFile(target, "");
    await chmod(target, 0o755);
    await expect(
      resolveExecutable({
        command: "tool",
        env: { PATH: root, PATHEXT: ".EXE" },
        platform: "linux",
      }),
    ).resolves.toBeNull();
  });
});

describe("resolveExecutable on win32", () => {
  it("appends PATHEXT suffixes in order while walking Path", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "tool.cmd"), "");
    await writeFile(join(root, "tool.exe"), "");
    await expect(
      resolveExecutable({
        command: "tool",
        env: { Path: `C:\\missing;${root}`, PATHEXT: ".COM;.EXE;.CMD" },
        platform: "win32",
      }),
    ).resolves.toBe(join(root, "tool.exe"));
    await expect(
      resolveExecutable({
        command: "tool",
        env: { Path: root, PATHEXT: ".CMD;.EXE" },
        platform: "win32",
      }),
    ).resolves.toBe(join(root, "tool.cmd"));
  });

  it("reads the Path key in any casing", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "tool.exe"), "");
    await expect(
      resolveExecutable({
        command: "tool",
        env: { path: root },
        platform: "win32",
      }),
    ).resolves.toBe(join(root, "tool.exe"));
    await expect(
      resolveExecutable({
        command: "tool",
        env: { PATH: root },
        platform: "win32",
      }),
    ).resolves.toBe(join(root, "tool.exe"));
  });

  it("decides executability by extension and never by the execute bit", async () => {
    const root = await makeRoot();
    const script = join(root, "script.ps1");
    await writeFile(script, "");
    await chmod(script, 0o600);
    await expect(
      resolveExecutable({
        command: "script",
        env: { Path: root },
        platform: "win32",
      }),
    ).resolves.toBe(script);
    await writeFile(join(root, "data.txt"), "");
    await expect(
      resolveExecutable({
        command: "data.txt",
        env: { Path: root },
        platform: "win32",
      }),
    ).resolves.toBeNull();
  });

  it("takes an explicit path as-is when it already carries an extension", async () => {
    const root = await makeRoot();
    const target = join(root, "tool.exe");
    await writeFile(target, "");
    await expect(
      resolveExecutable({ command: target, env: {}, platform: "win32" }),
    ).resolves.toBe(target);
    await expect(
      resolveExecutable({
        command: join(root, "tool"),
        env: {},
        platform: "win32",
      }),
    ).resolves.toBe(target);
  });

  it.runIf(process.platform === "win32")(
    "resolves real Windows tools",
    async () => {
      const resolved = await resolveExecutable({
        command: "cmd",
        env: process.env,
        platform: "win32",
      });
      expect(resolved?.toLowerCase()).toBe(
        resolveWindowsSystemToolPath("cmd.exe").toLowerCase(),
      );
      const whoami = resolveWindowsSystemToolPath("whoami.exe");
      await expect(
        resolveExecutable({
          command: whoami,
          env: process.env,
          platform: "win32",
        }),
      ).resolves.toBe(whoami);
    },
  );
});

describe("readNodeCmdShim", () => {
  it("reads the one-line bb shim", async () => {
    const root = await makeRoot();
    const shim = join(root, "bb.cmd");
    await writeFile(shim, '@node "%~dp0bb" %*\r\n');
    await expect(readNodeCmdShim(shim)).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "bb")],
    });
  });

  it("reads the npm/pnpm dp0 shim", async () => {
    const root = await makeRoot();
    const shim = join(root, "pnpm.cmd");
    await writeFile(
      shim,
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        '  SET "_prog=node"',
        ")",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*',
        "",
      ].join("\r\n"),
    );
    await expect(readNodeCmdShim(shim)).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "node_modules", "pnpm", "bin", "pnpm.cjs")],
    });
  });

  it("reads the relative node.exe shim", async () => {
    const root = await makeRoot();
    const shim = join(root, "tsc.cmd");
    await writeFile(
      shim,
      '"%~dp0\\node.exe" "%~dp0\\..\\typescript\\bin\\tsc" %*\r\n',
    );
    await expect(readNodeCmdShim(shim)).resolves.toEqual({
      command: process.execPath,
      args: [join(root, "..", "typescript", "bin", "tsc")],
    });
  });

  it("returns null for a shim that does not run node and for a missing file", async () => {
    const root = await makeRoot();
    const shim = join(root, "helper.cmd");
    await writeFile(shim, '@echo off\r\n"%~dp0..\\tools\\helper.exe" %*\r\n');
    await expect(readNodeCmdShim(shim)).resolves.toBeNull();
    await expect(readNodeCmdShim(join(root, "absent.cmd"))).resolves.toBeNull();
  });
});
```

In `packages/process-utils/test/index.test.ts`, keep the two existing POSIX-literal tests (257, 266) verbatim and only wrap them in `it.skipIf(process.platform === "win32")`, add the two portable variants beside them as new cases, and add the win32 env test after `scrubs inherited bb runtime env vars and node mode` (281). `join` and `tmpdir` are already imported by the file; import `assignPathEnv` alongside the existing `../src/index.js` imports.

```ts
it.skipIf(process.platform === "win32")(
  "resolves paths that stay within the configured root",
  () => {
    expect(
      resolveContainedPath({
        rootPath: "/tmp/root",
        candidatePath: "/tmp/root/child/file.txt",
      }),
    ).toBe("/tmp/root/child/file.txt");
  },
);

it.skipIf(process.platform === "win32")(
  "rejects root and escaped paths",
  () => {
    expect(
      resolveContainedPath({
        rootPath: "/tmp/root",
        candidatePath: "/tmp/root",
      }),
    ).toBeNull();
    expect(
      resolveContainedPath({
        rootPath: "/tmp/root",
        candidatePath: "/tmp/root/../escape",
      }),
    ).toBeNull();
  },
);

it("resolves host paths that stay within the configured root", () => {
  const rootPath = join(tmpdir(), "bb-contained-root");
  const candidatePath = join(rootPath, "child", "file.txt");
  expect(resolveContainedPath({ rootPath, candidatePath })).toBe(candidatePath);
});

it("rejects the host root and escaped host paths", () => {
  const rootPath = join(tmpdir(), "bb-contained-root");
  expect(
    resolveContainedPath({ rootPath, candidatePath: rootPath }),
  ).toBeNull();
  expect(
    resolveContainedPath({
      rootPath,
      candidatePath: join(rootPath, "..", "escape"),
    }),
  ).toBeNull();
});
```

```ts
it("collapses every PATH casing into one Path key on win32", () => {
  const env: NodeJS.ProcessEnv = {
    Path: "C:\\a",
    PATH: "C:\\b",
    path: "C:\\c",
    USERPROFILE: "C:\\Users\\me",
  };

  const sanitizedEnv = sanitizeInheritedChildProcessEnv({
    env,
    shellPath: "C:\\shell",
    platform: "win32",
  });

  expect(
    Object.keys(sanitizedEnv).filter((key) => /^path$/iu.test(key)),
  ).toEqual(["Path"]);
  expect(sanitizedEnv).toEqual({
    Path: "C:\\shell",
    USERPROFILE: "C:\\Users\\me",
  });
  expect(env).toEqual({
    Path: "C:\\a",
    PATH: "C:\\b",
    path: "C:\\c",
    USERPROFILE: "C:\\Users\\me",
  });
});

it("leaves win32 PATH casings alone without a shell path", () => {
  expect(
    sanitizeInheritedChildProcessEnv({
      env: { Path: "C:\\a", PATH: "C:\\b" },
      platform: "win32",
    }),
  ).toEqual({ Path: "C:\\a", PATH: "C:\\b" });
});

it("assigns the child PATH per platform", () => {
  expect(
    assignPathEnv({
      env: { HOME: "/home/me", PATH: "/bin" },
      path: "/opt/bin:/bin",
      platform: "linux",
    }),
  ).toEqual({ HOME: "/home/me", PATH: "/opt/bin:/bin" });
  expect(
    assignPathEnv({
      env: { Path: "C:\\a", PATH: "C:\\b", USERPROFILE: "C:\\Users\\me" },
      path: "C:\\new",
      platform: "win32",
    }),
  ).toEqual({ Path: "C:\\new", USERPROFILE: "C:\\Users\\me" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/process-utils exec vitest run test/resolve-executable.test.ts test/index.test.ts`.
Expected: FAIL — `test/resolve-executable.test.ts` cannot resolve `resolveExecutable`, `readNodeCmdShim`, `windowsExecutableExtensions`, `resolveWindowsSystemToolPath`, `resolvePowerShellExecutable` or `POWERSHELL_NONINTERACTIVE_ARGS` from `../src/index.js`; `test/index.test.ts` fails to import `assignPathEnv` and `sanitizeInheritedChildProcessEnv` rejects the `platform` property. The two original `resolveContainedPath` tests keep passing on POSIX and skip on Windows; the two portable variants pass on both.

- [ ] **Step 3: Create `packages/process-utils/src/windows-system-tools.ts`**

```ts
import { existsSync } from "node:fs";
import { win32 as win32Path } from "node:path";

const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const WINDOWS_PATH_DELIMITER = ";";

export const POWERSHELL_NONINTERACTIVE_ARGS: readonly string[] = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
];

export function readWindowsEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const direct = env[name];
  if (direct !== undefined) {
    return direct;
  }
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowered && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function splitWindowsPathList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const entries: string[] = [];
  for (const raw of value.split(WINDOWS_PATH_DELIMITER)) {
    const trimmed = raw.trim().replace(/^"+|"+$/gu, "");
    if (trimmed !== "") {
      entries.push(trimmed);
    }
  }
  return entries;
}

function appendExecutableSegment(
  base: string,
  segment: string,
  platform: NodeJS.Platform,
): string {
  if (base === "") {
    return segment;
  }
  if (base.endsWith("/") || base.endsWith("\\")) {
    return `${base}${segment}`;
  }
  if (platform !== "win32") {
    return `${base}/${segment}`;
  }
  return base.includes("\\") || !base.includes("/")
    ? `${base}\\${segment}`
    : `${base}/${segment}`;
}

export function joinExecutablePath(
  platform: NodeJS.Platform,
  base: string,
  ...segments: string[]
): string {
  let joined = base;
  for (const segment of segments) {
    joined = appendExecutableSegment(joined, segment, platform);
  }
  return joined;
}

export function resolveWindowsSystemToolPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return win32Path.join(
    readWindowsEnvValue(env, "SystemRoot") ?? DEFAULT_WINDOWS_SYSTEM_ROOT,
    "System32",
    name,
  );
}

export function resolvePowerShellExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const entry of splitWindowsPathList(readWindowsEnvValue(env, "Path"))) {
    const candidate = joinExecutablePath("win32", entry, "pwsh.exe");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const programFiles = readWindowsEnvValue(env, "ProgramFiles");
  if (programFiles !== undefined) {
    const candidate = joinExecutablePath(
      "win32",
      programFiles,
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return win32Path.join(
    readWindowsEnvValue(env, "SystemRoot") ?? DEFAULT_WINDOWS_SYSTEM_ROOT,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}
```

The `prefers a pwsh.exe found on the Path` test passes on every host because `joinExecutablePath("win32", "/tmp/x", "pwsh.exe")` returns `/tmp/x/pwsh.exe` and `joinExecutablePath("win32", "C:\\dir", "pwsh.exe")` returns `C:\dir\pwsh.exe`; the test is platform-neutral and no run-time conditional is needed.

- [ ] **Step 4: Create `packages/process-utils/src/resolve-executable.ts`**

```ts
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import {
  dirname,
  extname,
  posix as posixPath,
  resolve,
  win32 as win32Path,
} from "node:path";
import {
  joinExecutablePath,
  readWindowsEnvValue,
  splitWindowsPathList,
} from "./windows-system-tools.js";

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD;.PS1";
const POSIX_PATH_DELIMITER = ":";

const NON_SCRIPT_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([
  ".bat",
  ".cmd",
  ".com",
  ".exe",
]);

const NODE_CMD_SHIM_PATTERNS: readonly RegExp[] = [
  /^\s*@?node(?:\.exe)?\s+"%~dp0\\?([^"\r\n]+)"/imu,
  /"%~dp0\\?node\.exe"\s+"%~dp0\\?([^"\r\n]+)"/iu,
  /"%_prog%"\s+"%dp0%\\?([^"\r\n]+)"/iu,
  /"%dp0%\\?node\.exe"\s+"%dp0%\\?([^"\r\n]+)"/iu,
];

export interface ResolveExecutableArgs {
  command: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
}

export interface NodeCmdShimTarget {
  command: string;
  args: string[];
}

export function windowsExecutableExtensions(pathext?: string): string[] {
  const raw =
    pathext === undefined || pathext.trim() === ""
      ? DEFAULT_WINDOWS_PATHEXT
      : pathext;
  const extensions: string[] = [];
  for (const entry of raw.split(";")) {
    const trimmed = entry.trim().toLowerCase();
    if (trimmed === "") {
      continue;
    }
    const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    if (!extensions.includes(withDot)) {
      extensions.push(withDot);
    }
  }
  return extensions;
}

async function isPosixExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolvePosixExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | null> {
  if (posixPath.isAbsolute(command) || command.includes("/")) {
    const target = posixPath.isAbsolute(command)
      ? command
      : joinExecutablePath("linux", cwd, command);
    return (await isPosixExecutableFile(target)) ? target : null;
  }
  for (const entry of (env.PATH ?? "").split(POSIX_PATH_DELIMITER)) {
    if (entry === "") {
      continue;
    }
    const candidate = joinExecutablePath("linux", entry, command);
    if (await isPosixExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function findWindowsCandidate(
  base: string,
  extensions: string[],
): Promise<string | null> {
  const extension = win32Path.extname(base).toLowerCase();
  if (extensions.includes(extension) && (await fileExists(base))) {
    return base;
  }
  for (const suffix of extensions) {
    const candidate = `${base}${suffix}`;
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolveWindowsExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | null> {
  const extensions = windowsExecutableExtensions(
    readWindowsEnvValue(env, "PATHEXT"),
  );
  if (win32Path.isAbsolute(command) || /[\\/]/u.test(command)) {
    const base = win32Path.isAbsolute(command)
      ? command
      : joinExecutablePath("win32", cwd, command);
    return findWindowsCandidate(base, extensions);
  }
  for (const entry of splitWindowsPathList(readWindowsEnvValue(env, "Path"))) {
    const found = await findWindowsCandidate(
      joinExecutablePath("win32", entry, command),
      extensions,
    );
    if (found !== null) {
      return found;
    }
  }
  return null;
}

export async function resolveExecutable(
  args: ResolveExecutableArgs,
): Promise<string | null> {
  const platform = args.platform ?? process.platform;
  const env = args.env ?? process.env;
  const cwd = args.cwd ?? process.cwd();
  return platform === "win32"
    ? resolveWindowsExecutable(args.command, env, cwd)
    : resolvePosixExecutable(args.command, env, cwd);
}

function shimTargetsNode(body: string): boolean {
  return /node\.exe/iu.test(body) || /(?:^|[\s&|(])@?node\s/imu.test(body);
}

export async function readNodeCmdShim(
  shimPath: string,
): Promise<NodeCmdShimTarget | null> {
  let body: string;
  try {
    body = await readFile(shimPath, "utf8");
  } catch {
    return null;
  }
  if (!shimTargetsNode(body)) {
    return null;
  }
  for (const pattern of NODE_CMD_SHIM_PATTERNS) {
    const captured = pattern.exec(body)?.[1];
    if (captured === undefined) {
      continue;
    }
    const segments = captured
      .split(/[\\/]+/u)
      .filter((segment) => segment !== "");
    if (segments.length === 0) {
      continue;
    }
    const script = resolve(dirname(shimPath), ...segments);
    if (NON_SCRIPT_SHIM_EXTENSIONS.has(extname(script).toLowerCase())) {
      continue;
    }
    return { command: process.execPath, args: [script] };
  }
  return null;
}
```

- [ ] **Step 5: Add `platform`, the `windowsHide` default and `assignPathEnv` to `src/index.ts`**

Re-exports: line 1 is already `export * from "./plugin-process-paths.js";` — keep it and add the two new re-exports directly below it, so the file starts with:

```ts
export * from "./plugin-process-paths.js";
export * from "./resolve-executable.js";
export * from "./windows-system-tools.js";
```

Request and argument types (18–86):

```ts
interface PortableSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  stdio?: StdioOptions;
  windowsHide?: boolean;
}
```

```ts
interface PortablePipedSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}
```

```ts
interface KillProcessGroupArgs {
  child: {
    pid?: number | undefined;
    kill: (signal: NodeJS.Signals) => unknown;
  };
  platform?: NodeJS.Platform;
  signal: NodeJS.Signals;
}
```

```ts
export interface SanitizeInheritedChildProcessEnvArgs {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  shellPath?: string;
}

export interface AssignPathEnvArgs {
  env: NodeJS.ProcessEnv;
  path: string;
  platform?: NodeJS.Platform;
}
```

`spawnPortableProcess` (136–146):

```ts
export function spawnPortableProcess(
  request: PortableSpawnRequest,
): PortableChildProcess {
  const platform = request.platform ?? process.platform;
  return crossSpawn(request.command, request.args, {
    cwd: request.cwd,
    detached: request.detached,
    env: request.env,
    stdio: request.stdio,
    windowsHide:
      platform === "win32"
        ? (request.windowsHide ?? true)
        : request.windowsHide,
  });
}
```

Process-group helpers (186–212):

```ts
export function supportsProcessGroups(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

export function killProcessGroup(args: KillProcessGroupArgs): void {
  if (
    supportsProcessGroups(args.platform ?? process.platform) &&
    args.child.pid !== undefined
  ) {
    try {
      process.kill(-args.child.pid, args.signal);
      return;
    } catch {}
  }
  args.child.kill(args.signal);
}

export function isProcessGroupAlive(
  child: {
    pid?: number | undefined;
  },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!supportsProcessGroups(platform) || child.pid === undefined) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

`sanitizeInheritedChildProcessEnv` (451–468) plus the new `assignPathEnv` beside it. The POSIX statements are unchanged; the two added guards are inert whenever `platform !== "win32"`:

```ts
const WINDOWS_PATH_ENV_KEY_PATTERN = /^path$/iu;

export function sanitizeInheritedChildProcessEnv(
  args: SanitizeInheritedChildProcessEnvArgs,
): NodeJS.ProcessEnv {
  const platform = args.platform ?? process.platform;
  const dropPathVariants = platform === "win32" && args.shellPath !== undefined;
  const sanitizedEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(args.env)) {
    if (value === undefined) {
      continue;
    }
    if (key === "NODE_ENV" || key.startsWith("BB_")) {
      continue;
    }
    if (dropPathVariants && WINDOWS_PATH_ENV_KEY_PATTERN.test(key)) {
      continue;
    }
    sanitizedEnv[key] = value;
  }
  if (args.shellPath !== undefined) {
    if (platform === "win32") {
      sanitizedEnv.Path = args.shellPath;
      return sanitizedEnv;
    }
    sanitizedEnv.PATH = args.shellPath;
  }
  return sanitizedEnv;
}

export function assignPathEnv(args: AssignPathEnvArgs): NodeJS.ProcessEnv {
  const platform = args.platform ?? process.platform;
  if (platform !== "win32") {
    return { ...args.env, PATH: args.path };
  }
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(args.env)) {
    if (value === undefined || WINDOWS_PATH_ENV_KEY_PATTERN.test(key)) {
      continue;
    }
    childEnv[key] = value;
  }
  childEnv.Path = args.path;
  return childEnv;
}
```

- [ ] **Step 6: Run the tests and the typechecks**

Run: `pnpm --filter @bb/process-utils exec vitest run test/resolve-executable.test.ts test/index.test.ts`, then `pnpm exec turbo run typecheck --filter=@bb/process-utils --filter=@bb/host-daemon --filter=@bb/host-workspace --filter=@bb/local-open-targets --filter=@bb/plugin-sdk --filter=@bb/scripts`, then `pnpm exec turbo run test --filter=@bb/process-utils`.
Expected: green. The typecheck filters prove the claim that every existing caller compiles unchanged: no caller passes `platform`, `supportsProcessGroups()` and `isProcessGroupAlive(child)` keep their zero/one-argument call shape, and `windowsHide` keeps its meaning on POSIX. On Windows, `test/process-tree.test.ts` stays fully skipped; the `it.runIf(process.platform === "win32")` case in `test/resolve-executable.test.ts` is the only real-Windows coverage in this task.

- [ ] **Step 7: Format and commit**

```bash
pnpm exec oxfmt packages/process-utils/src/index.ts packages/process-utils/src/resolve-executable.ts packages/process-utils/src/windows-system-tools.ts packages/process-utils/test/index.test.ts packages/process-utils/test/resolve-executable.test.ts
git add packages/process-utils/src/index.ts packages/process-utils/src/resolve-executable.ts packages/process-utils/src/windows-system-tools.ts packages/process-utils/test/index.test.ts packages/process-utils/test/resolve-executable.test.ts
git commit -m "Add Windows executable resolution and env normalisation to process-utils

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 2: Windows process tree: snapshot, registry, identity-checked termination and sweep

**Files:**

- Create: `packages/process-utils/src/windows-process-snapshot.ts`
- Create: `packages/process-utils/src/windows-process-stop.ts`
- Modify: `packages/process-utils/src/index.ts` (re-exports at the top; `ProcessWithCwd` 64–67; `StopProcessGroupLeaderFirstArgs` 58–62; `ListProcessesWithCwdUnderArgs` 69–71; `KillProcessesWithCwdUnderArgs` 73–76; `spawnPortableProcess`; `stopProcessGroupLeaderFirst` 220–223; `listProcessesWithCwdUnder` 349–354; `killProcessesWithCwdUnder` 397–402)
- Create: `packages/process-utils/test/windows-process-snapshot.test.ts`
- Create: `packages/process-utils/test/windows-process-stop.test.ts`
- Create: `packages/process-utils/test/windows-process-real.test.ts`
- Modify: `packages/plugin-sdk/src/host.ts` (type re-exports, 55)
- Modify: `packages/plugin-api-map/src/surfaces.ts` (`apiSymbols` of the host-process surface, 797–802)

**Interfaces:**

- Consumes: `resolvePowerShellExecutable`, `POWERSHELL_NONINTERACTIVE_ARGS`, `resolveWindowsSystemToolPath` (Task 1); `spawnPortableOutputProcess`, `killProcessGroup` from `./index.js`.
- Produces, from `@bb/process-utils`: `WindowsProcessSnapshotEntry`, `WindowsCommandRequest`, `WindowsCommandResult`, `WindowsCommandRunner`, `defaultWindowsCommandRunner`, `WINDOWS_PROCESS_ENUM_TIMEOUT_MS`, `WindowsProcessEnumerationError`, `buildWindowsProcessEnumRequest`, `parseWindowsProcessSnapshot`, `takeWindowsProcessSnapshot`, `queryWindowsProcess`, `registerSweepRootProcess`, `unregisterSweepRootProcess`, `clearSweepRootProcesses`, `WindowsSweepMatchEvidence`, `WindowsProcessMatch`, `isWindowsPathUnderDirectory`, `matchWindowsProcessesUnderDirectory`, `SkippedProcessEvent`, `TerminateProcessTreeResult`, `terminateProcessTree`, and the exported `ProcessWithCwd`.
- Produces, from `@get-bb/plugin-sdk/host`: `ExperimentalProcessWithCwd` (the published alias of `ProcessWithCwd`, Step 9).

Two deviations from `shared-interfaces.md`, both additive: `defaultWindowsCommandRunner` is exported because `test/windows-process-real.test.ts` must wrap the real runner to forge a `CreationDate`; `expandWindowsShortPath` stays private as the default `canonicalizePath`.

`src/index.ts` imports the registry from `./windows-process-snapshot.js` while that module imports `spawnPortableOutputProcess` from `./index.js`, and `./windows-process-stop.js` imports `killProcessGroup` from `./index.js`. Every binding in both directions is a hoisted `export function`, used only inside function bodies, so the ES module cycle resolves at instantiation time and no top-level evaluation touches a partially initialised binding. Do not convert any of these to `const` arrow functions.

- [ ] **Step 1: Write the failing snapshot tests**

Create `packages/process-utils/test/windows-process-snapshot.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWindowsProcessEnumRequest,
  clearSweepRootProcesses,
  isWindowsPathUnderDirectory,
  matchWindowsProcessesUnderDirectory,
  parseWindowsProcessSnapshot,
  queryWindowsProcess,
  registerSweepRootProcess,
  takeWindowsProcessSnapshot,
  unregisterSweepRootProcess,
  WINDOWS_PROCESS_ENUM_TIMEOUT_MS,
  WindowsProcessEnumerationError,
  type WindowsCommandRequest,
  type WindowsCommandResult,
  type WindowsCommandRunner,
} from "../src/index.js";

const CREATED_AT = "2026-09-14T09:00:00.0000000+00:00";
const SWEEP_DIRECTORY = "C:\\work\\bb";
const WINDOWS_ENV: NodeJS.ProcessEnv = {
  Path: "C:\\nowhere",
  SystemRoot: "C:\\Windows",
};

function cimProcess(
  pid: number,
  parentPid: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ProcessId: pid,
    ParentProcessId: parentPid,
    ExecutablePath: null,
    CommandLine: null,
    CreationDate: CREATED_AT,
    ...extra,
  };
}

const CIM_SAMPLE = JSON.stringify([
  cimProcess(4, 0, { CreationDate: null }),
  cimProcess(624, 4, {
    ExecutablePath: "C:\\Windows\\System32\\services.exe",
    CommandLine: "C:\\Windows\\system32\\services.exe",
  }),
  cimProcess(1234, 624, {
    ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
    CommandLine:
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\bb\\scripts\\start-bb.mjs"',
  }),
  cimProcess(4242, 1234, {
    ExecutablePath: "C:\\work\\bb\\tools\\agent.exe",
    CommandLine: '"C:\\work\\bb\\tools\\agent.exe" --workspace C:\\work\\bb',
  }),
  cimProcess(4243, 4242, {
    ExecutablePath: "C:\\Windows\\System32\\cmd.exe",
    CommandLine: "cmd.exe /d /c build",
  }),
]);

function okResult(stdout: string): WindowsCommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fixedRunner(
  results: WindowsCommandResult[],
  requests: WindowsCommandRequest[] = [],
): WindowsCommandRunner {
  let index = 0;
  return async (request) => {
    requests.push(request);
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result === undefined) {
      throw new Error("no result configured");
    }
    return result;
  };
}

afterEach(() => {
  clearSweepRootProcesses();
});

describe("buildWindowsProcessEnumRequest", () => {
  it("runs PowerShell non-interactively and projects CreationDate", () => {
    const request = buildWindowsProcessEnumRequest(WINDOWS_ENV);
    expect(request.command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(request.args.slice(0, 5)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
    ]);
    expect(request.args[5]).toBe("-Command");
    expect(request.args[6]).toContain("Get-CimInstance Win32_Process");
    expect(request.args[6]).toContain("CreationDate");
    expect(request.args[6]).toContain("ConvertTo-Json -Compress");
  });

  it("pins the default enumeration timeout", () => {
    expect(WINDOWS_PROCESS_ENUM_TIMEOUT_MS).toBe(10_000);
  });
});

describe("parseWindowsProcessSnapshot", () => {
  it("parses a realistic payload including CreationDate", () => {
    const snapshot = parseWindowsProcessSnapshot(CIM_SAMPLE);
    expect(snapshot).toHaveLength(5);
    expect(snapshot[0]).toEqual({
      pid: 4,
      parentPid: 0,
      executablePath: null,
      commandLine: null,
      creationDate: null,
    });
    expect(snapshot[3]).toEqual({
      pid: 4242,
      parentPid: 1234,
      executablePath: "C:\\work\\bb\\tools\\agent.exe",
      commandLine: '"C:\\work\\bb\\tools\\agent.exe" --workspace C:\\work\\bb',
      creationDate: CREATED_AT,
    });
  });

  it("wraps a single object payload", () => {
    expect(
      parseWindowsProcessSnapshot(JSON.stringify(cimProcess(9, 1))),
    ).toEqual([
      {
        pid: 9,
        parentPid: 1,
        executablePath: null,
        commandLine: null,
        creationDate: CREATED_AT,
      },
    ]);
  });

  it("tolerates a leading byte-order mark and empty payloads", () => {
    expect(
      parseWindowsProcessSnapshot(
        `\uFEFF${JSON.stringify([cimProcess(9, 1)])}`,
      ),
    ).toHaveLength(1);
    expect(parseWindowsProcessSnapshot("")).toEqual([]);
    expect(parseWindowsProcessSnapshot("   \r\n")).toEqual([]);
    expect(parseWindowsProcessSnapshot("null")).toEqual([]);
  });

  it("skips entries without a usable process id", () => {
    expect(
      parseWindowsProcessSnapshot(
        JSON.stringify([
          { ProcessId: null },
          { ProcessId: 0 },
          cimProcess(7, 1),
        ]),
      ),
    ).toHaveLength(1);
  });

  it("throws on output that is not JSON", () => {
    expect(() =>
      parseWindowsProcessSnapshot("Get-CimInstance : denied"),
    ).toThrow(WindowsProcessEnumerationError);
  });
});

describe("takeWindowsProcessSnapshot", () => {
  it("returns the parsed snapshot", async () => {
    await expect(
      takeWindowsProcessSnapshot({
        runner: fixedRunner([okResult(CIM_SAMPLE)]),
        env: WINDOWS_ENV,
      }),
    ).resolves.toHaveLength(5);
  });

  it("rejects instead of returning an empty list when the probe hangs", async () => {
    const hangingRunner: WindowsCommandRunner = () => new Promise(() => {});
    await expect(
      takeWindowsProcessSnapshot({
        runner: hangingRunner,
        timeoutMs: 20,
        env: WINDOWS_ENV,
      }),
    ).rejects.toMatchObject({
      name: "WindowsProcessEnumerationError",
      reason: "timeout",
    });
  });

  it("rejects on a non-zero exit code", async () => {
    await expect(
      takeWindowsProcessSnapshot({
        runner: fixedRunner([{ stdout: "", stderr: "denied", exitCode: 1 }]),
        env: WINDOWS_ENV,
      }),
    ).rejects.toMatchObject({ reason: "exit" });
  });

  it("rejects when the probe cannot start", async () => {
    const failingRunner: WindowsCommandRunner = async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    await expect(
      takeWindowsProcessSnapshot({ runner: failingRunner, env: WINDOWS_ENV }),
    ).rejects.toMatchObject({ reason: "spawn" });
  });

  it("rejects when the output cannot be parsed", async () => {
    await expect(
      takeWindowsProcessSnapshot({
        runner: fixedRunner([okResult("not json")]),
        env: WINDOWS_ENV,
      }),
    ).rejects.toMatchObject({ reason: "parse" });
  });

  it("prunes spawn-registry entries whose pid is gone", async () => {
    registerSweepRootProcess({ pid: 4242, cwd: SWEEP_DIRECTORY });
    registerSweepRootProcess({ pid: 99999, cwd: SWEEP_DIRECTORY });
    const snapshot = await takeWindowsProcessSnapshot({
      runner: fixedRunner([okResult(CIM_SAMPLE)]),
      env: WINDOWS_ENV,
    });
    const matches = matchWindowsProcessesUnderDirectory({
      snapshot,
      directory: SWEEP_DIRECTORY,
    });
    expect(matches.map((match) => match.pid)).not.toContain(99999);
  });
});

describe("queryWindowsProcess", () => {
  it("filters on the process id and returns null when absent", async () => {
    const requests: WindowsCommandRequest[] = [];
    await expect(
      queryWindowsProcess(4242, {
        runner: fixedRunner(
          [okResult(JSON.stringify(cimProcess(4242, 1234)))],
          requests,
        ),
        env: WINDOWS_ENV,
      }),
    ).resolves.toMatchObject({ pid: 4242, creationDate: CREATED_AT });
    expect(requests[0]?.args.at(-1)).toContain('-Filter "ProcessId = 4242"');
    await expect(
      queryWindowsProcess(4242, {
        runner: fixedRunner([okResult("")]),
        env: WINDOWS_ENV,
      }),
    ).resolves.toBeNull();
  });
});

describe("isWindowsPathUnderDirectory", () => {
  it.each([
    ["C:\\work\\bb\\tools\\agent.exe", "C:\\work\\bb", true],
    ["C:/work/bb/tools/agent.exe", "C:\\work\\bb", true],
    ["c:\\WORK\\bb", "C:\\work\\bb", true],
    ["C:\\work\\bb", "C:\\work\\bb\\", true],
    ["C:\\work\\bb-other\\x.exe", "C:\\work\\bb", false],
    ["\\\\?\\C:\\work\\bb\\agent.exe", "C:\\work\\bb", true],
    ["\\\\server\\share\\job.exe", "\\\\server\\share", true],
    ["\\\\?\\UNC\\server\\share\\job.exe", "\\\\server\\share", true],
    ["C:\\proyectos\\diseño\\app.exe", "C:\\proyectos\\diseño", true],
    ["C:\\work\\bb", "C:\\", true],
    ["D:\\other\\x.exe", "C:\\work", false],
  ])("compares %s against %s as %s", (candidate, directory, expected) => {
    expect(isWindowsPathUnderDirectory(candidate, directory)).toBe(expected);
  });
});

describe("matchWindowsProcessesUnderDirectory", () => {
  it("reports how each match was reached and carries CreationDate", () => {
    const snapshot = parseWindowsProcessSnapshot(CIM_SAMPLE);
    const matches = matchWindowsProcessesUnderDirectory({
      snapshot,
      directory: SWEEP_DIRECTORY,
    });
    const byPid = new Map(matches.map((match) => [match.pid, match]));
    expect(byPid.get(1234)).toEqual({
      pid: 1234,
      cwd: "C:\\work\\bb\\scripts\\start-bb.mjs",
      approximateCwd: true,
      matchEvidence: "command-line",
      creationDate: CREATED_AT,
    });
    expect(byPid.get(4242)?.matchEvidence).toBe("executable-path");
    expect(byPid.get(4243)?.matchEvidence).toBe("descendant");
    expect(byPid.get(624)).toBeUndefined();
  });

  it("matches processes the current runtime registered itself", () => {
    registerSweepRootProcess({ pid: 4243, cwd: "C:\\work\\bb\\worktree" });
    const matches = matchWindowsProcessesUnderDirectory({
      snapshot: parseWindowsProcessSnapshot(CIM_SAMPLE),
      directory: SWEEP_DIRECTORY,
    });
    expect(matches.find((match) => match.pid === 4243)?.matchEvidence).toBe(
      "spawn-registry",
    );
    unregisterSweepRootProcess(4243);
    expect(
      matchWindowsProcessesUnderDirectory({
        snapshot: parseWindowsProcessSnapshot(CIM_SAMPLE),
        directory: SWEEP_DIRECTORY,
      }).find((match) => match.pid === 4243)?.matchEvidence,
    ).toBe("descendant");
  });

  it("excludes the sweeping process and everything below it", () => {
    const matches = matchWindowsProcessesUnderDirectory({
      snapshot: parseWindowsProcessSnapshot(CIM_SAMPLE),
      directory: SWEEP_DIRECTORY,
      selfPid: 4242,
    });
    expect(matches.map((match) => match.pid).sort()).toEqual([1234]);
  });

  it("leaves unrelated processes alone", () => {
    expect(
      matchWindowsProcessesUnderDirectory({
        snapshot: parseWindowsProcessSnapshot(CIM_SAMPLE),
        directory: "C:\\elsewhere",
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the failing stop tests**

The POSIX case builds its fake child without a pid. `killProcessGroup` only reaches `process.kill(-pid, …)` when `child.pid !== undefined`, so a fake carrying `pid: 1000` would send a real `SIGKILL` to whatever process group 1000 happens to be on the test host and, when that call succeeds, `killProcessGroup` returns before `child.kill` and the `signals` assertion fails. Without a pid the helper path runs deterministically on every host.

Create `packages/process-utils/test/windows-process-stop.test.ts`:

```ts
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSweepRootProcesses,
  killProcessesWithCwdUnder,
  listProcessesWithCwdUnder,
  stopProcessGroupLeaderFirst,
  terminateProcessTree,
  type SkippedProcessEvent,
  type TerminateProcessTreeChild,
  type WindowsCommandRequest,
  type WindowsCommandResult,
  type WindowsCommandRunner,
} from "../src/index.js";

const CREATED_AT = "2026-09-14T09:00:00.0000000+00:00";
const REUSED_AT = "2026-09-14T09:30:00.0000000+00:00";
const SWEEP_DIRECTORY = "C:\\work\\bb";
const WINDOWS_ENV: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows" };

function cimProcess(
  pid: number,
  parentPid: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ProcessId: pid,
    ParentProcessId: parentPid,
    ExecutablePath: null,
    CommandLine: null,
    CreationDate: CREATED_AT,
    ...extra,
  };
}

interface FakeChild {
  child: TerminateProcessTreeChild;
  signals: NodeJS.Signals[];
}

function createFakeChild(pid: number | undefined, exited = false): FakeChild {
  const signals: NodeJS.Signals[] = [];
  const child: TerminateProcessTreeChild = {
    pid,
    exitCode: exited ? 0 : null,
    signalCode: null,
    kill(signal?: NodeJS.Signals) {
      const sent = signal ?? "SIGTERM";
      signals.push(sent);
      child.signalCode = sent;
      return true;
    },
  };
  return { child, signals };
}

function isTaskkill(request: WindowsCommandRequest): boolean {
  return request.command.toLowerCase().endsWith("taskkill.exe");
}

function createFakeRunner(snapshots: Array<Record<string, unknown>[]>): {
  requests: WindowsCommandRequest[];
  runner: WindowsCommandRunner;
} {
  const requests: WindowsCommandRequest[] = [];
  let index = 0;
  const runner: WindowsCommandRunner = async (request) => {
    requests.push(request);
    if (isTaskkill(request)) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    const entries = snapshots[Math.min(index, snapshots.length - 1)] ?? [];
    index += 1;
    return { stdout: JSON.stringify(entries), stderr: "", exitCode: 0 };
  };
  return { requests, runner };
}

function taskkillArgs(requests: WindowsCommandRequest[]): string[][] {
  return requests.filter(isTaskkill).map((request) => request.args);
}

afterEach(() => {
  clearSweepRootProcesses();
});

describe("terminateProcessTree on win32", () => {
  it("asks the tree to close, force-kills the leader through the handle, then the descendants", async () => {
    const leader = createFakeChild(1000);
    const tree = [
      cimProcess(1000, 1),
      cimProcess(1001, 1000),
      cimProcess(1002, 1001),
    ];
    const { requests, runner } = createFakeRunner([tree, tree]);

    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });

    expect(taskkillArgs(requests)).toEqual([
      ["/PID", "1000", "/T"],
      ["/PID", "1001", "/F"],
      ["/PID", "1002", "/F"],
    ]);
    expect(requests.filter(isTaskkill)[0]?.command).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(leader.signals).toEqual(["SIGKILL"]);
    expect(result.descendantsKilled.sort()).toEqual([1001, 1002]);
    expect(result.descendantsSkipped).toEqual([]);
    expect(result.leaderExited).toBe(true);
  });

  it("never signals a leader that already exited", async () => {
    const leader = createFakeChild(1000, true);
    const { requests, runner } = createFakeRunner([
      [cimProcess(1000, 1), cimProcess(1001, 1000)],
      [cimProcess(1001, 1000)],
    ]);

    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });

    expect(leader.signals).toEqual([]);
    expect(taskkillArgs(requests)).toEqual([
      ["/PID", "1000", "/T"],
      ["/PID", "1001", "/F"],
    ]);
    expect(result.leaderExited).toBe(true);
  });

  it("skips and reports a descendant whose CreationDate changed", async () => {
    const leader = createFakeChild(1000);
    const skipped: SkippedProcessEvent[] = [];
    const { requests, runner } = createFakeRunner([
      [cimProcess(1000, 1), cimProcess(1001, 1000), cimProcess(1002, 1000)],
      [
        cimProcess(1001, 1000, { CreationDate: REUSED_AT }),
        cimProcess(1002, 1000),
      ],
    ]);

    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
      onSkippedProcess: (event) => skipped.push(event),
    });

    expect(taskkillArgs(requests)).toEqual([
      ["/PID", "1000", "/T"],
      ["/PID", "1002", "/F"],
    ]);
    expect(result.descendantsKilled).toEqual([1002]);
    expect(result.descendantsSkipped).toEqual([
      {
        pid: 1001,
        reason: "pid-reused",
        expectedCreationDate: CREATED_AT,
        observedCreationDate: REUSED_AT,
      },
    ]);
    expect(skipped).toEqual(result.descendantsSkipped);
  });

  it("ignores a failing tree request and propagates enumeration failures", async () => {
    const leader = createFakeChild(1000);
    const failingTaskkill: WindowsCommandRunner = async (request) =>
      isTaskkill(request)
        ? { stdout: "", stderr: "denied", exitCode: 1 }
        : {
            stdout: JSON.stringify([cimProcess(1000, 1)]),
            stderr: "",
            exitCode: 0,
          };
    await expect(
      terminateProcessTree({
        child: leader.child,
        graceMs: 30,
        platform: "win32",
        runner: failingTaskkill,
        env: WINDOWS_ENV,
      }),
    ).resolves.toMatchObject({ descendantsKilled: [] });

    const brokenEnumeration: WindowsCommandRunner = async () => ({
      stdout: "",
      stderr: "denied",
      exitCode: 1,
    });
    await expect(
      terminateProcessTree({
        child: createFakeChild(1000).child,
        graceMs: 30,
        platform: "win32",
        runner: brokenEnumeration,
        env: WINDOWS_ENV,
      }),
    ).rejects.toMatchObject({ reason: "exit" });
  });
});

describe("terminateProcessTree on posix", () => {
  it("kills the group and reports only the leader", async () => {
    const leader = createFakeChild(undefined);
    const result = await terminateProcessTree({
      child: leader.child,
      graceMs: 30,
      platform: "linux",
    });
    expect(leader.signals).toEqual(["SIGKILL"]);
    expect(result).toEqual({
      leaderExited: true,
      descendantsKilled: [],
      descendantsSkipped: [],
    });
  });
});

describe("stopProcessGroupLeaderFirst on win32", () => {
  it("delegates to terminateProcessTree with the leader timeout as the grace", async () => {
    const leader = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      {
        stdio: "ignore",
      },
    );
    const leaderPid = leader.pid ?? 0;
    const { requests, runner } = createFakeRunner([
      [cimProcess(leaderPid, 1), cimProcess(leaderPid + 1, leaderPid)],
      [cimProcess(leaderPid + 1, leaderPid)],
    ]);
    const exited = new Promise<void>((resolve) => {
      leader.once("exit", () => resolve());
    });

    await stopProcessGroupLeaderFirst({
      child: leader,
      timeoutMs: 30,
      killGraceMs: 10,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });
    await exited;

    expect(taskkillArgs(requests)).toEqual([
      ["/PID", String(leaderPid), "/T"],
      ["/PID", String(leaderPid + 1), "/F"],
    ]);
    expect(leader.signalCode).toBe("SIGKILL");
  });
});

describe("listProcessesWithCwdUnder on win32", () => {
  it("enumerates and matches instead of returning an empty list", async () => {
    const { runner } = createFakeRunner([
      [
        cimProcess(1234, 1, {
          ExecutablePath: "C:\\work\\bb\\tools\\agent.exe",
        }),
        cimProcess(1235, 1234),
      ],
    ]);
    const matches = await listProcessesWithCwdUnder({
      directory: SWEEP_DIRECTORY,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
    });
    expect(matches.map((match) => match.pid).sort()).toEqual([1234, 1235]);
    expect(matches.every((match) => match.approximateCwd === true)).toBe(true);
  });

  it("propagates enumeration failures", async () => {
    const brokenRunner: WindowsCommandRunner = async () => ({
      stdout: "",
      stderr: "denied",
      exitCode: 1,
    });
    await expect(
      listProcessesWithCwdUnder({
        directory: SWEEP_DIRECTORY,
        platform: "win32",
        runner: brokenRunner,
        env: WINDOWS_ENV,
      }),
    ).rejects.toMatchObject({ reason: "exit" });
  });
});

describe("killProcessesWithCwdUnder on win32", () => {
  it("verifies CreationDate immediately before every force kill", async () => {
    const skipped: SkippedProcessEvent[] = [];
    const first = [
      cimProcess(1234, 1, { ExecutablePath: "C:\\work\\bb\\tools\\agent.exe" }),
      cimProcess(1235, 1, { ExecutablePath: "C:\\work\\bb\\tools\\other.exe" }),
    ];
    const verification = [
      cimProcess(1234, 1, {
        ExecutablePath: "C:\\work\\bb\\tools\\agent.exe",
        CreationDate: REUSED_AT,
      }),
      cimProcess(1235, 1, { ExecutablePath: "C:\\work\\bb\\tools\\other.exe" }),
    ];
    const { requests, runner } = createFakeRunner([first, verification, []]);

    const killed = await killProcessesWithCwdUnder({
      directory: SWEEP_DIRECTORY,
      platform: "win32",
      runner,
      env: WINDOWS_ENV,
      onSkippedProcess: (event) => skipped.push(event),
    });

    expect(taskkillArgs(requests)).toEqual([["/PID", "1235", "/F"]]);
    expect(killed.map((entry) => entry.pid)).toEqual([1235]);
    expect(skipped).toEqual([
      {
        pid: 1234,
        reason: "pid-reused",
        expectedCreationDate: CREATED_AT,
        observedCreationDate: REUSED_AT,
      },
    ]);
  });

  it("stops once a round finds nothing and propagates enumeration failures", async () => {
    const { requests, runner } = createFakeRunner([[]]);
    await expect(
      killProcessesWithCwdUnder({
        directory: SWEEP_DIRECTORY,
        platform: "win32",
        runner,
        env: WINDOWS_ENV,
      }),
    ).resolves.toEqual([]);
    expect(taskkillArgs(requests)).toEqual([]);

    const brokenRunner: WindowsCommandRunner = async () => {
      throw new Error("spawn ENOENT");
    };
    await expect(
      killProcessesWithCwdUnder({
        directory: SWEEP_DIRECTORY,
        platform: "win32",
        runner: brokenRunner,
        env: WINDOWS_ENV,
      }),
    ).rejects.toMatchObject({ reason: "spawn" });
  });
});
```

- [ ] **Step 3: Write the failing real-Windows tests**

Create `packages/process-utils/test/windows-process-real.test.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSweepRootProcesses,
  defaultWindowsCommandRunner,
  matchWindowsProcessesUnderDirectory,
  resolveWindowsSystemToolPath,
  spawnPortablePipedProcess,
  takeWindowsProcessSnapshot,
  terminateProcessTree,
  type SkippedProcessEvent,
  type WindowsCommandRunner,
} from "../src/index.js";

const win32Only = process.platform === "win32";
const PID_RECYCLE_ITERATIONS = 300;

const PARENT_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });',
  "process.stdout.write(`child_pid=${child.pid}\\n`);",
  "setTimeout(() => {}, 600000);",
].join("\n");

const strayPids: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return true;
}

async function startTree(): Promise<{
  child: ReturnType<typeof spawnPortablePipedProcess>;
  grandchildPid: number;
}> {
  const child = spawnPortablePipedProcess({
    command: process.execPath,
    args: ["-e", PARENT_SCRIPT],
  });
  const [chunk] = await once(child.stdout, "data");
  const grandchildPid = Number(
    /child_pid=(\d+)/u.exec(String(chunk))?.[1] ?? "",
  );
  expect(Number.isSafeInteger(grandchildPid)).toBe(true);
  strayPids.push(grandchildPid);
  return { child, grandchildPid };
}

function spawnSleeper(args: string[], cwd: string): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: "ignore",
    windowsHide: true,
  });
  if (child.pid !== undefined) {
    strayPids.push(child.pid);
  }
  return child;
}

async function recyclePids(iterations: number): Promise<void> {
  const cmdPath = resolveWindowsSystemToolPath("cmd.exe");
  for (let index = 0; index < iterations; index += 1) {
    const child = spawn(cmdPath, ["/d", "/c", "exit", "0"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "exit");
  }
}

afterEach(() => {
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  clearSweepRootProcesses();
});

describe("terminateProcessTree against real Windows processes", () => {
  it.runIf(win32Only)(
    "kills the grandchild and reports it",
    async () => {
      const { child, grandchildPid } = await startTree();

      const result = await terminateProcessTree({
        child,
        graceMs: 5_000,
        platform: "win32",
      });

      expect(result.leaderExited).toBe(true);
      expect(result.descendantsKilled).toContain(grandchildPid);
      expect(result.descendantsSkipped).toEqual([]);
      await expect(waitUntilGone(grandchildPid, 5_000)).resolves.toBe(true);
    },
    30_000,
  );

  it.runIf(win32Only)(
    "skips a descendant whose recorded CreationDate no longer matches",
    async () => {
      const { child, grandchildPid } = await startTree();
      let enumerations = 0;
      const runner: WindowsCommandRunner = async (request, options) => {
        const result = await defaultWindowsCommandRunner(request, options);
        if (request.command.toLowerCase().endsWith("taskkill.exe")) {
          return result;
        }
        enumerations += 1;
        if (enumerations !== 1) {
          return result;
        }
        const parsed: unknown = JSON.parse(
          result.stdout.replace(/^\uFEFF/u, ""),
        );
        if (!Array.isArray(parsed)) {
          return result;
        }
        const entries: Record<string, unknown>[] = parsed.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null,
        );
        for (const entry of entries) {
          if (entry.ProcessId === grandchildPid) {
            entry.CreationDate = "1999-01-01T00:00:00.0000000+00:00";
          }
        }
        return { ...result, stdout: JSON.stringify(entries) };
      };

      const result = await terminateProcessTree({
        child,
        graceMs: 5_000,
        platform: "win32",
        runner,
      });

      expect(result.descendantsKilled).not.toContain(grandchildPid);
      expect(result.descendantsSkipped).toEqual([
        {
          pid: grandchildPid,
          reason: "pid-reused",
          expectedCreationDate: "1999-01-01T00:00:00.0000000+00:00",
          observedCreationDate: expect.stringMatching(/^\d{4}-/u),
        },
      ]);
      expect(isAlive(grandchildPid)).toBe(true);
    },
    30_000,
  );

  it.runIf(win32Only)(
    "leaves unrelated processes alive while PIDs are recycled under a tree kill",
    async () => {
      const unrelated = spawnSleeper(
        ["-e", "setTimeout(() => {}, 600000)"],
        process.cwd(),
      );
      const unrelatedPid = unrelated.pid ?? 0;
      expect(Number.isSafeInteger(unrelatedPid)).toBe(true);
      const { child, grandchildPid } = await startTree();
      const leaderPid = child.pid ?? 0;
      const skipped: SkippedProcessEvent[] = [];

      const [result] = await Promise.all([
        terminateProcessTree({
          child,
          graceMs: 5_000,
          platform: "win32",
          onSkippedProcess: (event) => {
            skipped.push(event);
          },
        }),
        recyclePids(PID_RECYCLE_ITERATIONS),
      ]);

      const unrelatedAlive = isAlive(unrelatedPid);
      process.stdout.write(
        `PID_REUSE_EVIDENCE ${JSON.stringify({
          leaderPid,
          grandchildPid,
          unrelatedPid,
          unrelatedAlive,
          recycleIterations: PID_RECYCLE_ITERATIONS,
          leaderExited: result.leaderExited,
          descendantsKilled: result.descendantsKilled,
          descendantsSkipped: result.descendantsSkipped,
          skipped,
        })}\n`,
      );

      expect(unrelatedAlive).toBe(true);
      expect(result.leaderExited).toBe(true);
      await expect(waitUntilGone(leaderPid, 5_000)).resolves.toBe(true);
      await expect(waitUntilGone(grandchildPid, 5_000)).resolves.toBe(true);
      expect(skipped).toEqual(result.descendantsSkipped);
      unrelated.kill();
    },
    180_000,
  );
});

describe("Windows process enumeration against real processes", () => {
  it.runIf(win32Only)(
    "documents an under-match and an over-match",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "bb-enum-demo-"));
      const underMatch = spawnSleeper(
        ["-e", "setTimeout(() => {}, 60000)"],
        directory,
      );
      const overMatch = spawnSleeper(
        [
          "-e",
          `process.env.BB_ENUM_DEMO_DIRECTORY = ${JSON.stringify(directory)}; setTimeout(() => {}, 60000)`,
        ],
        process.cwd(),
      );
      await delay(1_000);

      const startedAt = Date.now();
      const snapshot = await takeWindowsProcessSnapshot();
      const enumerationMs = Date.now() - startedAt;
      const matches = matchWindowsProcessesUnderDirectory({
        snapshot,
        directory,
      });
      const underMatchEntry = matches.find(
        (match) => match.pid === underMatch.pid,
      );
      const overMatchEntry = matches.find(
        (match) => match.pid === overMatch.pid,
      );

      process.stdout.write(
        `ENUMERATION_EVIDENCE ${JSON.stringify({
          directory,
          enumerationMs,
          underMatchPid: underMatch.pid,
          underMatchMissed: underMatchEntry === undefined,
          overMatchPid: overMatch.pid,
          overMatchEvidence: overMatchEntry?.matchEvidence ?? null,
          matchedPids: matches.map((match) => match.pid),
        })}\n`,
      );

      expect(underMatchEntry).toBeUndefined();
      expect(overMatchEntry?.matchEvidence).toBe("command-line");
      expect(overMatchEntry?.approximateCwd).toBe(true);

      underMatch.kill();
      overMatch.kill();
      await rm(directory, { recursive: true, force: true });
    },
    60_000,
  );
});
```

The second case in the first block is the PID-reuse stress proof in miniature: `taskkill /PID <leader> /T` without `/F` cannot close a windowless console process, and the leader dies only through its own handle, so the forged descendant survives untouched and is reported rather than killed. The `afterEach` cleanup kills it.

The last two cases carry the Phase 2 gate's process evidence, which is why they print one machine-readable line each instead of only asserting. `PID_REUSE_EVIDENCE` proves the gate's "a PID-reuse stress test leaves every unrelated process alive and logs `pid-reused` skips" bullet: 300 short-lived `cmd.exe /d /c exit 0` spawns recycle PIDs while the tree is torn down, the unrelated sleeper started before the loop is still alive afterwards, and `descendantsSkipped` records every identity mismatch the race produced (an empty array is a valid outcome and is recorded as such). `ENUMERATION_EVIDENCE` proves the "over-match and under-match cases are reproduced and documented" bullet: Windows exposes no cwd, so a process whose cwd is the directory but whose argv never names it is missed, and a process running elsewhere whose argv contains the directory string is matched with `command-line` evidence. `enumerationMs` is recorded as an observational data point for the spec's ≈1.2 s CIM cost figure, not asserted. Both cases live here, in the package that owns `@bb/process-utils`, instead of in standalone `qa/windows/scripts/*.mjs` files, because the repo root has no `node_modules/@bb` and a root-level script cannot import `@bb/process-utils`.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @bb/process-utils exec vitest run test/windows-process-snapshot.test.ts test/windows-process-stop.test.ts test/windows-process-real.test.ts`.
Expected: FAIL — none of `takeWindowsProcessSnapshot`, `terminateProcessTree`, `WindowsProcessEnumerationError`, `matchWindowsProcessesUnderDirectory`, `registerSweepRootProcess` or `defaultWindowsCommandRunner` exists, and `listProcessesWithCwdUnder`/`killProcessesWithCwdUnder`/`stopProcessGroupLeaderFirst` reject the new properties.

- [ ] **Step 5: Create `packages/process-utils/src/windows-process-snapshot.ts`**

```ts
import { realpathSync } from "node:fs";
import { spawnPortableOutputProcess } from "./index.js";
import {
  POWERSHELL_NONINTERACTIVE_ARGS,
  resolvePowerShellExecutable,
} from "./windows-system-tools.js";

export interface WindowsProcessSnapshotEntry {
  pid: number;
  parentPid: number;
  executablePath: string | null;
  commandLine: string | null;
  creationDate: string | null;
}

export interface WindowsCommandRequest {
  command: string;
  args: string[];
}

export interface WindowsCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type WindowsCommandRunner = (
  request: WindowsCommandRequest,
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<WindowsCommandResult>;

export type WindowsProcessEnumerationErrorReason =
  "timeout" | "exit" | "parse" | "spawn";

export class WindowsProcessEnumerationError extends Error {
  readonly reason: WindowsProcessEnumerationErrorReason;

  constructor(reason: WindowsProcessEnumerationErrorReason, message: string) {
    super(message);
    this.name = "WindowsProcessEnumerationError";
    this.reason = reason;
  }
}

export const WINDOWS_PROCESS_ENUM_TIMEOUT_MS = 10_000;

const WINDOWS_PROCESS_PROJECTION =
  "ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null }}}";

function buildWindowsProcessScript(filter: string | null): string {
  const source =
    filter === null
      ? "Get-CimInstance Win32_Process"
      : `Get-CimInstance Win32_Process -Filter "${filter}"`;
  return `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${source} | Select-Object ${WINDOWS_PROCESS_PROJECTION} | ConvertTo-Json -Compress`;
}

export function buildWindowsProcessEnumRequest(
  env: NodeJS.ProcessEnv = process.env,
): WindowsCommandRequest {
  return {
    command: resolvePowerShellExecutable(env),
    args: [
      ...POWERSHELL_NONINTERACTIVE_ARGS,
      "-Command",
      buildWindowsProcessScript(null),
    ],
  };
}

function buildWindowsProcessQueryRequest(
  pid: number,
  env: NodeJS.ProcessEnv,
): WindowsCommandRequest {
  return {
    command: resolvePowerShellExecutable(env),
    args: [
      ...POWERSHELL_NONINTERACTIVE_ARGS,
      "-Command",
      buildWindowsProcessScript(`ProcessId = ${pid}`),
    ],
  };
}

function describeWindowsCommand(request: WindowsCommandRequest): string {
  return `${request.command} ${request.args.join(" ")}`.slice(0, 400);
}

export const defaultWindowsCommandRunner: WindowsCommandRunner = (
  request,
  options,
) =>
  new Promise<WindowsCommandResult>((resolveRun, rejectRun) => {
    const child = spawnPortableOutputProcess({
      command: request.command,
      args: request.args,
      env: options.env,
      platform: "win32",
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const claim = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const timer = setTimeout(() => {
      if (!claim()) {
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {}
      rejectRun(
        new WindowsProcessEnumerationError(
          "timeout",
          `${describeWindowsCommand(request)} timed out after ${options.timeoutMs}ms`,
        ),
      );
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      if (claim()) {
        rejectRun(error);
      }
    });
    child.once("exit", (exitCode) => {
      if (!claim()) {
        return;
      }
      resolveRun({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
      });
    });
  });

async function runWindowsCommand(args: {
  runner: WindowsCommandRunner;
  request: WindowsCommandRequest;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<WindowsCommandResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: WindowsCommandResult;
  try {
    result = await Promise.race([
      args.runner(args.request, { timeoutMs: args.timeoutMs, env: args.env }),
      new Promise<WindowsCommandResult>((_resolveRace, rejectRace) => {
        timer = setTimeout(() => {
          rejectRace(
            new WindowsProcessEnumerationError(
              "timeout",
              `${describeWindowsCommand(args.request)} timed out after ${args.timeoutMs}ms`,
            ),
          );
        }, args.timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof WindowsProcessEnumerationError) {
      throw error;
    }
    throw new WindowsProcessEnumerationError(
      "spawn",
      `${describeWindowsCommand(args.request)} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
  if (result.exitCode !== 0) {
    throw new WindowsProcessEnumerationError(
      "exit",
      `${describeWindowsCommand(args.request)} exited with ${result.exitCode}: ${result.stderr.slice(0, 400)}`,
    );
  }
  return result;
}

function readCimString(
  record: Record<string, unknown>,
  names: string[],
): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return null;
}

export function parseWindowsProcessSnapshot(
  stdout: string,
): WindowsProcessSnapshotEntry[] {
  const trimmed = stdout.replace(/^\uFEFF/u, "").trim();
  if (trimmed === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new WindowsProcessEnumerationError(
      "parse",
      `Unable to parse Get-CimInstance Win32_Process output as JSON: ${trimmed.slice(0, 200)}`,
    );
  }
  if (parsed === null || parsed === undefined) {
    return [];
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const entries: WindowsProcessSnapshotEntry[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record: Record<string, unknown> = { ...item };
    const pid = Number(record.ProcessId ?? record.processId);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const parentRaw = Number(
      record.ParentProcessId ?? record.parentProcessId ?? 0,
    );
    entries.push({
      pid,
      parentPid: Number.isInteger(parentRaw) && parentRaw >= 0 ? parentRaw : 0,
      executablePath: readCimString(record, [
        "ExecutablePath",
        "executablePath",
      ]),
      commandLine: readCimString(record, ["CommandLine", "commandLine"]),
      creationDate: readCimString(record, ["CreationDate", "creationDate"]),
    });
  }
  return entries;
}

const trackedSweepRoots = new Map<number, string>();

export function registerSweepRootProcess(args: {
  pid: number;
  cwd: string;
}): void {
  if (Number.isInteger(args.pid) && args.pid > 0 && args.cwd !== "") {
    trackedSweepRoots.set(args.pid, args.cwd);
  }
}

export function unregisterSweepRootProcess(pid: number): void {
  trackedSweepRoots.delete(pid);
}

export function clearSweepRootProcesses(): void {
  trackedSweepRoots.clear();
}

export async function takeWindowsProcessSnapshot(
  args: {
    runner?: WindowsCommandRunner;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<WindowsProcessSnapshotEntry[]> {
  const env = args.env ?? process.env;
  const result = await runWindowsCommand({
    runner: args.runner ?? defaultWindowsCommandRunner,
    request: buildWindowsProcessEnumRequest(env),
    timeoutMs: args.timeoutMs ?? WINDOWS_PROCESS_ENUM_TIMEOUT_MS,
    env,
  });
  const snapshot = parseWindowsProcessSnapshot(result.stdout);
  const livePids = new Set(snapshot.map((entry) => entry.pid));
  for (const pid of [...trackedSweepRoots.keys()]) {
    if (!livePids.has(pid)) {
      trackedSweepRoots.delete(pid);
    }
  }
  return snapshot;
}

export async function queryWindowsProcess(
  pid: number,
  args: {
    runner?: WindowsCommandRunner;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<WindowsProcessSnapshotEntry | null> {
  const env = args.env ?? process.env;
  const result = await runWindowsCommand({
    runner: args.runner ?? defaultWindowsCommandRunner,
    request: buildWindowsProcessQueryRequest(pid, env),
    timeoutMs: args.timeoutMs ?? WINDOWS_PROCESS_ENUM_TIMEOUT_MS,
    env,
  });
  return parseWindowsProcessSnapshot(result.stdout)[0] ?? null;
}

function canonicalizeWindowsPath(value: string): string {
  let rest = value.replace(/\//gu, "\\");
  let prefix = "";
  if (/^\\\\\?\\UNC\\/iu.test(rest)) {
    prefix = "\\\\";
    rest = rest.slice(8);
  } else if (/^\\\\\?\\/iu.test(rest)) {
    rest = rest.slice(4);
  } else if (rest.startsWith("\\\\")) {
    prefix = "\\\\";
    rest = rest.slice(2);
  }
  rest = rest.replace(/\\+/gu, "\\");
  if (rest.length > 1 && rest.endsWith("\\") && !/^[A-Za-z]:\\$/u.test(rest)) {
    rest = rest.replace(/\\+$/u, "");
  }
  if (rest === "") {
    return prefix === "" ? "\\" : prefix;
  }
  return `${prefix}${rest}`.toLowerCase();
}

const WINDOWS_SHORT_NAME_SEGMENT_PATTERN = /~\d+(?=[\\/]|$)/u;

function expandWindowsShortPath(value: string): string {
  if (!WINDOWS_SHORT_NAME_SEGMENT_PATTERN.test(value)) {
    return value;
  }
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

export function isWindowsPathUnderDirectory(
  candidate: string,
  directory: string,
): boolean {
  const canonicalCandidate = canonicalizeWindowsPath(candidate);
  const canonicalDirectory = canonicalizeWindowsPath(directory);
  if (canonicalCandidate === canonicalDirectory) {
    return true;
  }
  const directoryPrefix = canonicalDirectory.endsWith("\\")
    ? canonicalDirectory
    : `${canonicalDirectory}\\`;
  return canonicalCandidate.startsWith(directoryPrefix);
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;

function extractWindowsPathCandidates(commandLine: string): string[] {
  const candidates: string[] = [];
  const tokenPattern = /"([^"]+)"|(\S+)/gu;
  let match: RegExpExecArray | null = tokenPattern.exec(commandLine);
  while (match !== null) {
    const token = (match[1] ?? match[2] ?? "").replace(/[,;]+$/u, "");
    if (
      token !== "" &&
      (WINDOWS_ABSOLUTE_PATH_PATTERN.test(token) || token.startsWith("\\\\"))
    ) {
      candidates.push(token);
    }
    match = tokenPattern.exec(commandLine);
  }
  return candidates;
}

export type WindowsSweepMatchEvidence =
  "spawn-registry" | "executable-path" | "command-line" | "descendant";

export interface WindowsProcessMatch {
  pid: number;
  cwd: string;
  approximateCwd: true;
  matchEvidence: WindowsSweepMatchEvidence;
  creationDate: string | null;
}

export interface MatchWindowsProcessesUnderDirectoryArgs {
  snapshot: WindowsProcessSnapshotEntry[];
  directory: string;
  trackedRoots?: ReadonlyMap<number, string>;
  selfPid?: number;
  canonicalizePath?: (value: string) => string;
}

function matchWindowsProcessPath(args: {
  entry: WindowsProcessSnapshotEntry;
  directory: string;
  canonicalize: (value: string) => string;
}): { path: string; evidence: WindowsSweepMatchEvidence } | null {
  if (
    args.entry.executablePath !== null &&
    isWindowsPathUnderDirectory(
      args.canonicalize(args.entry.executablePath),
      args.directory,
    )
  ) {
    return { path: args.entry.executablePath, evidence: "executable-path" };
  }
  if (args.entry.commandLine !== null) {
    for (const candidate of extractWindowsPathCandidates(
      args.entry.commandLine,
    )) {
      if (
        isWindowsPathUnderDirectory(
          args.canonicalize(candidate),
          args.directory,
        )
      ) {
        return { path: candidate, evidence: "command-line" };
      }
    }
  }
  return null;
}

export function matchWindowsProcessesUnderDirectory(
  args: MatchWindowsProcessesUnderDirectoryArgs,
): WindowsProcessMatch[] {
  const trackedRoots = args.trackedRoots ?? trackedSweepRoots;
  const canonicalizePath = args.canonicalizePath ?? expandWindowsShortPath;
  const canonicalCache = new Map<string, string>();
  const canonicalize = (value: string): string => {
    const cached = canonicalCache.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const canonical = canonicalizePath(value);
    canonicalCache.set(value, canonical);
    return canonical;
  };
  const directory = canonicalize(args.directory);
  const byPid = new Map<number, WindowsProcessSnapshotEntry>();
  const childrenByParent = new Map<number, number[]>();
  for (const entry of args.snapshot) {
    byPid.set(entry.pid, entry);
    const siblings = childrenByParent.get(entry.parentPid) ?? [];
    siblings.push(entry.pid);
    childrenByParent.set(entry.parentPid, siblings);
  }
  const evidenceByPid = new Map<
    number,
    { cwd: string; evidence: WindowsSweepMatchEvidence }
  >();
  for (const [pid, rootCwd] of trackedRoots) {
    if (pid === args.selfPid) {
      continue;
    }
    if (isWindowsPathUnderDirectory(canonicalize(rootCwd), directory)) {
      evidenceByPid.set(pid, { cwd: rootCwd, evidence: "spawn-registry" });
    }
  }
  for (const entry of args.snapshot) {
    if (entry.pid === args.selfPid || evidenceByPid.has(entry.pid)) {
      continue;
    }
    const match = matchWindowsProcessPath({ entry, directory, canonicalize });
    if (match !== null) {
      evidenceByPid.set(entry.pid, {
        cwd: match.path,
        evidence: match.evidence,
      });
    }
  }
  const queue = [...evidenceByPid.keys()];
  const queued = new Set<number>(queue);
  while (queue.length > 0) {
    const pid = queue.pop();
    if (pid === undefined) {
      continue;
    }
    const inherited = evidenceByPid.get(pid);
    if (inherited === undefined) {
      continue;
    }
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (childPid === args.selfPid || queued.has(childPid)) {
        continue;
      }
      queued.add(childPid);
      const child = byPid.get(childPid);
      const own =
        child === undefined
          ? null
          : matchWindowsProcessPath({ entry: child, directory, canonicalize });
      evidenceByPid.set(
        childPid,
        own === null
          ? { cwd: inherited.cwd, evidence: "descendant" }
          : { cwd: own.path, evidence: own.evidence },
      );
      queue.push(childPid);
    }
  }
  const results: WindowsProcessMatch[] = [];
  for (const [pid, match] of evidenceByPid) {
    const entry = byPid.get(pid);
    if (entry === undefined) {
      continue;
    }
    results.push({
      pid,
      cwd: match.cwd,
      approximateCwd: true,
      matchEvidence: match.evidence,
      creationDate: entry.creationDate,
    });
  }
  return results;
}
```

- [ ] **Step 6: Create `packages/process-utils/src/windows-process-stop.ts`**

```ts
import type { ChildProcess } from "node:child_process";
import { killProcessGroup, type ProcessWithCwd } from "./index.js";
import {
  defaultWindowsCommandRunner,
  matchWindowsProcessesUnderDirectory,
  takeWindowsProcessSnapshot,
  WINDOWS_PROCESS_ENUM_TIMEOUT_MS,
  type WindowsCommandRequest,
  type WindowsCommandRunner,
  type WindowsProcessSnapshotEntry,
} from "./windows-process-snapshot.js";
import { resolveWindowsSystemToolPath } from "./windows-system-tools.js";

const CHILD_EXIT_POLL_MS = 25;
const WINDOWS_SWEEP_MAX_ROUNDS = 5;
const WINDOWS_SWEEP_SETTLE_MS = 50;
const TASKKILL_NOT_FOUND_EXIT_CODE = 128;

export interface SkippedProcessEvent {
  pid: number;
  reason: "pid-reused";
  expectedCreationDate: string | null;
  observedCreationDate: string | null;
}

export interface TerminateProcessTreeResult {
  leaderExited: boolean;
  descendantsKilled: number[];
  descendantsSkipped: SkippedProcessEvent[];
}

export interface TerminateProcessTreeChild {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface TerminateProcessTreeArgs {
  child: TerminateProcessTreeChild;
  graceMs: number;
  platform?: NodeJS.Platform;
  runner?: WindowsCommandRunner;
  env?: NodeJS.ProcessEnv;
  onSkippedProcess?: (event: SkippedProcessEvent) => void;
}

function hasChildExited(child: TerminateProcessTreeChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForChildExit(
  child: TerminateProcessTreeChild,
  graceMs: number,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (!hasChildExited(child)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(CHILD_EXIT_POLL_MS);
  }
  return true;
}

function buildTaskkillRequest(
  pid: number,
  mode: "tree" | "force",
  env: NodeJS.ProcessEnv,
): WindowsCommandRequest {
  return {
    command: resolveWindowsSystemToolPath("taskkill.exe", env),
    args: ["/PID", String(pid), mode === "tree" ? "/T" : "/F"],
  };
}

function collectDescendantCreationDates(
  snapshot: WindowsProcessSnapshotEntry[],
  rootPid: number,
): Map<number, string | null> {
  const childrenByParent = new Map<number, number[]>();
  const byPid = new Map<number, WindowsProcessSnapshotEntry>();
  for (const entry of snapshot) {
    byPid.set(entry.pid, entry);
    const siblings = childrenByParent.get(entry.parentPid) ?? [];
    siblings.push(entry.pid);
    childrenByParent.set(entry.parentPid, siblings);
  }
  const descendants = new Map<number, string | null>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.pop();
    if (pid === undefined) {
      continue;
    }
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (childPid === rootPid || descendants.has(childPid)) {
        continue;
      }
      descendants.set(childPid, byPid.get(childPid)?.creationDate ?? null);
      queue.push(childPid);
    }
  }
  return descendants;
}

async function runTaskkill(args: {
  runner: WindowsCommandRunner;
  pid: number;
  mode: "tree" | "force";
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<boolean> {
  try {
    const result = await args.runner(
      buildTaskkillRequest(args.pid, args.mode, args.env),
      { timeoutMs: args.timeoutMs, env: args.env },
    );
    return (
      result.exitCode === 0 || result.exitCode === TASKKILL_NOT_FOUND_EXIT_CODE
    );
  } catch {
    return false;
  }
}

export async function terminateProcessTree(
  args: TerminateProcessTreeArgs,
): Promise<TerminateProcessTreeResult> {
  const platform = args.platform ?? process.platform;
  if (platform !== "win32") {
    killProcessGroup({ child: args.child, signal: "SIGKILL", platform });
    return {
      leaderExited: await waitForChildExit(args.child, args.graceMs),
      descendantsKilled: [],
      descendantsSkipped: [],
    };
  }
  const env = args.env ?? process.env;
  const runner = args.runner ?? defaultWindowsCommandRunner;
  const timeoutMs = WINDOWS_PROCESS_ENUM_TIMEOUT_MS;
  const leaderPid = args.child.pid;
  if (leaderPid === undefined) {
    return {
      leaderExited: hasChildExited(args.child),
      descendantsKilled: [],
      descendantsSkipped: [],
    };
  }
  const before = await takeWindowsProcessSnapshot({ runner, timeoutMs, env });
  const descendants = collectDescendantCreationDates(before, leaderPid);
  await runTaskkill({ runner, pid: leaderPid, mode: "tree", env, timeoutMs });
  const leaderExited = await waitForChildExit(args.child, args.graceMs);
  if (!leaderExited) {
    args.child.kill("SIGKILL");
  }
  const after = await takeWindowsProcessSnapshot({ runner, timeoutMs, env });
  const observedByPid = new Map(
    after.map((entry) => [entry.pid, entry.creationDate]),
  );
  const descendantsKilled: number[] = [];
  const descendantsSkipped: SkippedProcessEvent[] = [];
  for (const [pid, expectedCreationDate] of descendants) {
    if (!observedByPid.has(pid)) {
      continue;
    }
    const observedCreationDate = observedByPid.get(pid) ?? null;
    if (observedCreationDate !== expectedCreationDate) {
      const event: SkippedProcessEvent = {
        pid,
        reason: "pid-reused",
        expectedCreationDate,
        observedCreationDate,
      };
      descendantsSkipped.push(event);
      args.onSkippedProcess?.(event);
      continue;
    }
    if (await runTaskkill({ runner, pid, mode: "force", env, timeoutMs })) {
      descendantsKilled.push(pid);
    }
  }
  return {
    leaderExited: hasChildExited(args.child),
    descendantsKilled,
    descendantsSkipped,
  };
}

export async function listWindowsProcessesWithCwdUnder(args: {
  directory: string;
  runner: WindowsCommandRunner | undefined;
  env: NodeJS.ProcessEnv | undefined;
  timeoutMs: number | undefined;
  selfPid: number;
}): Promise<ProcessWithCwd[]> {
  const env = args.env ?? process.env;
  const snapshot = await takeWindowsProcessSnapshot({
    runner: args.runner ?? defaultWindowsCommandRunner,
    timeoutMs: args.timeoutMs ?? WINDOWS_PROCESS_ENUM_TIMEOUT_MS,
    env,
  });
  return matchWindowsProcessesUnderDirectory({
    snapshot,
    directory: args.directory,
    selfPid: args.selfPid,
  });
}

export async function killWindowsProcessesWithCwdUnder(args: {
  directory: string;
  runner: WindowsCommandRunner | undefined;
  env: NodeJS.ProcessEnv | undefined;
  timeoutMs: number | undefined;
  selfPid: number;
  onSkippedProcess: ((event: SkippedProcessEvent) => void) | undefined;
}): Promise<ProcessWithCwd[]> {
  const env = args.env ?? process.env;
  const runner = args.runner ?? defaultWindowsCommandRunner;
  const timeoutMs = args.timeoutMs ?? WINDOWS_PROCESS_ENUM_TIMEOUT_MS;
  const killed = new Map<number, ProcessWithCwd>();
  for (let round = 0; round < WINDOWS_SWEEP_MAX_ROUNDS; round += 1) {
    const snapshot = await takeWindowsProcessSnapshot({
      runner,
      timeoutMs,
      env,
    });
    const targets = matchWindowsProcessesUnderDirectory({
      snapshot,
      directory: args.directory,
      selfPid: args.selfPid,
    });
    if (targets.length === 0) {
      break;
    }
    const verification = await takeWindowsProcessSnapshot({
      runner,
      timeoutMs,
      env,
    });
    const observedByPid = new Map(
      verification.map((entry) => [entry.pid, entry.creationDate]),
    );
    for (const target of targets) {
      if (!observedByPid.has(target.pid)) {
        continue;
      }
      const observedCreationDate = observedByPid.get(target.pid) ?? null;
      if (observedCreationDate !== target.creationDate) {
        args.onSkippedProcess?.({
          pid: target.pid,
          reason: "pid-reused",
          expectedCreationDate: target.creationDate,
          observedCreationDate,
        });
        continue;
      }
      if (
        await runTaskkill({
          runner,
          pid: target.pid,
          mode: "force",
          env,
          timeoutMs,
        })
      ) {
        killed.set(target.pid, {
          pid: target.pid,
          cwd: target.cwd,
          approximateCwd: true,
          matchEvidence: target.matchEvidence,
        });
      }
    }
    await delay(WINDOWS_SWEEP_SETTLE_MS);
  }
  return [...killed.values()];
}
```

The win32 sweep force-kills immediately, so the POSIX `graceMs` (the SIGTERM grace) has no meaning there; the settle delay plus the next round's enumeration is the equivalent checkpoint. Document that line in `docs/platform-windows.md` in Task 14.

- [ ] **Step 7: Wire the win32 arms into `src/index.ts`**

Re-exports, extending the block from Task 1:

```ts
export * from "./plugin-process-paths.js";
export * from "./resolve-executable.js";
export * from "./windows-process-snapshot.js";
export * from "./windows-process-stop.js";
export * from "./windows-system-tools.js";
```

New imports beside `crossSpawn`:

```ts
import {
  registerSweepRootProcess,
  unregisterSweepRootProcess,
  type WindowsCommandRunner,
  type WindowsSweepMatchEvidence,
} from "./windows-process-snapshot.js";
import {
  killWindowsProcessesWithCwdUnder,
  listWindowsProcessesWithCwdUnder,
  terminateProcessTree,
  type SkippedProcessEvent,
} from "./windows-process-stop.js";
```

Argument and result types (58–76):

```ts
interface StopProcessGroupLeaderFirstArgs {
  child: ChildProcess;
  timeoutMs: number;
  killGraceMs: number;
  platform?: NodeJS.Platform;
  runner?: WindowsCommandRunner;
  env?: NodeJS.ProcessEnv;
  onSkippedProcess?: (event: SkippedProcessEvent) => void;
}

export interface ProcessWithCwd {
  pid: number;
  cwd: string;
  approximateCwd?: true;
  matchEvidence?: WindowsSweepMatchEvidence;
}

interface ListProcessesWithCwdUnderArgs {
  directory: string;
  platform?: NodeJS.Platform;
  runner?: WindowsCommandRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface KillProcessesWithCwdUnderArgs {
  directory: string;
  graceMs?: number;
  platform?: NodeJS.Platform;
  runner?: WindowsCommandRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onSkippedProcess?: (event: SkippedProcessEvent) => void;
}
```

`spawnPortableProcess` gains the registry block after the `crossSpawn` call (Task 1's body otherwise unchanged):

```ts
export function spawnPortableProcess(
  request: PortableSpawnRequest,
): PortableChildProcess {
  const platform = request.platform ?? process.platform;
  const child = crossSpawn(request.command, request.args, {
    cwd: request.cwd,
    detached: request.detached,
    env: request.env,
    stdio: request.stdio,
    windowsHide:
      platform === "win32"
        ? (request.windowsHide ?? true)
        : request.windowsHide,
  });
  const cwd = request.cwd;
  const pid = child.pid;
  if (platform === "win32" && cwd !== undefined && pid !== undefined) {
    registerSweepRootProcess({ pid, cwd });
    child.once("exit", () => unregisterSweepRootProcess(pid));
  }
  return child;
}
```

`stopProcessGroupLeaderFirst` keeps its whole body; only the new first statement is added after the destructuring line:

```ts
export function stopProcessGroupLeaderFirst(
  args: StopProcessGroupLeaderFirstArgs,
): Promise<void> {
  const { child, timeoutMs, killGraceMs } = args;
  if ((args.platform ?? process.platform) === "win32") {
    return terminateProcessTree({
      child,
      graceMs: timeoutMs,
      platform: "win32",
      ...(args.runner !== undefined ? { runner: args.runner } : {}),
      ...(args.env !== undefined ? { env: args.env } : {}),
      ...(args.onSkippedProcess !== undefined
        ? { onSkippedProcess: args.onSkippedProcess }
        : {}),
    }).then(() => undefined);
  }
  if (hasChildExited(child) && !isProcessGroupAlive(child)) {
    return Promise.resolve();
  }
  ...
}
```

`listProcessesWithCwdUnder` — the `return [];` early exit at 352–354 becomes the win32 arm; everything below it is unchanged:

```ts
export async function listProcessesWithCwdUnder(
  args: ListProcessesWithCwdUnderArgs,
): Promise<ProcessWithCwd[]> {
  if ((args.platform ?? process.platform) === "win32") {
    return listWindowsProcessesWithCwdUnder({
      directory: args.directory,
      runner: args.runner,
      env: args.env,
      timeoutMs: args.timeoutMs,
      selfPid: process.pid,
    });
  }
  const directory = await resolveSweepDirectory(args.directory);
  ...
}
```

`killProcessesWithCwdUnder` gains the win32 arm before `const graceMs = ...`; the POSIX loop is unchanged:

```ts
export async function killProcessesWithCwdUnder(
  args: KillProcessesWithCwdUnderArgs,
): Promise<ProcessWithCwd[]> {
  if ((args.platform ?? process.platform) === "win32") {
    return killWindowsProcessesWithCwdUnder({
      directory: args.directory,
      runner: args.runner,
      env: args.env,
      timeoutMs: args.timeoutMs,
      selfPid: process.pid,
      onSkippedProcess: args.onSkippedProcess,
    });
  }
  const graceMs = args.graceMs ?? 2000;
  ...
}
```

`killProcessGroup` is not changed in this task: on win32 it keeps `child.kill(signal)` and is leader-only (R3). Record that in `docs/platform-windows.md` in Task 14.

- [ ] **Step 8: Run the tests and the typechecks**

Run: `pnpm --filter @bb/process-utils exec vitest run test/windows-process-snapshot.test.ts test/windows-process-stop.test.ts test/windows-process-real.test.ts`, then `pnpm exec turbo run typecheck --filter=@bb/process-utils --filter=@bb/host-daemon --filter=@bb/host-workspace --filter=@bb/local-open-targets --filter=@bb/plugin-sdk --filter=@bb/agent-runtime --filter=@bb/scripts`, then `pnpm exec turbo run test --filter=@bb/process-utils`.
Expected: green. On Linux and macOS the two real-Windows cases report as skipped and the fake-runner suites carry the coverage; on the reference desktop and the `windows-x64` CI job all three files run. `test/process-tree.test.ts` still skips on win32 and is untouched.

- [ ] **Step 9: Publish `ProcessWithCwd` through the plugin SDK**

`ProcessWithCwd` becomes an exported type in this task and it is the return element of the already-published `experimental_killProcessesWithCwdUnder`, so it is published with it rather than left inferred. In `packages/plugin-sdk/src/host.ts`, beside the existing `export type { SanitizeInheritedChildProcessEnvArgs as ExperimentalSanitizeInheritedChildProcessEnvArgs } from "@bb/process-utils";` (55), add:

```ts
export type { ProcessWithCwd as ExperimentalProcessWithCwd } from "@bb/process-utils";
```

Add `"ExperimentalProcessWithCwd"` to the `apiSymbols` list that already carries `"experimental_killProcessesWithCwdUnder"` in `packages/plugin-api-map/src/surfaces.ts` (799–802). Task 14 Step 14 writes the `docs/api_to_audit.md` prose for the win32 `approximateCwd` / `matchEvidence` fields this type now carries; this task only publishes the symbol.

Run: `pnpm exec turbo run typecheck --filter=@bb/plugin-sdk --filter=@bb/plugin-api-map`, then `pnpm exec turbo run test --filter=@bb/plugin-api-map`.
Expected: green; the surfaces test accepts the new symbol because it is exported from `@get-bb/plugin-sdk/host`.

- [ ] **Step 10: Format and commit**

```bash
pnpm exec oxfmt packages/process-utils/src/index.ts packages/process-utils/src/windows-process-snapshot.ts packages/process-utils/src/windows-process-stop.ts packages/process-utils/test/windows-process-snapshot.test.ts packages/process-utils/test/windows-process-stop.test.ts packages/process-utils/test/windows-process-real.test.ts packages/plugin-sdk/src/host.ts packages/plugin-api-map/src/surfaces.ts
git add packages/process-utils/src/index.ts packages/process-utils/src/windows-process-snapshot.ts packages/process-utils/src/windows-process-stop.ts packages/process-utils/test/windows-process-snapshot.test.ts packages/process-utils/test/windows-process-stop.test.ts packages/process-utils/test/windows-process-real.test.ts packages/plugin-sdk/src/host.ts packages/plugin-api-map/src/surfaces.ts
git commit -m "Terminate and sweep Windows process trees with creation-date identity checks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 3: One `Path` key in every child environment block

**Files:**

- Modify: `apps/host-daemon/src/command-dispatch.ts` (`providerCliEnvFromShellEnv` 115–120)
- Modify: `apps/host-daemon/src/command-dispatch.test.ts` (new `describe` at the end)
- Modify: `apps/host-daemon/src/protocol-self-update.ts` (`SelfUpdateProcessRunner` 41–47, `CreateProtocolSelfUpdaterOptions` 49–58, `defaultInstallTarball` 163–186, `createProtocolSelfUpdater` installer wiring 188–200)
- Modify: `apps/host-daemon/src/protocol-self-update.test.ts` (`createFixture` 25–73, new test after `finds npm beside the running Node executable when the service PATH omits it` at 171)
- Modify: `packages/local-open-targets/src/index.ts` (`WorkspaceOpenTargetRuntimeOptions` 66–68, `createWorkspaceOpenTargetRuntime` 509–517)
- Modify: `packages/local-open-targets/test/workspace-open-targets.test.ts` (`default workspace open-target runtime` describe at 13)
- Modify: `plugins/automations/src/script-runner.ts` (`executeStoredScript` 265–305)
- Modify: `plugins/automations/package.json` (dependencies)
- Modify: `pnpm-lock.yaml` (regenerated by `pnpm install` after the dependency is added)
- Modify: `plugins/automations/src/automations.test.ts` (`script process containment` describe at 1646)
- Modify: `docs/api_to_audit.md` (`Host process primitives` section, 2516–2528)

**Interfaces:**

- Consumes: `assignPathEnv` from `@bb/process-utils` (Task 1).
- Produces: `providerCliEnvFromShellEnv(shellEnv, platform?)` exported from `apps/host-daemon/src/command-dispatch.ts`; `CreateProtocolSelfUpdaterOptions.platform?`; `WorkspaceOpenTargetRuntimeOptions.platform?`; `executeStoredScript(args)` gains `platform?: NodeJS.Platform`. Every new parameter defaults to `process.platform`.

Three of the four sites have no injectable platform today, so each gains the minimal parameter: `providerCliEnvFromShellEnv` gains a second parameter and becomes exported (it is otherwise unreachable from `command-dispatch.test.ts`), `createProtocolSelfUpdater` gains an option that it threads into `defaultInstallTarball`, and `executeStoredScript` gains an argument. `createWorkspaceOpenTargetRuntime` already takes an options object and gains `platform?` there; that option feeds only `assignPathEnv` in this task — the runtime's own `platform` field stays `process.platform` and belongs to Task 11.

`plugins/automations` has no `@bb/process-utils` dependency yet. It already depends on the workspace package `@bb/domain`, so plugins may depend on workspace packages directly and the dependency is added to `plugins/automations/package.json`; no `@get-bb/plugin-sdk/host` re-export is needed for this task.

- [ ] **Step 1: Write the failing tests**

Append to `apps/host-daemon/src/command-dispatch.test.ts` (adding `providerCliEnvFromShellEnv` to the existing `./command-dispatch.js` import):

```ts
describe("providerCliEnvFromShellEnv", () => {
  it("keeps the inherited env when the shell env has no PATH", () => {
    expect(providerCliEnvFromShellEnv({}, "linux")).toBe(process.env);
  });

  it("sets PATH on posix and exactly one Path key on win32", () => {
    expect(
      providerCliEnvFromShellEnv({ PATH: "/opt/bin:/bin" }, "linux").PATH,
    ).toBe("/opt/bin:/bin");
    const windowsEnv = providerCliEnvFromShellEnv(
      { PATH: "C:\\tools;C:\\Windows\\System32" },
      "win32",
    );
    expect(
      Object.keys(windowsEnv).filter((key) => /^path$/iu.test(key)),
    ).toEqual(["Path"]);
    expect(windowsEnv.Path).toBe("C:\\tools;C:\\Windows\\System32");
  });
});
```

In `apps/host-daemon/src/protocol-self-update.test.ts`, add `platform?: NodeJS.Platform` to `createFixture`'s argument type, pass `...(args.platform !== undefined ? { platform: args.platform } : {})` into `createProtocolSelfUpdater`, and add:

```ts
it("hands the installer exactly one Path key on Windows", async () => {
  vi.stubEnv("PATH", "C:\\tools");
  const test = await createFixture({
    useDefaultInstaller: true,
    platform: "win32",
  });

  await expect(test.updater.handleProtocolMismatch()).resolves.toBe("updated");

  const options = test.runProcess.mock.calls[0]?.[2];
  const keys = Object.keys(options?.env ?? {}).filter((key) =>
    /^path$/iu.test(key),
  );
  expect(keys).toEqual(["Path"]);
  expect(options?.env.Path).toBe(
    `${dirname(process.execPath)}${delimiter}C:\\tools`,
  );
});
```

In `packages/local-open-targets/test/workspace-open-targets.test.ts`, inside `describe("default workspace open-target runtime", ...)`:

```ts
it("builds a single Path key for the shell PATH on Windows", () => {
  const runtime = createWorkspaceOpenTargetRuntime({
    shellPath: "C:\\Users\\test\\bin;C:\\Windows\\System32",
    platform: "win32",
  });

  expect(
    Object.keys(runtime.env ?? {}).filter((key) => /^path$/iu.test(key)),
  ).toEqual(["Path"]);
  expect(runtime.env?.Path).toBe("C:\\Users\\test\\bin;C:\\Windows\\System32");
});
```

In `plugins/automations/src/automations.test.ts`, inside `describe("script process containment", ...)`. The case is `it.runIf(process.platform === "win32")` because it really spawns the interpreter: with `platform: "win32"` the child env carries only a `Path` key, and a POSIX `execvp` that finds no `PATH` falls back to `confstr(_CS_PATH)` and fails to spawn a bare `node` that lives outside `/bin` or `/usr/bin`. The platform-neutral proof that the key collapses is Task 1's `assigns the child PATH per platform` unit test.

```ts
it.runIf(process.platform === "win32")(
  "gives the script exactly one Path key on Windows",
  async () => {
    const pluginDataDir = await mkdtemp(join(tmpdir(), "bb-auto-path-env-"));
    const scriptDir = automationScriptDir(pluginDataDir, "auto_path");
    await mkdir(scriptDir, { recursive: true });
    await writeFile(
      join(scriptDir, "script.mjs"),
      "process.stdout.write(JSON.stringify(Object.keys(process.env).filter((key) => /^path$/iu.test(key))));\n",
    );

    try {
      const result = await executeStoredScript({
        pluginDataDir,
        automationId: "auto_path",
        runId: "run_path",
        projectId: "proj_test",
        scriptFile: "script.mjs",
        interpreter: "node",
        timeoutMs: 10_000,
        serverUrl: "http://127.0.0.1:38886",
        platform: "win32",
      });
      expect(result.output.trim().endsWith('["Path"]')).toBe(true);
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  },
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/host-daemon exec vitest run src/command-dispatch.test.ts`, `pnpm --filter @bb/host-daemon exec vitest run src/protocol-self-update.test.ts`, `pnpm --filter @bb/local-open-targets exec vitest run test/workspace-open-targets.test.ts`, `pnpm --filter bb-plugin-automations exec vitest run src/automations.test.ts`.
Expected: FAIL — `providerCliEnvFromShellEnv` is not exported, `createProtocolSelfUpdater`/`createWorkspaceOpenTargetRuntime`/`executeStoredScript` reject `platform`, and on Windows the automations env assertion sees both `Path` and `PATH`. On POSIX the automations case reports as skipped and the other three files carry the failure.

- [ ] **Step 3: `apps/host-daemon/src/command-dispatch.ts`**

Add `assignPathEnv` to the existing `@bb/process-utils` import, then:

```diff
-function providerCliEnvFromShellEnv(
-  shellEnv: NodeJS.ProcessEnv,
-): NodeJS.ProcessEnv {
-  return shellEnv.PATH ? { ...process.env, PATH: shellEnv.PATH } : process.env;
-}
+export function providerCliEnvFromShellEnv(
+  shellEnv: NodeJS.ProcessEnv,
+  platform: NodeJS.Platform = process.platform,
+): NodeJS.ProcessEnv {
+  return shellEnv.PATH
+    ? assignPathEnv({ env: process.env, path: shellEnv.PATH, platform })
+    : process.env;
+}
```

The single call site at `command-dispatch.ts:223` stays `providerCliEnvFromShellEnv(options.runtimeManager.getShellEnv())` and picks up `process.platform`. The daemon's shell env keeps writing the `PATH` key inside its own object (`runtime-shell-env.ts:418`); Task 4 owns that file and does not change the key name.

- [ ] **Step 4: `apps/host-daemon/src/protocol-self-update.ts`**

Add `import { assignPathEnv } from "@bb/process-utils";` and:

```diff
 async function defaultInstallTarball(
   tarballPath: string,
   runProcess: SelfUpdateProcessRunner,
+  platform: NodeJS.Platform,
 ): Promise<void> {
```

```diff
   await runProcess(
     "npm",
     ["install", "-g", BB_APP_ALLOW_SCRIPTS_ARG, ...prefixArgs, tarballPath],
     {
-      env: { ...process.env, PATH: path },
+      env: assignPathEnv({ env: process.env, path, platform }),
     },
   );
 }
```

```diff
 interface CreateProtocolSelfUpdaterOptions {
   dataDir: string;
   enabled: boolean;
   logger: HostDaemonLogger;
   serverUrl: string;
   fetchFn?: FetchFn;
   installTarball?: ProtocolSelfUpdateInstaller;
+  platform?: NodeJS.Platform;
   runProcess?: SelfUpdateProcessRunner;
   now?: () => number;
 }
```

```diff
   const installTarball =
     options.installTarball ??
     ((tarballPath) =>
       defaultInstallTarball(
         tarballPath,
         options.runProcess ?? defaultRunProcess,
+        options.platform ?? process.platform,
       ));
```

- [ ] **Step 5: `packages/local-open-targets/src/index.ts`**

Add `assignPathEnv` to the existing `@bb/process-utils` import, then:

```diff
 export interface WorkspaceOpenTargetRuntimeOptions {
+  platform?: NodeJS.Platform;
   shellPath?: string;
 }
```

```diff
   const homeDirectory = os.homedir();
-  const env: NodeJS.ProcessEnv = {
-    ...process.env,
-    ...(options.shellPath !== undefined ? { PATH: options.shellPath } : {}),
-  };
+  const shellPath = options.shellPath;
+  const env: NodeJS.ProcessEnv =
+    shellPath === undefined
+      ? { ...process.env }
+      : assignPathEnv({
+          env: process.env,
+          path: shellPath,
+          platform: options.platform ?? process.platform,
+        });
```

With no `shellPath` the result is `{ ...process.env }`, byte-identical to today's spread; with one on POSIX it is `{ ...process.env, PATH: shellPath }`, also byte-identical. The runtime's `platform: process.platform` field below is untouched.

- [ ] **Step 6: `plugins/automations` — dependency and script env**

`plugins/automations/package.json` dependencies:

```diff
   "dependencies": {
     "@bb/shared-ui": "workspace:*",
+    "@bb/process-utils": "workspace:*",
     "@radix-ui/react-slot": "^1.3.0",
```

Run `pnpm install` after the edit.

`plugins/automations/src/script-runner.ts` — add `import { assignPathEnv } from "@bb/process-utils";` and:

```diff
 export async function executeStoredScript(args: {
   pluginDataDir: string;
   automationId: string;
   runId: string;
   projectId: string;
   scriptFile: string;
   interpreter?: AutomationScriptInterpreter;
   timeoutMs: number;
   env?: Record<string, string>;
+  platform?: NodeJS.Platform;
   serverUrl: string;
 }): Promise<ScriptRunResult> {
```

```diff
-  const scriptEnv: NodeJS.ProcessEnv = {
-    ...process.env,
-    ...(args.env ?? {}),
-    PATH: scriptPathEnv(bbPath, process.env.PATH),
-    BB_SERVER_URL: args.serverUrl,
-    BB_PROJECT_ID: args.projectId,
-    BB_AUTOMATION_ID: args.automationId,
-    BB_AUTOMATION_RUN_ID: args.runId,
-  };
+  const scriptEnv: NodeJS.ProcessEnv = assignPathEnv({
+    env: { ...process.env, ...(args.env ?? {}) },
+    path: scriptPathEnv(bbPath, process.env.PATH),
+    platform: args.platform ?? process.platform,
+  });
+  scriptEnv.BB_SERVER_URL = args.serverUrl;
+  scriptEnv.BB_PROJECT_ID = args.projectId;
+  scriptEnv.BB_AUTOMATION_ID = args.automationId;
+  scriptEnv.BB_AUTOMATION_RUN_ID = args.runId;
```

On POSIX the result is the same object: re-assigning a key that the `process.env` spread already introduced keeps its original insertion position, so both the values and the key order match today's literal.

- [ ] **Step 7: `docs/api_to_audit.md`**

In the `Host process primitives (@get-bb/plugin-sdk/host)` section, after `The unused public process-group kill and platform-check exports were removed.`:

```md
On `win32` with a `shellPath`, `experimental_sanitizeInheritedChildProcessEnv`
drops every case variant of the `PATH` key and returns exactly one `Path` entry,
because a Windows environment block carrying both `Path` and `PATH` hands the
child the stale value; POSIX output is unchanged and still uses `PATH`. The
optional `platform` argument on
`ExperimentalSanitizeInheritedChildProcessEnvArgs` exists for tests and defaults
to `process.platform`.
```

- [ ] **Step 8: Run the tests and the typechecks**

Run, in order: `pnpm install`; `pnpm --filter @bb/host-daemon exec vitest run src/command-dispatch.test.ts`; `pnpm --filter @bb/host-daemon exec vitest run src/protocol-self-update.test.ts`; `pnpm --filter @bb/local-open-targets exec vitest run test/workspace-open-targets.test.ts`; `pnpm --filter bb-plugin-automations exec vitest run src/automations.test.ts`; then `pnpm exec turbo run typecheck --filter=@bb/host-daemon --filter=@bb/local-open-targets --filter=bb-plugin-automations --filter=@bb/process-utils`; then `pnpm exec turbo run test --filter=@bb/local-open-targets --filter=bb-plugin-automations`.
Expected: green on POSIX and on Windows. `@bb/host-daemon` suites stay file-by-file (Global Constraints). If `["Path"]` is asserted but the automations child reports `["PATH"]` on a POSIX runner, the win32 arm of `assignPathEnv` was not reached — check that `platform: "win32"` actually flowed into `executeStoredScript`.

- [ ] **Step 9: Format and commit**

```bash
pnpm exec oxfmt apps/host-daemon/src/command-dispatch.ts apps/host-daemon/src/command-dispatch.test.ts apps/host-daemon/src/protocol-self-update.ts apps/host-daemon/src/protocol-self-update.test.ts packages/local-open-targets/src/index.ts packages/local-open-targets/test/workspace-open-targets.test.ts plugins/automations/src/script-runner.ts plugins/automations/src/automations.test.ts docs/api_to_audit.md
git add apps/host-daemon/src/command-dispatch.ts apps/host-daemon/src/command-dispatch.test.ts apps/host-daemon/src/protocol-self-update.ts apps/host-daemon/src/protocol-self-update.test.ts packages/local-open-targets/src/index.ts packages/local-open-targets/test/workspace-open-targets.test.ts plugins/automations/package.json plugins/automations/src/script-runner.ts plugins/automations/src/automations.test.ts docs/api_to_audit.md pnpm-lock.yaml
git commit -m "Build child env blocks with a single Path key on Windows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 4: Windows PATH resolution for the runtime shell env

**Files:**

- Modify: `apps/host-daemon/src/runtime-shell-env.ts` (new win32 helpers after `parsePathFromUserShellEnv`, a win32 branch at the top of `resolveUserShellPathWithPrevious`, `platform` threaded through the bb-executable helpers)
- Modify: `apps/host-daemon/src/runtime-shell-env.test.ts` (new `describe("resolveUserShellPath on Windows")` and `describe("readWindowsRegistryPath")`; existing POSIX tests untouched)
- Unchanged: `apps/host-daemon/src/start-host-daemon.ts` — the composition root keeps calling `createUserShellPathResolver()`, `resolveBbExecutablePathInDirectory(dir)`, `resolveLocalBbExecutablePath()` and `prepareRuntimeShellEnv({...})` without a `platform`, so every new parameter defaults to `process.platform` there.

**Interfaces:**

- Consumes from `@bb/process-utils` (Task 1): `resolveWindowsSystemToolPath(name, env)` for `reg.exe`, `resolvePowerShellExecutable(env)`, `spawnPortableOutputProcess` (with the new `platform` field, which makes `windowsHide` default to `true` on win32). `POWERSHELL_NONINTERACTIVE_ARGS` is deliberately **not** used here: R5's probe is `-NoLogo -Command <script>` because the whole point of the probe is to load the user's PowerShell profile, which `-NoProfile` would suppress.
- Produces:
  - `export async function readWindowsRegistryPath(args: { env: NodeJS.ProcessEnv; runCommand?: SpawnUserShellEnv }): Promise<string | null>`
  - `runCommand?: SpawnUserShellEnv` on `ResolveUserShellPathOptions` (the existing `SpawnUserShellEnv` shape — `{ command, args, env, timeoutMs }` → `{ error?, signal, status, stderr, stdout }` — is exactly what a `reg.exe query` needs, so no second runner type is introduced).
  - `resolveBbExecutablePathInDirectory(bbExecutableDirectory: string, platform?: NodeJS.Platform): string`
  - `PrepareRuntimeShellEnvOptions.platform?: NodeJS.Platform`, `ResolveLocalBbExecutablePathOptions.platform?: NodeJS.Platform`
  - internal `bbExecutableFileName(platform)` → `"bb.cmd"` on win32, `getDefaultCliExecutablePath(platform)` → `../../cli/bin/bb.cmd` on win32 (the file Task 8 creates).

- [ ] **Step 1: Write the failing tests**

In `apps/host-daemon/src/runtime-shell-env.test.ts`, extend the import list:

```ts
import {
  createUserShellPathResolver,
  prepareRuntimeShellEnv,
  readWindowsRegistryPath,
  resolveBbExecutablePathInDirectory,
  resolveLocalBbExecutablePath,
  resolveUserShellPath,
  type SpawnUserShellEnv,
  type SpawnUserShellEnvArgs,
  type UserShellEnvSpawnResult,
} from "./runtime-shell-env.js";
```

Add these helpers next to `createMarkedShellEnvOutput` (leave every existing helper and every existing test as it is):

```ts
const WINDOWS_MACHINE_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const WINDOWS_USER_KEY = "HKCU\\Environment";

const windowsProbeEnv: NodeJS.ProcessEnv = {
  Path: "C:\\Windows\\System32;C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  SystemRoot: "C:\\Windows",
  USERPROFILE: "C:\\Users\\me",
};

function createRegistryQueryOutput(
  key: string,
  type: "REG_SZ" | "REG_EXPAND_SZ",
  value: string,
): string {
  return ["", key, `    Path    ${type}    ${value}`, "", ""].join("\r\n");
}

function createWindowsProbeBlock(entries: [string, string][]): string[] {
  return [
    "__BB_SHELL_ENV_START__",
    ...entries.map(
      ([name, value]) =>
        `${name}=${Buffer.from(value, "utf8").toString("base64")}`,
    ),
    "__BB_SHELL_ENV_END__",
  ];
}

function createFakeRegistryCommand(
  respond: (args: SpawnUserShellEnvArgs) => UserShellEnvSpawnResult,
): FakeShellEnvSpawn {
  const calls: SpawnUserShellEnvArgs[] = [];
  return {
    calls,
    async spawn(spawnArgs) {
      calls.push(spawnArgs);
      return respond(spawnArgs);
    },
  };
}
```

Then append two new `describe` blocks at the end of the file:

```ts
describe("readWindowsRegistryPath", () => {
  it("joins the machine and user values and expands %VAR% references", async () => {
    const registry = createFakeRegistryCommand((args) =>
      createShellEnvSpawnResult({
        stdout:
          args.args[1] === WINDOWS_USER_KEY
            ? createRegistryQueryOutput(
                WINDOWS_USER_KEY,
                "REG_EXPAND_SZ",
                "%USERPROFILE%\\bin;;%NOT_SET%\\x",
              )
            : createRegistryQueryOutput(
                WINDOWS_MACHINE_KEY,
                "REG_SZ",
                "C:\\Windows\\System32;C:\\Windows",
              ),
      }),
    );

    await expect(
      readWindowsRegistryPath({
        env: windowsProbeEnv,
        runCommand: registry.spawn,
      }),
    ).resolves.toBe(
      "C:\\Windows\\System32;C:\\Windows;C:\\Users\\me\\bin;%NOT_SET%\\x",
    );
    expect(registry.calls.map((call) => call.args)).toEqual([
      ["query", WINDOWS_MACHINE_KEY, "/v", "Path"],
      ["query", WINDOWS_USER_KEY, "/v", "Path"],
    ]);
    expect(registry.calls[0]?.command).toBe("C:\\Windows\\System32\\reg.exe");
  });

  it("keeps the machine value when the user value is missing", async () => {
    const registry = createFakeRegistryCommand((args) =>
      args.args[1] === WINDOWS_USER_KEY
        ? createShellEnvSpawnResult({
            status: 1,
            stderr:
              "ERROR: The system was unable to find the specified registry key or value.",
          })
        : createShellEnvSpawnResult({
            stdout: createRegistryQueryOutput(
              WINDOWS_MACHINE_KEY,
              "REG_SZ",
              "C:\\Windows\\System32",
            ),
          }),
    );

    await expect(
      readWindowsRegistryPath({
        env: windowsProbeEnv,
        runCommand: registry.spawn,
      }),
    ).resolves.toBe("C:\\Windows\\System32");
  });

  it("returns null when neither key yields a Path row", async () => {
    const registry = createFakeRegistryCommand(() =>
      createShellEnvSpawnResult({
        stdout: [
          "",
          WINDOWS_USER_KEY,
          "    TEMP    REG_SZ    C:\\Temp",
          "",
        ].join("\r\n"),
      }),
    );

    await expect(
      readWindowsRegistryPath({
        env: windowsProbeEnv,
        runCommand: registry.spawn,
      }),
    ).resolves.toBeNull();
  });

  it.runIf(process.platform === "win32")(
    "reads the real machine and user PATH from the registry",
    async () => {
      const registryPath = await readWindowsRegistryPath({ env: process.env });
      expect(registryPath).not.toBeNull();
      expect(registryPath?.toLowerCase()).toContain("system32");
    },
  );
});

describe("resolveUserShellPath on Windows", () => {
  function registryAlways(value: string): FakeShellEnvSpawn {
    return createFakeRegistryCommand((args) =>
      args.args[1] === WINDOWS_USER_KEY
        ? createShellEnvSpawnResult({ status: 1 })
        : createShellEnvSpawnResult({
            stdout: createRegistryQueryOutput(
              WINDOWS_MACHINE_KEY,
              "REG_SZ",
              value,
            ),
          }),
    );
  }

  it("prefers the PowerShell profile probe over the registry", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createWindowsProbeBlock([
            ["USERNAME", "me"],
            ["Path", "C:\\profile\\bin;C:\\Windows"],
          ]).join("\r\n"),
        }),
      ],
    });
    const registry = registryAlways("C:\\registry\\bin");

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registry.spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\profile\\bin;C:\\Windows");

    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.command.toLowerCase()).toMatch(
      /(pwsh|powershell)\.exe$/u,
    );
    expect(probe.calls[0]?.args[0]).toBe("-NoLogo");
    expect(probe.calls[0]?.args[1]).toBe("-Command");
    expect(probe.calls[0]?.args[2]).toContain("Get-ChildItem Env:");
    expect(probe.calls[0]?.timeoutMs).toBe(8_000);
  });

  it("ignores a hostile profile that prints a fake marker pair first", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: [
            ...createWindowsProbeBlock([["Path", "C:\\evil"]]),
            "profile noise",
            ...createWindowsProbeBlock([["Path", "C:\\real\\bin"]]),
          ].join("\r\n"),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\real\\bin");
  });

  it("skips a corrupt base64 Path line and keeps scanning", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: [
            "__BB_SHELL_ENV_START__",
            "Path=**not base64**",
            `PATH=${Buffer.from("C:\\second\\bin", "utf8").toString("base64")}`,
            "__BB_SHELL_ENV_END__",
          ].join("\r\n"),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\second\\bin");
  });

  it("falls back to the registry when the probe fails", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({ status: 1, stderr: "profile exploded" }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\registry\\bin");
  });

  it("falls back to the inherited Path when the probe and the registry fail", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [createShellEnvSpawnResult({ status: 1 })],
    });
    const registry = createFakeRegistryCommand(() =>
      createShellEnvSpawnResult({ status: 1 }),
    );

    await expect(
      resolveUserShellPath({
        env: windowsProbeEnv,
        platform: "win32",
        runCommand: registry.spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\Windows\\System32;C:\\Windows");
  });

  it("ignores SHELL on Windows", async () => {
    const probe = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createWindowsProbeBlock([["Path", "C:\\profile\\bin"]]).join(
            "\r\n",
          ),
        }),
      ],
    });

    await expect(
      resolveUserShellPath({
        env: {
          ...windowsProbeEnv,
          SHELL: "C:\\Program Files\\Git\\bin\\bash.exe",
        },
        platform: "win32",
        runCommand: registryAlways("C:\\registry\\bin").spawn,
        spawnUserShellEnv: probe.spawn,
      }),
    ).resolves.toBe("C:\\profile\\bin");
    expect(probe.calls[0]?.args[0]).toBe("-NoLogo");
  });

  it("points BB_CLI at bb.cmd on win32", () => {
    expect(resolveBbExecutablePathInDirectory("/tmp/bb-bin", "win32")).toBe(
      path.resolve("/tmp/bb-bin", "bb.cmd"),
    );
    expect(resolveBbExecutablePathInDirectory("/tmp/bb-bin", "linux")).toBe(
      path.resolve("/tmp/bb-bin", "bb"),
    );
    expect(
      prepareRuntimeShellEnv({
        bbExecutableDirectory: "/tmp/bb-bin",
        inheritedPath: "C:\\Windows",
        platform: "win32",
        serverUrl: "http://127.0.0.1:3334",
      }).BB_CLI,
    ).toBe(path.resolve("/tmp/bb-bin", "bb.cmd"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/host-daemon exec vitest run src/runtime-shell-env.test.ts`.
Expected: FAIL — `readWindowsRegistryPath` is not exported (`readWindowsRegistryPath is not a function`), the already-exported `resolveBbExecutablePathInDirectory` rejects the second `platform` argument, `runCommand` and `platform` are not accepted by the option types, and every Windows `resolveUserShellPath` case resolves to `null` because the win32 arm still returns early.

- [ ] **Step 3: Add the win32 helpers to `runtime-shell-env.ts`**

Extend the imports at the top of `apps/host-daemon/src/runtime-shell-env.ts`:

```ts
import {
  resolvePowerShellExecutable,
  resolveWindowsSystemToolPath,
  spawnPortableOutputProcess,
} from "@bb/process-utils";
```

Add `runCommand` to the options interface (the other fields are unchanged):

```ts
interface ResolveUserShellPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: SpawnUserShellEnv;
  spawnUserShellEnv?: SpawnUserShellEnv;
  timeoutMs?: number;
}
```

Add the win32 constants beside `USER_SHELL_ENV_TIMEOUT_MS` (the POSIX constants stay exactly as they are):

```ts
const POWERSHELL_SHELL_ENV_COMMAND = [
  `Write-Output '${SHELL_ENV_START_MARKER}'`,
  "Get-ChildItem Env: | ForEach-Object { Write-Output ($_.Name + '=' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_.Value))) }",
  `Write-Output '${SHELL_ENV_END_MARKER}'`,
].join("; ");
const BASE64_VALUE_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
const REGISTRY_PATH_ROW_PATTERN = /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/iu;
const WINDOWS_MACHINE_ENVIRONMENT_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const WINDOWS_USER_ENVIRONMENT_KEY = "HKCU\\Environment";
const WINDOWS_REGISTRY_QUERY_TIMEOUT_MS = 5_000;
const WINDOWS_USER_SHELL_ENV_TIMEOUT_MS = 8_000;
```

Insert the new win32 block **after** `parsePathFromUserShellEnv` and **before** `resolveUserShellPath`:

```ts
function defaultSpawnWindowsCommand(
  args: SpawnUserShellEnvArgs,
): Promise<UserShellEnvSpawnResult> {
  return new Promise<UserShellEnvSpawnResult>((resolveSpawn) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    function settle(result: UserShellEnvSpawnResult): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      resolveSpawn(result);
    }

    let child: ReturnType<typeof spawnPortableOutputProcess>;
    try {
      child = spawnPortableOutputProcess({
        command: args.command,
        args: args.args,
        env: args.env,
        platform: "win32",
      });
    } catch (error) {
      settle({
        error: error instanceof Error ? error : new Error(String(error)),
        signal: null,
        status: null,
        stderr,
        stdout,
      });
      return;
    }

    timeout = setTimeout(() => {
      child.kill();
      settle({
        error: new Error(`Shell env probe timed out after ${args.timeoutMs}ms`),
        signal: null,
        status: null,
        stderr,
        stdout,
      });
    }, args.timeoutMs);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle({ error, signal: null, status: null, stderr, stdout });
    });
    child.on("close", (status, signal) => {
      settle({ signal, status, stderr, stdout });
    });
  });
}

function readWindowsEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function expandWindowsEnvReferences(
  value: string,
  env: NodeJS.ProcessEnv,
): string {
  return value.replace(/%([^%]+)%/gu, (match, name: string) => {
    return readWindowsEnvValue(env, name) ?? match;
  });
}

function parseRegistryPathRow(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(REGISTRY_PATH_ROW_PATTERN);
    if (match === null) {
      continue;
    }
    const value = match[1]?.trim() ?? "";
    return value.length > 0 ? value : null;
  }
  return null;
}

export async function readWindowsRegistryPath(args: {
  env: NodeJS.ProcessEnv;
  runCommand?: SpawnUserShellEnv;
}): Promise<string | null> {
  const runCommand = args.runCommand ?? defaultSpawnWindowsCommand;
  const regExecutablePath = resolveWindowsSystemToolPath("reg.exe", args.env);
  const values: string[] = [];
  for (const key of [
    WINDOWS_MACHINE_ENVIRONMENT_KEY,
    WINDOWS_USER_ENVIRONMENT_KEY,
  ]) {
    const result = await runCommand({
      command: regExecutablePath,
      args: ["query", key, "/v", "Path"],
      env: args.env,
      timeoutMs: WINDOWS_REGISTRY_QUERY_TIMEOUT_MS,
    });
    if (
      result.error !== undefined ||
      result.signal !== null ||
      result.status !== 0
    ) {
      continue;
    }
    const rawValue = parseRegistryPathRow(result.stdout);
    if (rawValue === null) {
      continue;
    }
    values.push(expandWindowsEnvReferences(rawValue, args.env));
  }

  const joined = values
    .flatMap((value) => value.split(";"))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(";");
  return joined.length > 0 ? joined : null;
}

function findLastMarkerIndex(lines: string[], marker: string): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() === marker) {
      return index;
    }
  }
  return -1;
}

function parseWindowsPathFromUserShellEnv(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/u);
  const startIndex = findLastMarkerIndex(lines, SHELL_ENV_START_MARKER);
  if (startIndex === -1) {
    return null;
  }
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trim() === SHELL_ENV_END_MARKER,
  );
  if (endIndex === -1) {
    return null;
  }

  for (const line of lines.slice(startIndex + 1, endIndex)) {
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (line.slice(0, separator).toLowerCase() !== "path") {
      continue;
    }
    const encoded = line.slice(separator + 1).trim();
    if (!BASE64_VALUE_PATTERN.test(encoded)) {
      continue;
    }
    const pathValue = Buffer.from(encoded, "base64").toString("utf8").trim();
    if (pathValue.length > 0) {
      return pathValue;
    }
  }
  return null;
}

async function resolveWindowsUserShellPath(
  options: ResolveUserShellPathOptions,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const registryPath = await readWindowsRegistryPath({
    env,
    ...(options.runCommand === undefined
      ? {}
      : { runCommand: options.runCommand }),
  });

  const spawnUserShellEnv =
    options.spawnUserShellEnv ?? defaultSpawnWindowsCommand;
  const probeResult = await spawnUserShellEnv({
    command: resolvePowerShellExecutable(env),
    args: ["-NoLogo", "-Command", POWERSHELL_SHELL_ENV_COMMAND],
    env,
    timeoutMs: options.timeoutMs ?? WINDOWS_USER_SHELL_ENV_TIMEOUT_MS,
  });
  const probedPath =
    probeResult.error === undefined &&
    probeResult.signal === null &&
    probeResult.status === 0
      ? parseWindowsPathFromUserShellEnv(probeResult.stdout)
      : null;
  if (probedPath !== null) {
    return probedPath;
  }
  if (registryPath !== null) {
    return registryPath;
  }

  const inheritedPath = readWindowsEnvValue(env, "Path")?.trim();
  return inheritedPath !== undefined && inheritedPath.length > 0
    ? inheritedPath
    : null;
}
```

- [ ] **Step 4: Branch into the win32 arm and thread `platform` through the bb-executable helpers**

In `resolveUserShellPathWithPrevious` insert the branch immediately after the `env` line; every line below it stays byte-identical (including the duplicated `options.platform ?? process.platform` argument, so the POSIX arm is untouched):

```ts
async function resolveUserShellPathWithPrevious(
  options: ResolveUserShellPathOptions,
  previousPath: string | null,
): Promise<string | null> {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) === "win32") {
    return resolveWindowsUserShellPath(options, env);
  }
  const shell = resolveUserShellCommand(
    env,
    options.platform ?? process.platform,
  );
  if (!shell) {
    return null;
  }
```

`resolveUserShellCommand` keeps its `if (platform === "win32") { return null; }` guard unchanged — the win32 branch above means the POSIX loop is never reached on Windows, and the guard stays as the belt-and-braces it already is.

Then replace the four bb-executable helpers (`getDefaultCliExecutablePath`, `resolveCliEntryPath`'s platform read, `resolveLocalBbExecutablePath`, `bbExecutableFileName`, `resolveBbExecutablePathInDirectory`, `prepareRuntimeShellEnv`):

```ts
interface ResolveLocalBbExecutablePathOptions {
  cliExecutablePath?: string;
  cliRuntimePath?: string;
  platform?: NodeJS.Platform;
}

interface PrepareRuntimeShellEnvOptions {
  bbExecutableDirectory: string;
  bbExecutablePath?: string;
  hostDaemonPort?: number;
  serverUrl: string;
  inheritedPath?: string;
  platform?: NodeJS.Platform;
}
```

```ts
function getDefaultCliExecutablePath(platform: NodeJS.Platform): string {
  return fileURLToPath(
    new URL(`../../cli/bin/${bbExecutableFileName(platform)}`, import.meta.url),
  );
}
```

In `resolveCliEntryPath`, take the platform as a parameter instead of reading it inline (the body is otherwise unchanged):

```ts
async function resolveCliEntryPath(
  cliExecutablePath: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const cliEntryPath = resolve(cliExecutablePath);

  try {
    const stats = await fs.stat(cliEntryPath);
    if (!stats.isFile()) {
      throw new Error(`Resolved bb CLI entry is not a file: ${cliEntryPath}`);
    }
    if (platform !== "win32") {
```

```ts
export async function resolveLocalBbExecutablePath(
  options: ResolveLocalBbExecutablePathOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const resolvedCliExecutablePath =
    options.cliExecutablePath ?? getDefaultCliExecutablePath(platform);
  const cliEntryPath = await resolveCliEntryPath(
    resolvedCliExecutablePath,
    platform,
  );
  const cliRuntimePath =
    options.cliRuntimePath ??
    (options.cliExecutablePath === undefined
      ? getDefaultCliRuntimePath()
      : undefined);
  if (cliRuntimePath !== undefined) {
    await requireCliRuntimePath(cliRuntimePath);
  }
  return cliEntryPath;
}

function bbExecutableFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "bb.cmd" : "bb";
}

export function resolveBbExecutablePathInDirectory(
  bbExecutableDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolve(bbExecutableDirectory, bbExecutableFileName(platform));
}
```

and in `prepareRuntimeShellEnv` only the default-path expression changes:

```ts
const bbExecutablePath =
  options.bbExecutablePath ??
  resolveBbExecutablePathInDirectory(
    options.bbExecutableDirectory,
    options.platform ?? process.platform,
  );
```

The existing `"skips the execute-bit check on win32"` test keeps passing: it stubs `process.platform` through `withPlatform`, and `options.platform ?? process.platform` reads the stub at call time.

- [ ] **Step 5: Run the tests, typecheck and format**

Run: `pnpm --filter @bb/host-daemon exec vitest run src/runtime-shell-env.test.ts`, then `pnpm exec turbo run typecheck --filter=@bb/host-daemon`, then `pnpm exec oxfmt apps/host-daemon/src/runtime-shell-env.ts apps/host-daemon/src/runtime-shell-env.test.ts`.
Expected: all green; the seven POSIX `resolveUserShellPath` tests and the five `prepareRuntimeShellEnv` tests are unchanged and still pass; on the reference desktop the `it.runIf(win32)` registry case also runs and reports a PATH containing `System32`.

- [ ] **Step 6: Commit**

```bash
git add apps/host-daemon/src/runtime-shell-env.ts apps/host-daemon/src/runtime-shell-env.test.ts
git commit -m "Resolve the user PATH on Windows from the registry and a PowerShell profile probe

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 5: PowerShell environment hooks on Windows

**Files:**

- Modify: `packages/domain/src/setup-script.ts` (two new constants; `packages/domain/src/index.ts:49` already re-exports the module with `export * from "./setup-script.js"`, so no index change is needed)
- Modify: `apps/host-daemon/src/environment-lifecycle-script.ts`
- Modify: `apps/host-daemon/src/environment-lifecycle-script.test.ts`
- Unchanged: `apps/host-daemon/src/command-handlers/environment-hook.ts` — it is the composition root for hooks and keeps calling `runSetupScript`/`runTeardownScript` without a `platform`, which defaults to `process.platform`.

**Interfaces:**

- Consumes from `@bb/process-utils` (Tasks 1–2): `resolvePowerShellExecutable(env)`, `POWERSHELL_NONINTERACTIVE_ARGS`, `terminateProcessTree({ child, graceMs, platform, onSkippedProcess })`, `type SkippedProcessEvent`, `supportsProcessGroups(platform?)`, `isProcessGroupAlive(child, platform?)`, `sanitizeInheritedChildProcessEnv({ env, shellPath?, platform? })`, `spawnPortableOutputProcess` with the new `platform` field. `spawnPortableOutputProcess` has no `windowsHide` field of its own; Task 1's `spawnPortableProcess` turns an undefined `windowsHide` into `true` when `platform === "win32"`, so passing `platform` is what gives the PowerShell child a hidden window.
- Consumes from `@bb/domain`: `WINDOWS_ENV_SETUP_SCRIPT_NAME`, `WINDOWS_ENV_TEARDOWN_SCRIPT_NAME`.
- Produces in `environment-lifecycle-script.ts`:
  - `export const WINDOWS_ENV_SETUP_SCRIPT_NAME = ".bb-env-setup.ps1"` / `WINDOWS_ENV_TEARDOWN_SCRIPT_NAME = ".bb-env-teardown.ps1"` in `@bb/domain`
  - `export interface ResolvedLifecycleScript { scriptPath: string; scriptName: string; posixOnly: boolean }`
  - `export async function resolveLifecycleScript(args: { kind: "setup" | "teardown"; platform?: NodeJS.Platform; workspacePath: string }): Promise<ResolvedLifecycleScript | null>`
  - `BuildLifecycleScriptCommandArgs` gains `env: NodeJS.ProcessEnv`; `buildTeardownScriptCommand` becomes exported and gets its own `builds the teardown command and refuses a POSIX teardown hook` case in the test file
  - `RunSetupScriptArgs` gains `platform?: NodeJS.Platform`

- [ ] **Step 1: Write the failing tests**

Replace the test file's import block and helper section, keep `describe("core environment scripts")` verbatim but gate it on POSIX (on win32 every one of those cases writes a `.sh` hook, which HEAD already fails on Windows — this is the "split so the `/bin/sh` assertions stay on POSIX" the Global Constraints allow, not a rewrite), and drop the old `"reports unsupported POSIX scripts on Windows for each hook"` case:

```ts
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryWindowsProcess } from "@bb/process-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSetupScriptCommand,
  buildTeardownScriptCommand,
  resolveLifecycleScript,
  runSetupScript,
  runTeardownScript,
} from "./environment-lifecycle-script.js";

const directories: string[] = [];
async function workspace(
  kind: "setup" | "teardown",
  script: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-core-hooks-"));
  directories.push(directory);
  await writeFile(join(directory, `.bb-env-${kind}.sh`), script);
  return directory;
}

async function powerShellWorkspace(
  kind: "setup" | "teardown",
  script: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-core-hooks-"));
  directories.push(directory);
  await writeFile(join(directory, `.bb-env-${kind}.ps1`), script);
  return directory;
}
```

Change the surviving suite header to:

```ts
describe.skipIf(process.platform === "win32")("core environment scripts", () => {
```

and delete the `"reports unsupported POSIX scripts on Windows for each hook"` test (its `vi.stubGlobal("process", …)` shim goes with it; `vi` stays imported for the `afterEach` restore calls).

Append the new suite:

```ts
describe("windows environment scripts", () => {
  it("fails setup when only the POSIX hook exists on Windows", async () => {
    const workspacePath = await workspace("setup", "exit 0\n");
    const output: string[] = [];

    await expect(
      runSetupScript({
        workspacePath,
        timeoutMs: 5_000,
        platform: "win32",
        onProgress: (entry) => output.push(entry.text),
      }),
    ).rejects.toThrow(
      ".bb-env-setup.sh is a POSIX shell script; on Windows bb runs .bb-env-setup.ps1 instead (pwsh.exe or powershell.exe)",
    );
    expect(output).toEqual([".bb-env-setup.sh failed"]);
  });

  it("reports a POSIX-only teardown on Windows without blocking removal", async () => {
    const workspacePath = await workspace("teardown", "exit 0\n");
    const output: string[] = [];

    await expect(
      runTeardownScript({
        workspacePath,
        timeoutMs: 5_000,
        platform: "win32",
        onProgress: (entry) => output.push(entry.text),
      }),
    ).resolves.toEqual({ ran: true });
    expect(output.join("\n")).toContain(
      ".bb-env-teardown.sh is a POSIX shell script; on Windows bb runs .bb-env-teardown.ps1 instead (pwsh.exe or powershell.exe)",
    );
  });

  it("prefers the PowerShell hook when both hooks exist", async () => {
    const workspacePath = await workspace("setup", "exit 0\n");
    await writeFile(join(workspacePath, ".bb-env-setup.ps1"), "exit 0\r\n");

    await expect(
      resolveLifecycleScript({
        kind: "setup",
        platform: "win32",
        workspacePath,
      }),
    ).resolves.toEqual({
      scriptPath: join(workspacePath, ".bb-env-setup.ps1"),
      scriptName: ".bb-env-setup.ps1",
      posixOnly: false,
    });
    await expect(
      resolveLifecycleScript({
        kind: "setup",
        platform: "linux",
        workspacePath,
      }),
    ).resolves.toEqual({
      scriptPath: join(workspacePath, ".bb-env-setup.sh"),
      scriptName: ".bb-env-setup.sh",
      posixOnly: false,
    });
  });

  it("builds a non-interactive PowerShell -File command", () => {
    const command = buildSetupScriptCommand({
      env: {
        Path: "C:\\Windows\\System32",
        ProgramFiles: "C:\\Program Files",
        SystemRoot: "C:\\Windows",
      },
      platform: "win32",
      scriptPath: "C:\\ws\\.bb-env-setup.ps1",
    });

    expect(command.command.toLowerCase()).toMatch(/(pwsh|powershell)\.exe$/u);
    expect(command.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\ws\\.bb-env-setup.ps1",
    ]);
    expect(command.text).toMatch(
      /^(pwsh|powershell) -File \.bb-env-setup\.ps1$/u,
    );
  });

  it("builds the teardown command and refuses a POSIX teardown hook", () => {
    const command = buildTeardownScriptCommand({
      env: {
        Path: "C:\\Windows\\System32",
        ProgramFiles: "C:\\Program Files",
        SystemRoot: "C:\\Windows",
      },
      platform: "win32",
      scriptPath: "C:\\ws\\.bb-env-teardown.ps1",
    });

    expect(command.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\ws\\.bb-env-teardown.ps1",
    ]);
    expect(command.text).toMatch(
      /^(pwsh|powershell) -File \.bb-env-teardown\.ps1$/u,
    );
    expect(() =>
      buildTeardownScriptCommand({
        env: { SystemRoot: "C:\\Windows" },
        platform: "win32",
        scriptPath: "C:\\ws\\.bb-env-teardown.sh",
      }),
    ).toThrow(
      ".bb-env-teardown.sh is a POSIX shell script; on Windows bb runs .bb-env-teardown.ps1 instead (pwsh.exe or powershell.exe)",
    );
  });

  it.runIf(process.platform === "win32")(
    "streams PowerShell hook output",
    async () => {
      const workspacePath = await powerShellWorkspace(
        "setup",
        [
          'Write-Output "first"',
          'Write-Output "second"',
          '[Console]::Error.WriteLine("third")',
          "exit 0",
          "",
        ].join("\r\n"),
      );
      const output: string[] = [];

      await expect(
        runSetupScript({
          workspacePath,
          timeoutMs: 60_000,
          onProgress: (entry) => {
            if (entry.type === "output") output.push(entry.text);
          },
        }),
      ).resolves.toMatchObject({ ran: true, exitCode: 0 });

      expect(output).toHaveLength(3);
      expect(output).toEqual(
        expect.arrayContaining(["first", "second", "third"]),
      );
      expect(output.indexOf("first")).toBeLessThan(output.indexOf("second"));
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "times out a sleeping PowerShell hook",
    async () => {
      const workspacePath = await powerShellWorkspace(
        "setup",
        "Start-Sleep -Seconds 30\r\n",
      );

      await expect(
        runSetupScript({ workspacePath, timeoutMs: 1_000 }),
      ).rejects.toThrow("timed out after 1000ms");
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "cancels a PowerShell hook and leaves no descendant",
    async () => {
      const workspacePath = await powerShellWorkspace(
        "setup",
        [
          `$child = Start-Process -FilePath '${process.execPath}' -ArgumentList '-e','setTimeout(() => {}, 60000)' -PassThru -WindowStyle Hidden`,
          'Write-Output ("child=" + $child.Id)',
          "Start-Sleep -Seconds 30",
          "",
        ].join("\r\n"),
      );
      const controller = new AbortController();
      const childPids: number[] = [];

      await expect(
        runSetupScript({
          workspacePath,
          timeoutMs: 60_000,
          signal: controller.signal,
          onProgress: (entry) => {
            const match = entry.text.match(/^child=(\d+)$/u);
            if (match?.[1] !== undefined) {
              childPids.push(Number(match[1]));
              controller.abort();
            }
          },
        }),
      ).rejects.toThrow("cancelled");

      expect(childPids).toHaveLength(1);
      await expect(queryWindowsProcess(childPids[0] ?? 0)).resolves.toBeNull();
    },
    120_000,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/host-daemon exec vitest run src/environment-lifecycle-script.test.ts`.
Expected: FAIL — `resolveLifecycleScript` is not exported, `platform` is not a valid `runSetupScript` argument, `buildSetupScriptCommand` rejects the `env` property and still throws `"POSIX shell setup scripts are not supported on Windows"`.

- [ ] **Step 3: Add the Windows hook names to `@bb/domain`**

`packages/domain/src/setup-script.ts` becomes:

```ts
export const DEFAULT_ENV_SETUP_SCRIPT_NAME = ".bb-env-setup.sh";
export const DEFAULT_ENV_TEARDOWN_SCRIPT_NAME = ".bb-env-teardown.sh";

export const WINDOWS_ENV_SETUP_SCRIPT_NAME = ".bb-env-setup.ps1";
export const WINDOWS_ENV_TEARDOWN_SCRIPT_NAME = ".bb-env-teardown.ps1";

export const WORKTREE_INCLUDE_FILE_NAME = ".worktreeinclude";
```

- [ ] **Step 4: Resolve and build the Windows hook command**

In `apps/host-daemon/src/environment-lifecycle-script.ts` extend the imports:

```ts
import {
  WINDOWS_ENV_SETUP_SCRIPT_NAME,
  WINDOWS_ENV_TEARDOWN_SCRIPT_NAME,
} from "@bb/domain";
import {
  isProcessGroupAlive,
  killProcessGroup,
  POWERSHELL_NONINTERACTIVE_ARGS,
  resolvePowerShellExecutable,
  sanitizeInheritedChildProcessEnv,
  spawnPortableOutputProcess,
  supportsProcessGroups,
  terminateProcessTree,
} from "@bb/process-utils";
```

Add `platform` to the public args and `env` to the command-builder args:

```ts
export interface RunSetupScriptArgs {
  workspacePath: string;
  timeoutMs: number;
  platform?: NodeJS.Platform;
  shellPath?: string;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

type RunTeardownScriptArgs = RunSetupScriptArgs;

interface BuildLifecycleScriptCommandArgs {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  scriptPath: string;
}

interface RunLifecycleScriptArgs extends RunSetupScriptArgs {
  kind: "setup" | "teardown";
}

const WINDOWS_LIFECYCLE_TERMINATE_GRACE_MS = 2_000;
```

(`RunLifecycleScriptArgs` loses `scriptName` — the name now comes from `resolveLifecycleScript`.)

Replace `buildSetupScriptCommand` / `buildTeardownScriptCommand` and add the resolution helpers:

```ts
function lifecycleScriptNames(kind: "setup" | "teardown"): {
  posix: string;
  windows: string;
} {
  return kind === "setup"
    ? {
        posix: DEFAULT_ENV_SETUP_SCRIPT_NAME,
        windows: WINDOWS_ENV_SETUP_SCRIPT_NAME,
      }
    : {
        posix: DEFAULT_ENV_TEARDOWN_SCRIPT_NAME,
        windows: WINDOWS_ENV_TEARDOWN_SCRIPT_NAME,
      };
}

function windowsPosixScriptMessage(kind: "setup" | "teardown"): string {
  const names = lifecycleScriptNames(kind);
  return `${names.posix} is a POSIX shell script; on Windows bb runs ${names.windows} instead (pwsh.exe or powershell.exe)`;
}

function buildPowerShellScriptCommand(
  args: BuildLifecycleScriptCommandArgs,
): LifecycleScriptCommand {
  const executablePath = resolvePowerShellExecutable(args.env);
  const executableName = path.win32
    .basename(executablePath)
    .replace(/\.exe$/iu, "");
  return {
    command: executablePath,
    args: [...POWERSHELL_NONINTERACTIVE_ARGS, "-File", args.scriptPath],
    text: `${executableName} -File ${path.win32.basename(args.scriptPath)}`,
  };
}

export function buildSetupScriptCommand(
  args: BuildLifecycleScriptCommandArgs,
): LifecycleScriptCommand {
  if (args.platform === "win32") {
    if (!args.scriptPath.toLowerCase().endsWith(".ps1")) {
      throw new WorkspaceError(
        "setup_script_failed",
        windowsPosixScriptMessage("setup"),
      );
    }
    return buildPowerShellScriptCommand(args);
  }

  return {
    command: "env",
    args: ["bash", args.scriptPath],
    text: `env bash ${DEFAULT_ENV_SETUP_SCRIPT_NAME}`,
  };
}

export function buildTeardownScriptCommand(
  args: BuildLifecycleScriptCommandArgs,
): LifecycleScriptCommand {
  if (args.platform === "win32") {
    if (!args.scriptPath.toLowerCase().endsWith(".ps1")) {
      throw new WorkspaceError(
        "setup_script_failed",
        windowsPosixScriptMessage("teardown"),
      );
    }
    return buildPowerShellScriptCommand(args);
  }

  return {
    command: "env",
    args: ["bash", args.scriptPath],
    text: `env bash ${DEFAULT_ENV_TEARDOWN_SCRIPT_NAME}`,
  };
}

export interface ResolvedLifecycleScript {
  scriptPath: string;
  scriptName: string;
  posixOnly: boolean;
}

export async function resolveLifecycleScript(args: {
  kind: "setup" | "teardown";
  platform?: NodeJS.Platform;
  workspacePath: string;
}): Promise<ResolvedLifecycleScript | null> {
  const names = lifecycleScriptNames(args.kind);
  if ((args.platform ?? process.platform) === "win32") {
    const windowsPath = await resolveLifecycleScriptPath(
      args.workspacePath,
      names.windows,
    );
    if (windowsPath !== null) {
      return {
        scriptPath: windowsPath,
        scriptName: names.windows,
        posixOnly: false,
      };
    }
    const posixPath = await resolveLifecycleScriptPath(
      args.workspacePath,
      names.posix,
    );
    return posixPath === null
      ? null
      : { scriptPath: posixPath, scriptName: names.posix, posixOnly: true };
  }

  const scriptPath = await resolveLifecycleScriptPath(
    args.workspacePath,
    names.posix,
  );
  return scriptPath === null
    ? null
    : { scriptPath, scriptName: names.posix, posixOnly: false };
}
```

`resolveLifecycleScriptPath(workspacePath, scriptName)` keeps its current body; it just moves above `resolveLifecycleScript` so it is declared before use.

- [ ] **Step 5: Run the resolved script and terminate its tree on Windows**

Replace the head of `runLifecycleScript` down to the `spawnPortableOutputProcess` call:

```ts
async function runLifecycleScript(
  args: RunLifecycleScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  throwIfProvisionAborted(args.signal);
  const platform = args.platform ?? process.platform;
  const resolved = await resolveLifecycleScript({
    kind: args.kind,
    platform,
    workspacePath: args.workspacePath,
  });
  if (resolved === null) {
    return { ran: false };
  }
  const { scriptName, scriptPath } = resolved;

  throwIfProvisionAborted(args.signal);
  const startedAt = Date.now();
  if (resolved.posixOnly) {
    emitStep({
      onProgress: args.onProgress,
      key: `${args.kind}-failed`,
      text: `${scriptName} failed`,
      status: "failed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
    throw new WorkspaceError(
      "setup_script_failed",
      windowsPosixScriptMessage(args.kind),
    );
  }

  const env = sanitizeInheritedChildProcessEnv({
    env: process.env,
    platform,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
  });
  const command =
    args.kind === "setup"
      ? buildSetupScriptCommand({ env, platform, scriptPath })
      : buildTeardownScriptCommand({ env, platform, scriptPath });
  emitStep({
    onProgress: args.onProgress,
    key: `${args.kind}-started`,
    text: `Running ${scriptName}`,
    status: "started",
    startedAt,
  });

  const { timeoutMs } = args;
  const child = spawnPortableOutputProcess({
    command: command.command,
    args: command.args,
    cwd: args.workspacePath,
    detached: supportsProcessGroups(platform),
    env,
    platform,
  });
```

On POSIX this is behaviour-identical: `sanitizeInheritedChildProcessEnv` only moves above the command build (neither call can throw on POSIX), `supportsProcessGroups(platform)` with `platform === process.platform` returns exactly what `supportsProcessGroups()` returned, and `scriptName` holds the same `.sh` name the old `args.scriptName` did.

Replace the kill wiring (the `timeout` / `abortLifecycleScript` block) with:

```ts
let terminationPromise: Promise<unknown> | null = null;

const terminateLifecycleScript = (): void => {
  if (platform !== "win32") {
    killProcessGroup({ child, signal: "SIGKILL" });
    return;
  }
  if (terminationPromise !== null) {
    return;
  }
  terminationPromise = terminateProcessTree({
    child,
    graceMs: WINDOWS_LIFECYCLE_TERMINATE_GRACE_MS,
    platform,
    onSkippedProcess: (event) => {
      emitOutput(
        args.onProgress,
        `${args.kind}-pid-reused-${String(event.pid)}`,
        `Left pid ${String(event.pid)} alone during cleanup: its process id was reused (recorded ${event.expectedCreationDate ?? "unknown"}, found ${event.observedCreationDate ?? "unknown"})`,
      );
    },
  }).catch(() => undefined);
};

const timeout = setTimeout(() => {
  timedOut = true;
  terminateLifecycleScript();
}, timeoutMs);
const abortLifecycleScript = () => {
  if (abortRequested) {
    return;
  }
  abortRequested = true;
  terminateLifecycleScript();
};
```

and the post-close wait:

```ts
if (abortRequested || timedOut) {
  if (terminationPromise !== null) await terminationPromise;
  while (isProcessGroupAlive(child, platform)) await delay(25);
}
```

`terminationPromise` is only ever set on win32, so POSIX still runs `killProcessGroup({ child, signal: "SIGKILL" })` followed by the same `while (isProcessGroupAlive(child)) await delay(25);` loop; `isProcessGroupAlive(child, platform)` with `platform === process.platform` is the same call it was. On win32 the loop condition is already `false`, so awaiting `terminationPromise` is what actually guarantees the descendants are gone before the hook rejects.

Finally the two entry points:

```ts
export function runSetupScript(
  args: RunSetupScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  return runLifecycleScript({ ...args, kind: "setup" });
}

export async function runTeardownScript(
  args: RunTeardownScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  const startedAt = Date.now();
  const teardownScriptName =
    (args.platform ?? process.platform) === "win32"
      ? WINDOWS_ENV_TEARDOWN_SCRIPT_NAME
      : DEFAULT_ENV_TEARDOWN_SCRIPT_NAME;
  let failureReported = false;
  const onProgress: ProgressCallback = (entry) => {
    if (entry.type === "step" && entry.key === "teardown-failed") {
      failureReported = true;
    }
    args.onProgress?.(entry);
  };
  try {
    return await runLifecycleScript({ ...args, onProgress, kind: "teardown" });
  } catch (error) {
    if (args.signal?.aborted) throw error;
    if (!failureReported) {
      emitStep({
        onProgress: args.onProgress,
        key: "teardown-failed",
        text: `${teardownScriptName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs: Date.now() - startedAt },
      });
    }
    emitOutput(
      args.onProgress,
      "teardown-error",
      error instanceof Error ? error.message : String(error),
    );
    return { ran: true };
  }
}
```

The two local `DEFAULT_ENV_*_SCRIPT_NAME` consts at the top of the file stay exactly where they are (they are re-exported from this module today), so the POSIX text `env bash .bb-env-setup.sh` and the `.bb-env-teardown.sh failed` step text are byte-identical on POSIX.

- [ ] **Step 6: Run the tests, typecheck and format**

Run: `pnpm --filter @bb/host-daemon exec vitest run src/environment-lifecycle-script.test.ts`, then `pnpm exec turbo run typecheck --filter=@bb/domain --filter=@bb/host-daemon --filter=@bb/server`, then `pnpm exec turbo run test --filter=@bb/domain`, then `pnpm exec oxfmt packages/domain/src/setup-script.ts apps/host-daemon/src/environment-lifecycle-script.ts apps/host-daemon/src/environment-lifecycle-script.test.ts`.
Expected: on POSIX the six kept `core environment scripts` cases plus the four injected-platform cases pass and the three `it.runIf(win32)` cases are skipped; on the reference desktop `core environment scripts` is skipped and all seven Windows cases pass, including a `queryWindowsProcess` that reports the node grandchild gone after cancellation. Pipe the run to a file (`… > /tmp/hooks.log 2>&1`) — the two real PowerShell cases take tens of seconds.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/setup-script.ts apps/host-daemon/src/environment-lifecycle-script.ts apps/host-daemon/src/environment-lifecycle-script.test.ts
git commit -m "Run PowerShell environment hooks on Windows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 6: Git without `/bin/sh` on Windows, worktree helpers and `gh`

**Files:**

- Modify: `packages/host-workspace/src/git.ts` (new `runGitOutputPipeline` after `runShellPipeline` at line 565; `detectLinkedWorktree` at lines 628-641; imports at lines 1-14)
- Modify: `packages/host-workspace/src/workspace.ts` (imports at lines 19-46, `Workspace` constructor at lines 522-529, private pipeline wrapper at lines 573-582, `detectSquashMerge` at lines 1217-1251)
- Modify: `packages/host-workspace/test/git.test.ts` (imports at lines 1-22, new `describe("runGitOutputPipeline")`, new fixture, new cases in `describe("detectGitRepoKind")`)
- Create: `packages/environment-provider-host/vitest.config.ts`
- Create: `packages/environment-provider-host/test/git.test.ts`
- Modify: `packages/environment-provider-host/package.json` (`scripts.test`, `devDependencies.vitest`)
- Modify: `packages/environment-provider-host/tsconfig.json` (`include`)
- Modify: `pnpm-lock.yaml` (regenerated by `pnpm install` after the devDependency is added)
- Modify: `plugins/environment-git-worktree/host.test.ts` (fixtures at lines 46, 64, 340)
- Modify: `plugins/github/server.ts` (imports at line 1, new `ghCandidatePaths`, `resolveGh` at lines 567-578)
- Modify: `plugins/github/server.test.ts` (import list, new `describe("gh discovery")`)

**Interfaces:**

- Consumes: `spawnPortablePipedProcess`, `PortableChildProcess` from `@bb/process-utils`. This task does not pass `platform` to either spawn: `runGitOutputPipeline` only ever runs when the caller already decided `platform === "win32"`, and the spawn's own default (`process.platform`) is the correct value on both the real Windows host and the POSIX parity test that compares it against `runShellPipeline`.
- Produces in `packages/host-workspace/src/git.ts`:
  - `runGitOutputPipeline(producerArgs: string[], consumerArgs: string[], options: RunShellPipelineOptions): Promise<GitCommandResult>`
  - `isLinkedWorktreeGitDir(gitDir: string, platform?: NodeJS.Platform): boolean`
  - `detectLinkedWorktree(cwd: string, options?: DetectLinkedWorktreeOptions): Promise<boolean>` where `DetectLinkedWorktreeOptions extends GitTimeoutOptions { platform?: NodeJS.Platform }`
- Produces in `packages/host-workspace/src/workspace.ts`: `WorkspaceOptions extends GitProcessOptions { platform?: NodeJS.Platform }`; `new Workspace(path, options?: WorkspaceOptions)`.
- Produces in `plugins/github/server.ts`: `ghCandidatePaths(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string[]`.
- Unchanged: `runShellPipeline`, `createShellPipelineTimedOutError`, `createShellPipelineCancelledError`, every POSIX error code, `findWorktreeForBranch`, `readEmptyTreeSha`.

- [ ] **Step 1: Write the failing git-layer tests**

In `packages/host-workspace/test/git.test.ts` extend the import block at lines 5-22 with `isLinkedWorktreeGitDir`, `parsePatchId` and `runGitOutputPipeline` (keep `runShellPipeline` and every existing name):

```ts
import {
  detectGitRepo,
  detectGitRepoKind,
  detectLinkedWorktree,
  fetchRemoteBranches,
  getCheckoutRef,
  getWorkspaceGitOperation,
  isLinkedWorktreeGitDir,
  parseNameStatusEntries,
  parseNumstatEntriesZ,
  parsePatchId,
  parsePorcelainEntries,
  readDefaultBranchRefs,
  readGitBlob,
  readGitRepositoryState,
  runGit,
  runGitOutputPipeline,
  runGitWithNullRecordLimit,
  runShellPipeline,
  summarizeNumstat,
} from "../src/git.js";
```

Add a two-commit fixture next to `initBareWorktreeLayout` (after line 123):

```ts
async function initPatchIdRepo() {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "bb-patch-id-"));
  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "changed\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Second commit"], { cwd: repoPath });
  return repoPath;
}
```

Add a new describe block immediately after `describe("runShellPipeline")` (after line 149), leaving that block untouched:

```ts
describe("runGitOutputPipeline", () => {
  it("pipes producer stdout into the consumer without a shell", async () => {
    const repoPath = await initEmptyRepo();

    const result = await runGitOutputPipeline(
      ["--version"],
      ["hash-object", "--stdin"],
      { cwd: repoPath },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("computes a stable patch id for a real diff", async () => {
    const repoPath = await initPatchIdRepo();

    const result = await runGitOutputPipeline(
      ["diff", "HEAD~1..HEAD"],
      ["patch-id", "--stable"],
      { cwd: repoPath },
    );

    expect(result.exitCode).toBe(0);
    expect(parsePatchId(result.stdout.split("\n")[0])).toMatch(
      /^[0-9a-f]{40}$/u,
    );
  });

  it.skipIf(process.platform === "win32")(
    "returns the same patch id as the POSIX shell pipeline",
    async () => {
      const repoPath = await initPatchIdRepo();

      const piped = await runGitOutputPipeline(
        ["diff", "HEAD~1..HEAD"],
        ["patch-id", "--stable"],
        { cwd: repoPath },
      );
      const shelled = await runShellPipeline(
        'git diff "$1".."$2" | git patch-id --stable',
        ["HEAD~1", "HEAD"],
        { cwd: repoPath },
      );

      expect(parsePatchId(piped.stdout.split("\n")[0])).toBe(
        parsePatchId(shelled.stdout.split("\n")[0]),
      );
    },
  );

  it("reports a producer failure as a non-zero exit when allowFailure is set", async () => {
    const repoPath = await initEmptyRepo();

    const result = await runGitOutputPipeline(
      ["rev-parse", "--verify", "refs/heads/does-not-exist"],
      ["patch-id", "--stable"],
      { cwd: repoPath, allowFailure: true },
    );

    expect(result.exitCode).not.toBe(0);
  });

  it("raises a shell pipeline failure when the producer fails", async () => {
    const repoPath = await initEmptyRepo();

    await expect(
      runGitOutputPipeline(
        ["rev-parse", "--verify", "refs/heads/does-not-exist"],
        ["patch-id", "--stable"],
        { cwd: repoPath },
      ),
    ).rejects.toMatchObject({
      code: "shell_pipeline_failed",
      name: "WorkspaceError",
    });
  });

  it("classifies pipeline timeouts as hard failures when allowFailure is true", async () => {
    const repoPath = await initEmptyRepo();

    await expect(
      runGitOutputPipeline(
        ["hash-object", "--stdin"],
        ["patch-id", "--stable"],
        { cwd: repoPath, allowFailure: true, timeoutMs: 50 },
      ),
    ).rejects.toMatchObject({
      code: "shell_pipeline_timeout",
      name: "WorkspaceError",
    });
  });

  it("classifies aborted pipelines as cancellations", async () => {
    const repoPath = await initEmptyRepo();
    const controller = new AbortController();

    const pending = runGitOutputPipeline(
      ["hash-object", "--stdin"],
      ["patch-id", "--stable"],
      { cwd: repoPath, signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "provision_cancelled",
      name: "WorkspaceError",
    });
  });
});
```

Add two cases to `describe("detectGitRepoKind")` after the existing `"tells a linked worktree apart from an ordinary checkout"` test (after line 259):

```ts
it("reads a backslash-separated git dir as a linked worktree only on win32", () => {
  const windowsGitDir = "C:\\Users\\me\\repo\\.bare\\worktrees\\feature-a";

  expect(isLinkedWorktreeGitDir(windowsGitDir, "win32")).toBe(true);
  expect(isLinkedWorktreeGitDir(windowsGitDir, "darwin")).toBe(false);
  expect(
    isLinkedWorktreeGitDir("/srv/repo/.bare/worktrees/feature-a", "win32"),
  ).toBe(true);
  expect(
    isLinkedWorktreeGitDir("/srv/repo/.bare/worktrees/feature-a", "darwin"),
  ).toBe(true);
  expect(isLinkedWorktreeGitDir("C:\\Users\\me\\repo\\.git", "win32")).toBe(
    false,
  );
});

it("keeps a real linked worktree detected under the win32 arm", async () => {
  const { worktreePath } = await initBareWorktreeLayout();
  const ordinaryCheckout = await initReadGitBlobRepo();

  await expect(
    detectLinkedWorktree(worktreePath, { platform: "win32" }),
  ).resolves.toBe(true);
  await expect(
    detectLinkedWorktree(ordinaryCheckout, { platform: "win32" }),
  ).resolves.toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/host-workspace exec vitest run test/git.test.ts`.
Expected: FAIL — `runGitOutputPipeline` and `isLinkedWorktreeGitDir` are not exported from `../src/git.js`, and `detectLinkedWorktree` rejects the `platform` option at typecheck.

- [ ] **Step 3: Implement `runGitOutputPipeline` and the worktree-marker helper**

In `packages/host-workspace/src/git.ts` extend the `@bb/process-utils` import at lines 10-14:

```ts
import {
  killProcessGroup,
  sanitizeInheritedChildProcessEnv,
  spawnPortablePipedProcess,
  supportsProcessGroups,
  type PortableChildProcess,
} from "@bb/process-utils";
```

Add the pipeline child outcome helper directly above `runShellPipeline` (before line 516):

```ts
interface PipelineChildOutcome {
  exitCode: number | null;
  error?: Error;
}

function waitForPipelineChildClose(
  child: PortableChildProcess,
): Promise<PipelineChildOutcome> {
  return new Promise((resolvePipelineChild) => {
    child.once("error", (error: Error) => {
      resolvePipelineChild({ exitCode: null, error });
    });
    child.once("close", (exitCode: number | null) => {
      resolvePipelineChild({ exitCode });
    });
  });
}
```

Add `runGitOutputPipeline` immediately after the closing brace of `runShellPipeline` (after line 565), leaving `runShellPipeline` byte-identical:

```ts
export async function runGitOutputPipeline(
  producerArgs: string[],
  consumerArgs: string[],
  options: RunShellPipelineOptions,
): Promise<GitCommandResult> {
  if (options.signal?.aborted) {
    throw createShellPipelineCancelledError(options.signal.reason);
  }
  const env = resolveGitProcessEnv({
    env: undefined,
    shellPath: options.shellPath,
  });
  const producer = spawnPortablePipedProcess({
    command: "git",
    args: producerArgs,
    cwd: options.cwd,
    env,
  });
  const consumer = spawnPortablePipedProcess({
    command: "git",
    args: consumerArgs,
    cwd: options.cwd,
    env,
  });
  producer.stdout.pipe(consumer.stdin);
  producer.stdout.on("error", () => {});
  consumer.stdin.on("error", () => {});

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  producer.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk));
  });
  consumer.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(Buffer.from(chunk));
  });
  consumer.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const killBoth = (): void => {
    producer.kill();
    consumer.kill();
  };
  options.signal?.addEventListener("abort", killBoth, { once: true });
  if (options.timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      timedOut = true;
      killBoth();
    }, options.timeoutMs);
  }

  try {
    const [producerOutcome, consumerOutcome] = await Promise.all([
      waitForPipelineChildClose(producer),
      waitForPipelineChildClose(consumer),
    ]);
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (options.signal?.aborted) {
      throw createShellPipelineCancelledError(options.signal.reason);
    }
    if (timedOut && options.timeoutMs !== undefined) {
      throw createShellPipelineTimedOutError(options.timeoutMs);
    }
    const producerFailed =
      producerOutcome.error !== undefined ||
      (producerOutcome.exitCode ?? 1) !== 0;
    const consumerFailed =
      consumerOutcome.error !== undefined ||
      (consumerOutcome.exitCode ?? 1) !== 0;
    if (producerFailed || consumerFailed) {
      if (options.allowFailure) {
        return {
          stdout,
          stderr,
          exitCode: producerFailed
            ? (producerOutcome.exitCode ?? 1)
            : (consumerOutcome.exitCode ?? 1),
        };
      }
      const trimmed = trimOutput(stderr);
      const detail = trimmed ? `: ${trimmed}` : "";
      throw new WorkspaceError(
        "shell_pipeline_failed",
        `shell pipeline failed${detail}`,
        { cause: producerOutcome.error ?? consumerOutcome.error },
      );
    }
    return { stdout, stderr, exitCode: consumerOutcome.exitCode ?? 0 };
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    options.signal?.removeEventListener("abort", killBoth);
  }
}
```

Replace `detectLinkedWorktree` (lines 628-641) with the marker helper plus the injected-platform wrapper; the POSIX return line is unchanged:

```ts
export interface DetectLinkedWorktreeOptions extends GitTimeoutOptions {
  platform?: NodeJS.Platform;
}

export function isLinkedWorktreeGitDir(
  gitDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    return gitDir.replace(/\\/gu, "/").includes("/worktrees/");
  }
  return gitDir.includes("/worktrees/");
}

export async function detectLinkedWorktree(
  cwd: string,
  options: DetectLinkedWorktreeOptions = {},
): Promise<boolean> {
  const { platform = process.platform, ...gitOptions } = options;
  const gitDirResult = await runGit(["rev-parse", "--git-dir"], {
    cwd,
    ...gitOptions,
    allowFailure: true,
  });
  if (gitDirResult.exitCode !== 0) {
    return false;
  }
  return isLinkedWorktreeGitDir(gitDirResult.stdout.trim(), platform);
}
```

- [ ] **Step 4: Route `detectSquashMerge` through the pipeline on win32**

In `packages/host-workspace/src/workspace.ts` add `runGitOutputPipeline` to the `./git.js` import block (next to `runShellPipeline` at line 43) and replace the class header at lines 522-529:

```ts
export interface WorkspaceOptions extends GitProcessOptions {
  platform?: NodeJS.Platform;
}

export class Workspace {
  readonly path: string;
  private readonly gitProcessOptions: GitProcessOptions;
  private readonly platform: NodeJS.Platform;

  constructor(path: string, options: WorkspaceOptions = {}) {
    const { platform = process.platform, ...gitProcessOptions } = options;
    this.path = path;
    this.gitProcessOptions = gitProcessOptions;
    this.platform = platform;
  }
```

Add a second private wrapper directly after the existing `runShellPipeline` wrapper (after line 582), leaving that wrapper untouched:

```ts
  private runGitOutputPipeline(
    producerArgs: string[],
    consumerArgs: string[],
    options: Parameters<typeof runGitOutputPipeline>[2],
  ): Promise<GitCommandResult> {
    return runGitOutputPipeline(producerArgs, consumerArgs, {
      ...options,
      ...this.gitProcessOptions,
    });
  }
```

Replace the two pipeline calls in `detectSquashMerge` (lines 1222-1226 and 1240-1244) with a platform switch whose POSIX arm is the existing call text verbatim:

```ts
const branchPatchIdResult =
  this.platform === "win32"
    ? await this.runGitOutputPipeline(
        ["diff", `${mergeBaseRef}..HEAD`],
        ["patch-id", "--stable"],
        { cwd: this.path, allowFailure: true, timeoutMs },
      )
    : await this.runShellPipeline(
        'git diff "$1".."$2" | git patch-id --stable',
        [mergeBaseRef, "HEAD"],
        { cwd: this.path, allowFailure: true, timeoutMs },
      );
```

```ts
const basePatchIdsResult =
  this.platform === "win32"
    ? await this.runGitOutputPipeline(
        [
          "log",
          "-p",
          "-n",
          "1000",
          "--format=commit %H",
          `${mergeBaseRef}..${mergeBaseBranch}`,
        ],
        ["patch-id", "--stable"],
        { cwd: this.path, allowFailure: true, timeoutMs },
      )
    : await this.runShellPipeline(
        'git log -p -n 1000 --format="commit %H" "$1".."$2" | git patch-id --stable',
        [mergeBaseRef, mergeBaseBranch],
        { cwd: this.path, allowFailure: true, timeoutMs },
      );
```

- [ ] **Step 5: Run the host-workspace tests**

Run: `pnpm --filter @bb/host-workspace exec vitest run test/git.test.ts`, then `pnpm exec turbo run typecheck --filter=@bb/host-workspace --filter=@bb/host-daemon --filter=@bb/server`.
Expected: green; on POSIX the parity case compares `runGitOutputPipeline` against `runShellPipeline` and both patch ids match, on win32 that one case is skipped and the rest run.

- [ ] **Step 6: Pin the porcelain worktree parse in `@bb/environment-provider-host`**

Create `packages/environment-provider-host/vitest.config.ts`:

```ts
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    testTimeout: 30_000,
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "bb-environment-provider-host",
      include: ["test/**/*.test.ts"],
    }),
  },
});
```

Add the script to `packages/environment-provider-host/package.json` `scripts`, next to `typecheck`:

```json
    "test": "vitest run --config vitest.config.ts"
```

The package has no test tooling today, so two more declarations go with it. Add `vitest` to `devDependencies` beside `@types/node`, matching the version every other test-bearing package pins:

```json
    "vitest": "^4.1.1"
```

and extend `packages/environment-provider-host/tsconfig.json`'s `include` from `["src"]` to cover the new directory, the way `@bb/host-workspace` does:

```json
  "include": ["src", "test"]
```

Without the `include` change `tsc --noEmit` never reads the new file and a type error in it would ship silently; without the devDependency `pnpm --filter bb-environment-provider-host exec vitest` resolves nothing. Re-run `pnpm install` after editing the manifest so `pnpm-lock.yaml` records the new devDependency.

Create `packages/environment-provider-host/test/git.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findWorktreeForBranch, runGit } from "../src/git.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function comparablePath(value: string): string {
  return process.platform === "win32"
    ? value.replace(/\\/gu, "/").toLowerCase()
    : value;
}

async function initWorktreeLayout() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-provider-host-"));
  tempDirs.push(root);
  const repoPath = path.join(root, "repo");
  await fs.mkdir(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  const worktreePath = path.join(root, "feature-a");
  await runGit(["worktree", "add", "-b", "feature-a", worktreePath], {
    cwd: repoPath,
  });
  return { repoPath, worktreePath };
}

describe("findWorktreeForBranch", () => {
  it("reads the porcelain worktree path this host's git prints", async () => {
    const { repoPath, worktreePath } = await initWorktreeLayout();
    const expected = await fs.realpath(worktreePath);

    const found = await findWorktreeForBranch(repoPath, "feature-a");

    expect(found).not.toBeNull();
    expect(found).not.toContain("\r");
    expect(comparablePath(found ?? "")).toBe(comparablePath(expected));
    if (process.platform === "win32") {
      expect(found ?? "").toMatch(/^[A-Za-z]:\//u);
    }
  });

  it("returns null for a branch with no worktree", async () => {
    const { repoPath } = await initWorktreeLayout();

    await expect(findWorktreeForBranch(repoPath, "main")).resolves.not.toBe(
      null,
    );
    await expect(
      findWorktreeForBranch(repoPath, "no-such-branch"),
    ).resolves.toBeNull();
  });
});
```

Run: `pnpm --filter bb-environment-provider-host exec vitest run test/git.test.ts`.
Expected: green on every OS; on win32 the first case pins that `git worktree list --porcelain` yields a `C:/`-shaped, CR-free path that `findWorktreeForBranch` returns unchanged (R16: the function itself needs no edit).

- [ ] **Step 7: Make the worktree plugin fixtures portable**

In `plugins/environment-git-worktree/host.test.ts` replace the `mkdir -p` shell-out at line 46:

```ts
await mkdir(sourcePath, { recursive: true });
await mkdir(dataDir, { recursive: true });
```

and at line 64:

```ts
await mkdir(originPath, { recursive: true });
await mkdir(dataDir, { recursive: true });
```

Replace the `sleep` fixture at line 340:

```ts
const lingering = spawn(
  process.execPath,
  ["-e", "setTimeout(() => {}, 300000)"],
  {
    cwd: created.path,
    detached: true,
    stdio: "ignore",
  },
);
```

Run: `pnpm --filter bb-plugin-environment-git-worktree exec vitest run host.test.ts`.
Expected: the `mkdir`/`sleep` `ENOENT` failures are gone; remaining failures, if any, are recorded for Task 13's gate with their actual messages (the phase-0/phase-1 QA docs never broke the 8 failures down).

- [ ] **Step 8: Write the failing `gh` discovery test**

In `plugins/github/server.test.ts` add `ghCandidatePaths` to the `./server` import list and append:

```ts
describe("gh discovery", () => {
  it("keeps the POSIX candidates and adds the Windows install locations", () => {
    expect(ghCandidatePaths("darwin", {})).toEqual([
      "gh",
      "/opt/homebrew/bin/gh",
      "/usr/local/bin/gh",
    ]);
    expect(ghCandidatePaths("linux", {})).toEqual([
      "gh",
      "/opt/homebrew/bin/gh",
      "/usr/local/bin/gh",
    ]);
    expect(
      ghCandidatePaths("win32", {
        ProgramFiles: "C:\\Program Files",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      }),
    ).toEqual([
      "gh",
      "C:\\Program Files\\GitHub CLI\\gh.exe",
      "C:\\Users\\me\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe",
    ]);
    expect(ghCandidatePaths("win32", {})).toEqual([
      "gh",
      "C:\\Program Files\\GitHub CLI\\gh.exe",
    ]);
  });
});
```

Run: `pnpm --filter bb-plugin-github exec vitest run server.test.ts`.
Expected: FAIL — `ghCandidatePaths` is not exported from `./server`.

- [ ] **Step 9: Add the Windows `gh` candidates**

In `plugins/github/server.ts` add `import path from "node:path";` to the imports at line 1-3 and add the exported helper at module scope, next to `parsePaginatedGhApi`:

```ts
export function ghCandidatePaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform !== "win32") {
    return ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
  }
  const candidates = [
    "gh",
    path.win32.join(
      env.ProgramFiles ?? "C:\\Program Files",
      "GitHub CLI",
      "gh.exe",
    ),
  ];
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(
      path.win32.join(localAppData, "Programs", "GitHub CLI", "gh.exe"),
    );
  }
  return candidates;
}
```

Replace the candidate literal inside `resolveGh` (line 573) with the helper; the rest of the function is unchanged:

```ts
async function resolveGh(): Promise<string> {
  if (ghPath !== null) return ghPath;
  const candidates = ghCandidatePaths();
  for (const candidate of candidates) {
    try {
      await run(candidate, ["--version"], 5_000);
      ghPath = candidate;
      return candidate;
    } catch {}
  }
  throw needsConfiguration(`GitHub CLI not found. ${GH_HINT}`);
}
```

- [ ] **Step 10: Run every touched suite and typecheck**

Run, in order:

- `pnpm --filter @bb/host-workspace exec vitest run test/git.test.ts`
- `pnpm --filter bb-environment-provider-host exec vitest run test/git.test.ts`
- `pnpm --filter bb-plugin-environment-git-worktree exec vitest run host.test.ts`
- `pnpm --filter bb-plugin-github exec vitest run server.test.ts`
- `pnpm exec turbo run typecheck --filter=@bb/host-workspace --filter=bb-environment-provider-host --filter=bb-plugin-environment-git-worktree --filter=bb-plugin-github --filter=@bb/host-daemon --filter=@bb/server`
- `pnpm exec turbo run test --filter=@bb/host-workspace --filter=bb-environment-provider-host --filter=bb-plugin-environment-git-worktree --filter=bb-plugin-github`

Expected: all green. The reference desktop additionally runs `bb` against a real repo with a `gh.exe` install and records the `resolveGh` hit in `qa/windows/phase-2/` — `resolveGh` itself lives inside the plugin's `BbPluginApi` closure, so only `ghCandidatePaths` is unit-tested and the live probe is a manual gate check.

- [ ] **Step 11: Format and commit**

```bash
pnpm exec oxfmt packages/host-workspace/src/git.ts packages/host-workspace/src/workspace.ts packages/host-workspace/test/git.test.ts packages/environment-provider-host/vitest.config.ts packages/environment-provider-host/test/git.test.ts plugins/environment-git-worktree/host.test.ts plugins/github/server.ts plugins/github/server.test.ts
git add packages/host-workspace/src/git.ts packages/host-workspace/src/workspace.ts packages/host-workspace/test/git.test.ts packages/environment-provider-host/package.json packages/environment-provider-host/tsconfig.json packages/environment-provider-host/vitest.config.ts packages/environment-provider-host/test/git.test.ts plugins/environment-git-worktree/host.test.ts plugins/github/server.ts plugins/github/server.test.ts pnpm-lock.yaml
git commit -m "Run git pipelines without a shell on Windows and find gh there

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 7: Automations on Windows

**Files:**

- Unchanged: `plugins/automations/package.json` and `pnpm-lock.yaml` — Task 3 Step 6 declares the `@bb/process-utils` dependency this task consumes
- Modify: `plugins/automations/src/rpc-types.ts` (`automationScriptInterpreterSchema`, lines 112-117)
- Modify: `plugins/automations/src/script-files.ts` (`INTERPRETER_BY_EXTENSION` line 17, `INTERPRETER_COMMAND` line 25, `resolveInterpreterCommand` line 54)
- Modify: `plugins/automations/src/script-runner.ts` (`commandWorks` line 25, `bbBinaryCandidates` line 34, `isExecutableFile` line 58, `resolveBbBinary` line 68, `scriptPathEnv` line 84, `executeWithProcessGroup` line 193, `executeStoredScript` line 265)
- Modify: `plugins/automations/src/cli.ts` (`parseScriptInterpreter` line 212, `INTERPRETER_BY_EXTENSION` line 223)
- Modify: `plugins/automations/src/automations.test.ts`
- Modify: `plugins/automations/skills/automations/SKILL.md`
- Modify: `plugins/automations/skills/automations/references/creation.md` (line 35)
- Modify: `plugins/automations/skills/automations/references/script-runtime.md`
- Modify: `packages/templates/src/templates/bb-guide-automations.md` (line 37)

**Interfaces:**

- Consumes from `@bb/process-utils` (Task 1) through a direct workspace dependency: `resolveExecutable`, `readNodeCmdShim`, `resolvePowerShellExecutable`, `POWERSHELL_NONINTERACTIVE_ARGS`, `resolveWindowsSystemToolPath`, `assignPathEnv`.
- Produces in `plugins/automations`: `automationScriptInterpreterSchema = z.enum(["bash", "sh", "node", "python3", "powershell"])`; `resolveInterpreterCommand(interpreter, platform?, env?): Promise<InterpreterCommand>` with `InterpreterCommand = { command: string; argsPrefix: string[] }`; `bbBinaryCandidates(env, platform?)`; `scriptPathEnv(bbPath, inheritedPath, platform?)`.
- Wire protocol: unchanged. The interpreter enum is a plugin RPC type, so `HOST_DAEMON_PROTOCOL_VERSION` stays 200.

- [ ] **Step 1: Write the failing automations tests**

In `plugins/automations/src/automations.test.ts` add `automationScriptInterpreterSchema` (from `./rpc-types.js`) and `resolveDefaultInterpreter`, `resolveInterpreterCommand` (from `./script-files.js`) to the import lists, then add:

```ts
describe("Windows automation interpreters", () => {
  it("accepts powershell in the interpreter schema", () => {
    expect(
      automationScriptInterpreterSchema.safeParse("powershell").success,
    ).toBe(true);
    expect(automationScriptInterpreterSchema.safeParse("cmd").success).toBe(
      false,
    );
  });

  it("maps .ps1 to the powershell interpreter and keeps the POSIX map", () => {
    expect(resolveDefaultInterpreter("watch.ps1")).toBe("powershell");
    expect(resolveDefaultInterpreter("watch.PS1")).toBe("powershell");
    expect(resolveDefaultInterpreter("watch.sh")).toBe("bash");
    expect(resolveDefaultInterpreter("watch.py")).toBe("python3");
    expect(resolveDefaultInterpreter("watch.unknown")).toBe("bash");
  });

  it("keeps the POSIX interpreter argv at command plus script", async () => {
    for (const interpreter of ["bash", "sh", "node", "python3"] as const) {
      await expect(
        resolveInterpreterCommand(interpreter, "darwin"),
      ).resolves.toEqual({ command: interpreter, argsPrefix: [] });
    }
    await expect(
      resolveInterpreterCommand("powershell", "darwin"),
    ).resolves.toEqual({
      command: "pwsh",
      argsPrefix: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
      ],
    });
  });

  it("resolves node to this runtime on win32", async () => {
    await expect(
      resolveInterpreterCommand("node", "win32", {}),
    ).resolves.toEqual({ command: process.execPath, argsPrefix: [] });
  });

  it("names Git for Windows when bash is absent on win32", async () => {
    await expect(
      resolveInterpreterCommand("bash", "win32", { Path: "", PATHEXT: ".EXE" }),
    ).rejects.toThrow(/Git for Windows/u);
  });

  it("adds bb.cmd and drops the Homebrew fallbacks on win32", () => {
    expect(
      bbBinaryCandidates({ BB_CLI_DIR: "C:\\tools", Path: "C:\\bin" }, "win32"),
    ).toEqual([
      "C:\\tools\\bb.cmd",
      "C:\\tools\\bb",
      "C:\\bin\\bb.cmd",
      "C:\\bin\\bb",
    ]);
    expect(
      bbBinaryCandidates({ PATH: "C:\\bin" }, "win32").some((candidate) =>
        candidate.startsWith("/opt/homebrew"),
      ),
    ).toBe(false);
    expect(
      bbBinaryCandidates({ BB_CLI: "C:\\tools\\bb.cmd" }, "win32")[0],
    ).toBe("C:\\tools\\bb.cmd");
  });
});
```

Change the three existing `bbBinaryCandidates` cases and the `scriptPathEnv` case in `describe("bb CLI injection for script runs")` to pass `"darwin"` explicitly; every expectation string stays exactly as it is today, for example:

```ts
expect(bbBinaryCandidates({ PATH: "/usr/bin:/opt/tools" }, "darwin")).toEqual([
  "/usr/bin/bb",
  "/opt/tools/bb",
  "/opt/homebrew/bin/bb",
  "/usr/local/bin/bb",
]);
```

```ts
expect(scriptPathEnv("/daemon/bundle/bb", "/usr/bin:/bin", "darwin")).toBe(
  "/daemon/bundle:/usr/bin:/bin",
);
```

Add the real-Windows script run at the end of the file:

```ts
describe("PowerShell automation scripts", () => {
  it.runIf(process.platform === "win32")(
    "runs a stored .ps1 script through PowerShell",
    async () => {
      const pluginDataDir = await mkdtemp(join(tmpdir(), "bb-auto-ps1-"));
      const scriptDir = automationScriptDir(pluginDataDir, "auto_ps1");
      await mkdir(scriptDir, { recursive: true });
      await writeFile(
        join(scriptDir, "script.ps1"),
        "Write-Output 'hello'\nexit 0\n",
      );

      try {
        const result = await executeStoredScript({
          pluginDataDir,
          automationId: "auto_ps1",
          runId: "run_ps1",
          projectId: "proj_test",
          scriptFile: "script.ps1",
          timeoutMs: 60_000,
          serverUrl: "http://127.0.0.1:38886",
        });

        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("hello");
      } finally {
        await rm(pluginDataDir, { recursive: true, force: true });
      }
    },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter bb-plugin-automations exec vitest run src/automations.test.ts`.
Expected: FAIL — the schema rejects `powershell`, `resolveDefaultInterpreter("watch.ps1")` returns `"bash"`, `resolveInterpreterCommand` returns a string rather than a plan, and `bbBinaryCandidates` takes one argument.

- [ ] **Step 3: Check the `@bb/process-utils` dependency Task 3 declared**

Plugins already depend on internal workspace packages directly (`plugins/automations` lists `@bb/domain`, `plugins/provider-claude-code` lists `@bb/provider-bridge-protocol`), so the Windows primitives are imported from `@bb/process-utils` without widening the plugin SDK. Task 3 Step 6 owns that declaration: it adds `"@bb/process-utils": "workspace:*"` to `plugins/automations/package.json` `dependencies` and commits the regenerated `pnpm-lock.yaml`. This task declares nothing and touches neither file.

Confirm the declaration is in place before importing anything:

```bash
grep -n '"@bb/process-utils"' plugins/automations/package.json
```

Expected: one `dependencies` line. If it is absent, Task 3 was not completed — stop and finish Task 3 rather than declaring the dependency here, so the manifest and the lockfile stay in one commit.

- [ ] **Step 4: Add the `powershell` interpreter and its command plan**

`plugins/automations/src/rpc-types.ts` lines 112-117:

```ts
export const automationScriptInterpreterSchema = z.enum([
  "bash",
  "sh",
  "node",
  "python3",
  "powershell",
]);
```

`plugins/automations/src/script-files.ts` — extend the two maps (lines 17-29) and replace `resolveInterpreterCommand` (lines 54-58):

```ts
const INTERPRETER_BY_EXTENSION: Record<string, AutomationScriptInterpreter> = {
  ".sh": "bash",
  ".bash": "bash",
  ".js": "node",
  ".mjs": "node",
  ".py": "python3",
  ".ps1": "powershell",
};

const INTERPRETER_COMMAND: Record<AutomationScriptInterpreter, string> = {
  bash: "bash",
  sh: "sh",
  node: "node",
  python3: "python3",
  powershell: "pwsh",
};
```

```ts
export interface InterpreterCommand {
  command: string;
  argsPrefix: string[];
}

const POWERSHELL_SCRIPT_ARGS = [...POWERSHELL_NONINTERACTIVE_ARGS, "-File"];

async function resolveWindowsInterpreterCommand(
  interpreter: AutomationScriptInterpreter,
  env: NodeJS.ProcessEnv,
): Promise<InterpreterCommand> {
  if (interpreter === "powershell") {
    return {
      command: resolvePowerShellExecutable(env),
      argsPrefix: [...POWERSHELL_SCRIPT_ARGS],
    };
  }
  if (interpreter === "node") {
    return { command: process.execPath, argsPrefix: [] };
  }
  const names =
    interpreter === "python3" ? ["python3", "python"] : [interpreter];
  for (const name of names) {
    const resolved = await resolveExecutable({
      command: name,
      env,
      platform: "win32",
    });
    if (resolved !== null) {
      return { command: resolved, argsPrefix: [] };
    }
  }
  if (interpreter === "python3") {
    throw new Error(
      "Automation interpreter python3 was not found on this Windows host. Install Python and put python.exe on Path, or use the node or powershell interpreter.",
    );
  }
  throw new Error(
    `Automation interpreter ${interpreter} was not found on this Windows host. Install Git for Windows so ${interpreter}.exe is on Path, or use the powershell or node interpreter.`,
  );
}

export async function resolveInterpreterCommand(
  interpreter: AutomationScriptInterpreter,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InterpreterCommand> {
  if (platform === "win32") {
    return resolveWindowsInterpreterCommand(interpreter, env);
  }
  if (interpreter === "powershell") {
    return {
      command: INTERPRETER_COMMAND[interpreter],
      argsPrefix: [...POWERSHELL_SCRIPT_ARGS],
    };
  }
  return { command: INTERPRETER_COMMAND[interpreter], argsPrefix: [] };
}
```

This carries one POSIX-visible change, ruled by R8 and called out here because the Global Constraints require a POSIX-visible change to be recorded rather than hidden: `.ps1` now maps to the `powershell` interpreter on every platform, so a macOS or Linux host that today runs a stored `watch.ps1` automation under `bash` (the `resolveDefaultInterpreter` fallback for an unknown extension) will run it under `pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File` instead, and will fail with a spawn error when PowerShell 7 is not installed. Nothing else about POSIX automations changes: an automation whose interpreter was stored explicitly keeps it, and every other extension keeps its current mapping. State this in the task report as the one deliberate POSIX behaviour change of Task 7, and confirm it is the wording Task 14 puts in `docs/platform-windows.md`.

Add the SDK import at the top of `script-files.ts`:

```ts
import {
  POWERSHELL_NONINTERACTIVE_ARGS,
  resolveExecutable,
  resolvePowerShellExecutable,
} from "@bb/process-utils";
```

- [ ] **Step 5: Discover `bb.cmd` and build the script env on win32**

In `plugins/automations/src/script-runner.ts` add the imports:

```ts
import { extname } from "node:path";
import {
  assignPathEnv,
  readNodeCmdShim,
  resolveExecutable,
  resolveWindowsSystemToolPath,
} from "@bb/process-utils";
```

and change `path` usage to the platform-selected implementation by importing the namespace:

```ts
import path, { delimiter, dirname, isAbsolute, join } from "node:path";
```

Replace `commandWorks` (lines 25-32):

```ts
async function resolveProbeSpawnPlan(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<{ command: string; argsPrefix: string[] }> {
  if (platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) {
    return { command, argsPrefix: [] };
  }
  const shim = await readNodeCmdShim(command);
  if (shim !== null) {
    return { command: shim.command, argsPrefix: shim.args };
  }
  return {
    command: resolveWindowsSystemToolPath("cmd.exe", env),
    argsPrefix: ["/d", "/c", command],
  };
}

async function commandWorks(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const plan = await resolveProbeSpawnPlan(command, platform, env);
    await execFileAsync(plan.command, [...plan.argsPrefix, ...args], {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}
```

Replace `bbBinaryCandidates` (lines 34-56):

```ts
function readPathValue(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32") {
    return env.PATH ?? "";
  }
  for (const [key, value] of Object.entries(env)) {
    if (/^path$/iu.test(key) && value !== undefined) {
      return value;
    }
  }
  return "";
}

export function bbBinaryCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const fileNames = platform === "win32" ? ["bb.cmd", "bb"] : ["bb"];
  const candidates: string[] = [];
  const pushIfAbsolute = (candidate: string): void => {
    if (pathImpl.isAbsolute(candidate)) {
      candidates.push(candidate);
    }
  };
  const fromCli = env.BB_CLI?.trim();
  if (fromCli !== undefined && fromCli.length > 0) {
    pushIfAbsolute(fromCli);
  }
  const fromCliDir = env.BB_CLI_DIR?.trim();
  if (fromCliDir !== undefined && fromCliDir.length > 0) {
    for (const fileName of fileNames) {
      pushIfAbsolute(pathImpl.join(fromCliDir, fileName));
    }
  }
  for (const entry of readPathValue(env, platform).split(pathDelimiter)) {
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      for (const fileName of fileNames) {
        pushIfAbsolute(pathImpl.join(trimmed, fileName));
      }
    }
  }
  if (platform !== "win32") {
    candidates.push("/opt/homebrew/bin/bb", "/usr/local/bin/bb");
  }
  return candidates;
}
```

Replace `isExecutableFile` and `resolveBbBinary` (lines 58-82):

```ts
async function isExecutableFile(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) return false;
    if (platform === "win32") {
      if (extname(candidate).length === 0) return false;
      return (
        (await resolveExecutable({
          command: candidate,
          env,
          platform,
        })) !== null
      );
    }
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBbBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (resolvedBbPath !== null) return resolvedBbPath;
  for (const candidate of bbBinaryCandidates(env, platform)) {
    if (!(await isExecutableFile(candidate, platform, env))) continue;
    if (await commandWorks(candidate, ["--version"], platform, env)) {
      resolvedBbPath = candidate;
      return candidate;
    }
  }
  return null;
}
```

Replace `scriptPathEnv` (lines 84-93):

```ts
export function scriptPathEnv(
  bbPath: string | null,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const basePath = inheritedPath ?? "";
  if (bbPath === null || !pathImpl.isAbsolute(bbPath)) {
    return basePath;
  }
  const bbDir = pathImpl.dirname(bbPath);
  return basePath.length > 0 ? `${bbDir}${pathDelimiter}${basePath}` : bbDir;
}
```

Change `executeWithProcessGroup` (line 193) to take the full argument list and drop the now-unused `dirname`/`isAbsolute`/`delimiter`/`join` imports that `path.win32`/`path.posix` replace:

```ts
function executeWithProcessGroup(args: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<ScriptRunResult> {
```

```ts
const child = spawn(args.command, args.args, {
  cwd: args.cwd,
  detached: process.platform !== "win32",
  env: args.env,
  stdio: ["ignore", "pipe", "pipe"],
});
```

Replace the tail of `executeStoredScript` (lines 281-300). Task 3 added `platform?: NodeJS.Platform` to this function's argument object and this task is what makes the field do something: every helper below it now takes the platform, so a `platform: "win32"` call resolves the Windows interpreter, the Windows `bb.cmd` candidates, the `;`-joined script PATH and the single `Path` key. Leaving any one of them on the ambient `process.platform` would make the field accepted-but-ignored and would regress Task 3's `platform: "win32"` test.

```ts
const platform = args.platform ?? process.platform;
const interpreter =
  args.interpreter ?? resolveDefaultInterpreter(args.scriptFile);
const { command, argsPrefix } = await resolveInterpreterCommand(
  interpreter,
  platform,
  process.env,
);
const bbPath = await resolveBbBinary(process.env, platform);
const warning = bbPath === null ? `${BB_NOT_INJECTED_WARNING}\n` : "";
const scriptEnv = assignPathEnv({
  env: {
    ...process.env,
    ...(args.env ?? {}),
    BB_SERVER_URL: args.serverUrl,
    BB_PROJECT_ID: args.projectId,
    BB_AUTOMATION_ID: args.automationId,
    BB_AUTOMATION_RUN_ID: args.runId,
  },
  path: scriptPathEnv(bbPath, process.env.PATH, platform),
  platform,
});
if (bbPath !== null) {
  scriptEnv.BB_CLI = bbPath;
}
const cwd = scriptsRoot(args.pluginDataDir);
await mkdir(cwd, { recursive: true });
const result = await executeWithProcessGroup({
  command,
  args: [...argsPrefix, scriptPath],
  cwd,
  timeoutMs: Math.min(args.timeoutMs, AUTOMATION_SCRIPT_TIMEOUT_MAX_MS),
  env: scriptEnv,
});
return { ...result, output: `${warning}${result.output}` };
```

- [ ] **Step 6: Update the CLI flag surface**

`plugins/automations/src/cli.ts` — the error at line 219 and the extension map at line 223:

```ts
throw new Error(
  "Invalid --interpreter. Expected bash, sh, node, python3, or powershell.",
);
```

```ts
const INTERPRETER_BY_EXTENSION: Record<string, AutomationScriptInterpreter> = {
  ".sh": "bash",
  ".bash": "bash",
  ".js": "node",
  ".mjs": "node",
  ".py": "python3",
  ".ps1": "powershell",
};
```

- [ ] **Step 7: Update the discoverable surfaces**

`plugins/automations/skills/automations/references/creation.md` line 35:

```text
--interpreter <name>           bash, sh, node, python3, or powershell
```

`packages/templates/src/templates/bb-guide-automations.md` line 37:

```text
  [--interpreter <bash|sh|node|python3|powershell>]
```

`plugins/automations/skills/automations/SKILL.md` — after the paragraph that begins "Design the script to print nothing…", add:

````md
The interpreter comes from the script file extension unless `--interpreter`
overrides it: `.sh`/`.bash` run under `bash`, `.js`/`.mjs` under `node`, `.py`
under `python3`, `.ps1` under `powershell`. On a Windows server use `.ps1`:

```bash
bb automation create --project <id> --name "Disk watch" --cron "0 * * * *" \
  --timezone UTC --script-file ./disk-watch.ps1 --interpreter powershell
```
````

A Windows server runs `powershell` scripts through `pwsh.exe` when it is
installed and Windows PowerShell 5.1 otherwise, `node` scripts through the
server's own Node runtime, and `bash`/`sh` scripts only when Git for Windows
puts `bash.exe` on `Path`.

`plugins/automations/skills/automations/references/script-runtime.md` — replace the "common macOS install paths" sentence in "Variables and CLI lookup":

```md
The plugin resolves `bb` from `BB_CLI`, `BB_CLI_DIR`, and `PATH`, plus the
common macOS install paths on macOS and Linux. On Windows it looks for `bb.cmd`
before `bb` in the same places and skips the macOS paths. It adds the selected
directory to `PATH`.
```

- [ ] **Step 8: Run the tests, typechecks and formatter**

Run:

- `pnpm exec turbo run build:types --filter=@get-bb/plugin-sdk`
- `pnpm --filter bb-plugin-automations exec vitest run src/automations.test.ts`
- `pnpm exec turbo run typecheck --filter=bb-plugin-automations --filter=@bb/templates`
- `pnpm exec turbo run test --filter=bb-plugin-automations --filter=@bb/templates`

Expected: green. On Windows the `it.runIf(win32)` case actually starts PowerShell and prints `hello`; on POSIX it is skipped and the injected-platform cases carry the coverage.

```bash
pnpm exec oxfmt plugins/automations/src/rpc-types.ts plugins/automations/src/script-files.ts plugins/automations/src/script-runner.ts plugins/automations/src/cli.ts plugins/automations/src/automations.test.ts plugins/automations/skills/automations/SKILL.md plugins/automations/skills/automations/references/creation.md plugins/automations/skills/automations/references/script-runtime.md packages/templates/src/templates/bb-guide-automations.md
```

- [ ] **Step 9: Commit**

```bash
git add plugins/automations/src/rpc-types.ts plugins/automations/src/script-files.ts plugins/automations/src/script-runner.ts plugins/automations/src/cli.ts plugins/automations/src/automations.test.ts plugins/automations/skills/automations/SKILL.md plugins/automations/skills/automations/references/creation.md plugins/automations/skills/automations/references/script-runtime.md packages/templates/src/templates/bb-guide-automations.md
git commit -m "Run automations through PowerShell and find bb.cmd on Windows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 8: `bb` launcher for PowerShell and cmd

**Files:**

- Unchanged: `apps/cli/bin/bb` and `apps/cli/bin/title` — both stay exactly the `#!/bin/sh` files they are today, byte for byte
- Create: `apps/cli/bin/bb.cmd`
- Create: `apps/cli/bin/title.cmd`
- Modify: `apps/cli/src/bb-cli-reexec.ts` (spawn plan before `spawnSync`)
- Modify: `apps/cli/src/index.ts` (line 13, `await` the re-exec)
- Modify: `apps/cli/package.json` (`@bb/process-utils` dependency)
- Modify: `apps/cli/src/__tests__/bb-cli-reexec.test.ts`
- Modify: `apps/cli/src/__tests__/bin.test.ts` (guard the POSIX describe, add a win32 describe)
- Modify: `apps/host-daemon/scripts/build-bundles.mjs` (copy block at lines 81-89)
- Modify: `packages/bb-app/scripts/build-host.mjs` (copy block at lines 77-95)
- Modify: `packages/bb-app/package.json` (`files`, `devDependencies`)
- Modify: `packages/bb-app/src/launcher.ts` (`requiredHostArtifactPaths` line 2086, `assertBbAppArtifacts`/`assertBbHostArtifacts` lines 2150-2172, `CreateServerEnvArgs`/`createServerEnv` line 2561, `RunBundledCliCommandArgs`/`runBundledCliCommand` line 2705)
- Modify: `packages/bb-app/test/index.test.ts`
- Modify: `pnpm-lock.yaml` (regenerated by `pnpm install` after the two dependencies are added)

**Interfaces:**

- Consumes from `@bb/process-utils` (Task 1): `readNodeCmdShim`, `resolvePowerShellExecutable`, `resolveWindowsSystemToolPath`.
- Produces in `packages/bb-app/src/launcher.ts`: `resolveBundledBbCliFileName(platform: NodeJS.Platform): string`, `resolveBundledBbCliPath(daemonBundleDir: string, platform: NodeJS.Platform): string`, `resolveBundledCliSpawnPlan(cliPath: string, platform: NodeJS.Platform): Promise<{ command: string; argsPrefix: string[] }>`.
- Produces in `apps/cli/src/bb-cli-reexec.ts`: `resolveNodeLauncherSpawnPlan(cliPath: string, platform: NodeJS.Platform): Promise<{ command: string; argsPrefix: string[] }>`; `maybeReexecViaBbCli` becomes `async`.
- Produces: `apps/cli/bin/bb.cmd`, `apps/cli/bin/title.cmd` (CRLF in the working tree through `.gitattributes` `*.cmd text eol=crlf`; LF in the object).
- Consumed by Task 4: `bbExecutableFileName(platform)` in `apps/host-daemon/src/runtime-shell-env.ts` returns `"bb.cmd"` on win32, and `getDefaultCliExecutablePath("win32")` points at `../../cli/bin/bb.cmd` — the file this task creates.
- Unchanged: `apps/cli/package.json` `bin`, `apps/cli/bin/bb`, `apps/cli/bin/title`.

The POSIX launcher is not touched. `apps/cli/bin/bb` keeps its `#!/bin/sh` body, including the single `exec node "$CLI_ENTRY" "$@"` that replaces the shell process rather than adding one, and `apps/cli/bin/title` keeps its two-line `printf` escape. Windows support is two new sibling files that POSIX never reads, so no POSIX invocation gains a process, changes signal delivery or gains a new message.

Both shims are plain CMD one-liners:

- `apps/cli/bin/bb.cmd` is `@node "%~dp0..\dist\index.js" %*` — it skips the `bin/bb` shell script entirely and runs the built entry, because `cmd.exe` cannot execute a `#!/bin/sh` file and the `cli:prepare` fallback in `bin/bb` is a POSIX developer convenience, not part of the Windows contract. A Windows checkout that has not been built gets `node`'s own "Cannot find module" on `dist\index.js`, which names the missing file.
- `apps/cli/bin/title.cmd` is `@title %*` — `title` is a `cmd.exe` built-in that sets the console title, and Windows Terminal keeps the title the shim set after the shim's `cmd.exe` exits, so the shim needs no Node hop at all.

`readNodeCmdShim` parses `@node "%~dp0..\dist\index.js" %*` into `{ command: process.execPath, args: ["<cli>/dist/index.js"] }` (the `%~dp0` prefix already ends in a separator, the captured `..\dist\index.js` splits into three segments and resolves against the shim's directory) and returns `null` for `@title %*`, which has no `node` in it. Nothing in bb ever spawns `title.cmd`.

Both packages therefore gain `@bb/process-utils`. `apps/cli` already lists ten `workspace:*` packages in `dependencies` and bundles them into `dist/index.js` with esbuild (`scripts/build-node-entry.mjs`, `bundle: true`, `conditions: ["source"]`), so the new entry goes in `dependencies` beside `@bb/config`. `packages/bb-app` is different and was checked: it declares `@bb/config` and `@bb/sdk` in **devDependencies**, not `dependencies`, because `scripts/build.mjs` runs every entry through `buildNodeEsmEntry` (`scripts/build-utils.mjs`, `bundle: true`, `conditions: ["source"]`, `external` limited to native modules), so workspace code is inlined into `dist/*.js` at build time and the published package ships only the real runtime dependencies (`better-sqlite3`, `node-pty`, `@parcel/watcher`, …). `@bb/process-utils` is pure TypeScript with one npm dependency (`cross-spawn`, itself bundled), so it follows `@bb/config`: `packages/bb-app/package.json` `devDependencies`.

- [ ] **Step 1: Write the failing launcher tests**

In `apps/cli/src/__tests__/bb-cli-reexec.test.ts` add `resolveNodeLauncherSpawnPlan` to the import from `../bb-cli-reexec.js` and append:

```ts
describe("resolveNodeLauncherSpawnPlan", () => {
  let planRoot: string;

  beforeEach(async () => {
    planRoot = await mkdtemp(join(tmpdir(), "bb-cli-plan-"));
  });

  afterEach(async () => {
    await rm(planRoot, { recursive: true, force: true });
  });

  it("spawns a POSIX launcher directly", async () => {
    await expect(
      resolveNodeLauncherSpawnPlan("/opt/bb/bin/bb", "darwin"),
    ).resolves.toEqual({ command: "/opt/bb/bin/bb", argsPrefix: [] });
    await expect(
      resolveNodeLauncherSpawnPlan("/opt/bb/bin/bb.cmd", "darwin"),
    ).resolves.toEqual({ command: "/opt/bb/bin/bb.cmd", argsPrefix: [] });
  });

  it("reads the node shim of a Windows .cmd launcher", async () => {
    const script = join(planRoot, "bb");
    await writeFile(script, "");
    await writeFile(join(planRoot, "bb.cmd"), '@node "%~dp0bb" %*\r\n');
    await writeFile(join(planRoot, "bb.CMD"), '@node "%~dp0bb" %*\r\n');

    await expect(
      resolveNodeLauncherSpawnPlan(join(planRoot, "bb.cmd"), "win32"),
    ).resolves.toEqual({ command: process.execPath, argsPrefix: [script] });
    await expect(
      resolveNodeLauncherSpawnPlan(join(planRoot, "bb.CMD"), "win32"),
    ).resolves.toEqual({ command: process.execPath, argsPrefix: [script] });
  });

  it("refuses a Windows .cmd launcher that is not a node shim", async () => {
    const shimPath = join(planRoot, "bb.cmd");
    await writeFile(shimPath, "@echo off\r\nstart notepad.exe\r\n");
    await expect(
      resolveNodeLauncherSpawnPlan(shimPath, "win32"),
    ).rejects.toThrow(
      `Windows launcher ${shimPath} is not a Node shim bb can start directly`,
    );
    const missingPath = join(planRoot, "absent.cmd");
    await expect(
      resolveNodeLauncherSpawnPlan(missingPath, "win32"),
    ).rejects.toThrow(
      `Windows launcher ${missingPath} is not a Node shim bb can start directly`,
    );
  });

  it("spawns a non-shim Windows target directly", async () => {
    await expect(
      resolveNodeLauncherSpawnPlan("C:\\tools\\bb.exe", "win32"),
    ).resolves.toEqual({ command: "C:\\tools\\bb.exe", argsPrefix: [] });
  });
});
```

In `packages/bb-app/test/index.test.ts` add `resolveBundledBbCliFileName`, `resolveBundledBbCliPath` and `resolveBundledCliSpawnPlan` to the launcher import list and append inside the same top-level describe:

```ts
it("names and spawns the bundled bb launcher per platform", async () => {
  expect(resolveBundledBbCliFileName("darwin")).toBe("bb");
  expect(resolveBundledBbCliFileName("win32")).toBe("bb.cmd");
  expect(resolveBundledBbCliPath("/tmp/bundle", "linux")).toBe(
    join("/tmp/bundle", "bb"),
  );

  const bundleDir = mkdtempSync(join(tmpdir(), "bb-app-cli-plan-"));
  try {
    const cmdPath = join(bundleDir, "bb.cmd");
    writeFileSync(cmdPath, "@echo off\r\n");
    await expect(resolveBundledCliSpawnPlan(cmdPath, "win32")).rejects.toThrow(
      `Windows launcher ${cmdPath} is not a Node shim bb can start directly`,
    );
    writeFileSync(join(bundleDir, "bb"), "");
    writeFileSync(cmdPath, '@node "%~dp0bb" %*\r\n');
    await expect(resolveBundledCliSpawnPlan(cmdPath, "win32")).resolves.toEqual(
      {
        command: process.execPath,
        argsPrefix: [join(bundleDir, "bb")],
      },
    );
    await expect(
      resolveBundledCliSpawnPlan(join(bundleDir, "bb"), "darwin"),
    ).resolves.toEqual({ command: join(bundleDir, "bb"), argsPrefix: [] });
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
});

it("requires both bb launcher files and points BB_CLI at bb.cmd on win32", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "bb-app-win-artifacts-"));
  try {
    const context = resolveBbAppStartContext({
      entrypointUrl: pathToFileURL(join(packageRoot, "dist", "bb.js")).href,
      env: {},
      homeDir: join(packageRoot, "home"),
    });
    for (const artifact of [
      context.daemonEntry,
      join(context.daemonBundleDir, "bb"),
      join(context.daemonBundleDir, "bb-provider-bridge-worker.mjs"),
      join(context.daemonBundleDir, "bb-parcel-watcher-child.mjs"),
      join(context.daemonBundleDir, "bb-plugin-host-worker.mjs"),
    ]) {
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(artifact, "");
    }
    const chunkDir = join(context.daemonBundleDir, "bb-chunks");
    mkdirSync(chunkDir, { recursive: true });
    writeFileSync(join(chunkDir, "chunk-AAAAAAAA.js"), "");

    expect(() => assertBbHostArtifacts(context, "linux")).not.toThrow();
    expect(() => assertBbHostArtifacts(context, "win32")).toThrow(
      /Missing bundled bb CLI launcher/u,
    );

    writeFileSync(join(context.daemonBundleDir, "bb.cmd"), "");
    expect(() => assertBbHostArtifacts(context, "win32")).not.toThrow();

    expect(
      createServerEnv({ context, env: {}, platform: "win32" }).BB_CLI,
    ).toBe(join(context.daemonBundleDir, "bb.cmd"));
    expect(
      createServerEnv({ context, env: {}, platform: "linux" }).BB_CLI,
    ).toBe(join(context.daemonBundleDir, "bb"));
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});
```

Extend the packaging assertion in `"limits npm package metadata to documented runtimes"`:

```ts
expect(metadata.files).toContain("host-daemon/dist/bb.cmd");
```

In `apps/cli/src/__tests__/bin.test.ts` change the existing block header at line 25 so its `#!/bin/sh` pnpm fixtures stay on POSIX, leaving both test bodies untouched:

```ts
describe.skipIf(process.platform === "win32")("bb bin wrapper", () => {
```

and append a Windows block at the end of the file. `copyFile`, `mkdir`, `mkdtemp`, `rm` and `writeFile` are already imported from `node:fs/promises` in this file; add `resolvePowerShellExecutable` and `resolveWindowsSystemToolPath` from `@bb/process-utils` to the import block:

```ts
describe.runIf(process.platform === "win32")("bb cmd shim", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bb-cli-cmd-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function createLauncher(installName: string): Promise<string> {
    const installRoot = join(tempRoot, installName);
    const binDir = join(installRoot, "bin");
    const distDir = join(installRoot, "dist");
    await mkdir(binDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await copyFile(
      join(repoRoot, "apps", "cli", "bin", "bb.cmd"),
      join(binDir, "bb.cmd"),
    );
    await writeFile(
      join(distDir, "index.js"),
      "process.stdout.write(`bb-launcher-ok ${process.argv.slice(2).join(' ')}`);\n",
    );
    return join(binDir, "bb.cmd");
  }

  it("runs from cmd.exe", async () => {
    const launcher = await createLauncher("bb-launcher");
    const { stdout } = await execFileAsync(
      resolveWindowsSystemToolPath("cmd.exe"),
      ["/d", "/c", launcher, "--version"],
    );
    expect(stdout).toBe("bb-launcher-ok --version");
  });

  it("runs from PowerShell when the install path has a space", async () => {
    const launcher = await createLauncher("bb launcher dir");
    const { stdout } = await execFileAsync(resolvePowerShellExecutable(), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `& '${launcher}' --version`,
    ]);
    expect(stdout.trim()).toBe("bb-launcher-ok --version");
  });
});
```

`resolvePowerShellExecutable()` returns `pwsh.exe` when PowerShell 7 is on `Path` and Windows PowerShell 5.1 otherwise, so the case covers the reference desktop's `pwsh` and a bare Windows host with the same code. Both launchers are temp copies of the repo's own `bin/bb.cmd` next to a stub `dist/index.js` that echoes its arguments, which is what proves the shim's `%~dp0..\dist\index.js` target, its `%*` forwarding and the quoting of a path with a space. Task 15 Step 9 runs the same two shells against the real built CLI.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/cli exec vitest run src/__tests__/bb-cli-reexec.test.ts src/__tests__/bin.test.ts` and `pnpm --filter bb-app exec vitest run test/index.test.ts`.
Expected: FAIL — `resolveNodeLauncherSpawnPlan`, `resolveBundledCliSpawnPlan`, `resolveBundledBbCliFileName`, `resolveBundledBbCliPath` do not exist, `assertBbHostArtifacts`/`createServerEnv` take no platform, `apps/cli/bin/bb.cmd` is missing, and `host-daemon/dist/bb.cmd` is not in `files`. The existing `maybeReexecViaBbCli` cases keep passing throughout: they all take a branch that returns before the spawn plan is resolved.

- [ ] **Step 3: Add the two `.cmd` shims**

`apps/cli/bin/bb` and `apps/cli/bin/title` are not edited. Confirm that before moving on:

```bash
git diff --stat apps/cli/bin/bb apps/cli/bin/title
```

Expected: no output.

Create `apps/cli/bin/bb.cmd` (one line, CRLF, no trailing blank line):

```
@node "%~dp0..\dist\index.js" %*
```

Create `apps/cli/bin/title.cmd` (one line, CRLF, no trailing blank line):

```
@title %*
```

`title` is a `cmd.exe` built-in, so `title.cmd` needs no interpreter: `cmd.exe` sets the console title and Windows Terminal keeps it after the shim's `cmd.exe` exits. Writing the shim as `@node "%~dp0title" %*` instead would hand the escape sequence to a `#!/bin/sh` file that Node cannot parse.

Both files are `100644` (no execute bit; Windows does not use one and `git update-index --chmod=+x` would be wrong here). `.gitattributes` already carries `*.cmd text eol=crlf`, so the working-tree copies are CRLF and the blobs are LF. Verify after writing them:

```bash
git check-attr text eol -- apps/cli/bin/bb.cmd apps/cli/bin/title.cmd
node -e "process.stdout.write(JSON.stringify(require('node:fs').readFileSync('apps/cli/bin/bb.cmd','utf8')))"
```

Expected: `eol: crlf` for both, and the second command prints a string ending in `\r\n`.

- [ ] **Step 4: Add the re-exec spawn plan**

Add `"@bb/process-utils": "workspace:*"` to `apps/cli/package.json` `dependencies` (alphabetical, between `@bb/plugin-build` and `@bb/sdk`) and run `pnpm install`.

In `apps/cli/src/bb-cli-reexec.ts` add the import and the helper above `maybeReexecViaBbCli`:

```ts
import { readNodeCmdShim } from "@bb/process-utils";
```

```ts
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat"]);

export interface NodeLauncherSpawnPlan {
  command: string;
  argsPrefix: string[];
}

export async function resolveNodeLauncherSpawnPlan(
  cliPath: string,
  platform: NodeJS.Platform,
): Promise<NodeLauncherSpawnPlan> {
  const extension = extname(cliPath).toLowerCase();
  if (platform !== "win32" || !WINDOWS_SHIM_EXTENSIONS.has(extension)) {
    return { command: cliPath, argsPrefix: [] };
  }
  const shim = await readNodeCmdShim(cliPath);
  if (shim === null) {
    throw new Error(
      `Windows launcher ${cliPath} is not a Node shim bb can start directly`,
    );
  }
  return { command: shim.command, argsPrefix: shim.args };
}
```

Add `extname` to the `node:path` import. The helper never falls back to `cmd.exe` and never lets a shell resolve the target: a `.cmd` or `.bat` on `BB_CLI` is either an npm/pnpm/bb-style Node shim whose script `readNodeCmdShim` extracts, or it is refused by name.

Make `maybeReexecViaBbCli` `async` and replace the `spawnSync` block at its end:

```ts
let plan: NodeLauncherSpawnPlan;
try {
  plan = await resolveNodeLauncherSpawnPlan(target, process.platform);
} catch (error) {
  process.stderr.write(
    `bb: failed to re-exec BB_CLI=${target}: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
  return;
}

const result = spawnSync(plan.command, [...plan.argsPrefix, ...argv], {
  env: childEnv,
  stdio: "inherit",
});
```

The rest of the function is unchanged, and the only `await` sits _after_ the `options.reexec` seam and after every early `return`, so each existing test — all of which either return early or go through the `reexec` seam — still observes its effect synchronously and is not rewritten. No `windowsHide` is set because this is a user-facing hop.

`apps/cli/src/index.ts` line 13 becomes:

```ts
await maybeReexecViaBbCli();
```

The entry is ESM, esbuild emits ESM for `dist/index.js` and the target is Node 22, so top-level `await` is available. Awaiting at the same position keeps the ordering the POSIX launcher has today: nothing after line 13 runs until the re-exec decision is made, and the re-exec itself is still the synchronous `spawnSync` followed by `process.exit`.

- [ ] **Step 5: Ship the shims in both bundles**

`apps/host-daemon/scripts/build-bundles.mjs` — add `writeFile` to the `node:fs/promises` import and extend the copy block at lines 81-89:

```js
const cliBinDir = resolve(workspaceRoot, "apps", "cli", "bin");
const titleCommandPath = resolve(cliBinDir, "title");
const outputTitleCommandPath = resolve(packageRoot, "dist", "title");
await copyFile(titleCommandPath, outputTitleCommandPath);
await chmod(outputTitleCommandPath, 0o755);
const bundleShims = [
  ["bb.cmd", '@node "%~dp0bb" %*'],
  ["title.cmd", "@title %*"],
];
for (const [shimName, body] of bundleShims) {
  await writeFile(resolve(packageRoot, "dist", shimName), `${body}\r\n`);
}
```

The bundle's shims are written, not copied from `apps/cli/bin`: `apps/cli/bin/bb.cmd` targets `%~dp0..\dist\index.js` because it sits in `bin/` beside a sibling `dist/`, while the bundle's `bb.cmd` sits in the same directory as the bundled `bb` entry and must target `%~dp0bb`. Copying the checkout's shim would point the bundle at a path that does not exist. The `\r\n` is explicit because `dist/` is build output and carries no `.gitattributes` conversion.

`packages/bb-app/scripts/build-host.mjs` — after the `bb` copy at lines 77-81:

```js
await copyFile(
  resolve(hostDaemonSource, "bb.cmd"),
  resolve(hostDaemonTarget, "bb.cmd"),
);
```

`packages/bb-app/package.json` `files` — add the entry directly after `"host-daemon/dist/bb"`:

```json
    "host-daemon/dist/bb.cmd",
```

and add the bundled-at-build-time workspace dependency to `devDependencies`, beside `@bb/config`:

```json
    "@bb/process-utils": "workspace:*",
```

`host-daemon/dist/title.cmd` is deliberately **not** added: `build-host.mjs` never copies `title` into the enrolled-host package today, so a `title.cmd` entry there would ship a shim pointing at a missing sibling. The daemon bundle (`apps/host-daemon/dist`) gets both `title` and `title.cmd`, which is where `BB_CLI_DIR` points.

- [ ] **Step 6: Teach the bb-app launcher the Windows file name and plan**

In `packages/bb-app/src/launcher.ts` add the three helpers directly above `requiredHostArtifactPaths` (line 2086):

```ts
export function resolveBundledBbCliFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "bb.cmd" : "bb";
}

export function resolveBundledBbCliPath(
  daemonBundleDir: string,
  platform: NodeJS.Platform,
): string {
  return join(daemonBundleDir, resolveBundledBbCliFileName(platform));
}

const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat"]);

export async function resolveBundledCliSpawnPlan(
  cliPath: string,
  platform: NodeJS.Platform,
): Promise<{ command: string; argsPrefix: string[] }> {
  const extension = extname(cliPath).toLowerCase();
  if (platform !== "win32" || !WINDOWS_SHIM_EXTENSIONS.has(extension)) {
    return { command: cliPath, argsPrefix: [] };
  }
  const shim = await readNodeCmdShim(cliPath);
  if (shim === null) {
    throw new Error(
      `Windows launcher ${cliPath} is not a Node shim bb can start directly`,
    );
  }
  return { command: shim.command, argsPrefix: shim.args };
}
```

Add `readNodeCmdShim` from `@bb/process-utils` and `extname` from `node:path` to the imports of `launcher.ts`. This is the same plan `apps/cli/src/bb-cli-reexec.ts` uses; both read the shim rather than guessing a sibling file name, so the bundle's `@node "%~dp0bb" %*` and a user's `BB_CLI` pointing at an npm-installed `bb.cmd` both resolve to the script the shim actually names.

Replace `requiredHostArtifactPaths` (line 2086) so the win32 arm requires both files:

```ts
function requiredHostArtifactPaths(
  context: BbAppStartContext,
  platform: NodeJS.Platform = process.platform,
): ArtifactPath[] {
  const windowsLauncher: ArtifactPath[] =
    platform === "win32"
      ? [
          {
            kind: "file",
            label: "bundled bb CLI launcher",
            path: resolveBundledBbCliPath(context.daemonBundleDir, platform),
          },
        ]
      : [];
  return [
    { kind: "file", label: "host daemon entry", path: context.daemonEntry },
    {
      kind: "file",
      label: "bundled bb CLI",
      path: join(context.daemonBundleDir, "bb"),
    },
    ...windowsLauncher,
    {
      kind: "chunk-dir",
      label: "bundled bb CLI chunks",
      path: join(context.daemonBundleDir, "bb-chunks"),
    },
    {
      kind: "file",
      label: "provider bridge worker",
      path: join(context.daemonBundleDir, "bb-provider-bridge-worker.mjs"),
    },
    {
      kind: "file",
      label: "parcel watcher child",
      path: join(context.daemonBundleDir, "bb-parcel-watcher-child.mjs"),
    },
    {
      kind: "file",
      label: "plugin host worker",
      path: join(context.daemonBundleDir, "bb-plugin-host-worker.mjs"),
    },
  ];
}
```

Thread the platform through the two assertions and `requiredFullStackArtifactPaths`:

```ts
function requiredFullStackArtifactPaths(
  context: BbAppStartContext,
  platform: NodeJS.Platform = process.platform,
): ArtifactPath[] {
  return [
    ...requiredHostArtifactPaths(context, platform),
    { kind: "file", label: "server entry", path: context.serverEntry },
    {
      kind: "file",
      label: "web app",
      path: join(context.appDistDir, "index.html"),
    },
  ];
}
```

```ts
export function assertBbAppArtifacts(
  context: BbAppStartContext,
  platform: NodeJS.Platform = process.platform,
): void {
  const missingArtifact = requiredFullStackArtifactPaths(context, platform).find(
    (artifact) => !artifactPresent(artifact),
  );
```

```ts
export function assertBbHostArtifacts(
  context: BbAppStartContext,
  platform: NodeJS.Platform = process.platform,
): void {
  const missingArtifact = requiredHostArtifactPaths(context, platform).find(
    (artifact) => !artifactPresent(artifact),
  );
```

`CreateServerEnvArgs` and `createServerEnv` (line 2561):

```ts
interface CreateServerEnvArgs {
  context: BbAppStartContext;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}
```

```ts
    BB_CLI: resolveBundledBbCliPath(
      args.context.daemonBundleDir,
      args.platform ?? process.platform,
    ),
```

`RunBundledCliCommandArgs` and `runBundledCliCommand` (line 2705):

```ts
interface RunBundledCliCommandArgs {
  args: string[];
  context: BbAppStartContext;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}
```

```ts
export async function runBundledCliCommand(
  args: RunBundledCliCommandArgs,
): Promise<number> {
  const platform = args.platform ?? process.platform;
  const bbCliOverride = toOptionalString(args.env.BB_CLI);
  const cliPath =
    bbCliOverride ??
    resolveBundledBbCliPath(args.context.daemonBundleDir, platform);
  const plan = await resolveBundledCliSpawnPlan(cliPath, platform);
  const childProcess = spawn(plan.command, [...plan.argsPrefix, ...args.args], {
    cwd: process.cwd(),
    env: createCliEnv({ context: args.context, env: args.env }),
    stdio: "inherit",
  });

  return toExitCode(await waitForProcessExit(childProcess));
}
```

- [ ] **Step 7: Run the tests, typechecks and formatter**

Run:

- `pnpm install`
- `pnpm exec turbo run build --filter=@bb/cli`
- `pnpm --filter @bb/cli exec vitest run src/__tests__/bb-cli-reexec.test.ts src/__tests__/bin.test.ts`
- `pnpm --filter bb-app exec vitest run test/index.test.ts`
- `pnpm exec turbo run typecheck --filter=@bb/cli --filter=bb-app --filter=@bb/host-daemon`
- `pnpm exec turbo run test --filter=@bb/cli --filter=bb-app`
- `node apps/host-daemon/scripts/build-bundles.mjs` then `ls apps/host-daemon/dist` to confirm `bb`, `bb.cmd`, `title` and `title.cmd` are all present, and `cat apps/host-daemon/dist/bb.cmd` to confirm it targets `%~dp0bb` rather than `%~dp0..\dist\index.js`.
- `git diff --stat apps/cli/bin/bb apps/cli/bin/title` one last time: still no output.

Expected: green. On Windows the `describe.runIf(win32)` block runs the real `cmd.exe /d /c <tempcopy>\bin\bb.cmd --version` and the PowerShell `& '<tempcopy with a space>\bin\bb.cmd' --version` hop, and both print `bb-launcher-ok --version`, closing the donor's K19 spaced-install-path failure; on POSIX that block is skipped and the untouched `bb bin wrapper` tests still exercise the `cli:prepare` fallback and the direct `dist` path through the unchanged `#!/bin/sh` launcher.

```bash
pnpm exec oxfmt apps/cli/src/bb-cli-reexec.ts apps/cli/src/index.ts apps/cli/src/__tests__/bb-cli-reexec.test.ts apps/cli/src/__tests__/bin.test.ts apps/host-daemon/scripts/build-bundles.mjs packages/bb-app/scripts/build-host.mjs packages/bb-app/src/launcher.ts packages/bb-app/test/index.test.ts
```

(`oxfmt` is not run on the two `.cmd` files; leave them exactly one CRLF-terminated line each.)

- [ ] **Step 8: Commit**

```bash
git add apps/cli/bin/bb.cmd apps/cli/bin/title.cmd apps/cli/package.json apps/cli/src/bb-cli-reexec.ts apps/cli/src/index.ts apps/cli/src/__tests__/bb-cli-reexec.test.ts apps/cli/src/__tests__/bin.test.ts apps/host-daemon/scripts/build-bundles.mjs packages/bb-app/scripts/build-host.mjs packages/bb-app/package.json packages/bb-app/src/launcher.ts packages/bb-app/test/index.test.ts pnpm-lock.yaml
git commit -m "Launch bb through Node on Windows with a cmd shim for shells

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 9: Verified process stop on Windows

**Files:**

- Modify: `packages/config/package.json` (add `"@bb/process-utils": "workspace:*"` to `dependencies`, beside `"@bb/domain"`)
- Modify: `pnpm-lock.yaml` (regenerated by `pnpm install` after the dependency is added)
- Modify: `packages/config/src/verified-process-stop.ts`
- Modify: `packages/config/test/app-runtime-file.test.ts`
- Modify: `packages/bb-app/src/launcher.ts` (`runStopCommand`, lines 3220–3272)
- Unchanged: `apps/desktop/src/owned-runtime-supervisor.ts:141` keeps calling `createNodeVerifiedProcessOps()` with no argument, and both desktop callers keep calling `stopVerifiedProcess` without a `platform`.

**Interfaces:**

- Consumes from `@bb/process-utils` (Task 2): `queryWindowsProcess(pid)` and `type WindowsProcessSnapshotEntry`. Dependency direction check: `packages/process-utils/package.json` has exactly one runtime dependency, `cross-spawn` — it does not depend on `@bb/config`, so adding `@bb/process-utils` to `@bb/config` introduces no cycle. Re-verify with `pnpm exec turbo run typecheck --filter=@bb/config` after `pnpm install`.
- Produces:
  - `createNodeVerifiedProcessOps(platform?: NodeJS.Platform, overrides?: { queryProcess?: (pid: number) => Promise<WindowsProcessSnapshotEntry | null> }): VerifiedProcessOps` — the R10 signature with a second, test-only injectable so no test spawns a real CIM query.
  - `StopVerifiedProcessArgs.platform?: NodeJS.Platform` (default `process.platform`).
  - `StopVerifiedProcessResult` is unchanged: `not-running` / `unverified` (`command` | `start-time`) / `still-running` / `stopped` with `usedKill`.

- [ ] **Step 1: Write the failing tests**

In `packages/config/test/app-runtime-file.test.ts` extend the imports:

```ts
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowsProcessSnapshotEntry } from "@bb/process-utils";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimBbAppRuntimeFile,
  clearOwnBbAppRuntimeFile,
  readBbAppRuntimeFile,
} from "../src/app-runtime-file.js";
import {
  createNodeVerifiedProcessOps,
  parseElapsedSeconds,
  stopVerifiedProcess,
  type VerifiedProcessOps,
} from "../src/verified-process-stop.js";
```

Append a new suite after `describe("stopVerifiedProcess", …)` (the three existing cases in that suite stay exactly as they are):

```ts
describe("stopVerifiedProcess on Windows", () => {
  const commandLine =
    '"C:\\Program Files\\nodejs\\node.exe" C:\\bb\\bb-app.js start';

  function windowsEntry(
    overrides: Partial<WindowsProcessSnapshotEntry> = {},
  ): WindowsProcessSnapshotEntry {
    return {
      pid: 4_242,
      parentPid: 1,
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      commandLine,
      creationDate: new Date(Date.now() - 60_000).toISOString(),
      ...overrides,
    };
  }

  function windowsOps(
    entry: WindowsProcessSnapshotEntry | null,
    overrides: Partial<VerifiedProcessOps> = {},
  ): VerifiedProcessOps {
    return {
      ...createNodeVerifiedProcessOps("win32", {
        queryProcess: async () => entry,
      }),
      isRunning: () => true,
      kill: () => undefined,
      waitForExit: async () => true,
      ...overrides,
    };
  }

  const startedAt = new Date(Date.now() - 60_000).toISOString();

  it("terminates a verified process in a single stage", async () => {
    const killed: number[] = [];

    await expect(
      stopVerifiedProcess({
        killTimeoutMs: 10,
        pid: 4_242,
        platform: "win32",
        processOps: windowsOps(windowsEntry(), {
          kill: (pid) => {
            killed.push(pid);
          },
        }),
        signal: "SIGTERM",
        startedAt,
        timeoutMs: 10,
        verifyTokens: ["bb-app.js"],
      }),
    ).resolves.toEqual({ kind: "stopped", usedKill: true });
    expect(killed).toEqual([4_242]);
  });

  it("refuses a pid whose command line no longer looks like bb", async () => {
    await expect(
      stopVerifiedProcess({
        killTimeoutMs: 10,
        pid: 4_242,
        platform: "win32",
        processOps: windowsOps(
          windowsEntry({ commandLine: "C:\\Windows\\System32\\notepad.exe" }),
        ),
        signal: "SIGTERM",
        startedAt,
        timeoutMs: 10,
        verifyTokens: ["bb-app.js"],
      }),
    ).resolves.toMatchObject({ kind: "unverified", reason: "command" });
  });

  it("refuses a pid whose creation date drifted from the record", async () => {
    await expect(
      stopVerifiedProcess({
        killTimeoutMs: 10,
        pid: 4_242,
        platform: "win32",
        processOps: windowsOps(
          windowsEntry({
            creationDate: new Date(Date.now() - 3_600_000).toISOString(),
          }),
        ),
        signal: "SIGTERM",
        startedAt,
        timeoutMs: 10,
        verifyTokens: ["bb-app.js"],
      }),
    ).resolves.toMatchObject({ kind: "unverified", reason: "start-time" });
  });

  it("refuses a pid CIM cannot describe", async () => {
    await expect(
      stopVerifiedProcess({
        killTimeoutMs: 10,
        pid: 4_242,
        platform: "win32",
        processOps: windowsOps(null),
        signal: "SIGTERM",
        startedAt,
        timeoutMs: 10,
        verifyTokens: ["bb-app.js"],
      }),
    ).resolves.toMatchObject({ kind: "unverified", reason: "command" });
  });

  it("reports a process that is still alive after the terminate", async () => {
    await expect(
      stopVerifiedProcess({
        killTimeoutMs: 10,
        pid: 4_242,
        platform: "win32",
        processOps: windowsOps(windowsEntry(), {
          waitForExit: async () => false,
        }),
        signal: "SIGTERM",
        startedAt,
        timeoutMs: 10,
        verifyTokens: ["bb-app.js"],
      }),
    ).resolves.toEqual({ kind: "still-running" });
  });

  it("reports a recorded pid that already exited", async () => {
    await expect(
      stopVerifiedProcess({
        killTimeoutMs: 10,
        pid: 4_242,
        platform: "win32",
        processOps: windowsOps(null, { isRunning: () => false }),
        signal: "SIGTERM",
        startedAt,
        timeoutMs: 10,
        verifyTokens: ["bb-app.js"],
      }),
    ).resolves.toEqual({ kind: "not-running" });
  });

  it.runIf(process.platform === "win32")(
    "verifies and stops a real Node process through CIM",
    async () => {
      const marker = `bb-verified-stop-${String(process.pid)}-${String(Date.now())}`;
      const startedAtReal = new Date().toISOString();
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 60000)", marker],
        { stdio: "ignore", windowsHide: true },
      );
      const pid = child.pid ?? 0;
      expect(pid).toBeGreaterThan(0);

      try {
        await expect(
          stopVerifiedProcess({
            killTimeoutMs: 5_000,
            pid,
            signal: "SIGTERM",
            startedAt: startedAtReal,
            timeoutMs: 5_000,
            verifyTokens: [marker],
          }),
        ).resolves.toEqual({ kind: "stopped", usedKill: true });
      } finally {
        try {
          child.kill();
        } catch {}
      }
    },
    60_000,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/config exec vitest run test/app-runtime-file.test.ts`.
Expected: FAIL — `@bb/process-utils` cannot be resolved from `@bb/config`, `createNodeVerifiedProcessOps` takes no arguments, and `platform` is not a `stopVerifiedProcess` argument.

- [ ] **Step 3: Add the dependency**

In `packages/config/package.json`:

```json
  "dependencies": {
    "@bb/domain": "workspace:*",
    "@bb/process-utils": "workspace:*",
    "zod": "4.3.6"
  },
```

Run `pnpm install`. Then confirm the direction of the edge: `node -e "console.log(require('./packages/process-utils/package.json').dependencies)"` must print only `cross-spawn`.

- [ ] **Step 4: Implement the win32 ops and the single-stage stop**

In `packages/config/src/verified-process-stop.ts` add one import and the win32 ops factory; `VerifiedProcessOps`, `WaitForProcessExitArgs`, `parseElapsedSeconds`, `readPsField`, `isProcessRunning`, `waitForProcessExit` and `verifyProcessIdentity` are untouched. Lines 1-2 are already `import { execFile } from "node:child_process";` and `import { promisify } from "node:util";` — keep them and add only the third statement below them, so the file starts with:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  queryWindowsProcess,
  type WindowsProcessSnapshotEntry,
} from "@bb/process-utils";
```

```ts
interface StopVerifiedProcessArgs {
  killTimeoutMs: number;
  pid: number;
  platform?: NodeJS.Platform;
  processOps?: VerifiedProcessOps;
  signal: NodeJS.Signals;
  startedAt: string;
  timeoutMs: number;
  verifyTokens: string[];
}

interface NodeVerifiedProcessOpsOverrides {
  queryProcess?: (pid: number) => Promise<WindowsProcessSnapshotEntry | null>;
}

function createWindowsVerifiedProcessOps(
  queryProcess: (pid: number) => Promise<WindowsProcessSnapshotEntry | null>,
): VerifiedProcessOps {
  const pending = new Map<
    number,
    Promise<WindowsProcessSnapshotEntry | null>
  >();
  const readEntry = (
    pid: number,
  ): Promise<WindowsProcessSnapshotEntry | null> => {
    const existing = pending.get(pid);
    if (existing !== undefined) {
      return existing;
    }
    const started = queryProcess(pid);
    pending.set(pid, started);
    return started;
  };

  return {
    isRunning: (pid) => isProcessRunning(pid),
    kill: (pid) => {
      process.kill(pid);
    },
    async readCommand(pid) {
      const entry = await readEntry(pid);
      return entry?.commandLine ?? null;
    },
    async readElapsedSeconds(pid) {
      const entry = await readEntry(pid);
      if (entry === null || entry.creationDate === null) {
        return null;
      }
      const createdAt = Date.parse(entry.creationDate);
      if (Number.isNaN(createdAt)) {
        return null;
      }
      return Math.max(0, Math.round((Date.now() - createdAt) / 1_000));
    },
    waitForExit: (args) => waitForProcessExit(args),
  };
}

export function createNodeVerifiedProcessOps(
  platform: NodeJS.Platform = process.platform,
  overrides: NodeVerifiedProcessOpsOverrides = {},
): VerifiedProcessOps {
  if (platform === "win32") {
    return createWindowsVerifiedProcessOps(
      overrides.queryProcess ?? ((pid) => queryWindowsProcess(pid)),
    );
  }
  return {
    isRunning: (pid) => isProcessRunning(pid),
    kill(pid, signal) {
      process.kill(pid, signal);
    },
    readCommand: (pid) => readPsField(pid, "command="),
    async readElapsedSeconds(pid) {
      const rawElapsed = await readPsField(pid, "etime=");
      return rawElapsed === null ? null : parseElapsedSeconds(rawElapsed);
    },
    waitForExit: (args) => waitForProcessExit(args),
  };
}
```

One CIM query serves both `readCommand` and `readElapsedSeconds`: the ops object lives for exactly one `stopVerifiedProcess` call, so the memo also removes the TOCTOU between reading the command line and reading the creation date.

Then the win32 arm of `stopVerifiedProcess` (the POSIX tail from `processOps.kill(args.pid, args.signal);` down is byte-identical to today):

```ts
export async function stopVerifiedProcess(
  args: StopVerifiedProcessArgs,
): Promise<StopVerifiedProcessResult> {
  const platform = args.platform ?? process.platform;
  const processOps = args.processOps ?? createNodeVerifiedProcessOps(platform);

  if (!processOps.isRunning(args.pid)) {
    return { kind: "not-running" };
  }

  const mismatch = await verifyProcessIdentity({
    pid: args.pid,
    processOps,
    startedAt: args.startedAt,
    verifyTokens: args.verifyTokens,
  });
  if (mismatch !== null) {
    return {
      command: mismatch.command,
      kind: "unverified",
      reason: mismatch.reason,
    };
  }

  if (platform === "win32") {
    processOps.kill(args.pid, args.signal);
    const terminated = await processOps.waitForExit({
      pid: args.pid,
      timeoutMs: args.timeoutMs + args.killTimeoutMs,
    });
    if (!terminated && processOps.isRunning(args.pid)) {
      return { kind: "still-running" };
    }
    return { kind: "stopped", usedKill: true };
  }

  processOps.kill(args.pid, args.signal);
  const exited = await processOps.waitForExit({
    pid: args.pid,
    timeoutMs: args.timeoutMs,
  });
  if (exited || !processOps.isRunning(args.pid)) {
    return { kind: "stopped", usedKill: false };
  }

  processOps.kill(args.pid, "SIGKILL");
  const killed = await processOps.waitForExit({
    pid: args.pid,
    timeoutMs: args.killTimeoutMs,
  });
  if (!killed && processOps.isRunning(args.pid)) {
    return { kind: "still-running" };
  }
  return { kind: "stopped", usedKill: true };
}
```

There is no graceful stage on Windows: `SIGTERM` and `SIGKILL` are both `TerminateProcess`, so a single kill is issued after verification and it is reported as a forced stop (`usedKill: true`), which is what the launcher renders as "terminated".

- [ ] **Step 5: Say "terminated" instead of "SIGKILL" in `bb stop` on Windows**

`packages/bb-app/src/launcher.ts`, `runStopCommand` (a CLI composition root, so reading `process.platform` here is allowed). Hunk 1 — add the two suffix constants right below the early return:

```ts
async function runStopCommand(args: { dataDir: string }): Promise<void> {
  const runtimeFile = await readBbAppRuntimeFile(args.dataDir);
  if (runtimeFile === null) {
    log(dim("●"), `No running bb recorded in ${args.dataDir}`);
    return;
  }

  const forcedStopName =
    process.platform === "win32" ? "being terminated" : "SIGKILL";
  const forcedStopSuffix =
    process.platform === "win32" ? " (terminated)" : " with SIGKILL";

  const result = await stopVerifiedProcess({
```

Hunk 2 — the still-running message:

```ts
if (result.kind === "still-running") {
  process.stderr.write(
    `bb (pid ${String(runtimeFile.pid)}) did not stop, even after ${forcedStopName}.\n`,
  );
  process.exitCode = 1;
  return;
}
```

Hunk 3 — the success message:

```ts
log(
  green("✓"),
  `Stopped bb (pid ${String(runtimeFile.pid)})${result.usedKill ? forcedStopSuffix : ""}`,
);
```

On POSIX both strings are byte-identical to today (`… did not stop, even after SIGKILL.` and `Stopped bb (pid N) with SIGKILL`).

- [ ] **Step 6: Run the tests, typecheck and format**

Run: `pnpm --filter @bb/config exec vitest run test/app-runtime-file.test.ts`, then `pnpm exec turbo run typecheck --filter=@bb/config --filter=bb-app --filter=@bb/desktop`, then `pnpm exec turbo run test --filter=@bb/config --filter=@bb/desktop`, then `pnpm exec oxfmt packages/config/src/verified-process-stop.ts packages/config/test/app-runtime-file.test.ts packages/bb-app/src/launcher.ts`.
Expected: all green — the three original `stopVerifiedProcess` cases and the `parseElapsedSeconds` cases are unchanged, the desktop suites (`foreign-runtime.test.ts`, `owned-runtime-supervisor.test.ts`) still pass because they inject `processOps` and never pass a `platform`, and on the reference desktop the `it.runIf(win32)` case spawns a Node sleeper, verifies it through `Get-CimInstance` and stops it.

- [ ] **Step 7: Commit**

```bash
git add packages/config/package.json packages/config/src/verified-process-stop.ts packages/config/test/app-runtime-file.test.ts packages/bb-app/src/launcher.ts pnpm-lock.yaml
git commit -m "Verify Windows processes through CIM before bb stop kills them

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 10: Open and reveal targets on Windows

**Files:**

- Create: `packages/local-open-targets/src/windows-launch.ts`
- Modify: `packages/local-open-targets/src/types.ts` (`LaunchAdapter`, new `WindowsLaunchAdapter`, `ExecFileOptions`)
- Modify: `packages/local-open-targets/src/macos-launch-adapters.ts` (seven `windows.knownRelativePaths` entries, donor text verbatim)
- Modify: `packages/local-open-targets/src/index.ts` (import, the two `platform === "win32"` dispatch arms, the `detached` branch of `defaultExecFile`)
- Test: `packages/local-open-targets/test/workspace-open-targets.test.ts` (replace `returns no targets for unsupported win32 runtime`, add `describe("windows", …)`)

**Interfaces:**

- Consumes: `resolveExecutable({ command, env, platform })`, `readNodeCmdShim(shimPath)`, `resolveWindowsSystemToolPath(name, env)`, `resolvePowerShellExecutable(env)` from `@bb/process-utils` (Task 1); `runtime.env` already normalised to a single `Path` key by `assignPathEnv` in `createWorkspaceOpenTargetRuntime` (Task 3 — do not touch that function here); `LAUNCH_ADAPTERS`, `BASIC_FILE_OPEN_CAPABILITIES`, `FILE_MANAGER_OPEN_CAPABILITIES`, `WorkspaceOpenTargetError`.
- Produces: `listWindowsWorkspaceOpenTargets(runtime: WorkspaceOpenTargetRuntime): Promise<WorkspaceOpenTarget[]>` and `openWindowsPathInTarget(args: OpenPathInTargetArgs, runtime: WorkspaceOpenTargetRuntime): Promise<void>` from `./windows-launch.js`; `WindowsLaunchAdapter { knownRelativePaths?: string[][] }` and `LaunchAdapter.windows?` in `types.ts`; `ExecFileOptions` gains `cwd?`, `detached?`, `windowsHide?`.

Reference while implementing (do not apply it): `git diff 6cdb4ba61 refs/remotes/upstream-pr/3188 -- packages/local-open-targets`. The donor put every Windows function inside `index.ts`, resolved executables with `where.exe`, opened the containing directory instead of selecting the file, launched the default app through `cmd.exe /d /s /c start`, had no `terminal` target and swallowed every `explorer.exe` exit code 1. R11 changes all of that, so the donor is read for its adapter table and its JetBrains discovery, not applied.

Three deliberate deviations from a mechanical port, worth knowing before writing code:

- `explorer.exe` lives at `%SystemRoot%\explorer.exe`, **not** under `System32`, so it is the one Windows tool here that is not resolved by `resolveWindowsSystemToolPath`; `windows-launch.ts` joins `%SystemRoot%` itself (default `C:\Windows`). `cmd.exe` and `reg.exe` do go through `resolveWindowsSystemToolPath`.
- `windows-launch.ts` keeps its own tiny copies of `pathExists`, the openable-path classifier, the newest-name sort and the target-id prefixes instead of importing them from `index.ts`: `index.ts` imports `windows-launch.ts`, so the reverse import would be a cycle. Everything else (`LAUNCH_ADAPTERS`, the capability presets, `WorkspaceOpenTargetError`) comes from the existing leaf modules.
- The Windows `terminal` target gets `BASIC_FILE_OPEN_CAPABILITIES`, not `TERMINAL_OPEN_CAPABILITIES`: the Windows launch only changes directory, it has no terminal-editor script to honour a line or column.

- [ ] **Step 1: Write the failing tests**

In `packages/local-open-targets/test/workspace-open-targets.test.ts`, replace the whole `it("returns no targets for unsupported win32 runtime", …)` case (HEAD lines 343-355) with:

```ts
it("lists Windows platform targets without POSIX editor paths", async () => {
  const execFile = vi.fn<ExecFileHandler>(async () => ({ stdout: "" }));

  const targets = await listWorkspaceOpenTargetsWithRuntime(
    createRuntime({
      env: {},
      execFile,
      platform: "win32",
    }),
  );

  expect(targets.map((target) => target.id)).toEqual([
    "default-app",
    "file-manager",
    "terminal",
  ]);
  expect(
    execFile.mock.calls.some((call) =>
      call[0].toLowerCase().endsWith("reg.exe"),
    ),
  ).toBe(true);
  expect(execFile.mock.calls.some((call) => call[0] === "which")).toBe(false);
  expect(execFile.mock.calls.some((call) => call[0] === "where")).toBe(false);
});
```

Then append this block as the last child of the existing `describe("workspace open targets", …)` (immediately before its closing `});`):

```ts
describe("windows", () => {
  interface WindowsExecFileCall {
    args: string[];
    file: string;
    options?: ExecFileOptions;
  }

  interface CreateWindowsRuntimeArgs {
    appPaths?: Record<string, string>;
    beforeFailure?: () => Promise<void>;
    calls?: WindowsExecFileCall[];
    env?: NodeJS.ProcessEnv;
    failWithCode?: (executableName: string) => number | null;
  }

  function windowsExecutableName(file: string): string {
    const segments = file.split(/[\\/]/u);
    return (segments[segments.length - 1] ?? file).toLowerCase();
  }

  function createWindowsRuntime(
    args: CreateWindowsRuntimeArgs,
  ): WorkspaceOpenTargetRuntime {
    return createRuntime({
      env: args.env ?? {},
      execFile: async (file, commandArgs, options) => {
        const name = windowsExecutableName(file);
        args.calls?.push({ file, args: commandArgs, options });
        if (name === "reg.exe") {
          const key = commandArgs[1] ?? "";
          const entry = Object.entries(args.appPaths ?? {}).find(
            ([valueName]) =>
              key.toLowerCase().endsWith(`\\${valueName.toLowerCase()}`),
          );
          if (entry === undefined) {
            throw new Error("ERROR: The system was unable to find the key");
          }
          return {
            stdout: `\r\n${key}\r\n    (Default)    REG_SZ    ${entry[1]}\r\n\r\n`,
          };
        }
        const failCode = args.failWithCode?.(name) ?? null;
        if (failCode !== null) {
          await args.beforeFailure?.();
          throw Object.assign(new Error(`exited with ${failCode}`), {
            code: failCode,
          });
        }
        return { stdout: "" };
      },
      platform: "win32",
    });
  }

  async function createWindowsPathDirectory(
    executableNames: string[],
  ): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "bb-win-path-"));
    for (const executableName of executableNames) {
      await writeFile(path.join(directory, executableName), "");
    }
    return directory;
  }

  it("discovers VS Code on the Windows Path with remote support", async () => {
    const pathDirectory = await createWindowsPathDirectory(["code.exe"]);

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createWindowsRuntime({ env: { Path: pathDirectory } }),
      );

      expect(targets.map((target) => target.id)).toEqual([
        "vscode",
        "default-app",
        "file-manager",
        "terminal",
      ]);
      expect(targets.find((target) => target.id === "vscode")).toMatchObject({
        icon: { kind: "builtin", name: "vscode" },
        kind: "editor",
        label: "VS Code",
        remoteSshCapabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: true,
          openFileAtLine: true,
        },
      });
      expect(targets.find((target) => target.id === "terminal")).toMatchObject({
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: false,
          openFileAtLine: false,
        },
        kind: "terminal",
      });
    } finally {
      await rm(pathDirectory, { force: true, recursive: true });
    }
  });

  it("opens files in VS Code at line and column from the Windows Path", async () => {
    const pathDirectory = await createWindowsPathDirectory(["code.exe"]);
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "file.ts");
    const calls: WindowsExecFileCall[] = [];

    try {
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "vscode",
        },
        createWindowsRuntime({ calls, env: { Path: pathDirectory } }),
      );

      expect(calls).toEqual([
        {
          file: path.join(pathDirectory, "code.exe"),
          args: ["-g", `${filePath}:15:6`],
          options: { env: { Path: pathDirectory } },
        },
      ]);
    } finally {
      await rm(pathDirectory, { force: true, recursive: true });
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("discovers an editor through the App Paths registry when the Path misses", async () => {
    const installRoot = await mkdtemp(path.join(tmpdir(), "bb-apppaths-"));
    const codeExe = path.join(installRoot, "Code.exe");
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: WindowsExecFileCall[] = [];

    try {
      await writeFile(codeExe, "");

      const runtime = createWindowsRuntime({
        appPaths: { "code.exe": codeExe },
        calls,
      });
      const targets = await listWorkspaceOpenTargetsWithRuntime(runtime);
      expect(targets.map((target) => target.id)).toContain("vscode");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "vscode",
        },
        runtime,
      );

      const registryCall = calls.find(
        (call) => windowsExecutableName(call.file) === "reg.exe",
      );
      expect(registryCall?.args).toEqual([
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\code.exe",
        "/ve",
      ]);
      expect(calls.find((call) => call.file === codeExe)).toMatchObject({
        file: codeExe,
        args: [workspacePath],
      });
    } finally {
      await rm(installRoot, { force: true, recursive: true });
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("runs a node .cmd shim through the Node executable", async () => {
    const localAppData = await mkdtemp(path.join(tmpdir(), "bb-localapp-"));
    const binDirectory = path.join(
      localAppData,
      "Programs",
      "Microsoft VS Code",
      "bin",
    );
    const codeCmd = path.join(binDirectory, "code.cmd");
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: WindowsExecFileCall[] = [];

    try {
      await mkdir(binDirectory, { recursive: true });
      await writeFile(codeCmd, '@node "%~dp0code" %*\r\n');
      await writeFile(path.join(binDirectory, "code"), "");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "vscode",
        },
        createWindowsRuntime({ calls, env: { LOCALAPPDATA: localAppData } }),
      );

      expect(calls.find((call) => call.file === process.execPath)).toEqual({
        file: process.execPath,
        args: [path.join(binDirectory, "code"), workspacePath],
        options: { env: { LOCALAPPDATA: localAppData } },
      });
    } finally {
      await rm(localAppData, { force: true, recursive: true });
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("runs a non-node .cmd shim through cmd.exe", async () => {
    const localAppData = await mkdtemp(path.join(tmpdir(), "bb-localapp-"));
    const codeCmd = path.join(
      localAppData,
      "Programs",
      "Microsoft VS Code",
      "bin",
      "code.cmd",
    );
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: WindowsExecFileCall[] = [];

    try {
      await mkdir(path.dirname(codeCmd), { recursive: true });
      await writeFile(codeCmd, '@echo off\r\n"%~dp0..\\Code.exe" %*\r\n');

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "vscode",
        },
        createWindowsRuntime({ calls, env: { LOCALAPPDATA: localAppData } }),
      );

      const call = calls.find(
        (candidate) => windowsExecutableName(candidate.file) === "cmd.exe",
      );
      expect(call?.file.endsWith("System32\\cmd.exe")).toBe(true);
      expect(call?.args).toEqual(["/d", "/c", codeCmd, workspacePath]);
    } finally {
      await rm(localAppData, { force: true, recursive: true });
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("selects files and opens directories in Explorer", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const nestedDirectory = path.join(workspacePath, "sub");
    const filePath = path.join(nestedDirectory, "notes.md");
    const calls: WindowsExecFileCall[] = [];

    try {
      await mkdir(nestedDirectory, { recursive: true });
      await writeFile(filePath, "# Notes\n");

      const runtime = createWindowsRuntime({ calls });
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "file-manager",
        },
        runtime,
      );
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: nestedDirectory,
          targetId: "file-manager",
        },
        runtime,
      );

      expect(
        calls.map((call) => [windowsExecutableName(call.file), call.args]),
      ).toEqual([
        ["explorer.exe", [`/select,${filePath}`]],
        ["explorer.exe", [nestedDirectory]],
      ]);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens files and directories with the default app through Explorer", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: WindowsExecFileCall[] = [];

    try {
      await writeFile(filePath, "# Notes\n");

      const runtime = createWindowsRuntime({ calls });
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "default-app",
        },
        runtime,
      );
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "default-app",
        },
        runtime,
      );

      expect(
        calls.map((call) => [windowsExecutableName(call.file), call.args]),
      ).toEqual([
        ["explorer.exe", [filePath]],
        ["explorer.exe", [workspacePath]],
      ]);
      expect(
        calls.some((call) => windowsExecutableName(call.file) === "cmd.exe"),
      ).toBe(false);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens Windows Terminal at the containing directory", async () => {
    const pathDirectory = await createWindowsPathDirectory(["wt.exe"]);
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: WindowsExecFileCall[] = [];

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "terminal",
        },
        createWindowsRuntime({ calls, env: { Path: pathDirectory } }),
      );

      expect(calls).toEqual([
        {
          file: path.join(pathDirectory, "wt.exe"),
          args: ["-d", workspacePath],
          options: { env: { Path: pathDirectory }, windowsHide: false },
        },
      ]);
    } finally {
      await rm(pathDirectory, { force: true, recursive: true });
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("falls back to a detached PowerShell console when wt is absent", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: WindowsExecFileCall[] = [];

    try {
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "terminal",
        },
        createWindowsRuntime({ calls }),
      );

      expect(calls).toHaveLength(1);
      expect(windowsExecutableName(calls[0]?.file ?? "")).toMatch(
        /^(?:pwsh|powershell)\.exe$/u,
      );
      expect(calls[0]?.args).toEqual(["-NoLogo"]);
      expect(calls[0]?.options).toEqual({
        cwd: workspacePath,
        detached: true,
        env: {},
        windowsHide: false,
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("treats an Explorer exit code of 1 on an existing path as success", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));

    try {
      await expect(
        openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: workspacePath,
            targetId: "file-manager",
          },
          createWindowsRuntime({
            failWithCode: (name) => (name === "explorer.exe" ? 1 : null),
          }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("surfaces Explorer failures when the path is gone or the code is not 1", async () => {
    const missingPath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const failingPath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));

    try {
      await expect(
        openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: missingPath,
            targetId: "file-manager",
          },
          createWindowsRuntime({
            beforeFailure: () =>
              rm(missingPath, { force: true, recursive: true }),
            failWithCode: (name) => (name === "explorer.exe" ? 1 : null),
          }),
        ),
      ).rejects.toMatchObject({ code: 1 });

      await expect(
        openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: failingPath,
            targetId: "file-manager",
          },
          createWindowsRuntime({
            failWithCode: (name) => (name === "explorer.exe" ? 2 : null),
          }),
        ),
      ).rejects.toMatchObject({ code: 2 });
    } finally {
      await rm(missingPath, { force: true, recursive: true });
      await rm(failingPath, { force: true, recursive: true });
    }
  });

  it("opens remote SSH paths in VS Code and rejects targets without remote support", async () => {
    const pathDirectory = await createWindowsPathDirectory(["code.exe"]);
    const calls: WindowsExecFileCall[] = [];

    try {
      await openPathInTargetWithRuntime(
        {
          context: { kind: "remote-ssh", sshAuthority: "devbox" },
          columnNumber: 9,
          lineNumber: 42,
          path: "/home/me/missing-on-client.ts",
          targetId: "vscode",
        },
        createWindowsRuntime({ calls, env: { Path: pathDirectory } }),
      );

      expect(calls.at(-1)).toMatchObject({
        file: path.join(pathDirectory, "code.exe"),
        args: [
          "--remote",
          "ssh-remote+devbox",
          "-g",
          "/home/me/missing-on-client.ts:42:9",
        ],
      });

      await expect(
        openPathInTargetWithRuntime(
          {
            context: { kind: "remote-ssh", sshAuthority: "devbox" },
            columnNumber: null,
            lineNumber: null,
            path: "/home/me/project",
            targetId: "file-manager",
          },
          createWindowsRuntime({}),
        ),
      ).rejects.toMatchObject({ code: "remote_target_unsupported" });

      await expect(
        openPathInTargetWithRuntime(
          {
            context: { kind: "remote-ssh", sshAuthority: "devbox" },
            columnNumber: null,
            lineNumber: null,
            path: "/home/me/project",
            targetId: "vscode",
          },
          createWindowsRuntime({}),
        ),
      ).rejects.toMatchObject({ code: "target_unavailable" });
    } finally {
      await rm(pathDirectory, { force: true, recursive: true });
    }
  });

  it("rejects desktop and macOS app targets as unavailable", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));

    try {
      for (const targetId of [
        "desktop-app:mockedit",
        "mac-app:com.example.MockEdit",
      ]) {
        await expect(
          openPathInTargetWithRuntime(
            {
              context: { kind: "local" },
              columnNumber: null,
              lineNumber: null,
              path: workspacePath,
              targetId,
            },
            createWindowsRuntime({}),
          ),
        ).rejects.toMatchObject({ code: "target_unavailable" });
      }
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("discovers editors from Windows install roots", async () => {
    const localAppData = await mkdtemp(path.join(tmpdir(), "bb-localapp-"));
    const programFiles = await mkdtemp(path.join(tmpdir(), "bb-progfiles-"));
    const localCases = [
      { relativePath: ["cursor", "Cursor.exe"], targetId: "cursor" },
      { relativePath: ["Zed", "zed.exe"], targetId: "zed" },
      { relativePath: ["Windsurf", "Windsurf.exe"], targetId: "devin-desktop" },
      {
        relativePath: ["Antigravity", "Antigravity.exe"],
        targetId: "antigravity",
      },
    ];
    const sublExe = path.join(programFiles, "Sublime Text", "subl.exe");
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: WindowsExecFileCall[] = [];

    try {
      for (const testCase of localCases) {
        const executablePath = path.join(
          localAppData,
          "Programs",
          ...testCase.relativePath,
        );
        await mkdir(path.dirname(executablePath), { recursive: true });
        await writeFile(executablePath, "");
      }
      await mkdir(path.dirname(sublExe), { recursive: true });
      await writeFile(sublExe, "");
      await writeFile(filePath, "# Notes\n");

      const runtime = createWindowsRuntime({
        calls,
        env: { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
      });
      const targets = await listWorkspaceOpenTargetsWithRuntime(runtime);
      for (const testCase of [
        ...localCases,
        { relativePath: [], targetId: "sublime-text" },
      ]) {
        expect(targets.map((target) => target.id)).toContain(testCase.targetId);
      }

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "sublime-text",
        },
        runtime,
      );

      expect(calls.find((call) => call.file === sublExe)).toMatchObject({
        file: sublExe,
        args: [`${filePath}:15:6`],
      });
    } finally {
      await rm(localAppData, { force: true, recursive: true });
      await rm(programFiles, { force: true, recursive: true });
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("discovers JetBrains Toolbox shims and versioned installs", async () => {
    const localAppData = await mkdtemp(path.join(tmpdir(), "bb-localapp-"));
    const programFiles = await mkdtemp(path.join(tmpdir(), "bb-progfiles-"));
    const ideaCmd = path.join(
      localAppData,
      "JetBrains",
      "Toolbox",
      "scripts",
      "idea.cmd",
    );
    const webstormExe = path.join(
      programFiles,
      "JetBrains",
      "WebStorm 2024.1",
      "bin",
      "webstorm64.exe",
    );
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "file.ts");
    const calls: WindowsExecFileCall[] = [];

    try {
      await mkdir(path.dirname(ideaCmd), { recursive: true });
      await writeFile(ideaCmd, "@echo off\r\n");
      await mkdir(path.dirname(webstormExe), { recursive: true });
      await writeFile(webstormExe, "");
      await writeFile(filePath, "export const value = 1;\n");

      const runtime = createWindowsRuntime({
        calls,
        env: { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
      });
      const targets = await listWorkspaceOpenTargetsWithRuntime(runtime);
      expect(targets.map((target) => target.id)).toContain("intellij-idea");
      expect(targets.map((target) => target.id)).toContain("webstorm");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "intellij-idea",
        },
        runtime,
      );
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: 15,
          path: filePath,
          targetId: "webstorm",
        },
        runtime,
      );

      expect(
        calls.find((call) => windowsExecutableName(call.file) === "cmd.exe")
          ?.args,
      ).toEqual([
        "/d",
        "/c",
        ideaCmd,
        "--line",
        "15",
        "--column",
        "6",
        filePath,
      ]);
      expect(calls.find((call) => call.file === webstormExe)?.args).toEqual([
        "--line",
        "15",
        filePath,
      ]);
    } finally {
      await rm(localAppData, { force: true, recursive: true });
      await rm(programFiles, { force: true, recursive: true });
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("leaves JetBrains targets unavailable without Toolbox or installs", async () => {
    const localAppData = await mkdtemp(path.join(tmpdir(), "bb-empty-"));

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createWindowsRuntime({ env: { LOCALAPPDATA: localAppData } }),
      );

      for (const targetId of [
        "intellij-idea",
        "pycharm",
        "webstorm",
        "goland",
        "rider",
        "rustrover",
        "phpstorm",
        "android-studio",
      ]) {
        expect(targets.map((target) => target.id)).not.toContain(targetId);
      }
    } finally {
      await rm(localAppData, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "lists the real open targets of this desktop",
    async () => {
      const targets = await listWorkspaceOpenTargets();
      const targetIds = targets.map((target) => target.id);

      expect(targetIds).toContain("file-manager");
      expect(targetIds).toContain("terminal");
      expect(targetIds).toContain("default-app");
      if (
        (await resolveExecutable({ command: "code", platform: "win32" })) !==
        null
      ) {
        expect(targetIds).toContain("vscode");
      }
    },
  );
});
```

Extend the test file's imports to cover the new helpers and types:

```ts
import { resolveExecutable } from "@bb/process-utils";
import {
  createWorkspaceOpenTargetRuntime,
  listWorkspaceOpenTargets,
  listWorkspaceOpenTargetsWithRuntime,
  openPathInTargetWithRuntime,
  type WorkspaceOpenTargetRuntime,
} from "../src/index.js";
import type { ExecFileOptions } from "../src/types.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/local-open-targets exec vitest run test/workspace-open-targets.test.ts`.
Expected: FAIL — `Cannot find module './windows-launch.js'` is not yet the failure; the first failures are `expected [] to deeply equal [ 'default-app', 'file-manager', 'terminal' ]` from the replaced top-level case and `unsupported_platform` rejections from every `describe("windows")` open case, because `win32` still returns `[]` and throws.

- [ ] **Step 3: Extend the adapter types and table**

In `packages/local-open-targets/src/types.ts` replace the `ExecFileOptions` and `LaunchAdapter` declarations with:

```ts
export interface ExecFileOptions {
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
}
```

```ts
export interface LaunchAdapter {
  capabilities: WorkspaceOpenTargetCapabilities;
  fileOpenBehavior: "direct" | "containing-directory";
  icon: WorkspaceOpenTargetIcon;
  id: WorkspaceOpenTargetId;
  kind: WorkspaceOpenTargetKind;
  label: string;
  macos: MacLaunchAdapter;
  windows?: WindowsLaunchAdapter;
}

export interface WindowsLaunchAdapter {
  knownRelativePaths?: string[][];
}
```

In `packages/local-open-targets/src/macos-launch-adapters.ts` add the donor's seven `windows` blocks, each directly above the entry's `macos:` key:

```ts
    windows: {
      knownRelativePaths: [
        ["Microsoft VS Code", "bin", "code.cmd"],
        ["Microsoft VS Code", "Code.exe"],
      ],
    },
```

```ts
    windows: {
      knownRelativePaths: [
        ["Microsoft VS Code Insiders", "bin", "code-insiders.cmd"],
        ["Microsoft VS Code Insiders", "Code - Insiders.exe"],
      ],
    },
```

```ts
    windows: {
      knownRelativePaths: [
        ["cursor", "Cursor.exe"],
        ["cursor", "bin", "cursor.cmd"],
      ],
    },
```

```ts
    windows: {
      knownRelativePaths: [
        ["Sublime Text", "subl.exe"],
        ["Sublime Text", "sublime_text.exe"],
      ],
    },
```

```ts
    windows: {
      knownRelativePaths: [["Zed", "zed.exe"]],
    },
```

```ts
    windows: {
      knownRelativePaths: [
        ["Windsurf", "Windsurf.exe"],
        ["Windsurf", "bin", "windsurf.cmd"],
      ],
    },
```

```ts
    windows: {
      knownRelativePaths: [["Antigravity", "Antigravity.exe"]],
    },
```

in the `vscode`, `vscode-insiders`, `cursor`, `sublime-text`, `zed`, `devin-desktop` and `antigravity` entries, in that order. No other entry gets a `windows` block: the remaining adapters are either mac-only apps whose commands never resolve on Windows, or JetBrains IDEs, which are found through the Toolbox and versioned-install search instead.

- [ ] **Step 4: Create `src/windows-launch.ts`**

```ts
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceOpenTarget } from "@bb/host-daemon-contract";
import {
  readNodeCmdShim,
  resolveExecutable,
  resolvePowerShellExecutable,
  resolveWindowsSystemToolPath,
} from "@bb/process-utils";
import {
  BASIC_FILE_OPEN_CAPABILITIES,
  FILE_MANAGER_OPEN_CAPABILITIES,
} from "./capabilities.js";
import { WorkspaceOpenTargetError } from "./errors.js";
import { LAUNCH_ADAPTERS } from "./macos-launch-adapters.js";
import type {
  ExecFileInvocation,
  ExistingPath,
  LaunchAdapter,
  MacCommandExecutableAdapter,
  MacRemoteSshOpenCommandAdapter,
  OpenPathInTargetArgs,
  WorkspaceOpenTargetRuntime,
} from "./types.js";

const WINDOWS_APP_PATHS_SUBKEY =
  "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths";
const WINDOWS_APP_PATHS_HIVES = ["HKLM", "HKCU"] as const;
const WINDOWS_REGISTRY_VALUE_PATTERN = /\sREG_(?:EXPAND_)?SZ\s+(.*)$/mu;
const WINDOWS_CMD_SHIM_EXTENSIONS = new Set([".bat", ".cmd"]);
const WINDOWS_DEFAULT_SYSTEM_ROOT = "C:\\Windows";
const WINDOWS_INSTALL_ROOT_ENV_VARIABLES = [
  "ProgramFiles",
  "ProgramFiles(x86)",
] as const;
const WINDOWS_JETBRAINS_SHIM_EXTENSIONS = [".cmd", ".bat", ".exe"];
const WINDOWS_TERMINAL_COMMAND = "wt";
const WINDOWS_TERMINAL_ALIAS_SEGMENTS = ["Microsoft", "WindowsApps", "wt.exe"];
const WINDOWS_UNSUPPORTED_TARGET_ID_PREFIXES = ["desktop-app:", "mac-app:"];

type WindowsAppPathCache = Map<string, Promise<string | null>>;

interface WindowsCommandAdapter extends MacCommandExecutableAdapter {
  fallbackExecutables?: MacCommandExecutableAdapter[];
}

interface WindowsLaunchInvocation extends ExecFileInvocation {
  cwd?: string;
  detached?: boolean;
  explorerPath?: string;
  windowsHide?: boolean;
}

interface ResolveWindowsCliOpenArgs {
  columnNumber: number | null;
  definition: LaunchAdapter;
  existingPath: ExistingPath;
  lineNumber: number | null;
}

interface ResolveWindowsRemoteSshOpenArgs {
  columnNumber: number | null;
  definition: LaunchAdapter;
  lineNumber: number | null;
  path: string;
  sshAuthority: string;
}

function isPresentTarget(
  target: WorkspaceOpenTarget | null,
): target is WorkspaceOpenTarget {
  return target !== null;
}

function isExitCodeOneError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === 1;
}

function readWindowsEnvValue(
  runtime: WorkspaceOpenTargetRuntime,
  name: string,
): string | undefined {
  const env = runtime.env;
  if (env === undefined) {
    return undefined;
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

function readWindowsDirectoryEnvValue(
  runtime: WorkspaceOpenTargetRuntime,
  name: string,
): string | null {
  const value = readWindowsEnvValue(runtime, name)?.trim();
  return value === undefined || value === "" ? null : value;
}

async function windowsPathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function sortNewestNameFirst(entries: string[]): string[] {
  return [...entries].sort((a, b) => b.localeCompare(a));
}

function findWindowsLaunchAdapter(targetId: string): LaunchAdapter | null {
  return LAUNCH_ADAPTERS.find((candidate) => candidate.id === targetId) ?? null;
}

async function requireOpenableWindowsPath(
  targetPath: string,
): Promise<ExistingPath> {
  const stat = await fs.stat(targetPath).catch(() => null);
  if (stat === null) {
    throw new WorkspaceOpenTargetError({
      code: "path_not_found",
      message: `Open target path does not exist: ${targetPath}`,
    });
  }
  if (stat.isDirectory()) {
    return { path: targetPath, type: "directory" };
  }
  if (stat.isFile()) {
    return { path: targetPath, type: "file" };
  }
  throw new WorkspaceOpenTargetError({
    code: "path_not_openable",
    message: `Open target path must be a file or directory: ${targetPath}`,
  });
}

function getWindowsInstallRoots(runtime: WorkspaceOpenTargetRuntime): string[] {
  const roots: string[] = [];
  const localAppData = readWindowsDirectoryEnvValue(runtime, "LOCALAPPDATA");
  if (localAppData !== null) {
    roots.push(path.join(localAppData, "Programs"));
  }
  for (const variableName of WINDOWS_INSTALL_ROOT_ENV_VARIABLES) {
    const root = readWindowsDirectoryEnvValue(runtime, variableName);
    if (root !== null && !roots.includes(root)) {
      roots.push(root);
    }
  }
  return roots;
}

function getWindowsKnownExecutablePaths(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): string[] {
  const relativePaths = definition.windows?.knownRelativePaths ?? [];
  if (relativePaths.length === 0) {
    return [];
  }
  return getWindowsInstallRoots(runtime).flatMap((root) =>
    relativePaths.map((relativePath) => path.join(root, ...relativePath)),
  );
}

function parseWindowsRegistryDefaultValue(stdout: string): string | null {
  const match = WINDOWS_REGISTRY_VALUE_PATTERN.exec(stdout);
  const value = (match?.[1] ?? "").trim().replace(/^"(.*)"$/u, "$1");
  return value === "" ? null : value;
}

async function queryWindowsAppPath(
  executable: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const registryExecutable = resolveWindowsSystemToolPath(
    "reg.exe",
    runtime.env,
  );
  const valueName = executable.toLowerCase().endsWith(".exe")
    ? executable
    : `${executable}.exe`;
  for (const hive of WINDOWS_APP_PATHS_HIVES) {
    let stdout: string;
    try {
      const result = await runtime.execFile(
        registryExecutable,
        ["query", `${hive}\\${WINDOWS_APP_PATHS_SUBKEY}\\${valueName}`, "/ve"],
        { env: runtime.env },
      );
      stdout = result.stdout;
    } catch {
      continue;
    }
    const value = parseWindowsRegistryDefaultValue(stdout);
    if (value !== null && (await windowsPathExists(value))) {
      return value;
    }
  }
  return null;
}

function readWindowsAppPath(
  executable: string,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<string | null> {
  const key = executable.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const lookup = queryWindowsAppPath(executable, runtime);
  cache.set(key, lookup);
  return lookup;
}

function getWindowsJetBrainsToolbox(definition: LaunchAdapter): {
  bundlePrefixes: string[];
  executable: string;
} | null {
  if (definition.macos.openMode === "default-app") {
    return null;
  }
  return definition.macos.jetBrainsToolbox ?? null;
}

async function findWindowsJetBrainsToolboxScriptPath(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const toolbox = getWindowsJetBrainsToolbox(definition);
  const localAppData = readWindowsDirectoryEnvValue(runtime, "LOCALAPPDATA");
  if (toolbox === null || localAppData === null) {
    return null;
  }
  const scriptsDirectory = path.join(
    localAppData,
    "JetBrains",
    "Toolbox",
    "scripts",
  );
  for (const extension of WINDOWS_JETBRAINS_SHIM_EXTENSIONS) {
    const candidatePath = path.join(
      scriptsDirectory,
      `${toolbox.executable}${extension}`,
    );
    if (await windowsPathExists(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

async function findWindowsJetBrainsInstallPath(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const toolbox = getWindowsJetBrainsToolbox(definition);
  if (toolbox === null) {
    return null;
  }
  const launcherFileName = `${toolbox.executable}64.exe`;
  for (const root of getWindowsInstallRoots(runtime)) {
    const jetBrainsRoot = path.join(root, "JetBrains");
    const entries = await fs
      .readdir(jetBrainsRoot, { withFileTypes: true })
      .catch(() => null);
    if (entries === null) {
      continue;
    }
    const candidateDirectories = sortNewestNameFirst(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) =>
          toolbox.bundlePrefixes.some((prefix) =>
            name.toLowerCase().startsWith(prefix),
          ),
        ),
    );
    for (const directoryName of candidateDirectories) {
      const candidatePath = path.join(
        jetBrainsRoot,
        directoryName,
        "bin",
        launcherFileName,
      );
      if (await windowsPathExists(candidatePath)) {
        return candidatePath;
      }
    }
  }
  return null;
}

async function findWindowsExecutablePath(
  definition: LaunchAdapter,
  command: WindowsCommandAdapter,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<string | null> {
  const candidates = [command, ...(command.fallbackExecutables ?? [])];
  for (const candidate of candidates) {
    const resolved = await resolveExecutable({
      command: candidate.executable,
      env: runtime.env,
      platform: "win32",
    });
    if (resolved !== null) {
      return resolved;
    }
  }
  for (const candidate of candidates) {
    const appPath = await readWindowsAppPath(
      candidate.executable,
      runtime,
      cache,
    );
    if (appPath !== null) {
      return appPath;
    }
  }
  for (const candidatePath of getWindowsKnownExecutablePaths(
    definition,
    runtime,
  )) {
    if (await windowsPathExists(candidatePath)) {
      return candidatePath;
    }
  }
  const toolboxScriptPath = await findWindowsJetBrainsToolboxScriptPath(
    definition,
    runtime,
  );
  if (toolboxScriptPath !== null) {
    return toolboxScriptPath;
  }
  return findWindowsJetBrainsInstallPath(definition, runtime);
}

async function buildWindowsExecutableInvocation(
  executablePath: string,
  args: string[],
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WindowsLaunchInvocation> {
  if (
    !WINDOWS_CMD_SHIM_EXTENSIONS.has(path.extname(executablePath).toLowerCase())
  ) {
    return { file: executablePath, args, env: runtime.env };
  }
  const nodeShim = await readNodeCmdShim(executablePath);
  if (nodeShim !== null) {
    return {
      file: nodeShim.command,
      args: [...nodeShim.args, ...args],
      env: runtime.env,
    };
  }
  return {
    file: resolveWindowsSystemToolPath("cmd.exe", runtime.env),
    args: ["/d", "/c", executablePath, ...args],
    env: runtime.env,
  };
}

function resolveWindowsExplorerPath(
  runtime: WorkspaceOpenTargetRuntime,
): string {
  return path.join(
    readWindowsDirectoryEnvValue(runtime, "SystemRoot") ??
      WINDOWS_DEFAULT_SYSTEM_ROOT,
    "explorer.exe",
  );
}

function getWindowsCliOpenCommand(
  definition: LaunchAdapter,
): WindowsCommandAdapter | null {
  if (definition.macos.openMode === "default-app") {
    return null;
  }
  return (
    definition.macos.pathOpenCommand ?? definition.macos.lineOpenCommand ?? null
  );
}

function getWindowsRemoteSshOpenCommand(
  definition: LaunchAdapter,
): MacRemoteSshOpenCommandAdapter | null {
  if (definition.macos.openMode === "default-app") {
    return null;
  }
  return definition.macos.remoteSshOpenCommand ?? null;
}

async function isWindowsCliTargetAvailable(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<boolean> {
  const command = getWindowsCliOpenCommand(definition);
  return (
    command !== null &&
    (await findWindowsExecutablePath(definition, command, runtime, cache)) !==
      null
  );
}

async function findUnavailableWindowsRemoteSshExecutable(
  definition: LaunchAdapter,
  command: MacRemoteSshOpenCommandAdapter,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<string | null> {
  for (const executable of command.requiredExecutables ?? []) {
    if (
      (await resolveExecutable({
        command: executable,
        env: runtime.env,
        platform: "win32",
      })) === null
    ) {
      return executable;
    }
  }
  return (await findWindowsExecutablePath(
    definition,
    command,
    runtime,
    cache,
  )) === null
    ? command.executable
    : null;
}

async function toWindowsOpenTarget(
  definition: LaunchAdapter,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<WorkspaceOpenTarget | null> {
  if (!(await isWindowsCliTargetAvailable(definition, runtime, cache))) {
    return null;
  }
  const target: WorkspaceOpenTarget = {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    icon: definition.icon,
    capabilities: definition.capabilities,
  };
  const remoteSshOpenCommand = getWindowsRemoteSshOpenCommand(definition);
  if (
    remoteSshOpenCommand !== null &&
    (await findUnavailableWindowsRemoteSshExecutable(
      definition,
      remoteSshOpenCommand,
      runtime,
      cache,
    )) === null
  ) {
    target.remoteSshCapabilities = remoteSshOpenCommand.capabilities;
  }
  return target;
}

export async function listWindowsWorkspaceOpenTargets(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WorkspaceOpenTarget[]> {
  const cache: WindowsAppPathCache = new Map();
  const editors = await Promise.all(
    LAUNCH_ADAPTERS.map((definition) =>
      toWindowsOpenTarget(definition, runtime, cache),
    ),
  );
  return [
    ...editors.filter(isPresentTarget),
    {
      id: "default-app",
      label: "Default App",
      kind: "default-app",
      icon: { kind: "symbol", name: "default-app" },
      capabilities: BASIC_FILE_OPEN_CAPABILITIES,
    },
    {
      id: "file-manager",
      label: "File Manager",
      kind: "file-manager",
      icon: { kind: "symbol", name: "file-manager" },
      capabilities: FILE_MANAGER_OPEN_CAPABILITIES,
    },
    {
      id: "terminal",
      label: "Terminal",
      kind: "terminal",
      icon: { kind: "symbol", name: "terminal" },
      capabilities: BASIC_FILE_OPEN_CAPABILITIES,
    },
  ];
}

async function maybeResolveWindowsCliOpenInvocation(
  args: ResolveWindowsCliOpenArgs,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<WindowsLaunchInvocation | null> {
  if (args.definition.macos.openMode === "default-app") {
    return null;
  }
  const lineOpenCommand = args.definition.macos.lineOpenCommand;
  if (
    lineOpenCommand !== undefined &&
    args.lineNumber !== null &&
    args.existingPath.type === "file"
  ) {
    const executablePath = await findWindowsExecutablePath(
      args.definition,
      lineOpenCommand,
      runtime,
      cache,
    );
    if (executablePath !== null) {
      return buildWindowsExecutableInvocation(
        executablePath,
        lineOpenCommand.toArgs({
          columnNumber: lineOpenCommand.supportsColumn
            ? args.columnNumber
            : null,
          lineNumber: args.lineNumber,
          path: args.existingPath.path,
        }),
        runtime,
      );
    }
  }
  const pathOpenCommand = args.definition.macos.pathOpenCommand;
  if (pathOpenCommand === undefined) {
    return null;
  }
  const executablePath = await findWindowsExecutablePath(
    args.definition,
    pathOpenCommand,
    runtime,
    cache,
  );
  if (executablePath === null) {
    return null;
  }
  const openPath =
    args.existingPath.type === "file" &&
    args.definition.fileOpenBehavior === "containing-directory"
      ? path.dirname(args.existingPath.path)
      : args.existingPath.path;
  return buildWindowsExecutableInvocation(
    executablePath,
    pathOpenCommand.toArgs(openPath),
    runtime,
  );
}

function resolveWindowsDefaultAppInvocation(
  existingPath: ExistingPath,
  runtime: WorkspaceOpenTargetRuntime,
): WindowsLaunchInvocation {
  return {
    file: resolveWindowsExplorerPath(runtime),
    args: [existingPath.path],
    env: runtime.env,
    explorerPath: existingPath.path,
  };
}

function resolveWindowsFileManagerInvocation(
  existingPath: ExistingPath,
  runtime: WorkspaceOpenTargetRuntime,
): WindowsLaunchInvocation {
  return {
    file: resolveWindowsExplorerPath(runtime),
    args:
      existingPath.type === "file"
        ? [`/select,${existingPath.path}`]
        : [existingPath.path],
    env: runtime.env,
    explorerPath: existingPath.path,
  };
}

async function findWindowsTerminalExecutable(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<string | null> {
  const resolved = await resolveExecutable({
    command: WINDOWS_TERMINAL_COMMAND,
    env: runtime.env,
    platform: "win32",
  });
  if (resolved !== null) {
    return resolved;
  }
  const localAppData = readWindowsDirectoryEnvValue(runtime, "LOCALAPPDATA");
  if (localAppData === null) {
    return null;
  }
  const aliasPath = path.join(localAppData, ...WINDOWS_TERMINAL_ALIAS_SEGMENTS);
  return (await windowsPathExists(aliasPath)) ? aliasPath : null;
}

async function resolveWindowsTerminalInvocation(
  existingPath: ExistingPath,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WindowsLaunchInvocation> {
  const directory =
    existingPath.type === "file"
      ? path.dirname(existingPath.path)
      : existingPath.path;
  const windowsTerminalPath = await findWindowsTerminalExecutable(runtime);
  if (windowsTerminalPath !== null) {
    return {
      file: windowsTerminalPath,
      args: ["-d", directory],
      env: runtime.env,
      windowsHide: false,
    };
  }
  return {
    file: resolvePowerShellExecutable(runtime.env),
    args: ["-NoLogo"],
    cwd: directory,
    detached: true,
    env: runtime.env,
    windowsHide: false,
  };
}

async function resolveWindowsRemoteSshInvocation(
  args: ResolveWindowsRemoteSshOpenArgs,
  runtime: WorkspaceOpenTargetRuntime,
  cache: WindowsAppPathCache,
): Promise<WindowsLaunchInvocation> {
  const remoteSshOpenCommand = getWindowsRemoteSshOpenCommand(args.definition);
  if (remoteSshOpenCommand === null) {
    throw new WorkspaceOpenTargetError({
      code: "remote_target_unsupported",
      message: `${args.definition.label} cannot open remote SSH paths`,
    });
  }
  const unavailableExecutable = await findUnavailableWindowsRemoteSshExecutable(
    args.definition,
    remoteSshOpenCommand,
    runtime,
    cache,
  );
  if (unavailableExecutable !== null) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `${args.definition.label} remote SSH opener is unavailable: ${unavailableExecutable}`,
    });
  }
  const executablePath = await findWindowsExecutablePath(
    args.definition,
    remoteSshOpenCommand,
    runtime,
    cache,
  );
  if (executablePath === null) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `${args.definition.label} remote SSH opener is unavailable: ${remoteSshOpenCommand.executable}`,
    });
  }
  return buildWindowsExecutableInvocation(
    executablePath,
    remoteSshOpenCommand.toArgs({
      columnNumber: remoteSshOpenCommand.capabilities.openFileAtColumn
        ? args.columnNumber
        : null,
      lineNumber: remoteSshOpenCommand.capabilities.openFileAtLine
        ? args.lineNumber
        : null,
      path: args.path,
      sshAuthority: args.sshAuthority,
    }),
    runtime,
  );
}

async function resolveWindowsOpenInvocation(
  args: OpenPathInTargetArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WindowsLaunchInvocation> {
  const cache: WindowsAppPathCache = new Map();
  const definition = findWindowsLaunchAdapter(args.targetId);
  if (args.context.kind === "remote-ssh") {
    if (definition !== null && getWindowsRemoteSshOpenCommand(definition)) {
      return resolveWindowsRemoteSshInvocation(
        {
          columnNumber: args.columnNumber,
          definition,
          lineNumber: args.lineNumber,
          path: args.path,
          sshAuthority: args.context.sshAuthority,
        },
        runtime,
        cache,
      );
    }
    throw new WorkspaceOpenTargetError({
      code: "remote_target_unsupported",
      message: `${args.targetId} cannot open remote SSH paths`,
    });
  }

  if (
    WINDOWS_UNSUPPORTED_TARGET_ID_PREFIXES.some((prefix) =>
      args.targetId.startsWith(prefix),
    )
  ) {
    throw new WorkspaceOpenTargetError({
      code: "target_unavailable",
      message: `Workspace open target is unavailable: ${args.targetId}`,
    });
  }

  const existingPath = await requireOpenableWindowsPath(args.path);
  if (definition !== null) {
    const invocation = await maybeResolveWindowsCliOpenInvocation(
      {
        columnNumber: args.columnNumber,
        definition,
        existingPath,
        lineNumber: args.lineNumber,
      },
      runtime,
      cache,
    );
    if (invocation !== null) {
      return invocation;
    }
  }
  if (args.targetId === "default-app") {
    return resolveWindowsDefaultAppInvocation(existingPath, runtime);
  }
  if (args.targetId === "file-manager") {
    return resolveWindowsFileManagerInvocation(existingPath, runtime);
  }
  if (args.targetId === "terminal") {
    return resolveWindowsTerminalInvocation(existingPath, runtime);
  }
  throw new WorkspaceOpenTargetError({
    code: "target_unavailable",
    message: `Workspace open target is unavailable: ${args.targetId}`,
  });
}

export async function openWindowsPathInTarget(
  args: OpenPathInTargetArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<void> {
  const invocation = await resolveWindowsOpenInvocation(args, runtime);
  try {
    await runtime.execFile(invocation.file, invocation.args, {
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      ...(invocation.detached === undefined
        ? {}
        : { detached: invocation.detached }),
      env: invocation.env,
      ...(invocation.windowsHide === undefined
        ? {}
        : { windowsHide: invocation.windowsHide }),
    });
  } catch (error) {
    if (
      invocation.explorerPath !== undefined &&
      isExitCodeOneError(error) &&
      (await windowsPathExists(invocation.explorerPath))
    ) {
      return;
    }
    throw error;
  }
}
```

- [ ] **Step 5: Wire the dispatch in `index.ts`**

Three additions, nothing removed. First the import, beside the existing `./terminal.js` import:

```ts
import {
  listWindowsWorkspaceOpenTargets,
  openWindowsPathInTarget,
} from "./windows-launch.js";
```

Then the detached branch of `defaultExecFile` (change the `node:child_process` import to `import { execFile, spawn } from "node:child_process";`; the existing `execFileAsync` call keeps its body and only gains `windowsHide`, which Node documents as a no-op outside Windows):

```ts
async function defaultExecFile(
  file: string,
  args: string[],
  options?: ExecFileOptions,
): Promise<ExecFileResult> {
  if (options?.detached === true) {
    const child = spawn(file, args, {
      cwd: options.cwd,
      detached: true,
      env: sanitizeInheritedChildProcessEnv({
        env: options.env ?? process.env,
      }),
      stdio: "ignore",
      windowsHide: options.windowsHide ?? true,
    });
    child.unref();
    return { stdout: "" };
  }

  const result = await execFileAsync(file, args, {
    env: sanitizeInheritedChildProcessEnv({ env: options?.env ?? process.env }),
    windowsHide: options?.windowsHide ?? true,
  });
  return {
    stdout: result.stdout,
  };
}
```

Then the two dispatch arms. In `listWorkspaceOpenTargetsWithRuntime`, as the first statement of the body:

```ts
if (runtime.platform === "win32") {
  return listWindowsWorkspaceOpenTargets(runtime);
}
```

In `openPathInTargetWithRuntime`, as the first statement of the body:

```ts
if (runtime.platform === "win32") {
  await openWindowsPathInTarget(args, runtime);
  return;
}
```

`createWorkspaceOpenTargetRuntime`, `execInvocation` and every darwin/linux path stay exactly as Task 3 left them.

- [ ] **Step 6: Run the tests, typecheck and format**

Run: `pnpm --filter @bb/local-open-targets exec vitest run test/workspace-open-targets.test.ts`, then `pnpm exec turbo run typecheck --filter=@bb/local-open-targets --filter=@bb/host-daemon`, then `pnpm exec turbo run test --filter=@bb/local-open-targets`, then `pnpm exec oxfmt packages/local-open-targets/src/windows-launch.ts packages/local-open-targets/src/index.ts packages/local-open-targets/src/types.ts packages/local-open-targets/src/macos-launch-adapters.ts packages/local-open-targets/test/workspace-open-targets.test.ts`.
Expected: all green, including every darwin, linux and WSL case in the file, which must not change.
The PATH-discovery cases (`… on the Windows Path`, `… Windows Terminal at the containing directory`) run on every host and stay that way: Task 1's `resolveExecutable` builds each candidate with `joinExecutablePath`, which keeps a `/`-separated temp directory `/`-separated, so a POSIX host really finds the fixture files it wrote. No case in this file gets a platform guard it does not already have.

- [ ] **Step 7: Check the real desktop**

On the reference desktop run `pnpm --filter @bb/local-open-targets exec vitest run test/workspace-open-targets.test.ts` again so `lists the real open targets of this desktop` actually executes (it is skipped everywhere else), and open a workspace from the app in Explorer, in VS Code and in Windows Terminal once by hand. Capture the target list and the three launches in `qa/windows/phase-2/open-targets.md`.

- [ ] **Step 8: Commit**

```bash
git add packages/local-open-targets/src/windows-launch.ts packages/local-open-targets/src/index.ts packages/local-open-targets/src/types.ts packages/local-open-targets/src/macos-launch-adapters.ts packages/local-open-targets/test/workspace-open-targets.test.ts
git commit -m "Open workspaces in Explorer, editors and Windows Terminal on Windows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 11: Native folder picker on Windows

**Files:**

- Modify: `apps/host-daemon/src/command-handlers/native-folder-picker.ts` (rewrite around `pickHostFolderWithDeps`)
- Create: `apps/host-daemon/src/command-handlers/native-folder-picker.test.ts`
- Modify: `apps/host-daemon/src/local-api.ts:266` (`supportsNativeFolderPicker`)
- Modify: `apps/host-daemon/src/local-api.test.ts:191` (the matching status assertion)

**Interfaces:**

- Consumes: `resolvePowerShellExecutable(env)`, `POWERSHELL_NONINTERACTIVE_ARGS`, `sanitizeInheritedChildProcessEnv({ env, platform })` from `@bb/process-utils` (Task 1).
- Produces: `pickHostFolderWithDeps(deps: { env?: NodeJS.ProcessEnv; execFile?: NativeFolderPickerExecFile; platform?: NodeJS.Platform } = {})` beside the unchanged `pickHostFolder()` entry point that `command-dispatch.ts` already registers for `host.pick_folder`.

R12 keeps Desktop on the daemon picker, so the donor's `NativeFolderPickerDialog` / `setNativeFolderPickerDialogProvider` injection point is **not** ported: it is dead code in the donor (no caller anywhere in that tree) and R12 defers Electron dialog wiring. The wire contract is untouched — same `{ type: "host.pick_folder" }` request, same `{ path: string | null }` result, so `HOST_DAEMON_PROTOCOL_VERSION` stays 200.

- [ ] **Step 1: Write the failing tests**

Create `apps/host-daemon/src/command-handlers/native-folder-picker.test.ts`:

```ts
import { POWERSHELL_NONINTERACTIVE_ARGS } from "@bb/process-utils";
import { describe, expect, it } from "vitest";
import { pickHostFolderWithDeps } from "./native-folder-picker.js";

interface RecordedCall {
  args: string[];
  env?: NodeJS.ProcessEnv;
  file: string;
}

function createExecFile(options: {
  calls?: RecordedCall[];
  failure?: Error;
  stdout?: string;
}) {
  return async (
    file: string,
    args: string[],
    execOptions?: { env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string }> => {
    options.calls?.push({ file, args, env: execOptions?.env });
    if (options.failure !== undefined) {
      throw options.failure;
    }
    return { stdout: options.stdout ?? "" };
  };
}

describe("pickHostFolderWithDeps on Windows", () => {
  it("runs the folder browser dialog in a single-threaded apartment", async () => {
    const calls: RecordedCall[] = [];

    await expect(
      pickHostFolderWithDeps({
        env: {},
        execFile: createExecFile({
          calls,
          stdout: "C:\\Work\\bb\r\n",
        }),
        platform: "win32",
      }),
    ).resolves.toEqual({ path: "C:\\Work\\bb" });

    const call = calls[0];
    expect(call?.file.toLowerCase()).toMatch(/(?:pwsh|powershell)\.exe$/u);
    expect(call?.args.slice(0, POWERSHELL_NONINTERACTIVE_ARGS.length)).toEqual([
      ...POWERSHELL_NONINTERACTIVE_ARGS,
    ]);
    expect(call?.args.slice(POWERSHELL_NONINTERACTIVE_ARGS.length, -1)).toEqual(
      ["-STA", "-Command"],
    );
    const script = call?.args.at(-1) ?? "";
    expect(script).toContain("Add-Type -AssemblyName System.Windows.Forms");
    expect(script).toContain("System.Windows.Forms.FolderBrowserDialog");
    expect(script).toContain("$dialog.Description = 'Choose a project folder'");
    expect(script).toContain("$dialog.ShowNewFolderButton = $true");
    expect(script).toContain("$dialog.SelectedPath");
  });

  it("normalizes the selected path", async () => {
    const cases: Array<[string, string | null]> = [
      ["C:\\Work\\bb\\\r\n", "C:\\Work\\bb"],
      ["  C:\\Work\\My Project  \n", "C:\\Work\\My Project"],
      ["\r\n", null],
      ["", null],
      ["C:\\\r\n", "C:\\"],
    ];

    for (const [stdout, expected] of cases) {
      await expect(
        pickHostFolderWithDeps({
          env: {},
          execFile: createExecFile({ stdout }),
          platform: "win32",
        }),
      ).resolves.toEqual({ path: expected });
    }
  });

  it("reports a non-zero exit as a folder picker failure", async () => {
    await expect(
      pickHostFolderWithDeps({
        env: {},
        execFile: createExecFile({
          failure: Object.assign(new Error("Command failed: exit 1"), {
            code: 1,
          }),
        }),
        platform: "win32",
      }),
    ).rejects.toMatchObject({
      code: "folder_picker_failed",
      message: expect.stringContaining("Command failed"),
    });
  });
});

describe("pickHostFolderWithDeps on other platforms", () => {
  it("keeps the macOS osascript prompt", async () => {
    const calls: RecordedCall[] = [];

    await expect(
      pickHostFolderWithDeps({
        execFile: createExecFile({
          calls,
          stdout: "/Users/me/Projects/bb/\n",
        }),
        platform: "darwin",
      }),
    ).resolves.toEqual({ path: "/Users/me/Projects/bb" });
    expect(calls[0]?.file).toBe("osascript");
    expect(calls[0]?.args).toEqual([
      "-e",
      'try\nPOSIX path of (choose folder with prompt "Choose a project folder")\non error number -128\nreturn ""\nend try',
    ]);
  });

  it("rejects unsupported platforms", async () => {
    await expect(
      pickHostFolderWithDeps({
        execFile: createExecFile({}),
        platform: "linux",
      }),
    ).rejects.toMatchObject({
      code: "unsupported_platform",
      message: "Folder picker is only supported on macOS",
    });
  });
});
```

In `apps/host-daemon/src/local-api.test.ts` change the status assertion:

```ts
      supportsNativeFolderPicker:
        process.platform === "darwin" || process.platform === "win32",
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bb/host-daemon exec vitest run src/command-handlers/native-folder-picker.test.ts` and `pnpm --filter @bb/host-daemon exec vitest run src/local-api.test.ts`.
Expected: FAIL — `pickHostFolderWithDeps is not exported` for the first file; on Windows the second fails with `supportsNativeFolderPicker: false` against the expected `true` (on macOS and Linux the second file still passes, which is why the Windows run of Step 5 is the one that proves it).

- [ ] **Step 3: Rewrite the handler**

`apps/host-daemon/src/command-handlers/native-folder-picker.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import {
  POWERSHELL_NONINTERACTIVE_ARGS,
  resolvePowerShellExecutable,
  sanitizeInheritedChildProcessEnv,
} from "@bb/process-utils";
import { ExpectedCommandDispatchError } from "../command-dispatch-support.js";

const execFileAsync = promisify(execFile);

export type NativeFolderPickerExecFile = (
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

export interface NativeFolderPickerDeps {
  env?: NodeJS.ProcessEnv;
  execFile?: NativeFolderPickerExecFile;
  platform?: NodeJS.Platform;
}

type PickFolderResult = HostDaemonOnlineRpcResult<"host.pick_folder">;

const WINDOWS_FOLDER_PICKER_TITLE = "Choose a project folder";
const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:[\\/]$/u;
const WINDOWS_FOLDER_PICKER_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  `$dialog.Description = '${WINDOWS_FOLDER_PICKER_TITLE}'`,
  "$dialog.ShowNewFolderButton = $true",
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }",
].join("; ");

async function defaultExecFile(
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string }> {
  const result = await execFileAsync(file, args, {
    env: options?.env,
  });
  return { stdout: result.stdout };
}

function toPickFolderResult(selectedPath: string): PickFolderResult {
  const trimmedPath = selectedPath.trim();
  if (trimmedPath === "") {
    return { path: null };
  }
  if (WINDOWS_DRIVE_ROOT_PATTERN.test(trimmedPath)) {
    return { path: trimmedPath };
  }
  return { path: trimmedPath.replace(/[/\\]$/u, "") };
}

function toFolderPickerFailure(error: unknown): ExpectedCommandDispatchError {
  return new ExpectedCommandDispatchError(
    "folder_picker_failed",
    `Folder picker failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function pickMacOsFolder(
  execFileImpl: NativeFolderPickerExecFile,
): Promise<PickFolderResult> {
  let stdout: string;
  try {
    const result = await execFileImpl(
      "osascript",
      [
        "-e",
        'try\nPOSIX path of (choose folder with prompt "Choose a project folder")\non error number -128\nreturn ""\nend try',
      ],
      {
        env: sanitizeInheritedChildProcessEnv({ env: process.env }),
      },
    );
    stdout = result.stdout;
  } catch (error) {
    throw toFolderPickerFailure(error);
  }
  return toPickFolderResult(stdout);
}

async function pickWindowsFolder(
  execFileImpl: NativeFolderPickerExecFile,
  env: NodeJS.ProcessEnv,
): Promise<PickFolderResult> {
  let stdout: string;
  try {
    const result = await execFileImpl(
      resolvePowerShellExecutable(env),
      [
        ...POWERSHELL_NONINTERACTIVE_ARGS,
        "-STA",
        "-Command",
        WINDOWS_FOLDER_PICKER_SCRIPT,
      ],
      {
        env: sanitizeInheritedChildProcessEnv({ env, platform: "win32" }),
      },
    );
    stdout = result.stdout;
  } catch (error) {
    throw toFolderPickerFailure(error);
  }
  return toPickFolderResult(stdout);
}

export async function pickHostFolderWithDeps(
  deps: NativeFolderPickerDeps = {},
): Promise<PickFolderResult> {
  const platform = deps.platform ?? process.platform;
  const execFileImpl = deps.execFile ?? defaultExecFile;
  if (platform === "darwin") {
    return pickMacOsFolder(execFileImpl);
  }
  if (platform === "win32") {
    return pickWindowsFolder(execFileImpl, deps.env ?? process.env);
  }
  throw new ExpectedCommandDispatchError(
    "unsupported_platform",
    "Folder picker is only supported on macOS",
  );
}

export async function pickHostFolder(): Promise<PickFolderResult> {
  return pickHostFolderWithDeps();
}
```

The darwin arm is the HEAD body verbatim: the same `osascript` argument string, the same `sanitizeInheritedChildProcessEnv({ env: process.env })`, the same trim-then-strip-one-trailing-separator result. `toPickFolderResult` widens the stripped separator from `/` to `/` or `\` and pins drive roots, neither of which a macOS `POSIX path of` result can reach — it always ends in exactly one `/` for a folder, and never starts with a drive letter.

The refusal message stays the HEAD string, `Folder picker is only supported on macOS`, byte for byte. Only win32 gets a new arm; Linux and every other platform see exactly the code and the text they see today, so nothing a POSIX user can observe changes. Do not widen the sentence to "macOS and Windows".

- [ ] **Step 4: Advertise the capability**

`apps/host-daemon/src/local-api.ts`, in the `/status` handler:

```ts
      supportsNativeFolderPicker: platform === "darwin" || platform === "win32",
```

Nothing else changes: `useHostDaemon` and `usePathPickerHost` already gate `canUseNativeFolderPicker` on this flag plus `hostId === localDaemonHostId`, and `useLocalPathPicker` already falls back to the in-app `RemotePathBrowser` dialog when the RPC throws. The donor never touched `local-api.ts`, so without this line a working win32 picker would stay invisible to the app.

- [ ] **Step 5: Run the tests, typecheck and format**

Run: `pnpm --filter @bb/host-daemon exec vitest run src/command-handlers/native-folder-picker.test.ts`, then `pnpm --filter @bb/host-daemon exec vitest run src/local-api.test.ts`, then `pnpm exec turbo run typecheck --filter=@bb/host-daemon`, then `pnpm exec oxfmt apps/host-daemon/src/command-handlers/native-folder-picker.ts apps/host-daemon/src/command-handlers/native-folder-picker.test.ts apps/host-daemon/src/local-api.ts apps/host-daemon/src/local-api.test.ts`.
Expected: all green. Run the two suites file by file as above — the `@bb/host-daemon` suite is load-sensitive on Windows.

- [ ] **Step 6: Open the dialog by hand**

The dialog is interactive, so no automated test opens it. On the reference desktop run

```powershell
& (node -e "const {resolvePowerShellExecutable}=require('@bb/process-utils');console.log(resolvePowerShellExecutable(process.env))") -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Choose a project folder'; $dialog.ShowNewFolderButton = $true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }"
```

and confirm that the resolved interpreter accepts `-STA` (Windows PowerShell 5.1 always does; if the resolved `pwsh.exe` rejects the switch, record it as a Phase 2 finding and raise it before changing the pinned argument list). Then add a project from the app on Windows, pick a folder with a space in its name, cancel the dialog once, and record both outcomes in `qa/windows/phase-2/folder-picker.md`.

- [ ] **Step 7: Commit**

```bash
git add apps/host-daemon/src/command-handlers/native-folder-picker.ts apps/host-daemon/src/command-handlers/native-folder-picker.test.ts apps/host-daemon/src/local-api.ts apps/host-daemon/src/local-api.test.ts
git commit -m "Offer the native folder picker on Windows through PowerShell

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 12: Secret files fail closed on NTFS

**Files:**

- Create: `packages/secret-storage/src/windows-acl.ts`
- Create: `packages/secret-storage/test/windows-acl.test.ts`
- Create: `packages/secret-storage/test/windows-secret-file.test.ts`
- Modify: `packages/secret-storage/src/secret-file.ts` (win32 arms beside the untouched POSIX bodies; new `readSecretFile`)
- Modify: `packages/secret-storage/src/index.ts`
- Modify: `packages/secret-storage/package.json` (add `"@bb/process-utils": "workspace:*"`)
- Modify: `pnpm-lock.yaml` (regenerated by `pnpm install` after the dependency is added)
- Modify: `packages/secret-storage/test/secret-file.test.ts:41` (split the mode-bit assertion out)
- Modify: `packages/secret-storage/test/write-secret-file.test.ts:24-32` (split the mode-bit assertion out)
- Modify: `apps/server/src/services/plugins/plugin-settings.ts:1,15,42-55` (`readSecret` goes through `readSecretFile`; the `stat` check at line 173 stays)
- Modify: `apps/server/test/services/plugins/plugin-settings-storage.test.ts:170-187` (split the mode-bit assertion out, add the win32 ACL counterpart)

**Interfaces:**

- Consumes: `resolveWindowsSystemToolPath(name, env?)` and `spawnPortableOutputProcess({ command, args, platform })` from `@bb/process-utils` (Task 1). `spawnPortableOutputProcess` forwards to `spawnPortableProcess`, so on `platform: "win32"` the undefined `windowsHide` becomes `true` (R1) and the `icacls`/`whoami` probes never flash a console.
- Produces, from `@bb/secret-storage`:

```ts
export interface WindowsSecretUser {
  accountName: string;
  sid: string;
}
export interface WindowsAclCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
export type WindowsAclCommandRunner = (
  command: string,
  args: string[],
) => Promise<WindowsAclCommandResult>;
export interface WindowsAclDeps {
  env?: NodeJS.ProcessEnv;
  runCommand?: WindowsAclCommandRunner;
}
export interface WindowsFileAce {
  identity: string;
  rights: string;
}
export const SECRET_FILE_ACL_REMEDY: string;
export function parseWindowsUserCsv(stdout: string): WindowsSecretUser;
export function resolveCurrentWindowsUser(
  deps?: WindowsAclDeps,
): Promise<WindowsSecretUser>;
export function tightenSecretFileAcl(
  path: string,
  user: WindowsSecretUser,
  deps?: WindowsAclDeps,
): Promise<void>;
export function parseSecretFileAcl(
  path: string,
  stdout: string,
): WindowsFileAce[];
export function readSecretFileAcl(
  path: string,
  deps?: WindowsAclDeps,
): Promise<WindowsFileAce[]>;
export function assertSecretFileAclIsPrivate(
  path: string,
  aces: readonly WindowsFileAce[],
  user: WindowsSecretUser,
): void;
export function ensureSecretFileIsPrivate(
  path: string,
  deps?: WindowsAclDeps,
): Promise<void>;
export interface SecretFileOptions {
  platform?: NodeJS.Platform;
  deps?: WindowsAclDeps;
}
export function readSecretFile(
  path: string,
  options?: SecretFileOptions,
): Promise<string | undefined>;
export function writeSecretFile(
  path: string,
  value: string,
  options?: SecretFileOptions,
): Promise<void>;
// readOrCreateSecretFile args gain `platform?: NodeJS.Platform` and `deps?: WindowsAclDeps`
```

`assertSecretFileAclIsPrivate` takes `path` as its first parameter (the dispatch sketched `(aces, user)` but also requires the thrown message to name the path; the path is not recoverable from an ACE list, so it is a parameter).

**Measured on the reference desktop (2026-09-14, Windows 11 Pro 26200), and the reason every assertion below is shaped the way it is:**

- `whoami.exe /user /fo csv` prints a **localized** header row (`"Имя пользователя","SID"` on this box) followed by `"omen\olege","S-1-5-21-3327206002-2370753384-3252136475-1001"`. The parser therefore scans lines from the **last** one and takes the first row whose second field matches a SID, never the literal `"User Name"` header.
- `icacls.exe <file> /inheritance:r /grant:r *<SID>:F` exits `0` and prints a localized summary; `icacls.exe <file>` then prints `<path> OMEN\olege:(F)`, a **blank line**, and the localized `Successfully processed 1 files; Failed processing 0 files` line. ACE lines inside the block are separated by `\n`; the summary line ends `\r\n`.
- Additional ACEs appear as continuation lines indented to the width of the path, with the path omitted, e.g. a fresh temp file reads back as five inherited ACEs: `<path> OMEN\CodexSandboxUsers:(I)(M)`, then `S-1-5-21-3069236128-2815927062-1964413744-1774302275:(I)(M)` (an unresolvable SID prints bare, no `*`), then two localized built-in names, then `OMEN\olege:(I)(F)`.
- `icacls` on a missing path exits `2` and writes the reason to **stderr**.
- The DACL set on an empty file **survives** the later content write and survives `rename()` onto the final path (verified: `token.<hex>.tmp` tightened, written, renamed → read-back is still exactly `OMEN\olege:(F)`).
- `icacls` succeeds against a file this process holds open with `open(path, "r")`, so `readSecretFile` can open once, tighten, and read through the same handle.
- **`/inheritance:r /grant:r *<SID>:F` does not remove a pre-existing _explicit_ ACE.** A file additionally granted `*S-1-1-0` (Everyone) still reads back as two ACEs after tightening. Tightening therefore _cannot_ repair that file, and the correct behaviour is to fail closed: verification throws and the secret is never returned. Test 4 below asserts exactly that.
- Paths containing spaces and nested parents work unchanged because the arguments are an argv array (no shell, per Global Constraints).

- [ ] **Step 1: Write the failing unit tests for the parsers and the runner**

Create `packages/secret-storage/test/windows-acl.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assertSecretFileAclIsPrivate,
  parseSecretFileAcl,
  parseWindowsUserCsv,
  readSecretFileAcl,
  resolveCurrentWindowsUser,
  tightenSecretFileAcl,
  type WindowsAclCommandResult,
} from "../src/windows-acl.js";

const USER = {
  accountName: "omen\\olege",
  sid: "S-1-5-21-3327206002-2370753384-3252136475-1001",
};

const SECRET_PATH = "C:\\Users\\olege\\AppData\\Local\\Temp\\bb-acl\\secret";
const PAD = " ".repeat(SECRET_PATH.length + 1);
const SUMMARY =
  "\nSuccessfully processed 1 files; Failed processing 0 files\r\n";

const WHOAMI_CSV = `"\u0418\u043c\u044f \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f","SID"\r\n"omen\\olege","${USER.sid}"\r\n`;

function ok(stdout: string): WindowsAclCommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

describe("parseWindowsUserCsv", () => {
  it("takes the data row and ignores a localized header", () => {
    expect(parseWindowsUserCsv(WHOAMI_CSV)).toEqual(USER);
  });

  it("throws a descriptive error when no SID row is present", () => {
    expect(() => parseWindowsUserCsv('"SID"\r\n')).toThrow(
      /Could not read the current Windows user/u,
    );
  });
});

describe("parseSecretFileAcl", () => {
  it("reads a single tightened ACE and stops at the blank line", () => {
    expect(
      parseSecretFileAcl(
        SECRET_PATH,
        `${SECRET_PATH} OMEN\\olege:(F)\n${SUMMARY}`,
      ),
    ).toEqual([{ identity: "OMEN\\olege", rights: "(F)" }]);
  });

  it("reads indented continuation lines as further ACEs", () => {
    expect(
      parseSecretFileAcl(
        SECRET_PATH,
        `${SECRET_PATH} \u0412\u0441\u0435:(F)\n${PAD}OMEN\\olege:(F)\n${SUMMARY}`,
      ),
    ).toEqual([
      { identity: "\u0412\u0441\u0435", rights: "(F)" },
      { identity: "OMEN\\olege", rights: "(F)" },
    ]);
  });

  it("reads inherited rights and a bare unresolvable SID", () => {
    expect(
      parseSecretFileAcl(
        SECRET_PATH,
        `${SECRET_PATH} OMEN\\CodexSandboxUsers:(I)(M)\n${PAD}S-1-5-21-3069236128-2815927062-1964413744-1774302275:(I)(M)\n${PAD}OMEN\\olege:(I)(F)\n${SUMMARY}`,
      ),
    ).toEqual([
      { identity: "OMEN\\CodexSandboxUsers", rights: "(I)(M)" },
      {
        identity: "S-1-5-21-3069236128-2815927062-1964413744-1774302275",
        rights: "(I)(M)",
      },
      { identity: "OMEN\\olege", rights: "(I)(F)" },
    ]);
  });

  it("throws when the first line does not carry the requested path", () => {
    expect(() =>
      parseSecretFileAcl(SECRET_PATH, `C:\\other OMEN\\olege:(F)\n${SUMMARY}`),
    ).toThrow(/Could not parse the permissions/u);
    expect(() => parseSecretFileAcl(SECRET_PATH, "")).toThrow(
      /Could not parse the permissions/u,
    );
  });
});

describe("assertSecretFileAclIsPrivate", () => {
  it("accepts the account name case-insensitively", () => {
    expect(() =>
      assertSecretFileAclIsPrivate(
        SECRET_PATH,
        [{ identity: "OMEN\\OLEGE", rights: "(F)" }],
        USER,
      ),
    ).not.toThrow();
  });

  it("accepts a bare or starred SID identity", () => {
    for (const identity of [USER.sid, `*${USER.sid}`]) {
      expect(() =>
        assertSecretFileAclIsPrivate(
          SECRET_PATH,
          [{ identity, rights: "(F)" }],
          USER,
        ),
      ).not.toThrow();
    }
  });

  it("throws naming the path, the offending identities and the remedy", () => {
    expect(() =>
      assertSecretFileAclIsPrivate(
        SECRET_PATH,
        [
          { identity: "\u0412\u0441\u0435", rights: "(F)" },
          { identity: "OMEN\\olege", rights: "(F)" },
        ],
        USER,
      ),
    ).toThrow(
      new RegExp(
        `${SECRET_PATH.replace(/\\/gu, "\\\\")}[\\s\\S]*\u0412\u0441\u0435:\\(F\\)[\\s\\S]*NTFS volume`,
        "u",
      ),
    );
  });

  it("throws for inherited or partial rights and for a foreign single ACE", () => {
    expect(() =>
      assertSecretFileAclIsPrivate(
        SECRET_PATH,
        [{ identity: "OMEN\\olege", rights: "(OI)(CI)(M)" }],
        USER,
      ),
    ).toThrow(/is not restricted to/u);
    expect(() =>
      assertSecretFileAclIsPrivate(
        SECRET_PATH,
        [{ identity: "OMEN\\CodexSandboxUsers", rights: "(F)" }],
        USER,
      ),
    ).toThrow(/is not restricted to/u);
    expect(() => assertSecretFileAclIsPrivate(SECRET_PATH, [], USER)).toThrow(
      /is not restricted to/u,
    );
  });
});

describe("windows acl commands", () => {
  it("resolves the current user through whoami", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await expect(
      resolveCurrentWindowsUser({
        runCommand: async (command, args) => {
          calls.push({ command, args });
          return ok(WHOAMI_CSV);
        },
      }),
    ).resolves.toEqual(USER);
    expect(calls).toHaveLength(1);
    expect(calls[0].command.endsWith("whoami.exe")).toBe(true);
    expect(calls[0].args).toEqual(["/user", "/fo", "csv"]);
  });

  it("throws when whoami fails", async () => {
    await expect(
      resolveCurrentWindowsUser({
        runCommand: async () => ({
          stdout: "",
          stderr: "Access is denied.",
          exitCode: 1,
        }),
      }),
    ).rejects.toThrow(
      /Could not determine the current Windows user[\s\S]*denied/u,
    );
  });

  it("grants full control to the user's SID and nothing else", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await tightenSecretFileAcl(SECRET_PATH, USER, {
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return ok("");
      },
    });
    expect(calls[0].command.endsWith("icacls.exe")).toBe(true);
    expect(calls[0].args).toEqual([
      SECRET_PATH,
      "/inheritance:r",
      "/grant:r",
      `*${USER.sid}:F`,
    ]);
  });

  it("names the path and the remedy when icacls fails", async () => {
    const failing = async (): Promise<WindowsAclCommandResult> => ({
      stdout: "",
      stderr: `${SECRET_PATH}: The system cannot find the file specified.`,
      exitCode: 2,
    });
    await expect(
      tightenSecretFileAcl(SECRET_PATH, USER, { runCommand: failing }),
    ).rejects.toThrow(/bb-acl\\secret[\s\S]*NTFS volume/u);
    await expect(
      readSecretFileAcl(SECRET_PATH, { runCommand: failing }),
    ).rejects.toThrow(/bb-acl\\secret[\s\S]*NTFS volume/u);
  });

  it("reads the ACEs back through icacls", async () => {
    await expect(
      readSecretFileAcl(SECRET_PATH, {
        runCommand: async () =>
          ok(`${SECRET_PATH} OMEN\\olege:(F)\n${SUMMARY}`),
      }),
    ).resolves.toEqual([{ identity: "OMEN\\olege", rights: "(F)" }]);
  });
});
```

- [ ] **Step 2: Write the failing secret-file tests**

Create `packages/secret-storage/test/windows-secret-file.test.ts`:

```ts
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveWindowsSystemToolPath } from "@bb/process-utils";
import { afterEach, describe, expect, it } from "vitest";
import {
  readOrCreateSecretFile,
  readSecretFile,
  writeSecretFile,
} from "../src/index.js";
import {
  assertSecretFileAclIsPrivate,
  readSecretFileAcl,
  resolveCurrentWindowsUser,
  type WindowsAclCommandResult,
} from "../src/windows-acl.js";

const USER_SID = "S-1-5-21-3327206002-2370753384-3252136475-1001";
const WHOAMI_CSV = `"\u0418\u043c\u044f","SID"\r\n"omen\\olege","${USER_SID}"\r\n`;
const SUMMARY =
  "\nSuccessfully processed 1 files; Failed processing 0 files\r\n";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bb-win-secret-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => rm(tempDir, { force: true, recursive: true })),
  );
});

interface RecordedAclCall {
  command: string;
  args: string[];
  sizeAtCall: number;
}

function createFakeWindowsAcl(aclOutput?: (target: string) => string): {
  calls: RecordedAclCall[];
  runCommand: (
    command: string,
    args: string[],
  ) => Promise<WindowsAclCommandResult>;
} {
  const calls: RecordedAclCall[] = [];
  return {
    calls,
    runCommand: async (command, args) => {
      const target = args.length > 0 ? args[0] : "";
      let sizeAtCall = -1;
      try {
        sizeAtCall = (await stat(target)).size;
      } catch {}
      calls.push({ command, args, sizeAtCall });
      if (command.endsWith("whoami.exe")) {
        return { stdout: WHOAMI_CSV, stderr: "", exitCode: 0 };
      }
      if (args.length === 1) {
        return {
          stdout:
            aclOutput?.(target) ?? `${target} omen\\olege:(F)\n${SUMMARY}`,
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

function everyoneAcl(target: string): string {
  return `${target} \u0412\u0441\u0435:(F)\n${" ".repeat(target.length + 1)}omen\\olege:(F)\n${SUMMARY}`;
}

describe("secret files on win32 (injected runner)", () => {
  it("creates the file empty, tightens it, and only then writes the bytes", async () => {
    const dataDir = await makeTempDir();
    const acl = createFakeWindowsAcl();

    const secret = await readOrCreateSecretFile({
      bytes: 32,
      dataDir,
      encoding: "base64",
      fileName: "secret",
      platform: "win32",
      deps: { runCommand: acl.runCommand },
    });

    const secretPath = path.join(dataDir, "secret");
    expect((await readFile(secretPath, "utf8")).trim()).toBe(secret);
    const grant = acl.calls.find((call) =>
      call.args.includes("/inheritance:r"),
    );
    const verify = acl.calls.find(
      (call) => call.args.length === 1 && call.args[0] === secretPath,
    );
    expect(grant?.args).toEqual([
      secretPath,
      "/inheritance:r",
      "/grant:r",
      `*${USER_SID}:F`,
    ]);
    expect(grant?.sizeAtCall).toBe(0);
    expect(verify?.sizeAtCall).toBe(0);
  });

  it("removes the file it created when verification fails", async () => {
    const dataDir = await makeTempDir();
    const acl = createFakeWindowsAcl(everyoneAcl);

    await expect(
      readOrCreateSecretFile({
        bytes: 32,
        dataDir,
        encoding: "base64",
        fileName: "secret",
        platform: "win32",
        deps: { runCommand: acl.runCommand },
      }),
    ).rejects.toThrow(/is not restricted to/u);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("tightens the temp file before writing and renames it into place", async () => {
    const dir = await makeTempDir();
    const secretPath = path.join(dir, "token");
    const acl = createFakeWindowsAcl();

    await writeSecretFile(secretPath, "xoxb-123", {
      platform: "win32",
      deps: { runCommand: acl.runCommand },
    });

    expect(await readFile(secretPath, "utf8")).toBe("xoxb-123");
    expect(await readdir(dir)).toEqual(["token"]);
    const grant = acl.calls.find((call) =>
      call.args.includes("/inheritance:r"),
    );
    expect(grant?.args[0].endsWith(".tmp")).toBe(true);
    expect(grant?.sizeAtCall).toBe(0);
  });

  it("leaves no temp file behind when verification fails", async () => {
    const dir = await makeTempDir();
    const acl = createFakeWindowsAcl(everyoneAcl);

    await expect(
      writeSecretFile(path.join(dir, "token"), "xoxb-123", {
        platform: "win32",
        deps: { runCommand: acl.runCommand },
      }),
    ).rejects.toThrow(/is not restricted to/u);
    expect(await readdir(dir)).toEqual([]);
  });

  it("returns undefined for a missing secret without running icacls", async () => {
    const dir = await makeTempDir();
    const acl = createFakeWindowsAcl();

    await expect(
      readSecretFile(path.join(dir, "missing"), {
        platform: "win32",
        deps: { runCommand: acl.runCommand },
      }),
    ).resolves.toBeUndefined();
    expect(acl.calls).toEqual([]);
  });

  it("tightens an existing secret before handing back its content", async () => {
    const dir = await makeTempDir();
    const secretPath = path.join(dir, "token");
    await writeFile(secretPath, "xoxb-123", "utf8");
    const acl = createFakeWindowsAcl();

    await expect(
      readSecretFile(secretPath, {
        platform: "win32",
        deps: { runCommand: acl.runCommand },
      }),
    ).resolves.toBe("xoxb-123");
    expect(acl.calls.some((call) => call.args.includes("/inheritance:r"))).toBe(
      true,
    );
  });

  it("never runs icacls on the POSIX arm", async () => {
    const dir = await makeTempDir();
    const secretPath = path.join(dir, "token");
    const acl = createFakeWindowsAcl();

    await writeSecretFile(secretPath, "xoxb-123", {
      platform: "linux",
      deps: { runCommand: acl.runCommand },
    });
    await expect(
      readSecretFile(secretPath, {
        platform: "linux",
        deps: { runCommand: acl.runCommand },
      }),
    ).resolves.toBe("xoxb-123");
    await readOrCreateSecretFile({
      bytes: 8,
      dataDir: dir,
      encoding: "hex",
      fileName: "generated",
      platform: "linux",
      deps: { runCommand: acl.runCommand },
    });
    expect(acl.calls).toEqual([]);
  });
});

const runTool = promisify(execFile);

describe("secret files on real NTFS", () => {
  it.runIf(process.platform === "win32")(
    "creates a secret whose only ACE grants the current user full control",
    async () => {
      const dataDir = await makeTempDir();
      const secret = await readOrCreateSecretFile({
        bytes: 32,
        dataDir,
        encoding: "base64",
        fileName: "secret",
      });
      const secretPath = path.join(dataDir, "secret");
      expect((await readFile(secretPath, "utf8")).trim()).toBe(secret);

      const user = await resolveCurrentWindowsUser();
      const aces = await readSecretFileAcl(secretPath);
      expect(aces).toHaveLength(1);
      expect(() =>
        assertSecretFileAclIsPrivate(secretPath, aces, user),
      ).not.toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "writes a secret through a tightened temp file and leaves nothing behind",
    async () => {
      const dir = await makeTempDir();
      const secretPath = path.join(dir, "with space", "token");
      await writeSecretFile(secretPath, "xoxb-123");

      expect(await readFile(secretPath, "utf8")).toBe("xoxb-123");
      expect(await readdir(path.dirname(secretPath))).toEqual(["token"]);
      const user = await resolveCurrentWindowsUser();
      const aces = await readSecretFileAcl(secretPath);
      expect(aces).toHaveLength(1);
      expect(() =>
        assertSecretFileAclIsPrivate(secretPath, aces, user),
      ).not.toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "tightens an inherited ACL on the first read of an existing secret",
    async () => {
      const dataDir = await makeTempDir();
      const secretPath = path.join(dataDir, "secret");
      await writeFile(secretPath, "inherited-secret\n", "utf8");

      const before = await readSecretFileAcl(secretPath);
      expect(before.some((ace) => ace.rights.includes("(I)"))).toBe(true);

      await expect(
        readOrCreateSecretFile({
          bytes: 32,
          dataDir,
          encoding: "base64",
          fileName: "secret",
        }),
      ).resolves.toBe("inherited-secret");

      const user = await resolveCurrentWindowsUser();
      const after = await readSecretFileAcl(secretPath);
      expect(after).toHaveLength(1);
      expect(() =>
        assertSecretFileAclIsPrivate(secretPath, after, user),
      ).not.toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "refuses to hand back a secret that icacls cannot take away from Everyone",
    async () => {
      const dataDir = await makeTempDir();
      const secretPath = path.join(dataDir, "secret");
      await writeFile(secretPath, "shared-secret\n", "utf8");
      await runTool(
        resolveWindowsSystemToolPath("icacls.exe"),
        [secretPath, "/grant", "*S-1-1-0:F"],
        { windowsHide: true },
      );

      await expect(
        readOrCreateSecretFile({
          bytes: 32,
          dataDir,
          encoding: "base64",
          fileName: "secret",
        }),
      ).rejects.toThrow(/is not restricted to[\s\S]*NTFS volume/u);
      expect(await readFile(secretPath, "utf8")).toBe("shared-secret\n");
      expect((await readSecretFileAcl(secretPath)).length).toBeGreaterThan(1);
    },
  );
});
```

The last case pins the measured limit of `/inheritance:r /grant:r`: it replaces the ACE for the named SID and strips _inherited_ ACEs, but leaves other _explicit_ ACEs in place. Tightening cannot repair such a file, so the package fails closed, leaves the pre-existing file alone (it did not create it) and never returns the secret.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @bb/secret-storage exec vitest run test/windows-acl.test.ts test/windows-secret-file.test.ts`.
Expected: FAIL — `Cannot find module '../src/windows-acl.js'`, and `@bb/process-utils` is not resolvable from `@bb/secret-storage`.

- [ ] **Step 4: Add the dependency and the ACL module**

`packages/secret-storage/package.json`, in `dependencies` (keep the keys sorted):

```json
  "dependencies": {
    "@bb/process-utils": "workspace:*",
    "zod": "^4.3.6"
  },
```

Run `pnpm install` so the workspace link exists.

Create `packages/secret-storage/src/windows-acl.ts`:

```ts
import {
  resolveWindowsSystemToolPath,
  spawnPortableOutputProcess,
} from "@bb/process-utils";

export interface WindowsSecretUser {
  accountName: string;
  sid: string;
}

export interface WindowsAclCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type WindowsAclCommandRunner = (
  command: string,
  args: string[],
) => Promise<WindowsAclCommandResult>;

export interface WindowsAclDeps {
  env?: NodeJS.ProcessEnv;
  runCommand?: WindowsAclCommandRunner;
}

export interface WindowsFileAce {
  identity: string;
  rights: string;
}

export const SECRET_FILE_ACL_REMEDY =
  "Store the bb data directory on an NTFS volume where icacls can set permissions";

const WINDOWS_SID_PATTERN = /^S-\d+(?:-\d+)+$/u;
const WINDOWS_USER_CSV_ROW_PATTERN = /^"([^"]*)","([^"]*)"$/u;

function runWindowsAclTool(
  command: string,
  args: string[],
): Promise<WindowsAclCommandResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnPortableOutputProcess({
      command,
      args,
      platform: "win32",
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.once("error", rejectRun);
    child.once("close", (code) => {
      resolveRun({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
}

function describeCommandFailure(result: WindowsAclCommandResult): string {
  const detail = result.stderr.trim();
  const exit = `exited with ${String(result.exitCode)}`;
  return detail.length > 0 ? `${exit}: ${detail}` : exit;
}

export function parseWindowsUserCsv(stdout: string): WindowsSecretUser {
  const lines = stdout.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = WINDOWS_USER_CSV_ROW_PATTERN.exec(lines[index].trim());
    if (match === null) continue;
    const accountName = match[1];
    const sid = match[2];
    if (!WINDOWS_SID_PATTERN.test(sid)) continue;
    return { accountName, sid };
  }
  throw new Error(
    `Could not read the current Windows user from "whoami /user /fo csv" output: ${JSON.stringify(stdout)}`,
  );
}

let cachedWindowsUser: Promise<WindowsSecretUser> | undefined;

export async function resolveCurrentWindowsUser(
  deps: WindowsAclDeps = {},
): Promise<WindowsSecretUser> {
  const load = async (): Promise<WindowsSecretUser> => {
    const run = deps.runCommand ?? runWindowsAclTool;
    const command = resolveWindowsSystemToolPath("whoami.exe", deps.env);
    const result = await run(command, ["/user", "/fo", "csv"]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not determine the current Windows user: "${command} /user /fo csv" ${describeCommandFailure(result)}`,
      );
    }
    return parseWindowsUserCsv(result.stdout);
  };
  if (deps.runCommand !== undefined) {
    return load();
  }
  if (cachedWindowsUser === undefined) {
    cachedWindowsUser = load();
  }
  try {
    return await cachedWindowsUser;
  } catch (error) {
    cachedWindowsUser = undefined;
    throw error;
  }
}

export async function tightenSecretFileAcl(
  path: string,
  user: WindowsSecretUser,
  deps: WindowsAclDeps = {},
): Promise<void> {
  const run = deps.runCommand ?? runWindowsAclTool;
  const command = resolveWindowsSystemToolPath("icacls.exe", deps.env);
  const result = await run(command, [
    path,
    "/inheritance:r",
    "/grant:r",
    `*${user.sid}:F`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not restrict the secret file "${path}" to ${user.accountName}: icacls ${describeCommandFailure(result)}. ${SECRET_FILE_ACL_REMEDY}.`,
    );
  }
}

export function parseSecretFileAcl(
  path: string,
  stdout: string,
): WindowsFileAce[] {
  const aces: WindowsFileAce[] = [];
  let sawFirstLine = false;
  for (const rawLine of stdout.split(/\r?\n/u)) {
    if (rawLine.trim().length === 0) break;
    let line = rawLine;
    if (!sawFirstLine) {
      sawFirstLine = true;
      if (!line.startsWith(path)) {
        throw new Error(
          `Could not parse the permissions of the secret file "${path}": ${JSON.stringify(stdout)}`,
        );
      }
      line = line.slice(path.length);
    }
    const entry = line.trim();
    const separator = entry.lastIndexOf(":");
    if (separator <= 0) {
      throw new Error(
        `Could not parse the permissions of the secret file "${path}": ${JSON.stringify(stdout)}`,
      );
    }
    aces.push({
      identity: entry.slice(0, separator),
      rights: entry.slice(separator + 1),
    });
  }
  if (!sawFirstLine) {
    throw new Error(
      `Could not parse the permissions of the secret file "${path}": ${JSON.stringify(stdout)}`,
    );
  }
  return aces;
}

export async function readSecretFileAcl(
  path: string,
  deps: WindowsAclDeps = {},
): Promise<WindowsFileAce[]> {
  const run = deps.runCommand ?? runWindowsAclTool;
  const command = resolveWindowsSystemToolPath("icacls.exe", deps.env);
  const result = await run(command, [path]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not read the permissions of the secret file "${path}": icacls ${describeCommandFailure(result)}. ${SECRET_FILE_ACL_REMEDY}.`,
    );
  }
  return parseSecretFileAcl(path, result.stdout);
}

function isOwnerIdentity(
  ace: WindowsFileAce,
  user: WindowsSecretUser,
): boolean {
  const identity = ace.identity.startsWith("*")
    ? ace.identity.slice(1)
    : ace.identity;
  const normalized = identity.toLowerCase();
  return (
    normalized === user.accountName.toLowerCase() ||
    normalized === user.sid.toLowerCase()
  );
}

export function assertSecretFileAclIsPrivate(
  path: string,
  aces: readonly WindowsFileAce[],
  user: WindowsSecretUser,
): void {
  const offending = aces.filter(
    (ace) => !isOwnerIdentity(ace, user) || ace.rights !== "(F)",
  );
  if (aces.length === 1 && offending.length === 0) {
    return;
  }
  const listed =
    aces.length === 0
      ? "no entries"
      : aces.map((ace) => `${ace.identity}:${ace.rights}`).join(", ");
  throw new Error(
    `The secret file "${path}" is not restricted to ${user.accountName}: ${listed}. ${SECRET_FILE_ACL_REMEDY}.`,
  );
}

export async function ensureSecretFileIsPrivate(
  path: string,
  deps: WindowsAclDeps = {},
): Promise<void> {
  const user = await resolveCurrentWindowsUser(deps);
  await tightenSecretFileAcl(path, user, deps);
  assertSecretFileAclIsPrivate(path, await readSecretFileAcl(path, deps), user);
}
```

Identity comparison is deliberately name-or-SID: `icacls` resolves the granted SID back to a display name (`OMEN\olege`), so the granted `*<SID>` string never comes back verbatim, and built-in and foreign accounts render localized. A bare `S-1-…` identity (an unresolvable SID) is accepted only when it is the current user's own SID.

- [ ] **Step 5: Add the win32 arms to `secret-file.ts`**

Rewrite `packages/secret-storage/src/secret-file.ts` as below. Every POSIX statement is byte-identical to 07fdce05b; the win32 arms sit beside them and no POSIX call reaches `windows-acl.ts`.

```ts
import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ensureSecretFileIsPrivate,
  type WindowsAclDeps,
} from "./windows-acl.js";

export interface SecretFileOptions {
  platform?: NodeJS.Platform;
  deps?: WindowsAclDeps;
}

interface ReadOrCreateSecretFileArgs extends SecretFileOptions {
  bytes: number;
  dataDir: string;
  encoding: BufferEncoding;
  fileName: string;
}

const verifiedSecretPaths = new Set<string>();

async function ensureSecretFileIsPrivateOnce(
  path: string,
  options: SecretFileOptions,
): Promise<void> {
  const key = path.toLowerCase();
  if (verifiedSecretPaths.has(key)) return;
  await ensureSecretFileIsPrivate(path, options.deps ?? {});
  verifiedSecretPaths.add(key);
}

async function createPrivateSecretFile(
  path: string,
  options: SecretFileOptions,
): Promise<void> {
  const handle = await open(path, "wx");
  await handle.close();
  await ensureSecretFileIsPrivate(path, options.deps ?? {});
  verifiedSecretPaths.add(path.toLowerCase());
}

function errorCodeOf(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export async function readOrCreateSecretFile(
  args: ReadOrCreateSecretFileArgs,
): Promise<string> {
  await mkdir(args.dataDir, { recursive: true });
  const secretPath = join(args.dataDir, args.fileName);
  const platform = args.platform ?? process.platform;

  try {
    const existing = (await readFile(secretPath, "utf8")).trim();
    if (existing.length > 0) {
      if (platform === "win32") {
        await ensureSecretFileIsPrivateOnce(secretPath, { deps: args.deps });
      }
      return existing;
    }
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (errorCode !== "ENOENT") {
      throw error;
    }
  }

  const generatedSecret = randomBytes(args.bytes).toString(args.encoding);

  if (platform === "win32") {
    try {
      await createPrivateSecretFile(secretPath, { deps: args.deps });
    } catch (error) {
      if (errorCodeOf(error) !== "EEXIST") {
        await rm(secretPath, { force: true });
        throw error;
      }
      const racedSecret = (await readFile(secretPath, "utf8")).trim();
      if (racedSecret.length === 0) {
        throw new Error(`Failed to initialize secret at ${secretPath}`);
      }
      await ensureSecretFileIsPrivateOnce(secretPath, { deps: args.deps });
      return racedSecret;
    }
    try {
      await writeFile(secretPath, `${generatedSecret}\n`, { encoding: "utf8" });
    } catch (error) {
      await rm(secretPath, { force: true });
      throw error;
    }
    return generatedSecret;
  }

  try {
    await writeFile(secretPath, `${generatedSecret}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return generatedSecret;
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (errorCode !== "EEXIST") {
      throw error;
    }
  }

  const racedSecret = (await readFile(secretPath, "utf8")).trim();
  if (racedSecret.length === 0) {
    throw new Error(`Failed to initialize secret at ${secretPath}`);
  }
  return racedSecret;
}

export async function writeSecretFile(
  path: string,
  value: string,
  options: SecretFileOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;

  if ((options.platform ?? process.platform) === "win32") {
    try {
      await createPrivateSecretFile(tempPath, options);
      await writeFile(tempPath, value, { encoding: "utf8" });
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    verifiedSecretPaths.add(path.toLowerCase());
    return;
  }

  try {
    await writeFile(tempPath, value, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function readSecretFile(
  path: string,
  options: SecretFileOptions = {},
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== "win32") {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (errorCodeOf(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    await ensureSecretFileIsPrivateOnce(path, options);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function deleteSecretFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
```

`deleteSecretFile` stays byte-identical. The stale-`Set` case it could leave behind (delete then recreate, as `plugin-service.httpToken({ rotate: true })` does) is safe because the create path calls `createPrivateSecretFile`, which always tightens and verifies and never consults the `Set`.

`readSecretFile` opens the file **before** tightening so a missing secret is an `undefined`, not an `icacls` exit-2 error — `plugin-settings.readSecret` asks for unset secrets constantly. Measured: `icacls` succeeds against a file this process holds open for reading, so the tighten-then-read order holds.

`packages/secret-storage/src/index.ts`:

```ts
export {
  deleteSecretFile,
  readOrCreateSecretFile,
  readSecretFile,
  writeSecretFile,
  type SecretFileOptions,
} from "./secret-file.js";
export {
  assertSecretFileAclIsPrivate,
  ensureSecretFileIsPrivate,
  parseSecretFileAcl,
  parseWindowsUserCsv,
  readSecretFileAcl,
  resolveCurrentWindowsUser,
  SECRET_FILE_ACL_REMEDY,
  tightenSecretFileAcl,
  type WindowsAclCommandResult,
  type WindowsAclCommandRunner,
  type WindowsAclDeps,
  type WindowsFileAce,
  type WindowsSecretUser,
} from "./windows-acl.js";
```

- [ ] **Step 6: Route the server's secret reads through the package**

`apps/server/src/services/plugins/plugin-settings.ts` line 1 and line 15:

```ts
import { stat } from "node:fs/promises";
```

```ts
import {
  deleteSecretFile,
  readSecretFile,
  writeSecretFile,
} from "@bb/secret-storage";
```

Replace `readSecret` (lines 42-55) with:

```ts
async function readSecret(
  dataDir: string,
  pluginId: string,
  key: string,
): Promise<string | undefined> {
  return readSecretFile(secretFilePath(dataDir, pluginId, key));
}
```

On POSIX this is the same `readFile(..., "utf8")` with the same `ENOENT → undefined` and the same rethrow for every other code. The `stat`-based "is a secret set" check at line 173 is unchanged: it must not tighten or fail, it only reports presence.

- [ ] **Step 7: Split the mode-bit assertions onto POSIX**

`packages/secret-storage/test/secret-file.test.ts`: delete line 41 from `"reuses the same secret across repeated reads"` and add after that test:

```ts
it.skipIf(process.platform === "win32")(
  "creates the secret with 0600 mode",
  async () => {
    const dataDir = await makeTempDir();

    await readOrCreateSecretFile({
      bytes: 32,
      dataDir,
      encoding: "base64",
      fileName: "secret",
    });

    expect((await stat(path.join(dataDir, "secret"))).mode & 0o777).toBe(0o600);
  },
);
```

`packages/secret-storage/test/write-secret-file.test.ts`: rename the first test to `"writes the value, creating parent directories"`, delete its line 31, and add after it:

```ts
it.skipIf(process.platform === "win32")(
  "writes the value with 0600 mode",
  async () => {
    const dir = await makeTempDir();
    const secretPath = path.join(dir, "token");

    await writeSecretFile(secretPath, "xoxb-123");

    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
  },
);
```

`apps/server/test/services/plugins/plugin-settings-storage.test.ts`: rename the test at line 170 to `"round-trips secrets through private files and fires onChange with next/prev"`, delete its line 187 (`expect((await stat(secretPath)).mode & 0o777).toBe(0o600);`), and add two sibling tests right after it:

```ts
it.skipIf(process.platform === "win32")(
  "stores plugin secrets with 0600 mode",
  async () => {
    await installConfigurable();
    await service.updateSettings("configurable", { apiKey: "sk-secret-123" });

    const secretPath = join(
      dataDir,
      "plugins",
      "configurable",
      "secrets",
      "apiKey",
    );
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
  },
);

it.runIf(process.platform === "win32")(
  "stores plugin secrets with an ACL that names only the current user",
  async () => {
    await installConfigurable();
    await service.updateSettings("configurable", { apiKey: "sk-secret-123" });

    const secretPath = join(
      dataDir,
      "plugins",
      "configurable",
      "secrets",
      "apiKey",
    );
    const user = await resolveCurrentWindowsUser();
    const aces = await readSecretFileAcl(secretPath);
    expect(aces).toHaveLength(1);
    expect(() =>
      assertSecretFileAclIsPrivate(secretPath, aces, user),
    ).not.toThrow();
  },
);
```

and extend that file's `@bb/secret-storage` imports (it currently imports none) with:

```ts
import {
  assertSecretFileAclIsPrivate,
  readSecretFileAcl,
  resolveCurrentWindowsUser,
} from "@bb/secret-storage";
```

- [ ] **Step 8: Run the tests and typechecks**

Run, in order:

- `pnpm --filter @bb/secret-storage exec vitest run test/windows-acl.test.ts test/windows-secret-file.test.ts`
- `pnpm exec turbo run test --filter=@bb/secret-storage`
- `pnpm --filter @bb/server exec vitest run test/services/plugins/plugin-settings-storage.test.ts`
- `pnpm exec turbo run typecheck --filter=@bb/secret-storage --filter=@bb/server`

Expected: all green. On Windows the four `it.runIf(process.platform === "win32")` ACL cases actually run — confirm the run reports them as passed, not skipped (a skipped count of 4 in the secret-storage file means the guard is wrong). On WSL the same file reports 4 skipped and the injected-runner cases still pass. `countOpenFdsFor` in the server test reads `/proc/self/fd`; it is already POSIX-only in that file and is not touched here.

- [ ] **Step 9: Format and commit**

```bash
pnpm exec oxfmt packages/secret-storage/src/windows-acl.ts packages/secret-storage/src/secret-file.ts packages/secret-storage/src/index.ts packages/secret-storage/test/windows-acl.test.ts packages/secret-storage/test/windows-secret-file.test.ts packages/secret-storage/test/secret-file.test.ts packages/secret-storage/test/write-secret-file.test.ts apps/server/src/services/plugins/plugin-settings.ts apps/server/test/services/plugins/plugin-settings-storage.test.ts
git add packages/secret-storage/package.json packages/secret-storage/src/windows-acl.ts packages/secret-storage/src/secret-file.ts packages/secret-storage/src/index.ts packages/secret-storage/test/windows-acl.test.ts packages/secret-storage/test/windows-secret-file.test.ts packages/secret-storage/test/secret-file.test.ts packages/secret-storage/test/write-secret-file.test.ts apps/server/src/services/plugins/plugin-settings.ts apps/server/test/services/plugins/plugin-settings-storage.test.ts pnpm-lock.yaml
git commit -m "Protect secret files with an exclusive NTFS ACL on Windows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

Out of scope for this task and already recorded in R13, to be listed in `docs/platform-windows.md` by Task 14: `plugins/account-pool/src/store.ts`, `plugins/secrets/src/server.ts`, `apps/host-daemon/src/auth-state.ts` and `apps/host-daemon/src/identity.ts` keep their own `mode: 0o600` writes and get no NTFS ACL.

---

### Task 13: Junction refusals and the Claude Code skills link

**Files:**

- Modify: `apps/host-daemon/src/command-handlers/path-mutations.test.ts` (add a `describe.runIf` block after the existing `"rejects symlink escapes…"` test; that test is untouched)
- Modify: `plugins/provider-claude-code/src/bridge/skill-plugins.ts:51-89`
- Modify: `plugins/provider-claude-code/src/bridge/__tests__/skill-plugins.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `ensureClaudeSkillPlugin(args: { pluginsRoot: string; root: ClaudeSkillPluginRoot; takenNames?: Map<string, string>; platform?: NodeJS.Platform }): string` — `platform` defaults to `process.platform` and selects the `fs.symlink` type only.

**Per R14 there is no production change in `apps/host-daemon/src/command-handlers/path-mutations.ts` or `root-path.ts`.** Measured on the reference desktop (2026-09-14): `fs.lstat` on a junction reports `isSymbolicLink() === true` and `isDirectory() === false`, so `requireExistingWithin`'s existing `isSymbolicLink()` gate already refuses a junction handed in directly, and `fs.realpath` already resolves _through_ a junction so the `isPathWithinRoot` check already catches an escape. The new tests are pins, not a fix: they must pass on the first run, and a failure is a real refusal gap to be fixed before the commit, not a test to relax.

Also measured, and what the third test asserts: `fs.rm(<resolved real path>)` through a junction deletes only the resolved file and leaves the target directory's other files in place; `fs.rm(<junction>, { recursive: true })` and `fs.rmdir(<junction>)` delete only the reparse point and leave the target's contents intact. `fs.symlink(target, link, "junction")` needs neither elevation nor Developer Mode.

- [ ] **Step 1: Write the junction tests**

In `apps/host-daemon/src/command-handlers/path-mutations.test.ts`, after `"rejects symlink escapes and refuses to remove the declared root"` and still inside `describe("confined host path mutations", …)`:

```ts
describe.runIf(process.platform === "win32")("junctions", () => {
  it("refuses to remove a file reached through a junction that leaves the root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const link = path.join(root, "outside");
    await fs.symlink(outside, link, "junction");
    await fs.writeFile(path.join(outside, "secret.md"), "secret");

    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: path.join(link, "secret.md"),
        rootPath: root,
        recursive: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      fs.readFile(path.join(outside, "secret.md"), "utf8"),
    ).resolves.toBe("secret");
  });

  it("refuses to move a junction and leaves its target untouched", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const link = path.join(root, "outside");
    await fs.symlink(outside, link, "junction");
    await fs.writeFile(path.join(outside, "secret.md"), "secret");

    const info = await fs.lstat(link);
    expect(info.isSymbolicLink()).toBe(true);
    expect(info.isDirectory()).toBe(false);

    await expect(
      moveHostPath({
        type: "host.move_path",
        sourcePath: link,
        destinationPath: path.join(root, "moved"),
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(fs.readdir(outside)).resolves.toEqual(["secret.md"]);
    await expect(fs.readdir(root)).resolves.toEqual(["outside"]);
  });

  it("refuses a junction substituted for a working directory and removes only the resolved path when the junction stays inside the root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await fs.writeFile(path.join(outside, "keep.md"), "keep");
    await fs.writeFile(path.join(outside, "target.md"), "target");
    const substituted = path.join(root, "workdir");
    await fs.symlink(outside, substituted, "junction");

    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: path.join(substituted, "target.md"),
        rootPath: root,
        recursive: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(fs.readdir(outside)).resolves.toEqual([
      "keep.md",
      "target.md",
    ]);

    const inside = path.join(root, "real");
    await fs.mkdir(inside);
    await fs.writeFile(path.join(inside, "keep.md"), "keep");
    await fs.writeFile(path.join(inside, "target.md"), "target");
    const insideLink = path.join(root, "insidelink");
    await fs.symlink(inside, insideLink, "junction");

    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: path.join(insideLink, "target.md"),
        rootPath: root,
        recursive: false,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.readdir(inside)).resolves.toEqual(["keep.md"]);
    expect((await fs.lstat(insideLink)).isSymbolicLink()).toBe(true);
  });
});
```

The third test is the substitution race made deterministic: the junction is put in place _before_ the call, which is the worst case an attacker who wins the race between `lstat` and `realpath` can produce. Its second half pins the consequence of the resolution that follows a permitted junction — `removeHostPath` acts on the `realpath` result, so only `target.md` is deleted, `keep.md` survives, and the junction itself is left in place.

The existing `"rejects symlink escapes and refuses to remove the declared root"` test and its bare `fs.symlink(outside, link)` call are not touched.

- [ ] **Step 2: Write the failing skills-link tests**

In `plugins/provider-claude-code/src/bridge/__tests__/skill-plugins.test.ts`, after `"assembles a plugin whose skills directory links to the generic root"`:

```ts
it("links the skills directory as a junction on Windows", () => {
  const pluginsRoot = createClaudeSkillPluginsRoot(baseDir);
  const skillsPath = stageSkills("win");

  const pluginPath = ensureClaudeSkillPlugin({
    pluginsRoot,
    root: { id: "win", path: skillsPath },
    platform: "win32",
  });

  const skillsLink = join(pluginPath, "skills");
  expect(lstatSync(skillsLink).isSymbolicLink()).toBe(true);
  expect(readlinkSync(skillsLink)).toBe(skillsPath);
  expect(readFileSync(join(skillsLink, "demo", "SKILL.md"), "utf8")).toContain(
    "name: demo",
  );

  expect(
    ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "win", path: skillsPath },
      platform: "win32",
    }),
  ).toBe(pluginPath);
  expect(readlinkSync(skillsLink)).toBe(skillsPath);
});

it.skipIf(process.platform === "win32")(
  "links the skills directory as a directory symlink off Windows",
  () => {
    const pluginsRoot = createClaudeSkillPluginsRoot(baseDir);
    const skillsPath = stageSkills("posix");

    const pluginPath = ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "posix", path: skillsPath },
      platform: "linux",
    });

    const skillsLink = join(pluginPath, "skills");
    expect(lstatSync(skillsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(skillsLink)).toBe(skillsPath);
  },
);
```

The junction case runs on every OS: Node ignores the `"junction"` type on POSIX and creates an ordinary symlink there, so the assertions hold on Linux and macOS too. The injected-`"linux"` case is skipped on win32 because a `"dir"` symlink there needs Developer Mode or elevation — which is precisely the failure R14 removes. (Measured: this reference desktop happens to permit `"dir"` symlinks, so the skip guard is about stock machines, not about this box.)

- [ ] **Step 3: Run the tests to verify the expected result**

Run:

- `pnpm --filter @bb/host-daemon exec vitest run src/command-handlers/path-mutations.test.ts`
- `pnpm --filter bb-plugin-provider-claude-code exec vitest run src/bridge/__tests__/skill-plugins.test.ts`

Expected: the host-daemon file is green on Windows with 3 added junction tests reported as passed (on WSL they report as skipped). The skill-plugins file FAILS with `Object literal may only specify known properties, and 'platform' does not exist` at typecheck and, at runtime, `readlinkSync` mismatches are not reached because the extra property is ignored — the run must be treated as failing until Step 4 lands.

- [ ] **Step 4: Create the skills link as a junction on Windows**

`plugins/provider-claude-code/src/bridge/skill-plugins.ts`, the signature at line 51 and the link creation at line 86:

```ts
export function ensureClaudeSkillPlugin(args: {
  pluginsRoot: string;
  root: ClaudeSkillPluginRoot;
  takenNames?: Map<string, string>;
  platform?: NodeJS.Platform;
}): string {
```

```ts
if (current !== args.root.path) {
  rmSync(skillsLink, { recursive: true, force: true });
  symlinkSync(
    args.root.path,
    skillsLink,
    (args.platform ?? process.platform) === "win32" ? "junction" : "dir",
  );
}
```

Everything else in the function — the manifest write, the `lstatSync`/`readlinkSync` comparison that decides whether to re-point the link, and the returned `pluginPath` — is unchanged. `readlinkSync` on a junction returns the absolute target with no `\\?\` prefix and no trailing separator (measured), so the `current !== args.root.path` comparison keeps working and the plugin directory stays idempotent across calls. `bridge.ts` calls the function without `platform`, so it keeps reading `process.platform` at that composition root.

- [ ] **Step 5: Run the tests and typechecks**

Run:

- `pnpm --filter bb-plugin-provider-claude-code exec vitest run src/bridge/__tests__/skill-plugins.test.ts`
- `pnpm --filter @bb/host-daemon exec vitest run src/command-handlers/path-mutations.test.ts`
- `pnpm exec turbo run typecheck --filter=bb-plugin-provider-claude-code --filter=@bb/host-daemon`
- `pnpm exec turbo run test --filter=bb-plugin-provider-claude-code`

Expected: all green on Windows and on WSL.

- [ ] **Step 6: Format and commit**

```bash
pnpm exec oxfmt apps/host-daemon/src/command-handlers/path-mutations.test.ts plugins/provider-claude-code/src/bridge/skill-plugins.ts plugins/provider-claude-code/src/bridge/__tests__/skill-plugins.test.ts
git add apps/host-daemon/src/command-handlers/path-mutations.test.ts plugins/provider-claude-code/src/bridge/skill-plugins.ts plugins/provider-claude-code/src/bridge/__tests__/skill-plugins.test.ts
git commit -m "Pin junction refusals on Windows and link Claude Code skills as a junction

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4"
```

---

### Task 14: Documentation

**Files:**

- Modify: `docs/platform-windows.md` (status table, new `## Processes, hooks, git and open targets (Phase 2)` section, new `## Known limitations after Phase 2` section, `## Evidence` section)
- Modify: `docs/platform-support.md` (one sentence)
- Modify: `docs/worktrees.md` (hook sections and troubleshooting checklist)
- Modify: `docs/configuration.md` (hook paragraph)
- Modify: `docs/cli-guide-and-skill.md` (hook paragraph)
- Modify: `packages/templates/src/templates/bb-guide-environments.md`, `packages/templates/src/templates/bb-guide-overview.md`
- Modify: `plugins/bb-guide/skills/bb-cli/references/configuration.md`, `plugins/bb-guide/skills/bb-cli/references/thread-creation.md`
- Unchanged: `plugins/automations/skills/automations/references/creation.md` and `plugins/automations/skills/automations/SKILL.md` — Task 7 Step 7 owns both; Step 13 here only verifies them
- Modify: `docs/api_to_audit.md` (extend the `experimental_killProcessesWithCwdUnder` entry; confirm the `experimental_sanitizeInheritedChildProcessEnv` entry already covers the win32 single-`Path` arm)

**Interfaces:**

- Consumes: `WINDOWS_ENV_SETUP_SCRIPT_NAME = ".bb-env-setup.ps1"`, `WINDOWS_ENV_TEARDOWN_SCRIPT_NAME = ".bb-env-teardown.ps1"` (Task 5, `packages/domain/src/setup-script.ts`); `automationScriptInterpreterSchema` gaining `"powershell"` (Task 7); `apps/cli/bin/bb.cmd` (Task 8); `SkippedProcessEvent`, `WindowsSweepMatchEvidence`, `WINDOWS_PROCESS_ENUM_TIMEOUT_MS` (Tasks 1–2); every ruling R1–R18 and spec §6/§7/§9.
- Produces: no code. Documentation only.

- [ ] **Step 1: `docs/platform-windows.md` — status row**

Before:

```markdown
| 2 Processes, environment, Git, hooks, open targets | not started |
```

After:

```markdown
| 2 Processes, environment, Git, hooks, open targets | landed; evidence under `qa/windows/phase-2/` |
```

- [ ] **Step 2: `docs/platform-windows.md` — new Phase 2 section**

Insert immediately after the "Host identity and paths (Phase 1)" section (after its last bullet, the one ending "...predates this branch and is not changed by it.", and before the `## Known limitations after Phase 0` heading):

```markdown
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
- **PATH resolution.** `runtime-shell-env.ts` on win32 reads
  `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path` and
  `HKCU\Environment\Path` through `reg.exe query … /v Path` (REG_EXPAND_SZ
  expanded against the daemon's own environment), joins machine then user,
  then runs a PowerShell profile probe (`pwsh.exe` if found, else
  `powershell.exe`) that prints `__BB_SHELL_ENV_START__`, base64
  `Name=Value` pairs, `__BB_SHELL_ENV_END__`. Precedence: the probe's `Path`
  wins when the last marker pair parses; otherwise the registry PATH;
  otherwise the daemon's own inherited `Path`. The probe timeout is 8 seconds
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
  gate failure.
- **Process sweep.** `killProcessesWithCwdUnder` (used to reap a managed
  workspace before removing it) enumerates with `Get-CimInstance
Win32_Process` (measured cost about 1.2 s) instead of reading `cwd` from
  `/proc`, so every Windows match carries `approximateCwd: true` and a
  `matchEvidence` of `"spawn-registry"` (bb itself spawned the process with a
  known cwd), `"executable-path"` (the process's own exe path is under the
  directory), `"command-line"` (the directory string appears in the process's
  command line), or `"descendant"` (a child of an already-matched process). A
  10-second enumeration timeout is an error (`WindowsProcessEnumerationError`),
  never an empty list — an empty list would look like "nothing to kill" and
  leave a live tree behind. Because there is no real cwd query, two mismatches
  are possible and are reproduced in `qa/windows/phase-2/26-process-enumeration.md`:
  an **under-match**, a process whose cwd is genuinely under the directory but
  whose command line and executable path do not mention it (a real target the
  sweep misses), and an **over-match**, a process whose command line happens
  to contain the directory path as an argument while its cwd is elsewhere (a
  false positive the sweep would kill).
- **Secrets.** `@bb/secret-storage` on win32 creates a secret file empty with
  `wx`, tightens it with `icacls.exe <file> /inheritance:r /grant:r *<SID>:F`
  (the SID from `whoami.exe /user /fo csv`, cached per process), and reads the
  ACL back with `icacls.exe <file>`: the output must be exactly one ACE line
  whose identity is the current account name or SID and whose rights are
  `(F)`, or the write is rejected. Only after that read-back succeeds are the
  secret bytes written (a temp file for `writeSecretFile`, then rename). An
  existing file is tightened and verified the same way on first read per
  process. Any failure in this sequence removes the empty or temp file and
  throws an error naming the path and the remedy: put the data directory on
  an NTFS volume. `plugins/account-pool`, `plugins/secrets`, and the host
  daemon's own `auth-state.ts` and `identity.ts` files are out of scope — see
  Known limitations.
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
  `cmd.exe /d /c <shim>` for a shim that is not a recognized node wrapper.
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
  Homebrew fallback paths are POSIX-only and are not tried); interpreter
  commands (`node`, `python3` then `python`, `pwsh` then `powershell`) are
  resolved through `resolveExecutable` instead of spawned by bare name.
  `"powershell"` on POSIX resolves to `pwsh`. The extension mapping is not
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
```

- [ ] **Step 3: `docs/platform-windows.md` — Known limitations after Phase 2**

Insert a new section after `## Known limitations after Phase 1` (after its last bullet, "Provider containment ... pre-existing behavior, now applied to path keys.") and before `## Evidence`:

```markdown
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
```

- [ ] **Step 4: `docs/platform-windows.md` — Evidence section**

Before:

```markdown
`qa/windows/phase-1/` holds host facts (`00-host.md`), the build and
typecheck log (`30-build-typecheck.txt`), the per-package test results and
output tail (`31-test-results.md`, `31-test-output-tail.txt`), a UI- and
CLI-created project on `C:\` (`20-project-on-c.md`), three path spellings
resolving to one project id plus a UNC 400 (`21-path-identity.md`), a managed
worktree provisioned and removed (`22-managed-worktree.md`), the WSL POSIX
test run (`40-posix-check.md`), and the `windows-x64` CI run
(`41-ci-run.md`).
```

After (append a new paragraph):

```markdown
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
```

- [ ] **Step 5: `docs/platform-support.md` — Phase 2 landed in the fork branch**

Before (in "Maintainer-only or best-effort surfaces"):

```markdown
- native Windows PowerShell, CMD, and host-daemon runtime flows; the in-progress
  native port and its measured state are tracked in
  [platform-windows.md](platform-windows.md)
```

After:

```markdown
- native Windows PowerShell, CMD, and host-daemon runtime flows; the in-progress
  native port and its measured state are tracked in
  [platform-windows.md](platform-windows.md). Phase 2 (processes, environment,
  Git, hooks, open targets) has landed on the `windows-native/phase-2` fork
  branch; it has not merged to `main` and does not change the supported
  product path above.
```

- [ ] **Step 6: `docs/worktrees.md` — setup hook contract**

Before (the "Run setup" section's contract list):

```markdown
- The script runs with `env bash`, working directory set to the new worktree.
- stdin is closed. stdout and stderr stream into the thread's provisioning
  transcript in the app.
- A non-zero exit, a signal, or a timeout (15 minutes) fails provisioning and
  the thread doesn't start.
- POSIX only — supported on macOS, Linux, and WSL2. Native Windows isn't
  supported; bb reports that POSIX shell scripts are unsupported on Windows.
```

After:

```markdown
- The script runs with `env bash`, working directory set to the new worktree.
  On a native Windows host bb instead looks for `.bb-env-setup.ps1` and runs
  it with `pwsh.exe` (or `powershell.exe`) `-NoLogo -NoProfile -NonInteractive
-ExecutionPolicy Bypass -File`; a `.sh`-only script on Windows fails setup
  naming the `.ps1` contract instead of running.
- stdin is closed. stdout and stderr stream into the thread's provisioning
  transcript in the app.
- A non-zero exit, a signal, or a timeout (15 minutes) fails provisioning and
  the thread doesn't start.
- Supported on macOS, Linux, WSL2, and — for `.bb-env-setup.ps1` — native
  Windows (in progress; see [platform-windows.md](platform-windows.md)).
```

- [ ] **Step 7: `docs/worktrees.md` — teardown hook contract**

Before:

```markdown
- bb runs the script before calling a provider to remove a path it owns,
  including cleanup after failed setup. Attached paths do not run it.
- bb runs `env bash .bb-env-teardown.sh` from the worktree before it removes
  the worktree, so the script can read tracked and generated files.
- stdin is closed. bb records stdout and stderr in the server lifecycle logs.
- The script gets a separate 15-minute timeout.
- A non-zero exit, a signal, or a timeout reports a failure. It never stops bb
  from removing the worktree.
- The script receives the same sanitized environment as the setup script.
- POSIX only — supported on macOS, Linux, and WSL2. Native Windows isn't
  supported; bb reports that POSIX shell scripts are unsupported on Windows.
```

After:

```markdown
- bb runs the script before calling a provider to remove a path it owns,
  including cleanup after failed setup. Attached paths do not run it.
- bb runs `env bash .bb-env-teardown.sh` from the worktree before it removes
  the worktree, so the script can read tracked and generated files. On native
  Windows bb runs `.bb-env-teardown.ps1` the same way it runs the setup hook.
- stdin is closed. bb records stdout and stderr in the server lifecycle logs.
- The script gets a separate 15-minute timeout.
- A non-zero exit, a signal, or a timeout reports a failure. It never stops bb
  from removing the worktree.
- The script receives the same sanitized environment as the setup script.
- Supported on macOS, Linux, WSL2, and — for `.bb-env-teardown.ps1` — native
  Windows (in progress; see [platform-windows.md](platform-windows.md)).
```

- [ ] **Step 8: `docs/worktrees.md` — troubleshooting checklist**

Before item 2:

```markdown
2. If `.bb-env-setup.sh` doesn't seem to run, make sure it's committed to
   the branch you're working from. A file that exists only in the working
   copy of your main checkout won't appear in the new worktree.
```

After:

```markdown
2. If `.bb-env-setup.sh` (or `.bb-env-setup.ps1` on Windows) doesn't seem to
   run, make sure it's committed to the branch you're working from. A file
   that exists only in the working copy of your main checkout won't appear in
   the new worktree.
```

Leave items 3–5 unchanged and append a new item 6 after item 5 ("Run `bash .bb-env-teardown.sh` manually before you delete a test worktree. Confirm that repeated runs do not fail or remove shared resources."):

```markdown
6. On Windows, run
   `pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .bb-env-setup.ps1`
   (or the equivalent for `.bb-env-teardown.ps1`) manually before debugging
   through the provisioning transcript.
```

- [ ] **Step 9: `docs/configuration.md` — hook paragraph**

Before:

```markdown
Commit `.bb-env-setup.sh` when a managed worktree needs repository setup.
Commit `.bb-env-teardown.sh` when bb must release external resources before it
removes that worktree. See [Worktrees, setup scripts, and teardown
scripts](worktrees.md) for the lifecycle, environment, timeout, and failure
contracts.
```

After:

```markdown
Commit `.bb-env-setup.sh` (`.bb-env-setup.ps1` on native Windows) when a
managed worktree needs repository setup. Commit `.bb-env-teardown.sh`
(`.bb-env-teardown.ps1` on native Windows) when bb must release external
resources before it removes that worktree. See [Worktrees, setup scripts, and
teardown scripts](worktrees.md) for the lifecycle, environment, timeout, and
failure contracts.
```

`docs/configuration.md` names no automations interpreter list anywhere (`grep -n "interpreter" docs/configuration.md` returns nothing before or after this step) — the interpreter enum is documented only in the automations skill (Step 12), so this file needs only the hook-name edit above.

- [ ] **Step 10: `docs/cli-guide-and-skill.md` — hook paragraph**

Before:

```markdown
Environment lifecycle hooks are core policy: bb runs `.bb-env-setup.sh` after
an environment provider creates an owned path, and `.bb-env-teardown.sh` before
provider removal. Each has a 15-minute timeout; setup failure fails provisioning,
while reported teardown script failure does not block removal. Transport failure
keeps cleanup pending until the daemon confirms hook termination. Hook identity
and completion persist across server restarts. Attached checkout and
personal-workspace paths skip both hooks. These semantics apply equally to CLI,
SDK, and app launches; see [worktrees.md](worktrees.md).
```

After:

```markdown
Environment lifecycle hooks are core policy: bb runs `.bb-env-setup.sh`
(`.bb-env-setup.ps1` on native Windows) after an environment provider creates
an owned path, and `.bb-env-teardown.sh` (`.bb-env-teardown.ps1` on native
Windows) before provider removal. Each has a 15-minute timeout; setup failure
fails provisioning, while reported teardown script failure does not block
removal. Transport failure keeps cleanup pending until the daemon confirms
hook termination. Hook identity and completion persist across server
restarts. Attached checkout and personal-workspace paths skip both hooks.
These semantics apply equally to CLI, SDK, and app launches; see
[worktrees.md](worktrees.md).
```

- [ ] **Step 11: `packages/templates/src/templates/bb-guide-environments.md` and `bb-guide-overview.md`**

In `bb-guide-environments.md`, before:

```
  BB runs the hook as `env bash .bb-env-setup.sh` with cwd set to the new
  workspace. POSIX shell setup scripts are not supported on Windows. The hook
  inherits the host daemon's sanitized environment: NODE_ENV and every BB_*
  variable are removed, and bb does not inject BB_PROJECT_ID, BB_ENVIRONMENT_ID,
  or BB_SOURCE_PATH.
```

After:

```
  BB runs the hook as `env bash .bb-env-setup.sh` with cwd set to the new
  workspace. On native Windows BB instead looks for .bb-env-setup.ps1 and
  runs it through pwsh.exe (or powershell.exe) with
  -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File; a
  .sh-only script on Windows fails setup naming the .ps1 contract. The hook
  inherits the host daemon's sanitized environment: NODE_ENV and every BB_*
  variable are removed, and bb does not inject BB_PROJECT_ID, BB_ENVIRONMENT_ID,
  or BB_SOURCE_PATH.
```

And before:

```
  Commit a .bb-env-teardown.sh script at the repo root when setup creates
  resources outside the managed worktree. BB runs the hook as
  `env bash .bb-env-teardown.sh` from the worktree before it removes the
  worktree. The hook receives the same sanitized environment as the setup
  hook, and stdin is closed.
```

After:

```
  Commit a .bb-env-teardown.sh script (.bb-env-teardown.ps1 on native
  Windows) at the repo root when setup creates resources outside the managed
  worktree. BB runs the hook as `env bash .bb-env-teardown.sh` from the
  worktree before it removes the worktree; on native Windows it runs
  .bb-env-teardown.ps1 the same way it runs setup. The hook receives the same
  sanitized environment as the setup hook, and stdin is closed.
```

In `bb-guide-overview.md`, before:

```
repo-level `.bb-env-setup.sh` and `.bb-env-teardown.sh` hooks. Run `bb guide
```

After:

```
repo-level `.bb-env-setup.sh`/`.bb-env-setup.ps1` and
`.bb-env-teardown.sh`/`.bb-env-teardown.ps1` hooks. Run `bb guide
```

- [ ] **Step 12: bb-cli skill references**

In `plugins/bb-guide/skills/bb-cli/references/configuration.md`, before:

```markdown
- To make a repo work with bb worktrees, run `bb guide environments`. It
  documents the repo-level `.bb-env-setup.sh` and `.bb-env-teardown.sh` hooks,
  and the `.worktreeinclude` file.
- A new worktree checks out tracked files only. Commit a `.worktreeinclude`
  file at the repo root to list untracked files, such as `.env`, that bb must
  copy from the source checkout. It uses gitignore pattern syntax. bb copies
  the matches before it runs `.bb-env-setup.sh`.
```

After:

```markdown
- To make a repo work with bb worktrees, run `bb guide environments`. It
  documents the repo-level `.bb-env-setup.sh`/`.bb-env-setup.ps1` and
  `.bb-env-teardown.sh`/`.bb-env-teardown.ps1` hooks, and the
  `.worktreeinclude` file.
- A new worktree checks out tracked files only. Commit a `.worktreeinclude`
  file at the repo root to list untracked files, such as `.env`, that bb must
  copy from the source checkout. It uses gitignore pattern syntax. bb copies
  the matches before it runs the setup hook.
```

In `plugins/bb-guide/skills/bb-cli/references/thread-creation.md`, before:

```markdown
For paths a provider owns, bb runs `.bb-env-setup.sh` after create and
`.bb-env-teardown.sh` before remove on that machine, with separate 15-minute
timeouts. Setup failure fails the launch with output in provisioning progress;
teardown script failure is logged and removal continues. Attaching a project
checkout or personal workspace skips both hooks. Providers do not run these
core hooks themselves.
```

After:

```markdown
For paths a provider owns, bb runs `.bb-env-setup.sh`
(`.bb-env-setup.ps1` on native Windows) after create and
`.bb-env-teardown.sh` (`.bb-env-teardown.ps1` on native Windows) before
remove on that machine, with separate 15-minute timeouts. Setup failure fails
the launch with output in provisioning progress; teardown script failure is
logged and removal continues. Attaching a project checkout or personal
workspace skips both hooks. Providers do not run these core hooks themselves.
```

- [ ] **Step 13: verify the automations skill surfaces Task 7 updated**

Task 7 Step 7 owns both automations skill files and this task edits neither.
It rewrites `plugins/automations/skills/automations/references/creation.md`
line 35 to list `powershell` beside the other interpreters, and it adds a
paragraph to `plugins/automations/skills/automations/SKILL.md` that maps
`.ps1` to `powershell`, shows a `--interpreter powershell` example and says
which interpreters a Windows server can actually run. Verify both landed and
that the interpreter list is the same one this task documents:

```bash
grep -n 'powershell' plugins/automations/skills/automations/references/creation.md
grep -n 'powershell' plugins/automations/skills/automations/SKILL.md
git grep -n "bash, sh, node, or python3"
```

Expected: the first two print the Task 7 lines, and the third prints nothing.
If any of them disagrees, Task 7 is incomplete — finish it there rather than
patching the skill files from this task, so the interpreter surface stays in
one commit.

- [ ] **Step 14: `docs/api_to_audit.md` — `experimental_killProcessesWithCwdUnder`**

Before:

```markdown
0a. **Process reap.** `experimental_killProcessesWithCwdUnder({ directory,
   graceMs? })` from `@get-bb/plugin-sdk/host` is the same helper bb's own
daemon used to reap a managed workspace before removing it: SIGTERM to
every process whose working directory is at or under the path, SIGKILL
after the grace, returning what it signalled. Published for the worktree
and environment-personal-workspace plugins, which own their teardown and call it
before deleting the directory. Confirm the platform coverage (Linux
`/proc`, macOS `lsof`) and whether the grace should be per call.
```

After:

```markdown
0a. **Process reap.** `experimental_killProcessesWithCwdUnder({ directory,
   graceMs? })` from `@get-bb/plugin-sdk/host` is the same helper bb's own
daemon used to reap a managed workspace before removing it: SIGTERM to
every process whose working directory is at or under the path, SIGKILL
after the grace, returning what it signalled. Published for the worktree
and environment-personal-workspace plugins, which own their teardown and call it
before deleting the directory. Confirm the platform coverage (Linux
`/proc`, macOS `lsof`) and whether the grace should be per call.

On win32 (Phase 2) there is no `/proc`, so the helper matches by
`Get-CimInstance Win32_Process` evidence instead of a real cwd read: each
signalled process carries `approximateCwd: true` and a `matchEvidence` of
`"spawn-registry"`, `"executable-path"`, `"command-line"`, or `"descendant"`.
A process is force-killed only after its `CreationDate` is re-verified
immediately before the per-PID `taskkill /F`; a mismatch is skipped and
reported through an `onSkippedProcess` callback rather than killed blind.
Confirm before stabilizing: whether plugin callers need `matchEvidence` and
`approximateCwd` surfaced in the public result (today they are host-internal
types), and whether the over-match/under-match cases documented in
`qa/windows/phase-2/26-process-enumeration.md` are acceptable for a plugin
teardown helper or need a stricter default.
```

If Task 7 added a new `@get-bb/plugin-sdk` export for automations (check
`git log` on `packages/plugin-sdk/src/host.ts` or equivalent since this
task's dispatch), add one sentence here naming it and pointing at its own
entry; otherwise state in this task's report that no new SDK export needs an
entry.

- [ ] **Step 15: build, format, commit**

```bash
pnpm exec turbo run build --filter=@bb/templates
pnpm exec oxfmt docs/platform-windows.md docs/platform-support.md docs/worktrees.md docs/configuration.md docs/cli-guide-and-skill.md docs/api_to_audit.md packages/templates/src/templates/bb-guide-environments.md packages/templates/src/templates/bb-guide-overview.md plugins/bb-guide/skills/bb-cli/references/configuration.md plugins/bb-guide/skills/bb-cli/references/thread-creation.md
git add docs/platform-windows.md docs/platform-support.md docs/worktrees.md docs/configuration.md docs/cli-guide-and-skill.md docs/api_to_audit.md packages/templates/src/templates/bb-guide-environments.md packages/templates/src/templates/bb-guide-overview.md plugins/bb-guide/skills/bb-cli/references/configuration.md plugins/bb-guide/skills/bb-cli/references/thread-creation.md
git commit -m "$(cat <<'EOF'
Document the Windows process, hook, git and open-target seams

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4
EOF
)"
```

(Skip `plugins/automations/skills/automations/references/creation.md` from
`git add` if Step 13 found the edit already applied by Task 7 and made no
change.)

---

### Task 15: Phase gate and evidence

**Files:**

- Create: `qa/windows/phase-2/00-host.md`, `30-build-typecheck.txt`,
  `31-test-results.md`, `31-test-output-tail.txt`,
  `20-hook-stream-timeout-cancel.md`, `21-pid-reuse-stress.md`,
  `22-secret-acl.md`, `23-junctions.md`, `24-open-targets.md`,
  `25-bb-from-powershell.md`, `26-process-enumeration.md`,
  `40-posix-check.md`, `41-ci-run.md`,
  `21-pid-reuse-stress.txt`, `20-hook-stream-timeout-cancel.txt`
- Unchanged: `qa/windows/scripts/` — this task adds no script there. The two
  Windows process demonstrations run as `it.runIf(win32)` cases inside
  `packages/process-utils/test/windows-process-real.test.ts` (Task 2),
  because `qa/` belongs to no workspace package and cannot import
  `@bb/process-utils`.

**Interfaces:**

- Consumes: `packages/process-utils/test/windows-process-real.test.ts` and
  `apps/host-daemon/src/environment-lifecycle-script.test.ts` (Tasks 2 and 5)
  for the process and hook evidence; `qa/windows/scripts/summarize-turbo-run.mjs` (Phase 0); the
  `qa/windows/phase-1/31-test-results.md` refresh-3 comparison baseline and
  `qa/windows/phase-0/31-test-baseline.md` for packages Phase 1 never ran.
- Produces: the evidence spec §7's Phase 2 gate requires.

Measurement rule for every command below (unchanged from Phase 1 Task 11):
run it in one shell, append `EXIT=<code>` captured in that same shell to the
evidence file, and paste the exact command line above the output.

Turbo test filter list for this gate is the Phase 1 list plus the Phase 2
seams: `@bb/domain @bb/db @bb/host-daemon-contract @bb/desktop-contract
@bb/server-contract @bb/config @bb/scripts @bb/server @bb/host-daemon @bb/app
@bb/desktop bb-plugin-environment-git-worktree
bb-plugin-environment-personal-workspace @bb/process-utils
bb-environment-provider-host @bb/secret-storage @bb/local-open-targets
@bb/cli bb-plugin-automations bb-plugin-github bb-plugin-provider-claude-code
bb-app` (confirmed package names: `packages/environment-provider-host/package.json`
is `bb-environment-provider-host`, not `@bb/environment-provider-host`;
`plugins/automations`, `plugins/github`, `plugins/provider-claude-code` are
`bb-plugin-automations`, `bb-plugin-github`, `bb-plugin-provider-claude-code`;
`packages/bb-app/package.json` is `bb-app`). Re-check every name against its
`package.json` before building the `--filter` flags, since a stale name makes
Turbo silently skip the package rather than fail.

- [ ] **Step 1: Host facts**

```powershell
$f = "qa/windows/phase-2/00-host.md"; & { Get-Date -Format "o"; git rev-parse HEAD; node -v; pnpm -v; git --version; "$([System.Environment]::OSVersion.Version)"; (Get-Command node).Source; "pwsh $($PSVersionTable.PSVersion)" } 2>&1 | Tee-Object -Append $f; "EXIT=$LASTEXITCODE" | Tee-Object -Append $f
```

Expected: `EXIT=0`. Record the branch (`windows-native/phase-2`) and confirm
it is the same reference desktop as Phase 0/1 (`qa/windows/phase-1/00-host.md`).

- [ ] **Step 2: Build and typecheck**

```powershell
nvm use 22.19.0
pnpm exec turbo run build typecheck --output-logs=new-only 2>&1 | Tee-Object -Append qa/windows/phase-2/30-build-typecheck.txt; "EXIT=$LASTEXITCODE" | Tee-Object -Append qa/windows/phase-2/30-build-typecheck.txt
```

Expected: `EXIT=0`, all tasks successful.

- [ ] **Step 3: Tests**

```powershell
pnpm exec turbo run test --continue --summarize --output-logs=errors-only --filter=@bb/domain --filter=@bb/db --filter=@bb/host-daemon-contract --filter=@bb/desktop-contract --filter=@bb/server-contract --filter=@bb/config --filter=@bb/scripts --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/app --filter=@bb/desktop --filter=bb-plugin-environment-git-worktree --filter=bb-plugin-environment-personal-workspace --filter=@bb/process-utils --filter=@bb/host-workspace --filter=bb-environment-provider-host --filter=@bb/secret-storage --filter=@bb/local-open-targets --filter=@bb/cli --filter=bb-plugin-automations --filter=bb-plugin-github --filter=bb-plugin-provider-claude-code --filter=bb-app 2>&1 | Tee-Object qa/windows/phase-2/31-test-output.txt; "EXIT=$LASTEXITCODE" | Tee-Object -Append qa/windows/phase-2/31-test-output.txt
node qa/windows/scripts/summarize-turbo-run.mjs | Tee-Object qa/windows/phase-2/31-test-results.md
```

`@bb/server` and `@bb/host-daemon` are load-sensitive on Windows per the
Global Constraints; if the combined run above times out or the machine
struggles, split them out and run each package's test task individually
(`pnpm exec turbo run test --filter=@bb/server`, then `--filter=@bb/host-daemon`)
and merge their summaries into the same table by hand, noting the split in
prose.

Add to `31-test-results.md`: the commit SHA and Node version; a second table
`package | failed/passed test files` for the failing packages; a comparison
column against `qa/windows/phase-1/31-test-results.md`'s gate-refresh-3
section (`c3e4a8590`, 2026-09-14) for every package that appeared there, and
against `qa/windows/phase-0/31-test-baseline.md` for every package on this
list that Phase 1 never ran (`@bb/process-utils`, `bb-environment-provider-host`,
`@bb/secret-storage`, `@bb/local-open-targets`, `@bb/cli`,
`bb-plugin-automations`, `bb-plugin-github`, `bb-plugin-provider-claude-code`,
`bb-app`) — for those, note whether Phase 0 ran them at all and treat "not
run before" as the baseline rather than a regression. Expected: the six pure
packages that passed at the Phase 1 refresh-3 gate (`@bb/domain`, `@bb/db`,
`@bb/host-daemon-contract`, `@bb/desktop-contract`, `@bb/server-contract`,
`@bb/config`) still pass; no test file that passed at Phase 1 refresh-3 fails
now; every Windows-specific `it.runIf(win32)` test added in Tasks 1–13 passes
on this machine. Keep the last 200 lines of the output as
`31-test-output-tail.txt` and delete `31-test-output.txt`.

- [ ] **Step 4: Hook stream, timeout/cancel, `tasklist` before/after**

Create the scratch hook repository:

```powershell
$d = "C:\Users\olege\Work\phase2-hook"
if (Test-Path $d) { Remove-Item -Recurse -Force $d -Confirm:$false }
git init -q $d
Set-Content -NoNewline -Path (Join-Path $d ".bb-env-setup.ps1") -Value "Write-Output `"phase2 hook line 1`"`nStart-Sleep -Seconds 1`nWrite-Output `"phase2 hook line 2`"`nStart-Sleep -Seconds 1`nWrite-Output `"phase2 hook line 3`"`nStart-Process -NoNewWindow -FilePath node -ArgumentList `"-e`",`"setTimeout(()=>{},600000)`"`nStart-Sleep -Seconds 600`n"
Set-Content -Path (Join-Path $d "README.md") -Value "# phase2-hook`n"
git -C $d add .bb-env-setup.ps1 README.md
git -C $d -c user.name="Phase2 QA" -c user.email="olegefm@gmail.com" commit -q -m "Initial commit"
git -C $d log --oneline
```

Start the dev app (`pnpm dev:app current`), add `phase2-hook` as a project in
the UI, and start a thread with the Worktree environment provider (same UI
substitution as Phase 1's `22-managed-worktree.md`: `POST /api/v1/threads`
with `environment.environmentProviderId = "git-worktree"`). Before running:

```powershell
tasklist /FI "IMAGENAME eq node.exe" /FO CSV | Tee-Object qa/windows/phase-2/20-hook-stream-timeout-cancel.md -Append
```

Watch the thread's provisioning transcript in the app UI for the three
`Write-Output` lines and the "Running .bb-env-setup.ps1" / finished progress
markers; screenshot or copy the transcript text into
`20-hook-stream-timeout-cancel.md`. (If a scripted capture is preferred over
reading the UI, check `packages/server-contract/src/thread-timeline.ts` for
the route that streams thread/provisioning events before assuming one
exists — do not invent an endpoint.)

Cancel the thread from the UI while the hook's spawned `node` sleeper is
still running, then immediately:

```powershell
tasklist /FI "IMAGENAME eq node.exe" /FO CSV | Tee-Object -Append qa/windows/phase-2/20-hook-stream-timeout-cancel.md
```

Expected: the `node -e "setTimeout(()=>{},600000)"` process from the hook is
gone from the second `tasklist`, and any `node.exe` present is unrelated
(record its command line with `Get-CimInstance Win32_Process -Filter
"ProcessId = <pid>" | Select-Object CommandLine` if there is any doubt).

For the timeout path: `plugins/environment-git-worktree/server.ts` hardcodes
`CREATE_TIMEOUT_MS = 15 * 60 * 1000` with no server-exposed override
(confirmed: `grep -rn "CREATE_TIMEOUT_MS\|SETUP_TIMEOUT" apps/server/src`
finds nothing that overrides it). Waiting 15 real minutes for a second run is
not required — record instead that the timeout path shares the same
`terminateProcessTree` cancellation code as the cancel path just measured
above, and that Task 5's real-process timeout case covers the same branch
with a shortened timeout. Run that case and paste its result into the
evidence file:

```powershell
pnpm --filter @bb/host-daemon exec vitest run src/environment-lifecycle-script.test.ts -t "times out a sleeping PowerShell hook" 2>&1 | Tee-Object -Append qa/windows/phase-2/20-hook-stream-timeout-cancel.txt
```

`times out a sleeping PowerShell hook` in
`apps/host-daemon/src/environment-lifecycle-script.test.ts` is an
`it.runIf(process.platform === "win32")` case that writes a
`Start-Sleep -Seconds 30` hook, calls `runSetupScript` with
`timeoutMs: 1_000` and asserts it rejects with `timed out after 1000ms`; it
exercises the same `terminateProcessTree` path the 15-minute constant reaches.
Copy its pass line into `20-hook-stream-timeout-cancel.md` beside the cancel
measurement and state that this file records the cancel path as the
real-process proof for both.

Clean up: `pnpm dev:stop`; `Remove-Item -Recurse -Force C:\Users\olege\Work\phase2-hook -Confirm:$false`.

- [ ] **Step 5: PID-reuse stress**

The stress case lives in the package that owns the primitive, not in a
standalone script: `qa/` is not part of any workspace package, the repo root
declares no workspace dependencies, and `node --import tsx qa/…` therefore
cannot import `@bb/process-utils` at all. Task 2's
`packages/process-utils/test/windows-process-real.test.ts` carries it as the
`it.runIf(process.platform === "win32")` case
`leaves unrelated processes alive while PIDs are recycled under a tree kill`,
which starts an unrelated Node sleeper, starts a Node parent with a Node
child, runs 300 short-lived `cmd.exe /d /c exit 0` spawns (from the absolute
`%SystemRoot%\System32` path) concurrently with `terminateProcessTree` on the
parent, and prints one `PID_REUSE_EVIDENCE <json>` line.

Run the whole file and capture it:

```powershell
pnpm --filter @bb/process-utils exec vitest run test/windows-process-real.test.ts 2>&1 | Tee-Object qa/windows/phase-2/21-pid-reuse-stress.txt; "EXIT=$LASTEXITCODE" | Tee-Object -Append qa/windows/phase-2/21-pid-reuse-stress.txt
```

Copy the `PID_REUSE_EVIDENCE` line, the case's pass line and `EXIT` into
`qa/windows/phase-2/21-pid-reuse-stress.md`. Expected: `leaderExited: true`,
`unrelatedAlive: true` (the sleeper started before the recycle loop is
untouched), `descendantsKilled` containing the grandchild, and
`descendantsSkipped` an empty array on a clean run — record it as-is either
way, since a non-empty `descendantsSkipped` with a genuine `pid-reused` entry
is also a valid (if less likely) outcome of a tight PID-reuse race and is
worth keeping as evidence rather than treated as a failure. Add a
`tasklist /FI "IMAGENAME eq node.exe" /FO CSV` capture to the evidence file
after the run and confirm no leaked leader or descendant remains.

- [ ] **Step 6: Secrets ACL**

Start the dev server with a fresh data dir and record the ACL read-back on a
secret file and the telemetry id file:

```powershell
$env:BB_DATA_DIR = "C:\Users\olege\.bb-dev\phase2-secrets-qa"
pnpm dev:app current
Get-ChildItem $env:BB_DATA_DIR -Recurse -Include "auth-secret*","*telemetry*" | ForEach-Object { $_.FullName }
```

For each file `icacls.exe` reports back, capture:

```powershell
icacls.exe "<path>" | Tee-Object -Append qa/windows/phase-2/22-secret-acl.md
```

Expected: exactly one ACE line per file, identifying the current Windows
account with `(F)` and nothing else. Clean up with `pnpm dev:stop` and
`Remove-Item -Recurse -Force $env:BB_DATA_DIR -Confirm:$false`; unset
`BB_DATA_DIR`.

- [ ] **Step 7: Junctions**

```powershell
pnpm --filter @bb/host-daemon exec vitest run src/command-handlers/path-mutations.test.ts 2>&1 | Tee-Object qa/windows/phase-2/23-junctions.md; "EXIT=$LASTEXITCODE" | Tee-Object -Append qa/windows/phase-2/23-junctions.md
```

Paste the summary (pass/fail counts and the win32-only test names for
remove, move, and the junction-substitution race). Expected: all pass, and
the target directory of every junction case still exists and is unchanged
(the tests themselves assert this; note their assertions in the evidence
file rather than re-deriving it by hand).

- [ ] **Step 8: Open targets**

With the dev app running, find the daemon's local port from
`pnpm --silent dev:app env --powershell | Out-String` (it sets
`BB_HOST_DAEMON_PORT` or the equivalent local daemon URL — read the actual
variable name printed rather than assuming), then:

```powershell
$repo = "C:\Users\olege\Work\phase1-ui"
(Invoke-RestMethod -Uri "http://127.0.0.1:<daemon local port>/workspace-open-targets?path=$repo" -Method Get) | ConvertTo-Json -Depth 5 | Tee-Object qa/windows/phase-2/24-open-targets.md
```

Record the discovered target ids and use the id GET returned for each of
Explorer/file-manager, VS Code, and Windows Terminal in turn:

```powershell
$body = @{ targetId = "<id from the GET above>"; path = $repo; lineNumber = $null; columnNumber = $null } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:<daemon local port>/open-in-target" -Method Post -ContentType "application/json" -Body $body
```

For each of the three, record the request body, the response (`{}` on
success or the 400 body naming the failure), and a one-line manual
observation of what actually opened (an Explorer window on `phase1-ui`, a
VS Code window on the same folder, a Windows Terminal / PowerShell console
in that directory). If `wt.exe` is not installed on the reference desktop,
record that the fallback PowerShell console opened instead and note it as
expected per the ruling, not a failure.

- [ ] **Step 9: `bb` from PowerShell**

```powershell
pnpm exec turbo run build --filter=@bb/cli
$dest = "C:\Users\olege\Work\bb space test\cli"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item apps\cli\bin -Destination $dest -Recurse -Force
Copy-Item apps\cli\dist -Destination $dest -Recurse -Force
& "$dest\bin\bb.cmd" --version
"EXIT_PWSH=$LASTEXITCODE"
cmd.exe /d /c "`"$dest\bin\bb.cmd`" --version"
"EXIT_CMD=$LASTEXITCODE"
```

Then, against the dev server (`eval`d env from `pnpm --silent dev:app env --powershell`):

```powershell
& "$dest\bin\bb.cmd" project list --json
"EXIT_PROJECT_LIST=$LASTEXITCODE"
```

Record every command and its output/`EXIT` in
`qa/windows/phase-2/25-bb-from-powershell.md`. Expected: `bb.cmd --version`
prints the CLI version from both PowerShell and `cmd.exe`, and
`project list --json` returns the dev instance's projects despite the space
in the install directory's path. Clean up: `Remove-Item -Recurse -Force
"C:\Users\olege\Work\bb space test" -Confirm:$false`.

- [ ] **Step 10: Process enumeration over-match and under-match**

Same reasoning as Step 5: the demonstration lives in Task 2's
`packages/process-utils/test/windows-process-real.test.ts` as the
`it.runIf(process.platform === "win32")` case
`documents an under-match and an over-match`, which starts one Node process
whose cwd is a temp directory and whose argv never names it, starts a second
Node process elsewhere whose argv contains that directory path, takes a real
snapshot and prints one `ENUMERATION_EVIDENCE <json>` line.

Step 5 already ran the whole file into
`qa/windows/phase-2/21-pid-reuse-stress.txt`; run it again only if that
capture is stale:

```powershell
pnpm --filter @bb/process-utils exec vitest run test/windows-process-real.test.ts 2>&1 | Tee-Object qa/windows/phase-2/21-pid-reuse-stress.txt; "EXIT=$LASTEXITCODE" | Tee-Object -Append qa/windows/phase-2/21-pid-reuse-stress.txt
```

Copy the `ENUMERATION_EVIDENCE` line and the case's pass line into
`qa/windows/phase-2/26-process-enumeration.md`. Expected:
`underMatchMissed: true` (a real process under the directory is missed
because Windows exposes no cwd, and neither its executable path nor its
command line names the directory — this is the documented under-match) and
`overMatchEvidence: "command-line"` (a process running elsewhere is matched
only because the directory string appears in its argv — this is the
documented over-match). Record `enumerationMs` from the same line as an
observational data point for the spec's ~1.2 s CIM cost figure, not a strict
assertion.

- [ ] **Step 11: WSL POSIX run**

In WSL (`~/bb-posix-check`, reused from Phase 1):

```bash
git fetch origin windows-native/phase-2 && git checkout windows-native/phase-2 && pnpm install --frozen-lockfile
pnpm exec turbo run test --continue --summarize --output-logs=errors-only --filter=@bb/domain --filter=@bb/db --filter=@bb/host-daemon-contract --filter=@bb/desktop-contract --filter=@bb/server-contract --filter=@bb/config --filter=@bb/scripts --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/app --filter=@bb/desktop --filter=bb-plugin-environment-git-worktree --filter=bb-plugin-environment-personal-workspace --filter=@bb/process-utils --filter=@bb/host-workspace --filter=bb-environment-provider-host --filter=@bb/secret-storage --filter=@bb/local-open-targets --filter=@bb/cli --filter=bb-plugin-automations --filter=bb-plugin-github --filter=bb-plugin-provider-claude-code --filter=bb-app 2>&1 | tee ~/phase2-posix.txt; echo "EXIT=$?"
node qa/windows/scripts/summarize-turbo-run.mjs
```

Record the summariser table and `EXIT` in `qa/windows/phase-2/40-posix-check.md`.
`qa/windows/phase-1/40-posix-check.md` describes a 24-input differential
check for path identity; that check has no Phase 2 equivalent seam (Phase 2
touches processes and hooks, not path parsing), so state in this file that no
differential re-run applies here rather than searching for a script that
does not exist. Expected: every package in the filter list passes in WSL,
since the entire phase is win32-only arms beside untouched POSIX code.

- [ ] **Step 12: CI**

```bash
git push -u origin windows-native/phase-2
gh run list -R OlegFM/bb --branch windows-native/phase-2 --limit 5
gh run view <run-id> -R OlegFM/bb --json url,headSha,displayTitle,event,createdAt,jobs --jq '{url,headSha,displayTitle,event,createdAt, windows: (.jobs[]|select(.name|test("Windows"))|{name,status,conclusion,startedAt,completedAt,url,steps:[.steps[]|{name,conclusion}]})}'
```

Wait for `Windows x64 (windows-2025, Node 22.x)` to conclude, record the run
URL, job result, and step list in `qa/windows/phase-2/41-ci-run.md`, then
cancel any other runs the push queued (`Version Lockstep`, etc.) with
`gh run cancel <id> -R OlegFM/bb`.

- [ ] **Step 13: Commit the evidence**

```bash
git add qa/windows/phase-2
git commit -m "$(cat <<'EOF'
Record the Phase 2 Windows gate evidence

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4
EOF
)"
git push
```

- [ ] **Step 14: Gate check**

Map each spec §7 Phase 2 gate bullet to its evidence file before calling the
phase done:

- "a worktree with `.bb-env-setup.ps1` streams output, times out and cancels;
  cancellation leaves no descendants (`tasklist` before/after)" →
  `20-hook-stream-timeout-cancel.md`.
- "a PID-reuse stress test ... leaves every unrelated process alive and logs
  `pid-reused` skips" → `21-pid-reuse-stress.md`.
- "secret files created on win32 read back an ACL containing only the current
  user" → `22-secret-acl.md`.
- "junction remove, move and substitution are refused with the target
  untouched" → `23-junctions.md`.
- "Open in Explorer, VS Code and Windows Terminal work" → `24-open-targets.md`.
- "`bb` runs from PowerShell" (including a directory with a space) →
  `25-bb-from-powershell.md`.
- "process enumeration over-match and under-match cases are reproduced and
  documented" → `26-process-enumeration.md`.
- "POSIX suites unchanged (WSL run)" → `40-posix-check.md`.
- `30-build-typecheck.txt` ends with `EXIT=0`.
- `31-test-results.md` shows the Phase 1 refresh-3 packages still passing and
  no newly failing test file among them.
- `41-ci-run.md` links a green `windows-x64` job at the pushed SHA.

If any bullet's evidence shows a genuine gap (not a documented out-of-phase
limitation from Task 14's Known limitations list), record it here rather than
silently marking the gate passed, the same way Phase 1's `22-managed-worktree.md`
recorded its blocker before the fix landed.
