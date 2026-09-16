# `bb-app` from a packed tarball and a clean shell (Phase 3 gate, Step 8)

Host: `00-host.md`. Raw transcript: `24-npx-bb-app-clean-shell.txt`.
Two halves: the repository's own tarball smoke, then a hand-driven `npx` run with **no** `BB_*` dev
variables set.

## Result

| half | outcome |
|---|---|
| `pnpm exec turbo run smoke:tarball --filter=bb-app` (run 1, at `05138a11e`) | all 14 checks passed in **134.6 s**, then **`EBUSY` removing the temp root** → task exit 1 |
| same, after the `e5d59dc7e` fix | `bb-app tarball smoke passed in 119.3 s`; `Tasks: 48 successful, 48 total`; `SMOKE_TARBALL2_EXIT=0` |
| `npx --package <tgz> bb-app …` from a clean shell | URL line after 33 s; `/api/v1/system/config` → **HTTP 200**, 44 190 bytes |
| `npx --package <tgz> bb-app stop` | `✓ Stopped bb (pid 36924) (terminated)`, `STOP_EXIT=0`, listeners gone |
| data dir removed | `DATA_DIR_EXISTS=False` |

## Half 1 — the repository smoke

```bash
pnpm exec turbo run smoke:tarball --filter=bb-app --output-logs=new-only
```

First run, at the reviewed code head `05138a11e`:

```
bb-app tarball smoke: npm pack 36.7s
bb-app tarball smoke: npx install and help 27.6s
bb-app tarball smoke: npx entrypoint 27.6s
bb-app tarball smoke: npm install tarball 17.2s
bb-app tarball smoke: npx typescript check 2.8s
bb-app tarball smoke: sdk package 20.2s
bb-app tarball smoke: help commands 1.5s
bb-app tarball smoke: config command 0.3s
bb-app tarball smoke: installed repack 18.4s
bb-app tarball smoke: provider bridge bundles 4.9s
bb-app tarball smoke: plugin host worker ready
bb-app tarball smoke: plugin host worker bundle 0.1s
bb-app tarball smoke: full stack 19.2s
bb-app tarball smoke: daemon join 5.7s
bb-app tarball smoke passed in 134.6s
[Error: EBUSY: resource busy or locked, rmdir 'C:\Users\olege\AppData\Local\Temp\bb-app-tarball-TCD4nB'] {
  errno: -4082, code: 'EBUSY', syscall: 'rmdir',
  path: 'C:\\Users\\olege\\AppData\\Local\\Temp\\bb-app-tarball-TCD4nB'
}
 ELIFECYCLE  Command failed with exit code 1.
SMOKE_TARBALL_EXIT=1
```

Every check passed and the script then failed in its own `finally`: on Windows the just-killed server and
daemon children still hold handles under the temp root when `rm` runs, so the recursive delete hits
`EBUSY`. Task 12 measured 110.1 s / exit 0 on this desktop, so it is a **race, not a constant** — which is
exactly why it is worth fixing rather than retrying by hand.

Fix (commit `e5d59dc7e`), using the retry options Node documents for this case and the shape the repo
already uses in `apps/web/scripts/generate-og-card.mjs:230`:

```js
  await rm(tempRoot, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 200,
  });
```

`maxRetries`/`retryDelay` only engage on `EBUSY`/`ENOTEMPTY`/`EPERM`/`EMFILE`/`ENFILE`, none of which the
POSIX path raises here, so the POSIX run is unchanged. Re-run:

```
bb-app tarball smoke: full stack 18.5s
bb-app tarball smoke: daemon join 5.4s
bb-app tarball smoke passed in 119.3s

 Tasks:    48 successful, 48 total
Cached:    46 cached, 48 total
  Time:    2m26.756s
SMOKE_TARBALL2_EXIT=0
```

The same commit also makes `waitForHttp` print the launcher's own log files when a managed process exits or
times out, instead of only its stdout — that is what turned the opaque CI failure into a named root cause
(`41-ci-run.md`).

## Half 2 — `npx` from a clean shell

The tarball was packed with node's bundled npm (`npm` as a bare command mangles its first argument on this
host's nvm4w shim, and a relative path makes npm treat it as a GitHub shorthand — both recorded here so a
later gate does not repeat them):

```powershell
node C:\nvm4w\nodejs\node_modules\npm\bin\npm-cli.js pack "C:\Users\olege\Work\bb\packages\bb-app" --pack-destination <scratch>
```
```
bb-app-0.42.1.tgz   44 656 675 bytes
```

The run shell was verified clean first:

```powershell
Get-ChildItem Env: | Where-Object { $_.Name -like 'BB_*' }
```
```
BB_VAR_COUNT=0
```

```powershell
npx --yes --package <scratch>\bb-app-0.42.1.tgz bb-app `
  --data-dir C:\Users\olege\.bb-phase3-test --server-port 48886 --host-daemon-port 48887
```
```
NPX_PID=21492
SAW_URL=True AFTER_S=33

  bb

  ○  Starting server
  ✓  Server listening on http://127.0.0.1:48886
  ○  Starting host daemon
  ✓  Host daemon running

  ●  bb is ready

     app    http://127.0.0.1:48886
     daemon 48887
     data   C:\Users\olege\.bb-phase3-test
     db     C:\Users\olege\.bb-phase3-test\bb.db
     logs   C:\Users\olege\.bb-phase3-test\logs/
     lock   C:\Users\olege\.bb-phase3-test\daemon.lock

     Press Ctrl+C to stop
```

stderr carried one line, an upstream deprecation notice, and nothing else:

```
npm warn deprecated prebuild-install@7.1.3: No longer maintained. …
```

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:48886/api/v1/system/config" -UseBasicParsing
```
```
HTTP_STATUS=200
BODY_BYTES=44190
BODY_HEAD={"generalSettings":{"showKeyboardHints":true,"steerActiveThreadOnEnter":true,"showDiagnosticEvents":false,"providerOrder":[],"defaultProviderId":null,"streamerMode":false,"managedBranchPrefix":"bb/","showUnhandledProviderEvents":false},"keybindings":[{"command":"palette.open", …
```

```powershell
Get-NetTCPConnection -State Listen -LocalPort 48886,48887
```
```
127.0.0.1        48887         39648
127.0.0.1        48886         43468
```

Both halves of the stack are listening on the ports that were asked for — a real server and a real host
daemon, from an installed tarball, with no repository checkout in the picture.

## Stop

```powershell
npx --yes --package <tgz> bb-app stop --data-dir C:\Users\olege\.bb-phase3-test
```
```
  ✓  Stopped bb (pid 36924) (terminated)
STOP_EXIT=0
```
```
no listeners on 48886/48887
NPX_PROC_EXITED=True
```

The stop command found the running instance through its data directory, terminated it, and the foreground
`npx` process exited on its own — no force-kill was needed (`FORCED_STOP` was never printed).

```powershell
Remove-Item -Recurse -Force C:\Users\olege\.bb-phase3-test
```
```
DATA_DIR_EXISTS=False
```
