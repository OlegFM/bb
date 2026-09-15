# Junctions: remove, move and substitution refused with the target untouched (Phase 2 gate, Step 7)

Commit `7d0603bb4777132efd0e122ffc6d8064105333be`, node v22.19.0, the reference Windows desktop
(`00-host.md`). Raw capture: `23-junctions.txt`.

## Command and output

```powershell
pnpm --filter @bb/host-daemon exec vitest run src/command-handlers/path-mutations.test.ts --reporter=verbose 2>&1 | Tee-Object qa/windows/phase-2/23-junctions.txt; "EXIT=$LASTEXITCODE" | Tee-Object -Append qa/windows/phase-2/23-junctions.txt
```
```
 RUN  v4.1.1 C:/Users/olege/Work/bb/apps/host-daemon

 ✓ |@bb/host-daemon| src/command-handlers/path-mutations.test.ts > confined host path mutations > creates, moves, and removes paths beneath the declared root 64ms
 ✓ |@bb/host-daemon| src/command-handlers/path-mutations.test.ts > confined host path mutations > creates missing parent directories when recursive is enabled 10ms
 ✓ |@bb/host-daemon| src/command-handlers/path-mutations.test.ts > confined host path mutations > removes empty directories non-recursively and requires recursive for non-empty directories 14ms
 ✓ |@bb/host-daemon| src/command-handlers/path-mutations.test.ts > confined host path mutations > rejects symlink escapes and refuses to remove the declared root 20ms
 ✓ |@bb/host-daemon| src/command-handlers/path-mutations.test.ts > confined host path mutations > junctions > refuses to remove a file reached through a junction that leaves the root 14ms
 ✓ |@bb/host-daemon| src/command-handlers/path-mutations.test.ts > confined host path mutations > junctions > refuses to move a junction and leaves its target untouched 13ms
 ✓ |@bb/host-daemon| src/command-handlers/path-mutations.test.ts > confined host path mutations > junctions > refuses a junction substituted for a working directory and removes only the resolved path when the junction stays inside the root 26ms
 ✓ |@bb/host-daemon| src/command-handlers/path-mutations.test.ts > confined host path mutations > does not overwrite a move destination 23ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  08:35:55
   Duration  6.73s (transform 3.13s, setup 0ms, import 6.01s, tests 189ms, environment 0ms)

EXIT=0
```

**All eight pass**, including the three `junctions` cases the gate bullet names.

## What each junction case asserts

These are real NTFS junctions created by the tests themselves (`fs.symlink(target, link, "junction")`), not
mocks. The cases assert the target is untouched rather than the evidence being re-derived by hand
afterwards:

| case | refusal | target check inside the test |
|---|---|---|
| `refuses to remove a file reached through a junction that leaves the root` | the remove is rejected because the resolved real path escapes the declared root | the file behind the junction still exists and its contents are unchanged after the refusal |
| `refuses to move a junction and leaves its target untouched` | the move is rejected rather than relocating the reparse point | the junction's target directory and its contents are asserted present and unchanged; the junction itself still points where it did |
| `refuses a junction substituted for a working directory and removes only the resolved path when the junction stays inside the root` | a junction swapped in for a working directory does not let the removal follow it outside the root | the escaping substitution is refused with the outside target intact; when the junction resolves to a path that **is** inside the root, only that resolved path is removed — the junction is not followed to delete anything beyond it |

The surrounding non-junction cases matter for the same bullet: `rejects symlink escapes and refuses to
remove the declared root` shows the same confinement for ordinary symlinks and for the root itself, and
`does not overwrite a move destination` shows the move path refuses to clobber.

## Skill junction link (`plugins/provider-claude-code`)

The addenda adds the skill-directory junction that `skill-plugins.ts` creates on win32. Appended to the same
raw capture:

```powershell
pnpm --filter bb-plugin-provider-claude-code exec vitest run src/bridge/__tests__/skill-plugins.test.ts --reporter=verbose
```
```
 ✓ |bb-plugin-provider-claude-code| src/bridge/__tests__/skill-plugins.test.ts > claude skill plugins > assembles a plugin whose skills directory links to the generic root 27ms
 ✓ |bb-plugin-provider-claude-code| src/bridge/__tests__/skill-plugins.test.ts > claude skill plugins > passes the junction link type on win32 and the dir type off win32 16ms
 ✓ |bb-plugin-provider-claude-code| src/bridge/__tests__/skill-plugins.test.ts > claude skill plugins > links the skills directory as a junction on Windows 27ms
 ↓ |bb-plugin-provider-claude-code| src/bridge/__tests__/skill-plugins.test.ts > claude skill plugins > links the skills directory as a directory symlink off Windows
 ✓ |bb-plugin-provider-claude-code| src/bridge/__tests__/skill-plugins.test.ts > claude skill plugins > is idempotent for a root and re-points the link when the root moves 27ms
 ✓ |bb-plugin-provider-claude-code| src/bridge/__tests__/skill-plugins.test.ts > claude skill plugins > keeps the stable name across catalog changes and suffixes only a colliding second root 52ms

 Test Files  1 passed (1)
      Tests  5 passed | 1 skipped (6)
   Duration  592ms
EXIT_SKILL=0
```

- `links the skills directory as a junction on Windows` is `it.runIf(process.platform === "win32")` and
  **ran and passed here** — it creates the link for real and reads the reparse point back.
- `passes the junction link type on win32 and the dir type off win32` asserts the platform split without
  touching the filesystem (`["junction", "dir"]`), which is what keeps the POSIX arm byte-identical.
- The `↓` case is its POSIX-only twin, correctly skipped on win32.
- `is idempotent for a root and re-points the link when the root moves` covers the re-link path, which is
  the one that would otherwise strand an old junction.

## Package context

`src/command-handlers/path-mutations.test.ts` is **not** among `@bb/host-daemon`'s failing files in either
the Step 3 full-load run or the solo run (`31-test-results.md`), and it was not failing at the Phase 1 base
either — so the junction behaviour is green with no pre-existing noise to discount.

## Gate bullet

> "junction remove, move and substitution are refused with the target untouched"

**PASS.** Three junction refusal cases pass against real NTFS junctions, each asserting the target survives,
plus the win32 skill-junction link case.
