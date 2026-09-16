# ConPTY smoke (Phase 3 gate, Step 9)

Host: `00-host.md`. Raw transcript: `25-conpty-smoke.txt`.
The smoke is `apps/desktop/scripts/smoke-windows-conpty.mjs`, run through Turbo. Six checks; the `close`
check accepts exit codes `0` and `-1073741510`; the `ctrl-c` check waits for the prompt before sending its
follow-up command. On a non-win32 host it prints `conpty smoke: skipped (not win32)`.

## Command

```bash
for i in 1 2 3; do
  pnpm exec turbo run smoke:windows-conpty --filter=@bb/desktop --output-logs=new-only
  echo "CONPTY_EXIT_$i=$?"
done
```

## Three consecutive runs

| run | started | checks | duration | exit |
|---|---|---|---|---|
| 1 | 2026-09-16T02:43:43+03:00 | **6/6** | 24.502 s | `CONPTY_EXIT_1=0` |
| 2 | 2026-09-16T02:44:08+03:00 | **6/6** | 24.327 s | `CONPTY_EXIT_2=0` |
| 3 | 2026-09-16T02:44:33+03:00 | **6/6** | 24.266 s | `CONPTY_EXIT_3=0` |

Verbatim (run 1; runs 2 and 3 differ only in pids, full text in the `.txt`):

```
check spawn-echo: ok pid=39472
check utf8: ok
check resize: ok
check ctrl-c: ok
check close: ok pid=22132 exitCode=-1073741510 reaped
check tree: ok parent=40484 child=46768 reaped
conpty smoke: 6/6
 Tasks:    1 successful, 1 total
  Time:    24.502s
CONPTY_EXIT_1=0
```

Run 2: `spawn-echo pid=39280`, `close pid=45560 exitCode=-1073741510 reaped`, `tree parent=20160 child=34952 reaped`.
Run 3: `spawn-echo pid=46272`, `close pid=45720 exitCode=-1073741510 reaped`, `tree parent=44556 child=22132 reaped`.

Every run reports a distinct set of pids and the word `reaped` for both the closed pty and the spawned
tree, so no check passed by observing a stale process.

## The same smoke in CI

The `windows-x64` CI job runs the smoke as its `Smoke ConPTY` step and tees it into
`qa-artifacts/conpty-smoke.txt`. Downloaded from run **35031701885**
(`gh run download … -n windows-x64-test-results`):

```
> @bb/desktop@0.42.1 smoke:windows-conpty D:\a\bb\bb\apps\desktop
> node scripts/smoke-windows-conpty.mjs

check spawn-echo: ok pid=1284
check utf8: ok
check resize: ok
check ctrl-c: ok
check close: ok pid=10228 exitCode=-1073741510 reaped
check tree: ok parent=7344 child=10028 reaped
conpty smoke: 6/6

 Tasks:    1 successful, 1 total
  Time:    22.834s
```

`Smoke ConPTY` concluded `success` in **every** CI run this gate pushed (`41-ci-run.md`: runs 1–4), on
`windows-2025` with its own Node 22.x — so 6/6 is reproduced on a second, unrelated Windows machine.

Counting Task 11 (3 runs plus one by the reviewer) and this step, the smoke has now reported 6/6 on this
desktop 7 times and in CI 4 times, with no observed flake.
