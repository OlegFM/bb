# Path identity (Phase 1 gate, Step 5)

Date: 2026-09-13 — HEAD `203acb2738135c9b7ab1e2824da949223aa0dbc1`
Dev server `http://127.0.0.1:23813`, host `host_45kqba73eq` (`OMEN`, `primaryHostPlatform: win32`).
Starting state: `phase1-ui` already exists as `proj_x4gdw7vz68` with stored path
`C:\Users\olege\Work\phase1-ui` (Step 4).

All four requests below use the same PowerShell helper, so the request body printed above each response is
the exact JSON that was posted. The request shape is `createProjectRequestSchema` from
`packages/server-contract/src/api/projects.ts` (`{ name, source: { type: "local_path", hostId, path } }`).

```powershell
function Try-Create($name, $p) { $body = (@{ name = $name; source = @{ type = "local_path"; hostId = "host_45kqba73eq"; path = $p } } | ConvertTo-Json -Depth 5 -Compress); "REQUEST: $body"; try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/projects" -Method Post -ContentType "application/json" -Body $body; "RESPONSE 200/201:"; $r | ConvertTo-Json -Depth 6 } catch { "RESPONSE HTTP " + $_.Exception.Response.StatusCode.value__ + ":"; $_.ErrorDetails.Message } }
```

## 1. Forward slashes — `C:/Users/olege/Work/phase1-ui`

```powershell
Try-Create "phase1-ui-slash" "C:/Users/olege/Work/phase1-ui"
```
```
REQUEST: {"source":{"hostId":"host_45kqba73eq","type":"local_path","path":"C:/Users/olege/Work/phase1-ui"},"name":"phase1-ui-slash"}
RESPONSE 200/201:
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

## 2. Trailing separator — `C:\Users\olege\Work\phase1-ui\`

```powershell
Try-Create "phase1-ui-trailing" "C:\Users\olege\Work\phase1-ui\"
```
```
REQUEST: {"name":"phase1-ui-trailing","source":{"hostId":"host_45kqba73eq","type":"local_path","path":"C:\\Users\\olege\\Work\\phase1-ui\\"}}
RESPONSE 200/201:
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

## 3. Mixed case — `c:\users\olege\work\PHASE1-UI`

```powershell
Try-Create "phase1-ui-lower" "c:\users\olege\work\PHASE1-UI"
```
```
REQUEST: {"name":"phase1-ui-lower","source":{"hostId":"host_45kqba73eq","type":"local_path","path":"c:\\users\\olege\\work\\PHASE1-UI"}}
RESPONSE 200/201:
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

## 4. UNC path — `\\server\share\repo`

```powershell
Try-Create "phase1-unc" "\\server\share\repo"
```
```
REQUEST: {"name":"phase1-unc","source":{"path":"\\\\server\\share\\repo","hostId":"host_45kqba73eq","type":"local_path"}}
RESPONSE HTTP 400:

{
  "code": "invalid_request",
  "message": "UNC and device paths are not supported. Use a drive-letter path like C:\\Users\\me\\repo."
}
```

## Result

All three spellings of the same directory resolve to the **one** project `proj_x4gdw7vz68`, whose stored
source path stays the canonical `C:\Users\olege\Work\phase1-ui` (drive letter upper-cased, separators
normalised to `\`, trailing separator dropped, name case preserved from the first registration). None of the
three requests created a second project, and none of them rewrote the stored path — confirmed by listing
the projects afterwards:

```powershell
(Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/projects" -Method Get) | ForEach-Object { "{0}  {1}  {2}" -f $_.id, $_.name, ($_.sources | ForEach-Object { $_.path }) }
```
```
proj_x4gdw7vz68  phase1-ui  C:\Users\olege\Work\phase1-ui
proj_j3jwwb7f8v  phase1-cli  C:\Users\olege\Work\phase1-cli
```

The UNC spelling is refused at the request boundary with HTTP **400** and code **`invalid_request`**, as the
brief expects.

---

# Gate refresh at `e976524b488483fd583de42c8dce13ac6d6ac0cd` (2026-09-13)

Re-measured because `94f5c40eb` changed `UNSUPPORTED_UNC_PROJECT_PATH_MESSAGE` in
`packages/domain/src/project-path.ts` — the old text named a drive-letter path as the only remedy, which is
wrong for POSIX users — so the 400 body recorded above is no longer the text the server returns. The three
identity spellings were re-run at the same time to confirm the refactor in that commit
(`isBareDriveHostPath` moving into `@bb/domain`, `isWindowsHostPath` becoming module-private) changed
nothing about them.

Same dev instance and host as above (`http://127.0.0.1:23813`, `host_45kqba73eq`), same helper function,
project `proj_x4gdw7vz68` already present with stored path `C:\Users\olege\Work\phase1-ui`.

```powershell
function Try-Create($name, $p) { $body = (@{ name = $name; source = @{ type = "local_path"; hostId = "host_45kqba73eq"; path = $p } } | ConvertTo-Json -Depth 5 -Compress); "REQUEST: $body"; try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/projects" -Method Post -ContentType "application/json" -Body $body; "RESPONSE 200/201: id=" + $r.id + " path=" + ($r.sources | ForEach-Object { $_.path }) } catch { "RESPONSE HTTP " + $_.Exception.Response.StatusCode.value__ + ":"; $_.ErrorDetails.Message } }; Try-Create "phase1-ui-slash" "C:/Users/olege/Work/phase1-ui"; Try-Create "phase1-ui-trailing" "C:\Users\olege\Work\phase1-ui\"; Try-Create "phase1-ui-lower" "c:\users\olege\work\PHASE1-UI"; Try-Create "phase1-unc" "\\server\share\repo"
```
```
REQUEST: {"name":"phase1-ui-slash","source":{"type":"local_path","hostId":"host_45kqba73eq","path":"C:/Users/olege/Work/phase1-ui"}}
RESPONSE 200/201: id=proj_x4gdw7vz68 path=C:\Users\olege\Work\phase1-ui
REQUEST: {"name":"phase1-ui-trailing","source":{"type":"local_path","hostId":"host_45kqba73eq","path":"C:\\Users\\olege\\Work\\phase1-ui\\"}}
RESPONSE 200/201: id=proj_x4gdw7vz68 path=C:\Users\olege\Work\phase1-ui
REQUEST: {"name":"phase1-ui-lower","source":{"type":"local_path","hostId":"host_45kqba73eq","path":"c:\\users\\olege\\work\\PHASE1-UI"}}
RESPONSE 200/201: id=proj_x4gdw7vz68 path=C:\Users\olege\Work\phase1-ui
REQUEST: {"name":"phase1-unc","source":{"type":"local_path","hostId":"host_45kqba73eq","path":"\\\\server\\share\\repo"}}
RESPONSE HTTP 400:

{
  "code": "invalid_request",
  "message": "UNC and device paths (\\\\server\\share, //server/share) are not supported. Use an absolute path on the machine, such as /home/me/repo or C:\\Users\\me\\repo."
}
```

## Result at this head

Unchanged in substance: all three spellings still resolve to the single project `proj_x4gdw7vz68` with the
canonical stored path `C:\Users\olege\Work\phase1-ui`, and the UNC spelling is still refused with HTTP
**400** / `invalid_request`. The only difference is the refusal text, which now names both path flavours
instead of only a drive-letter path:

| | message |
|---|---|
| at `203acb273` | `UNC and device paths are not supported. Use a drive-letter path like C:\Users\me\repo.` |
| at `e976524b4` | `UNC and device paths (\\server\share, //server/share) are not supported. Use an absolute path on the machine, such as /home/me/repo or C:\Users\me\repo.` |


---

# Gate refresh 3 at `c3e4a8590` (2026-09-14)

Re-measured because the POSIX-parity round rewrote the whole canonicalization path: `783b01ac1` stopped
sending `host.canonicalize_path` to non-win32 hosts (the server shapes the path locally for them) and
restored the pre-port refusal messages, and `c3e4a8590` narrowed the degradation catch so that only a host
**RPC transport** failure falls back to the normalized spelling. Two cases the earlier rounds did not cover
were added: a path that does not exist on disk, and a POSIX-shaped path sent to a win32 host.

Same dev instance and host (`http://127.0.0.1:23813`, `host_45kqba73eq` = `OMEN`, `connected`,
`primaryHostPlatform: win32`), same helper function, projects `proj_x4gdw7vz68` (`phase1-ui`) and
`proj_tqqsn3xw8q` (`phase1-missing`) already present.

```powershell
function Try-Create($name, $p) { $body = (@{ name = $name; source = @{ type = "local_path"; hostId = "host_45kqba73eq"; path = $p } } | ConvertTo-Json -Depth 5 -Compress); "REQUEST: $body"; try { $r = Invoke-RestMethod -Uri "$env:BB_SERVER_URL/api/v1/projects" -Method Post -ContentType "application/json" -Body $body; "RESPONSE 200/201: id=" + $r.id + " path=" + ($r.sources | ForEach-Object { $_.path }) } catch { "RESPONSE HTTP " + $_.Exception.Response.StatusCode.value__ + ":"; $_.ErrorDetails.Message } }; Try-Create "phase1-ui-slash" "C:/Users/olege/Work/phase1-ui"; Try-Create "phase1-ui-trailing" "C:\Users\olege\Work\phase1-ui\"; Try-Create "phase1-ui-lower" "c:\users\olege\work\PHASE1-UI"; Try-Create "phase1-unc" "\\server\share\repo"; Try-Create "phase1-missing" "C:\Users\olege\Work\phase1-missing"; Try-Create "phase1-posix-shaped" "/tmp/phase1-posix-shaped"
```
```
REQUEST: {"source":{"type":"local_path","path":"C:/Users/olege/Work/phase1-ui","hostId":"host_45kqba73eq"},"name":"phase1-ui-slash"}
RESPONSE 200/201: id=proj_x4gdw7vz68 path=C:\Users\olege\Work\phase1-ui
REQUEST: {"source":{"type":"local_path","path":"C:\\Users\\olege\\Work\\phase1-ui\\","hostId":"host_45kqba73eq"},"name":"phase1-ui-trailing"}
RESPONSE 200/201: id=proj_x4gdw7vz68 path=C:\Users\olege\Work\phase1-ui
REQUEST: {"source":{"type":"local_path","path":"c:\\users\\olege\\work\\PHASE1-UI","hostId":"host_45kqba73eq"},"name":"phase1-ui-lower"}
RESPONSE 200/201: id=proj_x4gdw7vz68 path=C:\Users\olege\Work\phase1-ui
REQUEST: {"source":{"type":"local_path","path":"\\\\server\\share\\repo","hostId":"host_45kqba73eq"},"name":"phase1-unc"}
RESPONSE HTTP 400:

{
  "code": "invalid_request",
  "message": "UNC and device paths (\\\\server\\share) are not supported. Use an absolute path on the machine, such as /home/me/repo or C:\\Users\\me\\repo."
}
REQUEST: {"source":{"type":"local_path","path":"C:\\Users\\olege\\Work\\phase1-missing","hostId":"host_45kqba73eq"},"name":"phase1-missing"}
RESPONSE 200/201: id=proj_tqqsn3xw8q path=C:\Users\olege\Work\phase1-missing
REQUEST: {"source":{"type":"local_path","path":"/tmp/phase1-posix-shaped","hostId":"host_45kqba73eq"},"name":"phase1-posix-shaped"}
RESPONSE HTTP 400:

{
  "code": "invalid_path",
  "message": "Path \u0022/tmp/phase1-posix-shaped\u0022 must be a drive-absolute path such as C:\\Users\\me\\repo",
  "retryable": false
}
```

## 1–3. The three spellings still collapse to one project

Unchanged from every earlier round: forward slashes, a trailing separator and mixed case all return
`proj_x4gdw7vz68` with the canonical stored path `C:\Users\olege\Work\phase1-ui`. No new project row was
created by any of the six requests — the `project_sources` table still holds exactly three rows:

```powershell
node packages/db/read-rows.mjs "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\bb.db" sources
```
```json
[
  {
    "id": "src_dz7wnaemnu",
    "project_id": "proj_tqqsn3xw8q",
    "host_id": "host_45kqba73eq",
    "type": "local_path",
    "path": "C:\\Users\\olege\\Work\\phase1-missing",
    "path_key": "c:/users/olege/work/phase1-missing",
    "is_default": 1
  },
  {
    "id": "src_v3crtpycxb",
    "project_id": "proj_j3jwwb7f8v",
    "host_id": "host_45kqba73eq",
    "type": "local_path",
    "path": "C:\\Users\\olege\\Work\\phase1-cli",
    "path_key": "c:/users/olege/work/phase1-cli",
    "is_default": 1
  },
  {
    "id": "src_hcc6h4h2ax",
    "project_id": "proj_x4gdw7vz68",
    "host_id": "host_45kqba73eq",
    "type": "local_path",
    "path": "C:\\Users\\olege\\Work\\phase1-ui",
    "path_key": "c:/users/olege/work/phase1-ui",
    "is_default": 1
  }
]
```

`path` keeps the native spelling; `path_key` is the lower-cased forward-slash key. That is the Phase 1
path-identity rule, still holding.

## 4. UNC — the message narrowed again

Still HTTP **400** / `invalid_request`, but the POSIX-parity round removed the `//server/share` half of the
example, because on POSIX `//server/share` is an ordinary absolute path and naming it as unsupported was
itself a behaviour change:

| head | message |
|---|---|
| `203acb273` | `UNC and device paths are not supported. Use a drive-letter path like C:\Users\me\repo.` |
| `e976524b4` | `UNC and device paths (\\server\share, //server/share) are not supported. Use an absolute path on the machine, such as /home/me/repo or C:\Users\me\repo.` |
| `c3e4a8590` | `UNC and device paths (\\server\share) are not supported. Use an absolute path on the machine, such as /home/me/repo or C:\Users\me\repo.` |

## 5. A path that does not exist on disk is still accepted

`C:\Users\olege\Work\phase1-missing` does **not** exist in the filesystem — it was deleted at the end of an
earlier round and was not recreated:

```powershell
Test-Path C:\Users\olege\Work\phase1-missing
```
```
False
```

The request nevertheless returns **200** with the existing project `proj_tqqsn3xw8q` and the stored path
`C:\Users\olege\Work\phase1-missing`. This is the load-bearing check for the user's rule that the port must
not add validation: an earlier round's `realpath`/existence check would have refused this, and `0f2424510`
made those win32-only and best-effort. Creating a project for a directory that is not there yet behaves
exactly as it did before the port.

## 6. A POSIX-shaped path sent to a win32 host — refused by the daemon

`/tmp/phase1-posix-shaped` is a perfectly good path on Linux and a meaningless one on this Windows host.
The request is refused with HTTP **400**, code **`invalid_path`**, `retryable: false`:

```
{
  "code": "invalid_path",
  "message": "Path \u0022/tmp/phase1-posix-shaped\u0022 must be a drive-absolute path such as C:\\Users\\me\\repo",
  "retryable": false
}
```

(The `\u0022` are PowerShell's rendering of the double quotes around the path in the JSON body.)

**The refusal came from the host daemon, not from the server.** The daemon's own log records the RPC and its
outcome:

```
@bb/host-daemon:dev: [10:30:15] DEBUG: [host-daemon] Online host RPC {"serverUrl":"http://127.0.0.1:23813","commandType":"host.canonicalize_path","errorCode":"invalid_path","handlerMs":0.7,"ok":false}
```

That matches the code path `c3e4a8590` settled on, in
`apps/server/src/services/hosts/host-paths.ts:42-72`:

- a host whose daemon platform is not `win32` never reaches the RPC at all —
  `if (deps.hub.getDaemonPlatformForHost(args.hostId) !== "win32") return shapeCanonicalHostPath(args.path);`
- a win32 host calls `host.canonicalize_path`;
- an `invalid_path` answer from the daemon is re-thrown to the caller verbatim
  (`if (error.body.code === "invalid_path") throw invalidHostPath(error.body.message);`);
- **only** another ApiError code — an RPC transport failure — logs
  `"Host path canonicalization failed; storing the normalized spelling"` and degrades to the local shape.

So the shape refusal is a genuine host answer, and the degradation path cannot swallow it.

## Result at this head

All six cases behave as the phase intends:

| case | input | result |
|---|---|---|
| 1 | `C:/Users/olege/Work/phase1-ui` | 200 → `proj_x4gdw7vz68`, `C:\Users\olege\Work\phase1-ui` |
| 2 | `C:\Users\olege\Work\phase1-ui\` | 200 → `proj_x4gdw7vz68`, same stored path |
| 3 | `c:\users\olege\work\PHASE1-UI` | 200 → `proj_x4gdw7vz68`, same stored path |
| 4 | `\\server\share\repo` | 400 `invalid_request`, names only `\\server\share` |
| 5 | `C:\Users\olege\Work\phase1-missing` (not on disk) | 200 → `proj_tqqsn3xw8q` — no existence check |
| 6 | `/tmp/phase1-posix-shaped` on a win32 host | 400 `invalid_path` from the daemon |

Step 5 **PASSES** at `c3e4a8590`.
