# Windows CI run (task 11)

Date: 2026-09-11
node -v: v22.19.0
git rev-parse HEAD (when the push in this step was made): 0eeb71c286cf701b921434a488ca11e1c86197bb
Machine: reference desktop, Windows 11 Pro 10.0.26200

## Push

```bash
git push -u origin windows-native/phase-0
```

Succeeded: `branch 'windows-native/phase-0' set up to track 'origin/windows-native/phase-0'` / `* [new branch] windows-native/phase-0 -> windows-native/phase-0`.

## Dispatch: BLOCKED — could not run the Windows CI job

```bash
gh workflow run ci.yml --ref windows-native/phase-0 -R OlegFM/bb
```

Result: `HTTP 404: workflow ci.yml not found on the default branch`. Also tried the full path (`gh workflow run .github/workflows/ci.yml ...`) and the raw REST call (`gh api -X POST repos/OlegFM/bb/actions/workflows/ci.yml/dispatches -f ref=windows-native/phase-0`) — both 404 with the same message.

### Root cause

`OlegFM/bb` (`origin`) is a fork of `get-bb/bb`, **created today at 2026-09-11T10:58:35Z** (`gh api repos/OlegFM/bb --jq '{created_at}'`), about 10 hours before this task ran. `ci.yml` genuinely exists on the fork's `main` at the exact commit we expect:

- `git ls-tree -r --name-only origin/main -- .github/workflows` lists `ci.yml`.
- `gh api repos/OlegFM/bb/contents/.github/workflows/ci.yml --jq '.sha'` returns a blob SHA for it.
- `gh api repos/OlegFM/bb/git/ref/heads/main --jq '.object.sha'` (`fa1f44ebe9e5676004b669e48c99b3c7606466b6`) matches `git rev-parse origin/main` exactly — the ref is fully synced, not stale.

But `gh api "repos/OlegFM/bb/actions/workflows"` lists only **one** workflow, `Version Lockstep` (`version-lockstep.yml`), `created_at`/`updated_at` both `2026-09-11T23:32:49Z` — i.e. it was registered by *this task's own* `git push` moments earlier. `version-lockstep.yml` has `on: { push, pull_request, workflow_dispatch }` (no branch filter), so pushing `windows-native/phase-0` triggered it (it shows up, queued forever, in `gh api repos/OlegFM/bb/actions/runs`, matching the amendments' note that Blacksmith-only jobs queue forever on the fork). `ci.yml`'s push trigger is `branches: [main]`, so the same push did **not** trigger it — and evidently GitHub's Actions subsystem only registers a workflow (making it visible to `GET .../actions/workflows` and dispatchable via `workflow_dispatch`) once it has actually run at least once on the fork, not merely by being present in the default branch's tree. Since this fork has never had a push to `main` and no PR has been opened against it, `ci.yml` has never run here and is invisible to the dispatch API — a chicken-and-egg gap specific to a same-day fork.

`repos/OlegFM/bb/actions/permissions` shows `{"enabled": true, "allowed_actions": "all"}`, so this is not a permissions/opt-in problem — Actions are fully enabled on the fork.

### What would unblock this

The two normal ways to make GitHub register `ci.yml` are (a) a push to the fork's `main` that touches, or at least replays, that push event, or (b) opening a pull request (whose `pull_request` trigger would run it). Both are outside this task's sanctioned actions: amendment D authorizes pushing `windows-native/phase-0` and dispatching the workflow, and amendment G explicitly forbids merging or opening a PR. Pushing to the fork's `main` branch was never mentioned as sanctioned or unsanctioned by the brief or amendments (the brief's plan only expected `gh workflow run` to work directly), so it was treated as a missing decision rather than guessed at, per this task's instructions to ask rather than guess when blocked. **No CI run happened; there is no run URL, job conclusion, step table, artifact, or CI test baseline to report.**

## Gate item

`qa/windows/phase-0/40-ci-run.md` links a green `windows-x64` job: **NO** — blocked as described above, not attempted-and-failed. This is the one Step 6 gate item this task could not evaluate.
