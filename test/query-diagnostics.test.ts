import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { LatestLookupCoordinator } from "../src/latest-value-history.js";
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("history overtakes queued cache recovery without extra slots; FIFO within each workload", async () => {
  const { diagnostics } = fixture({ maxConcurrent: 1, maxQueued: 8 });
  const hold = deferred(),
    started = deferred();
  const order: string[] = [];
  const occupying = diagnostics.runBackground("cache-seed", () =>
    diagnostics.query("db", "SELECT 0", "latest-fallback", async () => {
      started.resolve();
      await hold.promise;
      order.push("running-seed");
      return value();
    }),
  );
  await started.promise;
  const request = (id: string, operation: string) =>
    diagnostics.runRequest(id, operation, () =>
      diagnostics.query("db", `SELECT '${id}'`, "schema", async () => {
        order.push(id);
        return value();
      }),
    );
  const background = diagnostics.runBackground("cache-seed", () =>
    diagnostics.query("db", "SELECT 'seed'", "schema", async () => {
      order.push("seed");
      return value();
    }),
  );
  const lastA = request("last-a", "batch-last"),
    lastB = request("last-b", "batch-last");
  const range = request("range", "batch-range"),
    explore = request("explore", "history");
  assert.deepEqual(diagnostics.snapshot()["queuedByWorkload"], {
    interactive: 2,
    "latest-recovery": 2,
    background: 1,
  });
  assert.equal(diagnostics.snapshot()["active"], 1);
  hold.resolve();
  await Promise.all([occupying, background, lastA, lastB, range, explore]);
  assert.deepEqual(order, [
    "running-seed",
    "range",
    "explore",
    "last-a",
    "last-b",
    "seed",
  ]);
  assert.equal(diagnostics.snapshot()["queued"], 0);
  assert.equal(diagnostics.snapshot()["active"], 0);
});

test("interactive history cannot bypass a full aggregate waiting bound", async () => {
  const { diagnostics } = fixture({ maxConcurrent: 1, maxQueued: 1 });
  const hold = deferred(),
    started = deferred();
  const owner = diagnostics.query("db", "SELECT 1", "history", async () => {
    started.resolve();
    await hold.promise;
    return value();
  });
  await started.promise;
  const background = diagnostics.runBackground("cache-seed", () =>
    diagnostics.query("db", "SELECT 2", "latest-fallback", async () => value()),
  );
  await assert.rejects(
    diagnostics.runRequest("read", "history", () =>
      diagnostics.query("db", "SELECT 3", "history", async () => value()),
    ),
    (e: unknown) => e instanceof QueryWorkloadError && e.code === "queue-full",
  );
  hold.resolve();
  await Promise.all([owner, background]);
});

test("a long history batch leaves bounded turns for waiting latest-value recovery", async () => {
  const { diagnostics } = fixture({ maxConcurrent: 1, maxQueued: 8 });
  const hold = deferred(),
    started = deferred(),
    order: string[] = [];
  const owner = diagnostics.query("db", "SELECT 0", "history", async () => {
    started.resolve();
    await hold.promise;
    return value();
  });
  await started.promise;
  const latest = diagnostics.runRequest("last", "batch-last", () =>
    diagnostics.query("db", "SELECT 'latest'", "schema", async () => {
      order.push("latest");
      return value();
    }),
  );
  const reads = Array.from({ length: 5 }, (_, i) =>
    diagnostics.runRequest(String(i), "batch-range", () =>
      diagnostics.query("db", `SELECT ${i + 1}`, "history", async () => {
        order.push(String(i));
        return value();
      }),
    ),
  );
  hold.resolve();
  await Promise.all([owner, latest, ...reads]);
  assert.deepEqual(order, ["0", "1", "latest", "2", "3", "4"]);
});

test("joining pending background SQL promotes it without another execution or queue entry", async () => {
  const { diagnostics } = fixture({ maxConcurrent: 1, maxQueued: 4 });
  const hold = deferred(),
    started = deferred(),
    order: string[] = [];
  const owner = diagnostics.query("db", "SELECT 0", "history", async () => {
    started.resolve();
    await hold.promise;
    return value();
  });
  await started.promise;
  const seed = diagnostics.runBackground("cache-seed", () =>
    diagnostics.query("db", "SELECT 1", "schema", async () => {
      order.push("shared");
      return value();
    }),
  );
  const latest = diagnostics.runRequest("last", "batch-last", () =>
    diagnostics.query("db", "SELECT 2", "schema", async () => {
      order.push("latest");
      return value();
    }),
  );
  const joined = diagnostics.runRequest("history", "history", () =>
    diagnostics.query("db", "SELECT 1", "schema", async () =>
      assert.fail("must coalesce"),
    ),
  );
  assert.equal(diagnostics.snapshot()["queued"], 2);
  assert.equal(diagnostics.snapshot()["coalescedWaiters"], 1);
  hold.resolve();
  await Promise.all([owner, seed, latest, joined]);
  assert.deepEqual(order, ["shared", "latest"]);
});

test("joining a startup lookup promotes queued and subsequent SQL above the coordinator", async () => {
  const { diagnostics, events } = fixture({ maxConcurrent: 1, maxQueued: 4 });
  const hold = deferred(),
    started = deferred();
  const owner = diagnostics.query("db", "SELECT 0", "history", async () => {
    started.resolve();
    await hold.promise;
    return value();
  });
  await started.promise;
  const lookups = new LatestLookupCoordinator({
    runLookup: (id, load) => diagnostics.runRecovery(id, load),
    onJoin: (id) => diagnostics.joinRecovery(id),
  });
  let loads = 0;
  const lookupStarted = deferred();
  const seed = diagnostics.runBackground("cache-seed", () =>
    lookups.run("enterprise/shared", async () => {
      loads++;
      lookupStarted.resolve();
      await diagnostics.query(
        "db",
        "SHOW COLUMNS FROM uns_data",
        "schema",
        async () => value(),
      );
      return diagnostics.query("db", "SELECT 1", "latest-fallback", async () =>
        value(),
      );
    }),
  );
  await lookupStarted.promise;
  const joined = diagnostics.runRequest("latest", "batch-last", () =>
    lookups.run("enterprise/shared", async () =>
      assert.fail("shared lookup must not repeat"),
    ),
  );
  assert.deepEqual(diagnostics.snapshot()["queuedByWorkload"], {
    interactive: 0,
    "latest-recovery": 1,
    background: 0,
  });
  hold.resolve();
  await Promise.all([owner, seed, joined]);
  assert.equal(loads, 1);
  const startedSql = events.filter(
    (e) => e["event"] === "query.started" && e["lookupId"],
  );
  assert.equal(startedSql.length, 2);
  assert.ok(startedSql.every((e) => e["workload"] === "latest-recovery"));
});

test("priority never extends queue deadlines and cancelled history is not executed", async () => {
  const { diagnostics } = fixture({
    maxConcurrent: 1,
    maxQueued: 3,
    queueTimeoutMs: 15,
  });
  const hold = deferred(),
    started = deferred(),
    abort = new AbortController();
  const owner = diagnostics.runBackground("cache-seed", () =>
    diagnostics.query("db", "SELECT 0", "latest-fallback", async () => {
      started.resolve();
      await hold.promise;
      return value();
    }),
  );
  await started.promise;
  const cancelled = diagnostics.runRequest("cancel", "history", () =>
    diagnostics.query(
      "db",
      "SELECT 1",
      "history",
      async () => assert.fail("cancelled read"),
      abort.signal,
    ),
  );
  const expired = diagnostics.runRequest("timeout", "history", () =>
    diagnostics.query("db", "SELECT 2", "history", async () =>
      assert.fail("expired read"),
    ),
  );
  const cancellation = assert.rejects(
    cancelled,
    (e: unknown) => e instanceof QueryWorkloadError && e.code === "cancelled",
  );
  abort.abort();
  await cancellation;
  await assert.rejects(
    expired,
    (e: unknown) =>
      e instanceof QueryWorkloadError && e.code === "queue-timeout",
  );
  hold.resolve();
  await owner;
  assert.equal(diagnostics.snapshot()["active"], 0);
  assert.equal(diagnostics.snapshot()["queued"], 0);
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
