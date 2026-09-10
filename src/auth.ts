import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigurationError } from "facio";
import { CookieJar, httpTransport, type HttpBinding, type Transport, type StoredCookie } from "facio/remote";
import { resolveEntry, resolveValue, type Argument, type Scope } from "./values.js";

export interface SessionOptions {
  endpoint: string;
  source: string;
  auth?: Record<string, unknown>;
  headers?: Record<string, Argument>;
  scope: Scope;
  fetch?: typeof fetch;
  stateDirectory?: string;
}
/** Endpoint-scoped authentication; help and configuration commands need no credentials. */
export class ApiSession {
  constructor(private readonly options: SessionOptions) {}
  private value(raw: unknown, where: string): string {
    if (raw === undefined) throw new ConfigurationError(`Authentication requires ${where}`);
    const value = resolveValue(raw as Argument, this.options.scope, where);
    if (value === undefined || value === null || String(value) === "") throw new ConfigurationError(`Authentication requires ${where}`);
    return String(value);
  }
  private mode(): string { return this.options.auth ? this.value(this.options.auth["type"] ?? "none", "authentication type") : "none"; }
  private file(): string {
    const directory = this.options.stateDirectory ?? this.options.scope.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
    const id = createHash("sha256").update(this.options.source + "\n" + new URL(this.options.endpoint).href).digest("hex");
    return join(directory, "s2cmd", `${id}.json`);
  }
  private jar(): CookieJar {
    try {
      const data = JSON.parse(readFileSync(this.file(), "utf8")) as { endpoint?: string; cookies?: StoredCookie[] };
      if (data.endpoint !== this.options.endpoint || !Array.isArray(data.cookies)) throw new Error("Invalid cookie session");
      for (const c of data.cookies) if (typeof c.name !== "string" || typeof c.value !== "string" || typeof c.domain !== "string" || typeof c.path !== "string"
        || typeof c.secure !== "boolean" || typeof c.hostOnly !== "boolean" || (c.expires !== undefined && (typeof c.expires !== "number" || !Number.isFinite(c.expires)))
        || /[\r\n;]/u.test(c.value) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(c.name)) throw new Error("Invalid session cookie");
      return new CookieJar(data.cookies);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new CookieJar();
      throw new ConfigurationError("Cannot read cookie session; use auth logout to remove it");
    }
  }
  private save(jar: CookieJar): void {
    const path = this.file(); const temporary = path + "." + randomUUID() + ".tmp";
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    try { writeFileSync(temporary, JSON.stringify({ endpoint: this.options.endpoint, cookies: jar.snapshot() }) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
    finally { try { unlinkSync(temporary); } catch { /* Renamed or never created. */ } }
  }
  transport(anonymous = false): Transport {
    return { request: async (binding, input) => {
      const headers: Record<string, string> = {};
      if (!anonymous) for (const [name, argument] of Object.entries(this.options.headers ?? {})) {
        const entry = resolveEntry(argument, { ...this.options.scope, input }, `header ${name}`);
        if (entry.present) headers[name] = String(entry.value);
      }
      const mode = anonymous ? "none" : this.mode();
      if (!["none", "basic", "cookie"].includes(mode)) throw new ConfigurationError(`Unknown authentication type ${mode}`);
      const jar = mode === "cookie" ? this.jar() : undefined;
      const credentials = mode === "basic" ? {
        type: "basic" as const,
        username: this.value(this.options.auth!["username"], "username"),
        password: this.value(this.options.auth!["password"], "password"),
      } : undefined;
      return httpTransport({ baseUrl: this.options.endpoint, headers, timeoutMs: 30_000,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(credentials ? { auth: credentials } : jar ? { auth: { type: "cookie" as const, jar }, onResponse: () => this.save(jar) } : {}),
      }).request(binding, input);
    } };
  }
  async login(): Promise<{ authenticated: boolean; endpoint: string }> {
    if (this.mode() !== "cookie") throw new ConfigurationError("auth login requires cookie authentication; Basic credentials are sent per request");
    const login = this.options.auth?.["login"] as Record<string, unknown> | undefined;
    if (!login || typeof login["path"] !== "string" || !login["path"].startsWith("/")) throw new ConfigurationError("Cookie authentication needs a login.path");
    const fields = login["body"] as Record<string, Argument> | undefined;
    if (!fields) throw new ConfigurationError("Cookie authentication needs login.body");
    const body = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, resolveValue(value, this.options.scope, `login ${key}`)]));
    const contentType = login["contentType"] ?? "application/x-www-form-urlencoded";
    if (contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded") throw new ConfigurationError("Unsupported login content type");
    const jar = new CookieJar();
    await httpTransport({ baseUrl: this.options.endpoint, auth: { type: "cookie", jar }, timeoutMs: 30_000,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    }).request({ method: "POST", path: login["path"], body: Object.keys(body), contentType }, body);
    if (!jar.snapshot().length) throw new ConfigurationError("Login returned no usable cookies; session was not saved");
    this.save(jar);
    return { authenticated: true, endpoint: this.options.endpoint };
  }
  status(): { type: string; endpoint: string; cookies: number; session: boolean } {
    const cookies = this.mode() === "cookie" ? this.jar().snapshot().length : 0;
    return { type: this.mode(), endpoint: this.options.endpoint, cookies, session: cookies > 0 };
  }
  logout(): { cleared: boolean } {
    try { unlinkSync(this.file()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { cleared: true };
  }
}
