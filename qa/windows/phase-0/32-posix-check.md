# POSIX regression check (task 11, amendment E)

Date: 2026-09-11 / 2026-09-12 (crossed midnight local time during the run)
Distro: Ubuntu 24.04.4 LTS (WSL2, kernel 6.18.33.2-microsoft-standard-WSL2), `wsl.exe -d Ubuntu-24.04`
node -v: v22.19.0
pnpm -v: 9.15.0
Clone `git rev-parse HEAD`: `08739e5e8df109975057a344d96c39aeb9ae2640` (the branch tip at clone time; it had advanced one commit past this task's own build/test runs — see the "concurrent commit" note in the main report)

All commands run via `wsl.exe -d Ubuntu-24.04 -- bash -c '<cmd>'` from the Bash tool, output piped through `tr -d '\0'` where captured directly.

## 1. Clone

```bash
git clone --branch windows-native/phase-0 /mnt/c/Users/olege/Work/bb ~/bb-posix-check
```

Succeeded (`Cloning into '/home/olege/bb-posix-check'... done.`).

## 2. Toolchain

```bash
. ~/.nvm/nvm.sh && nvm install 22.19.0 && nvm use 22.19.0 && corepack enable && node -v && pnpm -v
```

Result: `Now using node v22.19.0 (npm v10.9.3)`, `v22.19.0`, then corepack downloaded pnpm and reported `9.15.0`.

## 3. Install — required two attempts because of a tooling quirk, not a product problem

```bash
cd ~/bb-posix-check && pnpm install --frozen-lockfile
```

**First attempt** (as a single `wsl.exe -d Ubuntu-24.04 -- bash -c '... && ...'` invocation backgrounded from the Windows side, `> logfile 2>&1`) reported `PNPM_INSTALL_EXIT=0` after what looked like normal `Progress:` output, but `node_modules` in the clone was completely empty afterward (`ls node_modules | wc -l` → `0`) and `pnpm exec turbo` failed with `Command "turbo" not found`. Root cause, reproduced deliberately: a `wsl.exe -d Ubuntu-24.04 -- bash -c '<a> && <b> && <c>'` invocation launched from this Windows session's Bash tool can return before the wrapped command is actually done and/or the wrapped process can receive `SIGHUP` when the launching `wsl.exe` process exits, even with `nohup`/`disown` — `ps aux` inside the distro showed the shell killed by `Hangup` moments after the launcher returned. `;`-separated commands in the same shape were not observed to reproduce the silent-exit-3 variant, and neither `nohup` nor `disown` alone survived the hangup once backgrounded from the Windows side.

**Second attempt**, which is the one actually recorded here: launched the install as a fully detached session via `setsid nohup bash -c "pnpm install --frozen-lockfile; echo PNPM_INSTALL_EXIT=$?" > ~/bb-posix-install.log 2>&1 < /dev/null & disown -a`, then polled the log file from fresh, short-lived `wsl.exe` invocations (never leaving one long-lived `wsl.exe -- ... &` process backgrounded on the Windows side). This survived and finished cleanly:

```
Done in 23m 10.7s
PNPM_INSTALL_EXIT=0
```

(23 minutes is mostly `better-sqlite3` compiling from source under WSL — there is no cached native build for this distro.) Verified afterward: `node_modules` populated (14 top-level entries), `node_modules/.bin` has 13 entries including `turbo`. The same per-workspace-bin `WARN Failed to create bin ... ENOENT` lines seen on Windows in `10-install.txt` appear here too (expected: unbuilt workspace `dist/` output, same cause).

## 4. Filtered test — NOT green

```bash
pnpm exec turbo run test --filter=@bb/scripts --filter=bb-app --output-logs=errors-only
```

Launched the same way (detached via `setsid`/`disown`, polled from outside). Turbo footer:

```
 Tasks:    6 successful, 7 total
Cached:    3 cached, 7 total
  Time:    8.552s
Failed:    @bb/scripts#test
```

`bb-app#test` passed. `@bb/scripts#test` failed: `Test Files 1 failed | 25 passed (26)`, `Tests 2 failed | 159 passed (161)`, both failures in `test/provider-literal-ratchet.test.mjs`:

```
FAIL @bb/scripts test/provider-literal-ratchet.test.mjs > ratchet CLI (against the real repo baseline) > passes against the committed baseline
AssertionError: Provider-literal ratchet FAILED — core gained provider-id references.
  + packages/scripts/src/commands/run-dev-app.ts: 1
Do not add a provider-id branch to core.
: expected 1 to be +0

FAIL @bb/scripts test/provider-literal-ratchet.test.mjs > ratchet CLI (against the real repo baseline) > --write refuses to raise the total without the override
AssertionError: expected 1 to be +0
```

This is **not** a Windows-porting or POSIX-specific artifact: the ratchet counts provider-id string literals in core source files, which is OS-independent, and `packages/scripts/src/commands/run-dev-app.ts` does contain a new one —

```
packages/scripts/src/commands/run-dev-app.ts:215:      captureCommandOutput("codex", ["--version"]),
```

— printed by `pnpm dev:status`'s `Codex: codex-cli 0.153.4` line (see `20-dev-app.txt` and this task's own `pnpm dev:status` output). `packages/scripts` is core, not a plugin, so per `AGENTS.md` / the `Check provider-literal ratchet` CI step (`scripts/check-provider-literal-ratchet.mjs`), this needs an allowlist update or the literal needs to move out of core — neither of which this task made, per its brief (do not fix product code found while gathering evidence; this is the controller's call). **This means the gate's last checklist item is not met**: `pnpm exec turbo run test --filter=@bb/scripts --filter=bb-app` is not green on this POSIX machine, and the failure is a real regression, not one specific to this task's platform work.

For comparison, the same `@bb/scripts` package failed much more broadly in the full Windows run in `31-test-baseline.md` (6 test files / 15 tests, including this same ratchet failure plus Windows-specific ones); this narrower POSIX run isolates that the ratchet failure alone reproduces off Windows.

## Commands, exact, with EXIT lines

```
git clone --branch windows-native/phase-0 /mnt/c/Users/olege/Work/bb ~/bb-posix-check   # EXIT=0
. ~/.nvm/nvm.sh; nvm install 22.19.0; nvm use 22.19.0; corepack enable; node -v; pnpm -v # v22.19.0 / 9.15.0
pnpm install --frozen-lockfile                                                          # EXIT=0 (second, detached attempt)
pnpm exec turbo run test --filter=@bb/scripts --filter=bb-app --output-logs=errors-only # turbo run failed: command exited (1); Failed: @bb/scripts#test
```

`~/bb-posix-check` left in place per the amendment, for the controller's later review/deletion.
