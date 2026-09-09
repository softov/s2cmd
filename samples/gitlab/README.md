# GitLab sample

Set `GITLAB_TOKEN` in your environment or in an ignored `gitlab.env` file beside the document. For another instance, create `gitlab.local.yaml` here:

```yaml
config:
  api: https://git.example.com/api/v4
```

From the package root:

```sh
node dist/s2cmd.js --document samples/gitlab/gitlab.yaml --help
node dist/s2cmd.js --document samples/gitlab/gitlab.yaml me --json
node dist/s2cmd.js --document samples/gitlab/gitlab.yaml project list --json
node dist/s2cmd.js --document samples/gitlab/gitlab.yaml issue list --project 123 --page 1 --per_page 50 --json
node dist/s2cmd.js --document samples/gitlab/gitlab.yaml issue get --project 123 --iid 42 --json
node dist/s2cmd.js --document samples/gitlab/gitlab.yaml issue create --project 123 --title "Fix request validation"
node dist/s2cmd.js --document samples/gitlab/gitlab.yaml issue state --project 123 --iid 42 --state_event close --note "Fixed and verified"
```

Use numeric project IDs from `project list` and project-local issue numbers (`iid`). Each list returns one page; advance `--page` explicitly. Responses are raw GitLab JSON. `note list` includes system events, identified by `system: true`.

The mappings cover identity, projects, users, labels, active milestones, issue search/read/create/update/state changes, and issue notes. State changes post the required reason first; if the second request fails, the note remains and the state is unchanged. For `issue update`, supply at least one field to change. Empty optional strings and arrays are omitted, so this sample does not clear descriptions or labels. Labels replace the entire label list, so `issue update --labels` overwrites every label an issue already has rather than adding to them. Search before creating issues.

The defaults target GitLab.com. The sample uses the existing HTTP executor and requires no GitLab SDK.

Alternatively, save the API endpoint through the CLI:

```sh
npm run dev -- --document samples/gitlab/gitlab.yaml config keys
npm run dev -- --document samples/gitlab/gitlab.yaml config set api https://gitlab.example.com/api/v4
npm run dev -- --document samples/gitlab/gitlab.yaml config
```

Only `api` is declared writable in this sample. It must be an absolute HTTP(S) URI. With no external configuration file loaded, this creates `.gitlab.json` in the current directory. The token continues to come from `GITLAB_TOKEN`.

Authentication and Accept headers are shared through `defaults.http.headers`. Each `run.http` step inherits them; use `inheritHeaders: false` when adding a request that must not receive those headers.
