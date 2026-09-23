# Phase 5 acceptance status

Base: `fafaf454a` (Phase 4 continuation); branch: `windows-native/phase-5`.
Date: 2026-09-16. Native Windows remains **beta**.

The implementation plan is
`docs/superpowers/plans/2026-09-16-native-windows-phase-5.md`. The canonical
clean-machine checklist is `qa/windows/CHECKLIST.md`.

The 2026-09-23 continuation is recorded in
[05-local-hardening.md](05-local-hardening.md), including its fresh baseline,
task-specific verification and remaining limits. The earlier measurements
below apply to their recorded commits; they are not reruns at the hardening
head.

## External gates observed before implementation

Read-only commands:

```powershell
gh api repos/OlegFM/bb/actions/workflows --jq '.workflows[] | {id,name,path,state}'
gh api repos/OlegFM/bb/branches/main/protection
```

Observed workflow registry: CI (356166268) and Version Lockstep (356103578),
both active. `build-desktop.yml` is absent from the registry. The branch
protection API returned HTTP 404 with `Branch not protected`. No remote
settings, branch protection or publication was changed by this inspection.

At that inspection, the checked-in CI Windows job was
`Windows x64 (windows-2025, Node 22.x)`.
Its baseline test step has `continue-on-error: true`; its selected test packages
do not include server or app. A successful job therefore does not prove the
Windows server/UI test suites passed. Packaged Desktop and process-hygiene
smokes are separate steps. Ubuntu jobs use Blacksmith labels unavailable to
this fork in earlier Phase 4 attempts; a new passing POSIX run is still needed.

The Phase 4 continuation commit has not been pushed or checked by remote CI.
Earlier successful Windows CI applies to the earlier head, as recorded in
`../phase-4/41-ci-run.md`.

## Final local Phase 5 evidence

At head `43ff7f339`, real isolated native enrollment passes in PowerShell 5.1
and 7, including actual Scheduled Task registration and controlled action
restart, artifact reuse, private ACLs, CLI/SDK issuance and identity-safe cleanup.
See [03-native-integration.md](03-native-integration.md) and its redacted JSON.
This does not establish actual logon or clean-VM acceptance. The user confirmed
on 2026-09-16 that no ready clean VM is available and agreed to leave it open.

The 2026-09-16 CI definition added a failing-on-error focused persistent-host step
for server installer/artifact/routes and the app dialog after build, before
Electron packaging. The separate baseline still does not include server/app
and remains non-gating. No same-head external run or required-check change is
claimed by the local integration.

The 2026-09-23 hardening adds failing-on-error coverage for the locally verified
workspace, open-target, secret-storage, Desktop, plugin-build, Pi and full server
suites, plus focused broker, CLI and app-dialog regressions. The full server
run passed 2505 tests with 24 classified skips. These are checked-in workflow changes, not evidence of a remote
job run or an updated branch-protection setting.

## Existing baseline requiring hardening

The controlled Phase 4 continuation measured 19 failing server files and five
failing Desktop files. Details and limitations are in
`../phase-4/43-continuation.md`; this inventory does not turn those failures into
passes. The table includes measured updates from the 2026-09-23 hardening.
Task E's final isolated full server run passed 239 files (two optional-corpus
files skipped), 2505 tests passed and 24 skipped, exit 0; affected typecheck
also passed. Other non-gating repository packages are not covered by this result.

| Priority             | Family                                                                      | Evidence / intended treatment                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installer dependency | bb-app artifact npm spawning and missing Windows CLI shim                   | Corrected with 19 artifact tests and real route/npm installation plus installed CMD shim evidence in [03-native-integration.md](03-native-integration.md).                                                                                                              |
| Closed locally       | plugin-install, plugin-update, third-party marketplaces                     | Task A repaired local Git parsing/cache paths (selected four-file suite: 114 passed, 3 false npm prerequisite skips). Task D then corrected npm launch/probes and passed both complete npm files, 73/73 without skips. See [hardening evidence](05-local-hardening.md). |
| Closed locally       | plugin-service, appearance and thread runtime config                        | Task E repaired native ESM imports and remote-host path composition; the final full server run covers this family.                                                                                                                                                      |
| Closed locally       | fake-host-dependent public routes                                           | Task E distinguishes local and remote path flavor, validates raw paths against the connected target host, and retains offline 502 behavior. Full server passed.                                                                                                         |
| Closed locally       | install-machine-script, CLI documentation examples                          | Task E retains the portable integrity check, classifies 22 POSIX shell cases, runs all 56 native PowerShell installer tests, and launches real TypeScript compilation portably.                                                                                         |
| Closed locally       | SQLite/update cleanup EBUSY                                                 | Failed initialization closes its owned SQLite handle; real file rename and native Git update regressions pass in the full server suite.                                                                                                                                 |
| Closed locally       | chmod/secret-mode and separator assertions                                  | Native mode/content/hash and host-path assertions execute; the POSIX 0600 test has a running Windows ACL counterpart. This is not an audit of all product secret files.                                                                                                 |
| Closed locally       | Desktop app-paths, browser-import, packaging, foreign-runtime, view-manager | Task C fixed the five baseline files plus private broker publication/discovery; full Desktop 392 passed, 8 platform skips at `e1b0c38fa`, with types/builds and independent review passed.                                                                              |
| Closed locally       | execution-options timeouts                                                  | All 38 tests passed in the prior focused repeat and the final single-worker full server run; no timeout increase was needed for this family.                                                                                                                            |

A clean VM with WSL disabled, real logon/restart, live Connect credential
redemption, physical tray/Settings actions and signed-release verification have
not been performed by this acceptance inventory. Keep those checklist rows
pending until their own evidence exists.
