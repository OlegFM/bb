# Phase 4 continuation on Windows

Date: 2026-09-16. Source base: `0ad6f0e6b153794883c218debc53f03feeec2ad1`
plus the local Windows browser-broker fix and its lifecycle regression tests.
The original gate files remain historical evidence. This follow-up supersedes
their open first-close finding and adds measurements for previously incomplete
checks; it does not claim a green monorepo test suite or a completed release-workflow run.

## Browser lifecycle fix

The `closed` callback runs after Electron destroys its `BrowserWindow`.
The broker previously looked up its instance by reading that window's
`webContents`, throwing before cleanup. Lease revocation and manager-change
notifications also reached that getter.

On Windows, the broker now records the renderer ID at registration, uses it
for lookup and scopes, treats destroyed hosts as having no tabs, and skips
destroyed hosts during manager notifications. Release can revoke all leases,
close their CDP bridges and remove the instance without accessing destroyed
Electron objects. Other live windows keep their own instances and leases.
An injected platform preserves the existing POSIX behavior, per the port's
scope restriction. No wire fields, protocol versions, SDK or CLI surfaces change.

Seven new Windows regressions failed with the original destroyed-object error
before the fix; two POSIX preservation cases passed. All nine pass after the
fix, including a real loopback CDP WebSocket disconnect and multiple leases.
Independent code review found no actionable issues.

## Build and installed application

Commands ran through Turbo using `pnpm.cmd` to preserve argument separators
under PowerShell.

| Check                                                                                  | Result                                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `turbo run typecheck --filter=@bb/desktop`                                             | exit 0                                                                             |
| `turbo run test --filter=@bb/desktop -- test/desktop-browser-broker-lifecycle.test.ts` | exit 0; 9/9 tests                                                                  |
| Desktop tests with `--maxWorkers=2`                                                    | 44 files passed, 5 failed; 373 tests passed, 10 failed, 6 skipped                  |
| Same five failing files with the original broker                                       | same 10 failures reproduced; no broker regression identified                       |
| `turbo run desktop:build:windows --filter=@bb/desktop`                                 | exit 0; 49/49 tasks, 5m16s                                                         |
| Fresh per-user NSIS install                                                            | exit 0; installed version `0.42.1`                                                 |
| Installed window close/reopen                                                          | three cycles passed; zero captured main-process errors; `/health` stayed available |
| Quit after those cycles                                                                | desktop exit 0, 4,977 ms from quit-file write                                      |
| `turbo run smoke:packaged --filter=@bb/desktop`                                        | exit 0                                                                             |
| Isolated `smoke:windows-processes`                                                     | exit 0; no survivors/strays; bystander survived                                    |

The first process-hygiene attempt ran concurrently with the update installer
and timed out waiting for desktop exit. It is retained as a failed run, not
counted as a pass. The repeat after the installer exited passed in 16.338 s.
The concurrency is a confounding condition; the timeout's exact cause was not
established. The successful isolated check is the process-hygiene evidence here.

The Windows desktop suite's ten reproduced baseline failures cover path
separators (`app-paths`, browser import), POSIX mode bits (packaging), POSIX
signals (foreign runtime), and two existing browser-view reconnect cases.

The pre-fix packaged app reproduced the first-close exception using the same
Inspector-driven window-close procedure as the fixed installed app. In both
runs, `dialog.showErrorBox` was replaced in memory with an error collector so
an expected failure could be recorded without opening a modal. This did not
catch the failing callback or bypass broker cleanup. Reopening used a genuine
second process and the application's single-instance handler.

The rebuilt `apps/desktop/release/bb-0.42.1-x64.exe` is unsigned, SHA-256:

```text
1A49832EC0234AB5BDB7C6041D41FEAFE085AFFEFC5C1E23D7F98B52BDC6578F
```

Installed and unpacked `resources/app.asar` matched, SHA-256:

```text
33FB2E39FCDDCD7ADC3C998A649A0F936663D018EBB67BB4E6A9ACFEDBBD4535
```

## Actual updater download and installation

The corrected check passed, exit 0. The installed rebuilt N (`0.42.1`)
downloaded the retained Claude QA N+1 (`0.42.2`) through electron-updater,
then installed it through the normal automatic-install-on-Quit path.
N+1 is the earlier QA payload, not a second build containing this broker fix;
it was used to measure updating and was uninstalled after verification.

The local feed served `desktop-version-windows.json`, `latest.yml`, the N+1
blockmap and the full 161,914,035-byte installer. The feed intentionally had
no N blockmap; the measured 404 caused electron-updater's normal fallback to
a full download. Differential-download success is not claimed.

The actual downloaded installer matched `latest.yml`'s SHA-512:

```text
oI6Cj0upcX5VcPozfHDtMlPrAZvFoqjdEHxdfd8NkLswvm4ebmRMQCtKSmnMS/e7t9EpT15tu6N1s8ntZT4PWg==
```

The real service reported `downloadState: downloaded`, `latestVersion: 0.42.2`
and `updateDownloaded: true`. At the install boundary, none of the recorded
owned-runtime process identities remained and the unrelated bystander was
alive. The actual updater spawned its cached installer with `--updated /S`;
the old desktop exited **0**. The installer process completed and the bystander
remained alive. Its detached exit code is unavailable, so installation was
verified by independent observations: executable version, packaged `bb-app`
version and HKCU uninstall registration all reported **0.42.2**. A fresh
isolated launch also reported **0.42.2**, answered `/health`, and quit with
exit **0**.

Procedure used for the local feed:

1. Install N silently as the current user after verifying no existing install.
2. Start N with separate `BB_DATA_DIR`, `--user-data-dir`, server/daemon ports,
   a fresh quit-file path and `--inspect-brk=127.0.0.1:<port>`.
3. In the packaged main script, break on `args.updater.setAutoDownload(false)`
   immediately after the built-in feed configuration. Evaluate
   `args.updater.setFeedURL({provider: "generic", channel: "latest", url: localFeedUrl})`
   in that frame, remove the breakpoint and resume. The JSON feed uses the
   existing `BB_DESKTOP_VERSION_FEED_URL` setting.
4. Wait for the real service's downloaded state, record owned process
   identities, and write the normal quit request.
5. Break at `NsisUpdater.doInstall(options)` to check stopped-runtime
   identities, the bystander, installer hash and normal options
   `{isSilent: true, isForceRunAfter: false, isAdminRightsRequired: false}`.
6. Resume and immediately detach Inspector, then observe the actual installer
   process. Relaunch N+1 explicitly with isolated paths to verify the result.

No shipped updater override, hosts-file change, trusted certificate, publish
or product configuration change was introduced. Both port assignments and
Inspector endpoints were loopback-only. Local harnesses and full logs remain
in `.superpowers/sdd/2026-09-16-native-windows-phase-4/`.

The first instrumented attempt also installed N+1, but kept Inspector attached
while waiting for NSIS. Its app log ended with `Waiting for the debugger to
disconnect...` and desktop exit was 1. This was not counted as clean acceptance.
The harness was corrected to detach immediately before waiting; N was
reinstalled, the previous updater cache was set aside, and the complete
download/install check above was repeated with desktop exit 0. No other
desktop smoke ran concurrently with this clean update check.

## Cleanup and retained evidence

The test N+1 install was uninstalled. Its installation directory and HKCU
entry are absent, no `bb.exe` processes remain, and both updater cache
directories created by this continuation were removed. The original
`%APPDATA%\bb` contains the same **257 files with identical lengths and
SHA-256 hashes** as before testing. The original updater-cache directory was
absent before the continuation. QA runtime/profile data stayed in the isolated
scratch directories. The rebuilt N installer remains in `apps/desktop/release`.

Portable observations are saved alongside this report:

- `43-close-before.json`, `43-close-after.json`: actual Electron lifecycle results.
- `43-process-hygiene.json`: passing isolated process check;
  `43-process-hygiene-concurrent-failure.json`: the earlier timeout.
- `43-verification.txt`: command-output summaries for regression, typecheck,
  build, desktop baseline, packaged smoke and server checks.
- `44-updater.json`: clean download, hash, runtime-stop and installer observations.
- `44-installed-versions.json`, `44-n1-relaunch.json`: independently checked N+1.
- `44-cleanup.json`: original profile preservation and cleanup results.

## Controlled server tests

`pnpm.cmd exec turbo run test --filter=@bb/server --output-logs=new-only -- --maxWorkers=2`
completed all 240 files: **19 failed, 219 passed, 2 skipped**; **133 failed,
2,317 passed, 6 skipped tests**, exit 1. This replaces the previous absence of
any scoped server run; the initial monorepo pass had 145 failing server files.

Comparison against the retained Phase 2 solo log found 18 common failing
files. `plugin-authoring-docs` now passes; `execution-options` failed in this
run and also appears in older Phase 1 evidence. A focused follow-up,
`--maxWorkers=1 test/system/execution-options.test.ts`, passed **38/38**, exit 0,
including the initially unmatched HTTP 502 timeout case. No timeout was raised
and no server code or tests were changed.

Recurring failures include Windows paths treated as HTTPS Git URLs, ESM
imports receiving a `c:` protocol, POSIX executable/mode/path expectations,
locked-file cleanup, theme fallback assertions and fake-host waits. They
must not all be called load flakes. Historical case-level comparison found
the additional current public-thread and update-resolver timeout cases in
older logs too. These results support historical recurrence and resolve the
new file-composition delta; they do not establish that every server test passes
or replace a fresh paired baseline for an exhaustive regression claim.

## CI and scope

Live GitHub API verification confirmed the original evidence commit's
Windows job completed successfully: run `35097601541`, job `104798730962`,
completed `2026-09-16T12:59:56Z`. This is evidence for `0ad6f0e6b`, not CI
verification of the local continuation changes. The fork workflow registry
still contains only CI and Version Lockstep; the separate `build-desktop.yml`
run remains unmeasured as recorded in `42-build-desktop-run.md`.

Persistent host and GA hardening remain Phase 5. The existing unsigned-build,
SmartScreen, session-end, PID-reuse and absent protocol-handler limitations
are not changed by this fix. Physical tray-menu clicks and Settings-button
installation are not claimed by automated lifecycle/quit checks.
