import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  QueryDiagnostics,
  QueryWorkloadError,
  type DiagnosticEvent,
} from "../src/query-diagnostics.js";
import { LatestLookupCoordinator } from "../src/latest-value-history.js";
const fixture = () => {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new QueryDiagnostics({
    maxConcurrent: 1,
    maxQueued: 8,
    queueTimeoutMs: 100,
    slowQueryMs: 1,
    failureCooldownMs: 0,
    databaseLabel: "history-replica",
    emit: (e) => events.push(e),
  });
  return { diagnostics, events };
};
const result = () => ({
  value: { data: [[4]] },
  rows: 1,
  responseBytes: 10,
  httpStatus: 200,
});

test("latest coordinator links every verified caller to the actual schema and data executions", async () => {
  const { diagnostics, events } = fixture();
  const coordinator = new LatestLookupCoordinator<{ data: number[][] }>({
    runLookup: (id, run) => diagnostics.runRecovery(id, run),
    onJoin: (id) => diagnostics.joinRecovery(id),
  });
  let calls = 0;
  const load = async (signal: AbortSignal) => {
    await diagnostics.query(
      "db",
      'SHOW COLUMNS FROM "old_data"',
      "schema",
      async () => {
        calls++;
        await delay(10);
        return result();
      },
      signal,
    );
    return diagnostics.query(
      "db",
      "SELECT * FROM \"old_data\" WHERE topic='secret/topic'",
      "latest-fallback",
      async () => {
        calls++;
        return result();
      },
      signal,
    );
  };
  const outputs = await Promise.all(
    ["owner", "follower"].map((id) =>
      diagnostics.runRequest(id, "batch-last", async () => {
        diagnostics.authenticate({
          machineIdentityId: id,
          machineIdentityName: id,
        });
        const value = await coordinator.run("secret/topic", load);
        diagnostics.finishRequest(200);
        return value;
      }),
    ),
  );
  assert.equal(calls, 2);
  const started = events.find((e) => e["event"] === "lookup.started")!;
  const joined = events.find((e) => e["event"] === "lookup.joined")!;
  assert.equal(joined["requestId"], "follower");
  assert.equal(joined["lookupId"], started["lookupId"]);
  assert.equal((joined["caller"] as { name: string }).name, "follower");
  const queries = events.filter((e) => e["event"] === "query.started");
  assert.equal(queries.length, 2);
  for (const q of queries) assert.equal(q["lookupId"], joined["lookupId"]);
  assert.doesNotMatch(JSON.stringify(events), /secret\/topic/);
  outputs[1]!.data[0]![0] = 99;
  assert.equal(outputs[0]!.data[0]![0], 4);
});

test("latest follower capacity is bounded and reused after completion", async () => {
  let finish!: () => void;
  let throttled = 0;
  const coordinator = new LatestLookupCoordinator<number>({
    maxWaiters: 1,
    onThrottle: () => throttled++,
  });
  const owner = coordinator.run("one", async () => {
    await new Promise<void>((r) => (finish = r));
    return 4;
  });
  await Promise.resolve();
  const follower = coordinator.run("one", async () => 99);
  await assert.rejects(
    coordinator.run("one", async () => 99),
    /busy/,
  );
  assert.equal(throttled, 1);
  finish();
  assert.deepEqual(await Promise.all([owner, follower]), [4, 4]);
  assert.equal(await coordinator.run("two", async () => 5), 5);
});

test("cancelled queued lookup releases its queue entry without touching another query", async () => {
  const { diagnostics } = fixture();
  let finish!: () => void;
  const active = diagnostics.query("db", "SELECT 1", "health", async () => {
    await new Promise<void>((r) => (finish = r));
    return result();
  });
  await Promise.resolve();
  const controller = new AbortController();
  let executed = false;
  const queued = diagnostics.query(
    "db",
    "SELECT 2",
    "latest-fallback",
    async () => {
      executed = true;
      return result();
    },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(
    queued,
    (e) => e instanceof QueryWorkloadError && e.code === "cancelled",
  );
  assert.equal(diagnostics.snapshot()["queued"], 0);
  assert.equal(diagnostics.snapshot()["active"], 1);
  finish();
  await active;
  assert.equal(executed, false);
  assert.equal(diagnostics.snapshot()["active"], 0);
});

test("recovery failures before SQL remain correlated without exposing dependency details", async () => {
  const { diagnostics, events } = fixture();
  const coordinator = new LatestLookupCoordinator<number>({
    runLookup: (id, run) => diagnostics.runRecovery(id, run),
    onThrottle: () => diagnostics.cache("throttled"),
  });
  await diagnostics.runRequest("request-one", "batch-last", async () => {
    diagnostics.authenticate({ sub: "123" });
    const load = async () => {
      throw new Error("secret-token/private/topic");
    };
    await assert.rejects(coordinator.run("private/topic", load));
    await assert.rejects(coordinator.run("private/topic", load));
    diagnostics.finishRequest(200);
  });
  const failed = events.find((e) => e["event"] === "lookup.completed")!;
  assert.equal(failed["outcome"], "failed");
  assert.equal(failed["requestId"], "request-one");
  assert.equal(events.at(-1)!["throttled"], 1);
  assert.equal(diagnostics.snapshot()["active"], 0);
  assert.doesNotMatch(JSON.stringify(events), /private|secret-token/);
});
