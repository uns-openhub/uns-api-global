import assert from "node:assert/strict";
import test from "node:test";
import { planEntityHistoryBindings } from "../src/entity-query-planner.js";

const stableEntityId = "11111111-1111-4111-8111-111111111111";

test("plans one continuous entity attribute across old and new topic intervals", async () => {
  const reader = {
    listIntervals: async () => ({
      source: "controller" as const,
      intervals: [
        {
          topic: "site/line-a/press-14/equipment/main/temperature",
          stableEntityId,
          entityTypeKey: "openhub.asset",
          bindingKind: "attribute-topic" as const,
          validFrom: "2026-09-01T08:00:00.000Z",
          validTo: "2026-09-01T10:00:00.000Z",
          timeBasis: "source-event-time",
          sourceCount: 1,
          revision: "7",
          digest: `sha256:${"1".repeat(64)}`,
        },
        {
          topic: "site/line-b/press-14/equipment/main/temperature",
          stableEntityId,
          entityTypeKey: "openhub.asset",
          bindingKind: "attribute-topic" as const,
          validFrom: "2026-09-01T10:00:00.000Z",
          validTo: null,
          timeBasis: "source-event-time",
          sourceCount: 1,
          revision: "8",
          digest: `sha256:${"2".repeat(64)}`,
        },
      ],
    }),
  };
  const plan = await planEntityHistoryBindings(
    reader,
    [{ stableEntityId, attributePath: "equipment/main/temperature" }],
    { from: "2026-09-01T09:00:00Z", to: "2026-09-01T11:00:00Z" },
  );
  assert.equal(plan.selectors[0]?.status, "resolved");
  assert.deepEqual(plan.selectors[0]?.intervals.map((interval) => ({
    topic: interval.topic,
    from: interval.from,
    to: interval.to,
  })), [
    {
      topic: "site/line-a/press-14/equipment/main/temperature",
      from: "2026-09-01T09:00:00.000Z",
      to: "2026-09-01T10:00:00.000Z",
    },
    {
      topic: "site/line-b/press-14/equipment/main/temperature",
      from: "2026-09-01T10:00:00.000Z",
      to: "2026-09-01T11:00:00.000Z",
    },
  ]);
});

test("groups selectors by stable ID and keeps unmatched attributes explicit", async () => {
  let calls = 0;
  const reader = {
    listIntervals: async () => {
      calls++;
      return { source: "cache" as const, intervals: [] };
    },
  };
  const plan = await planEntityHistoryBindings(
    reader,
    [
      { stableEntityId, attributePath: "equipment/main/status" },
      { stableEntityId, attributePath: "equipment/main/temperature" },
    ],
    { from: "2026-09-01T09:00:00Z", to: "2026-09-01T11:00:00Z" },
  );
  assert.equal(calls, 1);
  assert.deepEqual(plan.selectors.map((selector) => selector.status), ["not-found", "not-found"]);
});

test("rejects wildcard attribute paths and excessive unique entities", async () => {
  const reader = { listIntervals: async () => ({ source: "controller" as const, intervals: [] }) };
  await assert.rejects(
    () => planEntityHistoryBindings(
      reader,
      [{ stableEntityId, attributePath: "equipment/+/temperature" }],
      { from: "2026-09-01T09:00:00Z", to: "2026-09-01T11:00:00Z" },
    ),
    /concrete/,
  );
  await assert.rejects(
    () => planEntityHistoryBindings(
      reader,
      Array.from({ length: 21 }, (_, index) => ({
        stableEntityId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
        attributePath: "equipment/main/temperature",
      })),
      { from: "2026-09-01T09:00:00Z", to: "2026-09-01T11:00:00Z" },
    ),
    /At most 20/,
  );
});
