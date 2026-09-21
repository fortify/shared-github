# Fortify 3rd-party action wrapper generator

This repo contains a generator workflow that reads the organization's allowed actions list and generates composite wrapper actions under `actions/3rdparty/<owner>/<repo>/v<major>/action.yml`. GitHub Action workflows within the github.com/fortify organization should not use 3rd-party actions directly, but instead use the wrapper actions provided in this repository.

Quick usage instructions:
- All allowed actions should be listed under `Allow or block specified actions and reusable workflows` at https://github.com/organizations/fortify/settings/actions
- Ideally, allowed action versions should be specified by SHA, not version tags/branches
- Whenever the list of allowed actions is updated, the `Generate third-party composite actions` workflow in this repository must be triggered
- The workflow will output warnings for outdated SHA references
- The workflow will output warnings for non-SHA action references, including the corresponding SHA, allowing for easily updating the allow list to use the appropriate SHA

Outputs & `all_upstream_outputs`
--------------------------------

Most upstream actions declare outputs in their `action.yml`; the generator mirrors those outputs into the wrapper so callers can reference `steps.<id>.outputs.<name>` as before. Some upstream actions do not declare outputs (they may set `GITHUB_OUTPUT` at runtime). To support those cases:

- The generator always exposes a JSON catch-all output named `all_upstream_outputs` whose value is `${{ toJSON(steps.upstream.outputs) }}`. Callers can parse that JSON and re-export individual outputs if needed.
- To make wrapper actions behave exactly like the original upstream action (so callers can continue to reference `steps.<id>.outputs.<name>`), you may declare expected outputs in `outputs.json` at the repository root. The generator will prefer `outputs.json` when creating wrapper metadata.

`outputs.json` format examples:

- object mapping output name to description (recommended):

```
{
	"googleapis/release-please-action@v4": {
		"release_created": "Whether a release was created",
		"tag_name": "Tag name created"
	}
}
```

- or an array of output names:

```
{
	"owner/repo@v1": [ "output1", "output2" ]
}
```

Notes:
- Key format is `owner/repo@v<major>` (for example `googleapis/release-please-action@v4`).
- When entries are present in `outputs.json`, the generator will add those outputs to the wrapper action so callers can reference them directly.
- If you don't want to declare every output upfront, continue to use `all_upstream_outputs` and add a small capture step in calling workflows that parses the JSON and writes individual outputs to `GITHUB_OUTPUT`.

See `outputs.json` in this repository for an example entry.