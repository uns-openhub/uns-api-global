// src/triggers/registry.ts
//
// In-memory cache of trigger definitions, fetched from the
// controller's GET /api/triggers endpoint at boot + on a periodic
// refresh interval.  Mirrors the pattern uns-api-global already
// uses for active-topic refresh (see fetchActiveTopicsFromController
// + setInterval in index.ts) so operationally it behaves the same.
//
// The registry is the only place that knows about HTTP / auth /
// JSON parsing.  Its consumers (the trigger service / evaluator)
// see a flat `Map<id, TriggerDefinition>` and an O(1)
// "triggers-watching-this-topic" index for hot-path message handling.

import { logger } from "@uns-kit/core";
import { ControllerRegistryHealth, type RegistryRefreshOptions, type RegistryHealth } from "../controller-registry-health.js";
import type { TriggerDefinition, TriggerKind } from "./types.js";

/** Matches the response shape uns-datahub-controller's
 *  src/routes/api.ts:GET /api/triggers emits.  `config` is parsed
 *  for us — the controller's REST handler runs JSON.parse on the
 *  way out so we don't pay it on every refresh. */
type TriggerApiRow = {
  id: string;
  name: string;
  kind: TriggerKind;
  sourceTopic: string;
  outputTopic: string;
  config: Record<string, unknown>;
  cooldownMs: number | null;
  enabled: boolean;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type TriggerApiResponse = {
  triggers: TriggerApiRow[];
};

export type TriggerRegistryDeps = RegistryRefreshOptions & {
  /** Base URL of the controller's REST API (e.g.
   *  "http://localhost:3200/api").  Trailing slash optional —
   *  normalised here. */
  controllerRestUrl: string;
  /** Returns a Bearer token to attach to controller requests. The service token
   *  provider resolves controller files, direct-development environment tokens,
   *  configured secrets, and legacy login only as a final fallback. */
  getAccessToken: () => Promise<string | null>;
  /** How often to refresh.  Mirror the existing topic-refresh
   *  cadence so admins only have to think about one knob. */
  refreshIntervalMs: number;
  /** Optional fetch override for tests.  Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export class TriggerRegistry {
  private readonly deps: TriggerRegistryDeps;
  private readonly fetchImpl: typeof fetch;
  /** Cache of every enabled trigger, keyed by id. */
  private byId: Map<string, TriggerDefinition> = new Map();
  /** Inverted index: source-topic → set of trigger ids subscribed
   *  to that topic.  Lets the message handler skip evaluator calls
   *  on every message — only triggers watching THIS topic run. */
  private bySourceTopic: Map<string, Set<string>> = new Map();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private generation = 0;
  private refreshPromise: Promise<void> | null = null;
  private readonly health: ControllerRegistryHealth;

  constructor(deps: TriggerRegistryDeps) {
    this.deps = deps;
    this.health = new ControllerRegistryHealth("triggers-registry", "Trigger definitions", deps);
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Initial fetch + start the refresh interval.  Resolves once
   *  the first fetch completes (or fails gracefully) so callers
   *  know the registry is in a usable state.  Subsequent refreshes
   *  run in the background; failures are logged but never thrown. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh();
    if (!this.started) return;
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        logger.warn(`[triggers] background refresh failed: ${stringifyError(err)}`);
      });
    }, this.deps.refreshIntervalMs);
    // Hint Node's process supervisor that the timer shouldn't keep
    // the event loop alive on its own — same convention catchall's
    // existing intervals use.
    if (this.refreshTimer && typeof this.refreshTimer.unref === "function") {
      this.refreshTimer.unref();
    }
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.started = false;
    this.generation++;
    this.refreshPromise = null;
    this.health.authorizationFailure();
    this.byId.clear();
    this.bySourceTopic.clear();
  }

  /** All triggers watching a given source topic.  O(1) — used by
   *  the message handler to avoid scanning every trigger on every
   *  message.  Returns an empty array when no triggers match. */
  getTriggersForTopic(topic: string): TriggerDefinition[] {
    if (!this.executionAllowed()) return [];
    const ids = this.bySourceTopic.get(topic);
    if (!ids || ids.size === 0) return [];
    const out: TriggerDefinition[] = [];
    for (const id of ids) {
      const trig = this.byId.get(id);
      if (trig) out.push(trig);
    }
    return out;
  }

  /** Total count of cached triggers.  Used by health / metrics
   *  surfaces. */
  size(): number {
    if (!this.executionAllowed()) return 0;
    return this.byId.size;
  }

  /** Stage 4b — flat snapshot of every cached trigger.  Used by
   *  the runtime-inspection endpoint to list all known triggers
   *  (including ones that haven't been evaluated yet, so the admin
   *  UI shows them as "Awaiting first value"). */
  list(): TriggerDefinition[] {
    if (!this.executionAllowed()) return [];
    return Array.from(this.byId.values());
  }

  /** Force a refresh now.  Useful for tests + for an admin
   *  endpoint we might add later that nudges the registry on
   *  trigger-create instead of waiting for the interval. */
  getHealth(): RegistryHealth { this.executionAllowed(); return this.health.get(); }

  private executionAllowed(): boolean {
    if (this.health.allowed()) return true;
    if (this.byId.size) void this.applyRows([], "registryUnavailable");
    return false;
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const pending = this.refreshOnce(this.generation);
    this.refreshPromise = pending;
    void pending.finally(() => { if (this.refreshPromise === pending) this.refreshPromise = null; }).catch(() => undefined);
    return pending;
  }

  private async refreshOnce(generation: number): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deps.requestTimeoutMs ?? 5000);
    const abort = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Registry timeout")), { once: true }));
    const current = () => generation === this.generation;
    try {
      let token: string | null;
      try { token = await Promise.race([this.deps.getAccessToken(), abort]); }
      catch {
        if (current()) { this.health.authorizationFailure(); await this.applyRows([], "authorizationUnavailable"); }
        return;
      }
      if (!current()) return;
      if (!token || this.health.tokenExpired(token)) {
        this.health.authorizationFailure();
        await this.applyRows([], "authorizationUnavailable");
        return;
      }
      let response: Response;
      try {
        response = await Promise.race([this.fetchImpl(`${this.deps.controllerRestUrl.replace(/\/+$/, "")}/triggers`, {
          method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: controller.signal,
        }), abort]);
      } catch {
        if (current()) { this.health.transportFailure(); this.executionAllowed(); }
        return;
      }
      if (!current()) return;
      if (response.status === 401 || response.status === 403) {
        this.health.authorizationFailure(); await this.applyRows([], "authorizationUnavailable"); return;
      }
      if (!response.ok) { this.health.transportFailure(); this.executionAllowed(); return; }
      const payload = await Promise.race([response.json(), abort]) as TriggerApiResponse;
      if (!current()) return;
      if (!payload || !Array.isArray(payload.triggers)) { this.health.transportFailure(); this.executionAllowed(); return; }
      // The credential may expire while a slow response body is being read.
      if (this.health.tokenExpired(token)) { this.health.authorizationFailure(); await this.applyRows([], "authorizationUnavailable"); return; }
      this.health.success(token);
      await this.applyRows(payload.triggers);
    } catch {
      if (current()) { this.health.transportFailure(); this.executionAllowed(); }
    } finally { clearTimeout(timeout); }
  }

  private async applyRows(rows: TriggerApiRow[], reason?: string): Promise<void> {
    const nextById = new Map<string, TriggerDefinition>();
    const nextBySourceTopic = new Map<string, Set<string>>();
    const addToIndex = (topic: string, id: string) => {
      let set = nextBySourceTopic.get(topic);
      if (!set) {
        set = new Set();
        nextBySourceTopic.set(topic, set);
      }
      set.add(id);
    };
    for (const row of rows) {
      const trig = mapApiRowToDefinition(row);
      if (!trig) continue;
      nextById.set(trig.id, trig);
      if (trig.kind === "compare") {
        const cfg = trig.config as { leftTopic?: unknown; rightTopic?: unknown };
        if (typeof cfg.leftTopic === "string" && cfg.leftTopic.length > 0) {
          addToIndex(cfg.leftTopic, trig.id);
        }
        if (typeof cfg.rightTopic === "string" && cfg.rightTopic.length > 0) {
          addToIndex(cfg.rightTopic, trig.id);
        }
      } else if (trig.kind === "composite") {
        // Stage 5 — index every condition's topic so a message on
        // any one of them re-runs the composite evaluator.  The
        // sourceTopic field is admin-facing only for composite,
        // not part of runtime routing.
        const cfg = trig.config as { conditions?: Array<{ topic?: unknown }> };
        const conds = Array.isArray(cfg.conditions) ? cfg.conditions : [];
        for (const c of conds) {
          if (c && typeof c.topic === "string" && c.topic.length > 0) {
            addToIndex(c.topic, trig.id);
          }
        }
      } else {
        addToIndex(trig.sourceTopic, trig.id);
      }
    }
    this.byId = nextById;
    this.bySourceTopic = nextBySourceTopic;
  }
}

function mapApiRowToDefinition(row: TriggerApiRow): TriggerDefinition | null {
  // Defensive: the controller validates kind ↔ config on write,
  // but a bad row in the DB shouldn't crash the registry.  Drop
  // anything we can't recognise.
  if (!row || typeof row.id !== "string" || typeof row.sourceTopic !== "string") return null;
  if (
    row.kind !== "high" &&
    row.kind !== "low" &&
    row.kind !== "event" &&
    row.kind !== "compare" &&
    row.kind !== "string" &&
    row.kind !== "composite"
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    sourceTopic: row.sourceTopic,
    outputTopic: row.outputTopic,
    // Trust the controller's validation; cast through the union.
    // The evaluator dispatches on `kind` so a wrong-shape config
    // would fail open (suppress) rather than crash.
    config: row.config as TriggerDefinition["config"],
    cooldownMs: typeof row.cooldownMs === "number" ? row.cooldownMs : null,
    enabled: row.enabled === true,
    description: typeof row.description === "string" ? row.description : null,
    createdBy: typeof row.createdBy === "string" ? row.createdBy : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
