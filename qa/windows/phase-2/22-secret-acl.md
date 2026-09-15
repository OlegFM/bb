# Secret files read back a single-user ACL (Phase 2 gate, Step 6)

Commit `7d0603bb4777132efd0e122ffc6d8064105333be`, node v22.19.0, the reference Windows desktop
(`00-host.md`). Account: `omen\olege` (`C:\Windows\System32\whoami.exe`). Raw test capture:
`22-secret-acl.txt`.

On win32 `@bb/secret-storage` creates a secret file empty with `wx`, tightens it with
`icacls.exe <file> /inheritance:r /grant:r *<SID>:F` (SID from `whoami.exe /user /fo csv`, cached per
process), and reads the ACL back: the output must be exactly one ACE line whose identity is the current
account name or SID and whose rights are `(F)`, or the write is rejected before any secret bytes are
written.

## A note on the brief's `BB_DATA_DIR`

The brief starts the dev server with `$env:BB_DATA_DIR = "C:\Users\olege\.bb-dev\phase2-secrets-qa"`.
That does not work: `pnpm dev:app` derives its own per-checkout instance directory and **ignores**
`BB_DATA_DIR`. Observed directly — with that variable exported, `pnpm dev:app current` still logged

```
[dev-app] Starting dev server, log C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\dev-app\dev.log
```

and `pnpm dev:status` reported `Data dir: C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85`. The evidence below
is therefore taken against that **real** running instance directory, which is the stronger measurement
anyway — it is a secret the running server actually created and uses.

## 1. The live server's `auth-secret`

```powershell
$d="C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85"
Get-ChildItem $d -Recurse -File -Include "auth-secret*","*telemetry*"
C:\Windows\System32\whoami.exe
C:\Windows\System32\icacls.exe "$d\auth-secret"
```
```
C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\auth-secret

omen\olege

C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\auth-secret OMEN\olege:(F)

Successfully processed 1 files; Failed processing 0 files
EXIT=0
```

**Exactly one ACE line, `OMEN\olege:(F)`, and nothing else.** No `(I)` inheritance flag, no second identity.

### `telemetry-id` is not created by a dev instance

The recursive search found no telemetry file. That is correct, not a gap:
`apps/server/src/services/system/telemetry.ts` returns `noopTelemetryService` — and therefore never calls
`readOrCreateSecretFile({ fileName: "telemetry-id" })` — unless telemetry is enabled, an API key is present
**and** `appVersion !== DEFAULTS.appVersion`. None of that holds in a dev checkout. The same code path was
therefore exercised directly instead, on this host, through the package's real runtime:

```powershell
node --conditions=source --import tsx <script calling readOrCreateSecretFile({bytes:16, dataDir:<fresh temp>, encoding:"hex", fileName:"telemetry-id"})>
C:\Windows\System32\icacls.exe "<that file>"
```
```
DATA_DIR C:\Users\olege\AppData\Local\Temp\bb-p2-telemetry-cspO3Y
FILE C:\Users\olege\AppData\Local\Temp\bb-p2-telemetry-cspO3Y\telemetry-id
LENGTH 32
EXIT=0

C:\Users\olege\AppData\Local\Temp\bb-p2-telemetry-cspO3Y\telemetry-id OMEN\olege:(F)

Successfully processed 1 files; Failed processing 0 files
EXIT_ICACLS=0
```

A freshly created `telemetry-id`, 16 random bytes hex-encoded (32 characters), one ACE: `OMEN\olege:(F)`.

## 2. Cyrillic directory (non-ASCII path)

```powershell
# readOrCreateSecretFile({bytes:32, dataDir:"<temp>\Данные проекта", encoding:"base64url", fileName:"auth-secret"})
C:\Windows\System32\icacls.exe "<that file>"
```
```
FILE C:\Users\olege\AppData\Local\Temp\bb-p2-cyr-Rk471S\Данные проекта\auth-secret
LENGTH 43
EXIT=0

C:\Users\olege\AppData\Local\Temp\bb-p2-cyr-Rk471S\????? ??????\auth-secret OMEN\olege:(F)

Successfully processed 1 files; Failed processing 0 files
EXIT_ICACLS=0
```

One ACE, `OMEN\olege:(F)`. The `?????` in the `icacls` echo is the console OEM code page rendering the
Cyrillic directory name — `icacls` itself resolved the path correctly (it reports
`Successfully processed 1 files`), and Node printed the real name on the `FILE` line above. This is exactly
why `assertSecretFileNameIsSupported` restricts the **file name** to ASCII while the **directory** may be
anything: the directory is passed as the process `cwd` and never parsed out of `icacls` output.

## 3. The contrast: an ordinary file in the same data directory

```powershell
C:\Windows\System32\icacls.exe "C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\bb.db"
```
```
C:\Users\olege\.bb-dev\work-bb-21d97a8d7c85\bb.db OMEN\CodexSandboxUsers:(I)(RX)
                                                  NT AUTHORITY\СИСТЕМА:(I)(F)
                                                  BUILTIN\Администраторы:(I)(F)
                                                  OMEN\olege:(I)(F)

Successfully processed 1 files; Failed processing 0 files
```

(Identity names rendered through the OEM code page in the captured console output; transcribed here in
their real form.) Four **inherited** `(I)` ACEs — including `OMEN\CodexSandboxUsers:(I)(RX)`, a local group
that can read it. The secret file sitting in the same directory has none of them. That is the whole point of
`/inheritance:r`, measured rather than asserted.

## 4. The package's own real-NTFS suite on this host

```powershell
pnpm --filter @bb/secret-storage exec vitest run --reporter=verbose
```
```
 ✓ … test/windows-secret-file.test.ts > secret files on real NTFS > creates a secret whose only ACE grants the current user full control 410ms
 ✓ … test/windows-secret-file.test.ts > secret files on real NTFS > returns the same secret to two concurrent creators 272ms
 ✓ … test/windows-secret-file.test.ts > secret files on real NTFS > repairs a secret file left empty by an earlier crash 210ms
 ✓ … test/windows-secret-file.test.ts > secret files on real NTFS > secures secrets inside a directory whose name is not ASCII 448ms
 ✓ … test/windows-secret-file.test.ts > secret files on real NTFS > writes a secret through a tightened temp file and leaves nothing behind 207ms
 ✓ … test/windows-secret-file.test.ts > secret files on real NTFS > tightens an inherited ACL on the first read of an existing secret 266ms
 ✓ … test/windows-secret-file.test.ts > secret files on real NTFS > refuses to hand back a secret that icacls cannot take away from Everyone 226ms

 Test Files  5 passed (5)
      Tests  49 passed | 2 skipped (51)
   Duration  3.85s
EXIT=0
```

The two skipped cases are the POSIX-only `0600`-mode assertions. Everything else passes, including:

- **the hardlink publish** — `tightens a staged file, writes it, and links it into place` plus the five
  `publishing a win32 secret` cases; the staged file is tightened, hard-linked to the final path, and
  unlinked, so the final path carries the single ACE (sections 1 and 2 above are the live read-back of
  exactly that final path);
- **the fail-closed run against `*S-1-1-0:F`** — `refuses to hand back a secret that icacls cannot take
  away from Everyone`: a secret whose ACL still grants `Everyone` is rejected rather than returned;
- **the Cyrillic-directory case** — `secures secrets inside a directory whose name is not ASCII`.

`@bb/secret-storage` is one of the packages that passes outright in the Step 3 full-load run
(`31-test-results.md`, Table 1), and it also passed at the Phase 1 base — no regression either way.

## Gate bullet

> "secret files created on win32 read back an ACL containing only the current user"

**PASS.** Both the live server's `auth-secret` and a freshly created `telemetry-id` read back exactly
`OMEN\olege:(F)` with no inherited ACEs, including under a non-ASCII directory, against an ordinary file in
the same directory that carries four inherited ACEs.

## Cleanup

```powershell
pnpm dev:stop  -> [dev-app] desktop: not running / [dev-app] dev server: stopped / EXIT_STOP=0
Remove-Item -Recurse -Force C:\Users\olege\AppData\Local\Temp\bb-p2-*  -> removed bb-p2-cyr-Rk471S, bb-p2-telemetry-cspO3Y; remaining: 0
```

`BB_DATA_DIR` was never honoured, so nothing had to be unset beyond the shell that set it; no
`C:\Users\olege\.bb-dev\phase2-secrets-qa` directory was ever created.
