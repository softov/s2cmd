import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ArgumentError, ConfigurationError, check, decode, type JsonSchema } from "facio";
import type { ResolvedConfig } from "facio/config";
import { parseDocument } from "./load.js";

export type ConfigSchema = Record<string, JsonSchema>;
const TYPES = ["string", "number", "integer", "boolean", "array", "object"];
const KEYS = ["type", "description", "enum", "const", "default", "minimum", "maximum", "minLength", "maxLength", "pattern", "format", "items", "properties", "required"];
const safeKey = (key: string): boolean => /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key)
  && !["__proto__", "prototype", "constructor"].includes(key);

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function schemaFrom(raw: unknown, label: string): JsonSchema {
  const held = mapping(raw, label);
  for (const key of Object.keys(held)) {
    if (!KEYS.includes(key)) throw new ConfigurationError(`${label}: unknown schema keyword ${key}`);
  }
  if (!TYPES.includes(String(held["type"]))) throw new ConfigurationError(`${label}: a supported type is required`);
  for (const key of ["description", "pattern", "format"]) {
    if (held[key] !== undefined && typeof held[key] !== "string") throw new ConfigurationError(`${label}.${key} must be text`);
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength"]) {
    const value = held[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value)
      || (key.endsWith("Length") && (!Number.isInteger(value) || value < 0)))) {
      throw new ConfigurationError(`${label}.${key} is not a valid bound`);
    }
  }
  for (const [min, max] of [["minimum", "maximum"], ["minLength", "maxLength"]] as const) {
    if (held[min] !== undefined && held[max] !== undefined && Number(held[min]) > Number(held[max])) {
      throw new ConfigurationError(`${label}.${min} exceeds ${max}`);
    }
  }
  if (held["enum"] !== undefined && (!Array.isArray(held["enum"]) || held["enum"].length === 0)) {
    throw new ConfigurationError(`${label}.enum must be a nonempty list`);
  }
  if (held["required"] !== undefined && (!Array.isArray(held["required"]) || !held["required"].every((key) => typeof key === "string"))) {
    throw new ConfigurationError(`${label}.required must be a list of property names`);
  }
  if (held["pattern"] !== undefined) new RegExp(String(held["pattern"]), "u");
  if (held["format"] !== undefined && !["uri", "date-time"].includes(String(held["format"]))) {
    throw new ConfigurationError(`${label}: format must be uri or date-time`);
  }
  const allowedTypes: Record<string, string[]> = {
    minimum: ["number", "integer"], maximum: ["number", "integer"],
    minLength: ["string"], maxLength: ["string"], pattern: ["string"], format: ["string"],
    items: ["array"], properties: ["object"], required: ["object"],
  };
  for (const [keyword, types] of Object.entries(allowedTypes)) {
    if (held[keyword] !== undefined && !types.includes(String(held["type"]))) {
      throw new ConfigurationError(`${label}.${keyword} does not apply to ${held["type"]}`);
    }
  }
  const schema = { ...held } as JsonSchema;
  if (held["items"] !== undefined) schema.items = schemaFrom(held["items"], `${label}.items`);
  if (held["properties"] !== undefined) schema.properties = schemaMap(held["properties"], `${label}.properties`);
  if (schema.default !== undefined) validateConfigValue(schema.default, schema, `${label}.default`);
  return schema;
}

function schemaMap(raw: unknown, label: string): ConfigSchema {
  return Object.fromEntries(Object.entries(mapping(raw, label)).map(([key, value]) => {
    if (!safeKey(key)) throw new ConfigurationError(`${label}: invalid key ${key}; use simple top-level names`);
    return [key, schemaFrom(value, `${label}.${key}`)];
  }));
}

export function configSchemaOf(document: Record<string, unknown>): ConfigSchema {
  return schemaMap(document["configSchema"] ?? {}, "configSchema");
}

export function configDefaults(schema: ConfigSchema): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).filter(([, value]) => value.default !== undefined)
    .map(([key, value]) => [key, value.default]));
}

export function validateConfigValue(value: unknown, schema: JsonSchema, label: string): void {
  check(value, schema, label);
  // facio checks types and bounds; URI validation is specific to this setting contract.
  if (schema.format === "uri" && (typeof value !== "string" || !URL.canParse(value) || /\s/u.test(value))) {
    throw new ArgumentError(`${label} must be an absolute URI`);
  }
  if (schema.type === "object") {
    for (const [key, one] of Object.entries(value as Record<string, unknown>)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) throw new ArgumentError(`${label}.${key} is not declared`);
      validateConfigValue(one, schema.properties![key]!, `${label}.${key}`);
    }
  }
  if (schema.type === "array" && schema.items !== undefined) {
    for (const one of value as unknown[]) validateConfigValue(one, schema.items, label);
  }
}

export function parseConfigValue(schema: ConfigSchema, key: string, raw: string): unknown {
  if (!Object.hasOwn(schema, key)) throw new ArgumentError(`${key} is not writable; use config keys`);
  const field = schema[key]!;
  let value: unknown;
  try {
    value = field.type === "array" || field.type === "object" ? JSON.parse(raw) : decode(raw, field);
  } catch {
    throw new ArgumentError(`${key} must be valid JSON`);
  }
  validateConfigValue(value, field, key);
  return value;
}

/** Write only the selected layer, keeping unrelated settings and defaults out of the file. */
export function setConfig(schema: ConfigSchema, resolved: ResolvedConfig, name: string, key: string, raw: string,
  cwd = process.cwd()): { path: string; key: string; value: unknown } {
  const value = parseConfigValue(schema, key, raw);
  if (!safeKey(name)) throw new ConfigurationError(`Cannot select a config file for program name ${name}`);
  const layer = resolved.layers.filter((one) => one.kind !== "base").at(-1);
  const path = layer?.path ?? join(cwd, `.${name}.json`);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    let held: Record<string, unknown> = {};
    let mode = 0o600;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) throw new ConfigurationError(`${path} must be a regular file`);
      mode = stat.mode & 0o777;
      held = parseDocument(readFileSync(path, "utf8"), path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = { ...held, [key]: value };
    // Flow values are in the supported YAML subset; JSON files retain JSON formatting.
    const text = path.endsWith(".json") ? JSON.stringify(next, null, 2)
      : Object.entries(next).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join("\n");
    writeFileSync(temp, text + "\n", { mode, flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    throw new ConfigurationError(`Could not save ${path}: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    try { unlinkSync(temp); } catch { /* No temporary file remains after a successful rename. */ }
  }
  return { path, key, value };
}
