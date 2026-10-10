import { createHash } from "node:crypto";

export class AuthorizationStatusError extends Error {
  constructor(readonly status: 401 | 403 | 503) {
    super(status === 503 ? "Authorization status authority unavailable" : "Authorization no longer active");
  }
}
export interface AuthorizationStatusOptions {
  controllerRest?: string | null;
  mode?: "controller" | "offline";
  cacheMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}
/** Bounded self-token checks, only after local signature/expiry verification. */
export class AuthorizationStatus {
  private readonly cache = new Map<string, { status: 200 | 401 | 403; until: number }>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string | null;
  private cooldownUntil = 0;
  private counters = { cacheHits: 0, checks: 0, coalesced: 0, denied: 0, unavailable: 0 };
  constructor(private readonly options: AuthorizationStatusOptions) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
    const base = options.controllerRest?.replace(/\/+$/, "");
    this.endpoint = base ? `${base}/auth/token-status` : null;
    if (this.endpoint && !/^https?:$/.test(new URL(this.endpoint).protocol)) throw Error("Unsupported authorization status URL");
    if (!Number.isFinite(options.cacheMs ?? 5000) || (options.cacheMs ?? 5000) < 250 || (options.cacheMs ?? 5000) > 30000) throw Error("Invalid authorization status cache duration");
  }
  snapshot() {
    return { mode: this.options.mode ?? "controller", cacheMs: this.options.cacheMs ?? 5000,
      maxConcurrent: 4, maxCacheEntries: 1024, requestTimeoutMs: 1500,
      cacheEntries: this.cache.size, activeChecks: this.pending.size, ...this.counters };
  }
  async check(token: string): Promise<void> {
    if (this.options.mode === "offline") return;
    const key = createHash("sha256").update(token).digest("hex");
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now()) {
      this.counters.cacheHits++;
      if (cached.status !== 200) { this.counters.denied++; throw new AuthorizationStatusError(cached.status); }
      return;
    }
    if (cached) this.cache.delete(key);
    const inFlight = this.pending.get(key);
    if (inFlight) { this.counters.coalesced++; return inFlight; }
    if (!this.endpoint || this.now() < this.cooldownUntil || this.pending.size >= 4) {
      this.counters.unavailable++;
      throw new AuthorizationStatusError(503);
    }
    const task = this.probe(key, token).finally(() => { this.pending.delete(key); });
    this.pending.set(key, task);
    return task;
  }
  private async probe(key: string, token: string): Promise<void> {
    const started = this.now();
    this.counters.checks++;
    try {
      const response = await this.fetcher(this.endpoint!, { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(1500) });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        this.remember(key, response.status, started);
        this.counters.denied++;
        throw new AuthorizationStatusError(response.status);
      }
      if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel().catch(() => {});
        throw new AuthorizationStatusError(503);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AuthorizationStatusError(503);
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 4096) throw new AuthorizationStatusError(503);
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { active?: unknown; protocolVersion?: unknown };
      if (body.active !== true || body.protocolVersion !== 1 || started + (this.options.cacheMs ?? 5000) <= this.now()) throw new AuthorizationStatusError(503);
      this.remember(key, 200, started);
    } catch (error) {
      if (error instanceof AuthorizationStatusError && error.status !== 503) throw error;
      this.counters.unavailable++;
      this.cooldownUntil = this.now() + 1000;
      throw new AuthorizationStatusError(503);
    }
  }
  private remember(key: string, status: 200 | 401 | 403, started: number) {
    if (this.cache.size >= 1024) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { status, until: started + (this.options.cacheMs ?? 5000) });
  }
}
