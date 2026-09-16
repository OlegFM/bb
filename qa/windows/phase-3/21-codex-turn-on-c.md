# A real Codex turn on a `C:\` project (Phase 3 gate, Step 5)

Host, dev instance and provider health: `00-host.md`. Raw transcript: `21-codex-turn-on-c.txt`.
Codex CLI `codex-cli 0.153.4` at `C:\Users\olege\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`.
This is a **real provider turn**, run once, as gate evidence only (R25).

## Result

| step | outcome |
|---|---|
| `git init C:\Users\olege\Work\phase3-codex` + one commit | `GIT_INIT_EXIT=0`, `GIT_COMMIT_EXIT=0`, `d140794 Seed the gate scratch repo` |
| `bb project create` | `proj_3rgx8gdtjn`, source `C:\Users\olege\Work\phase3-codex` on `host_45kqba73eq`, `PROJECT_EXIT=0` |
| `bb thread spawn --provider codex --permission-mode accept-edits` | `thr_h5ki6k5nuf`, `SPAWN_EXIT=0` |
| environment provisioned | managed git worktree `env_a4dvmgf8pk`, branch `bb/create-codex-phase-three-file-thr_h5ki6k5nuf` |
| turn completed | `Worked for (18s)`, assistant: "Created `codex-phase3.txt` containing `codex wrote this`." |
| file on disk | present, **16 bytes**, contents `codex wrote this` |
| `bb thread show --git-diff` | `A codex-phase3.txt`, `1 file changed, 1 insertion(+)` |

## Commands and output

```powershell
git init C:\Users\olege\Work\phase3-codex        # GIT_INIT_EXIT=0
git -c user.name=Gate -c user.email=… commit -m "Seed the gate scratch repo"   # GIT_COMMIT_EXIT=0
git log --oneline -1
```
```
d140794 Seed the gate scratch repo
```

```powershell
node apps/cli/dist/index.js project create --name phase3-codex --root C:\Users\olege\Work\phase3-codex --machine host_45kqba73eq --json
```
```json
{"id":"proj_3rgx8gdtjn","kind":"standard","name":"phase3-codex",
 "sources":[{"id":"src_jdgic2fwvb","type":"local_path","hostId":"host_45kqba73eq",
             "path":"C:\\Users\\olege\\Work\\phase3-codex","isDefault":true}]}
PROJECT_EXIT=0
```

The project source path is stored drive-absolute with backslashes, exactly as typed.

```powershell
node apps/cli/dist/index.js thread spawn --project proj_3rgx8gdtjn --provider codex --permission-mode accept-edits `
  --prompt "Create a file named codex-phase3.txt containing the text 'codex wrote this'." --json
```
```json
{"id":"thr_h5ki6k5nuf","projectId":"proj_3rgx8gdtjn","providerId":"codex","status":"starting", …}
SPAWN_EXIT=0
```

```powershell
node apps/cli/dist/index.js thread wait thr_h5ki6k5nuf --status idle --timeout 300 --json
```
```json
{"threadId":"thr_h5ki6k5nuf","matched":true,"target":{"kind":"status","status":"idle"}}
WAIT_EXIT=0
```

### `thread wait --status idle` can match before the turn starts

`WAIT_EXIT=0` returned at `02:31:37`, ~11 s after the spawn, while the log still held only the
provisioning block — the thread is briefly `idle` between "provisioned" and "turn running". The turn itself
finished at `02:31:57`. Every assertion below was therefore taken from a **later** read, not from the wait.
Recorded because the brief's Step 5 shape (`spawn` → `wait --status idle` → assert the file) is racy on its
own; a later gate should also wait for an assistant event.

## The turn

```powershell
node apps/cli/dist/index.js thread log thr_h5ki6k5nuf --all
```
```
── User ────────────────────────────────────────────────────
Create a file named codex-phase3.txt containing the text 'codex wrote this'.

── Provisioned thread ──────────────────────────────────────
  Preparing workspace
  Generating title
  Generated title (3s)
  Preparing Worktree…
  Creating worktree
  HEAD is now at d140794 Seed the gate scratch repo
  Preparing worktree (new branch 'bb/create-codex-phase-three-file-thr_h5ki6k5nuf')
  Created worktree
  Using workspace: C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_h5ki6k5nuf-1\phase3-codex
  Using branch: bb/create-codex-phase-three-file-thr_h5ki6k5nuf (d140794)
  Provisioned thread (4s)

── Worked for (18s) ────────────────────────────────────────

── Assistant ───────────────────────────────────────────────
Created `codex-phase3.txt` containing `codex wrote this`.

LOG_EXIT=0
```

Codex ran natively: `codex.exe app-server` was resolved and spawned by the win32 arm of
`resolveCodexAppServerLaunch`, the worktree was created by native `git worktree add` on `C:\`, and the
agent wrote through the daemon's workspace path — all without WSL.

## The file the agent wrote

The thread ran in its managed worktree, not in the project root, so the file lands there:

```powershell
$wt = "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_h5ki6k5nuf-1\phase3-codex\codex-phase3.txt"
Test-Path $wt; Get-Content $wt -Raw; (Get-Item $wt).Length
```
```
EXISTS=True
codex wrote this
BYTES=16
```

```powershell
node apps/cli/dist/index.js thread show thr_h5ki6k5nuf --git-diff
```
```
Thread: thr_h5ki6k5nuf
  Status: idle
  Title: Create Codex phase three file
  Project: proj_3rgx8gdtjn
  Environment: Worktree (env_a4dvmgf8pk)
    Pull request: unavailable
      gh pr view failed: no git remotes found

Git diff:
  Files:
A	codex-phase3.txt
  Summary: 1 file changed, 1 insertion(+)

diff --git a/codex-phase3.txt b/codex-phase3.txt
new file mode 100644
index 0000000..39bd543
--- /dev/null
+++ b/codex-phase3.txt
@@ -0,0 +1 @@
+codex wrote this
\ No newline at end of file

GITDIFF_EXIT=0
```

"Pull request: unavailable — gh pr view failed: no git remotes found" is correct: the scratch repo has no
remote. It is reported, not swallowed.
