# POSIX regression check in WSL (Phase 4 gate, Steps 11 and 12)

Clone: `~/bb-posix-check` in WSL2 Ubuntu-24.04 — the same clone Phases 0–3 used.

> ## Verdict: **PASS** — no POSIX failure that is absent at `47bb778d8`, and the mac/Linux
>
> electron-builder configuration is byte-identical to the base commit's.
>
> | check                                                                                        | result                                                                                           |
> | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
> | `turbo run typecheck` (whole monorepo)                                                       | **94 successful, 94 total**, `TYPECHECK_EXIT=0`                                                  |
> | `turbo run test` for `@bb/desktop`, `bb-app`, `@bb/process-utils`, `@bb/config`              | **7 successful, 7 total**, `TESTS_EXIT=0`; `@bb/desktop` **48/48 files, 376 passed · 4 skipped** |
> | `@bb/host-daemon` `src/terminals`                                                            | **3 passed · 1 skipped (4 files), 70 passed · 6 skipped**                                        |
> | the 17 `@bb/app` test files this branch changed                                              | **17 passed (17), 181 passed (181)**                                                             |
> | `--print-config` `mac` / `linux` / `dmg` / `publish` / `files` / `asarUnpack` vs `47bb778d8` | **all six IDENTICAL**, 0 differing blocks                                                        |
> | `--print-config --mac` with a partial Azure environment                                      | exit 0, **no** `azureSignOptions`, **no** `publisherName`                                        |
>
> Zero failures of any kind on Linux at this head.

## Environment and incantation

Node is not on the guest's login PATH, and the inherited PATH carries `/mnt/c` entries where a bare
`pnpm`/`corepack` resolves to the **Windows** binary. Every command below therefore strips `/mnt/c` first,
exactly as `qa/windows/phase-2/40-posix-check.md` and `phase-3/40-posix-check.md` record. The whole check
was run as one script through `wsl -e bash <script>` **from PowerShell, not from Git Bash** — Git Bash's
MSYS path conversion rewrites a `/mnt/c/...` script argument into `C:/Program Files/Git/mnt/c/...` and the
invocation fails before `bash` ever sees it.

```bash
export PATH="$(echo "$PATH" | tr ':' '\n' | grep -v '^/mnt/c' | paste -sd:)"
source ~/.nvm/nvm.sh
nvm use 24.20.0
cd ~/bb-posix-check
```

```
=== ENV ===
2026-09-16T14:44:41+03:00
11dfe15db7d21c1f4526b23ee4762975fcd2123f
windows-native/phase-4
v24.20.0
9.15.0
Linux OMEN 6.18.33.2-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Thu Jun 18 21:54:43 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux
EXIT=0
```

The clone is at the **same commit** as the Windows checkout, `11dfe15db`. The guest runs **Node 24.20.0**
while the Windows host runs 22.19.0 — the same Node-major difference Phases 2 and 3 declared. Every
comparison below is therefore made **against the same guest at `47bb778d8`**, never against the Windows
numbers. Turbo ran at `--concurrency=4` for the reason Phase 3 recorded at length (the default concurrency
drove this WSL VM into thrashing).

## Step 12 — the POSIX suites

### Typecheck, whole monorepo

```bash
corepack pnpm exec turbo run typecheck --concurrency=4 --output-logs=new-only
```

```
 Tasks:    94 successful, 94 total
Cached:    94 cached, 94 total
  Time:    192ms >>> FULL TURBO

TYPECHECK_EXIT=0
```

`FULL TURBO` because the same 94 tasks were typechecked in this clone earlier today at this identical
commit; the cache key covers the source, so a hit is proof the inputs are unchanged, not a skipped check.

### Tests for the packages this phase touches

```bash
corepack pnpm exec turbo run test --filter=@bb/desktop --filter=bb-app --filter=@bb/process-utils --filter=@bb/config --concurrency=4 --force --output-logs=new-only
```

```
@bb/process-utils:test:  Test Files  5 passed | 1 skipped (6)
@bb/process-utils:test:       Tests  114 passed | 6 skipped (120)
@bb/config:test:  Test Files  7 passed (7)
@bb/config:test:       Tests  115 passed | 1 skipped (116)
bb-app:test:  Test Files  7 passed (7)
bb-app:test:       Tests  98 passed (98)
@bb/desktop:test:  Test Files  48 passed (48)
@bb/desktop:test:       Tests  376 passed | 4 skipped (380)

 Tasks:    7 successful, 7 total
Cached:    0 cached, 7 total
  Time:    9.355s

TESTS_EXIT=0
```

`--force` was passed so none of the four could be satisfied from cache. Two numbers are worth reading
against the Windows side of this gate:

- **`@bb/desktop`: 48 files, 376 passed, 4 skipped on Linux; 48 files, 6 failed on Windows**
  (`31-test-results.md`). The whole Windows delta is the five-file win32 baseline the phase brief names plus
  one load flake. Nothing in the package fails on Linux.
- **`bb-app`: 7 files, 98 passed on Linux; 2 files / 9 tests failing on Windows**, the known
  `index.test.ts` / `logged-process.test.ts` win32 baseline. The new `parent-watchdog.test.ts` — the file
  this phase added — passes on both.

### `@bb/host-daemon` terminals

```bash
corepack pnpm --filter @bb/host-daemon exec vitest run src/terminals
```

```
 ✓  @bb/host-daemon  src/terminals/terminal-exit-code.test.ts (3 tests) 6ms
 ✓  @bb/host-daemon  src/terminals/node-pty-fd-leak.test.ts (2 tests | 1 skipped) 72ms
 ↓  @bb/host-daemon  src/terminals/terminal-manager.win32.test.ts (5 tests | 5 skipped)
 ✓  @bb/host-daemon:isolated  src/terminals/terminal-manager.test.ts (66 tests) 489ms

 Test Files  3 passed | 1 skipped (4)
      Tests  70 passed | 6 skipped (76)

DAEMON_TERMINALS_EXIT=0
```

`terminal-manager.win32.test.ts` skipping all 5 of its tests on Linux is the standing ruling this port
follows — host-dependent tests pin `platform: "linux"` or skip off-platform rather than being rewritten.
`terminal-exit-code.test.ts`, the file that covers this phase's `-1073741510` → `null` mapping, runs and
passes on Linux, because its win32 branch is exercised through an injected platform rather than the real
one.

### The `@bb/app` files this branch changed

The list is derived from the diff rather than typed by hand:

```bash
git diff --name-only 47bb778d8 HEAD -- 'apps/app/**/*.test.ts' 'apps/app/**/*.test.tsx' | sed 's|^apps/app/||'
```

```
src/components/layout/AppLayout.plugin-panel-header.test.tsx
src/components/layout/AppLayout.root-compose-project.test.tsx
src/components/layout/AppLayout.test.tsx
src/components/layout/AppPageHeader.test.tsx
src/components/pickers/ModelReasoningPicker.test.tsx
src/components/plugin/PluginNewThreadComposer.test.tsx
src/components/secondary-panel/SecondaryPanelLayout.test.tsx
src/components/secondary-panel/ThreadSecondaryPanel.captionReserve.test.tsx
src/lib/bb-desktop.test.ts
src/lib/host-path.test.ts
src/views/RootComposeSecondaryContent.test.tsx
src/views/thread-detail/PaneMaximizeButton.test.tsx
src/views/thread-detail/ThreadArchiveCommandHandler.test.tsx
src/views/thread-detail/ThreadDetailHeader.captionReserve.test.tsx
src/views/thread-detail/ThreadDetailHeader.test.tsx
src/views/thread-detail/ThreadDetailSecondaryContent.test.tsx
src/views/thread-detail/ThreadRenameCommandHandler.test.tsx
```

```bash
corepack pnpm --filter @bb/app exec vitest run "${APP_TESTS[@]}"
```

```
 Test Files  17 passed (17)
      Tests  181 passed (181)
   Duration  16.18s

APP_CHANGED_EXIT=0
```

That covers both caption-reserve suites, both `host-path` / `bb-desktop` suites and every header and layout
suite this phase edited. A further sweep over the changed non-test sources was attempted with
`vitest run --related <sources>`; vitest 4.1.1 has no `--related` flag (`CACError: Unknown option
'--related'`), so the invocation failed before running anything and the explicit changed-file list above is
what the POSIX evidence rests on. No product code was involved in that failure.

### `package:linux` (optional in the brief)

Not attempted. The brief makes it optional because of the AppImage FUSE requirement, and it sets one hard
condition — `electron-builder-config.test.ts` must pass on POSIX. It does: it is one of the 48 `@bb/desktop`
files above, 33 tests, green, and the `--print-config` comparison below exercises the same configuration
resolution end to end on Linux.

## Step 11 — mac/Linux electron-builder configuration unchanged

The comparison is made in the guest, between this head and the Phase 3 tip `47bb778d8`, with a **detached
worktree** rather than a checkout in place, so the clone's own HEAD never moved:

```bash
git -C ~/bb-posix-check worktree add /tmp/bb-base 47bb778d8
ln -sfn ~/bb-posix-check/node_modules /tmp/bb-base/node_modules
ln -sfn ~/bb-posix-check/apps/desktop/node_modules /tmp/bb-base/apps/desktop/node_modules
```

```
Preparing worktree (detached HEAD 47bb778d8)
HEAD is now at 47bb778d8 Record the Phase 3 Windows gate evidence
WORKTREE_EXIT=0
47bb778d8b420d8780bdf6b0155a872f0c75a1d4
lrwxrwxrwx … /tmp/bb-base/apps/desktop/node_modules -> /home/olege/bb-posix-check/apps/desktop/node_modules
lrwxrwxrwx … /tmp/bb-base/node_modules -> /home/olege/bb-posix-check/node_modules
```

The two symlinks are what let the base worktree run without a second `pnpm install`: `run-electron-builder.mjs`
resolves `electron-builder` through the workspace's `node_modules`, and the dependency set at `47bb778d8`
and at this head differ by nothing electron-builder reads (`pnpm-lock.yaml` moved by 3 lines this phase).

Both sides were printed with a **clean signing environment** — all seven Azure keys and the Apple keys
unset in the child process, so neither side could pick up an ambient secret:

```bash
cd apps/desktop
env -u AZURE_TENANT_ID -u AZURE_CLIENT_ID -u AZURE_CLIENT_SECRET -u AZURE_SIGNING_ENDPOINT \
    -u AZURE_SIGNING_ACCOUNT_NAME -u AZURE_SIGNING_CERTIFICATE_PROFILE -u WINDOWS_PUBLISHER_NAME \
    node scripts/run-electron-builder.mjs --print-config
```

```
PRINTCONFIG_HEAD_EXIT=0      # ~/bb-posix-check, 11dfe15db
PRINTCONFIG_BASE_EXIT=0      # /tmp/bb-base,     47bb778d8
```

The two JSON documents were then compared block by block:

```
mac: IDENTICAL
linux: IDENTICAL
dmg: IDENTICAL
publish: IDENTICAL
files: IDENTICAL
asarUnpack: IDENTICAL

base top-level keys: afterPack, appId, artifactName, asar, asarUnpack, directories, dmg, files, linux, mac, npmRebuild, productName, publish, toolsets
head top-level keys: afterPack, appId, artifactName, asar, asarUnpack, directories, dmg, files, linux, mac, npmRebuild, nsis, productName, publish, toolsets, win
keys only in head: nsis, win
keys only in base:

head.win: {"icon":"assets/icon.png","target":[{"target":"nsis","arch":["x64"]}]}
head.nsis: {"oneClick":false,"perMachine":false,"allowToChangeInstallationDirectory":true,"createDesktopShortcut":true,"deleteAppDataOnUninstall":false}
base.win: null

differing blocks: 0
```

**All six blocks the brief names are identical.** The head's config is a strict superset of the base's: two
new top-level keys, `win` and `nsis`, and nothing removed or altered. That matches the source diff exactly —
`apps/desktop/electron-builder.config.json` gained 11 lines and lost none:

```diff
+  "win": {
+    "icon": "assets/icon.png",
+    "target": [{ "target": "nsis", "arch": ["x64"] }]
+  },
+  "nsis": {
+    "oneClick": false,
+    "perMachine": false,
+    "allowToChangeInstallationDirectory": true,
+    "createDesktopShortcut": true,
+    "deleteAppDataOnUninstall": false
+  },
```

Recorded honestly rather than glossed: the `win` block **is** present in the printed config of a POSIX
build too, because `resolveElectronBuilderConfig` assigns `config.win` unconditionally. That is inert for a
`--mac` or `--linux` invocation — electron-builder reads the block for the platform it is building — and it
carries no signing material, as the next check proves.

### A `--mac` build ignores the Windows signing keys

The `windows` signing mode is gated on `--win` being among the electron-builder arguments. With a
**partial** Azure environment — the shape that aborts a Windows build with `Incomplete Windows signing
environment` — a macOS build must still succeed and must not gain `azureSignOptions`:

```bash
cd apps/desktop
AZURE_TENANT_ID=placeholder AZURE_CLIENT_ID=placeholder \
  node scripts/run-electron-builder.mjs --print-config --mac
```

```
PRINTCONFIG_MAC_PARTIAL_EXIT=0
mac-run win block: {"icon":"assets/icon.png","target":[{"target":"nsis","arch":["x64"]}]}
azureSignOptions present: false
publisherName present: false
```

The two placeholder values are not secrets and no secret value is printed anywhere in this gate.

## Cleanup

The base worktree was removed at the end of the gate; `~/bb-posix-check` itself is left in place for the
next phase, at `11dfe15db`, with its HEAD never having moved during this check. Logs live in the guest
under `/tmp/p4/`.
