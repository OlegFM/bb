# A real Claude Code turn on a `C:\` project (Phase 3 gate, Step 6)

Host, dev instance and provider health: `00-host.md`. Raw transcript: `22-claude-code-turn-on-c.txt`.
Claude Code CLI `2.1.272` at `C:\Users\olege\.local\bin\claude.exe`.
This is a **real provider turn**, run once, as gate evidence only (R25).

## Result

| step | outcome |
|---|---|
| `git init C:\Users\olege\Work\phase3-claude` + one commit | `GIT_INIT_EXIT=0`, `GIT_COMMIT_EXIT=0`, `307f02e Seed the gate scratch repo` |
| `bb project create` | `proj_9rsnc6twn3`, source `C:\Users\olege\Work\phase3-claude`, `PROJECT_EXIT=0` |
| `bb thread spawn --provider claude-code --permission-mode accept-edits` | `thr_7cfygzpgsw`, `SPAWN_EXIT=0` |
| environment provisioned | managed git worktree `env_wiifjku6zd`, branch `bb/create-claude-phase-3-file-thr_7cfygzpgsw` |
| turn completed | `Worked for (8s)`, assistant confirmed the write |
| file on disk | present, **23 bytes**, contents `claude-code wrote this` |
| `bb thread show --git-diff` | `A claude-phase3.txt`, `1 file changed, 1 insertion(+)` |

## The R14 contingency was not needed

Task 7 flagged that `resolveClaudeCodeExecutable` on win32 may return a `.cmd` (the npm-global install
shape) that the Claude Agent SDK cannot spawn, and the brief's Step 6 carried the contingency: implement
`spawnClaudeCodeProcess` on win32 and re-run.

On this host `claude` resolves to a **native PE**, `C:\Users\olege\.local\bin\claude.exe` (`00-host.md`),
so the Agent SDK spawned it directly and the turn succeeded on the first attempt. **No contingency commit
was made**, and `docs/platform-windows.md`'s statement — "The Claude Agent SDK spawns the resolved
`claude.exe` itself; bb installs its own `spawnClaudeCodeProcess` only when provider-bridge recording is
on" — is consistent with what was measured.

What this gate therefore does **not** prove: the npm-global `.cmd` install shape. A host whose Claude Code
came from `npm i -g @anthropic-ai/claude-code` is untested here; the risk Task 7 named is still open for
that shape.

## Commands and output

```powershell
node apps/cli/dist/index.js project create --name phase3-claude --root C:\Users\olege\Work\phase3-claude --machine host_45kqba73eq --json
```
```json
{"id":"proj_9rsnc6twn3","kind":"standard","name":"phase3-claude",
 "sources":[{"id":"src_7mv2nz2pxp","type":"local_path","hostId":"host_45kqba73eq",
             "path":"C:\\Users\\olege\\Work\\phase3-claude","isDefault":true}]}
PROJECT_EXIT=0
```

```powershell
node apps/cli/dist/index.js thread spawn --project proj_9rsnc6twn3 --provider claude-code --permission-mode accept-edits `
  --prompt "Create a file named claude-phase3.txt containing the text 'claude-code wrote this'." --json
```
```json
{"id":"thr_7cfygzpgsw","providerId":"claude-code","status":"starting", …}
SPAWN_EXIT=0
```

```powershell
node apps/cli/dist/index.js thread wait thr_7cfygzpgsw --status idle --timeout 300 --json
```
```json
{"threadId":"thr_7cfygzpgsw","matched":true,"target":{"kind":"status","status":"idle"}}
WAIT_EXIT=0
```

```powershell
node apps/cli/dist/index.js thread log thr_7cfygzpgsw --all
```
```
── User ────────────────────────────────────────────────────
Create a file named claude-phase3.txt containing the text 'claude-code wrote this'.

── Provisioned thread ──────────────────────────────────────
  Preparing workspace
  Generating title
  Generated title (3s)
  Preparing Worktree…
  Creating worktree
  HEAD is now at 307f02e Seed the gate scratch repo
  Preparing worktree (new branch 'bb/create-claude-phase-3-file-thr_7cfygzpgsw')
  Created worktree
  Using workspace: C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_7cfygzpgsw-1\phase3-claude
  Using branch: bb/create-claude-phase-3-file-thr_7cfygzpgsw (307f02e)
  Provisioned thread (4s)

── Worked for (8s) ─────────────────────────────────────────

── Assistant ───────────────────────────────────────────────
Created [claude-phase3.txt](C:\Users\olege\.bb-dev\…\thr_7cfygzpgsw-1\phase3-claude\claude-phase3.txt) with the text `claude-code wrote this`.
…
- The file landed in the **worktree** copy of the repo, not `C:\Users\olege\Work\phase3-claude` …

LOG_EXIT=0
```

## The file the agent wrote

```powershell
$wt = "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_7cfygzpgsw-1\phase3-claude\claude-phase3.txt"
Test-Path $wt; Get-Content $wt -Raw; (Get-Item $wt).Length
```
```
EXISTS=True
claude-code wrote this
BYTES=23
```

```powershell
node apps/cli/dist/index.js thread show thr_7cfygzpgsw --git-diff
```
```
Git diff:
  Files:
A	claude-phase3.txt
  Summary: 1 file changed, 1 insertion(+)

diff --git a/claude-phase3.txt b/claude-phase3.txt
new file mode 100644
index 0000000..2d7ba6a
--- /dev/null
+++ b/claude-phase3.txt
@@ -0,0 +1 @@
+claude-code wrote this

SHOW_EXIT=0
```

## Daemon trace

The daemon fetched and cached the Claude Code bridge host artifact for the turn, on Windows paths:

```
[02:32:23] DEBUG: [host-daemon] Downloading host artifact {"cacheDir":"C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugin-host-artifacts\provider-claude-code","digest":"fa1522310bd63f8b…"}
[02:32:31] DEBUG: [host-daemon] Using cached host artifact {"cacheDir":"C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugin-host-artifacts\provider-claude-code","digest":"fa1522310bd63f8b…"}
```

No secret or credential content was read or printed at any point.
