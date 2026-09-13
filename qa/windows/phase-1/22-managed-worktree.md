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
