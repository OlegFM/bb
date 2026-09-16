---
kind: instruction
title: bb Guide — Machines
summary: Command reference for listing and targeting execution machines.
intent: Explain execution-machine discovery and selection from the CLI.
editingNotes: Keep the user-facing noun machine; internal APIs and types use Host.
---
Machine commands

A machine is a host daemon that can run thread environments. Add remote
machines under Settings → Machines. Choose the target shell explicitly:
macOS / Linux (default) or Windows PowerShell. The target can differ from the
computer running the browser or server.

The server listens on loopback by default. Remote execution machines need the
account-gated bb connect route or a private Tailscale Serve URL; generate their
installer while using that reachable server URL.

The macOS/Linux Settings installer first uses the exact `bb-app` tarball served by that bb
server at `/install/bb-app.tgz`; only servers that do not implement the route
(HTTP 404) fall back to the npm registry. npm installs bb-app under this
machine enrollment's bb data directory, so the installer needs neither `sudo`
nor a global npm configuration. Installed launchd/systemd services pass
`--auto-update`. On a newer server protocol mismatch, the daemon downloads that
same artifact, updates its private install, and exits for the service manager to
restart. Failed attempts use a persisted exponential backoff that starts at 5
seconds and caps at 5 minutes. A daemon never auto-downgrades to an older server
protocol. Use Settings → Machines or `bb machine retry-update` to bypass the
current backoff after a transient failure.

Native Windows remains beta. The PowerShell installer requires Windows 11 x64,
Windows PowerShell 5.1 or PowerShell 7, Node 22.19+ with npm, and drive-local
NTFS storage. It downloads `/install.ps1` into a temporary file and invokes
`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File` with
`-JoinCode`, `-HostId`, `-Server`, optional `-MachineCode`, and optional
`-HostDaemonPort`. It requires the server's SHA-256-verified host artifact;
there is no registry or global-install fallback.

Windows enrollment defaults to `%USERPROFILE%\.bb-machines\<SHA-256-of-server-origin>`;
set `BB_DATA_DIR` before running the installer to choose an absolute drive-local
directory. Its private npm prefix is `<data>\npm`. A hidden per-user logon
Scheduled Task named `bb-host-daemon-<origin-hash>` starts the supervisor, with
HKCU Run fallback if registration is denied. The launcher enables auto-update
and restarts the daemon after exit. The installer prints the data directory,
port, launcher, service name, logs, and exact removal commands. Follow
`<data>\logs\host-daemon.log` and `supervisor.log`; restart using the printed
`stop-host-daemon.ps1`, then `start-host-daemon.ps1`. Remove startup registration,
stop the verified supervisor, then delete only that enrollment's data and port
reservation. It uses a separate port from Desktop's `38887` and leaves `~/.bb`
alone. Real logon, clean-VM, and live Connect acceptance remain pending; see
`docs/platform-windows.md` and `qa/windows/CHECKLIST.md`.

For CLI pairing, `bb machine join-code --json` returns `joinCode`, `hostId`, and
`expiresAt` for those installer arguments. The SDK equivalent is
`sdk.hosts.createJoinCode()`. Connect credentials use the existing
`createMachineCode` Connect RPC through `sdk.plugins.callRpc`, or
`bb connect machine-code --json`: the latter currently requires the **Mobile
app** experiment (`bb settings experiment mobileApp true`) and a paired Connect
server. Use its `code` as `-MachineCode` and `serverUrl` as `-Server`; otherwise
use a reachable direct server URL and omit `-MachineCode`. Run before either
code expires.

To opt out, remove `--auto-update` from the launchd plist or systemd user unit
and reload that service. Foreground/manual `bb-app host-daemon` runs leave it off
unless you pass `--auto-update` explicitly.

`bb-app`, `bb-server`, and `bb-host-daemon` capture service stdout and stderr
directly under the selected data directory in `logs/server-stdio.log` and
`logs/host-daemon-stdio.log`. These files append across restarts and contain
console output and startup errors; rotating application logs remain separate.
Use `tail -F` to follow them without coupling service logging to the terminal.

  bb machine list                         List machines with ID, connection
                                          status, and relative last-seen time
    --json                                Print the raw host list
  bb machine show <id-or-name>            Show machine details
  bb machine join-code                    Create a machine pairing code
    --json                                Print joinCode, hostId, expiresAt
  bb machine rename <id-or-name> <name>   Rename a machine
  bb machine retry-update <id-or-name>    Retry a pending daemon update now
  bb machine remove <id-or-name> [--yes]  Revoke and remove a machine
  bb machine provider-cli status <machine>
  bb machine provider-cli install <machine> <claudeCode|codex|cursor>
    --action <install|update>

Each machine has a permission limit: the highest permission mode any thread on
that machine can run with. The default is Full Access. A thread that asks for
more resolves down to the limit, and a provider that supports no mode under the
limit cannot run there. Set it in Settings → Machines → the machine → Permission
limit; that page also shows the machine's projects, provider CLIs, update state,
and rename/remove. There is no CLI or SDK command to set it, and a paired
machine cannot set it for any machine, so a sandbox machine can stay at Full
Access while your laptop stays lower. `bb machine list --json` and `bb machine
show` report the current limit.

Updates commands

One consolidated view of bb and provider CLI updates across machines — the
CLI counterpart of Settings → Updates and the sidebar Updates badge.

  bb updates [status]                     Show bb-app and provider CLI update
                                          status for every machine
    --machine <id-or-name>                Limit to one machine
    --json                                Print the aggregate as JSON
  bb updates apply                        Run every available provider CLI
                                          install/update, one at a time
    --machine <id-or-name>                Limit to one machine
    --json                                Print per-target results as JSON

`bb updates apply` covers provider CLIs only. Update bb-app itself with the
printed upgrade command (`npx bb-app@latest`) or the desktop app's relaunch;
connected daemons then follow the server version automatically.

When bb has no install or update command that would work on a machine — a
provider that ships only a shell installer on native Windows, or a Pi install
with neither bun nor npm on `Path` — the status carries an
`installUnavailableReason` instead of an action. `bb updates status` prints it
under the table as `<machine> · <provider>: <reason>`; `bb machine provider-cli
status` prints `<provider>: <reason>` on stderr in its default (non-`--json`)
output and keeps stdout a single JSON document; and both `--json` forms carry
the field.

Machine selectors accept either an exact machine ID or an unambiguous machine
name. `--host` is an alias for `--machine`.

  bb thread spawn --project <id> --machine <id-or-name> --prompt "..."
  bb project create --name "..." --root <path> --machine <id-or-name>
  bb project source add <projectId> --machine <id-or-name> --path <path>

For thread spawning, machine targeting works with an unmanaged workspace path,
a new managed worktree, or the personal workspace. Do not combine it with an
existing environment ID: the reused environment already selects its machine.

For project creation and sources, `--root`/`--path` refers to a path on the
selected connected machine; the directory does not have to exist. Omit the
selector to keep the existing local CLI machine fallback (normally the primary
machine). Pass `--clone` to source add instead of `--path` to clone the
project's Git remote there; `--remote-url` and `--target-path` optionally
override the clone inputs.
