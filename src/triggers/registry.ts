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

export type TriggerRegistryDeps = {
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

  constructor(deps: TriggerRegistryDeps) {
    this.deps = deps;
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
  }

  /** All triggers watching a given source topic.  O(1) — used by
   *  the message handler to avoid scanning every trigger on every
   *  message.  Returns an empty array when no triggers match. */
  getTriggersForTopic(topic: string): TriggerDefinition[] {
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
    return this.byId.size;
  }

  /** Stage 4b — flat snapshot of every cached trigger.  Used by
   *  the runtime-inspection endpoint to list all known triggers
   *  (including ones that haven't been evaluated yet, so the admin
   *  UI shows them as "Awaiting first value"). */
  list(): TriggerDefinition[] {
    return Array.from(this.byId.values());
  }

  /** Force a refresh now.  Useful for tests + for an admin
   *  endpoint we might add later that nudges the registry on
   *  trigger-create instead of waiting for the interval. */
  async refresh(): Promise<void> {
    const url = `${this.deps.controllerRestUrl.replace(/\/+$/, "")}/triggers`;
    let token: string | null = null;
    try {
      token = await this.deps.getAccessToken();
    } catch (err) {
      logger.warn(`[triggers] could not get access token: ${stringifyError(err)}`);
      return;
    }
    if (!token) {
      logger.warn(`[triggers] no access token available; skipping refresh`);
      return;
    }
    let payload: TriggerApiResponse;
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        logger.warn(
          `[triggers] controller responded ${response.status} for GET /api/triggers; keeping existing registry`,
        );
        return;
      }
      payload = (await response.json()) as TriggerApiResponse;
    } catch (err) {
      logger.warn(`[triggers] failed to fetch from controller: ${stringifyError(err)}`);
      return;
    }
    if (!payload || !Array.isArray(payload.triggers)) {
      logger.warn(`[triggers] unexpected response shape from controller; keeping existing registry`);
      return;
    }
    this.applyRows(payload.triggers);
    logger.info(
      `[triggers] registry refreshed: ${this.byId.size} active triggers across ${this.bySourceTopic.size} source topics`,
    );
  }

  /** Replace the in-memory state with a freshly-fetched batch.
   *  Atomic from the message-handler's perspective — readers either
   *  see the old map or the new map, never an inconsistent middle.
   *  Implemented with rebuilt-then-swap for that reason.
   *
   *  For `compare` triggers, BOTH `leftTopic` and `rightTopic` are
   *  added to the inverted index so a message on either side
   *  re-evaluates the relation.  `sourceTopic` for compare is
   *  informational and not added — the runtime only ever drives
   *  off the operand topics. */
  private applyRows(rows: TriggerApiRow[]): void {
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
