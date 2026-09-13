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

