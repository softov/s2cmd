import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, expect, it } from "vitest";

/**
 * The document, spoken.
 *
 * `mcp tools` proved the descriptors were right; this proves a client can use
 * them. It drives the real command line as a subprocess and writes JSON-RPC by
 * hand rather than importing an SDK, because s2cmd has one dependency and this
 * test is not the reason to add a second.
 */

const DOCUMENT = `
name: notes
version: 2.1.0
description: Notes, declared as data.
commands:
  note.add:
    summary: Add a note
    description: The bounds are stated once and enforced on the terminal and on the tool alike.
    input:
      title:
        type: string
        description: What the note says
        minLength: 1
        maxLength: 40
      pinned:
        type: boolean
        description: Keep it at the top
        default: false
    required: [title]
    surfaces:
      cli: { pattern: [note, add, ":title"] }
      mcp: true
    run:
      noop: { message: saved }

  danger.run:
    summary: Run the local script
    surfaces:
      cli: { pattern: [danger, run] }
    run:
      exec: { command: ./script.sh }
`;

interface Message {
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const started: { kill(): void }[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function serve() {
  const cwd = mkdtempSync(join(tmpdir(), "s2cmd-mcp-"));
  directories.push(cwd);
  const document = join(cwd, "notes.yaml");
  writeFileSync(document, DOCUMENT);

  const child = spawn(process.execPath, [
    "--import", createRequire(import.meta.url).resolve("tsx"),
    fileURLToPath(new URL("./s2cmd.ts", import.meta.url)),
    "--document", document, "mcp", "serve",
  ], { cwd, env: { ...process.env, NOTES_CONFIG: "", XDG_CONFIG_HOME: cwd } });
  started.push(child);

  const queued: Message[] = [];
  const waiting: ((message: Message) => void)[] = [];
  /** Anything on stdout that was not a protocol message. Must stay empty. */
  const stray: string[] = [];
  let stderr = "";
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
      if (line.trim() === "") continue;
      let message: Message;
      try { message = JSON.parse(line) as Message; } catch { stray.push(line); continue; }
      const next = waiting.shift();
      if (next === undefined) queued.push(message); else next(message);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

  const send = (message: object): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
  const next = async (): Promise<Message> => {
    const ready = queued.shift();
    return ready ?? await new Promise<Message>((resolve) => waiting.push(resolve));
  };
  return { send, next, stray, stderr: () => stderr, child };
}

it("serves the document's MCP tools to a client that launched it", async () => {
  const { send, next, stray, stderr } = serve();

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  const ready = await next();
  expect(ready.result?.["serverInfo"], stderr()).toEqual({ name: "notes", version: "2.1.0" });
  expect(ready.result?.["protocolVersion"]).toBe("2025-06-18");
  expect(ready.result?.["capabilities"]).toEqual({ tools: {} });
  expect(ready.result?.["instructions"]).toBe("Notes, declared as data.");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listed = (await next()).result?.["tools"] as { name: string; description: string; inputSchema: Record<string, unknown> }[];
  // Only what the document published: never the meta commands, and never the
  // `exec` command, which did not write `allowRemoteExec: true`.
  expect(listed.map((tool) => tool.name)).toEqual(["note_add"]);
  const schema = listed[0]!.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[] };
  expect(schema.required).toEqual(["title"]);
  expect(schema.properties["title"]).toMatchObject({ type: "string", minLength: 1, maxLength: 40, description: "What the note says" });
  expect(schema.properties["pinned"]).toMatchObject({ type: "boolean", default: false });

  // The document's bound, refused as something the agent can correct.
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "note_add", arguments: { title: "x".repeat(41) } } });
  const refused = await next();
  expect(refused.result?.["isError"]).toBe(true);
  expect(JSON.stringify(refused.result)).toMatch(/1 to 40 characters/u);

  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "note_add", arguments: { title: "Buy milk" } } });
  const done = await next();
  expect(done.result?.["isError"]).toBeUndefined();
  expect(JSON.stringify(done.result)).toContain("saved");

  // A tool the document did not publish is not reachable by guessing its name.
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "danger_run" } });
  expect((await next()).error?.code).toBe(-32602);

  expect(stray).toEqual([]);
}, 30_000);
