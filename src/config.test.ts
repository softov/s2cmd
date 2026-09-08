import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "facio/config";
import { configOf, commandsFromDocument } from "./document.js";
import { parseDocument } from "./load.js";
import { configSchemaOf, parseConfigValue, setConfig } from "./config.js";

const schema = configSchemaOf({ configSchema: {
  api: { type: "string", format: "uri", pattern: "^https?://", default: "https://gitlab.com/api/v4" },
  timeout: { type: "integer", minimum: 1, maximum: 120, default: 30 },
  enabled: { type: "boolean" },
  theme: { type: "string", enum: ["dark", "light"] },
  tags: { type: "array", items: { type: "string", minLength: 1 } },
  server: { type: "object", properties: { port: { type: "integer", minimum: 1 } }, required: ["port"] },
} });
const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "s2cmd-config-"));
  directories.push(path);
  return path;
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function resolve(cwd: string, path?: string) {
  return resolveConfig({ name: "example", cwd, home: cwd, env: {}, parse: parseDocument,
    extensions: [".yaml", ".yml", ".json"], ...(path === undefined ? {} : { path }) });
}

describe("config schema", () => {
  it.each([
    ["timeout", "60", 60], ["enabled", "false", false], ["theme", "dark", "dark"],
    ["tags", '["a","b"]', ["a", "b"]], ["server", '{"port":80}', { port: 80 }],
  ])("converts %s before saving", (key, raw, expected) => {
    expect(parseConfigValue(schema, String(key), String(raw))).toEqual(expected);
  });

  it.each([
    ["unknown", "value"], ["constructor", "value"], ["timeout", "121"], ["timeout", "1.5"],
    ["enabled", "maybe"], ["theme", "blue"], ["api", "https://"], ["api", "file:///tmp/x"],
    ["tags", '[""]'], ["server", '{"port":0}'], ["server", '{"port":80,"other":1}'],
  ])("rejects invalid %s=%s", (key, raw) => {
    expect(() => parseConfigValue(schema, key, raw)).toThrow();
  });

  it("uses schema defaults below document values without making other values writable", () => {
    expect(configOf({ configSchema: schema, config: { timeout: 45, fixed: "value" } }))
      .toEqual({ api: "https://gitlab.com/api/v4", timeout: 45, fixed: "value" });
    expect(() => parseConfigValue(schema, "fixed", "other")).toThrow("not writable");
  });

  it.each([
    { x: { type: "string", typo: true } }, { x: { type: "integer", default: "wrong" } },
    { x: { type: "integer", minimum: 20, maximum: 10 } }, { "a.b": { type: "string" } },
    { x: { type: "string", format: "made-up" } },
  ])("rejects invalid schema declarations at document registration", (configSchema) => {
    expect(() => commandsFromDocument({ configSchema, commands: { hello: { summary: "Hello", run: "noop" } } }))
      .toThrow();
  });
});

describe("config persistence", () => {
  it("creates a project file and reads it back without copying defaults", () => {
    const cwd = directory();
    setConfig(schema, resolve(cwd), "example", "timeout", "60", cwd);
    expect(JSON.parse(readFileSync(join(cwd, ".example.json"), "utf8"))).toEqual({ timeout: 60 });
    expect(resolve(cwd).get("timeout")).toBe(60);
  });

  it.each(["json", "yaml", "yml"])("preserves other values in an explicit %s file", (ext) => {
    const cwd = directory();
    const path = join(cwd, `settings.${ext}`);
    writeFileSync(path, ext === "json" ? '{"other":{"kept":true},"timeout":10}' : "other: { kept: true }\ntimeout: 10\n");
    setConfig(schema, resolve(cwd, path), "example", "enabled", "false", cwd);
    expect(resolve(cwd, path).values).toEqual({ other: { kept: true }, timeout: 10, enabled: false });
  });

  it("does not change the file after invalid input", () => {
    const cwd = directory();
    const path = join(cwd, ".example.json");
    writeFileSync(path, '{"timeout":10}');
    expect(() => setConfig(schema, resolve(cwd), "example", "timeout", "0", cwd)).toThrow();
    expect(readFileSync(path, "utf8")).toBe('{"timeout":10}');
  });

  it("writes the highest-priority active layer and preserves the lower file", () => {
    const cwd = directory();
    writeFileSync(join(cwd, ".example.json"), '{"timeout":10}');
    const path = join(cwd, "explicit.json");
    writeFileSync(path, '{}');
    setConfig(schema, resolve(cwd, path), "example", "timeout", "60", cwd);
    expect(resolve(cwd, path).get("timeout")).toBe(60);
    expect(resolve(cwd).get("timeout")).toBe(10);
  });

  it("supports CLI set, key discovery, and subsequent reads in separate processes", () => {
    const cwd = directory();
    const path = join(cwd, "document.json");
    writeFileSync(path, JSON.stringify({ name: "example", configSchema: schema,
      commands: { hello: { summary: "Hello", run: "noop" } } }));
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"),
      fileURLToPath(new URL("./s2cmd.ts", import.meta.url)), "--document", path, ...args],
      { cwd, encoding: "utf8", env: { ...process.env, EXAMPLE_CONFIG: "", XDG_CONFIG_HOME: cwd } });
    const keys = run("config", "keys", "--json");
    expect(keys.status, keys.stderr).toBe(0);
    expect(JSON.parse(keys.stdout)).toHaveProperty("api.format", "uri");
    const result = run("config", "set", "api", "https://git.example.com/api/v4");
    expect(result.status, result.stderr).toBe(0);
    const read = run("config", "--json");
    expect(read.status, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout).values.api).toBe("https://git.example.com/api/v4");
    expect(run("config", "set", "api", "https://").status).not.toBe(0);
    expect(run("config", "set", "unknown", "value").status).not.toBe(0);
  });
});
