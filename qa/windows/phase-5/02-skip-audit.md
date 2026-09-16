# Windows test-exclusion audit

Source inspection on 2026-09-16 at Phase 4 base `fafaf454a`.
This is a classification of coverage, not a claim that the listed suites passed
at the Phase 5 head. New installer tests run only where PowerShell is available.

Search included `skipIf`, inverse `runIf`, and aliases assigning `describe.skip`
or `it.skip` from process.platform, across apps, packages and plugins. Generic
optional-corpus, missing-build-output and missing-npm/Git skips also need their
prerequisites present in CI; they are not Windows support exceptions.

| Excluded test file / behavior                                                                            | Windows disposition                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| environment-personal-workspace/host/paths; environment-git-worktree/host/paths: literal backslash in key | POSIX filename capability; sibling Windows tests reject the separator.                                                                                                      |
| environment-git-worktree/host.test: process cleanup                                                      | Windows branch and host.win32 suite exercise native cleanup. Confirm these pass at GA head.                                                                                 |
| secret-storage/write-secret-file and secret-file: mode 0600                                              | POSIX mode bits do not secure NTFS; windows-secret-file/windows-secret-publish/windows-acl tests cover user-only ACLs.                                                      |
| server/plugin-settings-storage: mode 0600                                                                | Sibling Windows test checks ACL-protected secrets.                                                                                                                          |
| host-workspace/git: compare patch ID against sh pipeline                                                 | sh is not the native implementation; shared pipeline/error tests exercise direct Git piping.                                                                                |
| process-utils/resolve-executable: POSIX executable bits/PATH delimiter                                   | Native Windows tests cover PATHEXT, case-insensitive Path and direct Node shim launch.                                                                                      |
| process-utils/index: POSIX contained paths                                                               | Windows containment has a separate contract; verify its drive-root, case and escape tests at GA.                                                                            |
| process-utils/process-tree: POSIX groups/cwd/SIGTERM                                                     | Windows snapshot/stop and real-process suites cover CIM identities and taskkill; POSIX process groups are unreachable.                                                      |
| scripts/start-bb: direct SIGTERM stops descendants                                                       | Windows does not offer the POSIX signal contract; native process-tree smoke covers Windows termination.                                                                     |
| provider-bridge-protocol/provider-maintenance-kit: POSIX sh output                                       | Sibling Windows test exercises the direct native path.                                                                                                                      |
| provider-claude-code/session-options-win32: POSIX PATH walk                                              | Native Windows cases in the same file exercise its distinct lookup rules.                                                                                                   |
| provider-claude-code/skill-plugins: directory symlink                                                    | Sibling Windows junction test covers native staging.                                                                                                                        |
| provider-pi/rpc-session.scratch: POSIX failed-plan scratch retention                                     | Deliberately preserved POSIX behavior; sibling Windows test checks cleanup.                                                                                                 |
| cli/bin: shell wrapper                                                                                   | Sibling Windows CMD shim tests replace the POSIX shell wrapper.                                                                                                             |
| desktop/log-viewer: tail-backed follower                                                                 | Windows Node follower replaces tail.                                                                                                                                        |
| desktop/bb-process: SIGTERM-to-SIGKILL escalation                                                        | Windows-specific tree-stop/budget/early-leader-exit tests cover the native path.                                                                                            |
| host-daemon/environment-lifecycle-script: .sh hooks                                                      | Windows .ps1 hook tests and prior native streaming/timeout/cancel evidence replace .sh behavior.                                                                            |
| host-daemon/terminal-manager: chmod spawn-helper and /bin/sh persistent shell                            | chmod helper capability is POSIX-only; Windows ConPTY smoke covers native shells. PowerShell 5.1/CMD encoding remains an open acceptance concern.                           |
| **OPEN:** cli/plugin-cli-broken-pipe.e2e                                                                 | Windows CLI output can encounter broken pipes too; POSIX shell fixture is insufficient reason to declare capability unreachable. Add native execution/early-close coverage. |
| **OPEN:** host-workspace/git-fetch: timeout transport descendants                                        | Windows cancellation also must clean descendants; add a native transport fixture and assert no late side effect.                                                            |
| **OPEN:** host-workspace/git-ref-mutation-lock: symlink aliases                                          | NTFS junction aliases can reach the same Git directory; add a Windows equivalent for lock serialization.                                                                    |
| **OPEN:** plugin-build/toolchain: inherited npm script-policy config                                     | Applicable on Windows; replace the shell fixture with a native Node shim fixture and assert sanitized environment.                                                          |
| **OPEN:** provider-pi/bridge.bun-runtime                                                                 | NTFS teardown EBUSY is an unresolved failure, not an unreachable product capability. Fix lifecycle and run under Bun or explicitly narrow supported provider scope.         |

The audit is **not closed**: five substantive gaps above remain. Existing
baseline failures outside skip clauses remain additional work. Do not remove
test execution or mark native Windows supported to satisfy the gate.
