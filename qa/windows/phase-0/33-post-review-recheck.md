# Post-review recheck (whole-branch review, final fix wave)

Date: 2026-09-12
`node -v`: v22.19.0
`git rev-parse HEAD` at recheck time: `11e94578ca9e1af41cd8a9ba504a8f59cef3fabf`
Machine: reference desktop, Windows 11 Pro 10.0.26200 (OMEN), pnpm 9.15.0 via corepack

Every `EXIT=` line below was produced by `"EXIT=$LASTEXITCODE"` run in the same
PowerShell invocation as the command immediately above it; the surrounding prose
was written by the agent from that run's output.

## 1. Build and typecheck

```powershell
pnpm exec turbo run build typecheck --output-logs=new-only
"EXIT=$LASTEXITCODE"
```

```
@bb/desktop:build: @bb/desktop: built Electron entries

 Tasks:    144 successful, 144 total
Cached:    134 cached, 144 total
  Time:    42.076s

EXIT=0
```

## 2. `@bb/scripts` test baseline

```powershell
pnpm exec turbo run test --filter=@bb/scripts --output-logs=errors-only
"EXIT=$LASTEXITCODE"
```

```
@bb/scripts:test:  Test Files  5 failed | 21 passed (26)
@bb/scripts:test:       Tests  10 failed | 153 passed | 2 skipped (165)

 Tasks:    5 successful, 6 total
Cached:    4 cached, 6 total
  Time:    8.95s
Failed:    @bb/scripts#test

 ERROR  run failed: command  exited (1)
EXIT=1
```

`EXIT=1` is the failing-baseline exit code, not a regression: the same five files
failed in the last recorded baseline for this package
(`31-test-baseline.md`, `| @bb/scripts | 5/21 | 10/150 |`). The failing-test count
is unchanged at 10 and the passing count went 150 to 153, which is exactly the
three test cases this fix wave added.

Failing files (all pre-existing, none touched by this fix wave):

| File | Failed | Reason class |
|---|---|---|
| `test/source-cli-wrapper.test.ts` | 1 | `Error: spawn pnpm ENOENT` (test spawns `pnpm` without cross-spawn) |
| `test/archive-codex-tmp-bb-sessions.test.ts` | 3 | POSIX path expectations (`'C:\Users\tester\custom-codex'` vs `'\Users\tester\custom-codex'`) |
| `test/ci-workflow.test.ts` | 1 | workflow assertion that depends on a POSIX shell |
| `test/pr-approval-workflows.test.ts` | 2 | expected `'\n\n\n'` to contain `--remove-label needs-approval` (bash-dependent) |
| `test/run-dev.test.ts` | 3 | POSIX path expectations (`~/.bb/skills`) |

The fix wave's own file passes in full:

```
@bb/scripts:test:  ✓ |@bb/scripts| test/dev-app-launcher.test.ts (19 tests) 2247ms
@bb/scripts:test:  ✓ |@bb/scripts| test/run-dev-app.test.mjs (5 tests) 2079ms
```

## 3. Live dev launcher cycle

```powershell
pnpm dev:app current
"EXIT=$LASTEXITCODE"
```

```
[dev-app] desktop: not running
[dev-app] dev server: not running
[dev-app] Installing dependencies
[dev-app] Checking native modules
[dev-app] Building the plugin SDK
[dev-app] Starting dev server, log C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\dev-app\dev.log
Repo: C:\Users\olege\Work\bb
Branch: windows-native/phase-0 (11e94578c)
Node: v22.19.0 (ABI 127) at C:\nvm4w\nodejs\node.exe
Instance: work-bb-21d97a8d7c85
Data dir: C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85
App: http://localhost:15813
Server: http://127.0.0.1:23813
Host daemon: http://127.0.0.1:31813
Desktop user data: C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\desktop
Dev session: running
Desktop session: stopped
Logs: C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\dev-app\dev.log, C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\dev-app\desktop.log

EXIT=0
```

The session log carries no `[session-host]` line for this healthy start
(`grep -c "session-host" dev.log` = 0) and reaches the ready banner:

```
@bb/host-daemon:dev: [03:22:00] INFO: [host-daemon] Host daemon started {"serverUrl":"http://127.0.0.1:23813", ...}
```

```powershell
pnpm dev:status
"EXIT=$LASTEXITCODE"
Get-NetTCPConnection -LocalPort 23813,31813,15813 -State Listen | Select-Object LocalPort,State,OwningProcess
```

```
Dev session: running
Desktop session: stopped
EXIT=0

LocalPort  State OwningProcess
---------  ----- -------------
    31813 Listen          5828
    23813 Listen         24900
    15813 Listen         42068
```

```powershell
pnpm dev:stop
"EXIT=$LASTEXITCODE"
```

```
[dev-app] desktop: not running
[dev-app] dev server: stopped
EXIT=0
```

```powershell
pnpm dev:status
"EXIT=$LASTEXITCODE"
$conns = Get-NetTCPConnection -LocalPort 23813,31813,15813 -ErrorAction SilentlyContinue
"PORTS=$($conns.Count)"
```

```
Dev session: stopped
Desktop session: stopped
EXIT=0
PORTS=0
```

The machine is clean after the cycle: both sessions stopped, no connection of any
state on 23813, 31813 or 15813.

## The four commits under review

| SHA | Subject |
|---|---|
| `c2d5148da1822b84f9aeca19188b24fd395de189` | Correct the Windows page and verify-bb skill after the launcher change |
| `9e0bbf3dfb9a51c233447a9f2df8d2b3e2be577d` | Fail fast when the Windows session host cannot start its child |
| `598e311790b56e22653ec72d9a6e0ee7850dc2af` | Make followLogFile drain after abort and its test deterministic |
| `11e94578ca9e1af41cd8a9ba504a8f59cef3fabf` | Format the files touched by Phase 0 |

Per-commit verification (Turbo, logs kept outside the repo under
`.superpowers/sdd/2026-09-11-native-windows-phase-0/final-fix-*.log`):

- Commit 2: `turbo run test --filter=@bb/scripts -- dev-app-launcher` 18 passed,
  `turbo run typecheck --filter=@bb/scripts` exit 0. With the source change
  stashed the three new assertions fail (`Tests 3 failed | 15 passed`), so they
  do test the fix.
- Commit 3: same two commands (19 passed, typecheck exit 0). The `followLogFile`
  tests ran three times uncached; each run reported `2 passed | 17 skipped`.
  `-- followLogFile` alone selects no file (vitest positionals are filename
  filters and no file is named that), so the three runs used
  `--force -- dev-app-launcher -t followLogFile`. With the drain stashed the new
  test fails (`expected 'first line\n' to be 'first line\nsecond line\n'`).
- Commit 4: `pnpm exec oxfmt` on the eleven listed files, then
  `pnpm exec oxfmt --check` on them ("All matched files use the correct format.",
  exit 0), then `turbo run test --filter=@bb/scripts -- dev-app-launcher`
  (19 passed).

## 4. CI run for the pushed branch

Run: https://github.com/OlegFM/bb/actions/runs/34661615561 (CI workflow, push of
`8efe55e90` to `windows-native/phase-0` on the fork).

`Windows x64 (windows-2025, Node 22.x)`: **completed success**, 00:26:08Z to
00:34:14Z UTC (8m06s). Polled every 3 minutes with

```bash
gh run view 34661615561 -R OlegFM/bb --json jobs \
  --jq '.jobs[] | select(.name | startswith("Windows x64")) | {status, conclusion}'
```

which reported `in_progress` on the first three polls and
`completed success` on the fourth. The run's other jobs (Linux and macOS test,
check and smoke legs) were still queued on the fork's runners, so the run was
cancelled after the Windows job concluded, per the dispatch:
`gh run cancel 34661615561 -R OlegFM/bb` → `✓ Request to cancel workflow 34661615561 submitted.`,
`EXIT=0`.

For comparison, the same job was also `success` on the previous push
(`f37f6ffad`, run 34658495073).
