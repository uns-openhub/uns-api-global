import { readFile } from 'node:fs/promises';

export class RouteOwnerRegistration {
  private origin: string | undefined;
  private pending: Promise<boolean> | undefined;
  private registered = false;
  private reportedState: boolean | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly options: {
    controllerBase: string; tokenFile: string; controllerName: string; instanceId: string;
    version: string; processName: string; launchId: string;
    token?: () => Promise<string>; fetch?: typeof fetch; onReady?: () => Promise<void>; onState?: (ready: boolean) => void;
  }) {}
  observe(mappings: readonly { apiBase: string }[]): void {
    const origins = new Set(mappings.map(m => {
      const u = new URL(m.apiBase);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) throw Error('Invalid route origin');
      return u.origin;
    }));
    if (origins.size !== 1) throw Error('Conflicting route origins');
    this.origin = [...origins][0];
    if (!this.timer) { this.timer = setInterval(() => { void this.renew(); }, 10000); this.timer.unref(); }
    void this.renew();
  }
  renew(): Promise<boolean> {
    if (this.pending) return this.pending;
    if (!this.origin) return Promise.resolve(false);
    this.pending = this.perform().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async perform(): Promise<boolean> {
    try {
      const token = (await (this.options.token?.() ?? readFile(this.options.tokenFile, 'utf8'))).trim();
      if (!token || token.length > 16384) throw Error('Invalid route credential');
      const r = await (this.options.fetch ?? fetch)(new URL('/api/runtime-services/routes', this.options.controllerBase), {
        method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ apiHost: this.origin }), signal: AbortSignal.timeout(3000),
      });
      if (r.status !== 201 || Number(r.headers.get('content-length') ?? 0) > 4096) throw Error('Route registration unavailable');
      if (!r.body) throw Error('Missing route receipt');
      const reader = r.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
      try { while (true) { const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > 4096) { await reader.cancel(); throw Error('Route receipt too large'); }
        chunks.push(part.value);
      } } finally { reader.releaseLock(); }
      const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { protocolVersion?: number; expiresInMs?: number; binding?: Record<string, unknown> };
      const b = receipt.binding;
      if (receipt.protocolVersion !== 1 || receipt.expiresInMs !== 30000 || !b
        || b["controllerName"] !== this.options.controllerName || b["instanceId"] !== this.options.instanceId
        || b["version"] !== (this.options.version.startsWith("v") ? this.options.version : `v${this.options.version}`) || b["processName"] !== this.options.processName || b["apiHost"] !== this.origin
        || typeof b["deploymentId"] !== 'string' || !b["deploymentId"].startsWith(this.options.launchId + ':')) throw Error('Invalid route receipt');
      const first = !this.registered; this.registered = true;
      if (first) await this.options.onReady?.();
      this.reportState(true);
      return true;
    } catch { this.registered = false; this.reportState(false); return false; }
  }
  private reportState(ready: boolean): void {
    if (this.reportedState !== ready) { this.reportedState = ready; this.options.onState?.(ready); }
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

export function routeRegistrationEnvironment(env: NodeJS.ProcessEnv): Omit<ConstructorParameters<typeof RouteOwnerRegistration>[0], 'processName'> | undefined {
  if (!env['RTT_NODE']) return undefined;
  const tokenFile = env['UNS_ROUTE_TOKEN_FILE'];
  if (!tokenFile) return undefined; // An unchanged legacy launcher does not gain this contract.
  const controllerName = env['UNS_ROUTE_CONTROLLER_NAME'], instanceId = env['RTT_INSTANCE_ID'],
    version = env['version'], launchId = env['UNS_ROUTE_LAUNCH_ID'], host = env['UNS_CONTROLLER_HOST'], port = env['UNS_CONTROLLER_PORT'];
  if (!controllerName || !instanceId || !version || !launchId || !host || !port || !/^\d+$/.test(port) || +port > 65535 || +port < 1) throw Error('Incomplete route registration environment');
  // The launcher supplies the owning controller's advertised base, never a generic master/failover URL.
  const ownerBase = env['UNS_CONTROLLER_PUBLIC_BASE'];
  const target = new URL(ownerBase || `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`);
  if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw Error('Invalid owning controller base');
  const controllerBase = target.origin;
  return { tokenFile, controllerName, instanceId, version, launchId, controllerBase };
}
