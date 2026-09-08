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

Run directly from TypeScript during development, passing CLI arguments after `--`:

```sh
npm run dev -- --document samples/depot/depot.yaml --help
npm run dev -- --document samples/gitlab/gitlab.yaml --help
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

## Writable configuration

Declare settings users may change in `configSchema`. Keys in `config` alone remain read-only through the CLI.

```yaml
configSchema:
  api:
    type: string
    format: uri
    pattern: "^https?://"
    description: GitLab API endpoint
    default: https://gitlab.com/api/v4
  timeout:
    type: integer
    minimum: 1
    maximum: 120
    default: 30
```

```sh
npm run dev -- --document samples/gitlab/gitlab.yaml config keys
npm run dev -- --document samples/gitlab/gitlab.yaml config set api https://gitlab.example.com/api/v4
npm run dev -- --document samples/gitlab/gitlab.yaml config
```

`config keys --json` prints the complete schemas, including constraints. `config set KEY VALUE` rejects unknown keys and invalid values before writing. These commands appear when the document declares writable settings. They are CLI-only.

Each key is a simple top-level name. Types are string, number, integer, boolean, array, or object. Arrays and objects take JSON text; object properties must be declared. Numeric bounds, string length/pattern, enums, constants, and URI/date-time formats are validated. Imported schemas merge by setting name; a later declaration replaces that setting’s whole schema. Schema defaults sit below the document's `config` values and external configuration layers. This declaration controls setting values; existing configuration files are not retroactively validated.

The writer updates the highest-priority file already loaded: explicit `--config`, program configuration environment variable, project file, then user file. If none exists, it creates `.<program>.json` in the working directory (`.gitlab.json` for GitLab). Explicit files must already exist. Only the selected key is changed; unrelated values are preserved, and defaults are not copied into the file. YAML files are rewritten as YAML with flow values; comments and original formatting are not preserved. Writes replace the file atomically; the next invocation reads the saved value.
