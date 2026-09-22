# shared-github

Central, hardened source of shared GitHub Actions CI building blocks for the
`fortify` organization: generated wrapper actions around allow-listed 3rd-party
actions, plus hand-written reusable actions/workflows. Consumer repositories
(e.g. `fcli`) reference this repo instead of using 3rd-party actions or
duplicating CI logic directly.

## Layout

```
actions/3rdparty/<owner>/<repo>/v<major>/action.yml   # generated wrapper actions
actions/fortify/<name>/action.yml                     # hand-written, org-owned actions
.github/workflows/reusable-*.yml                      # reusable workflows (workflow_call only)
.github/workflows/local-*.yml                         # workflows that run for this repo only
scripts/generate.js                                   # wrapper generator
```

- **`actions/3rdparty/`** — composite wrapper actions, one per allow-listed
  3rd-party action major version. Content here is entirely generated; never
  hand-edit it.
- **`actions/fortify/`** — hand-written, org-owned composite actions.
- **`.github/workflows/`** — both reusable and repo-local workflows live here
  (GitHub does not support subdirectories under `.github/workflows/`). The
  `reusable-` / `local-` filename prefix, mirrored in each workflow's `name:`
  field (`'Reusable: ...'` / `'Local: ...'`), is the naming convention used to
  tell the two apart:
  - `reusable-*.yml` — triggered only by `workflow_call`; meant to be called
    from other repos via `uses: fortify/shared-github/.github/workflows/<file>@<sha>`.
  - `local-*.yml` — runs only for this repo (e.g. `workflow_dispatch`,
    `schedule`); not meant to be called from elsewhere.

## Process: keeping wrapper actions current

1. An org admin adds/updates an allowed action at
   `https://github.com/organizations/fortify/settings/actions`. Allowed
   actions should ideally be pinned by commit SHA, not a version tag/branch.
2. The admin (or a schedule) triggers **Local: Generate third-party composite
   actions** (`local-generate-composites.yml`) in this repo.
3. The workflow reads the org's allow-list via a GitHub App installation
   token (the App is scoped to read-only org-level allow-list access —
   nothing else), regenerates `actions/3rdparty/**`, and — only if every
   changed path is under `actions/3rdparty/**` — opens a pull request using
   the job's own `GITHUB_TOKEN`. If the generator produced changes outside
   that directory, the job fails instead of opening a PR.
4. A CODEOWNERS-designated reviewer reviews and merges the PR into `main`,
   which is protected (PR required, required approvals, no direct pushes).

Consumer repositories use pinned SHAs. Their bump workflow checks the latest
`shared-github/main` commit on every push, daily, manually, or through the
`shared-github-updated` `repository_dispatch` event. If pins are stale, the
workflow prints a copy/pasteable patch in the job summary and fails visibly.
The patch is applied by a maintainer, who then opens the normal consumer PR.
This is deliberate: the default `GITHUB_TOKEN` cannot modify files under
`.github/workflows/`, so the current design does not grant a workflow-file-write
App or PAT to every consumer.

Current migrated consumers include `fcli`, `fcli-docker`, and
`tool-definitions`. Parser plugin repositories and other Fortify repositories
remain to be migrated.

## Consuming this repo

Reference wrapper actions and reusable workflows by commit SHA, never
`@main`:

```yaml
- uses: fortify/shared-github/actions/3rdparty/<owner>/<repo>/v<major>@<sha>
- uses: fortify/shared-github/actions/fortify/<name>@<sha>

jobs:
  some-job:
    uses: fortify/shared-github/.github/workflows/reusable-<name>.yml@<sha>
```

Currently available reusable workflows: `reusable-check-duplicate-run.yml`
(skip a push-triggered run when an open PR already covers the same branch),
`reusable-fortify-analysis.yml` (Fortify on Demand SAST/SCA scan), and
`reusable-update-repo-docs.yml` (updates downstream generated docs from a
pinned `shared-doc-resources` commit), and `reusable-bump-shared-pin.yml`
(see below). The local workflows also include the wrapper generator and the
automated `shared-doc-resources` pin checker.

a schedule:
To check that pin without hand-editing or silently changing workflow files, add
a workflow to the consumer repo that calls the **Reusable: Bump shared-github
pin** workflow:

```yaml
# .github/workflows/bump-shared-github.yml
name: Bump shared-github pin

on:
  schedule:
    - cron: '0 6 * * *'   # daily
  workflow_dispatch:
  push:
  repository_dispatch:
    types: [shared-github-updated]

permissions:
  contents: read

jobs:
  bump:
    uses: fortify/shared-github/.github/workflows/reusable-bump-shared-pin.yml@<pinned-sha>
```

When a pin is stale, the reusable workflow emits a small unified diff and
commands such as `git apply` in the job summary, then fails. Apply that patch
on a local branch and open a normal reviewed PR. It updates all
`fortify/shared-github/...@<sha>` references in the consumer's workflow files
at once, covering wrappers, hand-written actions, and reusable workflows.

The workflow only updates references already pinned to a 40-character commit
SHA; initial conversion from `@main` or a tag is a deliberate migration step.
A future central dispatcher can trigger the existing
`repository_dispatch` event without changing each consumer workflow again.

## Outputs & `all_upstream_outputs`

Most upstream actions declare outputs in their `action.yml`; the generator
mirrors those outputs into the wrapper so callers can reference
`steps.<id>.outputs.<name>` as before. Some upstream actions don't declare
outputs statically (they set `GITHUB_OUTPUT` at runtime). To support those
cases:

- The generator always exposes a JSON catch-all output named
  `all_upstream_outputs`, whose value is `${{ toJSON(steps.upstream.outputs) }}`.
  Callers can parse that JSON and re-export individual outputs if needed.
- To make a wrapper behave exactly like the original upstream action (so
  callers can reference `steps.<id>.outputs.<name>` directly), declare the
  expected outputs in `outputs.json` at the repository root. The generator
  prefers `outputs.json` over the upstream action's own declared outputs when
  building wrapper metadata.

`outputs.json` format examples:

- object mapping output name to description (recommended):

  ```json
  {
    "googleapis/release-please-action@v4": {
      "release_created": "Whether a release was created",
      "tag_name": "Tag name created"
    }
  }
  ```

- or an array of output names:

  ```json
  {
    "owner/repo@v1": ["output1", "output2"]
  }
  ```

Notes:
- Key format is `owner/repo@v<major>` (for example
  `googleapis/release-please-action@v4`).
- If you don't want to declare every output upfront, use
  `all_upstream_outputs` and add a small step in the calling workflow that
  parses the JSON and writes individual outputs to `GITHUB_OUTPUT`.

See `outputs.json` in this repository for real entries.

## Repository security model

- A `protect-main` ruleset is configured to require PR review (including Code
  Owners), block direct pushes/force pushes, and use an empty bypass list;
  verify that its enforcement status is Active before relying on it.
- `CODEOWNERS` requires review on `actions/3rdparty/`, `actions/fortify/`,
  `.github/workflows/`, and `scripts/`.
- The only GitHub App used here is scoped to a read-only, org-level
  permission (reading the allow-list); it is never used for git operations.
  All git pushes and PR creation use the workflow's own `GITHUB_TOKEN`,
  scoped via each workflow's `permissions:` block.
- The generator workflow validates its own diff stays within
  `actions/3rdparty/**` before pushing anything, so a compromised
  `generate.js` (or a compromised npm dependency of it) cannot touch
  `.github/workflows/**`, `actions/fortify/**`, or `scripts/**`.
- Consumer pin checks are read-only and do not hold credentials capable of
  modifying workflow files. A future fully automatic PR design would require
  a narrowly installed GitHub App with workflow-file write permission; that is
  intentionally not part of the current model.
