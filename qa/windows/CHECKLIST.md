# Native Windows 11 acceptance checklist

Status: pending. This is the clean-machine gate from the approved native Windows
design, not a record of passing checks on the development workstation.

Create a fresh Windows 11 x64 VM with a standard user, WSL disabled, no Git Bash
on PATH, and a profile containing spaces/non-ASCII characters. Save OS build,
Node/npm/Git/PowerShell versions, commit, package hashes, feature state, commands,
exit codes and relevant logs under `qa/windows/phase-5/`. Redact pairing codes
and credentials. Do not use the developer workstation as a clean-VM substitute.

| Gate                | Procedure and required evidence                                                                                                                                                                         | Result  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| No WSL              | Record Windows optional-feature state and show no native flow launches wsl.exe.                                                                                                                         | Pending |
| Package             | Install the exact built tarball from native PowerShell 5.1 and 7; run bb-app and CLI without Bash. Exercise Node 22.19, 24, and 26 compatibility.                                                       | Pending |
| Native addons       | Load node-pty and watcher under Node; load the Desktop package under its Electron ABI.                                                                                                                  | Pending |
| Desktop             | Per-user NSIS install as standard user; start, minimize, close to tray, reopen from tray, quit. Click the real tray and Settings update controls.                                                       | Pending |
| Update              | Download N+1 through the actual Windows update feed, install after runtime shutdown, relaunch and verify installed version. Record zero orphan processes and a surviving unrelated bystander.           | Pending |
| Paths               | Create projects on C: and another local drive, including spaces/non-ASCII; inspect canonical host path/key; reject UNC/device paths.                                                                    | Pending |
| Workspaces          | Create/remove managed worktrees using Git for Windows; verify junction confinement and cleanup.                                                                                                         | Pending |
| Terminals           | PowerShell 7, Windows PowerShell 5.1 and CMD through ConPTY: input/output, resize, Ctrl+C, UTF-8/non-ASCII, close. Record limitations rather than silently accepting garbled text.                      | Pending |
| Hooks               | Run setup/teardown .ps1 with streaming, timeout, cancellation and descendant cleanup; prove failure propagation.                                                                                        | Pending |
| Providers           | Detect/install native Codex and Claude, authenticate, run a turn and cancellation in a drive-letter project.                                                                                            | Pending |
| Watcher             | Modify/create/delete/rename files on NTFS and verify UI changes without manual refresh.                                                                                                                 | Pending |
| Open targets        | Open workspace in Explorer, Windows Terminal and an installed editor; verify chosen path.                                                                                                               | Pending |
| Persistent host     | Install from /install.ps1, match host identity, rerun without duplicate daemon/registration, restart machine/log on, verify reconnection. Test Scheduled Task and denied-task HKCU Run fallback.        | Pending |
| Connect             | Mint join and machine codes through CLI and SDK; enroll through account-gated Connect; verify credential privacy and revoked/expired code failure.                                                      | Pending |
| Desktop coexistence | Keep Desktop running while enrolling another server; verify independent data and ports, preserve Desktop through install/reinstall/removal.                                                             | Pending |
| Lifecycle           | Quit/update/uninstall and host-stop leave no bb/provider/tool descendants; unrelated processes remain alive.                                                                                            | Pending |
| Cleanup             | Remove only the tested enrollment's autostart and data; preserve other server enrollments and the user's Desktop profile.                                                                               | Pending |
| CI/regression       | Windows checks, package smoke and installer smoke pass and are required. Existing macOS/Linux/WSL checks pass at the same head. Attach run URLs and branch-protection response.                         | Pending |
| Skip audit          | Every Windows-excluded test has equivalent measured coverage or an unreachable-capability explanation. Close all open rows in phase-5/02-skip-audit.md.                                                 | Pending |
| Signing             | Verify configured signing secrets produce a signed build; unsigned artifacts remain restricted to fork/nightly. Record certificate/signature and SmartScreen behavior for the artifact actually tested. | Pending |

Only after all applicable rows pass may `docs/platform-support.md` and
`docs/platform-windows.md` change native Windows from beta to supported.
