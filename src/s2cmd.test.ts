/**
 * One YAML file, three surfaces, one rulebook.
 *
 * The claim `s2cmd` exists to prove: a document this library did not author
 * becomes actions, and everything downstream - the terminal, an HTTP route, an
 * MCP tool - is a rendering of that one declaration. The point is not that any
 * one of them validates, but that none of them can be made to disagree, exactly
 * as in `examples/petshop`, with nobody having written a handler.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRegistry, canonicalFromCli, canonicalFromObject } from "facio";
import { listTools } from "facio/mcp";
import { manifestFrom } from "facio/remote";
import { commandsFromDocument } from "./document.js";
import { registryFor } from "./s2cmd.js";
import { loadDocument } from "./load.js";

const path = fileURLToPath(new URL("../samples/depot/depot.yaml", import.meta.url));
const loaded = loadDocument(path);
const { registry } = registryFor(loaded.document, {
  directory: loaded.directory,
  environment: loaded.environment,
});
const add = registry.find("pet.add")!;
const long = "x".repeat(41);

describe("the schema is the only rulebook", () => {
  it("holds a length on the command line", async () => {
    await expect(canonicalFromCli(add, { slots: { name: [long] }, options: {} }))
      .rejects.toThrow("must be 1 to 40 characters");
  });

  it("holds the same length on an object, which is what HTTP and MCP send", async () => {
    await expect(canonicalFromObject(add, { name: long }))
      .rejects.toThrow("must be 1 to 40 characters");
  });

  it("holds a bound on a value that arrived as a JSON number", async () => {
    await expect(canonicalFromObject(add, { name: "Rex", age: 40 }))
      .rejects.toThrow("must be an integer between 0 and 30");
  });

  it("holds an enum the document declared", async () => {
    await expect(canonicalFromObject(add, { name: "Rex", breed: "poodle" }))
      .rejects.toThrow("must be one of beagle, corgi, mixed");
  });

  it("applies the declared default", async () => {
    expect((await canonicalFromObject(add, { name: "Rex" }))["breed"]).toBe("mixed");
  });
});

describe("the MCP surface", () => {
  const tools = listTools(registry).tools;
  const tool = tools.find((one) => one.name === "pet_add")!;
  const properties = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;

  it("advertises every constraint the document stated", () => {
    expect(properties["name"]).toMatchObject({ type: "string", minLength: 1, maxLength: 40 });
    expect(properties["age"]).toMatchObject({ type: "integer", minimum: 0, maximum: 30 });
    expect(properties["breed"]).toMatchObject({ enum: ["beagle", "corgi", "mixed"], default: "mixed" });
  });

  it("shows an agent nothing about how a terminal spells it", () => {
    for (const property of Object.values(properties)) expect(property["cli"]).toBeUndefined();
  });

  /*
   * The refusal, from the other end. Nothing in the document opted the release
   * commands into being tools, and `release.ship` reaches a process through an
   * `internal` step, so neither is here.
   */
  it("publishes only the commands that run no process", () => {
    expect(tools.map((one) => one.name).sort()).toEqual(["pet_add", "pet_list"]);
  });
});

describe("the HTTP surface", () => {
  const manifest = manifestFrom(registry, { name: "depot", version: "1.0.0" });

  it("publishes the binding the document declared", () => {
    expect(manifest.commands.find((one) => one.id === "pet.add")?.http)
      .toEqual({ method: "POST", path: "/pets" });
  });

  it("routes nothing that runs a process", () => {
    expect(manifest.commands.map((one) => one.id).sort()).toEqual(["pet.add", "pet.list"]);
  });
});

describe("the command line", () => {
  it("still has the commands the other two surfaces withheld", () => {
    const ids = registry.commands.map((one) => one.id);
    expect(ids).toContain("release.deploy");
    expect(ids).toContain("release.ship");
    expect(registry.find("release.deploy")?.surfaces?.cli).toBe(true);
    expect(registry.find("release.deploy")?.surfaces?.mcp).toBe(false);
  });

  it("spells the input as options and slots, from one declaration", () => {
    const command = registry.find("release.build")!;
    const target = command.options?.find((one) => one.name === "--target");
    expect(target?.short).toBe("-t");
    expect(target?.repeatable).toBe(true);
    expect(add.pattern).toEqual(["pet", "add", ":name"]);
  });
});



describe("the GitLab sample", () => {
  const loaded = loadDocument(fileURLToPath(new URL("../samples/gitlab/gitlab.yaml", import.meta.url)), {
    environment: { GITLAB_TOKEN: "test-token" },
  });

  it.each([
    ["me", {}, "GET", "/user"],
    ["project.list", {}, "GET", "/projects"],
    ["project.get", { project: 123 }, "GET", "/projects/123"],
    ["user.list", { username: "tester" }, "GET", "/users"],
    ["label.list", { project: 123 }, "GET", "/projects/123/labels"],
    ["milestone.list", { project: 123 }, "GET", "/projects/123/milestones"],
    ["issue.list", { project: 123, search: "a & b" }, "GET", "/projects/123/issues"],
    ["issue.get", { project: 123, iid: 42 }, "GET", "/projects/123/issues/42"],
    ["issue.create", { project: 123, title: "Example" }, "POST", "/projects/123/issues"],
    ["issue.update", { project: 123, iid: 42, title: "Updated" }, "PUT", "/projects/123/issues/42"],
    ["issue.state", { project: 123, iid: 42, state_event: "close", note: "Verified" }, "PUT", "/projects/123/issues/42"],
    ["note.list", { project: 123, iid: 42 }, "GET", "/projects/123/issues/42/notes"],
    ["note.create", { project: 123, iid: 42, body: "A note" }, "POST", "/projects/123/issues/42/notes"],
  ] as const)("maps %s to GitLab", async (id, input, method, path) => {
    const seen: { url: URL; method: string; headers: Headers; body: unknown }[] = [];
    const registry = createRegistry();
    registry.register(...commandsFromDocument(loaded.document, {
      directory: loaded.directory,
      environment: loaded.environment,
      config: loaded.document["config"] as Record<string, unknown>,
      fetch: (async (url, init) => {
        seen.push({ url: new URL(String(url)), method: init?.method ?? "GET",
          headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    }));
    const command = registry.find(id)!;
    const canonical = await canonicalFromObject(command, input);
    await registry.execute(command, { surface: "cli", input: canonical });
    const request = seen.at(-1)!;
    expect(request.url.pathname).toBe("/api/v4" + path);
    expect(request.method).toBe(method);
    expect(request.headers.get("PRIVATE-TOKEN")).toBe("test-token");
    if (id.endsWith(".list")) {
      expect(request.url.searchParams.get("page")).toBe("1");
      expect(request.url.searchParams.get("per_page")).toBe("50");
    }
    if (id === "issue.list") expect(request.url.searchParams.get("search")).toBe("a & b");
    if (id === "issue.create") expect(request.body).toEqual({ title: "Example", issue_type: "issue" });
    if (id === "issue.update") expect(request.body).toEqual({ title: "Updated" });
    if (id === "note.create") expect(request.body).toEqual({ body: "A note" });
    if (id === "issue.state") {
      expect(seen).toHaveLength(2);
      expect(seen[0]!.method).toBe("POST");
      expect(seen[0]!.url.pathname).toBe("/api/v4/projects/123/issues/42/notes");
      expect(seen[0]!.body).toEqual({ body: "Verified" });
      expect(request.body).toEqual({ state_event: "close" });
    }
  });
});
