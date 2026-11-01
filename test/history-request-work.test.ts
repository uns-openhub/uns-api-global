import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mapHistoryRequests } from "../src/history-request-work.js";
import { QueryDiagnostics, QueryWorkloadError } from "../src/query-diagnostics.js";
import { resolveQueryDeploymentBudget } from "../src/query-deployment-budget.js";
import { queryQuestDbHttp } from "../src/questdb-http.js";

test("eight HTTP history reads retain order and tuples under a one-slot deployment allocation", async (t) => {
  let active = 0, peak = 0;
  const server = createServer(async (req, res) => {
    peak = Math.max(peak, ++active);
    const sql = new URL(req.url!, "http://local").searchParams.get("query")!;
    await delay(15);
    active--;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ columns: [{ name: "value", type: "DOUBLE" }], dataset: [[Number(/SELECT (\d+)/.exec(sql)![1])]] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const allocation = resolveQueryDeploymentBudget({ maxConcurrent: 4, maxQueued: 8, deploymentBudget: { totalMaxConcurrent: 2, maxInstances: 2 } });
  const diagnostics = new QueryDiagnostics({ ...allocation, maxQueued: 8, queueTimeoutMs: 10, slowQueryMs: 100, failureCooldownMs: 0, databaseLabel: "synthetic", emit: () => {} });
  const cfg = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, username: "local", password: "test", statementTimeoutMs: 1000 };
  const results = await mapHistoryRequests(Array.from({ length: 8 }, (_, i) => i), allocation.maxConcurrent,
    i => queryQuestDbHttp(diagnostics, cfg, `SELECT ${i}`, "history"));
  assert.deepEqual(results.map(r => r.data), Array.from({ length: 8 }, (_, i) => [[i]]));
  assert.ok(results.every(r => Array.isArray(r.raw["columns"])));
  assert.equal(peak, 1);
  assert.equal(diagnostics.snapshot()["active"], 0);
  assert.equal(diagnostics.snapshot()["queued"], 0);
  assert.equal((diagnostics.snapshot()["totals"] as { rejected: number }).rejected, 0);
});

test("cold multi-table schema reads work with no waiting slots", async () => {
  const diagnostics = new QueryDiagnostics({ maxConcurrent: 1, maxQueued: 0, queueTimeoutMs: 10, slowQueryMs: 100, failureCooldownMs: 0, databaseLabel: "synthetic", emit: () => {} });
  const values = await mapHistoryRequests(["old", "middle", "current"], 1, table => diagnostics.query("db", `SHOW COLUMNS FROM "${table}"`, "schema", async () => {
    await delay(2);
    return { value: table, rows: 1, responseBytes: 5, httpStatus: 200 };
  }));
  assert.deepEqual(values, ["old", "middle", "current"]);
  assert.equal((diagnostics.snapshot()["totals"] as { rejected: number }).rejected, 0);
});

test("disconnect stops unstarted paths and settles all admitted work before returning", async () => {
  const cancellation = new AbortController();
  const finish: Array<() => void> = [];
  const started: number[] = [];
  let settled = false;
  const work = mapHistoryRequests([0, 1, 2, 3], 2, async i => {
    started.push(i);
    await new Promise<void>(resolve => finish.push(resolve));
    return i;
  }, cancellation.signal).finally(() => { settled = true; });
  const rejected = assert.rejects(work, e => e instanceof QueryWorkloadError && e.code === "cancelled");
  cancellation.abort();
  finish[0]!();
  await delay(0);
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1]);
  finish[1]!();
  await rejected;
  assert.equal(settled, true);
  assert.deepEqual(started, [0, 1]);
});

test("a failure waits for other admitted work and does not launch further paths", async () => {
  const error = new Error("synthetic failure");
  let finish!: () => void, settled = false;
  const started: number[] = [];
  const work = mapHistoryRequests([0, 1, 2], 2, async i => {
    started.push(i);
    if (i === 0) throw error;
    await new Promise<void>(resolve => { finish = resolve; });
    return i;
  }).finally(() => { settled = true; });
  const rejected = assert.rejects(work, e => e === error);
  await delay(0);
  assert.equal(settled, false);
  finish();
  await rejected;
  assert.deepEqual(started, [0, 1]);
});

test("empty work stays empty and invalid allocations never launch a query", async () => {
  let calls = 0;
  const run = async () => ++calls;
  assert.deepEqual(await mapHistoryRequests([], 1, run), []);
  for (const limit of [0, -1, 1.5, Infinity, NaN]) await assert.rejects(mapHistoryRequests([1], limit, run));
  const signal = AbortSignal.abort();
  await assert.rejects(mapHistoryRequests([1], 1, run, signal), QueryWorkloadError);
  assert.equal(calls, 0);
});
