# Managed worktree provisioning and removal (Phase 1 gate, Step 6) — BLOCKED

Date: 2026-09-13 — HEAD `203acb2738135c9b7ab1e2824da949223aa0dbc1`
Dev server `http://127.0.0.1:23813`, host `host_45kqba73eq` (`primaryHostPlatform: win32`),
data dir `C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85`, project `phase1-ui` = `proj_x4gdw7vz68`.

**UI substitution (controller ruling).** "Start a thread in the `phase1-ui` project with the Worktree
environment provider" was attempted through `POST /api/v1/threads` — the route the UI's thread composer
posts to — with `environment.type = "provider"` and `environmentProviderId = "git-worktree"`, and again
through the `bb` CLI. Both are recorded verbatim below.

**Outcome: the step could not be executed.** No environment was created, so there is nothing to show
provisioned or removed. The cause is a Windows-specific path-separator defect in the server's plugin
manifest loader that makes **every bundled agent-provider plugin fail to load on native Windows**, which in
turn makes thread creation impossible. Details and the exact root cause are below.

## The Worktree environment provider itself is registered and running

```powershell
(Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/system/environment-providers" -Method Get) | ConvertTo-Json -Depth 5
```

Excerpt:

```
    {
      "id": "git-worktree",
      "displayName": "Worktree",
      "icon": "FolderGit",
      "logoUrl": null,
      "pluginId": "environment-git-worktree",
      "requires": {
        "projectCheckout": true,
        "gitCheckout": true,
        "gitRemote": false,
        "projectless": false
      },
      ...
      "acceptsEmptyInputs": true,
      "availability": null,
      "machineAvailability": {}
    },
```

The plugin listing confirms it is enabled and running:

```powershell
$raw = Invoke-WebRequest -Uri "http://127.0.0.1:23813/api/v1/plugins" -Method Get; $j = $raw.Content | ConvertFrom-Json; "count=" + $j.plugins.Count; $j.plugins | ForEach-Object { "{0} | enabled={1} | status={2}" -f $_.id, $_.enabled, $_.status }
```
```
count=22
account-pool | enabled=False | status=disabled
ask-user-question | enabled=False | status=disabled
automations | enabled=True | status=running
bb-guide | enabled=True | status=running
concurrency-limit | enabled=True | status=running
connect | enabled=True | status=running
custom-instructions | enabled=True | status=running
environment-git-worktree | enabled=True | status=running
environment-personal-workspace | enabled=True | status=running
environment-project-checkout | enabled=True | status=running
inline-vis | enabled=True | status=running
keep-awake | enabled=True | status=running
monaco-editor | enabled=False | status=disabled
pdf-preview | enabled=True | status=running
plugin-api-tester | enabled=False | status=disabled
provider-retry | enabled=True | status=running
provider-usage | enabled=False | status=disabled
push-notifications | enabled=True | status=running
scheduled-send | enabled=True | status=running
secrets | enabled=True | status=running
side-chat | enabled=True | status=running
workflows | enabled=False | status=disabled
```

Note what is **absent**: `provider-claude-code`, `provider-codex`, `provider-pi`, `provider-acp` — every
bundled agent provider — and `plugin-api-docs`.

## Thread creation is refused: no agent provider

### Through the API (the UI's own route)

```powershell
$body = '{"projectId":"proj_x4gdw7vz68","origin":"sdk","title":"Phase 1 worktree check","input":[{"type":"text","text":"Phase 1 managed worktree provisioning check."}],"environment":{"type":"provider","environmentProviderId":"git-worktree","machine":{"type":"existing","hostId":"host_45kqba73eq"},"inputs":null}}'; $body; try { $t = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/threads" -Method Post -ContentType "application/json" -Body $body; $t | ConvertTo-Json -Depth 4 } catch { "HTTP " + $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```
```
{"projectId":"proj_x4gdw7vz68","origin":"sdk","title":"Phase 1 worktree check","input":[{"type":"text","text":"Phase 1 managed worktree provisioning check."}],"environment":{"type":"provider","environmentProviderId":"git-worktree","machine":{"type":"existing","hostId":"host_45kqba73eq"},"inputs":null}}
HTTP 409

{
  "code": "no_provider_available",
  "message": "No agent provider is enabled. Enable an agent provider plugin in Settings \u2192 Plugins to start a thread."
}
```

### Through the CLI

```powershell
pnpm --silent dev:app env --powershell | Out-String | Invoke-Expression; node apps/cli/dist/index.js provider list --json 2>&1 | Select-Object -First 10; "EXIT_PROVIDERS=$LASTEXITCODE"; node apps/cli/dist/index.js thread spawn --project proj_x4gdw7vz68 --environment-provider git-worktree --title "Phase 1 worktree check" --prompt "Phase 1 managed worktree provisioning check." --json 2>&1 | Select-Object -First 10; "EXIT_SPAWN=$LASTEXITCODE"
```
```
[]
EXIT_PROVIDERS=0
Error: Failed to create thread: HTTP 409: No agent provider is enabled. Enable an agent provider plugin in Settings → Plugins to start a thread.
EXIT_SPAWN=1
```

`GET /api/v1/system/providers` returns `[]` (verified separately with `Invoke-WebRequest`, status `200`,
body `[]`).

There is no other route that creates an environment: the public API exposes only
`GET /environments`, `GET/PATCH/DELETE /environments/:id` and `POST /environments/:id/actions`, and
`bb environment --help` lists no `create` — environments are created only as part of thread creation.

## Root cause: a POSIX path separator in the plugin manifest asset guard

The dev server log for this instance
(`C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\dev-app\dev.log`) shows why the provider plugins are missing:

```bash
grep -i "symlink" "/c/Users/olege/.bb-dev/work-bb-21d97a8d7c85/dev-app/dev.log"; echo "EXIT=$?"
```
```
@bb/server:dev: [13:39:13] WARN: [server] bundled plugin provider-codex is unavailable: manifest bb.branding.icon escapes the plugin directory through a symlink
@bb/server:dev: [13:39:13] WARN: [server] bundled plugin provider-claude-code is unavailable: manifest bb.branding.icon escapes the plugin directory through a symlink
@bb/server:dev: [13:39:13] WARN: [server] bundled plugin provider-pi is unavailable: manifest bb.branding.icon escapes the plugin directory through a symlink
@bb/server:dev: [13:39:13] WARN: [server] bundled plugin provider-acp is unavailable: manifest bb.branding.icon escapes the plugin directory through a symlink
@bb/server:dev: [13:39:13] WARN: [server] bundled plugin plugin-api-docs is unavailable: manifest bb.branding.icon escapes the plugin directory through a symlink
EXIT=0
```

Installing one explicitly reproduces it through the public install route:

```powershell
$body = '{"source":"C:\\Users\\olege\\Work\\bb\\plugins\\provider-claude-code"}'; try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/plugins/install" -Method Post -ContentType "application/json" -Body $body; "ok=" + $r.ok + " id=" + $r.plugin.id } catch { "HTTP " + $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```
```
HTTP 422

{
  "ok": false,
  "error": "manifest bb.branding.icon escapes the plugin directory through a symlink"
}
```

The icon is **not** a symlink. It is an ordinary blob in the index and an ordinary file on disk:

```bash
ls -la plugins/provider-claude-code/icons/ 2>/dev/null; echo "==="; git ls-files -s plugins/provider-claude-code/icons/ | head
```
```
total 8
drwxr-xr-x 1 olege 197609    0 Sep 11 14:00 .
drwxr-xr-x 1 olege 197609    0 Sep 13 09:27 ..
-rw-r--r-- 1 olege 197609 2033 Sep 11 14:00 claude-code.svg
===
100644 544792729ed5b104b82b68cf5fcdd169b58618bc 0	plugins/provider-claude-code/icons/claude-code.svg
```

The guard is in `apps/server/src/services/plugins/manifest.ts`, twice — once for
`bb.branding.icon` / `bb.branding.logo.light` / `bb.branding.logo.dark` (line 176) and once for
`bb.branding.experimental_icons[…]` (line 204):

```ts
    if (realAsset !== realRoot && !realAsset.startsWith(realRoot + "/")) {
      throw new Error(
        `manifest ${label} escapes the plugin directory through a symlink`,
      );
    }
```

`realpath()` returns native separators on Windows, so `realRoot + "/"` is never a prefix of `realAsset` and
the guard misfires on every plugin whose manifest points at an asset file. Demonstrated directly (script
kept in this task's scratch directory as `repro-icon-guard.mjs`):

```powershell
node <scratch>\repro-icon-guard.mjs; "EXIT=$LASTEXITCODE"
```
```
realRoot                        = C:\Users\olege\Work\bb\plugins\provider-claude-code
realAsset                       = C:\Users\olege\Work\bb\plugins\provider-claude-code\icons\claude-code.svg
asset lstat().isSymbolicLink()  = false
realAsset === realRoot          = false
realAsset.startsWith(realRoot + "/")       = false
realAsset.startsWith(realRoot + path.sep)  = true
EXIT=0
```

The same guard in `packages/plugin-build/src/plugin-manifest.ts` (lines 79 and 111) already uses the
platform separator — `!realAsset.startsWith(realRoot + sep)` — having been corrected in Phase 0 by commits
`97a029511` ("Compare plugin manifest paths with the platform separator") and `13ab2be17` ("Use the platform
separator in every plugin-build containment check"). Its twin in the server was never updated: the last
commits to `apps/server/src/services/plugins/manifest.ts` are `385cfa339`, `8b2213625` and `e42a4ef48`, none
of them separator work. So this is the one remaining copy of a bug the project has already recognised and
fixed elsewhere.

Every bundled agent provider declares a file-path branding icon, so all four are affected:

```bash
for p in provider-codex provider-pi provider-acp; do sed -n '/"bb": {/,/^  }/p' plugins/$p/package.json; done
```
```
"branding": { "icon": "./icons/codex.svg" }
"branding": { "icon": "./icons/pi.svg" }
"branding": { "icon": "./icons/acp.svg", "experimental_icons": { "cursor": "./icons/cursor.svg", ... } }
```
(`provider-claude-code` declares `"icon": "./icons/claude-code.svg"`.)

The `examples/plugins/echo-provider` fixture fails the same way
(`manifest bb.branding.experimental_icons["receipt"] escapes the plugin directory through a symlink`,
HTTP 422). `tests/scripted-echo-provider` installs successfully — its manifest names a Lucide icon
(`"icon": "Zap"`) rather than a file — but it registers no agent provider (`providerIds: []`; its
`server.ts` is an empty plugin function and its provider bridge is wired up only by the server test
harness), so it does not unblock thread creation. That plugin was uninstalled again at the end of this task.

## Not a Phase 1 regression

The defect predates this branch. `385cfa339`, the last commit to touch
`apps/server/src/services/plugins/manifest.ts`, is an ancestor of `windows-native/phase-0`
(`git merge-base --is-ancestor 385cfa339 windows-native/phase-0` succeeds), and the file at the Phase 0 head
`779b0a127` already carries both `realRoot + "/"` comparisons at lines 176 and 204:

```bash
git show 779b0a127:apps/server/src/services/plugins/manifest.ts | grep -n 'startsWith(realRoot'
```
```
176:    if (realAsset !== realRoot && !realAsset.startsWith(realRoot + "/")) {
204:    if (realAsset !== realRoot && !realAsset.startsWith(realRoot + "/")) {
```

Nothing in Phase 1 introduced it; Phase 1 is simply the first phase whose gate needs a thread to exist.

## Which phase owns this

Two readings are possible and the controller should rule between them; both are recorded here rather than
resolved by this task.

1. **Phase 1 owns it.** The defect itself is a path-handling seam — a hard-coded POSIX separator in a
   server-side path containment check — which is exactly Phase 1's subject matter, and the project has
   already fixed the identical line in `packages/plugin-build`. Under this reading Step 6 is a genuine gate
   failure.
2. **Phases 2–3 own it.** `docs/platform-windows.md` line 98 states that "terminals, hooks and provider
   launch on native Windows still arrive in Phases 2 and 3", and an agent provider is precisely what is
   missing here. Under this reading Step 6 depends on a capability the plan defers, and the gate should be
   judged on the other criteria.

What is not in doubt is the blast radius: on native Windows at this HEAD no agent provider plugin loads, so
**no thread can be started at all**, and consequently no environment of any kind (worktree, project
checkout or personal workspace) can be provisioned through the product. Whichever phase owns the fix, it is
a two-line change in one file (`realRoot + "/"` → `realRoot + sep` at lines 176 and 204) and it is what
stands between native Windows and a usable agent provider.

## What could not be recorded

Because no environment was ever created, none of the brief's Step 6 observations exist:

- the environment path from `GET /environments?projectId=proj_x4gdw7vz68` — the list is empty, and the
  managed worktree root does not exist:

  ```powershell
  $raw = Invoke-WebRequest -Uri "http://127.0.0.1:23813/api/v1/environments?projectId=proj_x4gdw7vz68" -Method Get; $raw.StatusCode; $raw.Content; "---"; Test-Path "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\worktrees"
  ```
  ```
  200
  []
  ---
  False
  ```

- `git -C C:\Users\olege\Work\phase1-ui worktree list` while an environment is live,
- `Test-Path` of `C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\worktrees\<key>\phase1-ui` before and after
  removal,
- the `destroyed` row after `DELETE /environments/<id>`.

The expected location is confirmed by code rather than by observation:
`apps/server/src/services/hosts/host-paths.ts` derives `managedWorkspaceRoots(dataDir)` as
`joinHostPath(dataDir, "worktrees")` and `joinHostPath(dataDir, "personal-workspaces")`, and
`docs/platform-windows.md` states managed worktrees and personal workspaces are derived with the host's
native separator under `%USERPROFILE%\.bb\worktrees`.

---

# Gate refresh at `e976524b488483fd583de42c8dce13ac6d6ac0cd` (2026-09-13) — Step 6 now PASSES

Everything above this line is the original measurement at `203acb273`, when this step was blocked. The
final fix round landed `94f5c40eb`, which contains exactly the change this file diagnosed:

```bash
grep -n 'startsWith(realRoot' apps/server/src/services/plugins/manifest.ts
```
```
176:    if (realAsset !== realRoot && !realAsset.startsWith(realRoot + sep)) {
204:    if (realAsset !== realRoot && !realAsset.startsWith(realRoot + sep)) {
```

The scratch repository was re-created identically (hook-less `git init`, one commit, `master`, `b96b1ec`);
the dev instance's project row `proj_x4gdw7vz68` → `C:\Users\olege\Work\phase1-ui` was still present and was
reused. The same UI substitution as before applies: the thread was created through `POST /api/v1/threads`,
the route the UI's composer posts to.

## The provider plugins now load

Dev app restarted at this head (`pnpm dev:app current` → `Branch: windows-native/phase-1 (e976524b4)`,
`Dev session: running`, `EXIT=0`).

```powershell
$raw = Invoke-WebRequest -Uri "http://127.0.0.1:23813/api/v1/plugins" -Method Get; $j = $raw.Content | ConvertFrom-Json; "count=" + $j.plugins.Count; $j.plugins | Where-Object { $_.id -match "provider|plugin-api-docs" } | ForEach-Object { "{0} | enabled={1} | status={2}" -f $_.id, $_.enabled, $_.status }
```
```
count=27
plugin-api-docs | enabled=False | status=disabled
provider-acp | enabled=True | status=running
provider-claude-code | enabled=True | status=running
provider-codex | enabled=True | status=running
provider-pi | enabled=True | status=running
provider-retry | enabled=True | status=running
provider-usage | enabled=False | status=disabled
```

27 plugins against 22 before — the five that the asset guard rejected (`provider-claude-code`,
`provider-codex`, `provider-pi`, `provider-acp`, `plugin-api-docs`) now load, and all four provider plugins
are enabled and running. `grep -i symlink` over this instance's fresh `dev.log` returns nothing.

```powershell
$p = (Invoke-WebRequest -Uri "http://127.0.0.1:23813/api/v1/system/providers" -Method Get).Content | ConvertFrom-Json; $p | ForEach-Object { "{0} | {1} | available={2}" -f $_.id, $_.displayName, $_.available }
```
```
codex | Codex | available=True
claude-code | Claude Code | available=True
pi | Pi | available=True
acp-cursor | Cursor | available=True
```

`GET /api/v1/system/providers` returned `[]` before the fix; four providers are available now.

## Thread creation with the Worktree provider

First attempt, with `inputs: null` as in the original section:

```
HTTP 400
{
  "code": "invalid_request",
  "message": "The \u0022git-worktree\u0022 environment provider needs inputs, and the request carried none"
}
```

The provider declares a default in its input schema (`{"branch": {"kind": "default"}}`), which the UI's
composer sends; supplying it succeeds:

```powershell
$body = '{"projectId":"proj_x4gdw7vz68","origin":"sdk","providerId":"codex","title":"Phase 1 worktree check","input":[{"type":"text","text":"Phase 1 managed worktree provisioning check."}],"environment":{"type":"provider","environmentProviderId":"git-worktree","machine":{"type":"existing","hostId":"host_45kqba73eq"},"inputs":{"branch":{"kind":"default"}}}}'; $body; try { $t = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/threads" -Method Post -ContentType "application/json" -Body $body; ($t | ConvertTo-Json -Depth 3) | Out-String -Stream | Select-Object -First 26 } catch { "HTTP " + $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```
```
{
  "id": "thr_hnyw5gyc3h",
  "projectId": "proj_x4gdw7vz68",
  "environmentId": null,
  "providerId": "codex",
  "title": "Phase 1 worktree check",
  "titleFallback": "Phase 1 managed worktree provisioning check.",
  "sectionId": null,
  "status": "starting",
  ...
}
```

## The environment reaches `ready`

```powershell
(Invoke-WebRequest -Uri "http://127.0.0.1:23813/api/v1/environments?projectId=proj_x4gdw7vz68" -Method Get).Content
```
```
[{"id":"env_v4mcchxyjw","name":null,"projectId":"proj_x4gdw7vz68","hostId":"host_45kqba73eq","path":"C:\\Users\\olege\\.bb-dev\\work-bb-21d97a8d7c85\\plugins\\environment-git-worktree\\host-data\\worktrees\\thr_hnyw5gyc3h-1\\phase1-ui","isGitRepo":true,"isWorktree":true,"branchName":"bb/phase-1-worktree-check-thr_hnyw5gyc3h","baseBranch":null,"defaultBranch":"master","mergeBaseBranch":null,"status":"ready","environmentProviderId":"git-worktree","lifecycle":{"phase":"active","retireAt":null,"teardown":null},"environmentProviderSelection":{"machine":{"type":"existing","hostId":"host_45kqba73eq"},"inputs":{"branch":{"kind":"default"}}},"environmentProviderInstanceKey":"thr_hnyw5gyc3h-1","managed":true,"workspaceProvisionType":"managed-worktree","createdAt":1789304735637,"updatedAt":1789304738094}]
```

- `status`: **`ready`** (about 2.5 s after creation: `createdAt` 1789304735637 → `updatedAt` 1789304738094)
- `path`: `C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_hnyw5gyc3h-1\phase1-ui`
- `isWorktree: true`, `managed: true`, `workspaceProvisionType: "managed-worktree"`
- `environmentProviderInstanceKey`: `thr_hnyw5gyc3h-1`
- branch: `bb/phase-1-worktree-check-thr_hnyw5gyc3h`, default branch `master`

### `path` versus `pathKey` in the database

The `pathKey` column Task 5 added is not part of the public `Environment` response, so it was read straight
out of the dev database with `better-sqlite3` (script run from `packages/db` so the dependency resolves;
deleted afterwards):

```powershell
node C:\Users\olege\Work\bb\packages\db\read-env-rows.mjs "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\bb.db"
```
```
[
  {
    "id": "env_v4mcchxyjw",
    "project_id": "proj_x4gdw7vz68",
    "host_id": "host_45kqba73eq",
    "path": "C:\\Users\\olege\\.bb-dev\\work-bb-21d97a8d7c85\\plugins\\environment-git-worktree\\host-data\\worktrees\\thr_hnyw5gyc3h-1\\phase1-ui",
    "is_git_repo": 1,
    "is_worktree": 1,
    "branch_name": "bb/phase-1-worktree-check-thr_hnyw5gyc3h",
    "status": "ready",
    "environment_provider_id": "git-worktree",
    "environment_provider_plugin_id": "environment-git-worktree",
    "provider_owns_path": 1,
    "environment_provider_instance_key": "thr_hnyw5gyc3h-1",
    "status_message": "Using workspace: C:\\Users\\olege\\.bb-dev\\work-bb-21d97a8d7c85\\plugins\\environment-git-worktree\\host-data\\worktrees\\thr_hnyw5gyc3h-1\\phase1-ui",
    "claim_path": null,
    "path_key": "c:/users/olege/.bb-dev/work-bb-21d97a8d7c85/plugins/environment-git-worktree/host-data/worktrees/thr_hnyw5gyc3h-1/phase1-ui"
  }
]
EXIT=0
```

This is the Phase 1 behaviour working exactly as designed: the **stored `path` keeps the host's native
separators and drive-letter case**, while the **`path_key` is the canonical comparison key** — lower-cased,
forward-slashed — that Task 5 introduced and Task 6 reconciled.

### Deviation from the brief's expected location

The brief predicted `%USERPROFILE%\.bb-dev\<instance>\worktrees\<key>\phase1-ui`. The worktree is actually
provisioned at `<dataDir>\plugins\environment-git-worktree\host-data\worktrees\<instanceKey>\<repo>`, i.e.
inside the environment provider plugin's own host-data directory. That is the plugin-owned layout, not the
core `managedWorkspaceRoots(dataDir)` root (`<dataDir>\worktrees`) the brief's expectation was drawn from;
`<dataDir>\worktrees` does not exist on this instance at all. The substantive Windows property the step
exists to check — a drive-absolute, native-separator managed path, created and removed cleanly — holds.

## On disk while the environment is live

```powershell
$p = "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_hnyw5gyc3h-1\phase1-ui"; "Test-Path: " + (Test-Path $p); "--- dir ---"; Get-ChildItem $p -Force | Select-Object Name,Mode | Format-Table -AutoSize | Out-String; "--- git worktree list ---"; git -C C:\Users\olege\Work\phase1-ui worktree list; "EXIT=$LASTEXITCODE"
```
```
Test-Path: True
--- dir ---

Name      Mode
----      ----
.git      -a-h-
README.md -a---


--- git worktree list ---
C:/Users/olege/Work/phase1-ui                                                                                                b96b1ec [master]
C:/Users/olege/.bb-dev/work-bb-21d97a8d7c85/plugins/environment-git-worktree/host-data/worktrees/thr_hnyw5gyc3h-1/phase1-ui  b96b1ec [bb/phase-1-worktree-check-thr_hnyw5gyc3h]
EXIT=0
```

## Removal

`DELETE /environments/:id` is refused while threads are live, which is the documented contract:

```
HTTP 409
{
  "code": "invalid_request",
  "message": "Environment still has live threads"
}
```

So the environment's threads were archived through the public route first, then the environment deleted:

```powershell
try { $a = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/environments/env_v4mcchxyjw/archive-threads" -Method Post -ContentType "application/json" -Body "{}"; "archive-threads: " + ($a | ConvertTo-Json -Compress) } catch { "HTTP " + $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```
```
archive-threads: {"ok":true,"archivedThreadIds":["thr_hnyw5gyc3h"]}
```

```powershell
try { $d = Invoke-RestMethod -Uri "http://127.0.0.1:23813/api/v1/environments/env_v4mcchxyjw" -Method Delete; "DELETE ok: " + ($d | ConvertTo-Json -Compress) } catch { "HTTP " + $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```
```
DELETE ok: {"ok":true}
```

## After removal

```powershell
$p = "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_hnyw5gyc3h-1\phase1-ui"; "Test-Path env dir: " + (Test-Path $p); "Test-Path instance dir: " + (Test-Path "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_hnyw5gyc3h-1"); "--- git worktree list ---"; git -C C:\Users\olege\Work\phase1-ui worktree list; "EXIT=$LASTEXITCODE"; "--- environments API ---"; (Invoke-WebRequest -Uri "http://127.0.0.1:23813/api/v1/environments?projectId=proj_x4gdw7vz68" -Method Get).Content
```
```
Test-Path env dir: False
Test-Path instance dir: False
--- git worktree list ---
C:/Users/olege/Work/phase1-ui  b96b1ec [master]
EXIT=0
--- environments API ---
[]
```

The row itself:

```powershell
node C:\Users\olege\Work\bb\packages\db\read-env-rows.mjs "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\bb.db" | Select-String -Pattern '"id"|"status"|"path"|"path_key"|"teardown_status"'
```
```
    "id": "env_v4mcchxyjw",
    "path": null,
    "status": "destroyed",
    "teardown_status": "removed",
    "path_key": null
EXIT=0
```

`status` is **`destroyed`**, `teardown_status` is `removed`, and both `path` and `path_key` are cleared — so
the row no longer occupies the live unique index on `(project_id, host_id, path_key)` that Task 5 added.

## Step 6 verdict at this head

**PASS.** The managed worktree provisions to `ready` at a drive-absolute, native-separator path, is visible
to `git worktree list` and on disk while live, and after removal the directory (and its instance directory)
are gone, `git worktree list` shows only the main checkout, the environments listing is empty, and the row
is `destroyed` with `teardown_status: removed`.

## Cleanup for this refresh

- Thread `thr_hnyw5gyc3h` archived (by the `archive-threads` call above) and left in the dev database.
- `packages/db/read-env-rows.mjs`, the throwaway database reader, deleted from the checkout.
- Dev app stopped with `pnpm dev:stop`.
- `C:\Users\olege\Work\phase1-ui` deleted again; see `00-host.md`.


---

# Gate refresh 3 at `c3e4a8590` (2026-09-14) — Step 6 still PASSES

Everything above this line is unchanged. Re-measured because the POSIX-parity round rewrote
`canonicalizeProducedHostPath` — the helper that canonicalizes a path the *provider* produced, which is
exactly the managed worktree's directory. At `81bed7a61` that helper fell back to the raw path on any
`invalid_path`; `c3e4a8590` narrowed the catch to host **RPC failures** only, with a warning log. This step
is the end-to-end proof that the narrowed catch does not break provisioning.

The manifest asset guard this file originally diagnosed is still fixed at this head:

```bash
grep -n 'startsWith(realRoot' apps/server/src/services/plugins/manifest.ts
```
```
176:    if (realAsset !== realRoot && !realAsset.startsWith(realRoot + sep)) {
204:    if (realAsset !== realRoot && !realAsset.startsWith(realRoot + sep)) {
```

Same dev instance (`http://127.0.0.1:23813`, host `host_45kqba73eq` = `OMEN`), same scratch repository
`C:\Users\olege\Work\phase1-ui` (hook-less `git init`, one commit `a25bf64`, branch `master`), same project
`proj_x4gdw7vz68`. As before, the environment is created through `POST /api/v1/threads` — the route the UI's
composer posts to — because there is no `POST /environments`.

## Thread creation with the Worktree provider

```powershell
$body = '{"projectId":"proj_x4gdw7vz68","origin":"sdk","providerId":"codex","title":"Phase 1 worktree check r3","input":[{"type":"text","text":"Phase 1 managed worktree provisioning check, refresh 3."}],"environment":{"type":"provider","environmentProviderId":"git-worktree","machine":{"type":"existing","hostId":"host_45kqba73eq"},"inputs":{"branch":{"kind":"default"}}}}'; $body; try { $t = Invoke-RestMethod -Uri "$env:BB_SERVER_URL/api/v1/threads" -Method Post -ContentType "application/json" -Body $body; "id=" + $t.id + " status=" + $t.status + " environmentId=" + $t.environmentId } catch { "HTTP " + $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```
```
{"projectId":"proj_x4gdw7vz68","origin":"sdk","providerId":"codex","title":"Phase 1 worktree check r3","input":[{"type":"text","text":"Phase 1 managed worktree provisioning check, refresh 3."}],"environment":{"type":"provider","environmentProviderId":"git-worktree","machine":{"type":"existing","hostId":"host_45kqba73eq"},"inputs":{"branch":{"kind":"default"}}}}
id=thr_eg7guggbn7 status=starting environmentId=
```

## The environment reaches `ready`

```powershell
(Invoke-WebRequest -Uri "$env:BB_SERVER_URL/api/v1/environments?projectId=proj_x4gdw7vz68" -Method Get -UseBasicParsing).Content
```
```
[{"id":"env_35cwiwnx7n","name":null,"projectId":"proj_x4gdw7vz68","hostId":"host_45kqba73eq","path":"C:\\Users\\olege\\.bb-dev\\work-bb-21d97a8d7c85\\plugins\\environment-git-worktree\\host-data\\worktrees\\thr_eg7guggbn7-1\\phase1-ui","isGitRepo":true,"isWorktree":true,"branchName":"bb/phase-1-worktree-check-r3-thr_eg7guggbn7","baseBranch":null,"defaultBranch":"master","mergeBaseBranch":null,"status":"ready","environmentProviderId":"git-worktree","lifecycle":{"phase":"active","retireAt":null,"teardown":null},"environmentProviderSelection":{"machine":{"type":"existing","hostId":"host_45kqba73eq"},"inputs":{"branch":{"kind":"default"}}},"environmentProviderInstanceKey":"thr_eg7guggbn7-1","managed":true,"workspaceProvisionType":"managed-worktree","createdAt":1789371156041,"updatedAt":1789371157929}]
```

- `status`: **`ready`**, reached in **1.888 s** (`createdAt` 1789371156041 → `updatedAt` 1789371157929)
- `path`: `C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_eg7guggbn7-1\phase1-ui`
  — drive-absolute, native backslashes, no doubled or mixed separators
- `isWorktree: true`, `managed: true`, `workspaceProvisionType: "managed-worktree"`
- `environmentProviderInstanceKey`: `thr_eg7guggbn7-1`
- branch `bb/phase-1-worktree-check-r3-thr_eg7guggbn7`, default branch `master`

### `path` versus `path_key` in the database

```powershell
node packages/db/read-rows.mjs "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\bb.db" environments
```
```json
  {
    "id": "env_35cwiwnx7n",
    "project_id": "proj_x4gdw7vz68",
    "host_id": "host_45kqba73eq",
    "path": "C:\\Users\\olege\\.bb-dev\\work-bb-21d97a8d7c85\\plugins\\environment-git-worktree\\host-data\\worktrees\\thr_eg7guggbn7-1\\phase1-ui",
    "path_key": "c:/users/olege/.bb-dev/work-bb-21d97a8d7c85/plugins/environment-git-worktree/host-data/worktrees/thr_eg7guggbn7-1/phase1-ui",
    "status": "ready",
    "is_worktree": 1,
    "branch_name": "bb/phase-1-worktree-check-r3-thr_eg7guggbn7",
    "environment_provider_id": "git-worktree",
    "environment_provider_instance_key": "thr_eg7guggbn7-1",
    "provider_owns_path": 1,
    "teardown_status": null
  }
```

The provider-produced path was canonicalized by the **daemon**, not by the degraded local fallback. The dev
log contains **no** occurrence of the warning `c3e4a8590` added for the degraded branch:

```powershell
(Select-String -Path "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\dev-app\dev.log" -Pattern 'storing the normalized spelling' | Measure-Object).Count
```
```
0
```

## On disk and in git while the environment is live

```powershell
git -C C:\Users\olege\Work\phase1-ui worktree list
```
```
C:/Users/olege/Work/phase1-ui                                                                                                a25bf64 [master]
C:/Users/olege/.bb-dev/work-bb-21d97a8d7c85/plugins/environment-git-worktree/host-data/worktrees/thr_eg7guggbn7-1/phase1-ui  a25bf64 [bb/phase-1-worktree-check-r3-thr_eg7guggbn7]
```
```powershell
Get-ChildItem "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_eg7guggbn7-1\phase1-ui" -Force | Select-Object Name,Mode | Format-Table -AutoSize
```
```
Name      Mode
----      ----
.git      -a-h-
README.md -a---
```

The checkout is real: the tracked `README.md` is present and `.git` is the hidden worktree pointer file that
git creates for a linked worktree on Windows.

## Removal

The 409 contract still holds — `DELETE /environments/:id` is refused while threads are live:

```powershell
try { $d = Invoke-RestMethod -Uri "$env:BB_SERVER_URL/api/v1/environments/env_35cwiwnx7n" -Method Delete; "DELETE (no archive) ok: " + ($d | ConvertTo-Json -Compress) } catch { "DELETE (no archive) HTTP " + $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```
```
DELETE (no archive) HTTP 409

{
  "code": "invalid_request",
  "message": "Environment still has live threads"
}
```

Archive the threads through the public route, then delete:

```powershell
try { $a = Invoke-RestMethod -Uri "$env:BB_SERVER_URL/api/v1/environments/env_35cwiwnx7n/archive-threads" -Method Post -ContentType "application/json" -Body "{}"; "archive-threads: " + ($a | ConvertTo-Json -Compress) } catch { "HTTP " + $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```
```
archive-threads: {"ok":true,"archivedThreadIds":["thr_eg7guggbn7"]}
```
```powershell
try { $d = Invoke-RestMethod -Uri "$env:BB_SERVER_URL/api/v1/environments/env_35cwiwnx7n" -Method Delete; "DELETE ok: " + ($d | ConvertTo-Json -Compress) } catch { "HTTP " + $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```
```
DELETE ok: {"ok":true}
```

Unlike refresh 2, the delete succeeded on the first attempt after archiving — no `Environment cannot be
deleted while ready` retry was needed.

## After removal

```powershell
$p = "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_eg7guggbn7-1\phase1-ui"; "Test-Path env dir: " + (Test-Path $p); "Test-Path instance dir: " + (Test-Path "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\plugins\environment-git-worktree\host-data\worktrees\thr_eg7guggbn7-1"); "--- git worktree list ---"; git -C C:\Users\olege\Work\phase1-ui worktree list; "EXIT=$LASTEXITCODE"; "--- environments API ---"; (Invoke-WebRequest -Uri "$env:BB_SERVER_URL/api/v1/environments?projectId=proj_x4gdw7vz68" -Method Get -UseBasicParsing).Content; "--- row ---"; node packages/db/read-rows.mjs "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\bb.db" environments | Select-String -Pattern '"id"|"status"|"path"|"path_key"|"teardown_status"' | Select-Object -First 5
```
```
Test-Path env dir: False
Test-Path instance dir: False
--- git worktree list ---
C:/Users/olege/Work/phase1-ui  a25bf64 [master]
EXIT=0
--- environments API ---
[]
--- row ---

    "id": "env_35cwiwnx7n",
    "path": null,
    "path_key": null,
    "status": "destroyed",
    "teardown_status": "removed"
```

Both the environment directory and its instance directory are gone, git no longer lists the linked worktree,
the environments listing is empty, and the row is `destroyed` / `teardown_status: removed` with `path` and
`path_key` cleared — so it no longer occupies the live unique index on `(project_id, host_id, path_key)`.

## Step 6 verdict at this head

**PASS.** Provisioning, the canonical `path`/`path_key` pair, the on-disk and git-visible worktree, and the
full teardown all behave exactly as in refresh 1, and the narrowed degradation catch in `c3e4a8590` never
fired — the provider-produced path was canonicalized by the host daemon, with zero warning-log entries.

## Cleanup for this refresh

- Thread `thr_eg7guggbn7` archived by the `archive-threads` call above and left in the dev database.
- `packages/db/read-rows.mjs`, the throwaway database reader, deleted from the checkout.
- Dev app stopped with `pnpm dev:stop`.
