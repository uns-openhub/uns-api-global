import test from "node:test";
import assert from "node:assert/strict";

import { evaluateTrigger } from "../src/triggers/evaluator.js";
import type { LastValueSnapshot } from "../src/triggers/evaluator.js";
import type {
  TriggerDefinition,
  TriggerRuntimeState,
} from "../src/triggers/types.js";

// Helper: deterministic last-value cache for compare/string tests.
function makeCache(entries: Record<string, { value: unknown; uom?: string | null; time?: string; receivedAt?: number }>) {
  return (topic: string): LastValueSnapshot | null => {
    const e = entries[topic];
    if (!e) return null;
    return {
      value: e.value,
      uom: e.uom ?? null,
      time: e.time ?? "2026-04-26T10:00:00.000Z",
      receivedAt: e.receivedAt ?? 0,
    };
  };
}

// Test-side factory.  The controller emits these from
// /api/triggers; we just need the runtime-relevant subset for the
// evaluator's contract.
function makeTrigger(overrides: Partial<TriggerDefinition>): TriggerDefinition {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Test trigger",
    kind: "high",
    sourceTopic: "x/y/z",
    outputTopic: "alarms/x/y/z",
    config: { threshold: 100 },
    cooldownMs: null,
    enabled: true,
    description: null,
    createdBy: null,
    createdAt: "2026-04-26T10:00:00.000Z",
    updatedAt: "2026-04-26T10:00:00.000Z",
    ...overrides,
  };
}

const FRESH_STATE: TriggerRuntimeState = {
  lastSeenValue: null,
  lastFiredAt: null,
};

test("high — first value arms but does not fire (no edge to detect)", () => {
  const trigger = makeTrigger({ kind: "high", config: { threshold: 100 } });
  const result = evaluateTrigger(trigger, 150, FRESH_STATE, 1000);
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "first_value_arms_trigger");
  assert.equal(result.nextState.lastSeenValue, 150);
  assert.equal(result.nextState.lastFiredAt, null);
});

test("high — fires when crossing UP through the threshold", () => {
  const trigger = makeTrigger({ kind: "high", config: { threshold: 100 } });
  const armed: TriggerRuntimeState = { lastSeenValue: 80, lastFiredAt: null };
  const result = evaluateTrigger(trigger, 120, armed, 5000);
  assert.equal(result.fired, true);
  assert.equal(result.firedValue, 120);
  assert.equal(result.nextState.lastSeenValue, 120);
  assert.equal(result.nextState.lastFiredAt, 5000);
});

test("high — does NOT fire when staying above threshold (no fresh edge)", () => {
  const trigger = makeTrigger({ kind: "high", config: { threshold: 100 } });
  const armed: TriggerRuntimeState = { lastSeenValue: 120, lastFiredAt: 1 };
  const result = evaluateTrigger(trigger, 130, armed, 5000);
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "no_edge");
  assert.equal(result.nextState.lastSeenValue, 130);
});

test("high — does NOT fire when crossing DOWN through threshold", () => {
  const trigger = makeTrigger({ kind: "high", config: { threshold: 100 } });
  const armed: TriggerRuntimeState = { lastSeenValue: 120, lastFiredAt: null };
  const result = evaluateTrigger(trigger, 80, armed, 5000);
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "below_threshold");
});

test("low — fires when crossing DOWN through threshold", () => {
  const trigger = makeTrigger({ kind: "low", config: { threshold: 50 } });
  const armed: TriggerRuntimeState = { lastSeenValue: 80, lastFiredAt: null };
  const result = evaluateTrigger(trigger, 30, armed, 5000);
  assert.equal(result.fired, true);
  assert.equal(result.firedValue, 30);
});

test("low — symmetric: does NOT fire when staying below or going up", () => {
  const trigger = makeTrigger({ kind: "low", config: { threshold: 50 } });
  const stuckLow: TriggerRuntimeState = { lastSeenValue: 30, lastFiredAt: 1 };
  const stayLow = evaluateTrigger(trigger, 25, stuckLow, 5000);
  assert.equal(stayLow.fired, false);
  assert.equal(stayLow.suppressedReason, "no_edge");

  const goingUp = evaluateTrigger(trigger, 90, stuckLow, 5000);
  assert.equal(goingUp.fired, false);
  assert.equal(goingUp.suppressedReason, "above_threshold");
});

test("high — non-numeric values suppress without polluting state", () => {
  const trigger = makeTrigger({ kind: "high", config: { threshold: 100 } });
  const armed: TriggerRuntimeState = { lastSeenValue: 80, lastFiredAt: null };
  const result = evaluateTrigger(trigger, "not a number", armed, 1000);
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "value_not_numeric");
  // lastSeenValue must NOT have been overwritten with the bogus value.
  assert.equal(result.nextState.lastSeenValue, 80);
});

test("high — booleans are NOT silently coerced (true → 1 on threshold=0)", () => {
  // Defensive: a boolean source attr shouldn't accidentally fire a
  // high trigger configured for a threshold near 0.  The evaluator
  // rejects booleans on numeric kinds — admin should use kind=event
  // for boolean transitions.
  const trigger = makeTrigger({ kind: "high", config: { threshold: 0 } });
  const armed: TriggerRuntimeState = { lastSeenValue: 0, lastFiredAt: null };
  const result = evaluateTrigger(trigger, true, armed, 1000);
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "value_not_numeric");
});

test("high — accepts string-encoded numbers ('120' → 120)", () => {
  // QuestDB / catchall responses sometimes hand back string-form
  // numbers (especially in raw-mode responses).  The coercer
  // accepts those.
  const trigger = makeTrigger({ kind: "high", config: { threshold: 100 } });
  const armed: TriggerRuntimeState = { lastSeenValue: 80, lastFiredAt: null };
  const result = evaluateTrigger(trigger, "120", armed, 5000);
  assert.equal(result.fired, true);
  assert.equal(result.firedValue, 120);
});

test("event — fires on any value change after the first message", () => {
  const trigger = makeTrigger({ kind: "event", config: {} });
  const armed: TriggerRuntimeState = { lastSeenValue: "RUNNING", lastFiredAt: null };
  const result = evaluateTrigger(trigger, "STOPPED", armed, 5000);
  assert.equal(result.fired, true);
  assert.equal(result.firedValue, "STOPPED");
});

test("event — does NOT fire on identical successive values", () => {
  const trigger = makeTrigger({ kind: "event", config: {} });
  const armed: TriggerRuntimeState = { lastSeenValue: "RUNNING", lastFiredAt: 1 };
  const result = evaluateTrigger(trigger, "RUNNING", armed, 5000);
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "no_change");
});

test("event — matchValues filter limits fires to the listed values", () => {
  const trigger = makeTrigger({
    kind: "event",
    config: { matchValues: ["EXITED", "FINISHED"] },
  });
  const armed: TriggerRuntimeState = { lastSeenValue: "RUNNING", lastFiredAt: null };

  const matched = evaluateTrigger(trigger, "EXITED", armed, 5000);
  assert.equal(matched.fired, true);
  assert.equal(matched.firedValue, "EXITED");

  // A change to a non-listed value: state still updates, but no fire.
  const unmatched = evaluateTrigger(trigger, "PAUSED", armed, 5000);
  assert.equal(unmatched.fired, false);
  assert.equal(unmatched.suppressedReason, "not_in_match_values");
  assert.equal(unmatched.nextState.lastSeenValue, "PAUSED");
});

test("cooldown — suppresses fires inside the window", () => {
  const trigger = makeTrigger({
    kind: "high",
    config: { threshold: 100 },
    cooldownMs: 60_000,
  });
  // Previously fired at t=1000; threshold-crossing edge happens
  // at t=20000 (still inside the 60s cooldown).
  const armed: TriggerRuntimeState = { lastSeenValue: 80, lastFiredAt: 1000 };
  const result = evaluateTrigger(trigger, 120, armed, 20_000);
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "cooldown");
  // lastSeenValue still updates so the next edge is detectable.
  assert.equal(result.nextState.lastSeenValue, 120);
  // lastFiredAt is preserved (NOT overwritten by the suppressed call).
  assert.equal(result.nextState.lastFiredAt, 1000);
});

test("cooldown — fires once the window has elapsed", () => {
  const trigger = makeTrigger({
    kind: "high",
    config: { threshold: 100 },
    cooldownMs: 60_000,
  });
  // Need to re-arm BELOW threshold first (otherwise it's a stale
  // edge), then cross up after the cooldown.
  const reArmed: TriggerRuntimeState = { lastSeenValue: 80, lastFiredAt: 1000 };
  const result = evaluateTrigger(trigger, 120, reArmed, 70_000);
  assert.equal(result.fired, true);
  assert.equal(result.firedValue, 120);
  assert.equal(result.nextState.lastFiredAt, 70_000);
});

test("high — null cooldown means no cooldown gate (any edge fires)", () => {
  const trigger = makeTrigger({
    kind: "high",
    config: { threshold: 100 },
    cooldownMs: null,
  });
  const armed: TriggerRuntimeState = { lastSeenValue: 80, lastFiredAt: 1 };
  const result = evaluateTrigger(trigger, 120, armed, 2);
  assert.equal(result.fired, true);
});

// ─── Stage 2 — compare ──────────────────────────────────────────────────────

test("compare — first evaluable comparison arms but does not fire", () => {
  const trigger = makeTrigger({
    kind: "compare",
    sourceTopic: "info/cmp",
    config: { leftTopic: "a/temp", rightTopic: "b/temp", operator: "gt" },
  });
  const cache = makeCache({ "b/temp": { value: 50, receivedAt: 1000 } });
  const result = evaluateTrigger(trigger, 100, FRESH_STATE, 5000, {
    getLastValue: cache,
    incomingTopic: "a/temp",
  });
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "first_value_arms_trigger");
  assert.equal(result.nextState.lastComparisonResult, true);
});

test("compare — fires on rising edge (false → true) when left crosses up", () => {
  const trigger = makeTrigger({
    kind: "compare",
    sourceTopic: "info/cmp",
    config: { leftTopic: "a/temp", rightTopic: "b/temp", operator: "gt" },
  });
  const cache = makeCache({ "b/temp": { value: 50, receivedAt: 1000 } });
  const armed: TriggerRuntimeState = {
    lastSeenValue: 30,
    lastFiredAt: null,
    lastComparisonResult: false,
  };
  const result = evaluateTrigger(trigger, 100, armed, 5000, {
    getLastValue: cache,
    incomingTopic: "a/temp",
  });
  assert.equal(result.fired, true);
  assert.equal(result.firedValue, 100);
  assert.equal(result.nextState.lastComparisonResult, true);
  assert.equal(result.nextState.lastFiredAt, 5000);
});

test("compare — silent on falling edge (true → false)", () => {
  const trigger = makeTrigger({
    kind: "compare",
    sourceTopic: "info/cmp",
    config: { leftTopic: "a/temp", rightTopic: "b/temp", operator: "gt" },
  });
  const cache = makeCache({ "b/temp": { value: 50, receivedAt: 1000 } });
  const wasTrue: TriggerRuntimeState = {
    lastSeenValue: 100,
    lastFiredAt: 1000,
    lastComparisonResult: true,
  };
  const result = evaluateTrigger(trigger, 30, wasTrue, 5000, {
    getLastValue: cache,
    incomingTopic: "a/temp",
  });
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "falling_edge_ignored");
  assert.equal(result.nextState.lastComparisonResult, false);
});

test("compare — message on rightTopic also drives evaluation", () => {
  // a/temp = 100 (cached), b/temp message = 30 → 100 > 30 → true.
  // Previously false → fires.
  const trigger = makeTrigger({
    kind: "compare",
    sourceTopic: "info/cmp",
    config: { leftTopic: "a/temp", rightTopic: "b/temp", operator: "gt" },
  });
  const cache = makeCache({ "a/temp": { value: 100, receivedAt: 1000 } });
  const armed: TriggerRuntimeState = {
    lastSeenValue: 50,
    lastFiredAt: null,
    lastComparisonResult: false,
  };
  const result = evaluateTrigger(trigger, 30, armed, 5000, {
    getLastValue: cache,
    incomingTopic: "b/temp",
  });
  assert.equal(result.fired, true);
  // firedValue is the incoming side that "tipped" the relation.
  assert.equal(result.firedValue, 30);
});

test("compare — peer missing from cache suppresses with peer_value_missing", () => {
  const trigger = makeTrigger({
    kind: "compare",
    sourceTopic: "info/cmp",
    config: { leftTopic: "a/temp", rightTopic: "b/temp", operator: "gt" },
  });
  const cache = makeCache({}); // peer never seen
  const result = evaluateTrigger(trigger, 100, FRESH_STATE, 5000, {
    getLastValue: cache,
    incomingTopic: "a/temp",
  });
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "peer_value_missing");
  // lastSeenValue still updated so debug surfaces show last incoming.
  assert.equal(result.nextState.lastSeenValue, 100);
  // lastComparisonResult NOT set — half-known state must not later
  // be treated as a real prev result for edge detection.
  assert.equal(result.nextState.lastComparisonResult ?? null, null);
});

test("compare — all six operators evaluate correctly", () => {
  const cases: Array<{ op: "gt" | "lt" | "gte" | "lte" | "eq" | "neq"; left: number; right: number; expected: boolean }> = [
    { op: "gt", left: 10, right: 5, expected: true },
    { op: "gt", left: 5, right: 10, expected: false },
    { op: "lt", left: 5, right: 10, expected: true },
    { op: "gte", left: 5, right: 5, expected: true },
    { op: "lte", left: 5, right: 5, expected: true },
    { op: "eq", left: 5, right: 5, expected: true },
    { op: "eq", left: 5, right: 6, expected: false },
    { op: "neq", left: 5, right: 6, expected: true },
    { op: "neq", left: 5, right: 5, expected: false },
  ];
  for (const c of cases) {
    const trigger = makeTrigger({
      kind: "compare",
      sourceTopic: "info/cmp",
      config: { leftTopic: "a", rightTopic: "b", operator: c.op },
    });
    const cache = makeCache({ b: { value: c.right, receivedAt: 1000 } });
    // Pre-arm with prev=false so an `expected===true` outcome fires.
    const armed: TriggerRuntimeState = {
      lastSeenValue: 0,
      lastFiredAt: null,
      lastComparisonResult: false,
    };
    const result = evaluateTrigger(trigger, c.left, armed, 5000, {
      getLastValue: cache,
      incomingTopic: "a",
    });
    assert.equal(result.fired, c.expected, `operator=${c.op} left=${c.left} right=${c.right}`);
  }
});

test("compare — cooldown enforced after a real fire", () => {
  const trigger = makeTrigger({
    kind: "compare",
    sourceTopic: "info/cmp",
    config: { leftTopic: "a", rightTopic: "b", operator: "gt" },
    cooldownMs: 60_000,
  });
  const cache = makeCache({ b: { value: 50, receivedAt: 1000 } });
  // Simulate: previously fired at t=1000 (currently true), then
  // relation falls (right side rises in cache → comparison flips to
  // false), then incoming pushes it back to true at t=20_000 (within
  // 60s window).
  const cacheStaleHigh = makeCache({ b: { value: 200, receivedAt: 1000 } });
  const wasTrue: TriggerRuntimeState = {
    lastSeenValue: 100,
    lastFiredAt: 1000,
    lastComparisonResult: true,
  };
  // First, falling edge silently arms.
  const fall = evaluateTrigger(trigger, 30, wasTrue, 10_000, {
    getLastValue: cacheStaleHigh,
    incomingTopic: "a",
  });
  assert.equal(fall.fired, false);
  // Now rising edge inside cooldown window.
  const rise = evaluateTrigger(trigger, 100, fall.nextState, 20_000, {
    getLastValue: cache,
    incomingTopic: "a",
  });
  assert.equal(rise.fired, false);
  assert.equal(rise.suppressedReason, "cooldown");
});

// ─── Stage 2 — string (correlated reads) ────────────────────────────────────

test("string — fires with snapshots when source matches and snapshots are fresh", () => {
  const trigger = makeTrigger({
    kind: "string",
    sourceTopic: "slab/location",
    config: {
      matchValues: ["EXITED"],
      snapshotTopics: ["zone-1/temp", "zone-1/pressure"],
      staleAfterMs: 60_000,
    },
  });
  const cache = makeCache({
    "zone-1/temp": { value: 1100, uom: "°C", time: "t-temp", receivedAt: 4_500 },
    "zone-1/pressure": { value: 5, uom: "bar", time: "t-pres", receivedAt: 4_800 },
  });
  const armed: TriggerRuntimeState = { lastSeenValue: "RUNNING", lastFiredAt: null };
  const result = evaluateTrigger(trigger, "EXITED", armed, 5000, {
    getLastValue: cache,
    incomingTopic: "slab/location",
  });
  assert.equal(result.fired, true);
  assert.equal(result.firedValue, "EXITED");
  assert.equal(result.snapshots?.length, 2);
  assert.equal(result.snapshots?.[0]?.topic, "zone-1/temp");
  assert.equal(result.snapshots?.[0]?.value, 1100);
  assert.equal(result.snapshots?.[0]?.ageMs, 500);
  assert.equal(result.snapshots?.[1]?.topic, "zone-1/pressure");
  assert.equal(result.snapshots?.[1]?.ageMs, 200);
});

test("string — suppresses with stale_snapshot when ANY snapshot is too old", () => {
  const trigger = makeTrigger({
    kind: "string",
    sourceTopic: "slab/location",
    config: {
      snapshotTopics: ["zone-1/temp", "zone-1/pressure"],
      staleAfterMs: 1000,
    },
  });
  const cache = makeCache({
    "zone-1/temp": { value: 1100, receivedAt: 4_500 },     // age 500 — fresh
    "zone-1/pressure": { value: 5, receivedAt: 1_000 },     // age 4000 — STALE
  });
  const armed: TriggerRuntimeState = { lastSeenValue: "RUNNING", lastFiredAt: null };
  const result = evaluateTrigger(trigger, "EXITED", armed, 5000, {
    getLastValue: cache,
    incomingTopic: "slab/location",
  });
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "stale_snapshot");
  // lastSeenValue still updates so the next fresh edge can fire.
  assert.equal(result.nextState.lastSeenValue, "EXITED");
});

test("string — suppresses with stale_snapshot when a snapshot topic is missing", () => {
  const trigger = makeTrigger({
    kind: "string",
    sourceTopic: "slab/location",
    config: {
      snapshotTopics: ["zone-1/temp", "zone-1/pressure"],
      staleAfterMs: 60_000,
    },
  });
  // Only one of the two topics has a cached entry.
  const cache = makeCache({ "zone-1/temp": { value: 1100, receivedAt: 4_500 } });
  const armed: TriggerRuntimeState = { lastSeenValue: "RUNNING", lastFiredAt: null };
  const result = evaluateTrigger(trigger, "EXITED", armed, 5000, {
    getLastValue: cache,
    incomingTopic: "slab/location",
  });
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "stale_snapshot");
});

test("string — matchValues whitelist still gates the source side", () => {
  const trigger = makeTrigger({
    kind: "string",
    sourceTopic: "slab/location",
    config: {
      matchValues: ["EXITED"],
      snapshotTopics: ["zone-1/temp"],
      staleAfterMs: 60_000,
    },
  });
  const cache = makeCache({ "zone-1/temp": { value: 1100, receivedAt: 4_900 } });
  const armed: TriggerRuntimeState = { lastSeenValue: "RUNNING", lastFiredAt: null };
  // PAUSED isn't in matchValues → no fire even though snapshots are fresh.
  const result = evaluateTrigger(trigger, "PAUSED", armed, 5000, {
    getLastValue: cache,
    incomingTopic: "slab/location",
  });
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "not_in_match_values");
});

// ─── Stage 5 — composite (AND/OR over N per-topic conditions) ───────────────

const COMPOSITE_AND_TRIGGER: TriggerDefinition = {
  id: "composite-1",
  name: "All zones high",
  kind: "composite",
  sourceTopic: "info/composite",
  outputTopic: "alarms/composite/all-zones-high",
  config: {
    operator: "and",
    conditions: [
      { topic: "zone-1/temp", predicate: "gt", value: 1100 },
      { topic: "zone-2/temp", predicate: "gt", value: 1100 },
    ],
  },
  cooldownMs: null,
  enabled: true,
  description: null,
  createdBy: null,
  createdAt: "2026-04-29T19:00:00.000Z",
  updatedAt: "2026-04-29T19:00:00.000Z",
};

test("composite AND — fires when ALL conditions are satisfied (rising edge)", () => {
  const cache = makeCache({
    "zone-1/temp": { value: 1500, receivedAt: 4_500 },
    "zone-2/temp": { value: 1300, receivedAt: 4_700 },
  });
  // Previously false (treat-as-false default for fresh state).
  const result = evaluateTrigger(COMPOSITE_AND_TRIGGER, null, FRESH_STATE, 5000, {
    getLastValue: cache,
    incomingTopic: "zone-1/temp",
  });
  assert.equal(result.fired, true);
  assert.equal(result.nextState.lastCompositeResult, true);
  assert.equal(result.nextState.lastFiredAt, 5000);
});

test("composite AND — does NOT fire when any condition is false (treat-missing-as-false)", () => {
  const cache = makeCache({
    "zone-1/temp": { value: 1500, receivedAt: 4_500 },
    // zone-2 missing entirely
  });
  const result = evaluateTrigger(COMPOSITE_AND_TRIGGER, null, FRESH_STATE, 5000, {
    getLastValue: cache,
    incomingTopic: "zone-1/temp",
  });
  assert.equal(result.fired, false);
  // false === false (prev default) → composite_false
  assert.equal(result.suppressedReason, "composite_false");
  assert.equal(result.nextState.lastCompositeResult, false);
});

test("composite AND — falling edge is silent", () => {
  const cache = makeCache({
    "zone-1/temp": { value: 800, receivedAt: 5_000 }, // dropped
    "zone-2/temp": { value: 1300, receivedAt: 4_700 },
  });
  const wasTrue: TriggerRuntimeState = {
    lastSeenValue: null,
    lastFiredAt: 1000,
    lastCompositeResult: true,
  };
  const result = evaluateTrigger(COMPOSITE_AND_TRIGGER, null, wasTrue, 5000, {
    getLastValue: cache,
    incomingTopic: "zone-1/temp",
  });
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "falling_edge_ignored");
  assert.equal(result.nextState.lastCompositeResult, false);
});

test("composite OR — fires when ANY condition is satisfied", () => {
  const trigger: TriggerDefinition = {
    ...COMPOSITE_AND_TRIGGER,
    config: { operator: "or", conditions: COMPOSITE_AND_TRIGGER.config["conditions"] as never },
  };
  const cache = makeCache({
    "zone-1/temp": { value: 1500, receivedAt: 4_500 }, // satisfied
    // zone-2 missing — would normally be false in AND
  });
  const result = evaluateTrigger(trigger, null, FRESH_STATE, 5000, {
    getLastValue: cache,
    incomingTopic: "zone-1/temp",
  });
  assert.equal(result.fired, true);
  assert.equal(result.firedValue, 1500);
});

test("composite — string-equality predicate works with eq/neq", () => {
  const trigger: TriggerDefinition = {
    ...COMPOSITE_AND_TRIGGER,
    config: {
      operator: "or",
      conditions: [
        { topic: "slab/state", predicate: "eq", value: "ABORTED" },
        { topic: "slab/state", predicate: "eq", value: "ERROR" },
      ],
    },
  };
  const cache = makeCache({
    "slab/state": { value: "ERROR", receivedAt: 4_900 },
  });
  const result = evaluateTrigger(trigger, null, FRESH_STATE, 5000, {
    getLastValue: cache,
    incomingTopic: "slab/state",
  });
  assert.equal(result.fired, true);
  assert.equal(result.firedValue, "ERROR");
});

test("composite — no_edge when result hasn't changed", () => {
  const cache = makeCache({
    "zone-1/temp": { value: 1500, receivedAt: 4_500 },
    "zone-2/temp": { value: 1300, receivedAt: 4_700 },
  });
  const wasTrue: TriggerRuntimeState = {
    lastSeenValue: null,
    lastFiredAt: 1000,
    lastCompositeResult: true,
  };
  const result = evaluateTrigger(COMPOSITE_AND_TRIGGER, null, wasTrue, 5000, {
    getLastValue: cache,
    incomingTopic: "zone-1/temp",
  });
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "no_edge");
});

test("composite — cooldown gate blocks fires inside the window", () => {
  const trigger: TriggerDefinition = {
    ...COMPOSITE_AND_TRIGGER,
    cooldownMs: 60_000,
  };
  const cache = makeCache({
    "zone-1/temp": { value: 1500, receivedAt: 4_500 },
    "zone-2/temp": { value: 1300, receivedAt: 4_700 },
  });
  // Previously fired at t=1000; previously fell back to false; now
  // back to true at t=20000 (still inside the 60s window).
  const wasFalse: TriggerRuntimeState = {
    lastSeenValue: null,
    lastFiredAt: 1000,
    lastCompositeResult: false,
  };
  const result = evaluateTrigger(trigger, null, wasFalse, 20_000, {
    getLastValue: cache,
    incomingTopic: "zone-1/temp",
  });
  assert.equal(result.fired, false);
  assert.equal(result.suppressedReason, "cooldown");
});
