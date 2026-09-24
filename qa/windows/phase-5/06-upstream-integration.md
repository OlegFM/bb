# Upstream integration, 2026-09-24

Native Windows remains **beta**. This integrates upstream
`71bd54e9eb484e7b8e561f354f2c1d66dc13a975` with Windows branch head
`0342032bf354832fd53b25e804ab1c611e48dd2f`, retaining both histories.
The merge began with 128 conflicting paths and was resolved in an isolated
worktree. The upstream contribution remains pending maintainer approval.

## Integration changes

- Retained upstream machine providers, enrollment, server move, Desktop window
  architecture and provider lifecycle while adapting the native Windows port.
  Host daemon protocol is 218, above upstream 217, for Windows wire fields.
- Preserved upstream database migrations through 0130 and generated migration
  0131 for canonical host paths. A narrowly identified legacy Windows migration
  is repaired transactionally; real SQLite tests cover retained keys, current
  upstream databases and rollback on a conflicting path claim.
- Added the Windows enrollment command to the server contract, SDK, CLI
  `bb machine create --provider manual --shell powershell` and pairing UI.
  Connect forwards the authenticated PowerShell installer route. Bootstrap JSON
  uses ASCII escapes so Windows PowerShell 5.1 preserves Unicode values.
- Preserved private Windows ACLs during enrollment, managed JSON replacement,
  browser credential output and server export, including Unicode filenames.
  The native file lock also works in Desktop's CommonJS bundle.
- Corrected native Git path comparisons and provider pipe shutdown on Windows.
  Tests use native command shims and Windows process semantics where POSIX
  fixtures cannot execute; platform-specific skips remain explicit.
- Server move rewrites server-owned plugin paths between Windows and POSIX
  roots. Host-owned project and workspace paths are not rewritten. Automatic
  adoption as a background service remains macOS/Linux only; Windows Desktop
  keeps the moved runtime connected while the app stays open.

## Verification

Runs used native Windows, Node 22.19.0 and pnpm 9.15.0. Tests used isolated
HOME/USERPROFILE, Git, npm and credential configuration, with one worker per
suite. Native SQLite, PTY and watcher modules were prepared before verification.
No live user profile, provider account or desktop GUI was used.

Test orchestration used `pnpm exec turbo run test --filter=<package>
--env-mode=loose -- --maxWorkers=1`, adding file selectors for focused runs.
After generated dependencies were built, selected reruns used Turbo `--only`
to avoid rebuilding shared generated modules during another suite. Private
logs are under `.superpowers/upstream-integration-2026-09-23/`; this document
records portable results without committing those transcripts.

| Selection                                          | Passed | Skipped | Evidence                                          |
| -------------------------------------------------- | -----: | ------: | ------------------------------------------------- |
| Full CLI                                           |    845 |      26 | `cli-full-final.log`                              |
| Full Desktop                                       |    499 |      12 | `desktop-full-final.log`                          |
| App enrollment, layout and caption tests, 12 files |    131 |       0 | `app-desktop-focused.log`                         |
| Full ACP provider bridge                           |    358 |       2 | `acp-fixture-full-final.log`                      |
| Full Codex provider                                |    333 |       1 | `codex-full-final.log`                            |
| Full Pi provider                                   |    189 |       1 | `packages-native.log`, Pi task passed             |
| Full provider bridge protocol                      |    290 |       5 | `protocol-final.log`                              |
| Full plugin build                                  |    151 |       1 | `plugin-build-final.log`                          |
| Full process utilities                             |    107 |      14 | `process-protocol-final.log`, process task passed |
| Full DB, including final Unicode reroot            |    613 |       0 | `db-integrated-complete.log`                      |
| Full config before additional CJS regression       |    119 |       0 | `host-config-repair.log`                          |
| CJS file lock contention, timeout and release      |      1 |       0 | `host-config-cjs-lock.log`                        |
| Worktree adoption, path and listing tests          |     64 |       1 | `host-worktree-final.log`                         |
| Daemon runtime and terminal repair, 3 files        |    152 |       4 | `host-daemon-repair.log`                          |
| Daemon server move and command dispatch, 2 files   |     64 |       0 | `daemon-move-dispatch-final.log`                  |
| Managed JSON concurrency and crash behavior        |     30 |       1 | `host-managed-json-final.log`                     |
| Full local open targets                            |     87 |       1 | `packages-native.log`, open-target task passed    |
| Full host daemon contract                          |     65 |       0 | `packages-native.log`, contract task passed       |
| Full Desktop contract                              |     23 |       0 | `packages-native.log`, contract task passed       |
| Connect worker                                     |     78 |       0 | `connect-green.log`                               |

Automations coverage combines its eight-file run (118 passed, one failed,
one skipped) with the corrected entire harness file (25 passed): all 119
applicable cases pass across those runs. Host workspace coverage combines the
nine-file run (176 passed, one failed, seven skipped) with both interactive
fetch tests passing after fixture isolation was corrected. These are combined
results, not claims that the earlier commands exited successfully.

Final integrated typecheck passed **30/30 Turbo tasks**, exit 0
(`types-integrated-complete.log`). The selection covered app, CLI, server,
Desktop, daemon, SDK and contracts; config, DB, process/workspace/watcher,
secret storage, plugin build/API map, test helpers, ACP/protocol and affected
Git worktree, automations, GitHub, Codex and Pi plugins. The generated
prerequisites had already been built. Frozen offline lockfile verification
passed for all 102 workspace projects (`lock-frozen-check.log`).

The full server run (`server-core-2.log`) completed 304 files with **3,138
passed, seven failed and 42 skipped**, exit 1. The attempted CLI exclusion did
not apply to Vitest's projects: all 46 Windows installer cases ran in that
command. Its seven failures were corrected as follows:

- Two PowerShell 5.1 diagnostic assertions split words at console line wraps.
  The tests normalize line breaks; the installer behavior was already correct.
  The complete installer file then passed **46/46** in PowerShell 5.1 and 7,
  exit 0 (`install-machine-powershell-full-final.log`).
- Two files asserted POSIX mode bits on Windows; they now inspect real private
  Windows ACLs and retain POSIX checks. Complete affected files passed 8/8 and
  2/2 (`environment-storage-windows-acl.log`,
  `public-machine-environment-windows-acl.log`).
- The server-move switch test had the same mode-bit assumption. Its complete
  file passed 6/6 (`server-move-switch-windows-acl.log`).
- Two environment-directory tests expected obsolete error wording. Upstream's
  managed-storage refusal remains intact; the complete file passed 7/7
  (`host-server-environment-directory-final.log`).

This is combined coverage after focused repairs, not a claim that the earlier
full-server command exited successfully. The final DB run passed **613/613**,
including real SQLite Unicode path matching and case-preserving normalization.
The complete pending-boot file passed **16/16**, including the corresponding
snapshot registration regression (`pending-boot-full-final.log`). Both Unicode
regressions failed before their fixes. Independent review checked these fixes,
Windows worktree identity, CommonJS lock packaging and provider EOF handling.
Server typecheck passed again after the final test repairs
(`types-server-post-tests.log`). The full server's 42 skips comprise 39 POSIX
shell installer cases, one POSIX enrollment command, one POSIX plugin-settings
mode test and one optional provider-corpus test.

Scoped Oxlint over 206 resolved or subsequently edited source files exited 1
with 153 errors and three React warnings (`lint-integrated.log`). All 147
comment diagnostics refer to unchanged comment text already present at upstream
`71bd54e9e`; the other six flag filesystem imports also present in the same
upstream files. The upstream lint debt remains; no lint-clean result is claimed.
The new semantic declaration reference is accepted by the existing rule.

Final integrated build passed **53/53 Turbo tasks**, exit 0, in 2m59s
(`build-integrated-final.log`):

```powershell
pnpm.cmd exec turbo run build --filter=@bb/scripts --filter=@bb/app --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli --filter=bb-app --filter=@bb/desktop --concurrency=2 --continue=always --env-mode=loose --output-logs=new-only
```

The final Desktop bundle has no empty `import.meta` warning. The app build
retains its chunk-size and bundler deprecation warnings. Formatting of the
resolved and subsequently edited files and `git diff --check` passed. No
unresolved merge index entries or conflict markers remain.

## Limits

This is merged-tree local regression evidence, not complete macOS/Windows
feature parity or a full monorepo test run. It does not establish clean-machine
installation, actual logon persistence, live Connect/provider/browser sessions,
signed release acceptance, same-head external CI, or a macOS run. Tests affected
by the overnight system suspension were rerun; their elapsed times are not
performance evidence. Existing Phase 5 external acceptance gates remain open.
The native worktree fixture uses an 80-character source repository name and
checks the derived-name cap separately; it does not establish arbitrary paths
beyond Windows/Git path-length limits.
