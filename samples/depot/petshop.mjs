#!/usr/bin/env node
// A pet service, in one file, so the `pet` commands in depot.yaml have
// something to talk to.
//
// It stands in for a real API the way scripts/build.sh stands in for a real
// build: it holds a list in memory, answers GET /pets and POST /pets, and goes
// away when the process does. That is enough for the document's `http` executor
// to be exercised end to end without a checkout beside this one.
//
//   node samples/depot/petshop.mjs &
//   node dist/s2cmd.js --document samples/depot/depot.yaml pet list

import { createServer } from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8799;
const pets = [
  { id: 1, name: "Rex", breed: "beagle", age: 4 },
  { id: 2, name: "Biscuit", breed: "corgi", age: 2 },
];

let next = pets.length + 1;

function send(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);

  if (request.method === "GET" && url.pathname === "/pets") {
    const limit = Number(url.searchParams.get("limit"));
    send(response, 200, Number.isInteger(limit) && limit > 0 ? pets.slice(0, limit) : pets);
    return;
  }

  if (request.method === "POST" && url.pathname === "/pets") {
    let held = "";
    request.on("data", (chunk) => { held += chunk; });
    request.on("end", () => {
      let given;
      try {
        given = JSON.parse(held);
      } catch {
        send(response, 400, { error: "body must be JSON" });
        return;
      }
      if (typeof given?.name !== "string" || given.name === "") {
        send(response, 422, { error: "name is required" });
        return;
      }
      // Left out of the request entirely when nothing gave it a value, so age is
      // absent rather than null.
      const pet = { id: next++, name: given.name, breed: given.breed ?? "mixed", ...(given.age === undefined ? {} : { age: given.age }) };
      pets.push(pet);
      send(response, 201, pet);
    });
    return;
  }

  send(response, 404, { error: "no such route" });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`petshop: listening on http://127.0.0.1:${port}\n`);
});
