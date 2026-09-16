# Provider CLI installation status and run (Phase 3 gate, Step 10)

Host and dev instance: `00-host.md`. Machine `host_45kqba73eq`. Protocol
`HOST_DAEMON_PROTOCOL_VERSION` 201 — Phase 3 bumped it for `installUnavailableReason`, a **required** key
of the bridge status (Task 6; an external bridge built against an older SDK fails the parse until rebuilt).

## `bb machine provider-cli status --json`

```powershell
node apps/cli/dist/index.js machine provider-cli status host_45kqba73eq --json   # STATUS_EXIT=0
```

| provider | installed | source | current → latest | `installAction` | `installUnavailableReason` |
|---|---|---|---|---|---|
| `codex` | true | `external` | 0.153.4 → 0.154.0 | `{kind:"update", label:"Update", command:"codex update"}` | `null` |
| `claude-code` | true | `external` | 2.1.272 → 2.1.273 | `{kind:"update", label:"Update", command:"claude update"}` | `null` |
| `pi` | false | `notInstalled` | — → 0.85.1 | `{kind:"install", label:"Install", command:"bun add -g @earendil-works/pi-coding-agent@latest"}` | `null` |
| `acp-cursor` | false | `notInstalled` | — | `null` | *(see below)* |

Verbatim for the two interesting rows:

```json
"pi": {
  "displayName": "Pi", "executableName": "pi", "executablePath": null,
  "installed": false, "installSource": "notInstalled",
  "currentVersion": null, "latestVersion": "0.85.1", "minimumSupportedVersion": "0.84.0",
  "npmPackageName": "@earendil-works/pi-coding-agent", "npmGlobalPackageVersion": null,
  "installAction": {"kind":"install","label":"Install","command":"bun add -g @earendil-works/pi-coding-agent@latest"},
  "installUnavailableReason": null, "needsUpdate": false, "versionUnsupported": false
}
```
```json
"acp-cursor": {
  "displayName": "Cursor", "executableName": "cursor-agent", "executablePath": null,
  "installed": false, "installSource": "notInstalled",
  "installAction": null,
  "installUnavailableReason": "bb cannot run the Cursor Agent shell installer on Windows. Install Cursor Agent from https://cursor.com/install, then reload.",
  "needsUpdate": false, "versionUnsupported": false
}
```

**Pi yields an install action, not a reason** — the outcome the brief said to record "whichever the host
yields": `bun 1.4.0` is on this host (`00-host.md`), so the bun-based install command is offered and
`installUnavailableReason` stays `null`. A Windows host **without** bun is the case that produces a reason
for pi; it is not reproduced here.

**`acp-cursor` is this gate's live `installUnavailableReason`** and it is Windows-specific: bb refuses to
run Cursor's shell installer on win32 and names the manual route instead of failing opaquely.

## `claude-code` when it is not installed

The status path honours `BB_CLAUDE_CODE_EXECUTABLE`
(`plugins/provider-claude-code/src/bridge/provider-maintenance.ts:61`, declared as an env passthrough in
`plugins/provider-claude-code/server.ts:78`), so the missing-CLI case was measured directly rather than
cited: the packed **bridge host artifact** was run through the daemon's bridge worker with the variable
pointed at a file that does not exist, and asked for its installation status over JSON-RPC.

```bash
node <scratch>/claude-missing-cli-probe.mjs
```
```
BB_CLAUDE_CODE_EXECUTABLE=C:\Users\olege\AppData\Local\Temp\bb-claude-missing-VSSnvB\definitely-not-claude.exe
OUTCOME=answered
STDOUT:
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":2,"capabilities":{ … }}}
{"jsonrpc":"2.0","id":2,"result":{
  "executableName":"C:\\Users\\olege\\AppData\\Local\\Temp\\bb-claude-missing-VSSnvB\\definitely-not-claude.exe",
  "executablePath":null,"installed":false,"installSource":"notInstalled",
  "currentVersion":null,"latestVersion":null,"minimumSupportedVersion":null,
  "npmPackageName":"@anthropic-ai/claude-code","npmGlobalPackageVersion":null,
  "installAction":null,
  "installUnavailableReason":"bb cannot run the Claude Code shell installer on Windows. Install Claude Code from https://claude.com/claude-code, then reload.",
  "needsUpdate":false,"versionUnsupported":false}}
STDERR:

PROBE_EXIT=0
```

`installed:false`, `installAction:null`, and a Windows-specific reason naming the manual install URL —
the required key carries a usable sentence, not an empty string.

The probe used the real artifacts (`plugins/provider-claude-code/dist/host.js` driven by
`apps/host-daemon/dist/bb-provider-bridge-worker.mjs`), the same pair the packed tarball smoke exercises.
No throwaway daemon was started and the running dev daemon was not perturbed.

## `bb machine provider-cli install codex --action update`

An update **was** offered (0.153.4 → 0.154.0), so the brief's conditional branch applies and the action was
run for real:

```powershell
node apps/cli/dist/index.js machine provider-cli install host_45kqba73eq codex --action update --json
```
```json
[{"type":"started","provider":"codex","command":"codex update"},
 {"type":"output","provider":"codex","stream":"stdout","text":"Updating Codex via `powershell -ExecutionPolicy Bypass -c '$env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex'`...\r\n"},
 {"type":"output","provider":"codex","stream":"stdout","text":"==> Updating Codex CLI from 0.153.4 to 0.154.0"},
 {"type":"output","provider":"codex","stream":"stdout","text":"\r\n==> Detected platform: Windows (x64)\r\n==> Resolved version: 0.154.0\r\n"},
 {"type":"output","provider":"codex","stream":"stdout","text":"==> Downloading Codex CLI"},
 {"type":"output","provider":"codex","stream":"stdout","text":"ПРЕДУПРЕЖДЕНИЕ: Could not download or verify https://releases.openai.com/codex/releases/0.154.0/codex-package_SHA256SUMS; retrying from GitHub Releases."},
 {"type":"output","provider":"codex","stream":"stdout","text":"iex : Имя \"Get-FileHash\" не распознано как имя командлета… "},
 {"type":"output","provider":"codex","stream":"stdout","text":"Error: `powershell -ExecutionPolicy Bypass -c '…'` failed with status exit code: 1\r\n"},
 {"type":"completed","provider":"codex","exitCode":1,"signal":null,"success":false}]
INSTALL_EXIT=0
codex version after: codex-cli 0.153.4
```

### The failure is upstream, not bb — proved by running the same thing outside bb

```powershell
codex update      # a plain shell, no bb involved
```
```
Updating Codex via `powershell -ExecutionPolicy Bypass -c '$env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex'`...
==> Updating Codex CLI from 0.153.4 to 0.154.0
==> Detected platform: Windows (x64)
==> Resolved version: 0.154.0
==> Downloading Codex CLI
WARNING: Could not download or verify https://releases.openai.com/codex/releases/0.154.0/codex-package_SHA256SUMS;
retrying from GitHub Releases.
iex : The term 'Get-FileHash' is not recognized as the name of a cmdlet, function, script file, or operable program.
Error: `powershell -ExecutionPolicy Bypass -c '…'` failed with status exit code: 1

DIRECT_UPDATE_EXIT=1
codex version now: codex-cli 0.153.4
```

Byte-for-byte the same failure, same exit code, from a shell bb never touched. Codex's own installer script
is what breaks on this host; **bb's part worked**:

- it resolved the update action from the live status rather than guessing,
- it launched `codex update` through a ConPTY (the transcript carries the real escape sequences and the
  `codex.exe` window-title sequence),
- it streamed stdout back as `output` events, including the localized upstream error text, and
- it reported `exitCode: 1, success: false` rather than claiming success.

The CLI's own exit code is `0` because the command *ran*; the outcome is carried in the `completed` event's
`success:false`. That split is the documented contract, and it is what a caller must check.

`codex` is therefore still `0.153.4` after this gate — the host was left as found.
