# Swagger Petstore OpenAPI sample

A self-contained OpenAPI sample: `openapi.yaml` is the official [Swagger
Petstore][spec] OpenAPI 3.0 specification, `s2cmd.yaml` imports every operation
it supports, and `petstore.mjs` is a stub that answers them. Nothing outside
this directory and a Node runtime is needed.

[spec]: https://github.com/swagger-api/swagger-petstore/blob/master/src/main/resources/openapi.yaml

From the repository root, start the stub and show the generated CLI:

```sh
node samples/openapi/petstore.mjs &
node dist/s2cmd.js --document samples/openapi/s2cmd.yaml --help
```

The stub keeps its pets, orders and users in memory and goes away with the
process. No API call is made by `--help`, `sources`, or configuration commands.

`openapi.yaml` answers more than one method on most paths — `/pet` is `POST` and
`PUT`, `/pet/{petId}` is `GET` and `POST` — and one command name cannot be both.
The importer refuses the pair as ambiguous rather than picking a method, so
`s2cmd.yaml` spells every one out with `hints.pattern`; a hint replaces the
whole pattern, path parameters included. Four operations remain unsupported and
are reported, not silently dropped:

```sh
node dist/s2cmd.js --document samples/openapi/s2cmd.yaml sources --json
```

```text
deletePet                  DELETE /pet/{petId}          header parameter
uploadFile                 POST   /pet/{petId}/uploadImage  octet-stream body
createUsersWithListInput   POST   /user/createWithList  array request body
updateUser                 PUT    /user/{username}      input names overlap
```

The imported operations run against the stub, which listens on the endpoint the
document defaults to:

```sh
node dist/s2cmd.js --document samples/openapi/s2cmd.yaml pet list --status available
node dist/s2cmd.js --document samples/openapi/s2cmd.yaml pet add --name Zoe --photo-urls '["https://example.test/zoe.png"]'
node dist/s2cmd.js --document samples/openapi/s2cmd.yaml pet get 1
node dist/s2cmd.js --document samples/openapi/s2cmd.yaml pet tags --tags '["friendly"]'
node dist/s2cmd.js --document samples/openapi/s2cmd.yaml store inventory
node dist/s2cmd.js --document samples/openapi/s2cmd.yaml store order place --pet-id 1 --quantity 2
node dist/s2cmd.js --document samples/openapi/s2cmd.yaml user login --username tester --password secret
```

Arrays and objects are JSON text: `--photo-urls '["…"]'`, `--tags '["friendly"]'`,
`--category '{"id":1,"name":"dog"}'`.

To use the live public API instead of the stub, point `api` at the server in the
specification:

```sh
node dist/s2cmd.js --document samples/openapi/s2cmd.yaml config set api https://petstore3.swagger.io/api/v3
```

With no higher-priority config file active, that creates `.petstore.json` in the
current directory; `config` shows the effective values and their source.

## The specification

`openapi.yaml` is the upstream Swagger Petstore definition, unmodified, and is
licensed [Apache 2.0][license] by SmartBear Software. It is committed here so
the sample loads with no checkout beside this repository; update it from
[swagger-api/swagger-petstore][spec] rather than editing it.

[license]: https://www.apache.org/licenses/LICENSE-2.0.html
