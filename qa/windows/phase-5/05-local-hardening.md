# Phase 5 local hardening, 2026-09-23

Starting commit: `c2045de98ca7344c7db55543bbb583bc2167071a` on
`windows-native/phase-5`. Native Windows remains **beta**.

This continuation repairs locally reproducible Windows failures and closes
applicable test-exclusion gaps. It does not establish clean-machine, actual
logon, live Connect, signed-release or same-head external CI acceptance.
The execution scope is Tasks 4–8 of
[the Phase 5 plan](../../../docs/superpowers/plans/2026-09-16-native-windows-phase-5.md).

## Fresh starting measurements

The audit ran on native Windows with Node 22.19.0, pnpm 9.15.0 and Git for
Windows 2.52.0. Turbo was forced, with at most two test workers. These are
test-case counts, not counts of independent product defects.

| Selection                     | Passed | Failed | Skipped | Exit |
| ----------------------------- | -----: | -----: | ------: | ---: |
| Full `@bb/desktop`            |    373 |     10 |       6 |    1 |
| Four server files below       |     46 |     65 |       3 |    1 |
| Full `@bb/host-workspace`     |    147 |     26 |       4 |    1 |
| Full `@bb/local-open-targets` |     81 |      6 |       1 |    1 |
| Full `@bb/secret-storage`     |     49 |      0 |       2 |    0 |

The four server files were `plugin-install.test.ts`, `plugin-update.test.ts`,
`third-party-marketplaces.test.ts` and `custom-themes.test.ts`. The native
package command combined workspace, open-target and secret-storage packages
with `--continue`; its overall exit was 1. This audit was not a full server
or monorepo test run.

The initial private transcripts are under
`.superpowers/parity-audit/2026-09-23/`. Implementation reports and subsequent
transcripts are under
`.superpowers/sdd/2026-09-16-native-windows-phase-5/hardening-2026-09-23/`.
These gitignored diagnostics supplement the portable results recorded here.

## Verification results

Tasks A–E are implemented, independently reviewed and committed locally. The
starting measurements above are historical; the following runs establish the
verified scope of each correction.

Task A is committed as `5e1e5d7e5`. The corrected four-file server run passed
with one worker: **114 passed, 0 failed, 3 skipped**, exit 0
(`task-a-final-server-serial.log`). After the cache-namespace review correction,
five focused parser, real-install, marketplace and HTTP-update tests passed,
exit 0 (`task-a-green-cache-collision.log`). Both affected typechecks passed
through Turbo, exit 0 (`task-a-typecheck.log`). Independent review approved
the correction, and formatting and diff checks passed before commit.

The three npm skips were caused by a Windows-incompatible prerequisite probe
and were subsequently closed by Task D below. Task A's workspace status/diff
run had 70 passes and three failures: native non-Git path spelling,
large-directory timing, and a later timeout. The new SHA-256 case and original
unborn-repository cases passed; the full workspace baseline belongs to Task B.

Task B is committed as `b6678e3d1` after independent review. Its full serial
workspace run passed: **179 passed, 0 failed, 7 skipped**
across nine files, exit 0 (`task-b-host-final-serial-handshake.log`). The full
open-target suite passed with **87 passed, 0 failed, 1 skipped**, exit 0.
After a review correction confined to failure cleanup in the native fetch
test, the entire fetch file passed again: **6 passed, 0 failed, 1 skipped**,
exit 0 (`task-b-fetch-final-cleanup-focused.log`). Both affected typechecks,
formatting of all eleven changed files and `git diff --check` passed after
that correction. The full workspace suite was not repeated for this final
test-cleanup-only change.

The seven workspace exclusions are three POSIX shell cases, the POSIX
transport fixture, POSIX symlink and macOS volume aliases, and a literal TAB
filename that Win32 cannot create. Native Git, descendant, junction and parser
equivalents execute. The open-target exclusion is the explicitly opt-in real
interactive-console launch; this run did not open a user-visible terminal.

Task C is committed as `e1b0c38fa` after independent review. The final full
Desktop run passed **392 tests, 0 failed, 8 skipped** across 52 files (51 passed,
one POSIX-only file skipped), exit 0 (`task-c-desktop-full-review-final.log`).
The daemon broker file passed **9/9**, including transient and permanent
descriptor-publication contention (`task-c-publish-race-final.log`). Combined
Desktop/daemon typechecks passed all five Turbo tasks; combined builds passed
all 48 tasks, including bundled Desktop Electron entries. These checks ran
after the review correction, with final format and diff checks also passing.
The eight Desktop exclusions comprise the previous six platform-specific
cases and two added POSIX descriptor-permission cases; native ACL and reparse
equivalents execute on Windows.

Task D is committed as `f2021d36e` after independent review. Its final native
CLI selection passed **9 tests**, with eight retained
POSIX-only cases skipped. Full Pi passed **176 tests, 0 failed, 1 skipped**
across 31 files (`task-d-pi-full-green.log`); its sole exclusion is the POSIX
scratch-file expectation, with the Windows cleanup case retained. Full
plugin-build passed **142 tests, 0 failed, 1 skipped** across ten files
(`task-d-plugin-build-full.log`); the optional real registry fetch was not
enabled. Both complete server npm files passed **73/73** with no skips
(`task-d-server-two-files.log`). All commands exited 0. The final four-package
typecheck passed all nine Turbo tasks, and formatting/diff checks passed.
These package results include the independently reviewed lifecycle and
fixture corrections; Task E below supplies the separate full server result.

Task E is committed as `edabbdeab` after independent review. Its final isolated
full server run passed **2505 tests, 0 failed, 24 skipped** across 241 files
(239 passed, two optional-corpus files skipped), exit 0 (`task-e-full.log`).
Turbo completed all eight tasks in 19m56.519s; the run used one test worker.
Affected typecheck passed all five Turbo tasks, including an uncached server
`tsc --noEmit`, exit 0 (`task-e-typecheck.log`). All 24 changed server files
were formatted, and diff checks passed. The full run covers the final fixture
cleanup and POSIX case-preserving assertions, not just the earlier probes.

The 24 server exclusions are 22 POSIX shell installer cases, one POSIX `0600`
case with a running Windows ACL counterpart, and one optional provider-corpus
pagination case. The second skipped file has an empty corpus-driven selection
and adds no enumerated test case. All 56 native PowerShell installer tests and
the synthetic 10,019-event timeline test run; optional archived provider replay
is not established.

The final combined Desktop, host-daemon and server build passed **48/48 Turbo
tasks**, exit 0, in 3m27.797s (`controller-integration-build.log`), after Tasks
A–E and the plugin guide updates. Seven upstream tasks were cached; the server,
daemon and Desktop bundles executed. This builds Electron entries without
launching the GUI or creating/publishing an installer. The final workflow YAML,
all 13 Windows step bodies as PowerShell, formatting and `git diff --check`
also passed local validation.

## Implemented changes

Local Git plugin sources now recognize drive-absolute Windows paths with
either separator. The entered source spelling is preserved. The artifact
cache uses `@local-win/<drive>/<32-hex SHA-256 prefix>`, derived from the drive
and source path, avoiding a second copy of the entire absolute path under the
data directory. The prefix cannot be an HTTPS hostname; local and remote
origins cannot produce the same key through that prefix. Source validation
precedes cache-key construction. Real long-path and nested-plugin installation
cases exercise this behavior.

Unborn Git repositories now obtain their empty tree through empty stdin,
instead of opening Windows' device-file spelling. The regression includes a
real SHA-256 repository. Custom code themes use native relative containment,
so valid Windows child files load while parent and sibling escapes remain
rejected.

Server test-fixture corrections preserve their assertions: Git writes its own
URL-rewrite configuration; cache expectations follow the validated source
identity; native build scenarios receive individual time budgets based on
observed execution. The interrupted rollback completed in 56.4 seconds when
isolated, close to its former 60-second limit. The final selected server
verification uses one worker. That selected Task A run was not a full server
result; the later Task E full run is recorded above.

Workspace hardening uses direct native executable/Node-shim plans for Git and
gh, including background fetch and null-record/pipeline paths. Missing-command
errors retain their existing classification, and pipeline cancellation is
checked again after asynchronous executable lookup. A native SSH transport
regression reproduced a descendant surviving a fetch timeout; the production
timeout now waits for Windows process-tree termination. Junction aliases are
tested against the same Git common-directory identity and mutation lock.

The large-list regression retains 150,000 entries through an isolated
`readdir` fixture and the actual `Workspace.listFiles()` implementation. The
earlier real NTFS fixture completed its assertions in a serial run but exceeded
the 60-second cleanup-hook budget while deleting its files. Real nested native
directory listing remains covered separately. This fixture change is not a
claim of improved filesystem throughput. The timeout/descendant fixture
confirms a live child before triggering the product's timeout callback; other
timers and the native process tree remain real.

Desktop broker publication now uses private-before-content Windows staging.
The reader checks owner SID, ACL, file type and bounded content through one
opened handle, rejecting foreign owners, broad permissions and reparse points.
Windows lookup includes the finite origin-hash spellings produced by the
PowerShell 5.1 and 7 installers, including IDN and IPv6 differences, and checks
the descriptor's canonical server origin. Custom data directories remain
explicit inputs.

Native overlap tests reproduced an open-reader replacement failure even with
delete sharing. Broker publication handles that transient rename failure with
a bounded retry; the existing secret-file helper still secures and removes
each temporary file. A persistent failure retains its error and closes the
broker listeners. This handling is local to broker publication.

The Windows plugin-build toolchain now launches npm through its validated
Node entry, preserving complete pinned arguments and script-policy filtering.
Server npm fixtures use the same portable launch mechanism, isolated npmrc
files and local registries. Separate pack/install caches preserve the assertion
that an uncached scoped package is actually fetched. Previously hidden npm
cases now run. Native CLI tests close a real reader and retain full-output,
nonzero-exit and genuine write-error checks; they found no new CLI defect.

Pi cleanup now distinguishes process exit from completed stdio closure.
Native Bun evidence showed teardown removing its workspace while the owned
child was still alive, causing `EBUSY`. Thread and model-catalog cleanup wait
for close; a deadline terminates only the owned child and releases its own
streams. Early exit notification and request failure behavior remain covered.
Two native inherited-stdio probes did not reproduce a Windows hang; the bounded
close contract has a separate live-child regression. Full Pi tests retain
POSIX exit-log assertions and use actual PID disappearance on Windows.
These are fake-provider runtime tests, not live authenticated Pi turns.

Task E repairs server-owned SQLite connection cleanup when initialization
throws, and distinguishes local filesystem paths from paths belonging to a
remote daemon. Thread storage, project file reads, workspace instructions and
project skills use the remote path flavor. Raw HTML preview paths must be
absolute for the connected target host; invalid drive spellings, current-drive
paths, UNC/device paths and mismatched host flavors are rejected before a file
read. Offline hosts retain the existing 502 error. Native ESM and compiler
fixtures retain actual plugin loading and TypeScript compilation.

Its initial 14-file selection measured 260 passed and 26 failed. The first
isolated full server run measured 2457 passed, 45 failed and 24 skipped across
241 files, with two unhandled errors, exit 1. This is diagnostic evidence,
not acceptance. The isolation wrapper had removed the documented Git
`core.longpaths` and `core.symlinks` prerequisites. Restoring those settings in
the temporary Git config and clearing inherited `PSModulePath` produced a
five-file rerun with 258 passed and three failed; all 56 PowerShell installer
tests and the remote-path tests passed. A separate direct PowerShell module
probe did not reproduce the original autoload error, so that probe alone is
not its diagnosis.

The three remaining failures were an outdated Windows cache-path expectation,
a 5-second limit for a measured 9.6-second concurrent-update test, and duplicate
upper/lower-case npm cache environment keys in the Windows test process.
The npm probe confirmed those duplicates; a running installed plugin with zero
tarball requests did not prove a cold download. The corrected fixture uses
separate verified caches, removes case aliases before configuration and restores
them in `finally`. The Windows-only update budget is 20 seconds; POSIX retains
five seconds. Independent review closed the three path-boundary findings, and
the final full run and typecheck above passed after the fixture corrections.

## Reproducible verification commands

Run from the repository root in PowerShell. Task A's final selected suite,
post-review delta and typechecks respectively used these commands; each exited 0. The focused `-t` run deselects other tests, so its 105 skipped cases are
not additional platform exclusions.

```powershell
pnpm.cmd exec turbo run test --filter=@bb/server -- --maxWorkers=1 test/services/plugins/plugin-install.test.ts test/services/plugins/plugin-update.test.ts test/services/plugin-catalog/third-party-marketplaces.test.ts test/system/custom-themes.test.ts
pnpm.cmd exec turbo run test --filter=@bb/server -- --maxWorkers=1 test/services/plugins/plugin-install.test.ts test/services/plugins/plugin-update.test.ts test/services/plugin-catalog/third-party-marketplaces.test.ts -t "parses absolute Windows|separates Windows local cache keys|installs a local repository whose source path|adds, refreshes, and removes a git marketplace|checks, reads persisted state, and updates through"
pnpm.cmd exec turbo run typecheck --filter=@bb/server --filter=@bb/host-workspace
```

Task B's full workspace, full open-target, final cleanup-delta and type checks
used the following commands, each with exit 0:

```powershell
pnpm.cmd exec turbo run test --filter=@bb/host-workspace -- --maxWorkers=1
pnpm.cmd exec turbo run test --filter=@bb/local-open-targets -- --maxWorkers=2 test/workspace-open-targets.test.ts
pnpm.cmd exec turbo run test --filter=@bb/host-workspace -- --maxWorkers=1 test/git-fetch.test.ts
pnpm.cmd exec turbo run typecheck --filter=@bb/host-workspace --filter=@bb/local-open-targets
```

Task C's final verification used the following commands, each with exit 0.
The final full Desktop run used the package's default worker configuration.

```powershell
pnpm.cmd exec turbo run test --filter=@bb/desktop
pnpm.cmd exec turbo run test --filter=@bb/host-daemon -- --run src/desktop-browser-broker.test.ts
pnpm.cmd exec turbo run typecheck --filter=@bb/desktop --filter=@bb/host-daemon
pnpm.cmd exec turbo run build --filter=@bb/desktop --filter=@bb/host-daemon
```

Task D's final package and CLI verification used the following commands,
each with exit 0. Mechanical formatting followed the suites; the final
typecheck and format/diff checks apply to the formatted source.

```powershell
pnpm.cmd exec turbo run test --filter=@bb/cli --output-logs=new-only -- --maxWorkers=2 src/__tests__/plugin-cli-broken-pipe.e2e.test.ts
pnpm.cmd exec turbo run test --filter=bb-plugin-provider-pi --output-logs=new-only -- --maxWorkers=2
pnpm.cmd exec turbo run test --filter=@bb/plugin-build --output-logs=new-only -- --maxWorkers=2
pnpm.cmd exec turbo run test --filter=@bb/server --output-logs=new-only -- --maxWorkers=1 test/services/plugins/plugin-install.test.ts test/services/plugins/plugin-app-bundle.test.ts
pnpm.cmd exec turbo run typecheck --filter=@bb/plugin-build --filter=@bb/cli --filter=@bb/server --filter=bb-plugin-provider-pi --concurrency=1 --output-logs=new-only
```

Task E's final commands, each with exit 0, ran in a separate PowerShell process
with isolated profile, Git, gh and npm configuration. The checked-in
`Test Windows server regressions` step in
[ci.yml](../../../.github/workflows/ci.yml) contains the reproducible setup:
scrub inherited authentication/configuration variables without printing them,
use temporary Git `core.longpaths=true` and `core.symlinks=true`, disable system
Git config and interactive credentials, set an isolated npm cache and dead
loopback default registry, and clear inherited `PSModulePath`. Tests with
registries use their own loopback fixtures. Run that setup only in a child
PowerShell process; it deliberately replaces process-local profile variables.
Turbo loose mode passes this controlled environment to the test workers.

```powershell
pnpm.cmd exec turbo run test --filter=@bb/server --env-mode=loose --output-logs=new-only -- --maxWorkers=1
pnpm.cmd exec turbo run typecheck --filter=@bb/server --env-mode=loose --output-logs=new-only
```

The Windows CI definition now gates the full server, workspace, open-target,
secret-storage, Desktop, plugin-build and Pi suites, plus focused daemon broker,
CLI broken-pipe and app-dialog checks. Bun is pinned to 1.4.0 for the Pi case.
The old duplicated server selection was removed; the app-dialog gate remains.
Domain, process-utils, the rest of host-daemon, scripts and bb-app retain the
non-gating baseline. No external workflow was run or required-check setting
changed by this continuation.

The final integration build command was:

```powershell
pnpm.cmd exec turbo run build --filter=@bb/desktop --filter=@bb/host-daemon --filter=@bb/server --concurrency=1 --output-logs=new-only
```

## Acceptance boundary

The existing [native enrollment evidence](03-native-integration.md) remains
valid for its recorded head and scope. No clean VM, user logoff/reboot, live
Connect redemption, Desktop GUI manipulation, release publication or remote
required-check change is part of this local hardening run.

Browser Automation, cookie import and sandbox parity remain outside the
approved native Windows design. Neither a repaired test baseline nor the
presence of the [checklist](../CHECKLIST.md) changes those product boundaries.

The [documented Windows limitations](../../../docs/platform-windows.md)
also remain relevant: this continuation does not harden all account-pool,
secret and daemon identity/auth files, add creation-time identity to the
Desktop parent watchdog, implement Windows Keep Awake, automate provider
installation or establish PowerShell 5.1/CMD terminal encoding parity.
The broker descriptor changes above cover that specific credential file;
they are not evidence of a completed audit of every secret-storage path.
