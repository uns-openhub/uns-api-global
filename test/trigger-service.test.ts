import test from "node:test";
import assert from "node:assert/strict";

import { TriggerPublisher } from "../src/triggers/publisher.js";
import { TriggerRegistry } from "../src/triggers/registry.js";
import { TriggerService } from "../src/triggers/service.js";
import type { TriggerFireEvent } from "../src/triggers/service.js";
import type { TriggerDefinition } from "../src/triggers/types.js";

// End-to-end registry + service + publisher integration: a trigger
// flows from the (faked) controller response, lands in the registry,
// gets picked up by the service on a matching MQTT message, and
// fires the publisher with the right payload.  No MQTT or HTTP —
// the registry's fetch is fake-mocked, the publisher's transport is
// a spy.

function fakeFetch(triggers: TriggerDefinition[]) {
  return async (url: string | URL): Promise<Response> => {
    if (typeof url === "string" && url.endsWith("/triggers")) {
      const body = JSON.stringify({
        triggers: triggers.map((t) => ({
          ...t,
          // The controller's REST endpoint returns config as a
          // parsed object — match that shape exactly.
          config: t.config,
        })),
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  };
}

function makeServices(
  triggers: TriggerDefinition[],
  options: {
    cache?: Record<string, { value: unknown; uom?: string | null; time?: string; receivedAt?: number }>;
    now?: number;
    fireEvents?: TriggerFireEvent[];
  } = {},
) {
  const fixedNow = options.now ?? 5_000;
  const publishCalls: Array<{ outputTopic: string; payload: string }> = [];
  const publisher = new TriggerPublisher({
    publish: ({ outputTopic, payload }) => {
      publishCalls.push({ outputTopic, payload });
    },
    now: () => fixedNow,
  });
  const registry = new TriggerRegistry({
    controllerRestUrl: "http://localhost:3200/api",
    getAccessToken: async () => "fake-jwt",
    refreshIntervalMs: 60_000,
    fetchImpl: fakeFetch(triggers) as unknown as typeof fetch,
  });
  const cache = options.cache ?? {};
  const getLastValue = (topic: string) => {
    const e = cache[topic];
    if (!e) return null;
    return {
      value: e.value,
      uom: e.uom ?? null,
      time: e.time ?? "2026-04-26T10:00:00.000Z",
      receivedAt: e.receivedAt ?? 0,
    };
  };
  const service = new TriggerService({
    registry,
    publisher,
    now: () => fixedNow,
    getLastValue,
    onFire: (event) => {
      options.fireEvents?.push(event);
    },
  });
  return { registry, publisher, service, publishCalls };
}

async function flushPublisherQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const HIGH_TRIGGER: TriggerDefinition = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Furnace high",
  kind: "high",
  sourceTopic: "enterprise/site/area/heat-treatment-line/equipment/zone-1/temperature",
  outputTopic: "enterprise/site/area/alarms/furnace/zone-1-high",
  config: { threshold: 1100 },
  cooldownMs: null,
  enabled: true,
  description: null,
  createdBy: null,
  createdAt: "2026-04-26T10:00:00.000Z",
  updatedAt: "2026-04-26T10:00:00.000Z",
};

test("service start() pulls registry from controller and indexes by source topic", async () => {
  const { service, registry } = makeServices([HIGH_TRIGGER]);
  await service.start();
  assert.equal(registry.size(), 1);
  const matched = registry.getTriggersForTopic(HIGH_TRIGGER.sourceTopic);
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.id, HIGH_TRIGGER.id);
  service.stop();
});

test("onMessage: skips topics with no triggers (hot-path no-op)", async () => {
  const { service, publishCalls } = makeServices([HIGH_TRIGGER]);
  await service.start();
  service.onMessage({
    topic: "some/unrelated/topic",
    value: 99999,
    uom: null,
    sourceTimestamp: "2026-04-26T10:00:00.000Z",
  });
  assert.equal(publishCalls.length, 0);
  service.stop();
});

test("onMessage: arms on first value, fires when crossing the threshold UP", async () => {
  const { service, publishCalls } = makeServices([HIGH_TRIGGER]);
  await service.start();

  // First message arms — no fire.
  service.onMessage({
    topic: HIGH_TRIGGER.sourceTopic,
    value: 800,
    uom: "°C",
    sourceTimestamp: "2026-04-26T10:00:00.000Z",
  });
  assert.equal(publishCalls.length, 0);

  // Second message crosses up — fires.
  service.onMessage({
    topic: HIGH_TRIGGER.sourceTopic,
    value: 1200,
    uom: "°C",
    sourceTimestamp: "2026-04-26T10:00:01.000Z",
  });
  await flushPublisherQueue();
  assert.equal(publishCalls.length, 1);
  const call = publishCalls[0]!;
  assert.equal(call.outputTopic, HIGH_TRIGGER.outputTopic);
  const parsed = JSON.parse(call.payload);
  assert.equal(parsed.version, "2.0.0");
  assert.equal(parsed.message.data.value, 1200);
  assert.equal(parsed.message.data.valueType, "number");
  assert.equal(parsed.message.data.uom, "°C");
  assert.equal(parsed.message.data.dataGroup, "trigger");
  assert.equal(parsed.message.data.foreignEventKey, HIGH_TRIGGER.id);
  service.stop();
});

test("onFire callback is emitted only for a real trigger fire", async () => {
  const fireEvents: TriggerFireEvent[] = [];
  const { service, publishCalls } = makeServices([HIGH_TRIGGER], { fireEvents, now: 12_345 });
  await service.start();

  service.onMessage({
    topic: HIGH_TRIGGER.sourceTopic,
    value: 800,
    uom: "°C",
    sourceTimestamp: "t1",
  });
  service.onMessage({
    topic: HIGH_TRIGGER.sourceTopic,
    value: 900,
    uom: "°C",
    sourceTimestamp: "t2",
  });
  assert.equal(fireEvents.length, 0);

  service.onMessage({
    topic: HIGH_TRIGGER.sourceTopic,
    value: 1200,
    uom: "°C",
    sourceTimestamp: "t3",
  });
  await flushPublisherQueue();

  assert.equal(publishCalls.length, 1);
  assert.equal(fireEvents.length, 1);
  assert.equal(fireEvents[0]!.trigger.id, HIGH_TRIGGER.id);
  assert.equal(fireEvents[0]!.value, 1200);
  assert.equal(fireEvents[0]!.uom, "°C");
  assert.equal(fireEvents[0]!.sourceTimestamp, "t3");
  assert.equal(fireEvents[0]!.firedAtMs, 12_345);
  service.stop();
});

test("onMessage: state survives across messages (no double-fire on stay-above)", async () => {
  const { service, publishCalls } = makeServices([HIGH_TRIGGER]);
  await service.start();

  service.onMessage({
    topic: HIGH_TRIGGER.sourceTopic,
    value: 800,
    uom: "°C",
    sourceTimestamp: "t1",
  });
  service.onMessage({
    topic: HIGH_TRIGGER.sourceTopic,
    value: 1200,
    uom: "°C",
    sourceTimestamp: "t2",
  });
  // Stays above threshold — no fresh edge.
  service.onMessage({
    topic: HIGH_TRIGGER.sourceTopic,
    value: 1300,
    uom: "°C",
    sourceTimestamp: "t3",
  });
  await flushPublisherQueue();
  assert.equal(publishCalls.length, 1);
  service.stop();
});

test("multiple triggers on the same source topic both evaluate", async () => {
  const LOW_TRIGGER: TriggerDefinition = {
    ...HIGH_TRIGGER,
    id: "22222222-2222-2222-2222-222222222222",
    name: "Furnace low",
    kind: "low",
    config: { threshold: 600 },
    outputTopic: "enterprise/site/area/alarms/furnace/zone-1-low",
  };
  const { service, publishCalls } = makeServices([HIGH_TRIGGER, LOW_TRIGGER]);
  await service.start();

  // Arm both with a mid-range first value.
  service.onMessage({
    topic: HIGH_TRIGGER.sourceTopic,
    value: 800,
    uom: "°C",
    sourceTimestamp: "t1",
  });
  // Cross up through HIGH's threshold — fires HIGH only.
  service.onMessage({
    topic: HIGH_TRIGGER.sourceTopic,
    value: 1200,
    uom: "°C",
    sourceTimestamp: "t2",
  });
  // Cross down through LOW's threshold — fires LOW only.
  service.onMessage({
    topic: HIGH_TRIGGER.sourceTopic,
    value: 500,
    uom: "°C",
    sourceTimestamp: "t3",
  });
  await flushPublisherQueue();
  assert.equal(publishCalls.length, 2);
  const fired = publishCalls.map((c) => c.outputTopic).sort();
  assert.deepEqual(fired, [
    "enterprise/site/area/alarms/furnace/zone-1-high",
    "enterprise/site/area/alarms/furnace/zone-1-low",
  ]);
  service.stop();
});

test("event trigger with matchValues fires only on listed strings", async () => {
  const EVENT_TRIGGER: TriggerDefinition = {
    ...HIGH_TRIGGER,
    id: "33333333-3333-3333-3333-333333333333",
    name: "Slab exited",
    kind: "event",
    config: { matchValues: ["EXITED", "FINISHED"] },
    sourceTopic: "enterprise/site/area/heat-treatment-line/material/slab-001/location",
    outputTopic: "enterprise/site/area/journal/slab-001/exit",
  };
  const { service, publishCalls } = makeServices([EVENT_TRIGGER]);
  await service.start();

  service.onMessage({
    topic: EVENT_TRIGGER.sourceTopic,
    value: "ENTERED",
    uom: null,
    sourceTimestamp: "t1",
  });
  service.onMessage({
    topic: EVENT_TRIGGER.sourceTopic,
    value: "PAUSED",
    uom: null,
    sourceTimestamp: "t2",
  });
  // PAUSED isn't in matchValues — no fire even though value changed.
  assert.equal(publishCalls.length, 0);

  service.onMessage({
    topic: EVENT_TRIGGER.sourceTopic,
    value: "EXITED",
    uom: null,
    sourceTimestamp: "t3",
  });
  await flushPublisherQueue();
  assert.equal(publishCalls.length, 1);
  const parsed = JSON.parse(publishCalls[0]!.payload);
  assert.equal(parsed.version, "2.0.0");
  assert.equal(parsed.message.data.value, "EXITED");
  assert.equal(parsed.message.data.valueType, "string");
  assert.equal(parsed.message.data.dataGroup, "trigger");
  assert.equal(parsed.message.data.foreignEventKey, EVENT_TRIGGER.id);
  service.stop();
});

test("cooldown is enforced end-to-end (re-armed edge inside window does not fire)", async () => {
  const COOLDOWN_TRIGGER: TriggerDefinition = {
    ...HIGH_TRIGGER,
    cooldownMs: 60_000,
  };
  const publishCalls: Array<{ outputTopic: string; payload: string }> = [];
  let now = 1_000;
  const publisher = new TriggerPublisher({
    publish: ({ outputTopic, payload }) => {
      publishCalls.push({ outputTopic, payload });
    },
    now: () => now,
  });
  const registry = new TriggerRegistry({
    controllerRestUrl: "http://localhost:3200/api",
    getAccessToken: async () => "fake-jwt",
    refreshIntervalMs: 60_000,
    fetchImpl: fakeFetch([COOLDOWN_TRIGGER]) as unknown as typeof fetch,
  });
  const service = new TriggerService({
    registry,
    publisher,
    now: () => now,
  });
  await service.start();

  // Arm + fire once.
  service.onMessage({
    topic: COOLDOWN_TRIGGER.sourceTopic,
    value: 800,
    uom: "°C",
    sourceTimestamp: "t1",
  });
  now = 2_000;
  service.onMessage({
    topic: COOLDOWN_TRIGGER.sourceTopic,
    value: 1200,
    uom: "°C",
    sourceTimestamp: "t2",
  });
  await flushPublisherQueue();
  assert.equal(publishCalls.length, 1);

  // Re-arm BELOW + cross UP again, but inside the 60s window.
  now = 30_000; // 28s after the first fire — inside cooldown
  service.onMessage({
    topic: COOLDOWN_TRIGGER.sourceTopic,
    value: 800,
    uom: "°C",
    sourceTimestamp: "t3",
  });
  service.onMessage({
    topic: COOLDOWN_TRIGGER.sourceTopic,
    value: 1300,
    uom: "°C",
    sourceTimestamp: "t4",
  });
  assert.equal(publishCalls.length, 1, "should be cooled down");

  // Same edge, but now after the cooldown window.
  now = 100_000; // 98s after the first fire — outside cooldown
  service.onMessage({
    topic: COOLDOWN_TRIGGER.sourceTopic,
    value: 800,
    uom: "°C",
    sourceTimestamp: "t5",
  });
  service.onMessage({
    topic: COOLDOWN_TRIGGER.sourceTopic,
    value: 1400,
    uom: "°C",
    sourceTimestamp: "t6",
  });
  await flushPublisherQueue();
  assert.equal(publishCalls.length, 2);
  service.stop();
});

// ─── Stage 2 — compare end-to-end ───────────────────────────────────────────

test("compare: registry indexes BOTH leftTopic and rightTopic, fires on rising edge", async () => {
  const COMPARE_TRIGGER: TriggerDefinition = {
    id: "44444444-4444-4444-4444-444444444444",
    name: "Furnace zone-1 hotter than zone-2",
    kind: "compare",
    sourceTopic: "info/compare-z1-z2", // informational only for compare
    outputTopic: "enterprise/site/area/alarms/zone1-gt-zone2",
    config: {
      leftTopic: "enterprise/.../zone-1/temperature",
      rightTopic: "enterprise/.../zone-2/temperature",
      operator: "gt",
    },
    cooldownMs: null,
    enabled: true,
    description: null,
    createdBy: null,
    createdAt: "2026-04-27T10:00:00.000Z",
    updatedAt: "2026-04-27T10:00:00.000Z",
  };
  const { service, registry, publishCalls } = makeServices([COMPARE_TRIGGER], {
    cache: { "enterprise/.../zone-2/temperature": { value: 800, receivedAt: 4_500 } },
  });
  await service.start();

  // Both operand topics are indexed (sourceTopic is informational
  // only for compare and intentionally NOT indexed).
  assert.equal(registry.getTriggersForTopic("enterprise/.../zone-1/temperature").length, 1);
  assert.equal(registry.getTriggersForTopic("enterprise/.../zone-2/temperature").length, 1);
  assert.equal(registry.getTriggersForTopic("info/compare-z1-z2").length, 0);

  // First message on left: arms (no fire) — comparison is true but
  // this is the first evaluable result.
  service.onMessage({
    topic: "enterprise/.../zone-1/temperature",
    value: 1000,
    uom: "°C",
    sourceTimestamp: "t1",
  });
  assert.equal(publishCalls.length, 0);
  // Falling edge: left drops below right.  Silent.
  service.onMessage({
    topic: "enterprise/.../zone-1/temperature",
    value: 700,
    uom: "°C",
    sourceTimestamp: "t2",
  });
  assert.equal(publishCalls.length, 0);
  // Rising edge: left back above right.  FIRES.
  service.onMessage({
    topic: "enterprise/.../zone-1/temperature",
    value: 1100,
    uom: "°C",
    sourceTimestamp: "t3",
  });
  await flushPublisherQueue();
  assert.equal(publishCalls.length, 1);
  const parsed = JSON.parse(publishCalls[0]!.payload);
  assert.equal(parsed.version, "2.0.0");
  assert.equal(parsed.message.data.value, 1100);
  assert.equal(parsed.message.data.valueType, "number");
  assert.equal(parsed.message.data.foreignEventKey, COMPARE_TRIGGER.id);
  service.stop();
});

// ─── Stage 2 — string end-to-end ────────────────────────────────────────────

test("string: fires with standard UNS packet when snapshots are fresh", async () => {
  const STRING_TRIGGER: TriggerDefinition = {
    id: "55555555-5555-5555-5555-555555555555",
    name: "Slab exit snapshot",
    kind: "string",
    sourceTopic: "enterprise/.../material/slab-001/location",
    outputTopic: "enterprise/.../journal/slab-001/exit",
    config: {
      matchValues: ["EXITED"],
      snapshotTopics: ["enterprise/.../zone-1/temperature", "enterprise/.../zone-1/pressure"],
      staleAfterMs: 60_000,
    },
    cooldownMs: null,
    enabled: true,
    description: null,
    createdBy: null,
    createdAt: "2026-04-27T10:00:00.000Z",
    updatedAt: "2026-04-27T10:00:00.000Z",
  };
  const { service, publishCalls } = makeServices([STRING_TRIGGER], {
    cache: {
      "enterprise/.../zone-1/temperature": { value: 1100, uom: "°C", time: "ts-t", receivedAt: 4_500 },
      "enterprise/.../zone-1/pressure": { value: 5, uom: "bar", time: "ts-p", receivedAt: 4_700 },
    },
  });
  await service.start();

  // First message on source topic arms (no fire).
  service.onMessage({
    topic: STRING_TRIGGER.sourceTopic,
    value: "RUNNING",
    uom: null,
    sourceTimestamp: "t1",
  });
  assert.equal(publishCalls.length, 0);

  // Source value transitions to a matched value — fires.
  service.onMessage({
    topic: STRING_TRIGGER.sourceTopic,
    value: "EXITED",
    uom: null,
    sourceTimestamp: "t2",
  });
  await flushPublisherQueue();
  assert.equal(publishCalls.length, 1);
  const parsed = JSON.parse(publishCalls[0]!.payload);
  assert.equal(parsed.version, "2.0.0");
  assert.equal(parsed.message.data.value, "EXITED");
  assert.equal(parsed.message.data.valueType, "string");
  assert.equal(parsed.message.data.dataGroup, "trigger");
  assert.equal(parsed.message.data.foreignEventKey, STRING_TRIGGER.id);
  service.stop();
});

test("string: suppresses fire when a snapshot is stale (no half-snapshot)", async () => {
  const STRING_TRIGGER: TriggerDefinition = {
    id: "66666666-6666-6666-6666-666666666666",
    name: "Slab exit snapshot strict",
    kind: "string",
    sourceTopic: "enterprise/.../slab-002/location",
    outputTopic: "enterprise/.../journal/slab-002/exit",
    config: {
      matchValues: ["EXITED"],
      snapshotTopics: ["zone-1/temp", "zone-1/pressure"],
      staleAfterMs: 1000, // very tight
    },
    cooldownMs: null,
    enabled: true,
    description: null,
    createdBy: null,
    createdAt: "2026-04-27T10:00:00.000Z",
    updatedAt: "2026-04-27T10:00:00.000Z",
  };
  const { service, publishCalls } = makeServices([STRING_TRIGGER], {
    cache: {
      "zone-1/temp": { value: 1100, receivedAt: 4_500 },     // age 500 (fresh)
      "zone-1/pressure": { value: 5, receivedAt: 1_000 },     // age 4000 (stale)
    },
  });
  await service.start();

  service.onMessage({
    topic: STRING_TRIGGER.sourceTopic,
    value: "RUNNING",
    uom: null,
    sourceTimestamp: "t1",
  });
  service.onMessage({
    topic: STRING_TRIGGER.sourceTopic,
    value: "EXITED",
    uom: null,
    sourceTimestamp: "t2",
  });
  assert.equal(publishCalls.length, 0, "stale snapshot must suppress the fire");
  service.stop();
});

// ─── Stage 4b — runtime inspection (getRuntimeStates) ───────────────────────

const RUNTIME_TRIGGER: TriggerDefinition = {
  id: "rt-trigger-1",
  name: "Runtime view",
  kind: "high",
  sourceTopic: "rt/source",
  outputTopic: "rt/output",
  config: { threshold: 100 },
  cooldownMs: null,
  enabled: true,
  description: null,
  createdBy: null,
  createdAt: "2026-04-29T10:00:00.000Z",
  updatedAt: "2026-04-29T10:00:00.000Z",
};

test("getRuntimeStates: lists registered triggers even before any evaluation (Awaiting state)", async () => {
  const { service } = makeServices([RUNTIME_TRIGGER]);
  await service.start();
  const views = service.getRuntimeStates();
  assert.equal(views.length, 1);
  const v = views[0]!;
  assert.equal(v.triggerId, "rt-trigger-1");
  assert.equal(v.isArmed, false, "no message yet — should be Awaiting");
  assert.equal(v.state.lastSeenValue, null);
  assert.equal(v.metrics.fireCount, 0);
  assert.equal(v.metrics.suppressionCount, 0);
  assert.equal(v.metrics.lastEvaluatedAt, null);
  assert.equal(v.metrics.lastSuppressedReason, null);
  service.stop();
});

test("getRuntimeStates: tracks fireCount + suppressionCount + lastSuppressedReason across messages", async () => {
  const { service } = makeServices([RUNTIME_TRIGGER]);
  await service.start();
  // First message arms (suppressed: first_value_arms_trigger).
  service.onMessage({
    topic: "rt/source",
    value: 50,
    uom: null,
    sourceTimestamp: "t1",
  });
  // Second message crosses up — fires.
  service.onMessage({
    topic: "rt/source",
    value: 200,
    uom: null,
    sourceTimestamp: "t2",
  });
  // Third stays above — suppressed: no_edge.
  service.onMessage({
    topic: "rt/source",
    value: 250,
    uom: null,
    sourceTimestamp: "t3",
  });
  const v = service.getRuntimeStates()[0]!;
  assert.equal(v.isArmed, true);
  assert.equal(v.state.lastSeenValue, 250);
  assert.equal(v.state.lastFiredAt, 5_000);
  assert.equal(v.metrics.fireCount, 1);
  assert.equal(v.metrics.suppressionCount, 2);
  // Real fire wipes the lastSuppressedReason (the most-recent
  // outcome was a fire, not a suppression).  Then no_edge replaces
  // it on message 3.
  assert.equal(v.metrics.lastSuppressedReason, "no_edge");
  assert.equal(v.metrics.lastEvaluatedAt, 5_000);
  service.stop();
});

test("getRuntimeStates: isArmed flips true for composite kind even though lastSeenValue stays null", async () => {
  // Composite tracks lastCompositeResult, never lastSeenValue.
  // The naïve `state.lastSeenValue !== null` check would leave
  // every composite trigger permanently Awaiting in the UI even
  // after firing.  We derive isArmed from metrics.lastEvaluatedAt
  // instead — set on every evaluator call regardless of kind.
  const COMPOSITE_TRIGGER: TriggerDefinition = {
    id: "rt-composite-1",
    name: "AND of two zones",
    kind: "composite",
    sourceTopic: "info/composite",
    outputTopic: "out/composite",
    config: {
      operator: "and",
      conditions: [
        { topic: "rt/a", predicate: "gt", value: 50 },
        { topic: "rt/b", predicate: "gt", value: 50 },
      ],
    },
    cooldownMs: null,
    enabled: true,
    description: null,
    createdBy: null,
    createdAt: "2026-04-29T20:00:00.000Z",
    updatedAt: "2026-04-29T20:00:00.000Z",
  };
  const { service } = makeServices([COMPOSITE_TRIGGER], {
    cache: {
      "rt/a": { value: 100, receivedAt: 1_000 },
      "rt/b": { value: 100, receivedAt: 1_000 },
    },
  });
  await service.start();
  // Trigger an evaluation (any topic in the inverted index works).
  service.onMessage({ topic: "rt/a", value: 100, uom: null, sourceTimestamp: "t1" });
  const v = service.getRuntimeStates()[0]!;
  assert.equal(v.isArmed, true, "composite should be Armed after the first evaluation");
  assert.equal(v.state.lastSeenValue, null, "composite never updates lastSeenValue");
  assert.equal(v.metrics.lastEvaluatedAt, 5_000);
});

test("getRuntimeStates: clears lastSuppressedReason when the most recent outcome is a fire", async () => {
  const { service } = makeServices([RUNTIME_TRIGGER]);
  await service.start();
  // Suppress (first_value_arms_trigger).
  service.onMessage({ topic: "rt/source", value: 50, uom: null, sourceTimestamp: "t1" });
  // Fire.
  service.onMessage({ topic: "rt/source", value: 200, uom: null, sourceTimestamp: "t2" });
  const v = service.getRuntimeStates()[0]!;
  assert.equal(v.metrics.fireCount, 1);
  assert.equal(v.metrics.lastSuppressedReason, null, "fire wipes the last reason");
  service.stop();
});
