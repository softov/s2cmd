#!/usr/bin/env node
// A Petstore, in one file, so the operations imported from `openapi.yaml` have
// something to answer.
//
// It stands in for the real service the way the specification stands in for a
// real API: the pets, orders and users live in memory and go away with the
// process, which is enough to exercise the imported commands end to end
// without a checkout or a network.
//
//   node samples/openapi/petstore.mjs &
//   node dist/s2cmd.js --document samples/openapi/s2cmd.yaml pet list --status available

import { createServer } from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8793;

const pets = new Map([
  [1, { id: 1, name: "Rex", status: "available", photoUrls: ["http://example.test/rex.png"], category: { id: 1, name: "dog" }, tags: [{ id: 1, name: "friendly" }] }],
  [2, { id: 2, name: "Biscuit", status: "pending", photoUrls: ["http://example.test/biscuit.png"], category: { id: 1, name: "dog" }, tags: [{ id: 2, name: "small" }] }],
  [3, { id: 3, name: "Mittens", status: "sold", photoUrls: ["http://example.test/mittens.png"], category: { id: 2, name: "cat" }, tags: [{ id: 1, name: "friendly" }] }],
]);
const orders = new Map();
const users = new Map([["tester", { id: 1, username: "tester", firstName: "Test", lastName: "Er", email: "tester@example.test" }]]);

let nextPet = 4;
let nextOrder = 1;

function send(response, status, body, type = "application/json") {
  const text = type === "application/json" ? JSON.stringify(body) : String(body);
  response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(text) });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve) => {
    let held = "";
    request.on("data", (chunk) => { held += chunk; });
    request.on("end", () => resolve(held));
  });
}

function parsed(text, type) {
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const segments = url.pathname.split("/").filter(Boolean);
  const method = request.method ?? "GET";
  const body = await readBody(request);
  const given = parsed(body, request.headers["content-type"] ?? "");

  if (segments[0] === "pet") {
    // POST /pet — addPet. The specification returns 405 for input it cannot use.
    if (method === "POST" && segments.length === 1) {
      if (given === undefined || typeof given.name !== "string") { send(response, 405, { error: "invalid input" }); return; }
      const pet = { ...given, id: given.id ?? nextPet++ };
      pets.set(pet.id, pet);
      send(response, 200, pet); return;
    }
    // PUT /pet — updatePet. 404 when the pet is not there, as the spec says.
    if (method === "PUT" && segments.length === 1) {
      if (given === undefined || given.id === undefined || !pets.has(given.id)) { send(response, 404, { error: "Pet not found" }); return; }
      pets.set(given.id, given);
      send(response, 200, given); return;
    }
    if (method === "GET" && segments[1] === "findByStatus") {
      const wanted = (url.searchParams.get("status") ?? "").split(",").filter(Boolean);
      send(response, 200, [...pets.values()].filter((pet) => wanted.includes(pet.status))); return;
    }
    if (method === "GET" && segments[1] === "findByTags") {
      const wanted = (url.searchParams.get("tags") ?? "").split(",").filter(Boolean);
      send(response, 200, [...pets.values()].filter((pet) => (pet.tags ?? []).some((tag) => wanted.includes(tag.name)))); return;
    }
    if (segments.length === 2) {
      const pet = pets.get(Number(segments[1]));
      if (method === "GET") {
        if (!pet) { send(response, 404, { error: "Pet not found" }); return; }
        send(response, 200, pet); return;
      }
      // POST /pet/{petId} — updatePetWithForm. The description says "form
      // data", but the specification declares name and status as query
      // parameters, so that is where they arrive.
      if (method === "POST") {
        if (!pet) { send(response, 404, { error: "Pet not found" }); return; }
        const name = url.searchParams.get("name");
        const status = url.searchParams.get("status");
        if (name !== null) pet.name = name;
        if (status !== null) pet.status = status;
        send(response, 200, pet); return;
      }
    }
  }

  if (segments[0] === "store") {
    if (method === "GET" && segments[1] === "inventory") {
      const counts = {};
      for (const pet of pets.values()) counts[pet.status] = (counts[pet.status] ?? 0) + 1;
      send(response, 200, counts); return;
    }
    if (method === "POST" && segments[1] === "order" && segments.length === 2) {
      const order = { ...given, id: given?.id ?? nextOrder++ };
      orders.set(order.id, order);
      send(response, 200, order); return;
    }
    if (segments[1] === "order" && segments.length === 3) {
      const id = Number(segments[2]);
      const order = orders.get(id);
      if (method === "GET") {
        if (!order) { send(response, 404, { error: "Order not found" }); return; }
        send(response, 200, order); return;
      }
      if (method === "DELETE") {
        if (!order) { send(response, 404, { error: "Order not found" }); return; }
        orders.delete(id);
        send(response, 200, { message: `order ${id} deleted` }); return;
      }
    }
  }

  if (segments[0] === "user") {
    if (method === "GET" && segments[1] === "login") {
      const username = url.searchParams.get("username");
      if (!username) { send(response, 400, { error: "username and password are required" }); return; }
      send(response, 200, `logged in ${username}`, "text/plain"); return;
    }
    if (method === "GET" && segments[1] === "logout") {
      send(response, 200, "logged out", "text/plain"); return;
    }
    if (method === "POST" && segments.length === 1) {
      if (given === undefined || typeof given.username !== "string") { send(response, 400, { error: "username is required" }); return; }
      users.set(given.username, given);
      send(response, 200, given); return;
    }
    if (segments.length === 2) {
      const username = decodeURIComponent(segments[1]);
      const user = users.get(username);
      if (method === "GET") {
        if (!user) { send(response, 404, { error: "User not found" }); return; }
        send(response, 200, user); return;
      }
      if (method === "DELETE") {
        if (!user) { send(response, 404, { error: "User not found" }); return; }
        users.delete(username);
        send(response, 200, { message: `user ${username} deleted` }); return;
      }
    }
  }

  send(response, 404, { error: "no such route" });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`petstore: listening on http://127.0.0.1:${port}\n`);
});
