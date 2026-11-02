import type { QueryBudgetPlan } from "./query-deployment-budget.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

type Caller = {
  kind: "unverified" | "user" | "service" | "machine" | "runtime";
  id: string;
  name?: string;
};
type Workload = "interactive" | "latest-recovery" | "background";
const priority: Record<Workload, number> = {
  interactive: 0,
  "latest-recovery": 1,
  background: 2,
};
type Admission = { workload: Workload };
type Recovery = Admission & { lookupId: string };
type Context = {
  requestId: string;
  operation: string;
  workload: Workload;
  caller: Caller;
  startedAt: number;
  queries: number;
  coalesced: number;
  rejected: number;
  failed: number;
  cacheHits: number;
  cacheMisses: number;
  throttled: number;
};
export type DiagnosticEvent = Record<string, unknown>;
type QueryInfo = { queryType: string; fingerprint: string; tables: string[] };
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

// Only opaque IDs are emitted verbatim. Older subjects may be email addresses.
function safeId(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return /^(?:[0-9a-f]{8}-[0-9a-f-]{27,36}|[0-9]{1,20})$/i.test(value)
    ? value
    : `sha256:${digest(value).slice(0, 24)}`;
}
function safeName(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9 ._:-]{0,95}$/.test(value)
    ? value
    : undefined;
}
// This function must only receive signature-verified claims, never decoded JWTs or identity headers.
export function verifiedCaller(claims: Record<string, unknown>): Caller {
  const machine = safeId(claims["machineIdentityId"]);
  const client = safeId(claims["clientId"]);
  const name = safeName(claims["machineIdentityName"]);
  if (machine)
    return { kind: "machine", id: machine, ...(name ? { name } : {}) };
  if (client) return { kind: "service", id: client };
  return {
    kind: claims["serviceToken"] === true ? "service" : "user",
    id: safeId(claims["sub"]) ?? "unavailable",
  };
}

export function describeSql(sql: string): QueryInfo {
  // Tokenize before normalization: whitespace inside literals must not leak or influence the fingerprint.
  const normalized = sql
    .replace(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi,
      (token) =>
        token.startsWith('"')
          ? token
          : token.startsWith("--") || token.startsWith("/*")
            ? " "
            : "?",
    )
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const tables = [
    ...normalized.matchAll(
      /\b(?:from|join)\s+(?:"([a-z0-9_-]+)"|([a-z_][a-z0-9_]*))/g,
    ),
  ]
    .map((match) => match[1] ?? match[2]!)
    .filter((table) => table !== "select");
  return {
    queryType: /\blatest on\b/.test(normalized)
      ? "latest-on"
      : /^show columns/.test(normalized)
        ? "schema"
        : /^select \?$/.test(normalized)
          ? "health"
          : "history",
    fingerprint: digest(normalized).slice(0, 24),
    tables: [...new Set(tables)].slice(0, 16),
  };
}

export class QueryWorkloadError extends Error {
  readonly status = 503;
  constructor(
    readonly code: "queue-full" | "queue-timeout" | "cooldown" | "cancelled",
  ) {
    super(`QuestDB workload unavailable (${code}). Retry later.`);
  }
}

export class QueryDiagnostics {
  private readonly storage = new AsyncLocalStorage<Context>();
  private readonly recovery = new AsyncLocalStorage<Recovery>();
  private readonly recoveries = new Map<string, Recovery>();
  private readonly cancellationKeys = new WeakMap<AbortSignal, string>();
  private readonly salt = randomBytes(32);
  private readonly inFlight = new Map<
    string,
    { queryId: string; result: Promise<unknown>; admission: Admission }
  >();
  private readonly activeQueries = new Map<string, DiagnosticEvent>();
  private readonly recent: DiagnosticEvent[] = [];
  private readonly queue: Array<{
    admission: Admission;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    cleanup: () => void;
  }> = [];
  private active = 0;
  private interactiveStreak = 0;
  private coalescedWaiters = 0;
  private cooldownUntil = 0;
  private total = {
    executed: 0,
    coalesced: 0,
    lookupCoalesced: 0,
    rejected: 0,
    failed: 0,
  };
  constructor(
    private readonly options: {
      maxConcurrent: number;
      maxQueued: number;
      queueTimeoutMs: number;
      slowQueryMs: number;
      failureCooldownMs: number;
      databaseLabel: string;
      deploymentBudget?: QueryBudgetPlan | undefined;
      emit: (event: DiagnosticEvent) => void;
    },
  ) {}

  private emit(event: DiagnosticEvent): void {
    const record = {
      ...event,
      database: this.options.databaseLabel,
      timestamp: new Date().toISOString(),
    };
    this.recent.push(record);
    if (this.recent.length > 128) this.recent.shift();
    // Diagnostics must not change query success or leave semaphore slots held.
    try {
      this.options.emit(record);
    } catch {
      /* logging unavailable */
    }
  }
  runRequest<T>(
    requestId: string,
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    return this.storage.run(
      {
        requestId,
        operation,
        workload:
          operation === "batch-last" ? "latest-recovery" : "interactive",
        caller: { kind: "unverified", id: "unavailable" },
        startedAt: performance.now(),
        queries: 0,
        coalesced: 0,
        rejected: 0,
        failed: 0,
        cacheHits: 0,
        cacheMisses: 0,
        throttled: 0,
      },
      run,
    );
  }
  runBackground<T>(operation: string, run: () => Promise<T>): Promise<T> {
    return this.runRequest(randomUUID(), operation, async () => {
      const context = this.storage.getStore()!;
      context.caller = { kind: "runtime", id: "uns-api-global" };
      context.workload = "background";
      return run();
    });
  }
  authenticate(claims: Record<string, unknown>): void {
    const context = this.storage.getStore();
    if (context) context.caller = verifiedCaller(claims);
  }
  cache(outcome: "cacheHits" | "cacheMisses" | "throttled", count = 1): void {
    const context = this.storage.getStore();
    if (context) context[outcome] += count;
  }
  finishRequest(status: number): void {
    const context = this.storage.getStore();
    if (!context) return;
    this.emit({
      event: "http.completed",
      requestId: context.requestId,
      operation: context.operation,
      caller: context.caller,
      status,
      durationMs: Math.round(performance.now() - context.startedAt),
      queries: context.queries,
      coalesced: context.coalesced,
      rejected: context.rejected,
      failed: context.failed,
      cacheHits: context.cacheHits,
      cacheMisses: context.cacheMisses,
      throttled: context.throttled,
    });
  }
  runRecovery<T>(lookupId: string, load: () => Promise<T>): Promise<T> {
    const recovery: Recovery = {
      lookupId,
      workload: this.storage.getStore()?.workload ?? "background",
    };
    this.recoveries.set(lookupId, recovery);
    return this.recovery.run(recovery, async () => {
      const context = this.storage.getStore();
      this.emit({
        event: "lookup.started",
        lookupId,
        requestId: context?.requestId,
        caller: context?.caller ?? { kind: "runtime", id: "uns-api-global" },
        operation: context?.operation ?? "background",
      });
      const startedAt = performance.now();
      let outcome = "failed";
      try {
        const result = await load();
        outcome = result === null ? "miss" : "ok";
        return result;
      } finally {
        this.recoveries.delete(lookupId);
        this.emit({
          event: "lookup.completed",
          lookupId,
          outcome,
          durationMs: Math.round(performance.now() - startedAt),
          requestId: context?.requestId,
          caller: context?.caller ?? { kind: "runtime", id: "uns-api-global" },
        });
      }
    });
  }
  joinRecovery(lookupId: string): void {
    this.total.lookupCoalesced++;
    const context = this.storage.getStore();
    const recovery = this.recoveries.get(lookupId);
    if (
      recovery &&
      context &&
      priority[context.workload] < priority[recovery.workload]
    ) {
      // Seed/lazy recovery shares a promise above the SQL coalescing layer.
      // Promote both its queued SQL and subsequent schema/data reads when a
      // real caller joins; do not cancel or duplicate the shared lookup.
      recovery.workload = context.workload;
    }
    if (context) context.coalesced++;
    this.emit({
      event: "lookup.joined",
      lookupId,
      requestId: context?.requestId,
      caller: context?.caller ?? { kind: "runtime", id: "uns-api-global" },
      operation: context?.operation ?? "background",
    });
  }
  snapshot(): DiagnosticEvent {
    return {
      capturedAt: new Date().toISOString(),
      database: this.options.databaseLabel,
      active: this.active,
      queued: this.queue.length,
      queuedByWorkload: Object.fromEntries(
        Object.keys(priority).map((workload) => [
          workload,
          this.queue.filter((entry) => entry.admission.workload === workload)
            .length,
        ]),
      ),
      coalescedWaiters: this.coalescedWaiters,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - performance.now()),
      limits: {
        maxConcurrent: this.options.maxConcurrent,
        maxQueued: this.options.maxQueued,
        ...(this.options.deploymentBudget ? { deploymentBudget: this.options.deploymentBudget } : {}),
      },
      totals: { ...this.total },
      activeQueries: [...this.activeQueries.values()].map((q) => ({
        ...q,
        durationMs: Math.round(performance.now() - Number(q["startedAt"])),
        startedAt: undefined,
      })),
      recent: this.recent.map((record) => ({ ...record })),
    };
  }
  private acquire(admission: Admission, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted)
      return Promise.reject(new QueryWorkloadError("cancelled"));
    if (this.active < this.options.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length + this.coalescedWaiters >= this.options.maxQueued)
      return Promise.reject(new QueryWorkloadError("queue-full"));
    return new Promise((resolve, reject) => {
      const entry = {
        admission,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
        timer: setTimeout(() => {
          entry.cleanup();
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new QueryWorkloadError("queue-timeout"));
        }, this.options.queueTimeoutMs),
      };
      const abort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        clearTimeout(entry.timer);
        entry.cleanup();
        reject(new QueryWorkloadError("cancelled"));
      };
      this.queue.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  private release(): void {
    // Do not let cache recovery fan-out put every interactive read behind it.
    // FIFO within a class. After two interactive admissions allow one waiting
    // latest-value recovery so a long batch cannot starve ordinary cache misses.
    // Startup warming uses idle capacity only. Running SQL is never preempted;
    // every class retains the aggregate queue bound, deadline and SQL cap.
    let selected = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (
        priority[this.queue[i]!.admission.workload] <
        priority[this.queue[selected]!.admission.workload]
      )
        selected = i;
    }
    const latest = this.queue.findIndex(
      (entry) => entry.admission.workload === "latest-recovery",
    );
    if (latest >= 0 && this.interactiveStreak >= 2) selected = latest;
    const next = this.queue.splice(selected, 1)[0];
    if (next) {
      this.interactiveStreak =
        next.admission.workload === "interactive"
          ? Math.min(2, this.interactiveStreak + 1)
          : 0;
      clearTimeout(next.timer);
      next.cleanup();
      next.resolve();
    } else {
      this.active--;
      this.interactiveStreak = 0;
    }
  }
  async query<T>(
    databaseKey: string,
    sql: string,
    purpose: string,
    execute: (ids: { requestId: string; queryId: string }) => Promise<{
      value: T;
      rows: number;
      responseBytes: number;
      httpStatus: number;
      reportedCount?: number;
    }>,
    signal?: AbortSignal,
  ): Promise<T> {
    const context = this.storage.getStore();
    const admission: Admission = this.recovery.getStore() ?? {
      workload:
        context?.workload ??
        (purpose === "latest-fallback" ? "latest-recovery" : "interactive"),
    };
    const identity = {
      requestId: context?.requestId ?? randomUUID(),
      operation: context?.operation ?? "background",
      caller: context?.caller ?? { kind: "runtime", id: "uns-api-global" },
      ...(this.recovery.getStore()
        ? { lookupId: this.recovery.getStore()!.lookupId }
        : {}),
    };
    const info = describeSql(sql);
    // Never coalesce by the redacted fingerprint: different topics/ranges have the same shape.
    // The salted key is internal and includes database/credential isolation.
    // Cancellation-scoped reads share only within the same owner signal. A latest
    // lookup already coalesces callers above this layer; cancelling it must never
    // abort another lookup or an ordinary history request with identical SQL.
    let cancellationKey = "";
    if (signal) {
      cancellationKey = this.cancellationKeys.get(signal) ?? randomUUID();
      this.cancellationKeys.set(signal, cancellationKey);
    }
    const key = createHmac("sha256", this.salt)
      .update(databaseKey)
      .update("\0")
      .update(sql)
      .update("\0")
      .update(cancellationKey)
      .digest("hex");
    const existing = this.inFlight.get(key);
    if (existing) {
      if (this.coalescedWaiters + this.queue.length >= this.options.maxQueued) {
        this.total.rejected++;
        if (context) context.rejected++;
        this.emit({
          event: "query.rejected",
          ...identity,
          ...info,
          purpose,
          queryId: existing.queryId,
          outcome: "queue-full",
          active: this.active,
          queued: this.queue.length,
        });
        throw new QueryWorkloadError("queue-full");
      }
      // A foreground caller joining identical pending SQL must not inherit
      // a background owner's low priority. Never duplicate the database read.
      if (priority[admission.workload] < priority[existing.admission.workload])
        existing.admission.workload = admission.workload;
      this.coalescedWaiters++;
      this.total.coalesced++;
      if (context) context.coalesced++;
      const startedAt = performance.now();
      let outcome = "ok";
      try {
        return structuredClone(await existing.result) as T;
      } catch (error) {
        outcome = error instanceof QueryWorkloadError ? error.code : "failed";
        if (context) context.failed++;
        throw error;
      } finally {
        this.coalescedWaiters--;
        this.emit({
          event: "query.coalesced",
          ...identity,
          ...info,
          purpose,
          queryId: existing.queryId,
          outcome,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
    }
    const queryId = randomUUID();
    const run = async (): Promise<T> => {
      const submittedAt = performance.now();
      try {
        if (performance.now() < this.cooldownUntil)
          throw new QueryWorkloadError("cooldown");
        await this.acquire(admission, signal);
        if (signal?.aborted) {
          this.release();
          throw new QueryWorkloadError("cancelled");
        }
        // A queued query must also observe a dependency failure reported while it waited.
        if (performance.now() < this.cooldownUntil) {
          this.release();
          throw new QueryWorkloadError("cooldown");
        }
      } catch (error) {
        this.total.rejected++;
        if (context) context.rejected++;
        this.emit({
          event: "query.rejected",
          ...identity,
          ...info,
          purpose,
          queryId,
          outcome: error instanceof QueryWorkloadError ? error.code : "failed",
          queued: this.queue.length,
          active: this.active,
        });
        throw error;
      }
      const startedAt = performance.now();
      const record = {
        ...identity,
        ...info,
        purpose,
        queryId,
        workload: admission.workload,
        startedAt,
      };
      this.activeQueries.set(queryId, record);
      this.total.executed++;
      if (context) context.queries++;
      this.emit({
        event: "query.started",
        ...identity,
        ...info,
        purpose,
        queryId,
        workload: admission.workload,
        active: this.active,
        queued: this.queue.length,
        queueMs: Math.round(startedAt - submittedAt),
      });
      try {
        const result = await execute({
          requestId: identity.requestId,
          queryId,
        });
        const durationMs = Math.round(performance.now() - startedAt);
        this.emit({
          event: "query.completed",
          ...identity,
          ...info,
          purpose,
          queryId,
          outcome: "ok",
          durationMs,
          slow: durationMs >= this.options.slowQueryMs,
          rows: result.rows,
          responseBytes: result.responseBytes,
          httpStatus: result.httpStatus,
          ...(result.reportedCount === undefined
            ? {}
            : { reportedCount: result.reportedCount }),
        });
        return result.value;
      } catch (error) {
        this.total.failed++;
        if (context) context.failed++;
        const code =
          error && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        const httpStatus =
          error &&
          typeof error === "object" &&
          "httpStatus" in error &&
          typeof error.httpStatus === "number"
            ? error.httpStatus
            : undefined;
        const outcome =
          code === "timeout"
            ? "timeout"
            : code === "cancelled"
              ? "cancelled"
              : "failed";
        if (
          code === "timeout" ||
          code === "connection-error" ||
          (httpStatus !== undefined && httpStatus >= 500)
        ) {
          this.cooldownUntil = Math.max(
            this.cooldownUntil,
            performance.now() + this.options.failureCooldownMs,
          );
        }
        this.emit({
          event: "query.completed",
          ...identity,
          ...info,
          purpose,
          queryId,
          outcome,
          ...(httpStatus === undefined ? {} : { httpStatus }),
          durationMs: Math.round(performance.now() - startedAt),
        });
        throw error;
      } finally {
        this.activeQueries.delete(queryId);
        this.release();
      }
    };
    const result = run();
    this.inFlight.set(key, { queryId, result, admission });
    try {
      return await result;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
