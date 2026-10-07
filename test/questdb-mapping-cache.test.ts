import test from "node:test";
import assert from "node:assert/strict";
import {
  QuestDbMappingCache,
  QUESTDB_HISTORY_MAPPINGS_QUERY,
  selectMappedTable,
} from "../src/questdb-mapping-cache.js";
const old = {
  topicPrefix: "enterprise/site/old/equipment/main/temperature",
  tableName: "old_data",
};
const fresh = {
  topicPrefix: "enterprise/site/new/equipment/main/temperature",
  tableName: "new_data",
};

test("a warm miss refreshes immediately and resolves a newly persisted topic", async () => {
  let calls = 0;
  const cache = new QuestDbMappingCache({ now: () => 10_000 });
  const load = async () => (++calls === 1 ? [old] : [old, fresh]);
  assert.equal(await cache.resolve(old.topicPrefix, load), "old_data");
  assert.equal(await cache.resolve(fresh.topicPrefix, load), "new_data");
  assert.equal(calls, 2);
  assert.equal(await cache.resolve(old.topicPrefix, load), "old_data");
  assert.equal(calls, 2);
});
test("simultaneous cold misses and repeated different topics share a global cooldown", async () => {
  let now = 0,
    calls = 0;
  const cache = new QuestDbMappingCache({ now: () => now });
  const load = async () => {
    calls++;
    return [];
  };
  await Promise.all(
    Array.from({ length: 100 }, (_, i) => cache.resolve(`unknown/${i}`, load)),
  );
  assert.equal(calls, 1);
  await cache.resolve("another/topic", load);
  assert.equal(calls, 1);
  now = 5_000;
  await cache.resolve("third/topic", load);
  assert.equal(calls, 2);
});
test("warm misses coalesce while refreshing and throttle later distinct misses", async () => {
  let now = 10_000,
    calls = 0;
  const cache = new QuestDbMappingCache({ now: () => now });
  await cache.resolve(old.topicPrefix, async () => [old]);
  const load = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return [old];
  };
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => cache.resolve(`unknown/${i}`, load)),
  );
  assert.equal(calls, 1);
  await cache.resolve("different/miss", load);
  assert.equal(calls, 1);
  now += 5_000;
  await cache.resolve("retry/miss", load);
  assert.equal(calls, 2);
});
test("controller failure keeps known mappings, limits retry, and recovers", async () => {
  let now = 0,
    calls = 0;
  const cache = new QuestDbMappingCache({ now: () => now });
  await cache.resolve(old.topicPrefix, async () => [old]);
  now = 60_000;
  const failed = async () => {
    calls++;
    throw new Error("offline");
  };
  assert.equal(await cache.resolve(old.topicPrefix, failed), "old_data");
  assert.equal(await cache.resolve(fresh.topicPrefix, failed), null);
  assert.equal(calls, 1);
  now += 5_000;
  assert.equal(
    await cache.resolve(fresh.topicPrefix, async () => [old, fresh]),
    "new_data",
  );
});
test("a hanging token/fetch is bounded, aborts, releases the guard and ignores late results", async () => {
  let now = 0,
    signal: AbortSignal | undefined;
  let finish!: (rows: (typeof old)[]) => void;
  const cache = new QuestDbMappingCache({ now: () => now, timeoutMs: 10 });
  assert.equal(
    await cache.resolve(old.topicPrefix, async (s) => {
      signal = s;
      return new Promise((r) => {
        finish = r;
      });
    }),
    null,
  );
  assert.equal(signal?.aborted, true);
  now += 5_000;
  assert.equal(
    await cache.resolve(fresh.topicPrefix, async () => [fresh]),
    "new_data",
  );
  finish([old]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    await cache.resolve(fresh.topicPrefix, async () => []),
    "new_data",
  );
});
test("longest prefix, segment boundaries, dynamic siblings and tablePrefix remain compatible", () => {
  assert.equal(
    selectMappedTable("a/b/c", [
      { topicPrefix: "a", tableName: "broad" },
      { topicPrefix: "a/b", tablePrefix: "specific" },
    ]),
    "specific",
  );
  assert.equal(
    selectMappedTable("a/bcd", [{ topicPrefix: "a/b", tableName: "wrong" }]),
    null,
  );
  assert.equal(
    selectMappedTable("a/new/location", [
      { topicPrefix: "a/old/location", tablePrefix: "materials" },
    ]),
    "materials",
  );
  assert.equal(
    selectMappedTable("/a/b/", [{ topicPrefix: "a/b", tableName: "exact" }]),
    "exact",
  );
});

test("history mapping requests opt in to retained sources without claiming active ownership", () => {
  assert.match(QUESTDB_HISTORY_MAPPINGS_QUERY, /QuestDBMappings\(includeHistory: true\)/);
  assert.match(QUESTDB_HISTORY_MAPPINGS_QUERY, /topicPrefix tableName/);
});
