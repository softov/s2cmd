import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDocument, parseEnvFile } from "./load.js";

const loaded = loadDocument(fileURLToPath(new URL("../samples/depot/depot.yaml", import.meta.url)));

describe("the document, composed", () => {
  it("applies the imports before the file that imported them", () => {
    expect(loaded.files.map((one) => one.split("/").pop()))
      .toEqual(["depot.defaults.yaml", "depot.yaml"]);
    expect(loaded.document["config"]).toMatchObject({ api: "http://127.0.0.1:8799" });
  });

  it("passes over a file that said it might not be there", () => {
    expect(loaded.files.some((one) => one.endsWith("depot.local.yaml"))).toBe(false);
    expect(loaded.environment["RELEASE_CHANNEL"]).toBe("stable");
  });

  it("resolves imports and env away, so the reader takes a composed document", () => {
    expect(loaded.document["imports"]).toBeUndefined();
    expect(loaded.document["env"]).toBeUndefined();
  });
});

describe("composing documents", () => {
  const files: Record<string, string> = {
    "/doc/main.yaml": [
      "imports: [base.yaml, over.yaml]",
      "config: { who: main }",
      "commands:",
      "  own:",
      "    summary: Declared here",
      "    run: noop",
    ].join("\n"),
    "/doc/base.yaml": [
      "config: { who: base, kept: yes }",
      "commands:",
      "  shared:",
      "    summary: From base",
      "    run: noop",
    ].join("\n"),
    "/doc/over.yaml": [
      "config: { who: over }",
      "commands:",
      "  shared:",
      "    summary: From over",
      "    run: noop",
    ].join("\n"),
  };

  const read = (one: string): string => {
    const text = files[one];
    if (text === undefined) throw Object.assign(new Error(`no ${one}`), { code: "ENOENT" });
    return text;
  };

  it("lets a later import win, and the importing file win over all of them", () => {
    const composed = loadDocument("/doc/main.yaml", { readFile: read, environment: {} });
    expect(composed.document["config"]).toEqual({ who: "main", kept: "yes" });
    expect((composed.document["commands"] as Record<string, { summary: string }>)["shared"]?.summary)
      .toBe("From over");
  });

  it("refuses documents that import each other", () => {
    const circular = {
      "/doc/a.yaml": "imports: [b.yaml]\ncommands:\n  a:\n    summary: A\n    run: noop\n",
      "/doc/b.yaml": "imports: [a.yaml]\ncommands:\n  b:\n    summary: B\n    run: noop\n",
    } as Record<string, string>;
    expect(() => loadDocument("/doc/a.yaml", {
      readFile: (one) => circular[one] ?? "",
      environment: {},
    })).toThrow("import each other");
  });
});

describe("environment files", () => {
  it("reads the small, boring subset", () => {
    expect(parseEnvFile([
      "# a comment",
      "",
      "PLAIN=one",
      "export EXPORTED=two",
      'QUOTED="three four"',
      "TRAILING=five # not part of it",
    ].join("\n"))).toEqual({
      PLAIN: "one",
      EXPORTED: "two",
      QUOTED: "three four",
      TRAILING: "five",
    });
  });
});


it("merges imported config schemas by key and replaces an overridden field whole", () => {
  const files: Record<string, string> = {
    "/doc/base.json": JSON.stringify({ configSchema: {
      api: { type: "string", default: "https://gitlab.com/api/v4" },
      timeout: { type: "integer", minimum: 1, default: 30 },
    } }),
    "/doc/main.json": JSON.stringify({ imports: ["base.json"], configSchema: {
      timeout: { type: "integer", minimum: 10 },
    } }),
  };
  const result = loadDocument("/doc/main.json", { readFile: (path) => files[path]!, environment: {} });
  expect(result.document["configSchema"]).toEqual({
    api: { type: "string", default: "https://gitlab.com/api/v4" },
    timeout: { type: "integer", minimum: 10 },
  });
});


it("merges HTTP headers across imports case-insensitively with the document winning", () => {
  const files: Record<string, string> = {
    "/doc/base.json": JSON.stringify({ defaults: { http: { headers: {
      "PRIVATE-TOKEN": "base", Accept: "application/json", "X-Kept": "yes",
      "X-Conditional": { when: "$env.OLD", value: "old" },
    } } } }),
    "/doc/over.json": JSON.stringify({ defaults: { http: { headers: { "private-token": "import" } } } }),
    "/doc/main.json": JSON.stringify({ imports: ["base.json", "over.json"], defaults: { http: { headers: {
      "PRIVATE-TOKEN": "document", "X-Conditional": { when: "$env.NEW", value: "new" },
    } } } }),
  };
  const result = loadDocument("/doc/main.json", { readFile: (path) => files[path]!, environment: {} });
  expect(result.document["defaults"]).toEqual({ http: { headers: {
    "private-token": "document", accept: "application/json", "x-kept": "yes",
    "x-conditional": { when: "$env.NEW", value: "new" },
  } } });
});
