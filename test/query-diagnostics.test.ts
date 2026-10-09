import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  QueryDiagnostics,
  QueryWorkloadError,
  describeSql,
  verifiedCaller,
  type DiagnosticEvent,
} from "../src/query-diagnostics.js";

function fixture(
  overrides: Partial<ConstructorParameters<typeof QueryDiagnostics>[0]> = {},
) {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new QueryDiagnostics({
    maxConcurrent: 2,
    maxQueued: 2,
    queueTimeoutMs: 100,
    slowQueryMs: 1,
    failureCooldownMs: 20,
    databaseLabel: "history-replica",
    emit: (event) => events.push(event),
    ...overrides,
  });
  return { diagnostics, events };
}
const value = (v = 1) => ({
  value: { data: [v] },
  rows: 1,
  responseBytes: 20,
  httpStatus: 200,
});

test("fingerprints remove literals/comments while identifying latest/schema and target tables", () => {
  const sql = `SELECT * FROM "uns_data" WHERE topic = 'private/one''secret' AND value > 123 LATEST ON "time" PARTITION BY "topic" -- a secret`;
  const first = describeSql(sql);
  assert.deepEqual(first.tables, ["uns_data"]);
  assert.equal(first.queryType, "latest-on");
  assert.equal(
    first.fingerprint,
    describeSql(
      `SELECT * FROM "uns_data" WHERE topic = 'another/topic' AND value > 999 LATEST ON "time" PARTITION BY "topic"`,
    ).fingerprint,
  );
  assert.equal(describeSql(`SHOW COLUMNS FROM "uns_data"`).queryType, "schema");
  assert.doesNotMatch(JSON.stringify(first), /private|secret|123/);
});
test("caller labels use verified IDs without emitting emails, tokens, paths or unsafe names", () => {
  assert.deepEqual(
    verifiedCaller({
      machineIdentityId: "550e8400-e29b-41d4-a716-446655440000",
      machineIdentityName: "integration-one",
      email: "secret@example.invalid",
    }),
    {
      kind: "machine",
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "integration-one",
    },
  );
  const legacy = verifiedCaller({
    sub: "secret@example.invalid",
    serviceToken: true,
    token: "private-token",
  });
  assert.equal(legacy.kind, "service");
  assert.match(legacy.id, /^sha256:/);
  assert.doesNotMatch(JSON.stringify(legacy), /secret|example|private-token/);
  assert.equal(
    verifiedCaller({
      machineIdentityId: "id",
      machineIdentityName: "private/topic",
    }).name,
    undefined,
  );
});
test("concurrent callers coalesce exact SQL with attribution and independent result objects", async () => {
  const { diagnostics, events } = fixture();
  let executions = 0;
  const sql = `SELECT * FROM "uns_data" WHERE topic='private/topic' LATEST ON "time" PARTITION BY "topic"`;
  const requests = ["request-a", "request-b"].map((requestId, i) =>
    diagnostics.runRequest(requestId, "batch-last", async () => {
      diagnostics.authenticate({ sub: String(i + 1) });
      const result = await diagnostics.query(
        "database",
        sql,
        "latest-fallback",
        async () => {
          executions++;
          await delay(10);
          return value();
        },
      );
      diagnostics.finishRequest(200);
      return result;
    }),
  );
  const [a, b] = await Promise.all(requests);
  assert.equal(executions, 1);
  assert.notEqual(a, b);
  a!.data.push(2);
  assert.deepEqual(b!.data, [1]);
  const execution = events.find((e) => e["event"] === "query.completed")!;
  const joined = events.find((e) => e["event"] === "query.coalesced")!;
  assert.equal(joined["queryId"], execution["queryId"]);
  assert.equal(joined["requestId"], "request-b");
  assert.deepEqual(joined["caller"], { kind: "user", id: "2" });
  assert.doesNotMatch(JSON.stringify(events), /private\/topic/);
  assert.equal(events.filter((e) => e["event"] === "http.completed").length, 2);
});
test("same normalized fingerprint cannot coalesce distinct topics or databases", async () => {
  const { diagnostics } = fixture({ maxQueued: 5 });
  let executions = 0;
  await Promise.all(
    [
      ["db-a", "one"],
      ["db-a", "two"],
      ["db-b", "one"],
    ].map(([db, topic]) =>
      diagnostics.query(
        db!,
        `SELECT * FROM "uns_data" WHERE topic='${topic}'`,
        "history",
        async () => {
          executions++;
          await delay(2);
          return value();
        },
      ),
    ),
  );
  assert.equal(executions, 3);
});

test("coalesced waiters also obey the shared waiting bound", async () => {
  const { diagnostics } = fixture({ maxConcurrent: 1, maxQueued: 1 });
  const execute = async () => {
    await delay(10);
    return value();
  };
  const owner = diagnostics.query("db", "SELECT 1", "history", execute);
  const joined = diagnostics.query("db", "SELECT 1", "history", execute);
  await assert.rejects(
    diagnostics.query("db", "SELECT 1", "history", execute),
    (error: unknown) =>
      error instanceof QueryWorkloadError && error.code === "queue-full",
  );
  await assert.rejects(
    diagnostics.query("db", "SELECT 2", "history", execute),
    (error: unknown) =>
      error instanceof QueryWorkloadError && error.code === "queue-full",
  );
  await Promise.all([owner, joined]);
  assert.equal(diagnostics.snapshot()["coalescedWaiters"], 0);
});
test("global concurrency and queue limits reject overload and recover all permits", async () => {
  const { diagnostics } = fixture({ maxConcurrent: 1, maxQueued: 1 });
  let active = 0,
    peak = 0;
  const query = (i: number) =>
    diagnostics.query("db", `SELECT ${i}`, "history", async () => {
      peak = Math.max(peak, ++active);
      await delay(10);
      active--;
      return value(i);
    });
  const results = await Promise.allSettled([query(1), query(2), query(3)]);
  assert.equal(peak, 1);
  assert.equal(results[2]!.status, "rejected");
  assert.equal(diagnostics.snapshot()["active"], 0);
  assert.equal(diagnostics.snapshot()["queued"], 0);
  await query(4);
});
test("queue deadline removes pending work without executing it", async () => {
  const { diagnostics } = fixture({ maxConcurrent: 1, queueTimeoutMs: 3 });
  const first = diagnostics.query("db", "SELECT 1", "history", async () => {
    await delay(15);
    return value();
  });
  let executed = false;
  await assert.rejects(
    diagnostics.query("db", "SELECT 2", "history", async () => {
      executed = true;
      return value();
    }),
    (e: unknown) =>
      e instanceof QueryWorkloadError && e.code === "queue-timeout",
  );
  await first;
  assert.equal(executed, false);
  assert.equal(diagnostics.snapshot()["queued"], 0);
});
test("dependency failures activate cooldown including already queued work; retries recover", async () => {
  const { diagnostics, events } = fixture({ maxConcurrent: 1 });
  const first = diagnostics.query("db", "SELECT 1", "history", async () => {
    await delay(2);
    throw Object.assign(new Error("private/topic password=secret"), {
      code: "timeout",
    });
  });
  let executed = false;
  const second = diagnostics.query("db", "SELECT 2", "history", async () => {
    executed = true;
    return value();
  });
  await Promise.allSettled([first, second]);
  assert.equal(executed, false);
  await assert.rejects(
    diagnostics.query("db", "SELECT 3", "history", async () => value()),
    (e: unknown) => e instanceof QueryWorkloadError && e.code === "cooldown",
  );
  assert.doesNotMatch(JSON.stringify(events), /password|private\/topic|secret/);
  await delay(25);
  await diagnostics.query("db", "SELECT 3", "history", async () => value());
});
test("live snapshot is bounded; cache counters, background purpose and logging failure are safe", async () => {
  const { diagnostics, events } = fixture();
  await diagnostics.runBackground("cache-seed", async () => {
    await diagnostics.query("db", "SELECT 1", "cache-seed", async () => {
      assert.equal(
        (diagnostics.snapshot()["activeQueries"] as unknown[]).length,
        1,
      );
      return value();
    });
  });
  await diagnostics.runRequest("r", "batch-last", async () => {
    diagnostics.cache("cacheHits", 2);
    diagnostics.cache("cacheMisses");
    diagnostics.cache("throttled");
    diagnostics.finishRequest(200);
  });
  assert.deepEqual(events[0]!["caller"], {
    kind: "runtime",
    id: "uns-api-global",
  });
  assert.equal(events.at(-1)!["cacheHits"], 2);
  for (let i = 0; i < 140; i++)
    await diagnostics.query("db", `SELECT ${i}`, "health", async () => value());
  assert.equal((diagnostics.snapshot()["recent"] as unknown[]).length, 128);
  const broken = fixture({
    emit: () => {
      throw new Error("logging offline");
    },
  }).diagnostics;
  await broken.query("db", "SELECT 1", "health", async () => value());
  assert.equal(broken.snapshot()["active"], 0);
});
