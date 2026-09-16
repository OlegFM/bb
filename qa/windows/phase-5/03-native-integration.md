# Phase 5 isolated native integration

Tested head: `43ff7f339b447cc0020d2083bba9e0574ae262ee`, branch
`windows-native/phase-5`. Final live run: 2026-09-16 20:06:01–20:08:02 UTC,
exit **0**. Detailed redacted results are in [04-native-integration.json](04-native-integration.json).
Native Windows remains **beta**.

This used the real built server on an isolated loopback origin, real
`/install.ps1` and `/install/bb-app.tgz` routes, npm installation and installed
native binaries. Server and installer data, profiles and AppData were isolated.
The current user's real Scheduled Task registry was used only for the unique
origin-hash service, after collision checks. PowerShell initialized its own
module paths instead of inheriting the parent PowerShell 7 module path.

## Results

| Check                                            | Windows PowerShell 5.1                            | PowerShell 7                                      |
| ------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------- |
| Real code issuance                               | Built `bb machine join-code --json`, exit 0       | Built SDK `hosts.createJoinCode()`                |
| Installer / same-artifact rerun                  | 0 / 0                                             | 0 / 0                                             |
| Matching connected `/status` and public SDK host | Pass                                              | Pass                                              |
| Stable supervisor PID and daemon port on rerun   | Pass                                              | Pass                                              |
| Protected current-user-only FullControl ACLs     | Data, auth, config and both helpers               | Data, auth, config and both helpers               |
| Actual startup registration                      | One Scheduled Task, no HKCU Run                   | One Scheduled Task, no HKCU Run                   |
| Registered action                                | Logon trigger; Interactive/Limited; no time limit | Logon trigger; Interactive/Limited; no time limit |
| Controlled restart after verified stop           | `Start-ScheduledTask`; reconnects                 | `Start-ScheduledTask`; reconnects                 |
| Occupied unrelated port                          | Exit 1; bystander survives                        | Exit 1; bystander survives                        |
| Failed-install cleanup                           | No reservation or startup registration            | No reservation or startup registration            |
| Installed npm `bb.cmd --version`                 | Exit 0; 0.42.1                                    | Exit 0; 0.42.1                                    |

The artifact route was prewarmed and its hash verified **before** short-lived
CLI/SDK codes were minted. This is live enrollment evidence, not cold-install
timing evidence. The first enrollment was unregistered and stopped before the
second shell enrolled another host at the same server origin.

Final Turbo build: 47/47 tasks, 44 cache hits, exit 0, 1m49.21s. Source, built
and served installer bytes match: 29,984 bytes, SHA256
`4329993232d4ae8106622abb445cbc527657217b2adb2467b70cd0c9558b1170`.
Real served artifact: 1,315,027 bytes, SHA256
`c2251ffda48123a1037a9c9700a2dc3e980ce2150b376134e0f03e98b67d2fee`.

The supplementary probe loaded the actual installed `watcher.node` and
`conpty.node` bindings and recorded their SHA256 values in the JSON. Versions:
node-pty 1.2.0-beta.15 and watcher 2.5.6. Requiring the node-pty JavaScript entry
alone does not load its lazy ConPTY binding; the probe explicitly loaded that
binding. This does not prove terminal interaction or the Electron ABI.

## Separate regression evidence

These are previously executed, independently reviewed checks reused from
Tasks 1–2. They are separate runs and were not repeated or summed here.

| Check                                              | Observed result               | Boundary                                                      |
| -------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| Combined installer/artifact/routes                 | 86 passed; exit 0             | Before the final smart-apostrophe correction                  |
| Final installer route checks                       | 13 passed; exit 0             | Focused route run                                             |
| Final smart-path/ordinary pairing installer checks | 8 passed, 48 filtered; exit 0 | Focused final correction run in both shells                   |
| Final AddMachineDialog                             | 26 passed, no skips; exit 0   | Real-shell command probes with fixture download/child capture |
| Connect baseline                                   | 68 passed; exit 0             | Existing baseline; no live Connect pairing                    |
| Final app / server typechecks                      | Exit 0 / 0                    | 4 / 5 successful Turbo tasks                                  |

Installer unit fixtures remain distinct from the real server, npm and
Scheduled Task integration above. The full unrelated Windows baseline and
same-head external jobs remain pending.

## Cleanup and limits

All temporary Task/Run registrations were removed only after matching the
owned executable/action. Generated identity-safe stop helpers stopped both
supervisors and descendants; both daemon listeners disappeared. The isolated
server was stopped through its ChildProcess handle with `terminateProcessTree`:
leader exited, zero skipped descendants, no enumeration error. The QA bystander
was closed. Native CIM inspection found zero processes referencing any of the
seven owned QA run directories. Existing Task/Run snapshots and the user's
`~/.bb/auth.json`, `config.json` and `host-daemon-port` hashes were unchanged.
Private logs, package/data directories and credentials remain only in ignored
scratch; no raw credentials are included here.

The final checked-in CI definition has a failing-on-error persistent-host step
after build and before packaged Electron ABI changes. It uses `pnpm.cmd`,
`maxWorkers=2`, focused server installer/artifact/route tests and the app dialog
test, with explicit exits. Its unrelated baseline remains `continue-on-error`.
This is a definition review; no new external run or required-check setting is
claimed.

No clean VM is available; the user agreed on 2026-09-16 to leave that gate open.
No WSL change, reboot or logoff occurred. Actual logon restart, real denied-task
HKCU Run fallback, live Connect, Desktop coexistence, Node 24/26, Electron ABI,
signing and external Windows/POSIX regression gates remain pending. The
[clean-machine checklist](../CHECKLIST.md) and five open rows in the
[skip audit](02-skip-audit.md) remain open.

## Local delivery review

Independent whole-change review covered `fafaf454a..43ff7f339` and the final
CI, documentation and evidence changes. It approved this local persistent-host
beta slice with no blocking findings. It did not approve GA or mark any pending
acceptance gate as passed. The branch remains local; no merge, push or release
was performed.
