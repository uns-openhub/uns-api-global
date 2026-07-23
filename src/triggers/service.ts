// src/triggers/service.ts
//
// Orchestrator for the Stage 1 trigger module.  Stitches together:
//
//   - TriggerRegistry  ← polls the controller's /api/triggers
//   - evaluator        ← pure per-kind evaluators (edge-only, cooldown)
//   - TriggerPublisher ← serialises + hands off to MQTT publish
//
// The public surface is one method — `onMessage` — that uns-api-
// global's MQTT message handler calls right after it updates
// `lastValueMap`.  Everything else is plumbing.
//
// Per-trigger runtime state (lastSeenValue, lastFiredAt) lives in
// this service.  It survives registry refreshes (we look up by
// trigger id, so adding / removing triggers doesn't reset peers'
// state) but does NOT survive process restarts — that's the
// admin-confirmed "no replay on restart" behaviour.

import { logger } from "@uns-kit/core";
import { evaluateTrigger } from "./evaluator.js";
import type { LastValueAccessor } from "./evaluator.js";
import { resolveTriggerOutputUom, type TriggerPublisher } from "./publisher.js";
import type { TriggerRegistry } from "./registry.js";
import type {
  TriggerDefinition,
  TriggerFireRequest,
  TriggerRuntimeState,
} from "./types.js";

/** Stage 4b — observability metrics maintained alongside the
 *  evaluator's runtime state.  Separate type because the evaluator
 *  doesn't care about counts/timestamps (it only reads
 *  lastSeenValue / lastFiredAt); these are aggregations the admin
 *  inspection endpoint surfaces. */
export type TriggerRuntimeMetrics = {
  /** Total real fires since process start. */
  fireCount: number;
  /** Total suppressed evaluations since process start. */
  suppressionCount: number;
  /** Most recent suppressed-reason emitted by the evaluator (e.g.
   *  'cooldown', 'no_edge', 'first_value_arms_trigger', 'stale_snapshot').
   *  Null when the trigger has never been evaluated, or if the
   *  most-recent evaluation was a real fire. */
  lastSuppressedReason: string | null;
  /** Wall-clock (ms) of the most recent service.onMessage call for
   *  this trigger, regardless of fire / suppression outcome. */
  lastEvaluatedAt: number | null;
};

/** Combined runtime view for one trigger — the evaluator's state
 *  plus the inspection metrics.  Returned by getRuntimeStates(). */
export type TriggerRuntimeView = {
  triggerId: string;
  state: TriggerRuntimeState;
  metrics: TriggerRuntimeMetrics;
  /** Convenience flag derived from state — true once the trigger
   *  has seen a value and is ready to detect an edge.  False
   *  before the first message (also when the runtime was wiped on
   *  restart).  Used by the admin UI to render an
   *  "Armed" / "Awaiting first value" pill. */
  isArmed: boolean;
};

export type IncomingMessageContext = {
  /** The full UNS topic the message arrived on. */
  topic: string;
  /** The "value" field extracted from the parsed uns-kit packet.
   *  For Data attributes that's `message.data.value`; for Table
   *  attributes the caller picks one column (typically the principal
   *  numeric or string column of the row).  null when no usable
   *  value was found in the packet. */
  value: unknown;
  /** UoM from the packet, when present.  Forwarded into the fire
   *  payload. */
  uom: string | null;
  /** ISO timestamp on the packet — propagates into the fire
   *  payload's `triggerMeta.sourceTimestamp`. */
  sourceTimestamp: string;
};

export type TriggerServiceDeps = {
  registry: TriggerRegistry;
  publisher: TriggerPublisher;
  /** Wall-clock source.  Same one the publisher uses (tests pin
   *  both at once).  Defaults to Date.now. */
  now?: () => number;
  /** Optional read-through to the host's last-value cache.  Stage 2
   *  kinds (`compare`, `string`) need it to read peer / snapshot
   *  topics; Stage 1 kinds ignore it.  When omitted, Stage 2
   *  triggers can never reach the fire path (compare suppresses
   *  with `peer_value_missing`; string with `stale_snapshot`). */
  getLastValue?: LastValueAccessor;
  onFire?: (event: TriggerFireEvent) => void | Promise<void>;
};

export type TriggerFireEvent = {
  trigger: TriggerDefinition;
  value: number | string;
  uom: string | null;
  sourceTimestamp: string;
  firedAtMs: number;
};

export class TriggerService {
  private readonly registry: TriggerRegistry;
  private readonly publisher: TriggerPublisher;
  private readonly now: () => number;
  private readonly state: Map<string, TriggerRuntimeState> = new Map();
  private readonly metrics: Map<string, TriggerRuntimeMetrics> = new Map();
  private readonly getLastValue: LastValueAccessor | undefined;
  private readonly onFire: ((event: TriggerFireEvent) => void | Promise<void>) | undefined;

  constructor(deps: TriggerServiceDeps) {
    this.registry = deps.registry;
    this.publisher = deps.publisher;
    this.now = deps.now ?? (() => Date.now());
    this.getLastValue = deps.getLastValue;
    this.onFire = deps.onFire;
  }

  /** Initial fetch + start the registry refresh loop.  After this
   *  resolves, `onMessage` is ready to be called. */
  async start(): Promise<void> {
    await this.registry.start();
  }

  stop(): void {
    this.registry.stop();
  }

  /** Hot path — uns-api-global's MQTT handler calls this on every
   *  parsed message.  Skips fast when no triggers care about the
   *  topic; otherwise runs each matching evaluator and fires the
   *  publisher when a match crosses an edge. */
  onMessage(ctx: IncomingMessageContext): void {
    const triggers = this.registry.getTriggersForTopic(ctx.topic);
    if (triggers.length === 0) return;
    const now = this.now();
    for (const trig of triggers) {
      this.evaluateOne(trig, ctx, now);
    }
  }

  private evaluateOne(
    trig: TriggerDefinition,
    ctx: IncomingMessageContext,
    now: number,
  ): void {
    const prev = this.state.get(trig.id) ?? FRESH_STATE;
    const result = evaluateTrigger(trig, ctx.value, prev, now, {
      ...(this.getLastValue ? { getLastValue: this.getLastValue } : {}),
      incomingTopic: ctx.topic,
    });
    // Always commit nextState so lastSeenValue tracks even when
    // the evaluator suppressed the fire (cooldown, no_edge, …).
    // lastFiredAt only updates inside the evaluator on real fires,
    // so cooldown timing stays correct.
    this.state.set(trig.id, result.nextState);
    // Stage 4b — keep observability metrics in sync.
    const m = this.metrics.get(trig.id) ?? FRESH_METRICS();
    m.lastEvaluatedAt = now;
    if (result.fired) {
      m.fireCount++;
      m.lastSuppressedReason = null;
    } else {
      m.suppressionCount++;
      if (result.suppressedReason) m.lastSuppressedReason = result.suppressedReason;
    }
    this.metrics.set(trig.id, m);
    if (!result.fired) return;
    if (result.firedValue === null) return;
    const outputUom = resolveTriggerOutputUom(trig, ctx.uom);
    if (this.onFire) {
      Promise.resolve(
        this.onFire({
          trigger: trig,
          value: result.firedValue,
          uom: outputUom,
          sourceTimestamp: ctx.sourceTimestamp,
          firedAtMs: now,
        }),
      ).catch((err) => {
        logger.warn(
          `[triggers] onFire hook failed for trigger=${trig.id} (${trig.name}): ${
            err instanceof Error ? err.message : err
          }`,
        );
      });
    }
    const fireReq: TriggerFireRequest = {
      trigger: trig,
      value: result.firedValue,
      uom: outputUom,
      sourceTimestamp: ctx.sourceTimestamp,
      ...(result.snapshots !== undefined ? { snapshots: result.snapshots } : {}),
    };
    // Publish is fire-and-forget — failures are logged but never
    // propagate up into the MQTT handler (that would block other
    // triggers / topics on a single broker hiccup).
    Promise.resolve(this.publisher.fire(fireReq)).catch((err) => {
      logger.warn(
        `[triggers] publish failed for trigger=${trig.id} (${trig.name}): ${
          err instanceof Error ? err.message : err
        }`,
      );
    });
  }

  /** Test-only accessor for the per-trigger state map.  Lets unit
   *  tests assert that lastSeenValue advanced even when the fire
   *  was suppressed.  Intentionally not part of the public Stage 1
   *  surface — exposed via the same service so a test doesn't have
   *  to reach into the evaluator separately. */
  __getStateForTest(triggerId: string): TriggerRuntimeState | undefined {
    return this.state.get(triggerId);
  }

  /** Stage 4b — runtime inspection.  Returns one view per trigger
   *  currently in the registry, including triggers that have
   *  never been evaluated (so the admin UI shows them as
   *  "Awaiting first value" rather than missing entirely).
   *  Cheap — pure in-memory map iteration, no I/O. */
  getRuntimeStates(): TriggerRuntimeView[] {
    const out: TriggerRuntimeView[] = [];
    // Walk every registered trigger so the response covers
    // not-yet-evaluated triggers too (UI needs to know they exist).
    for (const trig of this.registry.list()) {
      const state = this.state.get(trig.id) ?? FRESH_STATE;
      const metrics = this.metrics.get(trig.id) ?? FRESH_METRICS();
      // Stage 4b/5 — "armed" means "the evaluator has seen this
      // trigger at least once".  We derive from metrics.lastEvaluatedAt
      // because state.lastSeenValue is per-kind:
      //   high/low/event/string update lastSeenValue on every eval
      //   compare           updates lastComparisonResult instead
      //   composite         updates lastCompositeResult instead
      // Using lastEvaluatedAt makes the flag truthful for every kind
      // — the alternative (checking each kind-specific state field)
      // would silently drift as new kinds ship.
      const isArmed = metrics.lastEvaluatedAt !== null;
      out.push({
        triggerId: trig.id,
        state,
        metrics,
        isArmed,
      });
    }
    return out;
  }
}

const FRESH_STATE: TriggerRuntimeState = {
  lastSeenValue: null,
  lastFiredAt: null,
};

const FRESH_METRICS = (): TriggerRuntimeMetrics => ({
  fireCount: 0,
  suppressionCount: 0,
  lastSuppressedReason: null,
  lastEvaluatedAt: null,
});
