# Host facts (Phase 3 gate, Task 14)

Machine: the same reference Windows desktop used for Phase 0, Phase 1 and Phase 2
(`qa/windows/phase-0/00-host.md`, `phase-1/00-host.md`, `phase-2/00-host.md`) — Windows 11 Pro,
OS version `10.0.26200.0`, node from `C:\nvm4w\nodejs`. Branch `windows-native/phase-3`, stacked on
`windows-native/phase-2` (`9a07e6994`).

Every command in this gate was run in a single shell, and the `EXIT=` line after each block is
`$LASTEXITCODE` (PowerShell) or `$?` (Git Bash) read in that same shell immediately after the command.
The header and prose in this file were composed by the agent from the captured output below; the fenced
blocks are verbatim.

## Commits measured

| commit | what it is |
|---|---|
| `05138a11e` | code head the final whole-branch review approved; measured by `30-build-typecheck.txt` and CI run 1 |
| `c3a02ba15` | gate fix 1 (Codex install guidance on Windows); measured by the full test run in `31-test-results.md` |
| `fd84ca436` | gate fix 2 (daemon app test expects the Windows provider `Path` key) |
| `e5d59dc7e` | gate fix 3 (tarball smoke cleanup retry + launcher log diagnostics) |
| `72605c433` | gate fix 4 (CI wiring: workspace-local temp root for the Windows tarball smoke); POSIX check and CI run 4 measure this |
| `9a07e6994` | Phase 2 tip, the regression baseline; checked out in a **separate worktree** at `C:\Users\olege\Work\bb-p2-base` (`git worktree add`, then `pnpm install --offline --config.confirmModulesPurge=false`). The main checkout was never stashed and its HEAD never moved. |

The baseline worktree was first created under the agent scratchpad and immediately moved to
`C:\Users\olege\Work\bb-p2-base` with `git worktree move`, for the `MAX_PATH` reason Phase 2 recorded
(`qa/windows/phase-2/00-host.md`, "The base worktree had to move"). It was removed at the end of the gate.

## Toolchain and commit

Command:

```powershell
Get-Date -Format "o"; git -C C:\Users\olege\Work\bb rev-parse HEAD; git -C C:\Users\olege\Work\bb rev-parse --abbrev-ref HEAD; node -v; pnpm -v; git --version; "$([System.Environment]::OSVersion.Version)"; (Get-Command node).Source; "pwsh $($PSVersionTable.PSVersion)"; "EXIT=$LASTEXITCODE"
```

Output:

```
2026-09-16T01:03:43.4949695+03:00
05138a11e12322ef6f7110165790384a29df99f6
windows-native/phase-3
v22.19.0
9.15.0
git version 2.52.0.windows.1
10.0.26200.0
C:\nvm4w\nodejs\node.exe
pwsh 7.6.6
EXIT=0
```

Identical to the Phase 2 gate host block except for the commit: same Node, pnpm, git, OS build, node
install location and PowerShell build (`7.6.6`).

## Shells

```powershell
(Get-Command pwsh).Source; (Get-Command powershell).Source; (Get-Command cmd).Source
```
```
C:\Program Files\PowerShell\7\pwsh.exe
C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe
C:\WINDOWS\system32\cmd.exe
```

The gate's own PowerShell scripts were run with **`pwsh`**, not `powershell`: Windows PowerShell 5.1 reads
a `.ps1` without a BOM as ANSI, and the Cyrillic literal in the terminal step (`'При' + 'вет'`) then
breaks the parser mid-file. Recorded because it changes how a later gate should drive these scripts.

## Provider CLIs

```powershell
(Get-Command codex).Source; codex --version; "CODEX_EXIT=$LASTEXITCODE"
(Get-Command claude).Source; claude --version; "CLAUDE_EXIT=$LASTEXITCODE"
(Get-Command bun).Source;  bun --version;   "BUN_EXIT=$LASTEXITCODE"
```
```
codex: C:\Users\olege\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe
codex-cli 0.153.4
CODEX_EXIT=0
claude: C:\Users\olege\.local\bin\claude.exe
2.1.272 (Claude Code)
CLAUDE_EXIT=0
bun: C:\Users\olege\.bun\bin\bun.exe
1.4.0
BUN_EXIT=0
```

`claude` on this host resolves to a **native `claude.exe`**, not an npm `.cmd` shim — so the Task 7 / R14
contingency (`spawnClaudeCodeProcess` on win32) was **not needed**; the Agent SDK spawned it directly and
the real turn in `22-claude-code-turn-on-c.md` succeeded. A host whose Claude Code install is npm-global
would still hit the `.cmd` shape described in `docs/platform-windows.md`; that case is untested here.

## Auth material (existence only, never contents)

```powershell
foreach ($p in @("$env:USERPROFILE\.codex\auth.json", "$env:USERPROFILE\.claude.json", "$env:USERPROFILE\.claude\.credentials.json")) {
  "{0} exists={1} bytes={2}" -f $p, (Test-Path $p), (Get-Item $p).Length
}
```
```
C:\Users\olege\.codex\auth.json exists=True bytes=4125
C:\Users\olege\.claude.json exists=True bytes=86090
C:\Users\olege\.claude\.credentials.json exists=True bytes=2271
```

No contents were read, printed or copied anywhere in this gate.

## Dev instance and provider health

```powershell
pnpm dev:app current            # DEV_EXIT=0
pnpm --silent dev:app env --powershell | Out-String | Invoke-Expression
```
```
Repo: C:\Users\olege\Work\bb
Branch: windows-native/phase-3 (e5d59dc7e)
Node: v22.19.0 (ABI 127) at C:\nvm4w\nodejs\node.exe
Instance: work-bb-21d97a8d7c85
Data dir: C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85
App: http://localhost:15813
Server: http://127.0.0.1:23813
Host daemon: http://127.0.0.1:31813
BB_SERVER_URL=http://127.0.0.1:23813
BB_HOST_DAEMON_PORT=31813
BB_PROJECT_ID=proj_personal
```

Listeners verified directly rather than through `pnpm dev:status`:

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 15813,23813,31813 }
```
```
127.0.0.1        31813          6012
127.0.0.1        23813         13528
127.0.0.1        15813         27736
```

```powershell
node apps/cli/dist/index.js machine list --json   # MACHINE_EXIT=0
```
```json
[{"id":"host_45kqba73eq","name":"OMEN","status":"connected","type":"persistent","maxPermissionMode":"full", … }]
```

```powershell
node apps/cli/dist/index.js provider list --json   # PROVIDER_EXIT=0
```

Health for the two providers the gate drives (full output in the step files):

| provider | `available` | `maintenance.health` | `maintenance.usage` | `maintenance.installation` |
|---|---|---|---|---|
| `codex` | true | true | true | true |
| `claude-code` | true | true | true | true |
| `pi` | true | true | false | true |
| `acp-cursor` | true | true | true | true |

## Scratch repositories and data directories used by this gate

| path | step | disposition |
|---|---|---|
| `C:\Users\olege\Work\phase3-codex` | 5 (Codex turn) | created, deleted at Step 13 |
| `C:\Users\olege\Work\phase3-claude` | 6 (Claude Code turn) | created, deleted at Step 13 |
| `C:\Users\olege\.bb-phase3-test` | 8 (`npx bb-app`) | created, removed in the same script (`DATA_DIR_EXISTS=False`) |
| `C:\Users\olege\Work\bb-p2-base` | 3 (base comparison) | worktree at `9a07e6994`, removed at Step 13 |
| `%LOCALAPPDATA%\Temp\bb-shortname-probe-directory` | CI diagnosis (8.3 path probe) | created, removed |

The two project rows (`proj_3rgx8gdtjn` phase3-codex, `proj_9rsnc6twn3` phase3-claude), their threads and
their managed worktrees are **left in the dev database**, as Phases 1 and 2 left theirs.

## Cleanup (Step 13)

```powershell
pnpm dev:stop
```
```
[dev-app] desktop: not running
[dev-app] dev server: stopped
DEV_STOP_EXIT=0
```

```powershell
Get-NetTCPConnection -State Listen -LocalPort 15813,23813,31813,48886,48887
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bb-app|host-daemon|run-dev-app|start-server' }
```
```
no bb dev or tarball listeners
(no matching node.exe processes)
```

```powershell
foreach ($p in @("C:\Users\olege\Work\phase3-codex","C:\Users\olege\Work\phase3-claude","C:\Users\olege\.bb-phase3-test")) {
  Remove-Item -Recurse -Force $p; "{0} exists={1}" -f $p, (Test-Path $p)
}
```
```
C:\Users\olege\Work\phase3-codex exists=False
C:\Users\olege\Work\phase3-claude exists=False
C:\Users\olege\.bb-phase3-test exists=False
```

```bash
git worktree remove C:/Users/olege/Work/bb-p2-base --force   # deregistered; the directory needed rmdir
cmd /c "rmdir /s /q C:\Users\olege\Work\bb-p2-base"          # RMDIR_EXIT=0, EXISTS=False
git worktree prune                                           # PRUNE_EXIT=0
git worktree list
```
```
C:/Users/olege/Work/bb  72605c433 [windows-native/phase-3]
```

`git worktree remove` deregistered the worktree but refused the directory itself with
`Directory not empty` — the installed `node_modules` tree. `rmdir /s /q` removed it, and
`git worktree list` then shows only the main checkout. The main checkout was never stashed and its HEAD
never moved.

```bash
git status --short
```
```
 M docs/platform-windows.md
?? qa/windows/phase-3/
```

The only working-tree changes at the end of the gate are this evidence directory and the one
`docs/platform-windows.md` correction the gate's CI round disproved
(the secret-file ACL remedy — see `41-ci-run.md`, run 3).
