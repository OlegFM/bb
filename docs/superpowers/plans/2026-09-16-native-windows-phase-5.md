# Native Windows Phase 5 — persistent host and acceptance

> Execution: use subagent-driven-development, one implementation task at a time,
> with independent review. Continue authorized local work without another design
> approval; the umbrella design is approved and the user authorized this phase.

**Goal:** Enroll a persistent Windows host from PowerShell, expose the same flow
through the app and existing CLI/SDK pairing operations, and record the remaining
requirements for native Windows general availability honestly.

**Architecture:** Add a Windows-only installer served by the existing server.
It installs the server's host artifact into a private per-server npm prefix,
enrolls the existing daemon, and registers a per-user logon launcher. Existing
macOS/Linux installation and wire contracts remain unchanged.

**Tech:** Windows PowerShell 5.1 and PowerShell 7, Node 22.19+, Hono, React,
Vitest, Turbo, existing bb host daemon and Connect pairing.

**Spec:** `docs/superpowers/specs/2026-09-11-native-windows-port-design.md`,
especially sections 2, 4, 7 (Phase 5), 8, and 10.

## Global constraints

- Base is Phase 4 commit `fafaf454a`; branch `windows-native/phase-5` is stacked
  directly on it. No merge into main, force push, or publication.
- Preserve POSIX behavior. Inject platform in shared code; no new wire fields.
- Follow root AGENTS.md: no code comments, boundary validation, Turbo checks,
  real DB tests, no generated modules in commits.
- Installer-created configuration and credentials are private before publication;
  ACL failure is fatal. Never persist join or machine codes in a launcher.
- Reject unsupported URLs/paths and never terminate an unrelated listener.
- Use isolated temporary data for live QA; remove only artifacts made by QA.
- Keep beta status until every spec gate has measured evidence. A fixture test
  is not evidence of real logon, a clean VM, live Connect, or signed release.
- Use `qa/windows/CHECKLIST.md` as the canonical checklist (spec section 10).

## Task 1: Windows installer and route

Files: add `apps/server/src/assets/install-machine.ps1`; edit
`apps/server/src/server.ts`, `apps/server/test/app/skeleton.test.ts`; add
`apps/server/test/app/install-machine-powershell.test.ts` and a focused fixture
under `apps/server/test/fixtures/` if needed. Do not modify install-machine.sh.

1. Add failing route and real PowerShell tests first. Execute PowerShell with
   `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File` and separate args.
   Test missing/invalid inputs, checksum mismatch/missing checksum, successful
   artifact installation, existing artifact reuse, native failure, pairing,
   port collision, rerun, and registration fallback. OS service operations may
   be intercepted by fixture functions in the child PowerShell only; never
   change the user's real autostart settings in unit tests.
2. Implement `-JoinCode`, `-HostId`, `-Server`, optional `-MachineCode` and
   `-HostDaemonPort`, plus help. Support 5.1 and 7 without execution-policy or
   PATH changes. Validate Node floor, URL origin, ports, and drive-local data.
3. Use a stable origin-specific directory under `.bb-machines` (honor existing
   `BB_DATA_DIR`) and private npm prefix. Download `/install/bb-app.tgz`, require
   its SHA-256 header, verify before npm, and cache the digest only after success.
   Fail closed when the server artifact is unavailable; do not silently install
   an unrelated registry version. Support conditional reuse of a complete local
   installation. Find npm's JavaScript entry and invoke it through Node to avoid
   untrusted CMD interpolation; retain native addon install-script allowance.
4. Allocate a loopback daemon port distinct from Desktop. Reserve it atomically
   per data directory; a stale occupied port is reassigned unless explicitly
   requested. An unrelated listener is never stopped. Fail on incompatible
   existing enrollment instead of replacing its identity.
5. Redeem optional Connect code using the existing request/response contract,
   validate credentials, write private config, enroll with the join code, and
   wait for matching host/server and connected status with a bounded deadline.
6. Generate an absolute-path launcher containing no transient secrets. Register
   a limited per-user Scheduled Task at logon, falling back to HKCU Run if task
   registration is denied. Start hidden; preserve the launcher's environment;
   make reruns idempotent with no duplicate startup registration. Print paths,
   service identity, logs, and exact uninstall instructions.
7. Serve `/install.ps1` with no-store and text content type; existing asset-copy
   build must carry it into the artifact. Test response bytes and headers.
8. Run focused tests and server typecheck through Turbo, capture logs and exit
   status, review, fix findings, and commit this seam.

Commands (PowerShell):

```powershell
pnpm.cmd exec turbo run test --filter=@bb/server --output-logs=new-only -- --maxWorkers=2 test/app/install-machine-powershell.test.ts test/app/skeleton.test.ts
pnpm.cmd exec turbo run typecheck --filter=@bb/server --output-logs=new-only
```

## Task 1b: Windows server artifact dependency

Inspection found two existing blockers on the installer path:
`services/install/bb-app-artifact.ts` executes bare npm/pnpm through execFile,
which cannot start their Windows shims, and its packaged-host materialization
omits `bb.cmd` even when the package advertises win32.

Files: `apps/server/src/services/install/bb-app-artifact.ts` and
`apps/server/test/app/bb-app-artifact.test.ts`.

1. Reproduce the default runner failure with the existing real packaged fixture.
2. Add injected platform to service options/default runner. On Windows resolve
   npm/pnpm using existing `resolveSpawnPlanOrThrow` from process-utils and run
   the direct Node entry, hidden, without shell interpolation. Preserve the
   existing POSIX execFile call and commandRunner interface.
3. Packages advertising win32 must include the existing `bb.cmd` artifact when
   materialized on any server OS. Do not require it in older POSIX-only packages.
4. Test real tarball bytes, win32 artifact inclusion/failure when missing, and
   unchanged POSIX package layout. Accept actual Windows filesystem error codes
   in fixture assertions instead of pretending NTFS returns EISDIR.
5. Run focused artifact tests and server typecheck, review and commit.

```powershell
pnpm.cmd exec turbo run test --filter=@bb/server --output-logs=new-only -- --maxWorkers=2 test/app/bb-app-artifact.test.ts
```

## Task 2: Pairing command in UI and discoverable CLI/SDK flow

Files: `apps/app/src/components/dialogs/AddMachineDialog.tsx` and its test;
`docs/multiple-devices.md`, `docs/platform-windows.md`; appropriate existing
machine chapter in `packages/templates/src/templates/bb-guide-*.md` and
`plugins/bb-guide/skills/bb-cli/` reference; `docs/configuration.md` only if
documenting installer interpretation of BB_DATA_DIR requires clarification.

1. Add explicit target-shell selection for macOS/Linux and Windows PowerShell.
   Preserve the current shell command for the default macOS/Linux selection.
   A browser may enroll a different OS; do not infer the target from the server.
2. Render a quoted Windows command downloading to a temporary file, invoke
   powershell.exe with named parameters, and clean the temporary file. Keep
   codes out of persistent files. The copied command must match selection.
3. Test shell switching, Connect/direct server variants, quoting, expiry and
   copy behavior. Retain the existing responsive Dialog infrastructure.
4. Document native prerequisites, installer flags, storage, autostart, restart,
   logs, removal, private artifact policy, and coexistence with Desktop.
   Document existing `bb machine join-code --json`, `bb connect machine-code
--json`, and `sdk.hosts.createJoinCode()` / Connect RPC as equivalent access;
   no redundant new CLI command or public SDK member is needed.
5. Run focused UI tests and typecheck through Turbo; run relevant Connect CLI
   tests on Windows. Review, fix, and commit.

```powershell
pnpm.cmd exec turbo run test --filter=@bb/app --output-logs=new-only -- --maxWorkers=2 src/components/dialogs/AddMachineDialog.test.tsx
pnpm.cmd exec turbo run typecheck --filter=@bb/app --output-logs=new-only
pnpm.cmd exec turbo run test --filter=bb-plugin-connect --output-logs=new-only -- --maxWorkers=2
```

Confirm the Connect package name from its manifest before running its command.

## Task 3: Integrated evidence and GA gate inventory

Files: `.github/workflows/ci.yml`, `qa/windows/phase-5/`, `qa/windows/CHECKLIST.md`,
`docs/platform-windows.md`, `docs/platform-support.md`.

1. Build the server with Turbo and verify the shipped installer bytes.
2. Exercise native PowerShell 5.1 and 7 against an isolated loopback server,
   preserving logs and structured assertions. Verify failure cleanup and no
   changes to the user's existing bb profile or autostart registrations.
3. Inventory all win32-skipped tests and classify each as equivalent coverage,
   unreachable capability with documented reason, or an open acceptance gap.
   Do not add blanket skips to produce a green Windows job.
4. Capture current CI definitions and external workflow/branch-protection
   availability. Add a gating Windows step for the new installer, artifact,
   route and AddMachineDialog tests; the current baseline selection excludes
   server and app. Separate required-check configuration from passing jobs.
5. Create a clean-VM checklist covering every spec section 2 row, including WSL
   disabled, real logon restart, real Connect pairing, Desktop coexistence,
   CLI/SDK, signing and all regression jobs. Record unexecuted rows as pending.
6. Reconcile Phase 4's 19 server failure files and 5 Desktop failure files into
   a prioritized GA backlog with evidence links. Fix failures caused by this
   phase immediately; unrelated baseline hardening remains an explicit next
   slice, never a successful gate.
7. Whole-branch review, relevant verification, and commit evidence. Do not flip
   beta to supported or make failing baseline jobs required prematurely.

## Acceptance boundary

Tasks 1–2 deliver the persistent-host implementation. Task 3 records what is
proven and what still blocks the umbrella Phase 5 gate. Real clean-VM/logon and
live Connect validation require their actual environments; they cannot be
substituted by fake service registrations or a WSL-enabled developer machine.
Full Windows baseline remediation and required external CI/branch protection
are a subsequent hardening slice, with no claim that Phase 5 is finished here.

## Local execution result

Tasks 1, 1b and 2 are implemented and independently reviewed. Task 3 completed
isolated native integration on the final product head `43ff7f339b` with explicit
exit 0 for both PowerShell versions. See
[the portable verification report](../../../qa/windows/phase-5/03-native-integration.md)
and its structured JSON for exact checks, hashes and limits. Whole-phase review
and the final evidence commit are recorded with the local delivery.

The user confirmed that no clean VM is available and agreed to leave that gate
open. This does not close the umbrella Phase 5 gate or change native Windows
from beta. The acceptance inventory and skip audit retain the remaining work.
