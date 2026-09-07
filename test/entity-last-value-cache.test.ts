import assert from "node:assert/strict";
import test from "node:test";
import { EntityLastValueCache } from "../src/entity-last-value-cache.js";

const selector = {
  stableEntityId: "11111111-1111-4111-8111-111111111111",
  attributePath: "equipment/main/temperature",
};

test("keeps the newest event across overlapping old and new topic bindings", () => {
  const cache = new EntityLastValueCache<{ timestamp: string | null; value: number }>();
  cache.replaceBindings(selector, [
    { topic: "site/line-a/press-14/equipment/main/temperature", bindingRevision: "rev-1", bindingDigest: "old" },
    { topic: "site/line-b/press-14/equipment/main/temperature", bindingRevision: "rev-2", bindingDigest: "new" },
  ]);
  cache.updateTopic("site/line-b/press-14/equipment/main/temperature", {
    timestamp: "2026-09-03T12:00:01.000Z",
    value: 11,
  });
  cache.updateTopic("site/line-a/press-14/equipment/main/temperature", {
    timestamp: "2026-09-03T11:59:59.000Z",
    value: 9,
  });
  assert.equal(cache.get(selector)?.value.value, 11);
  assert.equal(cache.get(selector)?.topic, "site/line-b/press-14/equipment/main/temperature");
});

test("invalidates a cached value when its binding revision is no longer current", () => {
  const cache = new EntityLastValueCache<{ timestamp: string | null; value: number }>();
  cache.replaceBindings(selector, [
    { topic: "site/line-a/press-14/equipment/main/temperature", bindingRevision: "rev-1", bindingDigest: "old" },
  ]);
  cache.updateTopic("site/line-a/press-14/equipment/main/temperature", {
    timestamp: "2026-09-03T12:00:00.000Z",
    value: 10,
  });
  cache.replaceBindings(selector, [
    { topic: "site/line-b/press-14/equipment/main/temperature", bindingRevision: "rev-2", bindingDigest: "new" },
  ]);
  assert.equal(cache.get(selector), null);
});
