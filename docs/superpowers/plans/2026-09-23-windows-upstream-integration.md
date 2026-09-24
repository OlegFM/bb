# Windows upstream integration plan

**Goal:** Merge upstream `71bd54e9e` into the native Windows branch at `0342032bf`, preserving both sets of behavior and validating the resulting tree before publication.

**Architecture:** A merge commit retains the published Windows history and current upstream history. Resolve independent domain conflicts on exclusive paths, then run coordinated integration checks. The original checkout remains unchanged until the integration branch is verified.

**Spec:** Existing native Windows design and `qa/windows/phase-5/05-local-hardening.md`; current upstream code is authoritative for newer product contracts and architecture.

## Constraints

- No upstream PR until contributor approval and feature sign-off. Do not merge the fork's main branch or force-push.
- Preserve Windows functionality and newer upstream behavior. Do not choose an entire side merely to remove conflict markers.
- Root owns the Git index, dependency manifests, lockfile and build/test lane. Domain workers edit exclusive source paths without Git mutations or concurrent suites.
- Preserve upstream migration history. Regenerate a new Drizzle migration/snapshot for the merged schema; never hand-edit snapshot JSON.
- Bump the daemon protocol above upstream 217 for the additional Windows wire contracts.
- No GUI, user profile changes or authenticated provider sessions. Keep Windows beta and all unexecuted acceptance gates explicit.

## Tasks

- [x] Resolve host/runtime/process/workspace/provider conflicts listed in `.superpowers/upstream-integration-2026-09-23/host-paths.txt`; compare stages 1/2/3 and retain native cleanup/path regressions.
- [x] Resolve app/Desktop conflicts listed in `desktop-paths.txt`; adapt Windows framing/lifecycle to newer upstream architecture and respect moved/deleted files.
- [x] Resolve server/database conflicts listed in `server-paths.txt`; retain canonical path ownership, remote-host boundaries and installer behavior, regenerate migrations after dependencies are ready.
- [x] Resolve root/build/plugin/CLI/documentation conflicts listed in `root-paths.txt`; preserve upstream dependency versions and portable Windows build/launch behavior, then regenerate the pnpm lockfile.
- [x] Verify no unresolved index entries or conflict markers remain, install frozen dependencies, regenerate required outputs through Turbo, and run affected typechecks.
- [x] Run native regression suites covering server, Desktop/UI, daemon/process/workspace, database, plugin build and changed providers; diagnose failures on the merged tree and compare upstream where attribution is uncertain.
- [x] Run an independent integration review, final affected build, formatting and diff checks. Record exact results and limitations in portable QA evidence.
- [x] Commit the merge, fast-forward the original Windows branch after verifying its clean unchanged state, and update the previously authorized fork branch without force. Keep upstream PR unopened pending approval.

## Review focus

- Newly redesigned upstream window chrome must retain Windows controls and compact layouts without reintroducing obsolete framing modules.
- Existing databases from current upstream and the Windows beta require explicit migration-path coverage; canonical path constraints must not drop or merge distinct projects.
- Native executable resolution, terminal cleanup and provider lifecycle must retain newer upstream cancellation/session behavior.
- Remote Windows and POSIX daemon paths must remain host-owned even when the server runs on the other OS.
- Auto-merged files may still reference removed upstream APIs; typechecks and focused semantic review must cover those callers as well as textual conflicts.
