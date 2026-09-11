# POSIX regression check (task 11, amendment E; updated in fix rounds 1 and 2)

## Fix round 2 (current, authoritative test result)

Date: 2026-09-12
Clone `git rev-parse HEAD`: `363e830c0c37d667935e4759919d59993069b49a`. No `git pull` was needed for this round: every commit landed since that SHA touches only `qa/` and `docs/superpowers/plans/`, not source or workflow files, so the clone's tree is unaffected.

Re-ran only the test command, in the foreground from the Bash tool (about 5 minutes wall clock including the WSL invocation overhead), per the fix brief's exact command:

```
wsl.exe -d Ubuntu-24.04 -- bash -c 'cd ~/bb-posix-check && git rev-parse HEAD && pnpm exec turbo run test --filter=@bb/scripts --filter=bb-app --output-logs=errors-only; echo "POSIX_TEST_EXIT=$?"' > .superpowers/sdd/2026-09-11-native-windows-phase-0/task-11-fix2-wsl-test.log 2>&1
```

Run exactly as specified (after restoring the `. ~/.nvm/nvm.sh; nvm use 22.19.0` prefix every other WSL command in this task has needed — without it, a non-login `bash -c` resolves `pnpm` to the Windows interop binary at `/mnt/c/nvm4w/nodejs/pnpm` instead of the Linux nvm install, which fails immediately with `exec: node:` and never reaches the exit line). The single-quoted outer argument does let `$?` reach the inner bash unexpanded, as intended, but running `git rev-parse HEAD && pnpm exec turbo run test ...` as one command in one `wsl.exe` invocation produced this (reproduced twice, deterministically, not a one-off race):

```
• turbo 2.10.12
5e4759919d59993069b49a

   • Packages in scope: @bb/scripts, bb-app
   ...
```

`git rev-parse HEAD`'s own output arrived corrupted and out of order — its first ~18 characters were lost and the remainder was printed after Turbo's own first banner line, even though `&&` guarantees `git` ran and exited first. This is a redirection artifact of `wsl.exe`'s Windows-file-handle forwarding when two different child processes (`git`, then the `pnpm`/`turbo` process tree) write to the same redirected file within one invocation — not something in the WSL guest's own shell semantics, and not the thing this fix round was chasing, but worth recording since it could otherwise be mistaken for corrupted evidence. Splitting the same work into two foreground `wsl.exe` invocations against the same log file (still single-quoted outer arguments, still `$?` reaching the inner shell, still foreground, same named log) produced a clean, trustworthy result:

```
363e830c0c37d667935e4759919d59993069b49a
---

   • Packages in scope: @bb/scripts, bb-app
   • Running test in 2 packages
   • Remote caching disabled


 Tasks:    7 successful, 7 total
Cached:    6 cached, 7 total
  Time:    457ms

POSIX_TEST_EXIT=0
```

HEAD confirmed (`363e830c0c37d667935e4759919d59993069b49a`, matching the header above), Turbo footer `Tasks: 7 successful, 7 total`, `POSIX_TEST_EXIT=0` captured as `$?` immediately after the Turbo command in the same shell that ran it — this is the actual command's own exit status, not a value expanded by an outer shell before the command ran, and it agrees with the success banner printed immediately above it in the same log. **Both `@bb/scripts#test` and `bb-app#test` are green.** Raw log: `.superpowers/sdd/2026-09-11-native-windows-phase-0/task-11-fix2-wsl-test.log`.

## Fix round 1: updating the clone

Date: 2026-09-12. Distro: Ubuntu 24.04.4 LTS (WSL2, kernel 6.18.33.2-microsoft-standard-WSL2). node -v: v22.19.0. pnpm -v: 9.15.0.

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
(`pnpm-lock.yaml` and root `package.json` are unchanged between `08739e5e8` and `363e830c0` — confirmed with `git diff --stat`, so no fresh `pnpm install` was needed; Tasks 11b/11d/11e only touch source and workflow files.) Fix round 1's own filtered-test re-run (which reported the fixed provider-literal-ratchet result was green) is superseded by Fix round 2's cleaner capture above; the result itself (green) is unchanged, only the exit-code provenance is stronger now.

## Original round (task 11)

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

**First attempt** (a single `wsl.exe -d Ubuntu-24.04 -- bash -c '... && ...'` invocation backgrounded from the Windows side, `> logfile 2>&1`) printed what looked like normal `Progress:` output ending in `PNPM_INSTALL_EXIT=0`, but `node_modules` in the clone was completely empty afterward and `pnpm exec turbo` failed with `Command "turbo" not found`. Root cause, reproduced deliberately: a `wsl.exe -d Ubuntu-24.04 -- bash -c '<a> && <b> && <c>'` invocation launched and backgrounded from this Windows session can return, or the wrapped process can be killed by `SIGHUP`, before the wrapped command has actually finished — observed directly via `ps aux` showing the shell killed by `Hangup` moments after the launching `wsl.exe` call returned, even under `nohup`/`disown`.

**Second attempt**, the one whose numbers are recorded: launched as a fully detached session, `setsid nohup bash -c "pnpm install --frozen-lockfile; echo PNPM_INSTALL_EXIT=$?" > ~/bb-posix-install.log 2>&1 < /dev/null & disown -a`, polled from fresh, independent `wsl.exe` calls. The log ends: `Done in 23m 10.7s`, `PNPM_INSTALL_EXIT=0` (23 minutes is mostly `better-sqlite3` compiling from source — no cached native build for this distro).

**Honest correction (fix round 2)**: as written above, `echo PNPM_INSTALL_EXIT=$?` sits inside a double-quoted string that is itself an argument built by the *launching* shell (the one running `setsid nohup bash -c "..."`), so `$?` there is expanded by that launching shell at the point the argument is constructed — not deferred to the detached process that actually runs `pnpm install`. The printed `0` is therefore **not proof of the install's real exit code**; it does not reliably say anything about whether `pnpm install --frozen-lockfile` itself succeeded. The install's success instead rests on three independent, trustworthy signals: the `Done in 23m 10.7s` completion banner from pnpm itself (a process that exits abnormally or is killed does not print this), `node_modules` populated with `node_modules/.bin/turbo` present (checked directly with `ls` in a separate command afterward), and the green test run recorded above, which could not have run `pnpm exec turbo run test` at all — let alone successfully — against an incomplete install. The raw log excerpt above is kept as originally captured.

`~/bb-posix-check` left in place per the amendment, for the controller's later review/deletion.
