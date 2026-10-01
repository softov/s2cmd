#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createRegistry, output, CofoldError, type Command, type Registry } from "@cofold/commands";
import { Program, renderTable, runEntry } from "@cofold/terminal";
import { configGlobal, resolveConfig, type ResolvedConfig } from "@cofold/config";
import { reference } from "@cofold/commands/docs";
import { listTools } from "@cofold/mcp";
import { serveStdio } from "@cofold/mcp/stdio";
import { commandsFromDocument, configOf, programOf } from "./document.js";
import { loadDocument, parseDocument } from "./load.js";
import { configSchemaOf, setConfig } from "./config.js";
import { loadSources, sourceCommands, connectSources } from "./openapi.js";
import type { Argument } from "./values.js";
import { createDocumentServer } from "./serve.js";

/**
 * `s2cmd` - a command line whose commands are written in YAML or JSON.
 *
 * Commands already arrive here from two documents this library did not author:
 * a remote manifest and an OpenAPI specification. A file on disk is the same
 * seam a third time, and the third instance is what turns "commands are data"
 * from a claim into a property: the author of the document writes schemas,
 * surfaces and steps, and gets parsing, validation, help, completion, `--json`,
 * a generated reference, HTTP routes and MCP tools without writing a handler.
 *
 * One thing the document adds, because a file cannot hold a function: `run` is
 * a list of steps naming registered executors - `noop`, `internal`, `exec` and
 * `http` - and everything that can be wrong with one is a startup error.
 *
 * The safety rule is the reason this is a front end rather than a feature. A
 * document is a file anybody can edit, so a command holding an `exec` step
 * refuses to be published as an MCP tool or an HTTP route unless it says
 * `allowRemoteExec: true`. Otherwise one line in a YAML file would hand an
 * agent arbitrary shell.
 */

const VERSION = "0.1.0";

function readGlobal(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at !== -1 && argv[at + 1] !== undefined) return argv[at + 1];
  return argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** Groups only when the document gave every command one: a half-grouped surface is worse than none. */
function groupsFor(commands: readonly Command[]): { name: string; title: string; agent: boolean }[] {
  const declared = [...new Set(commands.map((command) => command.group))];
  if (declared.length === 0 || declared.some((group) => group === undefined)) return [];
  return [
    ...declared.map((name) => ({ name: name!, title: name!, agent: true })),
    { name: "meta", title: "This program", agent: false },
  ];
}

export function registryFor(
  document: Record<string, unknown>,
  options: {
    directory: string;
    environment: Readonly<Record<string, string | undefined>>;
    /** What `{$config.…}` reads. The document's own block unless a resolver widened it. */
    config?: Readonly<Record<string, unknown>>;
    additionalCommands?: Command[];
  },
): { registry: Registry<object>; commands: Command[] } {
  let built: Registry<object> | undefined;

  const local = commandsFromDocument(document, {
    directory: options.directory,
    environment: options.environment,
    config: options.config ?? configOf(document),
    // The registry does not exist yet, and an `internal` step only needs it
    // when something runs. A thunk is the whole of that problem.
    runner: () => built!,
    allowEmpty: (options.additionalCommands?.length ?? 0) > 0,
  });

  const commands = [...local, ...(options.additionalCommands ?? [])];
  const groups = groupsFor(commands);
  built = createRegistry(groups.length === 0 ? {} : { groups });
  built.register(...commands);
  return { registry: built, commands };
}

/** Every leaf of the resolved configuration, as the dotted paths `sourceOf` answers to. */
function pathsOf(values: Readonly<Record<string, unknown>>, prefix = ""): string[] {
  return Object.entries(values).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? pathsOf(value as Record<string, unknown>, path)
      : [path];
  });
}

function attempt<T>(read: () => T): T {
  try {
    return read();
  } catch (error: unknown) {
    process.stderr.write(`s2cmd: ${error instanceof Error ? error.message : "the document could not be read"}\n`);
    process.exit(error instanceof CofoldError ? error.exitCode : 3);
  }
}

async function build(argv: readonly string[]): Promise<Program> {
  const path = readGlobal(argv, "--document") ?? process.env["S2CMD_DOCUMENT"];
  if (path === undefined) {
    process.stderr.write("s2cmd: --document PATH is required (a YAML or JSON command document)\n");
    process.exit(2);
  }

  /*
   * A broken document is the ordinary failure of a program whose commands come
   * from a file, and the person who broke it is not the person who wrote this.
   * So it reads as one sentence and exits like a configuration fault, rather
   * than as the stack trace of a startup that had not reached `runEntry` yet.
   */
  const loaded = attempt(() => loadDocument(path));
  let sources: Awaited<ReturnType<typeof loadSources>>;
  try { sources = await loadSources(loaded.document["sources"], loaded.directory); }
  catch (error) { return attempt(() => { throw error; }); }
  const program = programOf(loaded.document, { name: "s2cmd", version: VERSION });

  /*
   * The document's own `config:` block is the bottom layer, and the files the
   * resolver finds are layered over it. So a document ships defaults, an
   * installation disagrees with two of them, and `{$config.x}` reads the answer
   * without either side knowing about the other.
   */
  const config = attempt((): ResolvedConfig => resolveConfig({
    name: program.name,
    base: configOf(loaded.document),
    // The file `config set` writes when no higher layer is active, found upwards
    // so a command run from a subdirectory still lands in the project's own.
    project: `.${program.name}.json`,
    parse: parseDocument,
    extensions: [".yaml", ".yml", ".json"],
    ...(readGlobal(argv, "--config") === undefined ? {} : { path: readGlobal(argv, "--config")! }),
  }));

  const { registry, commands } = attempt(() => registryFor(loaded.document, {
    directory: loaded.directory,
    environment: loaded.environment,
    config: config.values,
    additionalCommands: sourceCommands(sources),
  }));
  attempt(() => connectSources(registry, sources, { input: {}, config: config.values, env: loaded.environment },
    ((loaded.document["defaults"] as { http?: { headers?: Record<string, Argument> } } | undefined)?.http?.headers ?? {})));

  const grouped = groupsFor(commands).length > 0;
  const meta = grouped ? { group: "meta" } : {};

  if (sources.length) {
    registry.action({ id: "sources", summary: "List loaded OpenAPI sources and unsupported operations",
      surfaces: { cli: { pattern: ["sources"] } }, ...meta,
      run: () => output(sources.map((source) => ({ name: source.name, operations: source.manifest.commands.length, files: source.files, references: source.diagnostics, unsupported: source.issues }))),
    });
    for (const source of sources) if (source.issues.length) process.stderr.write(`${source.name}: omitted ${source.issues.length} unsupported operation(s); run sources --json for details\n`);
  }

  registry.action({
    id: "mcp.tools",
    summary: "Print the MCP tools this document would serve",
    surfaces: { cli: { pattern: ["mcp", "tools"] } },
    ...meta,
    run: () => output(listTools(registry)),
  });

  /*
   * The same list, spoken rather than printed.
   *
   * `mcp tools` was always the honest half of a promise: the document says
   * which commands are tools and this could show them, but an agent cannot
   * read a printout. `@cofold/mcp/stdio` closes it without costing the document
   * a dependency, which matters here more than anywhere - the whole point of a
   * command document is that a YAML file and a Node runtime are the only
   * things a program needs.
   *
   * The refusal in `document.ts` is what makes this safe to offer at all: a
   * command holding an `exec` step is not published unless it said
   * `allowRemoteExec: true`, so serving a document cannot quietly hand an agent
   * a shell.
   */
  registry.action({
    id: "mcp.serve",
    summary: "Serve this document's MCP tools on stdin and stdout",
    description: "Speaks MCP over stdio, for an agent that launches this command as a subprocess. Only commands declaring surfaces.mcp are served, and stdout carries nothing but protocol messages.",
    surfaces: { cli: { pattern: ["mcp", "serve"] } },
    ...meta,
    run: async () => {
      const server = serveStdio(registry, {
        name: program.name,
        version: program.version,
        ...(program.description === undefined ? {} : { instructions: program.description }),
        // Stdout belongs to the protocol, so anything a person should read goes the other way.
        onDiagnostic: (error) => {
          process.stderr.write(`${program.name}: ${error instanceof Error ? error.message : String(error)}\n`);
        },
      });
      await server.closed;
      return output(null, "");
    },
  });

  registry.action({
    id: "docs",
    summary: "Print the generated Markdown reference for this document",
    surfaces: { cli: { pattern: ["docs"] } },
    ...meta,
    run: (context) => {
      const text = reference(registry, { name: program.name, version: program.version });
      context.write(text);
      return output(null, "");
    },
  });

  registry.action({
    id: "config",
    summary: "Print the configuration, and which file each value came from",
    surfaces: { cli: { pattern: ["config"] } },
    ...meta,
    run: () => output(
      {
        values: config.values,
        layers: config.layers.map((layer) => ({ kind: layer.kind, path: layer.path })),
      },
      () => renderTable(
        ["path", "value", "from"],
        pathsOf(config.values).map((one) => [
          one,
          JSON.stringify(config.get(one)),
          config.sourceOf(one) ?? "",
        ]),
      ),
    ),
  });

  const schema = configSchemaOf(loaded.document);
  if (Object.keys(schema).length > 0) {
    registry.action({
      id: "config.keys",
      summary: "List writable configuration keys and their schemas",
      surfaces: { cli: { pattern: ["config", "keys"] } },
      ...meta,
      run: () => output(schema, () => renderTable(
        ["key", "type", "description", "default"],
        Object.entries(schema).map(([key, field]) => [key, field.type ?? "", field.description ?? "", JSON.stringify(field.default) ?? ""]),
      )),
    });
    registry.action({
      id: "config.set",
      summary: "Validate and save a writable configuration value",
      description: "Writable settings: " + Object.entries(schema)
        .map(([key, field]) => `${key} (${field.type}): ${field.description ?? ""}`).join("; "),
      input: {
        key: { type: "string", enum: Object.keys(schema), description: "Setting listed by config keys" },
        value: { type: "string", description: "New value; use JSON for arrays and objects" },
      },
      required: ["key", "value"],
      surfaces: { cli: { pattern: ["config", "set", ":key", ":value"] } },
      ...meta,
      run: ({ input }) => {
        const saved = setConfig(schema, config, program.name, input.key, input.value);
        return output(saved, `Saved ${saved.key} to ${saved.path}`);
      },
    });
  }

  registry.action({
    id: "serve",
    summary: "Answer the document's HTTP commands on a port",
    input: {
      port: { type: "integer", description: "Which port", minimum: 1, maximum: 65535, default: 8800 },
    },
    surfaces: { cli: { pattern: ["serve"] } },
    ...meta,
    run: (context) => {
      const { port } = context.input;
      createDocumentServer(registry, program).listen(port, "127.0.0.1", () => {
        context.write(`${program.name} on http://127.0.0.1:${port} (manifest at /cli-manifest)\n`);
      });
      return output(null, "");
    },
  });

  return new Program({
    name: program.name,
    version: program.version,
    description: program.description ?? `${loaded.files.length} document(s), as a command line.`,
    registry,
    globals: [
      { name: "--document", value: "PATH", description: "The command document", env: "S2CMD_DOCUMENT" },
      configGlobal,
    ],
  });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const argv = process.argv.slice(2);
  await runEntry(await build(argv), argv);
}

export { build };
