import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("runs an OpenAPI CLI with forms, cookie login, Basic auth, config changes, and logout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), 's2cmd-openapi-'));
  const seen: { path: string; body: string; cookie: string; authorization: string }[] = [];
  const server = createServer((request, response) => {
    let body = ''; request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      seen.push({ path: request.url!, body, cookie: request.headers.cookie ?? '', authorization: request.headers.authorization ?? '' });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/login') response.setHeader('set-cookie', 'session=opaque; Path=/; HttpOnly');
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    writeFileSync(join(cwd, 'api.json'), JSON.stringify({ openapi: '3.1.0', paths: {
      '/public': { get: { operationId: 'readPublic', tags: ['public'], security: [] } },
      '/clients': { post: { operationId: 'listClients', tags: ['clients'], requestBody: { content: {
        'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } } } },
      } } } },
    } }));
    writeFileSync(join(cwd, 'commands.json'), JSON.stringify({ name: 'fixture', sources: { api: {
      type: 'openapi', path: 'api.json', endpoint: '{$config.api}', auth: { type: '{$config.auth}', username: '{$env.TEST_USER}', password: '{$env.TEST_PASSWORD}',
        login: { path: '/login', body: { username: '{$env.TEST_USER}', password: '{$env.TEST_PASSWORD}' } } },
    } }, configSchema: { api: { type: 'string', format: 'uri', default: endpoint }, auth: { type: 'string', enum: ['cookie', 'basic', 'none'], default: 'cookie' } } }));
    const run = async (...args: string[]) => promisify(execFile)(process.execPath,
      ['--import', createRequire(import.meta.url).resolve('tsx'), fileURLToPath(new URL('./s2cmd.ts', import.meta.url)), '--document', 'commands.json', ...args],
      { cwd, env: { ...process.env, FIXTURE_CONFIG: '', XDG_CONFIG_HOME: cwd, XDG_STATE_HOME: cwd, TEST_USER: 'tester', TEST_PASSWORD: 'a & b' } });
    expect((await run()).stdout).toContain('clients');
    expect(seen).toHaveLength(0);
    await run('auth', 'login');
    expect(new URLSearchParams(seen[0]!.body).get('password')).toBe('a & b');
    await run('clients', '--limit', '3', '--json');
    expect(seen.at(-1)!.cookie).toBe('session=opaque');
    expect(seen.at(-1)!.body).toBe('limit=3');
    const status = await run('auth', 'status', '--json');
    expect(JSON.parse(status.stdout).session).toBe(true); expect(status.stdout).not.toContain('opaque');
    await run('auth', 'logout');
    await run('clients'); expect(seen.at(-1)!.cookie).toBe('');
    await run('auth', 'login');
    await run('config', 'set', 'api', endpoint + '/other');
    await run('clients'); expect(seen.at(-1)!.path).toBe('/other/clients'); expect(seen.at(-1)!.cookie).toBe('');
    await run('config', 'set', 'auth', 'basic');
    await run('clients');
    expect(seen.at(-1)!.authorization).toBe('Basic ' + Buffer.from('tester:a & b').toString('base64'));
    await run('public');
    expect(seen.at(-1)!.authorization).toBe(''); expect(seen.at(-1)!.cookie).toBe('');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
