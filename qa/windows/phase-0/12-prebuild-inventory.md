# Native add-on prebuild inventory (Task 10 fix round)

Recorded 2026-09-11 on the reference desktop (Windows 11 Pro 10.0.26200) from `C:\Users\olege\Work\bb` in Git Bash, after the install recorded in `10-install.txt`. pnpm's strict layout exposes `@parcel/watcher-win32-x64` only from inside `@parcel/watcher`, so the probe resolves the watcher first.

```
$ node -v
v22.19.0
$ ls node_modules/.pnpm/node-pty@1.2.0-beta.15/node_modules/node-pty/prebuilds/win32-x64/
conpty
conpty.node
conpty.pdb
conpty_console_list.node
conpty_console_list.pdb
$ ls node_modules/.pnpm/node-pty@1.2.0-beta.15/node_modules/node-pty/prebuilds/win32-x64/conpty/
OpenConsole.exe
conpty.dll
$ node -e '<resolve @parcel/watcher from apps/host-daemon, then @parcel/watcher-win32-x64 from it>'
C:\Users\olege\Work\bb\node_modules\.pnpm\@parcel+watcher@2.5.6\node_modules\@parcel\watcher\package.json
C:\Users\olege\Work\bb\node_modules\.pnpm\@parcel+watcher-win32-x64@2.5.6\node_modules\@parcel\watcher-win32-x64\package.json
version 2.5.6
EXIT=0
$ ls node_modules/.pnpm | grep -i 'watcher-win32\|node-pty@'
@parcel+watcher-win32-arm64@2.5.6
@parcel+watcher-win32-x64@2.5.6
node-pty@1.2.0-beta.15
```

The probe source, verbatim:

```js
const { createRequire } = require("node:module")
const hostRequire = createRequire(process.cwd() + "/apps/host-daemon/package.json")
const watcherPkg = hostRequire.resolve("@parcel/watcher/package.json")
console.log(watcherPkg)
const watcherRequire = createRequire(watcherPkg)
const platformPkg = watcherRequire.resolve("@parcel/watcher-win32-x64/package.json")
console.log(platformPkg)
console.log("version " + watcherRequire("@parcel/watcher-win32-x64/package.json").version)
```

No compiler ran for either package: the files above come from the published tarballs (node-pty ships N-API prebuilds under `prebuilds/win32-x64/`; `@parcel/watcher` resolves its `win32-x64` platform package).
