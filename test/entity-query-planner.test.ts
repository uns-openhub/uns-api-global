import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeEntityHistoryRows,
  planEntityCurrentBindings,
  planEntityHistoryBindings,
} from "../src/entity-query-planner.js";

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

test("merges moved-path rows deterministically and removes boundary duplicates", () => {
  const columns = ["topic", "asset", "numberValue", "time"];
  const merged = mergeEntityHistoryRows([
    {
      columns,
      rows: [
        ["site/line-a", "press-14", 10, "2026-09-01T10:00:00Z"],
        ["site/line-a", "press-14", 9, "2026-09-01T09:59:00Z"],
      ],
    },
    {
      columns,
      rows: [
        ["site/line-b", "press-14", 10, "2026-09-01T10:00:00Z"],
        ["site/line-b", "press-14", 11, "2026-09-01T10:01:00Z"],
      ],
    },
  ], 10);
  assert.equal(merged.duplicatesRemoved, 1);
  assert.deepEqual(merged.rows.map((row) => row[2]), [11, 10, 9]);
});

test("fails closed when moved-path segments return incompatible columns", () => {
  assert.throws(() => mergeEntityHistoryRows([
    { columns: ["numberValue", "time"], rows: [[1, "2026-09-01T10:00:00Z"]] },
    { columns: ["value", "timestamp"], rows: [[1, "2026-09-01T10:00:00Z"]] },
  ], 10), /incompatible/);
});

test("resolves current bindings in a narrow window around the requested instant", async () => {
  const calls: Array<{ from: string; to: string }> = [];
  const reader = {
    async listIntervals(_entityId: string, from: string | Date, to: string | Date) {
      calls.push({ from: String(from), to: String(to) });
      return {
        source: "controller" as const,
        intervals: [{
          topic: "site/line-b/press-14/equipment/main/temperature",
          stableEntityId,
          entityTypeKey: "asset",
          bindingKind: "attribute-topic" as const,
          validFrom: "2026-09-01T10:00:00.000Z",
          validTo: null,
          timeBasis: "observed-at",
          sourceCount: 1,
          revision: "rev-2",
          digest: "digest-2",
        }],
      };
    },
  };
  const plan = await planEntityCurrentBindings(
    reader,
    [{ stableEntityId, attributePath: "equipment/main/temperature" }],
    "2026-09-03T12:00:00.000Z",
  );
  assert.deepEqual(calls, [{
    from: "2026-09-03T11:59:59.999Z",
    to: "2026-09-03T12:00:00.001Z",
  }]);
  assert.equal(plan.selectors[0]?.status, "resolved");
  assert.equal(plan.selectors[0]?.intervals[0]?.topic, "site/line-b/press-14/equipment/main/temperature");
});
