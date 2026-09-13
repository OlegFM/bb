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

