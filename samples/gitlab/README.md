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

The mappings cover identity, projects, users, labels, active milestones, issue search/read/create/update/state changes, and issue notes. State changes post the required reason first; if the second request fails, the note remains and the state is unchanged. For `issue update`, supply at least one field to change. Empty optional strings and arrays are omitted, so this sample does not clear descriptions or labels. Labels replace the entire label list; these direct API mappings do not implement Tasker's label vocabulary validation or component preservation. Search before creating issues.

The defaults target GitLab.com. The sample uses the existing REST executor and requires no GitLab SDK.
