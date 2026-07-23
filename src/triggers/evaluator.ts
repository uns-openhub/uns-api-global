// src/triggers/evaluator.ts
//
// Pure evaluator functions for the Stage 1 trigger kinds.  Each
// `evaluate*` is stateless on the call site — the caller (the
// service orchestrator) holds the per-trigger TriggerRuntimeState
// and threads it through.  This keeps the evaluators
// trivially testable: no time, no MQTT, no clock injection
// machinery — just (incomingValue, prevState, config, now) →
// fire decision.
//
// FIRING RULES (edge-only by default — admin-confirmed in the
// design discussion that led to this PR):
//
//   high   — fires when (incoming > threshold) AND (lastSeen is
//            null OR lastSeen <= threshold).  First message
//            after boot arms the trigger but does NOT fire,
//            because we have no edge to detect.  Replay-on-
//            restart was explicitly opt-out (admin: "restart =
//            alert storm" — bad).
//
//   low    — symmetric.
//
//   event  — fires on any value change (string-equality compare).
//            First message after boot arms but doesn't fire.
//            When `config.matchValues` is set, the new value must
//            also be one of those values for the fire to count.
//
// COOLDOWN — when `cooldownMs` is set on the trigger, suppress
// fires that fall within the window after a previous fire.  The
// cooldown window starts at the previous successful fire (not at
// the previous EVALUATION).  Enforced after the edge-detection
// pass so a "would-fire-but-cooldown" still updates lastSeenValue
// — otherwise a cooled-down edge would persistently re-arm.

import type {
  CompareOperator,
  CompositeCondition,
  TriggerConfigCompare,
  TriggerConfigComposite,
  TriggerConfigEvent,
  TriggerConfigHigh,
  TriggerConfigLow,
  TriggerConfigString,
  TriggerDefinition,
  TriggerRuntimeState,
  TriggerSnapshot,
} from "./types.js";

/** Read-only view into the last-value cache, supplied by the
 *  service.  Must return null when the topic has never been seen
 *  (or has been evicted).  `ageMs` is computed by the evaluator
 *  from the `time` field, so callers don't need to pre-compute it. */
export type LastValueAccessor = (topic: string) => LastValueSnapshot | null;

/** What the service hands the evaluator when the latter asks
 *  "what's the latest value on topic X?".  Mirrors the relevant
 *  bits of LastValueEntry in src/index.ts. */
export type LastValueSnapshot = {
  /** The "value" of the entry — for Data attributes that's the
   *  scalar; for Table attributes the service can pick a column or
   *  hand the whole values object (callers pre-extract). */
  value: unknown;
  uom: string | null;
  /** ISO source timestamp on the original packet. */
  time: string;
  /** Wall-clock ms when the cache last received the entry. */
  receivedAt: number;
};

/** The result of evaluating one trigger against one incoming
 *  message.  `nextState` is the runtime state to commit AFTER this
 *  evaluation — callers persist it back into the per-trigger state
 *  Map regardless of whether `fired` is true (lastSeenValue updates
 *  on every message; lastFiredAt only updates on real fires). */
export type EvaluationResult = {
  fired: boolean;
  /** When `fired === true`, the value the publisher should use as
   *  the trigger's data.  Number form for high/low/compare, string
   *  for event/string.  Null when fired === false. */
  firedValue: number | string | null;
  nextState: TriggerRuntimeState;
  /** Optional reason a fire was suppressed — useful for trace
   *  logging.  Examples: 'no_edge', 'cooldown', 'no_match',
   *  'value_not_numeric', 'first_value_arms_trigger',
   *  'peer_value_missing', 'falling_edge_ignored',
   *  'stale_snapshot'. */
  suppressedReason: string | null;
  /** `string`-only: snapshots captured at fire time.  Threaded
   *  through to the publisher so the fire payload's
   *  `triggerMeta.snapshots` reflects what the cache held when the
   *  trigger fired.  Undefined for other kinds. */
  snapshots?: readonly TriggerSnapshot[];
};

const FIRE_RESULT_SHAPE = (
  firedValue: number | string,
  nextState: TriggerRuntimeState,
): EvaluationResult => ({
  fired: true,
  firedValue,
  nextState,
  suppressedReason: null,
});

const SUPPRESS = (
  reason: string,
  nextState: TriggerRuntimeState,
): EvaluationResult => ({
  fired: false,
  firedValue: null,
  nextState,
  suppressedReason: reason,
});

/** Optional context the service can hand the evaluator.  Stage 1
 *  kinds ignore these; Stage 2 kinds need them:
 *    - `compare` reads the OTHER topic's last-known value via
 *      `getLastValue` (caller passes a topic, gets a snapshot).
 *    - `string` reads N snapshot topics on every fire.
 *    - `incomingTopic` lets `compare` know which side just updated
 *      (the other side comes from `getLastValue`).
 *  All optional so existing call sites (Stage 1 unit tests) stay
 *  signature-clean.
 */
export type EvaluationContext = {
  getLastValue?: LastValueAccessor;
  /** The topic the incoming message arrived on.  Required for
   *  `compare`; ignored by everyone else. */
  incomingTopic?: string;
};

/**
 * Evaluate one trigger against one incoming message.  Dispatches
 * on `trigger.kind` to the right kind-specific evaluator.  Every
 * branch returns `nextState` — the caller commits unconditionally
 * so lastSeenValue always tracks even when the fire was suppressed.
 */
export function evaluateTrigger(
  trigger: TriggerDefinition,
  incomingValue: unknown,
  prevState: TriggerRuntimeState,
  now: number,
  ctx: EvaluationContext = {},
): EvaluationResult {
  switch (trigger.kind) {
    case "high":
      return evaluateHigh(
        trigger.config as TriggerConfigHigh,
        incomingValue,
        prevState,
        trigger.cooldownMs,
        now,
      );
    case "low":
      return evaluateLow(
        trigger.config as TriggerConfigLow,
        incomingValue,
        prevState,
        trigger.cooldownMs,
        now,
      );
    case "event":
      return evaluateEvent(
        trigger.config as TriggerConfigEvent,
        incomingValue,
        prevState,
        trigger.cooldownMs,
        now,
      );
    case "compare":
      return evaluateCompare(
        trigger.config as TriggerConfigCompare,
        incomingValue,
        prevState,
        trigger.cooldownMs,
        now,
        ctx,
      );
    case "string":
      return evaluateString(
        trigger.config as TriggerConfigString,
        incomingValue,
        prevState,
        trigger.cooldownMs,
        now,
        ctx,
      );
    case "composite":
      return evaluateComposite(
        trigger.config as TriggerConfigComposite,
        prevState,
        trigger.cooldownMs,
        now,
        ctx,
      );
    default: {
      // Unreachable (controller validates kind on write) — but
      // surface as suppressed so a corrupt registry can't crash
      // the evaluation loop.
      const _exhaustive: never = trigger.kind;
      return SUPPRESS(`unknown_kind:${String(_exhaustive)}`, prevState);
    }
  }
}

function evaluateHigh(
  config: TriggerConfigHigh,
  incomingValue: unknown,
  prevState: TriggerRuntimeState,
  cooldownMs: number | null,
  now: number,
): EvaluationResult {
  const incomingNum = coerceNumber(incomingValue);
  if (incomingNum === null) {
    // Non-numeric on a numeric trigger: leave state untouched
    // (don't pollute lastSeenValue with a bad value) and bail.
    return SUPPRESS("value_not_numeric", prevState);
  }
  const nextState: TriggerRuntimeState = {
    ...prevState,
    lastSeenValue: incomingNum,
  };
  const threshold = config.threshold;
  const currentlyAbove = incomingNum > threshold;

  // First-message-after-boot path: arm the trigger but don't fire
  // — admin-locked decision (see file header).
  const prevSeen = prevState.lastSeenValue;
  if (prevSeen === null) {
    return SUPPRESS("first_value_arms_trigger", nextState);
  }
  const prevNum = typeof prevSeen === "number" ? prevSeen : coerceNumber(prevSeen);
  if (prevNum === null) {
    // Prev exists but isn't numeric — treat as no-edge.
    return SUPPRESS("prev_not_numeric", nextState);
  }
  const wasAbove = prevNum > threshold;
  if (!currentlyAbove || wasAbove) {
    return SUPPRESS(currentlyAbove ? "no_edge" : "below_threshold", nextState);
  }
  // We've crossed up over the threshold.  Apply cooldown gate.
  if (
    cooldownMs !== null &&
    prevState.lastFiredAt !== null &&
    now - prevState.lastFiredAt < cooldownMs
  ) {
    return SUPPRESS("cooldown", nextState);
  }
  return FIRE_RESULT_SHAPE(incomingNum, {
    ...nextState,
    lastFiredAt: now,
  });
}

function evaluateLow(
  config: TriggerConfigLow,
  incomingValue: unknown,
  prevState: TriggerRuntimeState,
  cooldownMs: number | null,
  now: number,
): EvaluationResult {
  const incomingNum = coerceNumber(incomingValue);
  if (incomingNum === null) {
    return SUPPRESS("value_not_numeric", prevState);
  }
  const nextState: TriggerRuntimeState = {
    ...prevState,
    lastSeenValue: incomingNum,
  };
  const threshold = config.threshold;
  const currentlyBelow = incomingNum < threshold;

  const prevSeen = prevState.lastSeenValue;
  if (prevSeen === null) {
    return SUPPRESS("first_value_arms_trigger", nextState);
  }
  const prevNum = typeof prevSeen === "number" ? prevSeen : coerceNumber(prevSeen);
  if (prevNum === null) {
    return SUPPRESS("prev_not_numeric", nextState);
  }
  const wasBelow = prevNum < threshold;
  if (!currentlyBelow || wasBelow) {
    return SUPPRESS(currentlyBelow ? "no_edge" : "above_threshold", nextState);
  }
  if (
    cooldownMs !== null &&
    prevState.lastFiredAt !== null &&
    now - prevState.lastFiredAt < cooldownMs
  ) {
    return SUPPRESS("cooldown", nextState);
  }
  return FIRE_RESULT_SHAPE(incomingNum, {
    ...nextState,
    lastFiredAt: now,
  });
}

function evaluateEvent(
  config: TriggerConfigEvent,
  incomingValue: unknown,
  prevState: TriggerRuntimeState,
  cooldownMs: number | null,
  now: number,
): EvaluationResult {
  // event triggers compare on stringified form so numeric +
  // string topics both work.  Empty / null / undefined incoming
  // values are dropped — there's no useful fire to emit there.
  const incomingStr = coerceString(incomingValue);
  if (incomingStr === null) {
    return SUPPRESS("value_empty", prevState);
  }
  const nextState: TriggerRuntimeState = {
    ...prevState,
    lastSeenValue: incomingStr,
  };
  const prevSeen = prevState.lastSeenValue;
  if (prevSeen === null) {
    return SUPPRESS("first_value_arms_trigger", nextState);
  }
  const prevStr = typeof prevSeen === "string" ? prevSeen : String(prevSeen);
  if (prevStr === incomingStr) {
    return SUPPRESS("no_change", nextState);
  }
  // Optional matchValues filter: when set, the NEW value must be
  // one of the listed strings.  Trim + case-sensitive — same shape
  // the controller's resolver canonicalised on write.
  const matchValues = Array.isArray(config.matchValues) ? config.matchValues : null;
  if (matchValues && matchValues.length > 0) {
    if (!matchValues.includes(incomingStr)) {
      return SUPPRESS("not_in_match_values", nextState);
    }
  }
  if (
    cooldownMs !== null &&
    prevState.lastFiredAt !== null &&
    now - prevState.lastFiredAt < cooldownMs
  ) {
    return SUPPRESS("cooldown", nextState);
  }
  return FIRE_RESULT_SHAPE(incomingStr, {
    ...nextState,
    lastFiredAt: now,
  });
}

/** Cross-topic comparison.  Either topic can drive evaluation —
 *  the service tells us via `ctx.incomingTopic` which side just
 *  updated, and we read the OTHER side from the cache.  Result
 *  shape, including snapshot embedding, is described above.
 *
 *  Edge semantics: fire only on rising edge of the comparison
 *  result (false → true).  Falling edge is silent — admin handles
 *  it by creating an inverse trigger with the opposite operator.
 */
function evaluateCompare(
  config: TriggerConfigCompare,
  incomingValue: unknown,
  prevState: TriggerRuntimeState,
  cooldownMs: number | null,
  now: number,
  ctx: EvaluationContext,
): EvaluationResult {
  const incomingNum = coerceNumber(incomingValue);
  if (incomingNum === null) {
    // Bad value — leave state unchanged (don't pollute
    // lastComparisonResult with a stale half-state).
    return SUPPRESS("value_not_numeric", prevState);
  }
  const incomingTopic = ctx.incomingTopic;
  if (!incomingTopic) {
    // Service must always pass incomingTopic for compare; if it
    // doesn't, treat as a config error and bail without state
    // mutation.
    return SUPPRESS("missing_incoming_topic", prevState);
  }
  // Determine which side this message belongs to and look up the
  // peer.  The accessor returns null when the cache hasn't seen
  // the peer yet — first-message-arms still applies.
  let leftNum: number | null;
  let rightNum: number | null;
  if (incomingTopic === config.leftTopic) {
    leftNum = incomingNum;
    rightNum = lookupNumber(ctx.getLastValue, config.rightTopic);
  } else if (incomingTopic === config.rightTopic) {
    rightNum = incomingNum;
    leftNum = lookupNumber(ctx.getLastValue, config.leftTopic);
  } else {
    // Defensive: registry should only route messages whose topic
    // matches one of the operands.  If we get here something is
    // off — suppress without mutation.
    return SUPPRESS("topic_not_in_compare_config", prevState);
  }

  // Track the incoming value as lastSeenValue so debug surfaces
  // can read "last numeric on this trigger" — even if peer is
  // missing.  lastComparisonResult stays separate.
  const baseNextState: TriggerRuntimeState = {
    ...prevState,
    lastSeenValue: incomingNum,
  };

  if (leftNum === null || rightNum === null) {
    // Peer hasn't arrived yet — arm but don't fire.  Don't update
    // lastComparisonResult either: a half-known relation is not a
    // result we should later detect a "false → true" edge against.
    return SUPPRESS("peer_value_missing", baseNextState);
  }
  const currentResult = applyOperator(config.operator, leftNum, rightNum);

  const nextState: TriggerRuntimeState = {
    ...baseNextState,
    lastComparisonResult: currentResult,
  };
  const prevResult = prevState.lastComparisonResult;
  if (prevResult === null || prevResult === undefined) {
    // First evaluable comparison — arm but don't fire.
    return SUPPRESS("first_value_arms_trigger", nextState);
  }
  if (currentResult === prevResult) {
    return SUPPRESS("no_edge", nextState);
  }
  // currentResult !== prevResult — but we only fire on the rising
  // edge (false → true).  Falling edge is silent.
  if (!currentResult) {
    return SUPPRESS("falling_edge_ignored", nextState);
  }
  if (
    cooldownMs !== null &&
    prevState.lastFiredAt !== null &&
    now - prevState.lastFiredAt < cooldownMs
  ) {
    return SUPPRESS("cooldown", nextState);
  }
  // Use the incoming side's value as the fire value (the side
  // that "tipped" the comparison).  Consumers that want both sides
  // can read them off the snapshots in the publisher payload.
  return FIRE_RESULT_SHAPE(incomingNum, {
    ...nextState,
    lastFiredAt: now,
  });
}

/** Event-with-correlated-reads.  Mirrors `event` for the
 *  match/edge logic; on every successful would-fire, also reads
 *  each `snapshotTopics` entry from the last-value cache.  When
 *  ANY snapshot is missing or older than `staleAfterMs`, the fire
 *  is suppressed (admin-confirmed: no half-snapshot).  State still
 *  updates so the next change can be detected. */
function evaluateString(
  config: TriggerConfigString,
  incomingValue: unknown,
  prevState: TriggerRuntimeState,
  cooldownMs: number | null,
  now: number,
  ctx: EvaluationContext,
): EvaluationResult {
  const incomingStr = coerceString(incomingValue);
  if (incomingStr === null) {
    return SUPPRESS("value_empty", prevState);
  }
  const nextState: TriggerRuntimeState = {
    ...prevState,
    lastSeenValue: incomingStr,
  };
  const prevSeen = prevState.lastSeenValue;
  if (prevSeen === null) {
    return SUPPRESS("first_value_arms_trigger", nextState);
  }
  const prevStr = typeof prevSeen === "string" ? prevSeen : String(prevSeen);
  if (prevStr === incomingStr) {
    return SUPPRESS("no_change", nextState);
  }
  const matchValues = Array.isArray(config.matchValues) ? config.matchValues : null;
  if (matchValues && matchValues.length > 0) {
    if (!matchValues.includes(incomingStr)) {
      return SUPPRESS("not_in_match_values", nextState);
    }
  }
  if (
    cooldownMs !== null &&
    prevState.lastFiredAt !== null &&
    now - prevState.lastFiredAt < cooldownMs
  ) {
    return SUPPRESS("cooldown", nextState);
  }
  // Fire conditions met — gather snapshots.  The publisher reads
  // them from the EvaluationResult via a new `snapshots` field
  // (added below) and embeds into triggerMeta.snapshots.
  const snapshots = gatherSnapshots(config.snapshotTopics, ctx.getLastValue, now, config.staleAfterMs);
  if (snapshots === null) {
    // At least one snapshot was stale or missing — suppress per
    // design.  State still updates so the next change is seen as
    // a fresh edge.
    return SUPPRESS("stale_snapshot", nextState);
  }
  return {
    fired: true,
    firedValue: incomingStr,
    nextState: { ...nextState, lastFiredAt: now },
    suppressedReason: null,
    snapshots,
  };
}

/** Returns `null` when ANY snapshot is missing or stale.  Otherwise
 *  returns a fully-populated array in the order specified by
 *  `topics` (so consumers can pin against position). */
function gatherSnapshots(
  topics: readonly string[],
  getLastValue: LastValueAccessor | undefined,
  now: number,
  staleAfterMs: number,
): TriggerSnapshot[] | null {
  if (!getLastValue) return null; // accessor not wired — treat as stale
  const out: TriggerSnapshot[] = [];
  for (const topic of topics) {
    const snap = getLastValue(topic);
    if (!snap) return null;
    const ageMs = now - snap.receivedAt;
    if (ageMs > staleAfterMs) return null;
    out.push({
      topic,
      value: snap.value,
      uom: snap.uom,
      time: snap.time,
      ageMs,
    });
  }
  return out;
}

/** Composite (AND/OR) — evaluate each condition independently
 *  against the latest cached value of its topic, then join with the
 *  configured operator.  Fires only on the rising edge (false→true).
 *
 *  Missing-value semantics: a condition whose topic has no cached
 *  value evaluates to `false`.  This means the composite walks
 *  `false → false → … → true` naturally as inputs arrive on boot,
 *  so we don't need a separate "first evaluation arms" state
 *  machine — the rising-edge detector fires only when all inputs
 *  have actually been observed at the right values.  See the
 *  Stage 5 design discussion for why this is preferred over
 *  treat-as-suppressed-until-warm.
 *
 *  The service indexes EVERY conditions[].topic in the registry
 *  inverted index (see registry.applyRows), so a message on any
 *  one of them re-runs this evaluator.  ctx.incomingTopic is
 *  ignored — we always read all conditions from the cache so the
 *  result reflects the latest observed state, not just the topic
 *  that arrived. */
function evaluateComposite(
  config: TriggerConfigComposite,
  prevState: TriggerRuntimeState,
  cooldownMs: number | null,
  now: number,
  ctx: EvaluationContext,
): EvaluationResult {
  const conditions: readonly CompositeCondition[] = Array.isArray(config.conditions)
    ? config.conditions
    : [];
  if (conditions.length === 0) {
    return SUPPRESS("composite_no_conditions", prevState);
  }
  const operator = config.operator === "or" ? "or" : "and";
  // Evaluate every condition by reading its topic from the cache.
  // Missing topics return null → coerced to `false` (treat-as-false).
  let currentResult = operator === "and";
  let firstSatisfiedValue: number | string | null = null;
  for (const cond of conditions) {
    const ok = evaluateCondition(cond, ctx.getLastValue);
    if (ok && firstSatisfiedValue === null) {
      // For the fire payload's `value` field we pick the first
      // satisfied condition's actual cached value — gives the
      // downstream consumer something concrete to log/display.
      const snap = ctx.getLastValue?.(cond.topic);
      if (snap) {
        if (typeof snap.value === "number") firstSatisfiedValue = snap.value;
        else if (typeof snap.value === "string") firstSatisfiedValue = snap.value;
      }
    }
    if (operator === "and" && !ok) {
      currentResult = false;
      break;
    }
    if (operator === "or" && ok) {
      currentResult = true;
      break;
    }
  }
  // For OR we may have exited the loop on the first true match;
  // for AND we may have exited on the first false.  Otherwise
  // currentResult holds the all-true (AND) or all-false (OR) outcome.

  const nextState: TriggerRuntimeState = {
    ...prevState,
    lastCompositeResult: currentResult,
  };
  const prevResult =
    prevState.lastCompositeResult === undefined ? false : prevState.lastCompositeResult ?? false;
  if (currentResult === prevResult) {
    return SUPPRESS(currentResult ? "no_edge" : "composite_false", nextState);
  }
  if (!currentResult) {
    // Falling edge — silent (matches compare's convention).
    return SUPPRESS("falling_edge_ignored", nextState);
  }
  // Rising edge → fire.  Cooldown gate.
  if (
    cooldownMs !== null &&
    prevState.lastFiredAt !== null &&
    now - prevState.lastFiredAt < cooldownMs
  ) {
    return SUPPRESS("cooldown", nextState);
  }
  // Pick a sensible firedValue: the first satisfied condition's
  // value if available, otherwise a synthetic "1" so the publisher
  // has something to send (the meaningful info is in triggerMeta,
  // not in data.value for composites).
  const firedValue = firstSatisfiedValue ?? 1;
  return FIRE_RESULT_SHAPE(firedValue, {
    ...nextState,
    lastFiredAt: now,
  });
}

/** Evaluate a single composite condition against the cache.
 *  Returns false when the topic has no cached value (treat-as-false)
 *  or when the cached value can't be coerced to the predicate's
 *  required type (e.g. string value compared with `gt`). */
function evaluateCondition(
  cond: CompositeCondition,
  getLastValue: LastValueAccessor | undefined,
): boolean {
  if (!getLastValue) return false;
  const snap = getLastValue(cond.topic);
  if (!snap) return false;
  const cached = snap.value;
  switch (cond.predicate) {
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      const left = coerceNumber(cached);
      const right = typeof cond.value === "number" ? cond.value : coerceNumber(cond.value);
      if (left === null || right === null) return false;
      return applyOperator(cond.predicate, left, right);
    }
    case "eq":
    case "neq": {
      // eq/neq: numeric-vs-numeric uses ===; otherwise string-vs-string.
      // The validator allows string OR number for eq/neq, so we coerce
      // only when the configured value is numeric — string values
      // compare exactly.
      if (typeof cond.value === "number") {
        const left = coerceNumber(cached);
        if (left === null) return cond.predicate === "neq";
        return cond.predicate === "eq" ? left === cond.value : left !== cond.value;
      }
      const leftStr = typeof cached === "string" ? cached : String(cached ?? "");
      return cond.predicate === "eq" ? leftStr === cond.value : leftStr !== cond.value;
    }
    default: {
      const _exhaustive: never = cond.predicate;
      return false;
    }
  }
}

function lookupNumber(
  getLastValue: LastValueAccessor | undefined,
  topic: string,
): number | null {
  if (!getLastValue) return null;
  const snap = getLastValue(topic);
  if (!snap) return null;
  return coerceNumber(snap.value);
}

function applyOperator(op: CompareOperator, left: number, right: number): boolean {
  switch (op) {
    case "gt":
      return left > right;
    case "lt":
      return left < right;
    case "gte":
      return left >= right;
    case "lte":
      return left <= right;
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    default: {
      const _exhaustive: never = op;
      return false; // unreachable
    }
  }
}

/** Coerce an MQTT-shaped value to a finite number.  Accepts:
 *    - a JS number (must be finite)
 *    - a string that parses to a finite number
 *    - everything else → null
 *  Booleans are deliberately rejected — we don't want `true` to
 *  silently coerce to 1 on a `high` threshold trigger. */
function coerceNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Coerce an MQTT-shaped value to a non-empty string.  Accepts:
 *    - a string (trimmed; empty → null)
 *    - a number (toString)
 *    - a boolean ('true' / 'false' — useful for state-attribute
 *      triggers where the source emits booleans)
 *    - everything else → null
 *  Mirrors the eval surface of the catchall response parser, so
 *  triggers can match the same values the catchall surfaces. */
function coerceString(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? String(raw) : null;
  }
  if (typeof raw === "boolean") return raw ? "true" : "false";
  return null;
}
