# Closing the last window to the tray (Phase 4 gate, Step 9)

Screenshot: `25-close-to-tray-error.png`.

> ## Result: **FAIL — the gate's one blocking finding.**
>
> The _behaviour_ the step checks is correct: closing the last window parks the app in the tray, the owned
> runtime keeps running, `/health` keeps answering 200, and a second launch brings a window back through the
> existing process instead of starting a new one.
>
> But **the first window close of every app session raises an Electron "A JavaScript error occurred in the
> main process" dialog**:
>
> ```
> Uncaught Exception:
> TypeError: Object has been destroyed
>     at C:\Users\olege\AppData\Local\Programs\bb\resources\app.asar\dist\main.js:44799:31
>     at Array.find (<anonymous>)
>     at instanceForWindow (…\main.js:44798:36)
>     at Object.releaseWindow (…\main.js:45002:24)
>     at BrowserWindow.<anonymous> (…\main.js:46873:27)
>     at BrowserWindow.emit (node:events:521:24)
> ```
>
> Reproduced on **2 of 2** fresh app sessions, on the first close each time. It is a modal error window the
> user must dismiss; until they do, the app has no window and an error box instead.

## What was measured

Build N+1 (`0.42.2`), installed copy, launched with a fresh `BB_DESKTOP_QUIT_REQUEST_FILE` and health
confirmed first.

`WM_CLOSE` was posted to the window — the exact message the title-bar X sends — rather than simulating a
click, so nothing depends on window z-order or pointer position:

```
WM_CLOSE posted to HWND=16912466 TITLE=bb
```

Five seconds later:

```
BBCOUNT_AFTER_CLOSE=26          # the process tree is alive
DESKTOP_ALIVE=1                 # the Desktop process itself survived
{"ok":true,"launchId":"6da190f3-0104-4035-b4cc-208c4b9fac3d"}     # /health still 200
LocalPort OwningProcess
    38887         30728
    38886         39988
```

So the tray-parking policy holds: the window is gone, the Desktop process stays, the owned runtime stays,
and both ports stay bound. That is the documented Windows behaviour and it is correct.

Enumerating the Desktop process's visible windows, however, found one — and it was not the app:

```
HWND=13504822 PID=48956 TITLE=Error
```

`25-close-to-tray-error.png` is that window, captured with `PrintWindow`. Its text is quoted in full in the
verdict above.

## The defect

`instanceForWindow` in `apps/desktop/src/desktop-browser-broker.ts` is:

```ts
function instanceForWindow(webContentsId: number): InstanceEntry | undefined {
  return [...instances.values()].find(
    (entry) => entry.window.webContents.id === webContentsId,
  );
}
```

and `main.ts` calls into it from the window's own `closed` handler:

```ts
browserWindow.on("closed", () => {
  desktopBrowserBroker?.releaseWindow(webContentsId);
  applicationWindowWebContentsIds.delete(webContentsId);
});
```

By the time `closed` fires the `BrowserWindow` is destroyed, so reading `entry.window.webContents` on a
map entry whose window is that same destroyed window throws `Object has been destroyed`. Nothing catches
it, so Electron's default uncaught-exception handler shows the error box.

`desktop-browser-broker.ts` itself is **unchanged by this phase** (`git diff 47bb778d8 HEAD` touches
`main.ts` but not the broker), so this is a latent bug rather than new code. What Phase 4 changed is that
Windows now **reaches** it in a state where the user sees it: before this phase closing the last window on
Windows was not a supported flow at all, and on the other platforms the app either quits on
`window-all-closed` or the user is on macOS, where the same close happens against a different window
lifecycle. Either way the Windows close-to-tray flow this phase introduces is the flow that surfaces it,
and it surfaces on the very first close a user performs.

## Reproducibility

| session                        | close                                     | error dialog |
| ------------------------------ | ----------------------------------------- | ------------ |
| A (running ~4 min, one window) | 1st                                       | **yes**      |
| A                              | 2nd (window reopened via second instance) | no           |
| A                              | 3rd                                       | no           |
| A                              | 4th                                       | no           |
| B (fresh launch)               | 1st                                       | **yes**      |

Two fresh sessions, two errors, both on the first close. Subsequent closes within the same session were
clean, which fits the shape of the bug — the throwing entry is consumed or the map is left in a state the
next call tolerates — but the first close is the one every user performs.

## The rest of Step 9, which passed

**A second launch restores a window through the existing process.** With the app parked in the tray and
zero windows:

```powershell
$second = Start-Process -FilePath "$env:LOCALAPPDATA\Programs\bb\bb.exe" -WorkingDirectory "$env:LOCALAPPDATA\Programs\bb" -PassThru
```

```
SECOND_PID=33568
SECOND_ALIVE=0                        # the second instance exited on the single-instance lock
   Id MainWindowTitle
48956 bb                              # the ORIGINAL process now has a window again
DESKTOP_48956_ALIVE=1
HWND=46862228 PID=48956 TITLE=bb
```

The second process exited and the first one opened the window — the single-instance behaviour
`docs/platform-windows.md` describes, and the same code path the tray's `Open bb` item uses.

**Open/close cycles keep the runtime alive.** Four open→close cycles in session A left the runtime
answering `/health` 200 throughout, with `bb.exe` counts between 10 and 26 as Chromium spawned and
retired renderers.

**Quit still works from the parked state.** After the final close, writing the quit flag emptied the
process table in **4.39 s**.

## `MANUAL — for the user`

1. **Reproduce the error box by hand** (30 seconds, and worth doing before any fix): launch the installed
   app, wait for the window, click the title-bar **X**. Expect the Electron error box quoted above.
2. **Clicking the tray icon** was not exercised — the second-instance launch was used instead, which is
   the same `Open bb` path. Right-click or click the tray icon while parked and confirm a window appears.

## What should follow

This is a product defect found by the gate, not a documentation or environment issue, so it is recorded
here and **not** fixed in the evidence commit: a fix touches `apps/desktop/src/desktop-browser-broker.ts`,
needs a regression test around `releaseWindow` with a destroyed window, and belongs in its own reviewed
commit rather than inside "Record the Phase 4 Windows gate evidence". The natural shape is to make
`instanceForWindow` skip entries whose window is already destroyed (`entry.window.isDestroyed()`) and to
have `releaseWindow` match on the entry's recorded `webContentsId` rather than re-reading it from a
possibly-destroyed window.
