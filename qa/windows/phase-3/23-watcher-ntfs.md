# The file watcher on NTFS (Phase 3 gate, Step 7)

Host and dev instance: `00-host.md`. Project `proj_3rgx8gdtjn` (`phase3-codex`, Step 5) with its thread's
managed worktree `env_a4dvmgf8pk` open in the running dev instance. Every mutation was made from a
**separate** `powershell -NoProfile` process, never from the daemon, and observed through the server's own
listing — never by re-reading the directory and calling that "the app noticed".

## Result

| event | observed by bb | latency |
|---|---|---|
| `Set-Content …\watched.txt "x"` (create) | `watched.txt` appears in `bb project files` | **683 ms** |
| `Rename-Item watched.txt → WATCHED.TXT` (case-only rename) | listing flips to `WATCHED.TXT`, the lower-case name is gone | **644 ms** |

No refresh command, no restart, no cache bust: the polling loop only re-ran `bb project files`, which the
server answers from the watcher-backed workspace index.

## Baseline

```powershell
node apps/cli/dist/index.js project files proj_3rgx8gdtjn --environment env_a4dvmgf8pk --json
```
```json
{"files":[{"path":"codex-phase3.txt","name":"codex-phase3.txt"},
          {"path":"README.md","name":"README.md"}],"truncated":false}
FILES_EXIT=0
```

## Create, from another PowerShell

```powershell
powershell -NoProfile -Command "Set-Content -Path 'C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_h5ki6k5nuf-1\phase3-codex\watched.txt' -Value 'x'"
```
```
SETCONTENT_EXIT=0
SAW_WATCHED_TXT=True AFTER_MS=683
```
```json
{"files":[{"path":"codex-phase3.txt","name":"codex-phase3.txt"},
          {"path":"README.md","name":"README.md"},
          {"path":"watched.txt","name":"watched.txt"}],"truncated":false}
```

## Case-only rename, from another PowerShell

This is the NTFS case that a case-sensitive watcher gets wrong: `watched.txt` and `WATCHED.TXT` are the
same file to the filesystem, so a naive index keeps both, or keeps the stale spelling.

```powershell
powershell -NoProfile -Command "Rename-Item -Path '…\watched.txt' -NewName 'WATCHED.TXT' -Force"
```
```
RENAME_EXIT=0
SAW_WATCHED_UPPER=True AFTER_MS=644
```
```json
{"files":[{"path":"codex-phase3.txt","name":"codex-phase3.txt"},
          {"path":"README.md","name":"README.md"},
          {"path":"WATCHED.TXT","name":"WATCHED.TXT"}],"truncated":false}
```

The match was tested with `-cmatch` (case-**sensitive**), so `SAW_WATCHED_UPPER=True` means the listing
really carries the upper-case spelling, and the absence of a second entry means the lower-case one was
retired rather than duplicated. On-disk truth agrees:

```powershell
cmd /c "dir /b C:\Users\olege\.bb-dev\…\thr_h5ki6k5nuf-1\phase3-codex"
```
```
codex-phase3.txt
README.md
WATCHED.TXT
```

## What this confirms, and what it does not

- Confirms the Task 9 behaviour on a real running instance: watcher matching on win32 is case-insensitive
  and event paths have their `\\?\` / `\\.\` prefixes stripped, so a case-only rename resolves to the same
  watched entry and the index adopts the new spelling.
- Latency here (683 ms / 644 ms) is **poll-loop resolution**, not watcher latency: the loop asked every
  250 ms and `bb project files` itself costs ~150–400 ms. It is consistent with, and bounded below by, the
  Task 10 real-host follow latency of 2–21 ms; this step does not re-measure that.
- The Task 9 real NTFS test (`pnpm exec turbo run test --filter=@bb/host-watcher`, passed 2/2) remains the
  fine-grained evidence. In this gate's full Windows run `@bb/host-watcher` **passed** (9 files / 74 tests,
  1 skipped) while it **failed** at the `9a07e6994` baseline — see `31-test-results.md`.
- Known limitation, unchanged and documented in `docs/platform-windows.md`: extended-length **watch roots**
  (a root spelled `\\?\C:\…`) are not supported, because `watchPathRoot` resolves the root with
  `path.resolve`. Only event paths are prefix-stripped.
