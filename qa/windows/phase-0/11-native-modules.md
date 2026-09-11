# Native add-on load check (task 2)

All commands run from `C:\Users\olege\Work\bb`. Node version switches use
`nvm use <version>` (nvm-windows; the brief's `fnm use` does not apply on
this machine) and are confirmed with `node -v` before each run.

## Node 22.19.0 (first run)

```powershell
nvm use 22.19.0
node -v
node qa/windows/scripts/conpty-load-check.mjs 2>&1 | Tee-Object qa/windows/phase-0/11-native-modules.md
```

Output:

```
v22.19.0
better-sqlite3 ok (ABI 127)
@parcel/watcher ok (function)
node-pty ok (exit 0, pid 35060)
```

Note: at the time of this run, the original script did not terminate on its
own after printing the three `ok` lines - it hung because ConPTY kept the
event loop alive after `onExit` fired, and the process had to be terminated
with `Stop-Process -Force` on the `node.exe` PID to release the
`Tee-Object` pipeline (the script's output was already fully flushed to
disk, so no data was lost). This was a script defect, not a data problem:
the recorded `ok` lines above are unaffected. The same hang recurred on the
post-restore Node 22 run below. The script was subsequently fixed to call
`process.exit()` after the final write's callback; see "Exit behaviour
after fix" at the end of this document for the fix and its verification.

## Hardlink measurement (before the Node 24 repair)

```powershell
node -p "require('node:fs').lstatSync(require.resolve('better-sqlite3/build/Release/better_sqlite3.node', { paths: ['packages/db'] })).nlink"
```

Output:

```
1
```

The `better-sqlite3` native binary was not hardlinked (`nlink` = 1) at the
time of this measurement, so the Node 24 repair below was not expected to
(and did not) print a "Detached hardlinked" line.

## Node 24.12.0

```powershell
nvm use 24.12.0
node -v
node qa/windows/scripts/conpty-load-check.mjs 2>&1 | Tee-Object -Append qa/windows/phase-0/11-native-modules.md
```

Output:

```
v24.12.0
node:internal/modules/cjs/loader:1920
  return process.dlopen(module, path.toNamespacedPath(filename));
                 ^

Error: The module '\\?\C:\Users\olege\Work\bb\node_modules\.pnpm\better-sqlite3@12.10.0\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 127. This version of Node.js requires
NODE_MODULE_VERSION 137. Please try re-compiling or re-installing
the module (for instance, using `npm rebuild` or `npm install`).
    at Object..node (node:internal/modules/cjs/loader:1920:18)
    at Module.load (node:internal/modules/cjs/loader:1481:32)
    at Module._load (node:internal/modules/cjs/loader:1300:12)
    at TracingChannel.traceSync (node:diagnostics_channel:328:14)
    at wrapModuleLoad (node:internal/modules/cjs/loader:245:24)
    at Module.require (node:internal/modules/cjs/loader:1504:12)
    at require (node:internal/modules/helpers:152:16)
    at bindings (C:\Users\olege\Work\bb\node_modules\.pnpm\bindings@1.5.0\node_modules\bindings\bindings.js:112:48)
    at new Database (C:\Users\olege\Work\bb\node_modules\.pnpm\better-sqlite3@12.10.0\node_modules\better-sqlite3\lib\database.js:48:64)
    at file:///C:/Users/olege/Work/bb/qa/windows/scripts/conpty-load-check.mjs:13:12 {
  code: 'ERR_DLOPEN_FAILED'
}

Node.js v24.12.0
```

`better-sqlite3` reported `NODE_MODULE_VERSION` (127 vs 137 required), as
anticipated by the brief. This run crashed before reaching the `node-pty`
spawn, so it did not hang; it exited on its own with exit code 1.

### Repair under Node 24

```powershell
node scripts/ensure-native-modules.mjs 2>&1 | Tee-Object -Append qa/windows/phase-0/11-native-modules.md
```

Output:

```
[ensure-native-modules] Installing prebuilt better-sqlite3 for Node 24.12.0 (ABI 137)
```

Exit code 0. No "Detached hardlinked" line was printed, consistent with the
`nlink` = 1 measurement above (the binary was not hardlinked, so
`detachHardlinkedBinary` had nothing to detach and returned early without
logging).

## Restore Node 22.19.0 and repair back

```powershell
nvm use 22.19.0
node -v
node scripts/ensure-native-modules.mjs 2>&1 | Tee-Object -Append qa/windows/phase-0/11-native-modules.md
```

Output:

```
v22.19.0
[ensure-native-modules] Installing prebuilt better-sqlite3 for Node 22.19.0 (ABI 127)
```

Exit code 0. The script repaired the shared binary back to ABI 127 as
expected. No "Detached hardlinked" line here either (same reason: `nlink`
was 1, nothing to detach).

## Node 22.19.0 (after restore, final check)

```powershell
node -v
node qa/windows/scripts/conpty-load-check.mjs 2>&1 | Tee-Object -Append qa/windows/phase-0/11-native-modules.md
```

Output:

```
v22.19.0
better-sqlite3 ok (ABI 127)
@parcel/watcher ok (function)
node-pty ok (exit 0, pid 12872)
```

Same hang as the first Node 22 run: the script hung because ConPTY kept the
event loop alive after `onExit` fired, so the `node.exe` PID again had to be
terminated with `Stop-Process -Force` to release the pipeline. All three
modules load correctly on Node 22.19.0 after the round-trip repair.

Final state at this point: `node -v` reports `v22.19.0`, and the Node 22
load check passes (three `ok` lines) both before and after the Node 24
detour. See "Exit behaviour after fix" below for the resolution of the hang
itself.

## Exit behaviour after fix

The controller ruled that the hang above is a script defect (Task 9 runs
this script as a CI step, where a hang would consume the job's whole
timeout), not merely a fact to document. `qa/windows/scripts/conpty-load-check.mjs`
was changed so the `onExit` handler calls `process.exit(ok ? 0 : 1)` from
the write callback of the final `node-pty ...` line, instead of only setting
`process.exitCode`, so the process terminates explicitly once its output has
flushed instead of relying on the event loop draining naturally (which
ConPTY's kept-alive handle prevented).

Verified with `node -v` confirmed as `v22.19.0`, then run in Git Bash with no
kill or timeout wrapper:

```bash
node qa/windows/scripts/conpty-load-check.mjs; echo "exit=$?"
```

Output:

```
better-sqlite3 ok (ABI 127)
@parcel/watcher ok (function)
node-pty ok (exit 0, pid 39644)
exit=0
```

The process printed the three `ok` lines and returned control on its own,
with exit code 0. No process had to be killed; `Get-CimInstance Win32_Process`
confirmed no lingering `node.exe` for this script afterward.
