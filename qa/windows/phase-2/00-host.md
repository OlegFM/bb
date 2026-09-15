# Host facts (Phase 2 gate, Task 15)

Machine: the same reference Windows desktop used for Phase 0 and Phase 1 (`qa/windows/phase-0/00-host.md`,
`qa/windows/phase-1/00-host.md`) — Windows 11 Pro, OS version `10.0.26200.0`, node from `C:\nvm4w\nodejs`.
Branch `windows-native/phase-2`, stacked on `windows-native/phase-1` (`07fdce05b`).

Every command in this gate was run in a single shell, and the `EXIT=` line after each block is
`$LASTEXITCODE` (PowerShell) or `$?` (Git Bash) read in that same shell immediately after the command.
The header and prose in this file were composed by the agent from the captured output below; the fenced
blocks are verbatim.

## Toolchain and commit

Command:

```powershell
$f = "qa/windows/phase-2/00-host.md"; & { Get-Date -Format "o"; git rev-parse HEAD; node -v; pnpm -v; git --version; "$([System.Environment]::OSVersion.Version)"; (Get-Command node).Source; "pwsh $($PSVersionTable.PSVersion)" } 2>&1 | Tee-Object -Append $f; "EXIT=$LASTEXITCODE" | Tee-Object -Append $f
```

Output:

```
2026-09-15T00:06:25.7455638+03:00
7d0603bb4777132efd0e122ffc6d8064105333be
v22.19.0
9.15.0
git version 2.52.0.windows.1
10.0.26200.0
C:\nvm4w\nodejs\node.exe
pwsh 7.6.6
EXIT=0
```

Differences from the Phase 1 gate host block: the commit (`7d0603bb4` instead of `203acb273` /
`c3e4a8590`) and the PowerShell build (`7.6.6` instead of `7.6.5`, a host-side update between the two
gates). Node, pnpm, git, the OS build and the node install location are identical.

## Branch and base

```
git rev-parse --abbrev-ref HEAD  -> windows-native/phase-2
git rev-parse HEAD               -> 7d0603bb4777132efd0e122ffc6d8064105333be
git merge-base HEAD windows-native/phase-1 -> 07fdce05b (Phase 1 head)
```

The pre-existing-failure comparison in `31-test-results.md` is made against a **separate worktree** checked
out at `07fdce05b` under the agent scratchpad (`git worktree add <scratchpad>/p1-base 07fdce05b`, then
`pnpm install --offline` in it). The main checkout was never stashed and never had its HEAD moved; the
worktree was removed at the end of the gate.

## Scratch repositories and data directories used by this gate

| path | step | disposition |
|---|---|---|
| `C:\Users\olege\Work\phase2-hook` | 4 (hook stream/cancel) | created, then deleted (`Test-Path … : False`) |
| `C:\Users\olege\Work\phase2 open targets` | 8 (open targets, spaced path) | created, then deleted |
| `C:\Users\olege\Work\bb space test` | 9 (`bb` from PowerShell) | created, then deleted |
| `C:\Users\olege\AppData\Local\Temp\bb-p2-telemetry-*`, `bb-p2-cyr-*` | 6 (secret ACL) | created, then deleted (0 remaining) |
| `C:\Users\olege\Work\bb-p1-base` | 3 (base comparison) | worktree at `07fdce05b`, removed |

`C:\Users\olege\.bb-dev\phase2-secrets-qa` was **never created**: `pnpm dev:app` ignores `BB_DATA_DIR` and
derives its own per-checkout instance directory (`22-secret-acl.md` records this).

### The base worktree had to move

`git worktree add <scratchpad>/p1-base 07fdce05b` plus `pnpm install --offline` succeeded, but **every**
package's vitest run then died before starting:

```
TypeError [ERR_PACKAGE_IMPORT_NOT_DEFINED]: Package import specifier "#module-sync-enabled" is not defined
imported from …\scratchpad\p1-base\node_modules\.pnpm\vite@8.0.12_@types+node@22.19.10_esbuild@0.28.1_jiti@2.7.0_terser@5.50.0_tsx@4.23.1_yaml@2.9.0\node_modules\vite\dist\node\chunks\node.js
```

`vite`'s `package.json` in that store entry **does** define `#module-sync-enabled` (read back and compared
byte-for-byte with the main checkout's copy — identical). The failure is Windows `MAX_PATH`: the scratchpad
prefix alone is 118 characters and the importing module's full path exceeds 260, so Node's walk-up for the
nearest `package.json` silently finds nothing and reports the specifier as undefined. The worktree was moved
to a short path and reinstalled:

```bash
git worktree move <scratchpad>/p1-base C:/Users/olege/Work/bb-p1-base   # EXIT=0
```
```powershell
pnpm install --offline --config.confirmModulesPurge=false   # the plain form stops at an interactive purge prompt
pnpm exec turbo run build --output-logs=errors-only          # Tasks: 55 successful, 55 total
```

after which the base ran normally. Removed at the end of the gate:

```powershell
Remove-Item -Recurse -Force "C:\Users\olege\Work\bb-p1-base"   # Test-Path: False
git worktree prune                                             # PRUNE_EXIT=0
git worktree list                                              # C:/Users/olege/Work/bb  7d0603bb4 [windows-native/phase-2]
```

The main checkout was never stashed and its HEAD never moved.

## Dev instance state left behind

- `pnpm dev:stop` was run at the end: `[dev-app] desktop: not running`, `[dev-app] dev server: stopped`,
  `EXIT_STOP=0`.
- The `phase2-hook` project row (`proj_ffz6bbwjau`) is **left in the dev database**; its source directory no
  longer exists. `bb project delete` was attempted but the dev server had already stopped, and the CLI
  correctly refused the destructive action without an interactive terminal. Phase 1 left its QA project rows
  the same way.
- Thread `thr_kwxi54ybzq` was archived and its environment `env_ug3v639xg4` deleted; the managed worktree
  directory is gone and `git worktree list` in the source repo showed no stale registration
  (`20-hook-stream-timeout-cancel.md`).
- Desktop left as found: the Explorer window opened for Step 8 was closed with `Shell.Application`'s
  `Quit()`, the two Windows Terminal tabs opened for Step 8 were closed with `taskkill /F`, and Zed was
  closed with `taskkill /F`. Final checks: zero Explorer windows, zero `zed.exe`, zero `-NoLogo` consoles,
  and the Terminal back to the two tabs it had before.
