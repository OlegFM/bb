# Project on `C:\` from the UI and the CLI (Phase 1 gate, Step 4)

Date: 2026-09-13 — HEAD `203acb2738135c9b7ab1e2824da949223aa0dbc1` — node v22.19.0 — pnpm 9.15.0
Dev instance: `work-bb-21d97a8d7c85`, data dir `C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85`
Dev server: `http://127.0.0.1:23813` — app `http://localhost:15813` — host daemon `http://127.0.0.1:31813`
(from `pnpm dev:status`, `EXIT=0`).

**UI substitution (controller ruling).** This agent has no interactive browser session on the reference
desktop, so every step the brief phrases as a UI action was performed through the same public HTTP API the
UI calls, with the exact request and response recorded below:

| brief's UI action | API call used instead |
|---|---|
| open Settings → Machines and read the machine's platform label | `GET /api/v1/system/config` → `primaryHostPlatform`, mapped by `apps/app/src/components/settings/MachinesSettingsSection.tsx`'s `PLATFORM_LABELS` |
| add a project by browsing to `C:\Users\olege\Work\phase1-ui` | `POST /api/v1/projects` with `{ name, source: { type: "local_path", hostId, path } }` — the body `createProjectRequestSchema` in `packages/server-contract/src/api/projects.ts` defines and the UI's project-create form posts |

## Scratch repositories

Created hook-less with one commit each (a fresh `git init` installs only the inert `.sample` hooks; the
commits were made with `-c core.hooksPath=` so no repo-level or global hook could run):

```bash
for n in phase1-ui phase1-cli; do d="/c/Users/olege/Work/$n"; rm -rf "$d"; git init -q "$d"; printf '# %s\n' "$n" > "$d/README.md"; git -C "$d" -c core.hooksPath= add README.md; git -C "$d" -c core.hooksPath= -c user.name="Phase1 QA" -c user.email="olegefm@gmail.com" commit -q -m "Initial commit"; echo "--- $n ---"; git -C "$d" log --oneline; git -C "$d" rev-parse --abbrev-ref HEAD; done
```
```
warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
--- phase1-ui ---
23433db Initial commit
master
warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
--- phase1-cli ---
fafed5a Initial commit
master
```

## Machines label and host

```powershell
$r = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/hosts" -Method Get; $r | ConvertTo-Json -Depth 6
```
```
{
  "id": "host_45kqba73eq",
  "name": "OMEN",
  "status": "connected",
  "type": "persistent",
  "maxPermissionMode": "full",
  "lastSeenAt": 1789296080718,
  "lastRejectedProtocolVersion": null,
  "createdAt": 1789148926030,
  "updatedAt": 1789296080718
}
```

```powershell
$c = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/system/config" -Method Get; [pscustomobject]@{ primaryHostId = $c.primaryHostId; primaryHostPlatform = $c.primaryHostPlatform } | ConvertTo-Json
```
```
{
  "primaryHostId": "host_45kqba73eq",
  "primaryHostPlatform": "win32"
}
```

The API's platform value is **`win32`**; `PLATFORM_LABELS` in `MachinesSettingsSection.tsx` maps `win32` to
the Machines settings label **`Windows`**, which is what the UI renders for this machine (`OMEN`,
`host_45kqba73eq`, the primary host).

## Project added "from the UI" (API substitution)

Command (PowerShell 7.6.5; the request body is echoed first, then the response):

```powershell
$body = '{"name":"phase1-ui","source":{"type":"local_path","hostId":"host_45kqba73eq","path":"C:\\Users\\olege\\Work\\phase1-ui"}}'; $body; try { $p = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/projects" -Method Post -ContentType "application/json" -Body $body; $p | ConvertTo-Json -Depth 6 } catch { "HTTP " + $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```

Output:

```
{"name":"phase1-ui","source":{"type":"local_path","hostId":"host_45kqba73eq","path":"C:\\Users\\olege\\Work\\phase1-ui"}}
{
  "id": "proj_x4gdw7vz68",
  "kind": "standard",
  "name": "phase1-ui",
  "gitRemoteUrl": null,
  "createdAt": 1789296184785,
  "updatedAt": 1789296184785,
  "sources": [
    {
      "id": "src_hcc6h4h2ax",
      "projectId": "proj_x4gdw7vz68",
      "type": "local_path",
      "hostId": "host_45kqba73eq",
      "path": "C:\\Users\\olege\\Work\\phase1-ui",
      "isDefault": true,
      "createdAt": 1789296184785,
      "updatedAt": 1789296184785
    }
  ]
}
```

Read back with the brief's `GET /projects/<id>`:

```powershell
$g = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/projects/proj_x4gdw7vz68" -Method Get; $g | ConvertTo-Json -Depth 6
```
```
{
  "id": "proj_x4gdw7vz68",
  "kind": "standard",
  "name": "phase1-ui",
  "gitRemoteUrl": null,
  "createdAt": 1789296184785,
  "updatedAt": 1789296184785,
  "sources": [
    {
      "id": "src_hcc6h4h2ax",
      "projectId": "proj_x4gdw7vz68",
      "type": "local_path",
      "hostId": "host_45kqba73eq",
      "path": "C:\\Users\\olege\\Work\\phase1-ui",
      "isDefault": true,
      "createdAt": 1789296184785,
      "updatedAt": 1789296184785
    }
  ]
}
```

Project id **`proj_x4gdw7vz68`**, stored source path **`C:\Users\olege\Work\phase1-ui`** — drive-absolute,
native separators, no trailing separator.

## Project created from the CLI

```powershell
$env:BB_SERVER_URL = "http://127.0.0.1:23813"; pnpm exec turbo run build --filter=@bb/cli --output-logs=errors-only 2>&1 | Select-Object -Last 8; "EXIT=$LASTEXITCODE"
```
```
   • Running build in 1 packages
   • Remote caching disabled


 Tasks:    4 successful, 4 total
Cached:    4 cached, 4 total
  Time:    110ms >>> FULL TURBO

EXIT=0
```

### Deviation: the brief's `node apps/cli/bin/bb …` cannot run on Windows

`apps/cli/bin/bb` is a POSIX `#!/bin/sh` wrapper, not a JavaScript entry point, so `node` cannot execute it:

```powershell
$env:BB_SERVER_URL = "http://127.0.0.1:23813"; node apps/cli/bin/bb project create --name phase1-cli --root C:\Users\olege\Work\phase1-cli --json 2>&1 | Out-String -Stream | Select-Object -First 3; "EXIT=$LASTEXITCODE"; "--- head of the wrapper ---"; Get-Content apps/cli/bin/bb -TotalCount 3
```
```
file:///C:/Users/olege/Work/bb/apps/cli/bin/bb:2
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
                        ^^
EXIT=
--- head of the wrapper ---
#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLI_ENTRY="$SCRIPT_DIR/../dist/index.js"
```

Its exit code, captured without the pipeline that swallows `$LASTEXITCODE`:

```powershell
$env:BB_SERVER_URL = "http://127.0.0.1:23813"; node apps/cli/bin/bb project create --name phase1-cli --root C:\Users\olege\Work\phase1-cli --json > $null 2>&1; "EXIT=$LASTEXITCODE"
```
```
EXIT=1
```

This is a property of the brief's command line, not a product regression: the wrapper exists to *find or
build* `apps/cli/dist/index.js` and then `exec node` on it. The equivalent Windows invocation is to run that
entry directly. (On Windows the `bb` command a user actually gets comes from the package's `bin` shim, which
npm/pnpm materialise as `bb.cmd`/`bb.ps1`; `bin/bb` is the POSIX-only half of that pair.)

### Equivalent CLI invocation

The CLI resolves the project's source machine through the local host daemon, so it needs the dev instance's
daemon port as well as its server URL. `docs/debugging-and-qa.md` documents exactly this:
`pnpm --silent dev:app env --powershell | Out-String | Invoke-Expression`.

```powershell
pnpm --silent dev:app env --powershell | Out-String | Invoke-Expression; node apps/cli/dist/index.js project create --name phase1-cli --root C:\Users\olege\Work\phase1-cli --json; "EXIT=$LASTEXITCODE"
```
```
{
  "id": "proj_j3jwwb7f8v",
  "kind": "standard",
  "name": "phase1-cli",
  "gitRemoteUrl": null,
  "createdAt": 1789296268376,
  "updatedAt": 1789296268376,
  "sources": [
    {
      "id": "src_v3crtpycxb",
      "projectId": "proj_j3jwwb7f8v",
      "type": "local_path",
      "hostId": "host_45kqba73eq",
      "path": "C:\\Users\\olege\\Work\\phase1-cli",
      "isDefault": true,
      "createdAt": 1789296268376,
      "updatedAt": 1789296268376
    }
  ]
}
EXIT=0
```

Without the daemon port the same command fails with `Error: Cannot reach local host daemon. Is it running?`
and `EXIT=1` — recorded here so the dependency is explicit, not as a defect.

## Result

Both projects exist with drive-absolute, native-separator paths:

```powershell
(Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/projects" -Method Get) | ForEach-Object { "{0}  {1}  {2}" -f $_.id, $_.name, ($_.sources | ForEach-Object { $_.path }) }
```
```
proj_x4gdw7vz68  phase1-ui  C:\Users\olege\Work\phase1-ui
proj_j3jwwb7f8v  phase1-cli  C:\Users\olege\Work\phase1-cli
```

## Cleanup

The two scratch repositories `C:\Users\olege\Work\phase1-ui` and `C:\Users\olege\Work\phase1-cli` were
deleted at the end of this task, after all evidence above was recorded. The deletion command and its output
are in `00-host.md`, together with the rest of the dev-instance state this task left behind.
