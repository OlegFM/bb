# POSIX regression check (task 11, amendment E; updated in fix round 1)

## Fix round 1 (current result)

Date: 2026-09-12
Distro: Ubuntu 24.04.4 LTS (WSL2, kernel 6.18.33.2-microsoft-standard-WSL2), `wsl.exe -d Ubuntu-24.04`
node -v: v22.19.0
pnpm -v: 9.15.0
Clone `git rev-parse HEAD` (after updating): `363e830c0c37d667935e4759919d59993069b49a` — matches the pushed SHA measured in `40-ci-run.md`.

### Update the clone

```
cd ~/bb-posix-check && git pull --ff-only 2>&1; echo "PULL_EXIT=$?"; git rev-parse HEAD
```
```
Updating 08739e5e8..363e830c0
Fast-forward
 ... 20 files changed, 3614 insertions(+), 18 deletions(-)
PULL_EXIT=0
363e830c0c37d667935e4759919d59993069b49a
```
(`pnpm-lock.yaml` and root `package.json` are unchanged between `08739e5e8` and `363e830c0` — confirmed with `git diff --stat`, so no fresh `pnpm install` was needed before re-running the filtered test; Tasks 11b/11d/11e only touch source and workflow files.)

### Re-run the filtered test — now green

Launched detached (`setsid nohup ... & disown -a`, same pattern as the install workaround below) so the command survives independently of the launching `wsl.exe` process, then polled the log from fresh `wsl.exe` calls:

```
pnpm exec turbo run test --filter=@bb/scripts --filter=bb-app --output-logs=errors-only; echo "POSIX_TEST_EXIT=$?"
```
```
• turbo 2.10.12

   • Packages in scope: @bb/scripts, bb-app
   • Running test in 2 packages
   • Remote caching disabled


 Tasks:    7 successful, 7 total
Cached:    5 cached, 7 total
  Time:    20.773s

POSIX_TEST_EXIT=0
```
`POSIX_TEST_EXIT=0` here is `$?` captured immediately after the `pnpm exec turbo run test ...` command in the same inner shell, and it agrees with the `Tasks: 7 successful, 7 total` line printed immediately above it in the same log — unlike the previous round's `POSIX_TEST_EXIT=0`, which followed a `Command "turbo" not found` failure and should not have read `0` (see "Known issue" below). **Both `@bb/scripts#test` and `bb-app#test` are green** — Task 11d (removed the `codex` literal from `run-dev-app.ts`) and Task 11e (made the ratchet CLI's own tests really spawn the CLI on Windows/POSIX instead of the previous stale-title/skip behavior) together resolved the provider-literal-ratchet failure this check found in the original round.

## Original round (task 11, unchanged narrative)

Distro/toolchain, the clone, and the install below are as originally recorded; only the final filtered-test result and its exit line are superseded by the "Fix round 1" section above.

### 1. Clone

```bash
git clone --branch windows-native/phase-0 /mnt/c/Users/olege/Work/bb ~/bb-posix-check
```
Succeeded.

### 2. Toolchain

```bash
. ~/.nvm/nvm.sh && nvm install 22.19.0 && nvm use 22.19.0 && corepack enable && node -v && pnpm -v
```
`Now using node v22.19.0 (npm v10.9.3)`, `v22.19.0`, then corepack downloaded pnpm and reported `9.15.0`.

### 3. Install — required two attempts because of a tooling quirk, not a product problem

**First attempt** (a single `wsl.exe -d Ubuntu-24.04 -- bash -c '... && ...'` invocation backgrounded from the Windows side, `> logfile 2>&1`) printed what looked like normal `Progress:` output ending in `PNPM_INSTALL_EXIT=0`, but `node_modules` in the clone was completely empty afterward and `pnpm exec turbo` failed with `Command "turbo" not found`. Root cause, reproduced deliberately: a `wsl.exe -d Ubuntu-24.04 -- bash -c '<a> && <b> && <c>'` invocation launched and backgrounded from this Windows session can return, or the wrapped process can be killed by `SIGHUP`, before the wrapped command has actually finished — observed directly via `ps aux` showing the shell killed by `Hangup` moments after the launching `wsl.exe` call returned, even under `nohup`/`disown`. This is the same class of bug behind the "Known issue" below: an exit line that looks like it was captured with `$?` can still describe a process that did not really do (or finish) the work the surrounding log implies, when the shell that would compute `$?` was itself killed or never reached that point in the way the log's ordering suggests.

**Second attempt**, the one whose numbers are recorded: launched as a fully detached session, `setsid nohup bash -c "pnpm install --frozen-lockfile; echo PNPM_INSTALL_EXIT=$?" > ~/bb-posix-install.log 2>&1 < /dev/null & disown -a`, polled from fresh, independent `wsl.exe` calls (never one long-lived backgrounded `wsl.exe -- ... &` process). This finished cleanly: `Done in 23m 10.7s`, `PNPM_INSTALL_EXIT=0` (23 minutes is mostly `better-sqlite3` compiling from source — no cached native build for this distro). Verified: `node_modules` populated, `node_modules/.bin/turbo` present.

### Known issue this round fixed: an exit line following a failing command

The original round's filtered-test attempt (before the `setsid` pattern was adopted for it) logged:
```
Now using node v22.19.0 (npm v10.9.3)
undefined
 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "turbo" not found
POSIX_TEST_EXIT=0
```
`turbo` was not found (this was before the install was fixed, so `node_modules/.bin/turbo` did not exist), yet the recorded exit line read `0`. The `$?` syntax used was correct, but this is exactly the failure mode described above: the command that supposedly produced this exit code did not run the way the log implies, so the printed number cannot be trusted as evidence the run succeeded. This task's fix-round re-run (above) was checked against its own success banner (`Tasks: 7 successful, 7 total`) printed immediately before the exit line in the same log, so the two agree this time.

`~/bb-posix-check` left in place per the amendment, for the controller's later review/deletion.
