# `build-desktop.yml` QA run (Phase 4 gate, Step 13, second half)

> ## Verdict: **not run — blocked by the fork's workflow registry, not by this branch.**
>
> `gh workflow run build-desktop.yml --ref windows-native/phase-4 -f publish=false -f release_channel=qa`
> returns **HTTP 404** on `OlegFM/bb`. The workflow file is present and correct on the fork's default
> branch; GitHub has simply never registered it on this fork, and registering it requires a push to the
> fork's `main`, which this task is not permitted to make. The remedy is a
> **`MANUAL — for the user`** item at the bottom of this file.
>
> This is an environment limitation of the fork, in the same class as the `blacksmith-*` runner labels that
> `41-ci-run.md` records: the branch's own Windows packaging path is exercised end to end by the
> `Windows x64` job of `ci.yml` (**success**, `41-ci-run.md`) and by the full local `dist:windows` →
> install → run → update → uninstall sequence in `20-…` through `26-…`. No part of the gate's Windows
> verdict depends on this dispatch.

## What was attempted, verbatim

```bash
gh workflow run build-desktop.yml --ref windows-native/phase-4 -f publish=false -f release_channel=qa 2>&1; echo "DISPATCH_EXIT=$?"
```

```
HTTP 404: workflow build-desktop.yml not found on the default branch (https://api.github.com/repos/OlegFM/bb/actions/workflows/build-desktop.yml)
DISPATCH_EXIT=1
```

The same call through the REST API, in case `gh` was resolving the name rather than the path:

```bash
gh api -X POST repos/OlegFM/bb/actions/workflows/build-desktop.yml/dispatches \
  -f ref=windows-native/phase-4 -f 'inputs[publish]=false' -f 'inputs[release_channel]=qa' 2>&1; echo "API_EXIT=$?"
```

```
{"message":"Not Found","documentation_url":"https://docs.github.com/rest/actions/workflows#create-a-workflow-dispatch-event","status":"404"}
gh: Not Found (HTTP 404)
API_EXIT=1
```

By workflow display name rather than file name:

```bash
gh workflow run "Build Desktop" --ref windows-native/phase-4 -f publish=false -f release_channel=qa 2>&1; echo "EXIT=$?"
```

```
could not find any workflows named Build Desktop
EXIT=1
```

## Why: the fork's registry holds two workflows, not fifteen

```bash
gh api "repos/OlegFM/bb/actions/workflows?per_page=100" --jq '{total:.total_count, list:[.workflows[]|{name,path,state}]}'
```

```json
{
  "total": 2,
  "list": [
    { "name": "CI", "path": ".github/workflows/ci.yml", "state": "active" },
    {
      "name": "Version Lockstep",
      "path": ".github/workflows/version-lockstep.yml",
      "state": "active"
    }
  ]
}
```

`gh workflow list --all` prints the same two rows, so this is not a disabled-workflow state that could be
flipped with `PUT /actions/workflows/{id}/enable` — the workflow has no id on this fork at all.

The file itself is present on the default branch and is the byte the dispatch would have read:

```bash
gh api repos/OlegFM/bb --jq '{default_branch,fork,parent:.parent.full_name}'
gh api repos/OlegFM/bb/commits/main --jq '.sha'
gh api 'repos/OlegFM/bb/contents/.github/workflows/build-desktop.yml?ref=main' --jq '.sha, .size'
git ls-tree origin/main .github/workflows/ --name-only | grep build-desktop
```

```
{"default_branch":"main","fork":true,"parent":"get-bb/bb"}
fa1f44ebe9e5676004b669e48c99b3c7606466b6
463300652d8d43444659a1b048f8fc48cdd130b7
15660
.github/workflows/build-desktop.yml
```

Actions are enabled on the fork and unrestricted:

```bash
gh api repos/OlegFM/bb/actions/permissions
```

```json
{ "enabled": true, "allowed_actions": "all", "sha_pinning_required": false }
```

So the cause is GitHub's lazy workflow registration on forks: a workflow file becomes dispatchable once
the repository has processed an event that references it — for `ci.yml` and `version-lockstep.yml` that
was this branch's `push`, because both carry `push` triggers on `windows-native/**`. `build-desktop.yml`
is `workflow_dispatch`-only, so nothing has ever registered it here, and the only event that would is a
**push to the fork's `main`**. This task is explicitly not allowed to touch `main`, and doing so to satisfy
a piece of evidence would be the wrong trade: it would move the fork's default branch for a QA dispatch.

## What the run would have measured, and where that is covered instead

`.github/workflows/build-desktop.yml` has four jobs. On this fork only one of them could run at all:

| job                                        | `runs-on`                      | can it run on `OlegFM/bb`?                                                                    |
| ------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------- |
| `macos` (macOS arm64 desktop artifacts)    | `blacksmith-6vcpu-macos-15`    | no — self-hosted label the fork has no runner for                                             |
| `linux` (Linux x64 desktop artifacts)      | `blacksmith-4vcpu-ubuntu-2404` | no — same                                                                                     |
| `windows` (Windows x64 desktop artifacts)  | `windows-2025`                 | yes — the one hosted label that works here                                                    |
| `publish` (Publish stable desktop release) | `blacksmith-4vcpu-ubuntu-2404` | no, and it `needs: [macos, linux, windows]`, so it would be skipped even if the label existed |

That is the second, independent reason this dispatch could not have produced the evidence the brief asks
for: the `publish` job's plan step — the one that emits `should_publish` and
`publish_windows_binaries` — `needs` the two `blacksmith` jobs, so on this fork it would never execute even
after the workflow is registered. Its outputs can only be read from a run on `get-bb/bb`.

The plan step is nevertheless fully determined for `publish=false` / `release_channel=qa`, and the
determination is visible in the workflow source (`.github/workflows/build-desktop.yml`, `Plan release
publication`):

```bash
SHOULD_PUBLISH="false"
if [[ "$INPUT_PUBLISH" == "true" && "$RELEASE_CHANNEL" == "stable" && "$IS_PRERELEASE" == "false" ]]; then
  SHOULD_PUBLISH="true"
fi
…
PUBLISH_WINDOWS_BINARIES="false"
if [[ "$HAS_WINDOWS_SIGNING_SECRETS" == "true" ]]; then
  PUBLISH_WINDOWS_BINARIES="true"
elif [[ "$SHOULD_PUBLISH" == "true" ]]; then
  echo "::warning::Windows signing secrets are missing; publishing the Windows version feed only and withholding the unsigned .exe installer."
fi
```

With `inputs.publish=false` the first condition's `"$INPUT_PUBLISH" == "true"` arm is false, so
`should_publish=false`; with no Azure Trusted Signing secrets on the fork,
`has_windows_signing_secrets=false` and therefore `publish_windows_binaries=false`. Both are the values the
brief expects — but they are **read from the workflow source here, not observed in a run**, and this file
does not claim otherwise.

The `windows` job's own product work _was_ measured, twice over:

- **On a `windows-2025` runner**, by `ci.yml`'s `Windows x64` job at this exact commit: `package:windows`,
  `smoke:packaged` and `smoke:windows-processes` all green (`41-ci-run.md`). `build-desktop.yml`'s
  `windows` job runs `desktop:build:windows` — the full NSIS installer rather than `--dir` — plus the same
  two smokes and `desktop:version-feed`.
- **Locally**, by `20-build-installer.md`: `pnpm --filter @bb/desktop run dist:windows` produces exactly the
  four paths the job's `Upload desktop workflow artifacts` step globs
  (`apps/desktop/release/*.exe`, `*.blockmap`, `latest.yml`, `desktop-version-windows.json`), and
  `24-quit-orphans.md` runs the process-hygiene smoke three times.

The artifact **names** the run would have produced are fixed by the workflow and are worth recording even
unobserved, since a later gate will compare against them:

| artifact                                 | contents                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `bb-desktop-windows-x64`                 | `apps/desktop/release/*.exe`, `*.blockmap`, `latest.yml`, `desktop-version-windows.json` (`if-no-files-found: error`) |
| `bb-desktop-windows-x64-process-hygiene` | `apps/desktop/qa-artifacts/process-hygiene/*.json` (`if-no-files-found: warn`, `if: always()`)                        |
| `bb-desktop-macos-arm64`                 | macOS job, cannot run here                                                                                            |
| `bb-desktop-linux-x64`                   | Linux job, cannot run here                                                                                            |

Their **sizes** are not recorded, because no run produced them; the local `release/` sizes in
`20-build-installer.md` are the closest available figure for the Windows set.

## `MANUAL — for the user`

Two items, in order. Neither is a code change and neither blocks the phase.

1. **Register `build-desktop.yml` on the fork.** On `OlegFM/bb`, push any commit to `main` (syncing the
   fork from `get-bb/bb` through the repository page's **Sync fork** button is enough, and is the least
   invasive option). Then confirm registration:

   ```bash
   gh api "repos/OlegFM/bb/actions/workflows?per_page=100" --jq '[.workflows[].path]'
   ```

   `.github/workflows/build-desktop.yml` must appear in that list.

2. **Dispatch the QA run and record it.** With the workflow registered:

   ```bash
   gh workflow run build-desktop.yml --ref windows-native/phase-4 -f publish=false -f release_channel=qa
   gh run list --workflow build-desktop.yml --branch windows-native/phase-4 --limit 1
   gh run view <id> --json jobs --jq '.jobs[] | "\(.name): \(.status) \(.conclusion)"'
   gh api repos/OlegFM/bb/actions/runs/<id>/artifacts --jq '.artifacts[] | "\(.name) \(.size_in_bytes)"'
   ```

   Expect the `windows` job to succeed and the `macos`, `linux` and `publish` jobs to stay queued or be
   skipped for the runner-label reason above. The `publish` job's plan output
   (`should_publish=false`, `publish_windows_binaries=false`) can only be observed on `get-bb/bb`, where
   the `blacksmith` runners exist; on the fork it is unobservable by construction.
