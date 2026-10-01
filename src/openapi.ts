import { resolve } from "node:path";
import { ConfigurationError, output, type Command, type Registry } from "@cofold/commands";
import { commandsFrom, manifestFromOpenApi, type OpenApiDocument, type OpenApiOptions, type ProgramManifest } from "@cofold/remote";
import { loadYaml } from "@cofold/yaml";
import { resolveValue, type Argument, type Scope } from "./values.js";
import { ApiSession } from "./auth.js";

export interface OpenApiSource {
  name: string; settings: Record<string, unknown>; spec: Record<string, unknown>; manifest: ProgramManifest;
  files: string[]; diagnostics: { reference: string; message: string }[]; issues: { id: string; method: string; path: string; reason: string }[];
}
function map(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigurationError(`${label} must be a mapping`);
  return raw as Record<string, unknown>;
}
export async function loadSources(raw: unknown, directory: string): Promise<OpenApiSource[]> {
  if (raw === undefined) return [];
  const sources: OpenApiSource[] = [];
  for (const [name, value] of Object.entries(map(raw, "sources"))) {
    const settings = map(value, `sources.${name}`);
    for (const key of Object.keys(settings)) if (!["type", "path", "endpoint", "tags", "hints", "prefix", "mcp", "auth", "refs"].includes(key)) throw new ConfigurationError(`sources.${name}: unknown ${key}`);
    if (settings["type"] !== "openapi" || typeof settings["path"] !== "string") throw new ConfigurationError(`${name} requires type: openapi and a path`);
    for (const key of ["tags", "prefix"]) if (settings[key] !== undefined
      && (!Array.isArray(settings[key]) || !(settings[key] as unknown[]).every((one) => typeof one === "string"))) {
      throw new ConfigurationError(`${name}.${key} must be a list of strings`);
    }
    if (settings["mcp"] !== undefined && typeof settings["mcp"] !== "boolean") throw new ConfigurationError(`${name}.mcp must be boolean`);
    const path = /^https?:/u.test(settings["path"]) ? settings["path"] : resolve(directory, settings["path"]);
    const refs = settings["refs"] === undefined ? {} : map(settings["refs"], "refs");
    for (const [key, value] of Object.entries(refs)) if (!["local", "remote"].includes(key) || typeof value !== "boolean") {
      throw new ConfigurationError(`${name}.refs accepts boolean local and remote options`);
    }
    const loaded = await loadYaml(path, { refs: { local: refs["local"] !== false, remote: refs["remote"] !== false, circular: "preserve", unresolved: "preserve" } });
    const spec = map(loaded.data, path);
    if (typeof spec["openapi"] !== "string" || !/^3\.[01]\./u.test(spec["openapi"])) throw new ConfigurationError(`${path}: expected OpenAPI 3.0 or 3.1`);
    const issues: OpenApiSource["issues"] = [];
    const manifest = manifestFromOpenApi(spec as OpenApiDocument, {
      program: { name, version: String((spec["info"] as Record<string, unknown> | undefined)?.["version"] ?? "0.0.0") },
      ...(settings["tags"] ? { tags: settings["tags"] as string[] } : {}),
      ...(settings["hints"] ? { hints: settings["hints"] as OpenApiOptions["hints"] & {} } : {}),
      onUnsupported: (issue) => issues.push(issue),
    });
    if (manifest.commands.length === 0) throw new ConfigurationError(`${name}: no supported operations; ${issues.map((one) => one.reason).join("; ")}`);
    sources.push({ name, settings, spec, manifest, files: loaded.sources, diagnostics: loaded.diagnostics, issues });
  }
  return sources;
}
export function serverOf(source: OpenApiSource): string {
  const servers = source.spec["servers"] as { url?: string; variables?: Record<string, { default?: string }> }[] | undefined;
  const server = servers?.[0];
  if (!server?.url) throw new ConfigurationError(`${source.name}: set an endpoint; the specification has no server URL`);
  const url = server.url.replace(/\{([^}]+)\}/gu, (_, key: string) => {
    const value = server.variables?.[key]?.default;
    if (value === undefined) throw new ConfigurationError(`${source.name}: server variable ${key} has no default`);
    return value;
  });
  if (!/^https?:/u.test(url)) throw new ConfigurationError(`${source.name}: relative server URLs require an explicit endpoint`);
  return url;
}
export function sourceCommands(sources: OpenApiSource[]): Command[] {
  return sources.flatMap((source) => commandsFrom(source.manifest, {
    capability: `source_${source.name}`,
    prefix: source.settings["prefix"] as string[] | undefined ?? (sources.length > 1 ? [source.name] : []),
    expose: () => source.settings["mcp"] === true,
  }).map((command) => ({ ...command, id: `${source.name}:${command.id}`, group: command.group ?? source.name })));
}
export function connectSources(registry: Registry<object>, sources: OpenApiSource[], scope: Scope, headers: Record<string, Argument>): void {
  for (const source of sources) {
    const endpoint = source.settings["endpoint"] === undefined ? serverOf(source)
      : String(resolveValue(source.settings["endpoint"] as Argument, scope, "OpenAPI endpoint"));
    if (!URL.canParse(endpoint) || !/^https?:/u.test(endpoint)) throw new ConfigurationError(`${source.name}: endpoint must be an absolute HTTP(S) URL`);
    const session = new ApiSession({ endpoint, source: source.name, scope, headers,
      ...(source.settings["auth"] ? { auth: map(source.settings["auth"], "auth") } : {}),
    });
    const paths = source.spec["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    registry.provide(`source_${source.name}`, { description: `HTTP for ${source.name}`, resolve: () => ({
      request: (binding: Parameters<ReturnType<ApiSession["transport"]>["request"]>[0], input: Record<string, unknown>) => {
        const operation = paths[binding.path]?.[binding.method.toLowerCase()];
        const security = operation?.["security"] ?? source.spec["security"];
        const anonymous = Array.isArray(security) && (security.length === 0 || security.some((one) => one !== null && typeof one === "object" && Object.keys(one).length === 0));
        return session.transport(anonymous).request(binding, input);
      },
    }) });
    const prefix = sources.length > 1 ? [source.name] : [];
    if (source.settings["auth"]) {
      for (const verb of ["login", "status", "logout"] as const) registry.action({
        id: `${source.name}:auth.${verb}`, ...(registry.groups.length ? { group: "meta" } : {}), summary: `${verb} authentication for ${source.name}`,
        surfaces: { cli: { pattern: [...prefix, "auth", verb] } },
        run: async () => output(await session[verb]()),
      });
    }
  }
}
