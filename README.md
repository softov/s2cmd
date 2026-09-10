# s2cmd

**Write the commands in a file. Get a CLI, an HTTP API and MCP tools.**

[![npm](https://img.shields.io/npm/v/s2cmd.svg)](https://www.npmjs.com/package/s2cmd)
[![node](https://img.shields.io/node/v/s2cmd.svg)](https://www.npmjs.com/package/s2cmd)
[![license](https://img.shields.io/npm/l/s2cmd.svg)](LICENSE)

## What it is

A YAML or JSON document declares commands: their input schemas, which surfaces they appear on, and what they run. `s2cmd` reads it and hands the whole thing to [`facio`](https://github.com/softov/facio), which is where the surfaces come from.

Nobody writes a handler, and nobody implements a surface.

```yaml
# pets.yaml
name: depot
version: 1.0.0

config:
  api: http://localhost:8799

commands:
  pet.add:
    summary: Add a pet
    input:
      name: { type: string, minLength: 1 }
      age:  { type: integer, minimum: 0, default: 1 }
    surfaces:
      cli:  { pattern: [pet, add, ":name"] }
      http: { method: POST, path: /pets }
      mcp:  true
    run:
      http:
        method: POST
        endpoint: "{$config.api}/pets"
        body: { name: "{name}", age: "{age}" }
```

One file, three surfaces:

```sh
# a command line, with parsing, coercion, validation, --help and completion
s2cmd --document pets.yaml pet add Ada --age 99
s2cmd --document pets.yaml pet add Ada --json

# an HTTP API of its own
s2cmd --document pets.yaml serve --port 8801 &
curl -X POST localhost:8801/pets -d '{"name":"Ada","age":99}'

# the tools an agent would receive
s2cmd --document pets.yaml mcp tools
```

A command that runs a *process* is the same shape, with one more word — see [below](#a-shell-step-does-not-become-an-agent-tool-by-accident) for why that word is required:

```yaml
  release.deploy:
    summary: Deploy the application
    input:
      env:   { type: string, enum: [staging, production], default: production, cli: { short: -e } }
      force: { type: boolean, default: false, cli: { short: -f } }
    surfaces:
      cli: { pattern: [release, deploy] }
    run:
      - exec: { command: ./scripts/build.sh, args: ["{env}"] }
      - exec:
          command: ./scripts/deploy.sh
          args:
            - "{env}"
            - { when: force, value: "--force" }
```

Everything a document-defined command needs already existed in `facio` except one thing. `run` is a function, and a file cannot hold one, so execution is stated as data: named executors and an ordered list of steps. `input` is the same map of JSON Schema `registry.action` takes and `surfaces` is the same declaration, so the terminal, an HTTP request and an MCP tool call are held to one rule exactly as they are in code.

## Install

```sh
npm install -g s2cmd
```

Node.js 22 or newer.

## YAML parser

YAML parsing comes from the reusable `facio/yaml` subpath. The current parser supports a documented subset and reports the source file and line on syntax errors. s2cmd owns document composition and command validation.

## Executors

| executor   | what it does                                            |
| ---------- | ------------------------------------------------------- |
| `noop`     | nothing: the word that only exists to hold subcommands  |
| `internal` | another command of the same document, through `execute` |
| `exec`     | one process, given its arguments as argv                |
| `http`     | one HTTP call (`rest` remains an alias)                 |

Steps run in order and stop at the first failure. A single step may be written unwrapped, and a bare name is a step with nothing to configure (`run: noop`). An executor the document does not name is a registration error, so it is a crash on the first run rather than a surprise on the one command nobody tested. So is a placeholder naming no field, an `internal` step calling a command the document does not declare, and two of them calling each other.

**Arguments are arrays, never a shell string.** Interpolating a value into a shell string is command injection the moment that value comes from anywhere but the author's own keyboard, and here it comes from whoever typed the command. `args` is a list and reaches the process as one, so `;` and `$(...)` in a value arrive as literal text. `shell: true` is how to ask for the other behaviour, and asking is the point.

**No template language.** `{{#if force}}--force{{/if}}` means a dependency and an argument list that gets re-parsed. The input is already validated and typed, so the two things a template is used for are data instead: `{ when: force, value: "--force" }` drops a value, `{ each: tags, value: "--tag={$item}" }` repeats one. Interpolation is one rule with no exception: `$` means "not an input field". Everything without it is the input, all the way down, so `{env}` is the field a deploy command always has and `{theme.mode}` reaches into a structured one. `{$env.NAME}` is the environment, `{$config.theme.mode}` is the resolved configuration, and `{$item}` is the value of the surrounding `each`.

## A shell step does not become an agent tool by accident

If MCP came for free, a YAML file would be a set of tools an agent can call and `exec` is arbitrary shell. `surfaces.mcp` being off by default already prevents the worst of it; `s2cmd` goes further and refuses to publish a command holding an `exec` step as an MCP tool or an HTTP route unless that command says so:

```yaml
    allowRemoteExec: true
```

Separate from `surfaces`, refused loudly rather than dropped quietly, and it travels: a command whose only step calls another command that runs a process is a command that runs a process. `http` and `internal` steps default the normal way.

## Composing documents

`imports:` composes other documents and `env:` loads environment files, both taking a bare path or `{ path: ..., optional: true }` for a file that may not be there. Paths resolve relative to the document. Later wins, and the importing document wins over everything it imported.

## YAML, without a dependency

`facio` has no dependencies and a command document is not worth one, so the included reader covers the subset a document is written in and **refuses the rest by name** — anchors, aliases, custom tags, merge keys, multiple documents. A hand-written YAML parser is a liability exactly to the extent that it accepts a document and reads it differently from a real one, and refusing is how that is bounded. Nothing downstream reads YAML: the reader takes parsed data, so a full parser is a one-line substitution for anybody who wants one, and JSON is always available for a document that needs what the subset refuses.

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
s2cmd --document samples/gitlab/gitlab.yaml config keys
s2cmd --document samples/gitlab/gitlab.yaml config set api https://git.example.com/api/v4
s2cmd --document samples/gitlab/gitlab.yaml config
```

`config keys --json` prints the complete schemas, including constraints. `config set KEY VALUE` rejects unknown keys and invalid values before writing. These commands appear when the document declares writable settings. They are CLI-only.

Each key is a simple top-level name. Types are string, number, integer, boolean, array, or object. Arrays and objects take JSON text; object properties must be declared. Numeric bounds, string length/pattern, enums, constants, and URI/date-time formats are validated. Imported schemas merge by setting name; a later declaration replaces that setting's whole schema. Schema defaults sit below the document's `config` values and external configuration layers. This declaration controls setting values; existing configuration files are not retroactively validated.

The writer updates the highest-priority file already loaded: explicit `--config`, program configuration environment variable, project file, then user file. If none exists, it creates `.<program>.json` in the working directory (`.gitlab.json` for GitLab). Explicit files must already exist. Only the selected key is changed; unrelated values are preserved, and defaults are not copied into the file. YAML files are rewritten as YAML with flow values; comments and original formatting are not preserved. Writes replace the file atomically; the next invocation reads the saved value.

## HTTP defaults

Share HTTP headers across a document:

```yaml
defaults:
  http:
    headers:
      PRIVATE-TOKEN: "{$env.GITLAB_TOKEN}"
      Accept: application/json

commands:
  me:
    summary: Read the authenticated user
    run:
      http:
        method: GET
        endpoint: "{$config.api}/user"
```

`http` is the canonical executor name; existing `rest` steps use the same executor and `defaults.http`. Defaults currently support HTTP headers only. Header names merge case-insensitively, and a step's value replaces the corresponding default. Placeholders are evaluated when that step runs. Imports merge defaults, with later imports and the importing document winning.

For a request to another service, omit shared credentials explicitly:

```yaml
run:
  http:
    method: GET
    endpoint: https://example.com/status
    inheritHeaders: false
    headers:
      Accept: application/json
```

`inheritHeaders: false` removes all document-default headers for that step while retaining its own headers. Defaults do not apply to other executors.

## Samples

| Sample                                     | Shows                                                        |
| ------------------------------------------ | ------------------------------------------------------------ |
| [`depot`](samples/depot/depot.yaml)        | Every executor, imports, environment files, all three surfaces |
| [`gitlab`](samples/gitlab/README.md)       | A real REST API as commands, with writable configuration      |

The depot sample's pet commands call the `facio` petshop example on port 8799. From a `facio` checkout: `npm run examples && node examples/dist/petshop/cli.js serve --port 8799`.

## Development

The `facio` dependency currently uses the sibling checkout at `../facio`.

```sh
npm --prefix ../facio run build
npm install
npm run check

node dist/s2cmd.js --document samples/depot/depot.yaml --help
```

Run directly from TypeScript, passing CLI arguments after `--`:

```sh
npm run dev -- --document samples/depot/depot.yaml --help
```

`npm link` makes the `s2cmd` command available locally after building.

## Packaging

`npm pack` builds the CLI and packages the compiled files and samples. Before publishing for use outside this checkout layout, replace the local `facio` dependency with the corresponding published version.

## Documentation

`s2cmd` is a front end for [`facio`](https://github.com/softov/facio), whose manual covers everything a surface does with a command once it has been declared:

* [Getting started](https://github.com/softov/facio/blob/main/docs/01-getting-started.md)
* [Actions](https://github.com/softov/facio/blob/main/docs/02-actions.md)
* [Configuration](https://github.com/softov/facio/blob/main/docs/10-config.md)

## License

[MIT](LICENSE)

## OpenAPI sources

A command document can import OpenAPI 3.0/3.1 operations alongside handwritten commands. See [the Controllr sample](samples/openapi/README.md).

```yaml
sources:
  service:
    type: openapi
    path: ./api/openapi.yaml
    endpoint: "{$config.api}"
    tags: [Clients]
    hints:
      listClients:
        pattern: [client, list]
```

`path` accepts a local YAML/JSON file or an HTTP(S) URL. Local paths are relative to the declaring wrapper, including when that wrapper is imported. References are resolved relative to the file or URL that contains them. `refs: { local: false, remote: false }` disables external reference locations; internal JSON Pointers remain available. Remote specifications cannot import local files. Specification fetches carry no API authentication headers and do not follow redirects.

If `endpoint` is omitted, the first specification server is used with its variable defaults expanded. Use `configSchema` to declare writable endpoint/authentication settings. `tags`, operation-ID `hints` (`pattern`, `group`, `summary`, `skip`), `prefix`, and `mcp: true` control the imported surface. Without operation IDs, hint keys are the lowercase method plus dotted path, such as `post.controllrctl.client.list`. Imported MCP exposure is off by default.

Only supported input schemas are advertised. JSON and `application/x-www-form-urlencoded` object request bodies are supported; array/object field values use JSON text at the CLI. Multipart uploads, unresolved input references, union/composition schemas, and header/cookie input parameters are reported as unsupported rather than silently flattened. The loader's `sources --json` command lists loaded files, reference diagnostics, and omitted operations.

Handwritten HTTP steps can select `contentType: application/x-www-form-urlencoded` as well. Authentication belongs to an OpenAPI source: Basic uses `username`/`password` templates; cookie mode uses a `login` object with `path`, `body`, and optional `contentType` (form encoding by default). Authentication credentials are evaluated only for requests. There is no automatic login or retry of failed writes.

Generated OpenAPI command words always follow the API path (`POST /invoice_ctl/bank/list` becomes `invoice-ctl bank list`). Tags are display headings only, even when translated; operation IDs remain identifiers. Only explicit `hints.pattern` or `x-cli.pattern` overrides command spelling. Hints can use operation IDs or method-plus-dotted-path keys, so path hints remain stable when a spec adds operation IDs. The actual HTTP path is preserved.

Operations that share a generated command path require explicit naming hints to distinguish them; the importer reports collisions instead of picking one HTTP method.
