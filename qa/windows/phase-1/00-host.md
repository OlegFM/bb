# Host facts (Phase 1 gate, Task 11)

Machine: reference Windows desktop, Windows 11 Pro. Branch `windows-native/phase-1`.

Every command below was run in a single PowerShell 7.6.5 session through the agent's PowerShell tool; the `EXIT=` line after each block is `$LASTEXITCODE` read in that same shell immediately after the command.

## Toolchain and commit

Command:

```powershell
$f = "qa/windows/phase-1/00-host.md"; & { Get-Date -Format "o"; git rev-parse HEAD; node -v; pnpm -v; git --version; "$([System.Environment]::OSVersion.Version)"; (Get-Command node).Source; "pwsh $($PSVersionTable.PSVersion)" } 2>&1 | Tee-Object -Append $f; "EXIT=$LASTEXITCODE" | Tee-Object -Append $f
```

Output:

```
2026-09-13T09:23:39.6275020+03:00
203acb2738135c9b7ab1e2824da949223aa0dbc1
v22.19.0
9.15.0
git version 2.52.0.windows.1
10.0.26200.0
C:\nvm4w\nodejs\node.exe
pwsh 7.6.5
EXIT=0
```


## WSL guest used for Step 7

```powershell
wsl.exe -l -v | Out-String; wsl.exe -e bash -lc 'nproc; free -h | sed -n 2p'
```
```
    N A M E                                             S T A T E                       V E R S I O N

 *   U b u n t u - 2 4 . 0 4                             R u n n i n g                   2

     d o c k e r - d e s k t o p                         R u n n i n g                   2

     p o d m a n - m a c h i n e - d e f a u l t         S t o p p e d                   2



16
Mem:            15Gi       1.6Gi        12Gi       1.2Mi       1.6Gi        13Gi
```

(`wsl.exe -l -v` emits UTF-16, which the pipe renders with the spacing shown; the content is the three
distros, with `Ubuntu-24.04` default and running.) Guest resources: 16 vCPUs, 15 GiB RAM, 4 GiB swap.
Guest toolchain: node v22.19.0 through nvm, `corepack pnpm` 9.15.0. Clone: `~/bb-posix-check`, `origin` =
`/mnt/c/Users/olege/Work/bb`.

## Scratch repositories: deletion

The two hook-less repositories created for Steps 4-6 (`C:\Users\olege\Work\phase1-ui` and
`C:\Users\olege\Work\phase1-cli`, one commit each) were deleted at the end of this task, after every piece of
evidence in `20-project-on-c.md`, `21-path-identity.md` and `22-managed-worktree.md` had been recorded:

```powershell
Remove-Item -Recurse -Force C:\Users\olege\Work\phase1-ui, C:\Users\olege\Work\phase1-cli -Confirm:$false; "EXIT=$?"; "Test-Path phase1-ui: " + (Test-Path C:\Users\olege\Work\phase1-ui); "Test-Path phase1-cli: " + (Test-Path C:\Users\olege\Work\phase1-cli)
```
```
EXIT=True
Test-Path phase1-ui: False
Test-Path phase1-cli: False
```

(`$?` in PowerShell is a boolean for the last statement's success, not a process exit code; `Remove-Item` is
a cmdlet, not a native command, so `$LASTEXITCODE` would not have been updated by it. The two `Test-Path`
results are the substantive check.)

## Dev instance state left behind

- `pnpm dev:stop` was run at the end: `[dev-app] desktop: not running`, `[dev-app] dev server: stopped`,
  `EXIT=0`.
- The test-harness plugin installed while investigating Step 6 (`tests/scripted-echo-provider`) was
  uninstalled again: `DELETE /api/v1/plugins/scripted-echo-provider` returned `{"ok": true}` and the plugin
  count returned to 22 with no `scripted-echo-provider` row.
- The two projects created in Steps 4 and 5 (`proj_x4gdw7vz68` `phase1-ui`, `proj_j3jwwb7f8v` `phase1-cli`)
  were **left in the dev database**; their source directories no longer exist. They are dev-instance QA state
  and are the subject of this evidence, so they were not deleted.


---

# Gate refresh at `e976524b488483fd583de42c8dce13ac6d6ac0cd` (2026-09-13)

Same machine and toolchain as the section above (`node -v` re-checked: `v22.19.0`); only the commit changed.

## Scratch repository: re-created and deleted again

Step 6 was re-run at this head, so `C:\Users\olege\Work\phase1-ui` was re-created hook-less with a single
commit. The dev instance's project row for that path (`proj_x4gdw7vz68`) was still present and was reused.

```bash
d="/c/Users/olege/Work/phase1-ui"; rm -rf "$d"; git init -q "$d"; printf '# phase1-ui\n' > "$d/README.md"; git -C "$d" -c core.hooksPath= add README.md; git -C "$d" -c core.hooksPath= -c user.name="Phase1 QA" -c user.email="olegefm@gmail.com" commit -q -m "Initial commit"; git -C "$d" log --oneline; git -C "$d" rev-parse --abbrev-ref HEAD; echo "EXIT=$?"
```
```
warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
b96b1ec Initial commit
master
EXIT=0
```

Deleted again after the evidence in `22-managed-worktree.md` was recorded:

```powershell
pnpm dev:stop 2>&1 | Select-Object -Last 4; "EXIT=$LASTEXITCODE"; Remove-Item -Recurse -Force C:\Users\olege\Work\phase1-ui -Confirm:$false; "Test-Path phase1-ui: " + (Test-Path C:\Users\olege\Work\phase1-ui)
```
```
[dev-app] desktop: not running
[dev-app] dev server: stopped
EXIT=0
Test-Path phase1-ui: False
```

`C:\Users\olege\Work\phase1-cli` was not re-created; Step 4 was not re-run in this refresh.

## Dev instance state left behind by the refresh

- Dev app stopped (`pnpm dev:stop`, above).
- The five bundled plugins the asset-guard fix unblocked (`provider-claude-code`, `provider-codex`,
  `provider-pi`, `provider-acp`, `plugin-api-docs`) now load; the four provider plugins are enabled and
  running. This is the fix taking effect, not QA state to undo.
- Thread `thr_hnyw5gyc3h` ("Phase 1 worktree check") was archived through
  `POST /environments/env_v4mcchxyjw/archive-threads` and left in the dev database; its environment
  `env_v4mcchxyjw` is `destroyed` with `teardown_status: removed`.
- The two projects from Steps 4 and 5 remain in the dev database with their directories gone, as before.
- `packages/db/read-env-rows.mjs` — the throwaway `better-sqlite3` reader used to show `path_key` — was
  deleted from the checkout; `git status` is clean apart from the `qa/windows/phase-1/` evidence.

