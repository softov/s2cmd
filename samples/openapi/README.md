# Controllr OpenAPI sample

This wrapper loads the local Controllr OpenAPI 3.1 specification and its referenced files. Keep `path` pointed at your API documentation checkout. The sample contains no credentials.

From `/github/s2cmd`, show the generated CLI:

```sh
npm run dev -- --document samples/openapi/openapi.yaml
```

No API call is made by help, `sources`, or configuration commands. Inspect unsupported operations and reference problems with:

```sh
npm run dev -- --document samples/openapi/openapi.yaml sources --json
```

Choose your real endpoint; check the current sample default before using it:

```sh
npm run dev -- --document samples/openapi/openapi.yaml config set api https://your-host:8443
```

With no higher-priority config file active, this creates `.controllr.json` in the current directory. `config` shows the effective values and their source. The `api` value includes the server URL's base path, if any; do not add an OpenAPI documentation path.

For cookie authentication, export `CONTROLLR_USERNAME` and `CONTROLLR_PASSWORD` in your shell, then:

```sh
npm run dev -- --document samples/openapi/openapi.yaml auth login
npm run dev -- --document samples/openapi/openapi.yaml auth status
npm run dev -- --document samples/openapi/openapi.yaml controllrctl client list --limit 10 --json
npm run dev -- --document samples/openapi/openapi.yaml auth logout
```

Login posts form-encoded credentials to `/login`. Only the successful login's cookies are persisted, with private file permissions, below `$XDG_STATE_HOME/s2cmd` or `~/.local/state/s2cmd`. The session file is keyed by source and complete endpoint URL. Changing `api` selects a different session. `auth status` reports session metadata without printing cookies; logout removes the local session without calling the server.

For Basic authentication, use the same environment variables and select:

```sh
npm run dev -- --document samples/openapi/openapi.yaml config set auth basic
npm run dev -- --document samples/openapi/openapi.yaml controllrctl client list --limit 10 --json
```

Basic authentication sends credentials on each request and does not need `auth login`. `config set auth cookie` switches back. An explicitly exported `CONTROLLR_COOKIE` overrides the managed Cookie header; unset it to use saved login cookies. `config set auth none` disables the managed authentication provider; explicitly supplied headers still apply.

`controllrctl client list` follows the specification's `/controllrctl/client/list` path. Other commands use their API path segments as well; see the generated help. Multi-source wrappers can configure `prefix` to avoid command-name collisions.

The supplied specification has missing referenced files, a misspelled input type, and multipart upload operations. Those operations are reported and omitted. Multipart uploads are not implemented. No API operations are run automatically while loading the specification. A spec's `security: []` marks an operation public and suppresses the source's authentication headers for that operation.

Command names use API path segments; HTTP methods remain in request metadata. For example, the `Cobranças Observação` heading contains `invoice-ctl observation create`; the heading is not part of the command.
