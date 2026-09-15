# Native Windows Port — Phase 3 (ConPTY, providers, watcher, native `bb-app`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a native Windows host the in-app terminal runs through ConPTY with a profile-loading PowerShell, provider CLIs (Codex, Claude Code, Pi, ACP agents) are located PATHEXT-aware and launched without `cmd.exe`, provider installation streams through ConPTY and offers only installers that can run natively, the file watcher matches NTFS event paths correctly, the Desktop log viewer follows logs without `tail`, the `bb-app` tarball smoke runs on the Windows CI job, and the docs declare native Windows a beta runtime.

**Architecture:** Every Windows branch is a `platform === "win32"` arm beside untouched POSIX code; the POSIX behaviour of every shared module stays byte-identical to `windows-native/phase-2` (9a07e6994). `@bb/process-utils` gains a resolve-then-spawn seam (`resolveExecutableSync`, `resolveSpawnPlan`, `runCommandCapture`, an npm-launcher shim pattern) and every provider seam consumes it: the terminal manager, the provider installation runner, the maintenance kit, the four provider bridges, the runtime manager's PATH overlay. node-pty's ConPTY binding is driven with its defaults; kill on win32 is a single `pty.kill()` because node-pty throws on any signal there; the PTY pid is registered as a sweep root once it is non-zero. The watcher, log viewer and tarball smoke get win32 arms; no POSIX code path changes.

**Tech Stack:** pnpm 9.15.0, Turbo, Vitest 4, TypeScript, zod, node-pty 1.2.0-beta.15 (ConPTY-only win32 prebuild), `@parcel/watcher` 2.5.6 (win32-x64 prebuild), PowerShell 7 / Windows PowerShell 5.1, `@bb/process-utils` (Phase 2).

**Spec:** `docs/superpowers/specs/2026-09-11-native-windows-port-design.md` (§4 Process rules, §5 seams "Executable and environment discovery", "Process launch and stop", "Terminal and shell", §6 Skill scripts, §7 Phase 3, §8 Verification, §9 Risks, §10 Donor policy).

**Research (read-only, saved for the controller):** the session scratchpad `phase3-research/` holds `01-terminals-conpty.md`, `02-providers.md`, `03-watcher-logviewer-bbapp-docs.md`, `04-deferred-and-skipif.md`, `05-gate-paths.md`, `06-controller-probes.md`. Every measured fact quoted below comes from those files; a task brief may quote them but never needs them.

## Global Constraints

- **User rule (binding, overrides the donor and any ruling):** POSIX behaviour of shared code stays byte-identical to 9a07e6994. New validation, new spawn paths, new resolution and new env normalisation exist only inside `platform === "win32"` arms. A shared function may gain an optional `platform?: NodeJS.Platform` parameter defaulting to `process.platform` and an optional `env?: NodeJS.ProcessEnv` parameter defaulting to `process.env` (testability, not behaviour), and a shared module may gain a new export that POSIX callers do not call. Existing POSIX tests are not rewritten; when an existing POSIX test fails on the win32 host only because a default became platform-aware, pin `platform: "linux"` on that call and change nothing else. A reviewer treats "a POSIX user could notice this" as an Important finding.
- Platform is injected, never ambient: `process.platform` is read only as a default parameter value or at composition roots (`apps/host-daemon/src/app.ts`, `apps/host-daemon/src/command-dispatch.ts` dispatch entry, plugin `server.ts`/`host.ts` entry points, `apps/desktop/src/main.ts`, script entry points) (spec §4).
- `shell: true` stays forbidden. `.cmd`/`.bat` files run only when the operation is explicitly a CMD command. On win32 a command that resolves to a Node `.cmd` shim is spawned as `process.execPath <script> …` (never through `cmd.exe /c`); a `.cmd` that is not a Node shim is refused with `nodeShimRefusalMessage`. PowerShell scripts run with `-File` and separate arguments; bb's own probes use `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass`; interactive terminals use `-NoLogo` only. Background helpers, provider processes, probes and cleanup pass `windowsHide: true`; the user-facing terminal launch stays visible (spec §4).
- Windows system tools are spawned by absolute path from `resolveWindowsSystemToolPath(name, env)`; `where.exe` is never spawned (Phase 2's `resolveExecutable` walks `Path` + `PATHEXT` in process).
- Tool output is never parsed for localized text; success is decided by exit codes, liveness re-checks and structured output.
- Stop sequence identity rules (spec §5) stay as Phase 2 implemented them; new stop paths reuse `terminateProcessTree` and the sweep registry, never a bare-PID `taskkill /F`.
- `HOST_DAEMON_PROTOCOL_VERSION` moves from 200 to 201 exactly once, in Task 6, for the new `installUnavailableReason` field on the provider installation status result. No other task changes a wire field; if one finds it must, it stops and reports.
- Code comments are forbidden in TypeScript and JavaScript except semantic tool directives (`AGENTS.md`). No `as X` casts outside boundary parsing; the donor's `as unknown as SpawnedProcess`, `error.code as string | number` and `as Readable` shapes are not ported.
- Builds, typechecks and tests run through Turbo: `pnpm exec turbo run <task> --filter=<pkg>`; single files may be run with `pnpm --filter <pkg> exec vitest run <file>` while iterating; every task ends with the Turbo `typecheck` of the touched packages and the Turbo `test` of every package whose tests changed. `@bb/server` and `@bb/host-daemon` suites are load-sensitive on Windows: run changed files individually there and pipe output to a scratchpad log.
- Measurement rule (spec §8): no Windows behaviour is claimed until it has run on Windows. Pure logic with injected platform/runner runs everywhere; real ConPTY, real provider binaries, NTFS watcher events and tarball installs are `it.runIf(process.platform === "win32")` (or `describe.runIf`) and run on the reference desktop and the `windows-x64` CI job. An early `return` that leaves a test green is a bug; a test that cannot run on win32 is `skipIf` with the reason in its name or a documented "unreachable" entry.
- Formatter: `pnpm exec oxfmt <files>` on every touched `.ts`/`.mjs`/`.md`/`.json` file before committing; Windows literals in TypeScript use doubled backslashes; `.ps1` stays LF.
- Donor policy (spec §10): fragments from `refs/remotes/upstream-pr/3188` (`git show refs/remotes/upstream-pr/3188:<path>`) are reading aids, never cherry-picks; not ported: `portable-executable.ts`, `-NoProfile` interactive shells, `chcp 65001` bootstraps, `where.exe` probes, the PowerShell+`bash` installer arm, the Pi probe-message simplification, the universal `tail` replacement, the separate `win-*.yml` workflows, `workspaceProvisionType: "unmanaged"` test fixtures (removed upstream by #3227).
- Plugin API rules: new `@get-bb/plugin-sdk` exports need an `experimental_` prefix, an entry in `docs/api_to_audit.md`, a symbol in `packages/plugin-api-map/src/surfaces.ts`, and an entry in `plugins/bb-guide/skills/bb-plugin-authoring/references/backend-api-index.md` (the Phase 2 gate regression). This plan adds no new SDK export; changed signatures of existing `experimental_` re-exports update their `docs/api_to_audit.md` entries.
- Commits are grouped by seam; each task ends with one commit whose message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` followed by `Claude-Session: https://claude.ai/code/session_0188S1T6s9v1Ea3gDyMXGzP4`.
- Phase gate (spec §7, restated in Task 14): the in-app terminal handles Ctrl+C, resize and UTF-8 echo; a real Codex turn and a real Claude Code turn read and write files under a `C:\` project; watcher events fire on NTFS; `npx bb-app` starts from a clean PowerShell session; the ConPTY smoke passes all six checks (the spec's five plus Ctrl+C); POSIX suites unchanged (WSL run); CI `Windows x64` green.

## Rulings recorded before execution

Each resolves a place where the spec, the donor, the measured host and the current tree disagree. Each is binding for the task that cites it.

- **R1 Terminal shell resolution.** `resolveDefaultTerminalShell({ platform, env, resolveExecutable, pathIsExecutable })` is exported and argument-injected. Win32 order: `pwsh.exe` through `resolveExecutable({ command: "pwsh", env, platform: "win32" })`, then `%ProgramFiles%\PowerShell\7\pwsh.exe`, then `resolveWindowsSystemToolPath("WindowsPowerShell\\v1.0\\powershell.exe", env)`, then `ComSpec`, then `resolveWindowsSystemToolPath("cmd.exe", env)`; when nothing exists it throws `TerminalShellUnavailableError` (no bare `"powershell.exe"` fallback). The resolver is composed in the daemon from Phase 2 exports; `resolvePowerShellExecutable` is not changed. POSIX branch is today's candidate list with `env.SHELL` read from the injected env.
- **R2 Interactive shell arguments.** PowerShell (`pwsh.exe` and `powershell.exe`): `shell` mode `["-NoLogo"]`, `command` mode `["-NoLogo", "-Command", command]`; the profile loads (measured: `-NoLogo` alone loads `$PROFILE`). `cmd.exe`: `shell` mode `[]`, `command` mode `["/s", "/c", command]` (AutoRun is CMD's profile; `/d` is not passed). No `chcp 65001` bootstrap anywhere (measured: `pwsh -NoLogo` round-trips Cyrillic without it); Windows PowerShell 5.1 and `cmd.exe` keep the console code page and this is documented. POSIX arms stay `[]` / `["-lc", command]`.
- **R3 Terminal env.** `buildTerminalEnv` gains `platform` and `inheritedEnv` parameters (defaults `process.platform`, `process.env`); on win32 the result carries exactly one `Path` key built with `assignPathEnv({ env: merged, path: shellEnv.PATH ?? readWindowsEnvValue(inheritedEnv, "Path") ?? "", platform: "win32" })`; POSIX output is byte-identical.
- **R4 Kill semantics.** node-pty throws `Signals not supported on windows.` for any signal (measured, `windowsTerminal.js:157-165`). The adapter's `kill` on win32 calls `pty.kill()` with no argument and never `killProcessGroup`; `terminalCloseSupportsForceKill(platform)` returns `false` on win32, so `forceCloseTerminal` only finishes the session there (single close), and the grace timer still fires cleanup. POSIX keeps `killProcessGroup(…, signal ?? "SIGHUP")` and the two-stage close verbatim.
- **R5 Sweep root.** `TerminalPtyProcess` gains `readonly pid?: number`. On win32 only, the manager registers `registerSweepRootProcess({ pid, cwd })` once `pty.pid > 0`, retrying every 250 ms up to 12 times (measured: pid is 0 for 90–178 ms after spawn), and unregisters in `finishTerminalSession`. POSIX registers nothing (today's behaviour).
- **R6 Failed-open cleanup.** The donor's `cleanupFailedTerminalOpen` (kill and dispose an orphan pty when a later open step throws) is applied only when `platform === "win32"`; the POSIX leak is recorded in `docs/platform-windows.md` as a pre-existing upstream finding, not fixed here.
- **R7 UTF-8 input.** The adapter's `write` on win32 converts a string to `Buffer.from(data, "utf8")` before `pty.write`; POSIX passes the value through unchanged. The wire is already base64 of UTF-8 bytes; no protocol change.
- **R8 Exit code `0xC000013A`.** A win32 `pty.kill()` exits with `-1073741510` (`STATUS_CONTROL_C_EXIT`). It is passed through unchanged (no wire-meaning change, no bump); the gate records what the app shows after a user-initiated close and `docs/platform-windows.md` documents the code. Normalisation is deferred to Phase 4 with the Desktop terminal UX.
- **R9 ConPTY smoke.** `apps/desktop/scripts/smoke-windows-conpty.mjs` is ported with six checks (`spawn-echo`, `utf8`, `resize`, `ctrl-c`, `close`, `tree`), spawns the shell resolved by R1 with `["-NoLogo"]`, calls `process.exit` after the summary (measured: ConPTY keeps a `Socket` handle alive), and becomes the Turbo task `@bb/desktop#smoke:windows-conpty` (`cache: false`, `outputs: []`, `passThroughEnv: ["*"]`) run by the `windows-x64` CI job. The gate reads "6/6".
- **R10 Provider installation through ConPTY.** `provider-installation.ts` takes `platform` (default `process.platform`; the composition root is `command-dispatch.ts`). On win32 the plan's command is resolved with `resolveSpawnPlan` before `spawnPty` (ConPTY runs only PE images: `npm.cmd` fails with error 193); an unresolvable command produces an `error` event with `nodeShimRefusalMessage` or `Command <name> was not found on Path`; cancel is `pty.kill()` followed by `terminateProcessTree` over `{ pid: pty.pid, exitCode, signalCode, kill: () => pty.kill() }` with `graceMs: 0` so descendants (`node.exe` under npm) are reaped by identity; POSIX keeps `pty.kill("SIGTERM")`. The env is `assignPathEnv` on win32 (already the case through `providerCliEnvFromShellEnv`).
- **R11 Resolve-then-spawn seam.** `@bb/process-utils` gains `resolveExecutableSync(args)` (same `Path`/`PATHEXT`/`X_OK` semantics as `resolveExecutable`, synchronous), `resolveSpawnPlan({ command, args, env, platform, cwd })` returning `{ command, args } | null` (POSIX: literal identity `{ command, args }`; win32: `resolveExecutable`, then `resolveNodeShimSpawnPlan` on the result, prepending the shim's `node.exe <script>`), `runCommandCapture({ command, args, env, cwd, timeoutMs, maxBytes, platform })` returning `{ stdout, stderr, exitCode, timedOut, truncated }` without casts, and an npm-launcher pattern in `readNodeCmdShim` for `SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"` … `"%NODE_EXE%" "%NPM_CLI_JS%" %*` (measured: the real `npm.cmd` returns `null` today). These stay internal to `@bb/process-utils` and `bridge-kit`; nothing new is exported from the plugin SDK.
- **R12 Maintenance kit.** `provider-maintenance-kit.ts` keeps every POSIX string, timeout and null-on-failure byte-identical. Functions gain `platform` (default `process.platform`) and, where they spawn, route through `resolveSpawnPlan` on win32 before the existing `execFile` (`.cmd` never reaches `execFile`). `npmCommand(platform)` returns `"npm"` on every platform (resolution happens at spawn time; `"npm.cmd"` is gone from the plan). `npmGlobalInstallSource` compares paths case-insensitively on win32. `downloadedInstallerCommand(url, platform)` returns `null` on win32 (no PowerShell+`bash` arm); `docs/api_to_audit.md` audit item 4 is rewritten accordingly.
- **R13 Install matrix and capability message.** `providerInstallationStatusSchema` and `providerCliStatusSchema` gain `installUnavailableReason: z.string().min(1).nullable()`; every bridge fills it (`null` when `installAction` is non-null or nothing is needed). On win32: Codex keeps `codex update` (native `.exe`); Claude Code keeps `claude update` for updates and returns `installAction: null` with reason `bb cannot run the Claude Code shell installer on Windows. Install Claude Code from https://claude.com/claude-code, then reload.` for a missing install; Pi offers `bun add -g @mariozechner/pi-coding-agent@latest` when `bun` resolves, else npm through `resolveSpawnPlan`'s Node rewrite, else `installAction: null` with reason naming `bun` or `npm`; ACP agents already carry `installUrl`. The app renders the reason in the provider row description (`update-manually` state), `bb updates status` prints it, `bb machine provider-cli status --json` carries it. `HOST_DAEMON_PROTOCOL_VERSION` becomes 201 in the same commit.
- **R14 Claude Code executable.** `resolveClaudeCodeExecutable` gains `platform`; on win32 it reads PATH with `readWindowsEnvValue(env, "Path")`, walks it with `resolveExecutableSync`, adds `%USERPROFILE%\.local\bin\claude.exe` and `%USERPROFILE%\.claude\local\claude.exe` to the well-known list, and resolves an explicit `BB_CLAUDE_CODE_EXECUTABLE` without extension to its PATHEXT sibling. The SDK keeps spawning the resolved `claude.exe` itself; `spawnClaudeCodeProcess` is installed on win32 only if Task 14 measures the SDK's own spawn misbehaving (contingency recorded in Task 7). The donor's `session-options-win32.test.ts` cases are adopted.
- **R15 Codex, Pi, ACP launch.** `app-server-connection.ts` (Codex), `rpc-child.ts` (Pi) and `packages/provider-bridge-acp/src/bridge/agent-connection.ts` plus the two other ACP launch sites resolve the command with `resolveSpawnPlan` and pass `windowsHide: true` only when `platform === "win32"`; POSIX keeps bare `spawn` with today's options. `resolvePiLaunch` returns `pi` on every platform (PATHEXT finds `pi.exe`); `bunCommand(platform)` returns `bun` (same reason); `describePiVersionProbeFailure` messages are kept. Five-pipe stdio to a Node child works on win32 (measured); Pi is not installed on the reference desktop, so the Pi launch is unit-tested with an injected platform and documented as unverified live.
- **R16 Runtime PATH.** `providerProcessEnvFromShellEnv(shellEnv, platform)` builds its PATH entry through `assignPathEnv({ env: {}, path: shellEnv.PATH, platform })`; `prependPath(dir, inherited, platform)` uses `";"` on win32 and `":"` elsewhere; `prepareRuntimeShellEnv` threads `options.platform`. POSIX output byte-identical.
- **R17 Sweep skip visibility.** `plugins/environment-git-worktree/host/worktree.ts` and `plugins/environment-personal-workspace/host.ts` pass `onSkippedProcess` to `experimental_killProcessesWithCwdUnder`, writing one line `bb sweep left pid <pid> alone: process id reused` to `process.stderr` (the plugin-host worker's existing diagnostic channel; `ExperimentalHostRpcContext` has no logger and is not widened). The callback is never invoked on POSIX.
- **R18 Watcher.** The spec's "ignore-list separator" is the donor's `watch-event-path.ts` (event-path/root matching, case-insensitive NTFS dedupe, `\\?\` handling); glob ignores already work on NTFS (measured). The module is ported with `platform` parameters, win32 arms only; four `path.join("/tmp", …)` fixtures in `test/watch-path.test.ts` become `os.tmpdir()`; `workspace-root-ignores.test.ts` (Linux-only inotify ceiling) gets a `docs/platform-windows.md` entry, not a Windows twin.
- **R19 Log viewer.** `createLogTailer` gains `platform` (composition root `apps/desktop/src/main.ts`); on win32 a file-follow reader (`readLastLogLines`, `readAppendedLogBytes`, `StringDecoder`, rotation by size/mtime, driven by the existing `fs.watch` + 2 s poll) replaces the `tail` child; POSIX keeps `spawn("tail", …)` and its tests byte-identical (`platform: "linux"` pinned where the default became platform-aware).
- **R20 Tarball smoke.** `packages/bb-app/scripts/smoke-tarball.mjs` cannot import workspace packages; on win32 it resolves `npm`/`npx` to `process.execPath` plus `<dirname(process.execPath)>\node_modules\npm\bin\npm-cli.js` / `npx-cli.js` (measured to exist and run) and fails loudly when the file is missing; POSIX keeps `spawn("npm", …)`. The `windows-x64` job adds `bb-app` to its typecheck/build/test filters and runs `pnpm exec turbo run smoke:tarball --filter=bb-app` after the tests.
- **R21 Beta declaration.** `docs/platform-support.md`, `README.md` and `packages/bb-app/README.md` add a "Native Windows (beta)" path beside WSL2 (WSL2 stays supported); `docs/platform-windows.md` flips the Phase 3 status row, replaces every "arrives in Phase 3" bullet, and records the new measured facts. Docs are written in Task 13 and corrected by the gate if a claim fails.
- **R22 Skill scripts.** Still not spawned by bb (Phase 2 R7); the guidance in `docs/platform-windows.md` gains the provider launch facts and nothing else.
- **R23 `node-pty-fd-leak.test.ts`.** Stays `runIf(darwin|linux)` (it counts `/dev/ptmx` with `lsof`) with a `docs/platform-windows.md` entry; the terminal manager's silent `if (process.platform === "win32") return` becomes `it.skipIf(process.platform === "win32")` with a name suffix ` (POSIX /bin/sh)` and a win32 twin lives in the new real-ConPTY test file.
- **R24 Test worker isolation.** The new `terminal-manager.win32.test.ts` and the provider-installation ConPTY test spawn real ConPTY sessions that keep a socket handle alive; both files are added to the host-daemon vitest isolated list only if the shared worker fails to exit (measure, record in the report).
- **R25 Codex/Claude in CI.** CI has no provider binaries; every provider launch test is unit-level with an injected spawner, and the real turns are gate evidence on the reference desktop.
- **R26 Terminal exit on failure to resolve a shell.** When R1 throws, the manager sends `sendTerminalError({ code: "shell_unavailable", message })` (a new code in the existing string enum is not a wire change because the app renders codes generically; verify in Task 2 and report if the enum is a strict zod enum, in which case reuse `spawn_failed`).
- **R27 Protocol bump placement.** Task 6 is the only commit touching `HOST_DAEMON_PROTOCOL_VERSION`; its brief carries the 200 → 201 edit and the compatibility note.

## File Structure

| Path                                                                                                                                                                             | Responsibility                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/process-utils/src/resolve-executable.ts` (+ `test/resolve-executable.test.ts`)                                                                                         | `resolveExecutableSync`, `resolveSpawnPlan`, npm-launcher shim pattern                |
| `packages/process-utils/src/run-command-capture.ts` (+ test)                                                                                                                     | `runCommandCapture`                                                                   |
| `packages/process-utils/src/index.ts`                                                                                                                                            | re-exports                                                                            |
| `apps/host-daemon/src/terminals/terminal-manager.ts` (+ `.test.ts`, new `terminal-manager.win32.test.ts`)                                                                        | win32 shell resolution, args, env, kill, sweep root, UTF-8 write, failed-open cleanup |
| `apps/host-daemon/src/provider-installation.ts` (+ `.test.ts`)                                                                                                                   | ConPTY install on win32 through `resolveSpawnPlan`, tree termination on cancel        |
| `apps/host-daemon/src/command-dispatch.ts`                                                                                                                                       | passes `platform` to the installation runner                                          |
| `packages/provider-bridge-protocol/src/bridge-kit/provider-maintenance-kit.ts` (+ test)                                                                                          | platform-injected kit, `downloadedInstallerCommand` null on win32                     |
| `packages/provider-bridge-protocol/src/provider-maintenance.ts`, `packages/host-daemon-contract/src/local.ts`, `packages/host-daemon-contract/src/protocol.ts`                   | `installUnavailableReason`, protocol 201                                              |
| `apps/server/src/services/system/*`, `apps/app/src/components/provider-cli/provider-cli-install.tsx`, `apps/cli/src/commands/updates.ts`, `apps/cli/src/commands/machine.ts`     | carry and render the reason                                                           |
| `plugins/provider-codex/src/bridge/{app-server-connection,provider-maintenance}.ts`                                                                                              | resolve-then-spawn, matrix                                                            |
| `plugins/provider-claude-code/src/bridge/{session-options,model-list,sdk-session,provider-maintenance}.ts` (+ `__tests__/session-options-win32.test.ts`)                         | PATHEXT lookup, well-known paths, install reason                                      |
| `plugins/provider-pi/src/bridge/{rpc-child,provider-maintenance}.ts`                                                                                                             | resolve-then-spawn, `bunCommand(platform)`                                            |
| `packages/provider-bridge-acp/src/bridge/{agent-connection,bridge}.ts`                                                                                                           | resolve-then-spawn                                                                    |
| `apps/host-daemon/src/runtime-manager.ts`, `apps/host-daemon/src/runtime-shell-env.ts`                                                                                           | `assignPathEnv` overlay, `prependPath(platform)`                                      |
| `plugins/environment-git-worktree/host/worktree.ts`, `plugins/environment-personal-workspace/host.ts`                                                                            | `onSkippedProcess` to stderr                                                          |
| `packages/host-watcher/src/watch-event-path.ts` (+ test), `parcel-host-watcher.ts`, `watch-path.ts`, `watch-specs.ts`, `parcel-subprocess/parcel-child-handler.ts`               | NTFS event-path handling                                                              |
| `apps/desktop/src/log-viewer.ts` (+ test), `apps/desktop/src/main.ts`                                                                                                            | win32 file follower                                                                   |
| `apps/desktop/scripts/smoke-windows-conpty.mjs`, `apps/desktop/package.json`, `turbo.json`                                                                                       | ConPTY smoke as a Turbo task                                                          |
| `packages/bb-app/scripts/smoke-tarball.mjs`, `.github/workflows/ci.yml`                                                                                                          | tarball smoke on Windows                                                              |
| `docs/platform-windows.md`, `docs/platform-support.md`, `README.md`, `packages/bb-app/README.md`, `docs/api_to_audit.md`, `docs/configuration.md`, bb-guide templates and skills | documentation                                                                         |
| `qa/windows/phase-3/`                                                                                                                                                            | gate evidence                                                                         |

---

### Task 1: Resolve-then-spawn seam in `@bb/process-utils`

**Files:**

- Modify: `packages/process-utils/src/resolve-executable.ts`
- Create: `packages/process-utils/src/run-command-capture.ts`
- Modify: `packages/process-utils/src/index.ts` (re-exports)
- Test: `packages/process-utils/test/resolve-executable.test.ts`, `packages/process-utils/test/run-command-capture.test.ts`

**Interfaces:**

- Consumes: `resolveExecutable`, `readNodeCmdShim`, `resolveNodeShimSpawnPlan`, `windowsExecutableExtensions`, `joinExecutablePath`, `readWindowsEnvValue`, `splitWindowsPathList` (Phase 2).
- Produces (used by Tasks 2, 4, 5, 7, 10):
  - `resolveExecutableSync(args: ResolveExecutableArgs): string | null` — synchronous twin of `resolveExecutable` with identical semantics (`accessSync(X_OK)` on POSIX; extension/PATHEXT on win32).
  - `interface SpawnPlan { command: string; args: string[] }`
  - `interface ResolveSpawnPlanArgs { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; cwd?: string }`
  - `resolveSpawnPlan(args): Promise<SpawnPlan | null>` — POSIX: `{ command: args.command, args: [...args.args] }` with no filesystem access; win32: `resolveExecutable` → `null` when not found; then `resolveNodeShimSpawnPlan(found)` → `null` when a `.cmd`/`.bat` is not a Node shim; result `{ command: plan.command, args: [...plan.args, ...args.args] }`.
  - `class SpawnPlanUnavailableError extends Error { readonly reason: "not_found" | "not_node_shim"; readonly command: string; readonly resolvedPath: string | null }` with `spawnPlanUnavailableMessage(args)` producing `Command <name> was not found on Path` or `nodeShimRefusalMessage(resolvedPath)`.
  - `interface RunCommandCaptureArgs { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number; maxBytes?: number (default 1 MiB); platform?: NodeJS.Platform; windowsHide?: boolean }`
  - `interface CommandCaptureResult { stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; truncated: boolean }`
  - `runCommandCapture(args): Promise<CommandCaptureResult>` — resolves the plan with `resolveSpawnPlan` (throws `SpawnPlanUnavailableError` when null), spawns with `node:child_process.spawn` (`stdio: ["ignore", "pipe", "pipe"]`, `windowsHide: platform === "win32" ? (args.windowsHide ?? true) : args.windowsHide`), collects UTF-8 output capped at `maxBytes` per stream (`truncated: true` when capped, the child is killed with `terminateProcessTree` on win32 and `child.kill("SIGKILL")` elsewhere once the cap is hit), times out with the same termination and `timedOut: true`. On POSIX `resolveSpawnPlan` is identity, so a POSIX caller's command reaches `spawn` unchanged.

- [ ] **Step 1: Write the failing tests for `resolveExecutableSync`**

Add to `packages/process-utils/test/resolve-executable.test.ts` a `describe("resolveExecutableSync")` mirroring the existing async cases in the same file (create the same fixture directories with `mkdtempSync`): a win32 `Path` walk that finds `tool.exe` from `tool`; PATHEXT order (`.COM;.EXE` finds `x.com` before `x.exe`); an explicit `.cmd` found only when `.cmd` is in PATHEXT; a POSIX case that returns the executable file and `null` for a non-executable (`platform: "linux"`, `chmodSync(…, 0o644)`; skip the non-executable assertion with `it.skipIf(process.platform === "win32")` because NTFS has no mode bits). Assert that for every fixture the sync result `toBe` the awaited async result.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bb/process-utils exec vitest run test/resolve-executable.test.ts -t resolveExecutableSync`
Expected: FAIL with `resolveExecutableSync is not a function`.

- [ ] **Step 3: Implement `resolveExecutableSync`**

In `resolve-executable.ts` import `accessSync` from `node:fs` and add synchronous twins of `isPosixExecutableFile`, `fileExists`, `resolvePosixExecutable`, `findWindowsCandidate`, `resolveWindowsExecutable` (suffix `Sync`), then:

```ts
export function resolveExecutableSync(
  args: ResolveExecutableArgs,
): string | null {
  const platform = args.platform ?? process.platform;
  const env = args.env ?? process.env;
  const cwd = args.cwd ?? process.cwd();
  return platform === "win32"
    ? resolveWindowsExecutableSync(args.command, env, cwd)
    : resolvePosixExecutableSync(args.command, env, cwd);
}
```

Share the candidate-list computation between the async and sync forms by extracting `windowsCandidatePaths(base, extensions): string[]` (returns `[base]` when its extension is in `extensions`, then `base + suffix` for each suffix) and `posixCandidatePaths(command, env, cwd): string[]`, so the two forms cannot drift.

- [ ] **Step 4: Run to verify pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Write the failing tests for the npm-launcher shim pattern**

In the `readNodeCmdShim` describe, add a fixture written with the literal body of npm's launcher (this is the file measured on the reference desktop at `C:\nvm4w\nodejs\npm.cmd`):

```ts
const NPM_LAUNCHER_SHIM = [
  ":: Created by npm, please don't edit manually.",
  "@ECHO OFF",
  "SETLOCAL",
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" ( SET "NODE_EXE=node" )',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
  '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
  ")",
  'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" ( SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%" )',
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
  "",
].join("\r\n");
```

Expected result: `{ command: process.execPath, args: [resolve(shimDir, "node_modules", "npm", "bin", "npm-cli.js")] }`. Add the same shape for `npx.cmd` (`NPX_CLI_JS` → `npx-cli.js`). Add a negative: a launcher whose `SET "NPM_CLI_JS=…"` names a `.exe` returns `null`.

- [ ] **Step 6: Run to verify failure**

Expected: FAIL — `readNodeCmdShim` returns `null` for the npm launcher.

- [ ] **Step 7: Implement the npm-launcher pattern**

Add to `NODE_CMD_SHIM_PATTERNS` (keep the existing four first):

```ts
/^\s*SET\s+"NP[MX]_CLI_JS=%~dp0\\?([^"\r\n]+)"/imu,
```

`shimTargetsNode` already returns true for this body (`node.exe` appears). No other change.

- [ ] **Step 8: Run to verify pass**

Expected: PASS, including every pre-existing shim fixture.

- [ ] **Step 9: Write the failing tests for `resolveSpawnPlan`**

New describe in the same test file:

- POSIX identity: `await resolveSpawnPlan({ command: "definitely-missing-tool", args: ["--x"], platform: "linux", env: { PATH: "" } })` equals `{ command: "definitely-missing-tool", args: ["--x"] }` (no lookup on POSIX; assert also that a spy on `fs.access` is not called — use `vi.spyOn(await import("node:fs/promises"), "access")`, or simply assert the result for an empty PATH, which proves no resolution happened).
- win32 `.exe`: fixture `tool.exe` on `Path` → `{ command: "<dir>\\tool.exe", args: ["--x"] }`.
- win32 Node shim: fixture `tool.cmd` with body `@node "%~dp0\\..\\lib\\cli.js" %*` and an existing `lib/cli.js` → `{ command: process.execPath, args: ["<dir>\\..\\lib\\cli.js" resolved, "--x"] }`.
- win32 npm launcher: the Step 5 fixture as `npm.cmd` on `Path` → `process.execPath` + `npm-cli.js` + args.
- win32 not found → `null`; win32 `.cmd` that is not a Node shim (`@echo hi`) → `null`.
- `spawnPlanUnavailableMessage({ command: "npm", resolvedPath: null })` → `Command npm was not found on Path`; with `resolvedPath: "C:\\x\\t.cmd"` → `nodeShimRefusalMessage("C:\\x\\t.cmd")`.

- [ ] **Step 10: Run to verify failure**, then **Step 11: Implement**

```ts
export interface SpawnPlan {
  command: string;
  args: string[];
}
export interface ResolveSpawnPlanArgs {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
}
export class SpawnPlanUnavailableError extends Error {
  readonly reason: "not_found" | "not_node_shim";
  readonly command: string;
  readonly resolvedPath: string | null;
  constructor(args: { command: string; resolvedPath: string | null }) {
    super(spawnPlanUnavailableMessage(args));
    this.name = "SpawnPlanUnavailableError";
    this.reason = args.resolvedPath === null ? "not_found" : "not_node_shim";
    this.command = args.command;
    this.resolvedPath = args.resolvedPath;
  }
}
export function spawnPlanUnavailableMessage(args: {
  command: string;
  resolvedPath: string | null;
}): string {
  return args.resolvedPath === null
    ? `Command ${args.command} was not found on Path`
    : nodeShimRefusalMessage(args.resolvedPath);
}
export async function resolveSpawnPlan(
  args: ResolveSpawnPlanArgs,
): Promise<SpawnPlan | null> {
  const platform = args.platform ?? process.platform;
  if (platform !== "win32") {
    return { command: args.command, args: [...args.args] };
  }
  const resolved = await resolveExecutable({
    command: args.command,
    env: args.env,
    platform,
    cwd: args.cwd,
  });
  if (resolved === null) return null;
  const shimPlan = await resolveNodeShimSpawnPlan(resolved);
  if (shimPlan === null) return null;
  return { command: shimPlan.command, args: [...shimPlan.args, ...args.args] };
}
```

Also add `resolveSpawnPlanOrThrow(args)` returning the plan or throwing `SpawnPlanUnavailableError` (it needs the resolved path for the message: compute `resolveExecutable` once inside and reuse; restructure so `resolveSpawnPlan` is implemented on top of an internal `resolveSpawnPlanDetailed` returning `{ plan, resolvedPath }`).

- [ ] **Step 12: Run to verify pass**

- [ ] **Step 13: Write the failing tests for `runCommandCapture`** (new file `test/run-command-capture.test.ts`)

Use `process.execPath` with `-e` scripts (portable on every platform, no PATH dependency, `platform` pinned to `process.platform` so the plan is identity on POSIX and an `.exe` path on win32):

- captures stdout and stderr and `exitCode: 0`: `-e "process.stdout.write('out'); process.stderr.write('err')"`.
- non-zero exit: `-e "process.exit(3)"` → `exitCode: 3`, `timedOut: false`.
- timeout: `-e "setTimeout(()=>{}, 60000)"` with `timeoutMs: 300` → `timedOut: true`, `exitCode` null or non-zero, the promise settles within 5 s.
- cap: `-e "process.stdout.write('x'.repeat(200000))"` with `maxBytes: 1024` → `truncated: true`, `stdout.length <= 1024`.
- unavailable command on win32: `it.runIf(process.platform === "win32")` — `command: "definitely-missing-tool-xyz"` rejects with `SpawnPlanUnavailableError` whose `reason` is `not_found`.
- POSIX unavailable: `it.skipIf(win32)` — `command: "definitely-missing-tool-xyz"` resolves with `exitCode: null` and an `error` field? No — keep the contract simple: on POSIX a spawn `error` event resolves the promise with `{ stdout: "", stderr: "", exitCode: null, signal: null, timedOut: false, truncated: false, spawnError: "<message>" }`; add `spawnError: string | null` to `CommandCaptureResult` and assert `spawnError` contains `ENOENT`.

- [ ] **Step 14: Run to verify failure**, then **Step 15: Implement `run-command-capture.ts`**

```ts
import { spawn } from "node:child_process";
import { resolveSpawnPlanOrThrow } from "./resolve-executable.js";
import { terminateProcessTree } from "./windows-process-stop.js";

const DEFAULT_CAPTURE_MAX_BYTES = 1024 * 1024;

export interface RunCommandCaptureArgs { … as in Interfaces … }
export interface CommandCaptureResult { … as in Interfaces, plus spawnError: string | null … }

export async function runCommandCapture(args: RunCommandCaptureArgs): Promise<CommandCaptureResult> {
  const platform = args.platform ?? process.platform;
  const plan = await resolveSpawnPlanOrThrow({ command: args.command, args: args.args, env: args.env, platform, cwd: args.cwd });
  const maxBytes = args.maxBytes ?? DEFAULT_CAPTURE_MAX_BYTES;
  return new Promise((resolveResult) => {
    const child = spawn(plan.command, plan.args, {
      cwd: args.cwd,
      env: args.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(platform === "win32" ? { windowsHide: args.windowsHide ?? true } : args.windowsHide === undefined ? {} : { windowsHide: args.windowsHide }),
    });
    …collect chunks per stream into Buffer arrays with a running byte count; once a stream exceeds maxBytes mark truncated, stop appending, and call stop("cap")…
    …const timer = setTimeout(() => stop("timeout"), args.timeoutMs)…
    …function stop(reason): if (platform === "win32") void terminateProcessTree({ child, graceMs: 0, platform }); else child.kill("SIGKILL")…
    …child.once("error", (error) => settle({ spawnError: error.message, exitCode: null, signal: null }))…
    …child.once("close", (code, signal) => settle({ exitCode: code, signal, spawnError: null }))…
    …settle clears the timer, decodes buffers as utf8, resolves once…
  });
}
```

`terminateProcessTree` accepts the `ChildProcess` (`pid`, `exitCode`, `signalCode`, `kill`). Do not use `execFile`; do not use `shell`.

- [ ] **Step 16: Run to verify pass**; export everything from `src/index.ts` (`resolveExecutableSync`, `resolveSpawnPlan`, `resolveSpawnPlanOrThrow`, `SpawnPlan`, `ResolveSpawnPlanArgs`, `SpawnPlanUnavailableError`, `spawnPlanUnavailableMessage`, `runCommandCapture`, `RunCommandCaptureArgs`, `CommandCaptureResult`).

- [ ] **Step 17: Typecheck, full package test, format, commit**

Run: `pnpm exec turbo run typecheck test --filter=@bb/process-utils`; `pnpm exec oxfmt packages/process-utils/src/resolve-executable.ts packages/process-utils/src/run-command-capture.ts packages/process-utils/src/index.ts packages/process-utils/test/resolve-executable.test.ts packages/process-utils/test/run-command-capture.test.ts`.

```bash
git add packages/process-utils
git commit -m "Add a resolve-then-spawn seam and npm launcher shim support to @bb/process-utils"
```

---

### Task 2: Windows terminal shell resolution, spawn arguments and environment

**Files:**

- Modify: `apps/host-daemon/src/terminals/terminal-manager.ts`
- Test: `apps/host-daemon/src/terminals/terminal-manager.test.ts`

**Interfaces:**

- Consumes: `resolveExecutable`, `resolveWindowsSystemToolPath`, `readWindowsEnvValue`, `assignPathEnv`, `sanitizeInheritedChildProcessEnv` from `@bb/process-utils`; `TerminalManagerOptions.platform` (already injected, default `process.platform` at `apps/host-daemon/src/app.ts:700-707`).
- Produces (used by Task 3 and Task 11):
  - `export interface ResolveDefaultTerminalShellArgs { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; pathIsExecutable?: (filePath: string) => Promise<boolean>; resolveExecutable?: typeof resolveExecutable }`
  - `export async function resolveDefaultTerminalShell(args?: ResolveDefaultTerminalShellArgs): Promise<string>` (R1).
  - `export class TerminalShellUnavailableError extends Error` with message `No terminal shell was found: tried pwsh.exe, powershell.exe, ComSpec and cmd.exe`.
  - `export function terminalSpawnArgsForStart(message, shell, platform): string[]` (R2).
  - `export function buildTerminalEnv(args: { shellEnv, terminalId, platform?, inheritedEnv? }): NodeJS.ProcessEnv` (R3).
  - `export function terminalTitleFromShell(shell, platform): string`.

Rulings in force: R1, R2, R3, R26. The `unsupported_platform` block at `terminal-manager.ts:566-574` and its test `"rejects native Windows opens"` (`terminal-manager.test.ts:1389-1433`) are removed in this task.

- [ ] **Step 1: Write the failing tests (Linux-runnable, injected platform)**

Add a `describe("resolveDefaultTerminalShell")`:

- win32 prefers `pwsh` from `Path`: `resolveExecutable` stub returns `"C:\\Program Files\\PowerShell\\7\\pwsh.exe"` for `{ command: "pwsh", platform: "win32" }` → result equals it.
- win32 falls back to `%ProgramFiles%\PowerShell\7\pwsh.exe` when `resolveExecutable` returns `null` and `pathIsExecutable` (win32 meaning: exists) is true for that path (env `ProgramFiles: "C:\\Program Files"`).
- win32 falls back to `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` (env `SystemRoot: "C:\\Windows"`).
- win32 falls back to `ComSpec` (`"D:\\shells\\cmd.exe"`), then to `C:\\Windows\\System32\\cmd.exe`.
- win32 with nothing available rejects with `TerminalShellUnavailableError`.
- POSIX (`platform: "linux"`, `env: { SHELL: "/usr/bin/fish" }`, `pathIsExecutable` true only for `/usr/bin/fish`) → `/usr/bin/fish`; with nothing executable → `/bin/sh` (today's fallback, unchanged).

`describe("terminalSpawnArgsForStart")`:

- `("shell", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32")` → `["-NoLogo"]`; `("command", …, "win32")` with command `git status` → `["-NoLogo", "-Command", "git status"]`; same for `powershell.exe`.
- `("shell", "C:\\Windows\\System32\\cmd.exe", "win32")` → `[]`; `command` → `["/s", "/c", "git status"]`.
- POSIX: `("shell", "/bin/zsh", "linux")` → `[]`; `("command", "/bin/zsh", "linux")` → `["-lc", "git status"]`.
- Regression guard: `expect(args).not.toContain("-NoProfile")` and `not.toContain("chcp")` for both win32 shells.

`describe("buildTerminalEnv")`:

- win32: `inheritedEnv: { Path: "C:\\old", PATH: "C:\\older", HOME: "x" }`, `shellEnv: { PATH: "C:\\bb;C:\\old" }` → `Object.keys(env).filter((k) => k.toLowerCase() === "path")` equals `["Path"]` and `env.Path === "C:\\bb;C:\\old"`; `BB_TERMINAL_SESSION_ID`, `TERM`, `COLORTERM` present.
- win32 without `shellEnv.PATH` → `Path` equals `inheritedEnv.Path`.
- POSIX (`platform: "linux"`): the returned object deep-equals today's shape exactly (spread sanitized env, `shellEnv`, then the six fixed keys) — write the expectation as the literal object.

`describe("terminalTitleFromShell")`: `("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32")` → `pwsh.exe`; `("/bin/zsh", "linux")` → `zsh`.

Also change the existing `"rejects native Windows opens"` test into `"opens a native Windows terminal through the injected adapter"`: same harness with `platform: "win32"`, a fake adapter recording `spawn` args and a `resolveShell` returning `C:\\Program Files\\PowerShell\\7\\pwsh.exe`; assert `terminal.opened` is sent with `shell` equal to that path and `title: "pwsh.exe"`, and the adapter received `args: ["-NoLogo"]` and an env with a single `Path`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bb/host-daemon exec vitest run src/terminals/terminal-manager.test.ts > <scratchpad>/t2-red.log 2>&1; tail -40 <scratchpad>/t2-red.log`.

- [ ] **Step 3: Implement**

```ts
export class TerminalShellUnavailableError extends Error {
  constructor() {
    super(
      "No terminal shell was found: tried pwsh.exe, powershell.exe, ComSpec and cmd.exe",
    );
    this.name = "TerminalShellUnavailableError";
  }
}

export interface ResolveDefaultTerminalShellArgs {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathIsExecutable?: (filePath: string) => Promise<boolean>;
  resolveExecutable?: typeof resolveExecutable;
}

async function resolveWindowsTerminalShell(
  args: Required<ResolveDefaultTerminalShellArgs>,
): Promise<string> {
  const onPath = await args.resolveExecutable({
    command: "pwsh",
    env: args.env,
    platform: "win32",
  });
  if (onPath !== null) return onPath;
  const programFiles = readWindowsEnvValue(args.env, "ProgramFiles");
  const candidates = [
    ...(programFiles === undefined
      ? []
      : [joinExecutablePath("win32", programFiles, "PowerShell\\7\\pwsh.exe")]),
    resolveWindowsSystemToolPath(
      "WindowsPowerShell\\v1.0\\powershell.exe",
      args.env,
    ),
    ...(readWindowsEnvValue(args.env, "ComSpec") === undefined
      ? []
      : [readWindowsEnvValue(args.env, "ComSpec")]),
    resolveWindowsSystemToolPath("cmd.exe", args.env),
  ];
  for (const candidate of candidates) {
    if (await args.pathIsExecutable(candidate)) return candidate;
  }
  throw new TerminalShellUnavailableError();
}

export async function resolveDefaultTerminalShell(
  args: ResolveDefaultTerminalShellArgs = {},
): Promise<string> {
  const platform = args.platform ?? process.platform;
  const env = args.env ?? process.env;
  const pathIsExecutableFn =
    args.pathIsExecutable ??
    (platform === "win32" ? pathExists : pathIsExecutable);
  if (platform === "win32") {
    return resolveWindowsTerminalShell({
      platform,
      env,
      pathIsExecutable: pathIsExecutableFn,
      resolveExecutable: args.resolveExecutable ?? resolveExecutable,
    });
  }
  const candidates = [env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(
    isNonEmptyString,
  );
  for (const candidate of candidates) {
    if (await pathIsExecutableFn(candidate)) return candidate;
  }
  return "/bin/sh";
}
```

Check `resolveWindowsSystemToolPath`'s contract in `packages/process-utils/src/windows-system-tools.ts` before using a sub-path like `WindowsPowerShell\\v1.0\\powershell.exe`: if it only accepts a bare file name, build the 5.1 path with `joinExecutablePath("win32", readWindowsEnvValue(env, "SystemRoot") ?? "C:\\Windows", "System32\\WindowsPowerShell\\v1.0\\powershell.exe")`. `pathExists` is `access(path, constants.F_OK)`.

`TerminalManagerOptions.resolveShell` keeps its type `() => Promise<string>`; the constructor default becomes `() => resolveDefaultTerminalShell({ platform: this.platform })` — the composition root passes nothing.

```ts
function isPowerShellExecutable(shell: string): boolean {
  const name = shell.split(/[/\\]/u).pop()?.toLowerCase() ?? "";
  return name === "pwsh.exe" || name === "powershell.exe" || name === "pwsh";
}

export function terminalSpawnArgsForStart(message: TerminalOpenMessage, shell: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") {
    switch (message.start.mode) {
      case "shell": return [];
      case "command": return ["-lc", message.start.command];
    }
  }
  const powerShell = isPowerShellExecutable(shell);
  switch (message.start.mode) {
    case "shell": return powerShell ? ["-NoLogo"] : [];
    case "command": return powerShell ? ["-NoLogo", "-Command", message.start.command] : ["/s", "/c", message.start.command];
  }
}

interface BuildTerminalEnvArgs { shellEnv: …; terminalId: string; platform?: NodeJS.Platform; inheritedEnv?: NodeJS.ProcessEnv }

export function buildTerminalEnv(args: BuildTerminalEnvArgs): NodeJS.ProcessEnv {
  const platform = args.platform ?? process.platform;
  const inheritedEnv = args.inheritedEnv ?? process.env;
  const merged: NodeJS.ProcessEnv = {
    ...sanitizeInheritedChildProcessEnv({ env: inheritedEnv }),
    ...args.shellEnv,
    BB_TERMINAL_SESSION_ID: args.terminalId,
    COLORTERM: "truecolor",
    DISABLE_AUTO_TITLE: "true",
    FORCE_HYPERLINK: "1",
    PROMPT_EOL_MARK: "",
    TERM: "xterm-256color",
  };
  if (platform !== "win32") return merged;
  const path = args.shellEnv.PATH ?? readWindowsEnvValue(inheritedEnv, "Path") ?? "";
  return assignPathEnv({ env: merged, path, platform: "win32" });
}

export function terminalTitleFromShell(shell: string, platform: NodeJS.Platform): string {
  const base = platform === "win32" ? (shell.split(/[/\\]/u).pop() ?? "") : path.basename(shell);
  return base || "Terminal";
}
```

`terminalTitleForStart` passes `this.platform` through. In `openTerminal` delete the `unsupported_platform` block, call `terminalSpawnArgsForStart(message, shell, this.platform)`, `buildTerminalEnv({ …, platform: this.platform })`, and map a `TerminalShellUnavailableError` thrown by `resolveShell` to `sendTerminalError({ code: "shell_unavailable", message: error.message, … })` inside the existing `catch` (the `code` field is a plain `string`, `SendTerminalErrorArgs.code: string`; confirm the app renders unknown codes generically and note it in the report).

- [ ] **Step 4: Run to verify pass** (same command, green log), then run the whole file to confirm nothing else regressed.

- [ ] **Step 5: Typecheck, format, commit**

`pnpm exec turbo run typecheck --filter=@bb/host-daemon`; `pnpm exec oxfmt apps/host-daemon/src/terminals/terminal-manager.ts apps/host-daemon/src/terminals/terminal-manager.test.ts`.

```bash
git add apps/host-daemon/src/terminals
git commit -m "Resolve Windows terminal shells and spawn them with a single Path key"
```

---

### Task 3: ConPTY kill semantics, sweep root, UTF-8 write, failed-open cleanup and the real Windows terminal test

**Files:**

- Modify: `apps/host-daemon/src/terminals/terminal-manager.ts`
- Modify: `apps/host-daemon/src/terminals/terminal-manager.test.ts` (the silent win32 return at `:1436-1438`)
- Create: `apps/host-daemon/src/terminals/terminal-manager.win32.test.ts`
- Modify (only if measured necessary, R24): `apps/host-daemon/vitest.config.ts`

**Interfaces:**

- Consumes: `registerSweepRootProcess`, `unregisterSweepRootProcess`, `queryWindowsProcess` from `@bb/process-utils`; Task 2's exports.
- Produces: `TerminalPtyProcess.pid?: number`; `export function terminalCloseSupportsForceKill(platform: NodeJS.Platform): boolean` (false on win32); constants `TERMINAL_SWEEP_REGISTER_RETRY_MS = 250`, `TERMINAL_SWEEP_REGISTER_RETRIES = 12`.

Rulings in force: R4, R5, R6, R7, R8, R23, R24. Measured facts the tests encode: node-pty throws `Signals not supported on windows.` for any signal; `pty.pid` is 0 for 90–178 ms after spawn; `pty.kill()` returns in ≈20 ms and the process leaves `tasklist` in ≈90 ms with exit code `-1073741510`; a detached grandchild survives `pty.kill()`; `-NoLogo` loads the profile; Ctrl+C (`\x03`) interrupts `Start-Sleep` in ≈470 ms.

- [ ] **Step 1: Write the failing unit tests (fake adapter, Linux-runnable)**

In `terminal-manager.test.ts`, using the file's existing fake-adapter harness with `platform: "win32"`:

- `"closes a Windows terminal with a single kill and no force stage"`: open, close, advance fake timers past `closeGracePeriodMs`; assert the adapter's `kill` was called exactly once with `undefined` and never with `"SIGKILL"`, and `terminal.exited` was sent once with the session's `closeReason`.
- `"keeps the two-stage close on POSIX"`: `platform: "linux"`; assert `kill()` then `kill("SIGKILL")` after the grace period (this pins today's behaviour; write it as the exact call list).
- `"registers the Windows pty as a sweep root once its pid is known"`: fake pty whose `pid` getter returns `0` for the first two reads then `4242`; use fake timers; after `2 * TERMINAL_SWEEP_REGISTER_RETRY_MS` assert `listSweepRootProcesses()`-style visibility — if `@bb/process-utils` has no read accessor for the registry, add `export function isSweepRootProcess(pid: number): boolean` to `windows-process-snapshot.ts` in this task (tiny, test-only consumer is fine) — then close and assert it is unregistered.
- `"does not register sweep roots on POSIX"`: `platform: "linux"`, pid `4242` → `isSweepRootProcess(4242)` is false.
- `"writes string input as UTF-8 bytes on Windows"`: trigger the DA1 auto-reply path (send output containing `\u001b[c`) and assert the adapter's `write` received a `Buffer` equal to `Buffer.from(PRIMARY_DEVICE_ATTRIBUTES_RESPONSE, "utf8")`; POSIX twin asserts a string is passed through (today's behaviour).
- `"kills the orphan pty when a Windows open fails after spawn"`: adapter `spawn` succeeds, `runtimeManager.markTerminalActive` throws; assert the fake pty's `kill` and `dispose` were called and no session remains; POSIX twin asserts today's behaviour (no kill call) — name it `"leaves the orphan pty alone on POSIX (pre-existing upstream behaviour)"`.

Change `it("runs commands in one persistent shell from the workspace cwd", …)` at `:1436` to `it.skipIf(process.platform === "win32")("runs commands in one persistent shell from the workspace cwd (POSIX /bin/sh)", …)` and delete the `if (process.platform === "win32") { return; }` lines. Nothing else in that test changes.

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

```ts
export interface TerminalPtyProcess {
  readonly pid?: number;
  …
}

const TERMINAL_SWEEP_REGISTER_RETRY_MS = 250;
const TERMINAL_SWEEP_REGISTER_RETRIES = 12;

export function terminalCloseSupportsForceKill(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

const nodePtyAdapter: TerminalPtyAdapter = {
  spawn(args) {
    ensureNodePtySpawnHelperExecutable(args.logger);
    const platform = args.platform ?? process.platform;
    const pty = spawnPty(args.file, args.args, { cols: args.cols, cwd: args.cwd, env: args.env, name: "xterm-256color", rows: args.rows });
    return {
      get pid() { return pty.pid; },
      dispose: () => disposeNodePty(pty),
      kill: (signal) => {
        if (platform === "win32") { pty.kill(); return; }
        killProcessGroup({ child: { pid: pty.pid, kill: (groupSignal) => pty.kill(groupSignal) }, signal: signal ?? "SIGHUP" });
      },
      onData: …, onExit: …, resize: …,
      write: (data) => pty.write(platform === "win32" && typeof data === "string" ? Buffer.from(data, "utf8") : data),
    };
  },
};
```

`SpawnTerminalPtyArgs` gains `platform?: NodeJS.Platform`; `openTerminal` passes `this.platform`. `TerminalSession` gains `sweepPid: number | null` and `sweepTimer: NodeJS.Timeout | null`.

```ts
private registerTerminalSweepRoot(session: TerminalSession, cwd: string, attempt = 0): void {
  if (this.platform !== "win32") return;
  const pid = session.pty.pid ?? 0;
  if (pid > 0) {
    registerSweepRootProcess({ pid, cwd });
    session.sweepPid = pid;
    return;
  }
  if (attempt >= TERMINAL_SWEEP_REGISTER_RETRIES) {
    this.options.logger.warn({ terminalId: session.terminalId }, "Terminal pty never reported a pid; sweep root not registered");
    return;
  }
  session.sweepTimer = setTimeout(() => {
    session.sweepTimer = null;
    if (this.sessions.get(session.terminalId) === session) this.registerTerminalSweepRoot(session, cwd, attempt + 1);
  }, TERMINAL_SWEEP_REGISTER_RETRY_MS);
}

private unregisterTerminalSweepRoot(session: TerminalSession): void {
  if (session.sweepTimer !== null) { clearTimeout(session.sweepTimer); session.sweepTimer = null; }
  if (session.sweepPid !== null) { unregisterSweepRootProcess(session.sweepPid); session.sweepPid = null; }
}
```

Call `registerTerminalSweepRoot(session, target.cwd)` right after `this.sessions.set(...)`; call `unregisterTerminalSweepRoot(session)` at the top of `finishTerminalSession`.

`forceCloseTerminal`: when `!terminalCloseSupportsForceKill(this.platform)` skip the `kill("SIGKILL")` try-block and log `"Terminal did not exit after close; finishing session (single close on this platform)"`, then `finishTerminalSession` as today.

`openTerminal` failed-open cleanup (win32 only): wrap the steps after `this.ptyAdapter.spawn` so that on throw, when `this.platform === "win32"`, the orphan `pty` is killed (`pty.kill()` in a try) and disposed, the session removed, `unregisterTerminalSweepRoot` called and `markTerminalInactive` invoked if it had been marked active; POSIX path unchanged.

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Write the real Windows test** (`terminal-manager.win32.test.ts`, `describe.runIf(process.platform === "win32")`, `testTimeout` 30 s)

Build a `TerminalManager` with the real `nodePtyAdapter` (default), a recording `sendMessage`, a stub `runtimeManager` whose `getShellEnv()` returns `{ PATH: process.env.Path ?? "", BB_CLI: "", BB_SERVER_URL: "" }` (check the `AgentRuntimeOptions["shellEnv"]` shape), and a `host_path` target at a temp dir. Cases:

- `"echoes UTF-8 through ConPTY"`: open (`start: { mode: "shell" }`), wait for `terminal.opened`, send input `Buffer.from("Write-Output ('При' + 'вет')\r", "utf8").toString("base64")`, collect `terminal.output` chunks (decode base64 → utf8) until they contain `Привет` (10 s); assert.
- `"resizes without ending the session"`: resize to 120×40 then 80×30, then a marker command `Write-Output ('BB_' + 'RESIZE_OK')` echoes back.
- `"interrupts a running command with Ctrl+C"`: send `Start-Sleep -Seconds 30\r`, wait 300 ms, send base64 of `Buffer.from([0x03])`, then `Write-Output ('BB_' + 'CTRLC_OK')\r`; assert the marker arrives within 5 s.
- `"closes with a single kill and the process disappears"`: read `session.pty.pid` through a test accessor (add `listOpenTerminalPids()` to `TerminalManager` if none exists — or read the pid from the sweep registry with `isSweepRootProcess`), close, wait for `terminal.exited`; assert `await queryWindowsProcess(pid)` is `null` within 5 s and that the exit code is `-1073741510` (document R8).
- `"registers the pty as a sweep root"`: after open, poll `isSweepRootProcess(pid)` for up to 3 s → true; after close → false.

`afterEach`: close every terminal; `afterAll`: nothing else (the ConPTY socket handle keeps the worker alive — R24: if the vitest run does not exit, add this file to the isolated list in `apps/host-daemon/vitest.config.ts` and record the measurement).

- [ ] **Step 6: Run it on the reference desktop**

Run: `pnpm --filter @bb/host-daemon exec vitest run src/terminals/terminal-manager.win32.test.ts > <scratchpad>/t3-win32.log 2>&1`. Expected: 5 passed. Negative control once (do not commit): temporarily make the adapter's win32 `kill` call `pty.kill("SIGHUP")` and observe the close test fail with `Signals not supported on windows.`; restore. Record both runs in the report.

- [ ] **Step 7: Typecheck, run both terminal test files, format, commit**

```bash
git add apps/host-daemon/src/terminals apps/host-daemon/vitest.config.ts packages/process-utils
git commit -m "Close ConPTY terminals with a single kill and register them as sweep roots on Windows"
```

---

### Task 4: Provider installation through ConPTY on Windows

**Files:**

- Modify: `apps/host-daemon/src/provider-installation.ts`
- Modify: `apps/host-daemon/src/command-dispatch.ts` (`runProviderInstallationOnHost`, lines 222-300: pass `platform`)
- Test: `apps/host-daemon/src/provider-installation.test.ts`, new `apps/host-daemon/src/provider-installation.win32.test.ts`

**Interfaces:**

- Consumes: `resolveSpawnPlan`, `spawnPlanUnavailableMessage`, `terminateProcessTree` (Task 1, Phase 2); `providerCliEnvFromShellEnv` (already `assignPathEnv`-based).
- Produces: `streamProviderInstallation(args: { providerId; plan; env?; processSpawner?; platform?: NodeJS.Platform })` — same return type; `ProviderInstallationProcessSpawner.spawn(args: { command; args; env?; platform })`.

Ruling in force: R10. Measured: ConPTY (`CreateProcessW` with a null application name) cannot start `npm.cmd` (error 193); `pty.kill()` kills only the leader.

- [ ] **Step 1: Write the failing unit tests**

In `provider-installation.test.ts` (injected `processSpawner`):

- `"rewrites a Windows npm plan to node.exe npm-cli.js before spawning"`: `platform: "win32"`, `plan: { command: "npm", args: ["install", "-g", "x@latest"], displayCommand: "npm install -g x@latest" }`, inject `resolveSpawnPlan` (add `resolveSpawnPlan?:` to the args for tests, default the real one) returning `{ command: "C:\\nodejs\\node.exe", args: ["C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "install", "-g", "x@latest"] }`; assert the spawner received exactly that command/args and the `started` event still carries `displayCommand`.
- `"emits an error event when a Windows plan cannot be resolved"`: `resolveSpawnPlan` returns `null` → events are `started` then `error` with message `Command npm was not found on Path` (use `spawnPlanUnavailableMessage`), then the stream closes and the provider lock is released (a second call does not throw `ProviderInstallationInProgressError`).
- `"passes POSIX plans through unchanged"`: `platform: "linux"` with the same `sh -c` plan → spawner receives `command: "sh"`, `args: ["-c", …]`, and `resolveSpawnPlan` is not consulted (assert the injected stub was not called).
- `"cancels a Windows installation through the process tree"`: the injected spawner returns a process whose `kill` records calls; cancel the stream; assert `kill` was called with `undefined` on win32 and with `"SIGTERM"` on linux.

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

```ts
export interface ProviderInstallationProcessSpawner {
  spawn(args: {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  }): ProviderInstallationProcess;
}
```

`createPtyProviderInstallationProcessSpawner`: `kill(signal)` → on win32 `pty.kill()` then `void terminateProcessTree({ child: { pid: pty.pid, exitCode: exited ? 0 : null, signalCode: null, kill: () => { pty.kill(); return true; } }, graceMs: 0, platform: "win32" })` where `exited` is tracked from `onExit`; on POSIX `pty.kill(signal)` as today. `ProviderInstallationProcess.kill(signal?: NodeJS.Signals)`.

`streamProviderInstallation`: resolve `const platform = args.platform ?? process.platform`; in `start`, before spawning, when `platform === "win32"`:

```ts
const resolved = await (args.resolveSpawnPlan ?? resolveSpawnPlan)({
  command: args.plan.command,
  args: args.plan.args,
  env: args.env ?? process.env,
  platform,
});
if (resolved === null) {
  write({
    type: "error",
    provider: args.providerId,
    message: spawnPlanUnavailableMessage({
      command: args.plan.command,
      resolvedPath: await resolveExecutable({
        command: args.plan.command,
        env: args.env ?? process.env,
        platform,
      }),
    }),
  });
  close();
  return;
}
```

(`start` may be `async`; the `ReadableStream` contract allows a promise.) Spawn with `resolved.command`/`resolved.args` on win32, `args.plan.command`/`args.plan.args` elsewhere. `cancel()` calls `child?.kill(platform === "win32" ? undefined : "SIGTERM")`.

`runProviderInstallationOnHost` passes `platform: process.platform` explicitly (composition root) — or better, `options.platform` if `CommandDispatchOptions` already carries one (check; Phase 2 added `platform` to several dispatch helpers).

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Write and run the real Windows test** (`provider-installation.win32.test.ts`, `describe.runIf(win32)`)

Stream `{ command: "node", args: ["-e", "process.stdout.write('BB_CONPTY_INSTALL_OK')"], displayCommand: "node -e …" }` with the real spawner and `env: process.env`; read the NDJSON events; assert an `output` event contains `BB_CONPTY_INSTALL_OK` and `completed` has `success: true`. Second case: `{ command: "npm", args: ["--version"] }` → `output` contains a semver and `completed.success` (this proves the npm launcher rewrite end to end through ConPTY). Third: cancel mid-run of `node -e "setTimeout(()=>{},30000)"` and assert the pid (from an `output`-free probe: expose the spawned pid through `onClose` is not possible — instead assert the stream closes within 3 s and `queryWindowsProcess` finds no `node.exe` whose command line contains `setTimeout(()=>{},30000)` afterwards, using `takeWindowsProcessSnapshot`).

- [ ] **Step 6: Typecheck, tests, format, commit**

```bash
git add apps/host-daemon/src/provider-installation.ts apps/host-daemon/src/provider-installation.test.ts apps/host-daemon/src/provider-installation.win32.test.ts apps/host-daemon/src/command-dispatch.ts
git commit -m "Run provider installations through ConPTY on Windows with resolved executables"
```

---

### Task 5: Platform-injected provider maintenance kit

**Files:**

- Modify: `packages/provider-bridge-protocol/src/bridge-kit/provider-maintenance-kit.ts`
- Test: `packages/provider-bridge-protocol/src/bridge-kit/provider-maintenance-kit.test.ts` (create if absent; check `packages/provider-bridge-protocol/test/` first and follow the package's existing test location)
- Modify: `docs/api_to_audit.md` (the `experimental_` maintenance-kit block, lines ≈969-1013, and audit item 4)

**Interfaces:**

- Consumes: `resolveExecutable`, `resolveSpawnPlan`, `spawnPlanUnavailableMessage` from `@bb/process-utils` (already a dependency of `@bb/provider-bridge-protocol`).
- Produces (consumed by every provider bridge via `@get-bb/plugin-sdk/provider-bridge` `experimental_*` re-exports; the SDK re-export list in `packages/plugin-sdk/src/provider-bridge.ts:190-232` is unchanged, only signatures widen):
  - `resolveExecutablePath(command: string, options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): Promise<string | null>` — POSIX branch byte-identical (absolute → `access(X_OK)`; else `which` through `execFile`); win32 branch: absolute → `resolveExecutable({ command, platform: "win32", env })` (PATHEXT completes a missing extension); else the same call for a bare name. No `where`.
  - `commandOutput(command, args, options?: { platform?; env? })`, `readCliVersion(command, options?)`: POSIX byte-identical (`execFile` with the same timeouts and the same `${stdout}\n${stderr}` handling); win32: `resolveSpawnPlan` first, `null` when the plan is null, then the same `execFile` on the plan (an `.exe` or `node.exe <script>`), with `windowsHide: true`.
  - `npmCommand(platform?: NodeJS.Platform): string` → `"npm"` on every platform (R12).
  - `npmGlobalInstallCommand(npmPackage, platform?)`, `npmLatestVersion(npmPackage, options?)`, `probeNpmGlobalPackage(npmPackage, options?)` thread `platform`/`env`; `probeNpmGlobalPackage` keeps `npmBin = npmPrefix` on win32.
  - `npmGlobalInstallSource(args & { platform? })` — `pathIsInside` compares lower-cased on win32.
  - `downloadedInstallerCommand(url: string, platform?: NodeJS.Platform): ProviderInstallationCommand | null` — POSIX string byte-identical; `null` on win32.
  - New: `installerUnavailableReason(displayName: string, url: string): string` → `bb cannot run the ${displayName} shell installer on Windows. Install ${displayName} from ${url}, then reload.` (used by Task 6).

- [ ] **Step 1: Write the failing tests**

Pin POSIX outputs first (these must pass before and after):

- `npmCommand("linux") === "npm"`, `npmCommand("darwin") === "npm"`, and the new `npmCommand("win32") === "npm"`.
- `npmGlobalInstallCommand("@openai/codex", "linux")` deep-equals `{ command: "npm", args: ["install", "-g", "@openai/codex@latest"], displayCommand: "npm install -g @openai/codex@latest" }`; win32 identical.
- `downloadedInstallerCommand("https://claude.ai/install.sh", "linux")` deep-equals the literal `{ command: "sh", args: ["-c", 'tmp=$(mktemp "${TMPDIR:-/tmp}/provider-installation.XXXXXX") && trap \'rm -f "$tmp"\' EXIT && curl -fsSL https://claude.ai/install.sh -o "$tmp" && bash "$tmp"'], displayCommand: <same script> }` (copy the exact string from the current implementation); `downloadedInstallerCommand(url, "win32") === null`.
- `installerUnavailableReason("Claude Code", "https://claude.com/claude-code")` equals the exact sentence above.
- `npmGlobalInstallSource({ installed: true, executablePath: "C:\\NVM4W\\nodejs\\codex.cmd", npmBin: "C:\\nvm4w\\nodejs", platform: "win32" }) === "npmGlobal"`; the same on `"linux"` with differing case → `"external"` (today's behaviour).
- `resolveExecutablePath("pwsh", { platform: "win32", env })` with a fixture directory on `Path` containing `pwsh.exe` → that path; with a bare `pwsh` and PATHEXT excluding `.exe` → `null`; absolute `"<dir>\\pwsh"` → `"<dir>\\pwsh.exe"`.
- `commandOutput("npm", ["--version"], { platform: "win32", env: { Path: "<empty dir>" } })` → `null` without throwing (plan unresolvable).
- `it.runIf(win32)`: `commandOutput("npm", ["--version"], { platform: "win32" })` on the reference desktop returns a semver line (proves the launcher rewrite through `execFile`).
- POSIX `it.skipIf(win32)`: `commandOutput("sh", ["-c", "printf out; printf err 1>&2"], { platform: "linux" })` equals `"out\nerr"`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bb/provider-bridge-protocol exec vitest run <test file>`.

- [ ] **Step 3: Implement**

```ts
interface KitPlatformOptions { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }

async function windowsSpawnPlan(command: string, args: readonly string[], options: KitPlatformOptions) {
  return resolveSpawnPlan({ command, args, env: options.env ?? process.env, platform: "win32" });
}

export async function resolveExecutablePath(command: string, options: KitPlatformOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return resolveExecutable({ command, env: options.env ?? process.env, platform });
  }
  …existing POSIX body, with `which` (the `where` branch is gone because platform is never win32 here)…
}

export async function commandOutput(command: string, args: readonly string[], options: KitPlatformOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") { …existing body verbatim… }
  const plan = await windowsSpawnPlan(command, args, options);
  if (plan === null) return null;
  try {
    const { stdout, stderr } = await execFileAsync(plan.command, plan.args, { timeout: INSTALLATION_CHECK_TIMEOUT_MS, windowsHide: true, env: options.env });
    return `${stdout}\n${stderr}`.trim();
  } catch { return null; }
}
```

`readCliVersion` mirrors `commandOutput`'s split with the 5 s timeout and the version regex. `npmLatestVersion`, `probeNpmGlobalPackage` pass `options` through; `probeNpmGlobalPackage` uses `platform` (not `process.platform`) for the `npmBin` shape. `pathIsInside(child, parent, platform)` lower-cases both when `platform === "win32"`. `downloadedInstallerCommand(url, platform = process.platform)` returns `null` when win32. Keep every POSIX string literal unchanged; run the pinned tests to prove it.

- [ ] **Step 4: Run to verify pass**; fix callers that break on the widened `downloadedInstallerCommand` return type: `plugins/provider-claude-code/src/bridge/provider-maintenance.ts:177-181, 220-230` — Task 6 rewrites that code; here only make it typecheck by narrowing with a null check that throws `new Error("Claude Code installer is unavailable on this platform")` (Task 6 replaces it with the reason flow).

- [ ] **Step 5: Update `docs/api_to_audit.md`**

In the maintenance-kit block: state that `resolveExecutablePath`, `commandOutput`, `readCliVersion`, `npmLatestVersion`, `probeNpmGlobalPackage`, `npmGlobalInstallSource`, `npmCommand`, `npmGlobalInstallCommand`, `downloadedInstallerCommand` accept `platform` (default `process.platform`) and, where they spawn, `env`; that on win32 commands are resolved through `Path` + `PATHEXT` and Node `.cmd` shims are started as `node.exe <script>`; that `npmCommand` returns `npm` everywhere (the daemon resolves it); that `downloadedInstallerCommand` returns `null` on win32. Rewrite audit item 4 (`downloadedInstallerCommand is POSIX…`) to: "**`downloadedInstallerCommand` returns `null` on win32.** The Claude Code bridge turns that into `installAction: null` with `installUnavailableReason`. Stabilisation: decide whether a native Windows installer (winget/MSI) should be modelled as a second command kind."

- [ ] **Step 6: Typecheck the kit and every consumer, format, commit**

Run: `pnpm exec turbo run typecheck --filter=@bb/provider-bridge-protocol --filter=@get-bb/plugin-sdk --filter=@bb/provider-codex --filter=@bb/provider-claude-code --filter=@bb/provider-pi --filter=@bb/provider-bridge-acp` (use the packages' real names from their `package.json`), then `pnpm exec turbo run test --filter=@bb/provider-bridge-protocol`.

```bash
git add packages/provider-bridge-protocol plugins/provider-claude-code/src/bridge/provider-maintenance.ts docs/api_to_audit.md
git commit -m "Inject the platform into the provider maintenance kit and resolve commands without where.exe"
```

---

### Task 6: Install matrix, `installUnavailableReason` and protocol 201

**Files:**

- Modify: `packages/provider-bridge-protocol/src/provider-maintenance.ts` (`providerInstallationStatusSchema`)
- Modify: `packages/host-daemon-contract/src/local.ts` (`providerCliStatusSchema`), `packages/host-daemon-contract/src/protocol.ts` (`HOST_DAEMON_PROTOCOL_VERSION = 201`)
- Modify: `apps/server/src/services/system/provider-installations.ts` and whichever mapper builds `ProviderCliStatus` from `ProviderInstallationStatus` (grep `installAction` in `apps/server/src`; add `displayName` mapping site)
- Modify: `apps/app/src/components/provider-cli/provider-cli-install.tsx` (`buildProviderCliIssue`), its test
- Modify: `apps/cli/src/commands/updates.ts` (`status` output), `apps/cli/src/commands/machine.ts` (`provider-cli status` text output)
- Modify: `plugins/provider-codex/src/bridge/provider-maintenance.ts`, `plugins/provider-claude-code/src/bridge/provider-maintenance.ts`, `plugins/provider-pi/src/bridge/provider-maintenance.ts` (+ tests), `plugins/provider-acp/src/*` where the installation status is built (ACP agents: reason `null`; if ACP has no installation status, no change)
- Modify: every fixture that builds a `ProviderInstallationStatus`/`ProviderCliStatus` literal (typecheck finds them: server tests, app tests, CLI tests, `packages/sdk` fixtures, bb-guide docs snapshots)
- Docs: `docs/cli-guide-and-skill.md` surfaces for `bb updates status` / `bb machine provider-cli status` JSON (the templates under `packages/templates/src/templates/bb-guide-*.md` and `plugins/bb-guide/skills/bb-cli/references/*.md` that document the status JSON shape), `docs/configuration.md` if it documents provider CLI status fields.

**Interfaces:**

- Produces: `installUnavailableReason: string | null` on both schemas (required key, nullable value: filled once at the bridge, passed through the daemon and server, never defaulted later); `HOST_DAEMON_PROTOCOL_VERSION` 201.
- Bridge outputs on win32 (R13):
  - Codex: unchanged (`codex update`), `installUnavailableReason: null`.
  - Claude Code: `installAction` for `update` unchanged (`claude update`); for a missing install on win32 `installAction: null`, `installUnavailableReason: installerUnavailableReason("Claude Code", "https://claude.com/claude-code")`; POSIX unchanged with `installUnavailableReason: null`.
  - Pi: `piGlobalInstallCommand(executablePath, { platform, env })`: when `isBunManagedPi` → bun command (`bun`, resolved at spawn); else when `commandOutput("npm", ["--version"], { platform, env })` is non-null → npm command; else on win32 `installAction: null` with reason `bb needs bun or npm on Path to install Pi on Windows. Install Node.js or Bun, then reload.`; POSIX keeps today's npm fallback unconditionally.

- [ ] **Step 1: Bump the protocol and widen the schemas**

`packages/host-daemon-contract/src/protocol.ts`: `200` → `201`. Add `installUnavailableReason: z.string().min(1).nullable()` after `installAction` in both schemas. Run `pnpm exec turbo run typecheck` for `@bb/host-daemon-contract`, `@bb/provider-bridge-protocol`, `@bb/server`, `@bb/host-daemon`, `@bb/app`, `@bb/cli`, `@bb/sdk` and fix every literal the compiler flags by adding `installUnavailableReason: null` (fixtures) or the mapped value (server mapper). Do not add defaults in zod.

- [ ] **Step 2: Write the failing bridge tests**

Claude Code (`plugins/provider-claude-code/src/bridge/*.test.ts`, follow the existing status test harness that stubs `commandOutput`/`resolveExecutablePath`): `platform: "win32"`, not installed → `installAction === null` and `installUnavailableReason` equals the sentence; `platform: "linux"`, not installed → `installAction.kind === "install"` with the `sh -c` display command and `installUnavailableReason === null`; installed and outdated on win32 → `installAction.kind === "update"`, `command` `claude update`.
Pi: win32 with neither bun nor npm → `null` + reason; win32 with npm → npm command; linux without npm → npm command (today).
Codex: `installUnavailableReason === null` in every existing case.

- [ ] **Step 3: Run to verify failure**, then **Step 4: Implement the bridges**

The status functions take `{ platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }` options (default `process.platform`/`process.env`, read at the bridge entry — the plugin's `server.ts`/bridge `main` is the composition root). `getClaudeProviderInstallationStatus` computes `const installer = downloadedInstallerCommand(CLAUDE_INSTALL_SCRIPT_URL, platform)` and:

```ts
const actionKind = !installed
  ? installer === null
    ? null
    : "install"
  : needsUpdate && canRunUpdate
    ? "update"
    : null;
const installUnavailableReason =
  !installed && installer === null
    ? installerUnavailableReason("Claude Code", CLAUDE_CODE_DOWNLOAD_URL)
    : null;
```

`buildClaudeProviderInstallationRun` returns `{ available: false, message: status.installUnavailableReason ?? … }` when the installer is null. `CLAUDE_CODE_DOWNLOAD_URL = "https://claude.com/claude-code"`.

- [ ] **Step 5: Server, app, CLI**

Server mapper copies the field. `buildProviderCliIssue`: in the `!status.installed` branch, `description: status.installUnavailableReason ?? \`Install ${status.displayName} so bb can start ${status.displayName} sessions.\``; in the `needsUpdate` branch append `` `; ${status.installUnavailableReason}` `` when non-null. Add unit cases to the existing `provider-cli-install`test. CLI:`bb updates status`and`bb machine provider-cli status` print the reason on its own line after the status when non-null (text mode; JSON carries the field automatically). Add CLI test cases to the existing command tests.

- [ ] **Step 6: Docs surfaces**

Update every listed surface that documents the provider CLI status JSON to include `installUnavailableReason` (grep `installAction` under `docs/`, `packages/templates/`, `plugins/bb-guide/`). `docs/api_to_audit.md`: note the new field on `ProviderInstallationStatus` in the bridge-protocol block.

- [ ] **Step 7: Typecheck the whole workspace and run the touched suites**

`pnpm exec turbo run typecheck` (all), then `pnpm exec turbo run test --filter=@bb/host-daemon-contract --filter=@bb/provider-bridge-protocol --filter=<codex> --filter=<claude-code> --filter=<pi> --filter=@bb/cli --filter=@bb/app`; for `@bb/server` run the provider-installation test files individually. Format, commit:

```bash
git add -A packages/host-daemon-contract packages/provider-bridge-protocol apps/server apps/app apps/cli plugins/provider-codex plugins/provider-claude-code plugins/provider-pi plugins/provider-acp packages/sdk docs packages/templates plugins/bb-guide
git commit -m "Report why a provider install is unavailable on Windows and bump the daemon protocol to 201"
```

---

### Task 7: Provider launch specs — Codex, Claude Code, Pi, ACP

**Files:**

- Modify: `plugins/provider-codex/src/bridge/app-server-connection.ts` (+ test)
- Modify: `plugins/provider-claude-code/src/bridge/session-options.ts`, `model-list.ts` (+ new `__tests__/session-options-win32.test.ts`, existing tests), `plugins/provider-claude-code/package.json` (add `"@bb/process-utils": "workspace:*"`)
- Modify: `plugins/provider-pi/src/bridge/rpc-child.ts`, `plugins/provider-pi/src/bridge/provider-maintenance.ts` (+ tests), `plugins/provider-pi/package.json` (add the dependency)
- Modify: `packages/provider-bridge-acp/src/bridge/agent-connection.ts`, `packages/provider-bridge-acp/src/bridge/bridge.ts` (`loadAgentModelCatalog` ≈:725-760, session discovery ≈:790-810, session launch ≈:1660-1685) (+ tests), `packages/provider-bridge-acp/package.json` (add the dependency)

**Interfaces:**

- Consumes: `resolveSpawnPlan`, `resolveExecutableSync`, `spawnPlanUnavailableMessage`, `readWindowsEnvValue` from `@bb/process-utils`.
- Produces:
  - Codex: `createCodexAppServerConnection(options & { platform?: NodeJS.Platform })` — on win32 the command is resolved with `resolveSpawnPlan` before `spawn` and `windowsHide: true` is passed; when the plan is null the connection emits the same failure path a spawn `error` would (`spawnPlanUnavailableMessage`), so callers see a clear message instead of `ENOENT`.
  - Claude Code: `resolveClaudeCodeExecutable({ env, platform? })` (R14); `buildSessionOptions(params, env, platform?)`, `buildModelProbeOptions(env, platform?)`.
  - Pi: `spawnPiRpcChild`/`PiRpcChild` take `platform?`; `resolvePiLaunch` unchanged (`pi`); `bunCommand(platform?)` → `"bun"`; `probePiVersion({ platform?, env? })` keeps its messages and routes through `resolveSpawnPlan` on win32 only.
  - ACP: `createAcpAgentConnection(options & { platform? })` resolve-then-spawn on win32; `loadAgentModelCatalog` resolves on win32 before `execFile`.

Rulings in force: R14, R15, R25. All win32 resolution is asynchronous except the Claude Code SDK path, which is synchronous (`buildSessionOptions` is sync) and therefore uses `resolveExecutableSync`.

- [ ] **Step 1: Claude Code — failing tests**

Create `plugins/provider-claude-code/src/bridge/__tests__/session-options-win32.test.ts` with fixture directories (`mkdtempSync`), covering (adapted from the donor's four cases plus three of ours):

1. win32 prefers `claude.exe` over an extensionless `claude` in the same directory (`env: { Path: dir, PATHEXT: ".EXE;.CMD" }`).
2. POSIX order untouched: `platform: "linux"`, `env: { PATH: dir }` with an executable `claude` file → that file (chmod 755; `skipIf(win32)`).
3. explicit `BB_CLAUDE_CODE_EXECUTABLE` without extension on win32 resolves to the `.exe` sibling; a missing explicit path throws the existing message.
4. PATHEXT order across two `Path` entries: `a\claude.cmd` and `b\claude.exe` with `PATHEXT=.EXE;.CMD` → `b\claude.exe`.
5. win32 reads `Path` when the env has no `PATH` key (`env: { Path: dir }`).
6. win32 well-known fallback: `env: { USERPROFILE: home }` with `home\.local\bin\claude.exe` present and nothing on `Path` → that path; `home\.claude\local\claude.exe` second.
7. `platform: "linux"` never consults `USERPROFILE` (only `HOME`), pinning today's list.

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```ts
function wellKnownClaudeExecutablePaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const profile = readWindowsEnvValue(env, "USERPROFILE")?.trim();
    return profile ? [win32.join(profile, ".local", "bin", "claude.exe"), win32.join(profile, ".claude", "local", "claude.exe")] : [];
  }
  …existing POSIX body verbatim…
}

export function resolveClaudeCodeExecutable(args: { env: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): string | null {
  const platform = args.platform ?? process.platform;
  const explicitPath = args.env[CLAUDE_CODE_EXECUTABLE_ENV]?.trim();
  if (explicitPath) {
    if (platform === "win32") {
      const resolved = resolveExecutableSync({ command: explicitPath, env: args.env, platform });
      if (resolved !== null) return resolved;
      throw new Error(`${CLAUDE_CODE_EXECUTABLE_ENV} must point to an executable Claude CLI path: ${explicitPath}`);
    }
    …existing POSIX accessSync branch verbatim…
  }
  if (platform === "win32") {
    const onPath = resolveExecutableSync({ command: "claude", env: args.env, platform });
    if (onPath !== null) return onPath;
    for (const candidate of wellKnownClaudeExecutablePaths(args.env, platform)) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
  …existing POSIX PATH walk and well-known loop verbatim…
}
```

`buildSessionOptions` and `buildModelProbeOptions` pass `platform` (default `process.platform`; the bridge entry is the composition root). Do not install `spawnClaudeCodeProcess` on win32 in this task; Task 14 measures a real turn first (contingency: if the SDK's own spawn fails on win32, a follow-up wires `spawnClaudeCodeProcess` to `spawn(claudePath, args, { windowsHide: true, stdio })` without casts).

- [ ] **Step 4: Codex — failing test and implementation**

Test (`app-server-connection.test.ts`, existing harness with an injected `spawn` if present, else add `spawnImpl?:` to the options): `platform: "win32"` with `resolveSpawnPlan` stub returning `{ command: "C:\\Codex\\codex.exe", args: ["app-server"] }` → spawn called with that command/args and `windowsHide: true`; `platform: "linux"` → spawn called with `"codex"`/`["app-server"]` and no `windowsHide` key (pin `expect(options).not.toHaveProperty("windowsHide")`). Because resolution is async and `createCodexAppServerConnection` is sync, add `export async function resolveCodexAppServerLaunch(options)` in the caller (`bridge.ts` `resolveAppServerLaunch` site) that on win32 returns the resolved plan or throws `Error(spawnPlanUnavailableMessage(…))`; `createCodexAppServerConnection` gains only `platform?` and the `windowsHide` spread.

- [ ] **Step 5: Pi — tests and implementation**

`bunCommand(platform)` returns `"bun"`; `isBunManagedPi(executablePath, { platform, env })` passes options to `commandOutput` and uses `platform` for the `pi.exe` name; `probePiVersion({ platform, env })`: on win32 resolve the launch with `resolveSpawnPlan` and call `execFileAsync(plan.command, plan.args, { timeout, windowsHide: true })`; when the plan is null return `{ version: null, failure: \`\\\`${display}\\\` ${spawnPlanUnavailableMessage(…)}\` }`; POSIX body verbatim. `PiRpcChild`constructor:`platform`option; on win32`resolvePiSpawnPlan`must run before construction — add`export async function spawnPiRpcChild(args)`if the class is constructed directly today (check callers), resolving the plan on win32 and passing`{ command, args }`in; the five-pipe`stdio`stays. Tests: injected platform for the plan and`windowsHide`; the `bun.test.ts`assertions stop branching on`process.platform` (inject).

- [ ] **Step 6: ACP — tests and implementation**

`createAcpAgentConnection` gains `platform?` and `windowsHide: true` on win32; the three call sites in `bridge.ts` resolve the command with `resolveSpawnPlan` on win32 (`agent.command` may be a bare name such as `cursor-agent`, whose `.cmd` npm shim becomes `node.exe <script>`); `loadAgentModelCatalog` does the same before `execFile` and adds `windowsHide: true` on win32. Custom agents (`customAcpAgentSchema`) need no schema change. Tests with injected platform and a stubbed spawn.

- [ ] **Step 7: Typecheck and test every touched package, format, commit**

```bash
git add plugins/provider-codex plugins/provider-claude-code plugins/provider-pi packages/provider-bridge-acp pnpm-lock.yaml
git commit -m "Resolve provider executables through Path and PATHEXT before launching them on Windows"
```

---

### Task 8: Runtime PATH overlay, `prependPath` delimiter and sweep-skip visibility

**Files:**

- Modify: `apps/host-daemon/src/runtime-manager.ts` (`providerProcessEnvFromShellEnv`, lines 244-256, and its two call sites ≈:1166, ≈:1237)
- Modify: `apps/host-daemon/src/runtime-shell-env.ts` (`prependPath` :161-168, `prepareRuntimeShellEnv` :685-711)
- Modify: `plugins/environment-git-worktree/host/worktree.ts` (≈:681), `plugins/environment-personal-workspace/host.ts` (≈:47)
- Test: `apps/host-daemon/src/runtime-manager.test.ts`, `apps/host-daemon/src/runtime-shell-env.test.ts`, the two plugins' `host.test.ts`

Rulings in force: R16, R17.

- [ ] **Step 1: Failing tests**

- `providerProcessEnvFromShellEnv({ PATH: "C:\\bb;C:\\x", BB_CLI: "", BB_SERVER_URL: "" }, "win32")` → `{ Path: "C:\\bb;C:\\x" }` (plus `BB_PROVIDER_BRIDGE_RECORD_DIR` only when set); `"linux"` → `{ PATH: "…" }` (today).
- `prepareRuntimeShellEnv({ …, platform: "win32", inheritedPath: "C:\\x", bbExecutableDirectory: "C:\\bb" }).PATH === "C:\\bb;C:\\x"`; `platform: "linux"` → `"/bb:/x"`.
- Worktree/personal-workspace `host.test.ts` win32 siblings (`describe.runIf(win32)`): stub `experimental_killProcessesWithCwdUnder` (or the process-utils `killProcessesWithCwdUnder` via `vi.mock`) to invoke `onSkippedProcess({ pid: 4242, expectedCreationDate: "a", observedCreationDate: "b", reason: "pid-reused" })` (use the real `SkippedProcessEvent` shape); spy `process.stderr.write`; assert one line `bb sweep left pid 4242 alone: process id reused\n`. POSIX tests unchanged.

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```ts
function providerProcessEnvFromShellEnv(shellEnv, platform: NodeJS.Platform = process.platform): Record<string, string> | null {
  let env: Record<string, string> = {};
  if (shellEnv.PATH) {
    env = Object.fromEntries(Object.entries(assignPathEnv({ env: {}, path: shellEnv.PATH, platform })).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  …record dir as today…
}
```

(`assignPathEnv` returns `NodeJS.ProcessEnv`; the filter narrows without a cast.) Call sites pass `this.platform` if `RuntimeManager` has one, else `process.platform` at construction (check the class; Phase 2 may already store it).

```ts
function prependPath(
  executableDirectoryPath: string,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string {
  const delimiter = platform === "win32" ? ";" : ":";
  return inheritedPath
    ? `${executableDirectoryPath}${delimiter}${inheritedPath}`
    : executableDirectoryPath;
}
```

`prepareRuntimeShellEnv` passes `options.platform ?? process.platform`. Plugins:

```ts
await experimental_killProcessesWithCwdUnder({
  directory: workspacePath,
  onSkippedProcess: (event) => {
    process.stderr.write(
      `bb sweep left pid ${String(event.pid)} alone: process id reused\n`,
    );
  },
});
```

- [ ] **Step 4: Run to verify pass; typecheck; run the four test files; format; commit**

```bash
git add apps/host-daemon/src/runtime-manager.ts apps/host-daemon/src/runtime-manager.test.ts apps/host-daemon/src/runtime-shell-env.ts apps/host-daemon/src/runtime-shell-env.test.ts plugins/environment-git-worktree plugins/environment-personal-workspace
git commit -m "Give provider processes a single Path key on Windows and report sweep skips"
```

---

### Task 9: Watcher event paths on NTFS

**Files:**

- Create: `packages/host-watcher/src/watch-event-path.ts`
- Modify: `packages/host-watcher/src/parcel-host-watcher.ts` (`watchPathRoot` ≈:195-223), `packages/host-watcher/src/watch-path.ts` (`isPathWithinTarget`, `resolveEventPath` ≈:40-55), `packages/host-watcher/src/watch-specs.ts` (`isPathWithinRoot`/`resolveEventPath`/`normalizeRelativePath` ≈:90-110, dedupe ≈:245-262), `packages/host-watcher/src/parcel-subprocess/parcel-child-handler.ts` (`emitRescan` ≈:33-49)
- Test: create `packages/host-watcher/test/watch-event-path.test.ts`; modify `packages/host-watcher/test/watch-path.test.ts` (`path.join("/tmp", …)` at :179, :219, :257, :297 → `path.join(os.tmpdir(), …)`); create `packages/host-watcher/test/watch-ntfs.win32.test.ts`

**Interfaces:**

- Produces (all with `platform: NodeJS.Platform = process.platform` as the last parameter; POSIX arms are today's `path.posix`/`path` behaviour, win32 arms are new):
  - `isExtendedLengthWindowsPath(value: string): boolean` (`\\?\` or `\\.\` prefix).
  - `normalizeWatchEventPath(rootPath: string, eventPath: string, platform?): string` — absolute → `path.win32.normalize`/`path.posix.normalize` by platform (extended-length prefixes preserved verbatim on win32); relative → resolved against `rootPath`.
  - `isWatchPathWithinRoot(rootPath: string, candidatePath: string, platform?): boolean` — win32: compare after stripping `\\?\`, normalising and lower-casing; POSIX: today's `path.relative` test.
  - `toWatchRootRelativeKey(rootPath: string, candidatePath: string, platform?): string` — win32: `path.win32.relative` with every separator turned into `/`; POSIX: today's `path.relative(...).split(path.sep).join("/")`.
  - `dedupeWatchPathChanges<T extends { path: string; type: string }>(changes: T[], platform?): T[]` — win32: first occurrence wins per lower-cased `(type, path)`; POSIX: returns the input array unchanged (identity, not a copy).
  - `joinWatchedEntry(dir: string, entry: string): string` — chooses `path.win32.join` when `dir` is win32-absolute and not posix-absolute, else `path.posix.join` (shape-based, no platform read; used by the child handler which receives paths from the parent).

Ruling in force: R18. Donor reading aid: `git show refs/remotes/upstream-pr/3188:packages/host-watcher/src/watch-event-path.ts` and `…:packages/host-watcher/test/watch-event-path.test.ts` (166 lines, already platform-parameterised — adopt the cases, rename to our exports). Measured on the reference desktop: `@parcel/watcher` 2.5.6 win32-x64 emits backslash absolute paths and honours `**/node_modules/**` ignores without any change.

- [ ] **Step 1: Write the failing unit tests** (`watch-event-path.test.ts`, Linux-runnable)

For each export: a win32 case (`"C:\\Work\\bb"` root; event `"c:\\work\\bb\\SRC\\a.ts"` is within root; relative key `SRC/a.ts`; `\\?\C:\Work\bb\x` within root; dedupe of `C:\W\a.ts` vs `c:\w\A.TS` update events keeps one) and a POSIX case pinning today's outputs (`"/work/bb"` root; `/work/BB/a.ts` is NOT within root; dedupe returns the same array reference). `joinWatchedEntry("C:\\dir", "x")` → `C:\dir\x`; `joinWatchedEntry("/dir", "x")` → `/dir/x`.

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** the module (types above; no `process.platform` read except as the default), **Step 4: Run to verify pass**.

- [ ] **Step 5: Rewire the four call sites**

`parcel-host-watcher.ts` `onEvents`: `path: normalizeWatchEventPath(args.rootPath, event.path)` (default platform; the daemon is the composition root for this package — acceptable per the Global Constraints as a default-parameter read). `watch-path.ts`: `isPathWithinTarget` → `isWatchPathWithinRoot`, `resolveEventPath` → `normalizeWatchEventPath`. `watch-specs.ts`: same two plus `normalizeRelativePath` → `toWatchRootRelativeKey`, and pass the change batch through `dedupeWatchPathChanges` where changes are collected (find the array build near :245-262). `parcel-child-handler.ts` `emitRescan`: `path: joinWatchedEntry(dir, entry)`. Run the whole `@bb/host-watcher` suite on this host and (later, gate) in WSL; POSIX outputs are identity by construction — add one assertion in the existing `watch-specs` test that a Linux-shaped batch is returned unchanged by `dedupeWatchPathChanges`.

- [ ] **Step 6: Write and run the real NTFS test** (`watch-ntfs.win32.test.ts`, `describe.runIf(win32)`, 20 s timeout)

Using `createParcelHostWatcher()` (or the lowest-level `watchPathRoot` the package exports for tests), subscribe to a temp directory with `ignoredPaths: ["**/node_modules/**"]`; create `a.txt`, rename to `B.TXT`, delete; create `node_modules/x.js`. Assert: at least one change for `a.txt` and `B.TXT` arrives with a path that `isWatchPathWithinRoot` accepts, none for `node_modules`, and the reported paths use backslashes (record the exact strings in the report). Second case: a `\\?\`-prefixed root subscribes and events still match.

- [ ] **Step 7: Typecheck, test, format, commit**

```bash
git add packages/host-watcher
git commit -m "Match watcher event paths case-insensitively and dedupe them on Windows"
```

---

### Task 10: Desktop log viewer follows files on Windows without `tail`

**Files:**

- Modify: `apps/desktop/src/log-viewer.ts` (`createLogTailer` :560, `restartTailProcess` :631-684, `processIds` :735-740, `start`/`stop` :741-776)
- Modify: `apps/desktop/src/main.ts` (:1436 `createLogTailer({ … })` → add `platform: process.platform`)
- Test: `apps/desktop/test/log-viewer.test.ts`

**Interfaces:**

- `CreateLogTailerArgs` gains `platform?: NodeJS.Platform` (default `process.platform`).
- On win32 a component state holds `fileFollow: { filePath; offset; mtimeMs; decoder: StringDecoder } | null` instead of `tailProcess`; `processIds()` returns `[]` on win32 (no child).
- New internal functions (win32 path only): `readLastLogLines({ filePath, maxLines })` → `{ lines: string[]; size: number; mtimeMs: number }` (read backwards in 64 KiB windows doubling to 4 MiB); `readAppendedLogBytes(follow)` → `{ text: string; rotated: boolean }` (stat; `size < offset` or same size with a different `mtimeMs` ⇒ rotated: reset to 0; else read `[offset, size)` with `handle.read` and decode through the persistent `StringDecoder("utf8")`).

Ruling in force: R19. Donor reading aid: `git diff 6cdb4ba refs/remotes/upstream-pr/3188 -- apps/desktop/src/log-viewer.ts` (346 lines) — take the reader functions, not the platform-wide replacement.

- [ ] **Step 1: Pin POSIX tests** — in `log-viewer.test.ts` every `createLogTailer({...})` call that must keep the `tail` behaviour (including `"kills tail child processes when stopped"` at :220) gets `platform: "linux"` when running on this host would otherwise pick win32; wrap the `tail`-dependent cases in `describe.skipIf(process.platform === "win32")("tail-backed follower (POSIX)")`. No assertion changes.

- [ ] **Step 2: Write the failing win32 tests** (`describe("file-backed follower (win32 arm)")`, Linux-runnable with `platform: "win32"` because the reader is pure Node): initial tail of the last `LOG_VIEWER_INITIAL_TAIL_LINES` lines from a file with 1,000 lines; appended bytes arrive after `writeFile(…, { flag: "a" })` within the 2 s poll (use fake timers or a short poll override if the file exposes one); a multi-byte UTF-8 character split across two appends decodes as one character; truncation (`writeFile` with shorter content) resets and re-reads; rotation (`server.2.log` appears) switches files as the existing rotation test expects; `processIds()` is `[]`.

- [ ] **Step 3: Run to verify failure**, **Step 4: Implement** — `restartTailProcess` becomes `restartFollower` which branches once on `platform`: POSIX body verbatim (spawn `tail`), win32 body `restartFileFollow` (read the initial tail with `readLastLogLines`, emit through the existing `handleTailChunk`/`emitComponentLines` so `formatLogLine` still applies, then set `fileFollow`). `refreshTailProcesses` (existing rotation tick, also driven by the `fs.watch` directory watcher) additionally calls `readAppendedLogBytes` for each win32 `fileFollow` and emits the text. `stopTailProcess` on win32 closes the handle if kept open (prefer opening per read to avoid a held handle on NTFS). `processIds` filters on `tailProcess` only.

- [ ] **Step 5: Run to verify pass; run the full desktop log-viewer test file; typecheck `@bb/desktop`; format; commit**

```bash
git add apps/desktop/src/log-viewer.ts apps/desktop/src/main.ts apps/desktop/test/log-viewer.test.ts
git commit -m "Follow desktop log files on Windows without tail"
```

---

### Task 11: ConPTY smoke as a Turbo task and the Windows CI job

**Files:**

- Create: `apps/desktop/scripts/smoke-windows-conpty.mjs`
- Modify: `apps/desktop/package.json` (`"smoke:windows-conpty": "node scripts/smoke-windows-conpty.mjs"` beside the other `smoke:` scripts at :24-31)
- Modify: `turbo.json` (`"@bb/desktop#smoke:windows-conpty": { "cache": false, "inputs": ["scripts/smoke-windows-conpty.mjs"], "outputs": [], "passThroughEnv": ["*"] }` beside `@bb/desktop#smoke:packaged` at :253)
- Modify: `.github/workflows/ci.yml` (`windows-x64` job :247-313: add a step `Smoke ConPTY` running `pnpm exec turbo run smoke:windows-conpty --filter=@bb/desktop` after `Load native add-ons`, teeing to `qa-artifacts/conpty-smoke.txt` and uploading it with the run summaries)

**Interfaces:** the script exits 0 only when all six checks pass and prints one line per check `check <name>: ok|fail <detail>` plus a final `conpty smoke: 6/6` line; it calls `process.exit` after the summary flush (R9). It resolves the shell with the same order as R1 (`pwsh` on `Path` via a local PATHEXT walk in plain Node, then `%ProgramFiles%\PowerShell\7\pwsh.exe`, then System32 `powershell.exe`) because a script cannot import the daemon; spawns with `["-NoLogo"]`, `cols: 80, rows: 30, cwd: os.tmpdir(), env: process.env`; loads node-pty through `createRequire(<repo>/apps/host-daemon/package.json)` as the donor does. On a non-win32 host it prints `conpty smoke: skipped (not win32)` and exits 0.

Checks (each with a 10 s deadline): `spawn-echo` (`Write-Output ('BB_' + 'WN_OK')`), `utf8` (`Write-Output ('dise' + 'ño ✓')` written as UTF-8 bytes; expect `diseño ✓`), `resize` (120×40 then 80×30, then marker `BB_WN_RESIZE_OK`), `ctrl-c` (`Start-Sleep -Seconds 30`, 300 ms later write byte `0x03`, then `Write-Output ('BB_' + 'CTRLC_OK')`; expect the marker within 5 s), `close` (`pty.kill()`, `onExit` within 10 s, then `tasklist.exe /FI "PID eq <pid>" /FO CSV /NH` from `%SystemRoot%\System32` shows no row), `tree` (from inside the shell `Start-Process powershell.exe -PassThru` printing the child pid, verify it is in `tasklist`, then `taskkill.exe /PID <shell pid> /T /F` and verify both gone).

- [ ] **Step 1: Port the script** from `git show refs/remotes/upstream-pr/3188:apps/desktop/scripts/smoke-windows-conpty.mjs` with the changes above (no `-NoProfile`, no `chcp`, no `powershell.exe` default, six checks, `process.exit`). No comments in the file.
- [ ] **Step 2: Run it on the reference desktop**: `pnpm exec turbo run smoke:windows-conpty --filter=@bb/desktop > <scratchpad>/t11-smoke.log 2>&1`; expected last line `conpty smoke: 6/6`. Negative control (do not commit): temporarily remove the Ctrl+C byte write and confirm `check ctrl-c: fail`.
- [ ] **Step 3: Wire `package.json`, `turbo.json`, `ci.yml`**; run `pnpm exec turbo run smoke:windows-conpty --filter=@bb/desktop --dry-run` to confirm the task graph resolves.
- [ ] **Step 4: Format (`oxfmt` on the `.mjs`, `.json`), commit**

```bash
git add apps/desktop/scripts/smoke-windows-conpty.mjs apps/desktop/package.json turbo.json .github/workflows/ci.yml
git commit -m "Add the ConPTY smoke as a Turbo task and run it on the Windows CI job"
```

---

### Task 12: `bb-app` tarball smoke on Windows

**Files:**

- Modify: `packages/bb-app/scripts/smoke-tarball.mjs` (`runCommand` :122-140, `spawnManagedProcess` :142-160, and the `command: "npm"`/`"npx"` sites at ≈:414, :434, :872, :919, :930)
- Modify: `.github/workflows/ci.yml` (`windows-x64`: add `--filter=bb-app` to the typecheck/build and test filters; add a step `Smoke bb-app tarball` running `pnpm exec turbo run smoke:tarball --filter=bb-app` after the tests, not `continue-on-error`)
- Test: `packages/bb-app/test/smoke-tarball-launch.test.ts` (new, unit-tests the resolver by importing it from the script — export `resolveNpmLaunch` from the `.mjs`; if the script is not importable without side effects, move the resolver to `packages/bb-app/scripts/npm-launch.mjs` and import it from both)

**Interfaces:** `resolveNpmLaunch({ command: "npm" | "npx", args, platform, execPath }) → { command, args }` — POSIX: identity; win32: `{ command: execPath, args: [join(dirname(execPath), "node_modules", "npm", "bin", command + "-cli.js"), ...args] }` after `existsSync` of that file, else throws `Error("npm launcher not found beside " + execPath + "; the smoke needs the Node.js distribution's bundled npm")`.

Ruling in force: R20. Measured: `spawn("npm")` → `ENOENT`, `spawn("npm.cmd")` → `EINVAL` on this host; `<dirname(node.exe)>\node_modules\npm\bin\npm-cli.js` exists and prints `10.9.3`.

- [ ] **Step 1: Failing unit tests** for `resolveNpmLaunch` (win32 with a temp `execPath` directory containing `node_modules/npm/bin/npm-cli.js` → the plan; missing file → throws the message; `platform: "linux"` → identity).
- [ ] **Step 2: Implement** and route every `npm`/`npx` spawn in `runCommand`/`spawnManagedProcess` through it (`platform: process.platform`, `execPath: process.execPath` — the script is a composition root). The `npx bb-app …` managed launch on win32 spawns `node.exe npx-cli.js bb-app …`, which starts the package's `bin` through npm's own shim handling inside `npx-cli.js` (no `cmd.exe` from bb's side).
- [ ] **Step 3: Build the host bundle and run the smoke on the reference desktop**: `pnpm exec turbo run build --filter=bb-app` then `pnpm exec turbo run smoke:tarball --filter=bb-app > <scratchpad>/t12-smoke.log 2>&1`. Expected: exit 0 with every builtin plugin `running`. If the smoke fails for a reason inside the packaged runtime (native module load, `bb.cmd`, port binding), fix it in this task only if it is a win32 arm of this script or of `packages/bb-app/src/launcher.ts`; anything else is reported as a concern with the log excerpt.
- [ ] **Step 4: CI wiring, format, commit**

```bash
git add packages/bb-app .github/workflows/ci.yml
git commit -m "Run the bb-app tarball smoke on Windows through Node's bundled npm"
```

---

### Task 13: Documentation — Phase 3 section, known limitations, beta runtime

**Files:**

- Modify: `docs/platform-windows.md` (title :3; intro :7-9; Status table row 3 :18; new section `## Terminals, providers, watcher and native bb-app (Phase 3)` inserted before `## Known limitations after Phase 0` (:329); new `## Known limitations after Phase 3` inserted before `## Evidence` (:462); Evidence paragraph for `qa/windows/phase-3/`; every bullet that says "arrives in Phase 3" / "Phase 3 follow-up" / "until Phase 3" at :334, :398, :437, :440, :454, :459 rewritten to state what landed)
- Modify: `docs/platform-support.md` (:9 supported hosts; :27-34 WSL2 paragraph; :145-150 maintainer-only surfaces; :225-227 CI sentence), `README.md` (:39-42), `packages/bb-app/README.md` (:36-53)
- Modify: `docs/api_to_audit.md` (confirm Tasks 5 and 6 entries; add nothing new), `docs/cli-guide-and-skill.md` surfaces already touched in Task 6 (verify), `docs/configuration.md` (`BB_CLAUDE_CODE_EXECUTABLE` on Windows: extension optional, PATHEXT applies), `plugins/bb-guide/skills/bb-plugin-authoring/references/backend-api-index.md` (verify no new symbol is owed)
- Modify: `docs/superpowers/specs/2026-09-11-native-windows-port-design.md` §7 Phase 3 gate line: "ConPTY smoke 5/5" → "ConPTY smoke 6/6 (spawn-echo, utf8, resize, ctrl-c, close, tree)" (R9), and §10 "manual checklist lives in `qa/windows/CHECKLIST.md`" left as is (Phase 5 deliverable; note it does not exist yet in the Phase 3 limitations).

**Facts the Phase 3 section must state** (each measured or ruled; do not soften):

- Terminals: shell order `pwsh.exe` (Path, then `%ProgramFiles%\PowerShell\7`), Windows PowerShell 5.1, `ComSpec`, `cmd.exe`; interactive shells load the profile (`-NoLogo` only; a profile can inject OSC sequences — bb answers only DA1); `command` mode is `-NoLogo -Command <cmd>` (PowerShell) or `/s /c <cmd>` (cmd); no `chcp` bootstrap, so Windows PowerShell 5.1 and `cmd.exe` keep the console code page (non-ASCII may garble there; pwsh 7 is UTF-8); the terminal env carries one `Path`; close is a single `pty.kill()` (node-pty rejects signals on Windows), the grace timer only finishes the session; the exit code after a user-initiated close is `-1073741510` (`0xC000013A`) and the app may show it (Phase 4 UX); the PTY pid is registered as a sweep root once node-pty reports it (0 for ≈100–200 ms after spawn); a detached grandchild survives `pty.kill()` and is reaped by the worktree sweep only when it matches the sweep's evidence rules; a failed open kills the orphan pty on Windows (the POSIX leak is a pre-existing upstream finding); `node-pty-fd-leak.test.ts` stays POSIX-only because it counts `/dev/ptmx` with `lsof` (ConPTY has no equivalent signal yet).
- Provider launch: executables are resolved through `Path` + `PATHEXT`; Node `.cmd` shims (including npm's own `npm.cmd`/`npx.cmd` launcher shape) run as `node.exe <script>`; a `.cmd` that is not a Node shim is refused with the Phase 2 message; Codex (`codex.exe`), Claude Code (`claude.exe`, well-known `%USERPROFILE%\.local\bin`), Pi (`pi` → `pi.exe`; five-pipe stdio verified with a Node child; Pi itself not installed on the reference desktop) and ACP agents spawn with `windowsHide`; the Claude Agent SDK spawns `claude.exe` itself.
- Provider installation: runs through ConPTY; commands are resolved first (ConPTY cannot start `.cmd`); cancel kills the leader and reaps descendants by identity; `npm install -g` runs as `node.exe npm-cli.js`; `installUnavailableReason` explains a missing install button; Claude Code's shell installer is not offered on Windows (install from claude.com/claude-code); Pi needs `bun` or `npm` on Path; protocol 201.
- Watcher: `@parcel/watcher` win32-x64 prebuild; backslash event paths; case-insensitive root matching and dedupe; `\\?\` roots; glob ignores unchanged; the inotify ceiling test is Linux-only by design.
- Log viewer: Windows follows files by offset with a 2 s poll plus directory watch; POSIX keeps `tail -F`.
- `bb-app`: the tarball smoke runs on Windows through Node's bundled `npm-cli.js`/`npx-cli.js`; `npx bb-app` from a clean PowerShell session is gate evidence.
- CI: `windows-x64` now runs `bb-app` typecheck/build/test, the ConPTY smoke and the tarball smoke; the test baseline stays non-blocking.
- Skill scripts guidance updated with the provider facts only (R22).

**Known limitations after Phase 3** (bullets): 5.1/cmd code page; exit code `0xC000013A` display; POSIX failed-open leak (upstream); Pi unverified live; `spawnClaudeCodeProcess` not installed (SDK owns the spawn); `qa/windows/CHECKLIST.md` not yet created (Phase 5); `readNodeCmdShim` recognises the npm launcher and `node_modules/.bin` shapes only; secrets/ACL items carried from Phase 2 unchanged; runtime-id design still Phase 4; `dev:stop` still unverified.

**Beta declaration wording** (R21): `docs/platform-support.md` "Supported host environments" gains `- Windows 11 x64, native (beta)` beside the WSL2 bullet; the WSL2 paragraph keeps WSL2 as the stable path and adds one paragraph: native Windows runs the server, host daemon, terminals and providers directly (see platform-windows.md), is verified on the fork's `windows-native/*` branches and the `windows-x64` CI job, and is beta because the Desktop app (Phase 4) and the persistent host (Phase 5) have not landed. The maintainer-only list moves native Windows out and points at platform-windows.md. The CI sentence says the Windows job is non-required while the native path is beta. `README.md` and `packages/bb-app/README.md` add a `Native Windows (beta)` alternative with the PowerShell `npx bb-app` command, `LongPathsEnabled` and Git for Windows prerequisites, and the pointer to platform-windows.md.

- [ ] **Step 1: Write the docs**; **Step 2:** `pnpm exec oxfmt` on every touched `.md`; run the docs tests that assert on these files (`apps/server` docs tests that scan the plugin guide; `pnpm exec turbo run test --filter=@bb/templates` if templates changed); **Step 3: Commit**

```bash
git add docs README.md packages/bb-app/README.md plugins/bb-guide packages/templates
git commit -m "Document native Windows terminals, provider launch and the beta runtime"
```

---

### Task 14: Phase gate and evidence

**Files:**

- Create: `qa/windows/phase-3/00-host.md`, `20-terminal-ctrl-c-resize-utf8.md` (+ `.txt`), `21-codex-turn-on-c.md` (+ `.txt`), `22-claude-code-turn-on-c.md` (+ `.txt`), `23-watcher-ntfs.md`, `24-npx-bb-app-clean-shell.md` (+ `.txt`), `25-conpty-smoke.md` (+ `.txt`), `26-provider-installation.md`, `30-build-typecheck.txt`, `31-test-results.md`, `31-test-output-tail.txt`, `40-posix-check.md`, `41-ci-run.md`
- Modify: `docs/platform-windows.md` only to correct a claim the gate disproves.

Every step records the exact command, its exit code captured in the same shell (`cmd; echo "EXIT=$?"` or `$LASTEXITCODE`), versions, and pids. Programmatic where possible; a genuinely human-only step is recorded as `MANUAL — for the user` with exact instructions, never faked. Dev launcher facts: `pnpm dev:app current` starts server + daemon; `pnpm --silent dev:app env --powershell | Out-String | Invoke-Expression` sets `BB_SERVER_URL`, `BB_HOST_DAEMON_PORT`, `BB_PROJECT_ID` (the CLI needs both URL and daemon port); `pnpm dev:status` can misreport — verify listeners with `Get-NetTCPConnection -LocalPort <port>`; the CLI on Windows is `node apps/cli/dist/index.js …` or `apps/cli/bin/bb.cmd`.

- [ ] **Step 1 — `00-host.md`:** commit, `node -v`, `pnpm -v`, `git --version`, `[Environment]::OSVersion`, `$PSVersionTable.PSVersion`, `pwsh`/`powershell`/`cmd` paths, `codex --version`, `claude --version`, `bun --version`, the three auth files' existence (never contents), and `bb provider list --json` health for `codex` and `claude-code` against the dev instance.
- [ ] **Step 2 — build/typecheck:** `pnpm exec turbo run build typecheck --output-logs=new-only > qa/windows/phase-3/30-build-typecheck.txt 2>&1`; expected all green.
- [ ] **Step 3 — tests:** `pnpm exec turbo run test --continue --summarize --output-logs=new-only > <scratchpad>/31-full.log 2>&1`, summarise with `node qa/windows/scripts/summarize-turbo-run.mjs` into `31-test-results.md` with the per-package table and a pass→fail delta against `qa/windows/phase-2/31-test-results.md`; every file that flipped pass→fail is re-run isolated and classified (regression → fix in this task with its own commit and re-review; load flake → recorded). `@bb/server` and `@bb/host-daemon` file by file when the full run is load-sensitive. `31-test-output-tail.txt` holds the last 200 lines.
- [ ] **Step 4 — terminal (`20-…`):** start the dev app; `bb terminal create --machine <host> --cwd C:\Users\olege\Work --title gate --cols 80 --rows 24 --json`; `bb terminal resize <id> --cols 120 --rows 40`; `bb terminal send <id> --text "Write-Output ('При' + 'вет')`n"`; `bb terminal output <id> --json`shows`Привет`; start `Start-Sleep -Seconds 30`, send byte `0x03` through the SDK (`sdk.terminals.input({ terminalId, dataBase64: Buffer.from([0x03]).toString("base64") })`via a`node -e`one-liner against`packages/sdk`, or `bb terminal send --stdin`with raw bytes) and prove the prompt returns within 5 s; close and confirm the pid left`tasklist`and what`terminal.exited`carried. **MANUAL — for the user:** open a thread in the app, open its terminal panel, press Ctrl+C during`Start-Sleep -Seconds 30`, resize the window, type `echo Привет`; record the three outcomes and what the panel shows after closing (R8).
- [ ] **Step 5 — Codex turn (`21-…`):** `git init C:\Users\olege\Work\phase3-codex` with one commit; `bb project create --name phase3-codex --root C:\Users\olege\Work\phase3-codex --machine <host>`; `bb thread spawn --project <id> --provider codex --permission-mode accept-edits --prompt "Create a file named codex-phase3.txt containing the text 'codex wrote this'." --json`; `bb thread wait <thread> --status idle --timeout 300`; verify the file content on disk and `bb thread show <thread> --git-diff`; `bb thread log <thread> --all` tail into the `.txt`.
- [ ] **Step 6 — Claude Code turn (`22-…`):** same shape with `--provider claude-code`, root `C:\Users\olege\Work\phase3-claude`, file `claude-phase3.txt`. If the turn fails because the SDK cannot spawn `claude.exe` (R14 contingency), record the daemon/bridge log lines, implement `spawnClaudeCodeProcess` on win32 in `sdk-session.ts`/`model-list.ts` (spawn the resolved path with `windowsHide: true`, piped stdio, no casts) as a separate commit, and re-run.
- [ ] **Step 7 — watcher (`23-…`):** with the Codex project open, from another PowerShell `Set-Content C:\Users\olege\Work\phase3-codex\watched.txt "x"` then rename to `WATCHED.TXT`; prove the app/daemon observed it (`bb project files`/content or the workspace status endpoint) without a manual refresh; cite the Task 9 real-test run.
- [ ] **Step 8 — `npx bb-app` (`24-…`):** `pnpm exec turbo run smoke:tarball --filter=bb-app` transcript; then from a **new** PowerShell window with none of the `BB_*` dev vars set: `npx --yes --package <path to the packed .tgz> bb-app --data-dir C:\Users\olege\.bb-phase3-test --server-port 48886 --host-daemon-port 48887`, wait for the URL line, `Invoke-WebRequest http://127.0.0.1:48886/api/v1/system/config`, then `npx --package <tgz> bb-app stop` (or the documented stop command); record exit codes and remove the data dir.
- [ ] **Step 9 — ConPTY smoke (`25-…`):** `pnpm exec turbo run smoke:windows-conpty --filter=@bb/desktop`; expect `conpty smoke: 6/6`; run three times and record all three.
- [ ] **Step 10 — provider installation (`26-…`):** `bb machine provider-cli status --json` for codex, claude-code, pi; show `installUnavailableReason` for pi (bun present → an install action instead; record whichever the host yields) and for claude-code when not installed (simulate by pointing `BB_CLAUDE_CODE_EXECUTABLE` at a missing file in a throwaway daemon run only if the status path honours it; otherwise cite the bridge unit test); run `bb machine provider-cli install codex --action update` only if an update is offered, else run the Task 4 real test and cite it.
- [ ] **Step 11 — POSIX check (`40-…`):** in WSL (`~/bb-posix-check`, nvm Node 24, Linux-only PATH without `/mnt/c`, logs under `~/` not `/tmp`): fetch the branch, `pnpm install`, `pnpm exec turbo run typecheck`, and `test` for `@bb/process-utils`, `@bb/host-daemon` (file by file), `@bb/provider-bridge-protocol`, `@bb/provider-bridge-acp`, the four provider plugins, `@bb/host-watcher`, `@bb/desktop`, `bb-app`, `@bb/cli`, `@bb/app`, `@bb/server` (known 2 pre-existing failing files), the two environment plugins. Any POSIX failure not present at 9a07e6994 is a gate FAIL.
- [ ] **Step 12 — CI (`41-…`):** push `windows-native/phase-3`; cancel the queued Blacksmith/Version Lockstep runs after the Windows job; record the run id, the `Windows x64` result and the three new steps' outcomes.
- [ ] **Step 13 — cleanup and commit:** `pnpm dev:stop` (verify listeners gone), delete the two scratch projects' directories (note the dev DB rows stay, as in Phases 1–2), commit the evidence:

```bash
git add qa/windows/phase-3 docs/platform-windows.md
git commit -m "Record the Phase 3 Windows gate evidence"
```

Gate verdict in `31-test-results.md`'s header: PASS only when Steps 2–12 hold; a FAIL names the step and the fix commit that follows.
