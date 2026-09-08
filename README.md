# s2cmd

A standalone package that turns YAML or JSON command documents into a CLI, HTTP routes and MCP tools using `facio`.

## Development

Requires Node.js 22 or newer. The `facio` dependency currently uses the sibling checkout at `../facio`.

```sh
npm --prefix ../facio run build
npm install
npm run check
node dist/s2cmd.js --document samples/depot/depot.yaml --help
node dist/s2cmd.js --document samples/depot/depot.yaml mcp tools
node dist/s2cmd.js --document samples/depot/depot.yaml release build -e staging
```

`npm link` makes the `s2cmd` command available locally after building.

The sample's pet and deployment commands call the facio petshop example on port 8799. Start it from the facio checkout with `npm run examples` followed by `node examples/dist/petshop/cli.js serve --port 8799`.

## Command documents

Documents declare `commands`, their input schemas, surfaces and execution steps. Supported executors are `noop`, `internal` (another registered command), `exec` (a process), and `rest` (an HTTP request). Steps run in order and stop at the first failure.

`imports` composes documents and `env` loads environment files. Paths resolve relative to the document. See `samples/depot/depot.yaml` for a complete example.

Process arguments are arrays. Commands that run processes, including through internal calls, require `allowRemoteExec: true` before being exposed through HTTP or MCP.

The included YAML reader supports a restricted subset; use JSON for documents requiring unsupported YAML features.

## Packaging

`npm pack` builds the CLI and packages the compiled files and samples. Before publishing for use outside this checkout layout, replace the local `facio` dependency with the corresponding published version.

The [GitLab sample](samples/gitlab/README.md) maps GitLab projects, issues, notes and reference data through REST commands.
