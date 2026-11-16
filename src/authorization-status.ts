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
/** These are hints only. Their absence never proves a user identity; the
 * Controller must positively identify a user before a response may be cached.
 * Call this only with claims from a verified signature and expiry. */
export function hasMachineAuthorizationHint(claims: Record<string, unknown> | undefined): boolean {
  if (!claims) return true;
  return ["serviceToken", "machineIdentityId", "machineIdentityName", "identityType", "workloadIdentityType", "tokenVersion",
    "catalogPublication", "catalogLaunch", "configuredServiceLaunch", "configuredAccess", "runtimeRouteDeployment"]
    .some(key => Object.hasOwn(claims, key));
}
type VerifiedCaller = { claims: Record<string, unknown>; standaloneHmac: boolean };
type Principal = "user" | "machine" | "unknown";

/** Bounded self-token checks, only after local signature/expiry verification.
 * Machine, broker, legacy-service and unidentified tokens are checked on every
 * request; only a Controller-confirmed non-service user can reuse a result. */
export class AuthorizationStatus {
  private readonly users = new Map<string, { until: number }>();
  private readonly userPending = new Map<string, Promise<Principal>>();
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string | null;
  private activeChecks = 0;
  private cooldownUntil = 0;
  private counters = { cacheHits: 0, checks: 0, coalesced: 0, denied: 0, unavailable: 0 };
  constructor(private readonly options: AuthorizationStatusOptions) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
    const base = options.controllerRest?.replace(/\/+$/, "");
    this.endpoint = base ? `${base}/auth/token-status` : null;
    if (this.endpoint) {
      try {
        const url = new URL(this.endpoint);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
      } catch { throw Error("Unsupported authorization status URL"); }
    }
    if (!Number.isFinite(options.cacheMs ?? 5000) || (options.cacheMs ?? 5000) < 250 || (options.cacheMs ?? 5000) > 30000) throw Error("Invalid authorization status cache duration");
  }
  snapshot() {
    return { mode: this.options.mode ?? "controller", cacheMs: this.options.cacheMs ?? 5000,
      maxConcurrent: 16, maxCacheEntries: 1024, requestTimeoutMs: 1500,
      cacheEntries: this.users.size, activeChecks: this.activeChecks, ...this.counters };
  }
  async check(token: string, caller?: VerifiedCaller): Promise<void> {
    if (typeof token !== "string" || !token || token.length > 16377 || /[\s\u0000-\u001f\u007f]/.test(token))
      throw new AuthorizationStatusError(401);
    const machineHint = hasMachineAuthorizationHint(caller?.claims);
    // Standalone HMAC users cannot be verified by the Controller. This explicit
    // legacy mode never bypasses status for Controller/JWKS or machine tokens.
    if (this.options.mode === "offline" && caller?.standaloneHmac === true && !machineHint) return;
    const key = createHash("sha256").update(token).digest("hex");
    const cached = !machineHint ? this.users.get(key) : undefined;
    if (cached && cached.until > this.now()) { this.counters.cacheHits++; return; }
    // Requests without machine hints may share the first probe, but may use
    // its result only after the Controller positively identifies a user.
    const inFlight = !machineHint ? this.userPending.get(key) : undefined;
    if (inFlight) {
      this.counters.coalesced++;
      const principal = await inFlight;
      // A Controller may have changed classification since the last result.
      // Never let a coalesced result authorize a machine/unknown follower.
      if (principal === "user") {
        const refreshed=this.users.get(key);
        if (refreshed && refreshed.until > this.now()) return;
        throw new AuthorizationStatusError(503);
      }
    }
    const started = this.now();
    const work = this.request(token);
    // A machine/unknown follower must perform its own probe; do not turn that
    // probe into another shared result while the other followers are released.
    if (!machineHint && !inFlight) this.userPending.set(key, work);
    try {
      const principal = await work;
      if (!machineHint && principal === "user") {
        if (started + (this.options.cacheMs ?? 5000) <= this.now()) throw new AuthorizationStatusError(503);
        this.rememberUser(key, started);
      } else this.users.delete(key);
    } finally {
      if (this.userPending.get(key) === work) this.userPending.delete(key);
    }
  }
  private async request(token: string): Promise<Principal> {
    if (!this.endpoint || this.now() < this.cooldownUntil || this.activeChecks >= 16) {
      this.counters.unavailable++;
      throw new AuthorizationStatusError(503);
    }
    this.counters.checks++;this.activeChecks++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Count timed-out network work until it really settles: an implementation
    // that ignores abort cannot create an unbounded number of abandoned calls.
    const work = this.probe(token, controller.signal).finally(()=>{this.activeChecks--;});
    try {
      return await Promise.race([work,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject(new AuthorizationStatusError(503));},1500);
      })]);
    } catch (error) {
      if (error instanceof AuthorizationStatusError && error.status !== 503) {this.counters.denied++;throw error;}
      this.counters.unavailable++;
      this.cooldownUntil = this.now() + 1000;
      throw new AuthorizationStatusError(503);
    } finally {if(timer)clearTimeout(timer);controller.abort();}
  }
  private async probe(token: string, signal: AbortSignal): Promise<Principal> {
    const response = await this.fetcher(this.endpoint!, { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new AuthorizationStatusError(response.status);
    }
    if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
      Number(response.headers.get("content-length") ?? 0) > 4096 || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new AuthorizationStatusError(503);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];let size = 0;
    try {
      for (;;) {
        const part = await reader.read();if (part.done) break;
        size += part.value.byteLength;if (size > 4096) throw new AuthorizationStatusError(503);
        chunks.push(part.value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { active?: unknown; protocolVersion?: unknown; principalType?: unknown };
      if (body.active !== true || body.protocolVersion !== 1) throw new AuthorizationStatusError(503);
      return body.principalType === "user" ? "user" : body.principalType === "machine" ? "machine" : "unknown";
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  private rememberUser(key:string,started:number) {
    if (this.users.size >= 1024 && !this.users.has(key)) this.users.delete(this.users.keys().next().value!);
    this.users.set(key,{until:started+(this.options.cacheMs??5000)});
  }
}

/** Read the same controller REST setting used for other Controller calls. */
export function authorizationStatusForConfig(
  config: {uns?: {rest?: unknown} | undefined},
  options: Omit<AuthorizationStatusOptions,"controllerRest">,
): AuthorizationStatus {
  return new AuthorizationStatus({...options,controllerRest:typeof config.uns?.rest === 'string' ? config.uns.rest : null});
}
