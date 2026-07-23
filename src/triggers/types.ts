// src/triggers/types.ts
//
// Shared types for the Stage 1 trigger module.  Mirror what the
// controller's GET /api/triggers endpoint emits — see
// src/routes/api.ts and src/postgres/queries/trigger-definitions-
// reads.ts in uns-datahub-controller.
//
// Stage 1 supports three kinds:
//   high   — fire when value > config.threshold (edge-only)
//   low    — fire when value < config.threshold (edge-only)
//   event  — fire on value change, optionally filtered by
//            config.matchValues
//
// Stage 2 adds two more kinds:
//   compare — fire on rising edge of a cross-topic comparison
//             (left OP right).  Driven by messages on EITHER
//             topic — the registry indexes both leftTopic and
//             rightTopic to the same trigger so a value change
//             on either side re-evaluates.
//   string  — like `event`, but at fire time the evaluator also
//             reads N other topics from the last-value cache and
//             returns them as snapshots.  Stale snapshots
//             (missing or older than staleAfterMs) suppress the
//             fire — admin-confirmed "no half-snapshot" rule.
//
// Stage 5 adds the composite kind:
//   composite — AND/OR expression over N per-topic conditions.
//               Fires on rising edge of the boolean composite
//               (false→true).  Missing cached values evaluate as
//               `false` for that condition (the composite naturally
//               rolls from false → true as inputs arrive on boot).
//               Driven by messages on ANY conditions[].topic — the
//               registry indexes all of them.

export type TriggerKind = "high" | "low" | "event" | "compare" | "string" | "composite";

export type CompareOperator = "gt" | "lt" | "gte" | "lte" | "eq" | "neq";

/** Stage 5 — predicate set per composite condition.  Same six
 *  operators as compare; eq/neq double for string equality. */
export type CompositePredicate = CompareOperator;

/** Logical join across composite conditions. */
export type CompositeOperator = "and" | "or";
export type TriggerUomMode = "inherit" | "override" | "none";

export type TriggerOutputUomConfig = {
  /** Output UoM policy for the fired scalar value.  Missing means
   *  "inherit source" for backwards compatibility with existing
   *  trigger definitions. */
  uomMode?: TriggerUomMode;
  /** Required only when uomMode is "override". */
  uom?: string;
};

export type TriggerConfigHigh = TriggerOutputUomConfig & {
  threshold: number;
};

export type TriggerConfigLow = TriggerOutputUomConfig & {
  threshold: number;
};

export type TriggerConfigEvent = TriggerOutputUomConfig & {
  /** Optional filter: when set, only fire if the new value (as a
   *  trimmed string) is one of these.  Empty / omitted = fire on
   *  any change. */
  matchValues?: readonly string[];
};

export type TriggerConfigCompare = TriggerOutputUomConfig & {
  /** First operand topic.  The current value is read from the
   *  last-value cache when a message arrives on EITHER topic. */
  leftTopic: string;
  /** Second operand topic. */
  rightTopic: string;
  /** Comparison operator.  Six relations supported — see
   *  CompareOperator above. */
  operator: CompareOperator;
};

export type TriggerConfigString = TriggerOutputUomConfig & {
  /** Required: 1..8 topic strings whose latest cached values are
   *  embedded into the fire payload's `triggerMeta.snapshots`. */
  snapshotTopics: readonly string[];
  /** Maximum age (ms) for any snapshot to count as fresh.  When any
   *  snapshot is missing or older, the fire is suppressed with
   *  `suppressedReason='stale_snapshot'`.  Default 60_000. */
  staleAfterMs: number;
  /** Same semantics as TriggerConfigEvent.matchValues — optional
   *  whitelist of source values that count as a fire. */
  matchValues?: readonly string[];
};

/** Stage 5 — one predicate per condition: `<topic> <predicate> <value>`.
 *  `value` is `number` for the four numeric predicates (gt/lt/gte/lte)
 *  and `number | string` for eq/neq (the controller validator
 *  rejects string values for the four numeric predicates so the
 *  union here is permissive). */
export type CompositeCondition = {
  topic: string;
  predicate: CompositePredicate;
  value: number | string;
};

export type TriggerConfigComposite = TriggerOutputUomConfig & {
  operator: CompositeOperator;
  conditions: readonly CompositeCondition[];
};

export type TriggerConfig =
  | TriggerConfigHigh
  | TriggerConfigLow
  | TriggerConfigEvent
  | TriggerConfigCompare
  | TriggerConfigString
  | TriggerConfigComposite;

/** A single snapshot captured at fire time for a `string` trigger.
 *  Embedded into the fire payload so downstream consumers see the
 *  correlated reads (e.g. zone-1 temp + zone-1 pressure at the
 *  moment slab-001 → EXITED). */
export type TriggerSnapshot = {
  topic: string;
  value: unknown;
  uom: string | null;
  /** Source timestamp from the cached entry. */
  time: string;
  /** How old the snapshot was at fire time, in ms.  Useful for
   *  consumers to reason about correlated freshness. */
  ageMs: number;
};

export type TriggerDefinition = {
  id: string;
  name: string;
  kind: TriggerKind;
  sourceTopic: string;
  outputTopic: string;
  /** Parsed object — the controller's REST endpoint hands it to
   *  us pre-parsed (configParsed in the row) so we don't JSON.parse
   *  on every refresh. */
  config: TriggerConfig;
  cooldownMs: number | null;
  enabled: boolean;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The runtime per-trigger state the evaluator uses to enforce
 *  edge-only firing + cooldowns.  Keyed by trigger id so disabling /
 *  re-enabling a trigger doesn't reset its peer's state. */
export type TriggerRuntimeState = {
  /** Last value SEEN for this trigger's source topic (string form
   *  for `event` / `string`, number form for `high` / `low`).  Null
   *  until the first message arrives — first message arms the
   *  trigger but doesn't fire (see evaluator.ts for the rationale). */
  lastSeenValue: string | number | null;
  /** Wall-clock ms when this trigger last fired.  Null until first
   *  fire.  Used for cooldown enforcement. */
  lastFiredAt: number | null;
  /** `compare`-only: previous comparison result (left OP right).
   *  Null until both sides have a cached value at evaluation time.
   *  Edge fires only on the false→true transition. */
  lastComparisonResult?: boolean | null;
  /** `composite`-only: previous AND/OR result.  `false` is the
   *  natural starting state (treat-missing-as-false), so we don't
   *  have to special-case "first evaluation arms".  Edge fires
   *  only on the false→true transition. */
  lastCompositeResult?: boolean | null;
};

/** A "fire" decision produced by the evaluator for a single
 *  (trigger, incoming-message) pair.  Consumed by the publisher,
 *  which constructs the uns-kit message and pushes it to the
 *  configured outputTopic. */
export type TriggerFireRequest = {
  trigger: TriggerDefinition;
  /** The triggering value as parsed from the incoming MQTT message
   *  (number for high/low/compare, string for event/string). */
  value: number | string;
  /** UoM from the source message, if any. */
  uom: string | null;
  /** ISO 8601 timestamp from the incoming message; falls back to
   *  the wall-clock receive time when the message had none. */
  sourceTimestamp: string;
  /** Snapshots captured at fire time — only populated for `string`-kind
   * triggers and consumed by the trigger fire audit path. They are not embedded
   * in the UNS scalar output packet. */
  snapshots?: readonly TriggerSnapshot[];
};
