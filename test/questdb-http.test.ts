import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  QueryDiagnostics,
  type DiagnosticEvent,
} from "../src/query-diagnostics.js";
import {
  readHistory,
  HistoryReadError,
} from "../src/history-source-diagnostics.js";
import { queryQuestDbHttp, QuestDbQueryError } from "../src/questdb-http.js";

test("HTTP execution carries correlation, preserves tuple/columns/SQL and excludes sensitive diagnostics", async (t) => {
  const calls: Array<{
    query: string | null;
    id: string | undefined;
    queryId: string | undefined;
  }> = [];
  const server = createServer(async (req, res) => {
    calls.push({
      query: new URL(req.url!, "http://local").searchParams.get("query"),
      id: req.headers["x-request-id"] as string,
      queryId: req.headers["x-query-id"] as string,
    });
    await delay(10);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        columns: [{ name: "value", type: "DOUBLE" }],
        dataset: [[1]],
        count: 1,
        query: "private/topic",
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const events: DiagnosticEvent[] = [];
  const diagnostics = new QueryDiagnostics({
    maxConcurrent: 2,
    maxQueued: 2,
    queueTimeoutMs: 100,
    slowQueryMs: 1,
    databaseLabel: "history-replica",
    failureCooldownMs: 0,
    emit: (e) => events.push(e),
  });
  const address = server.address() as { port: number };
  const cfg = {
    url: `http://127.0.0.1:${address.port}`,
    username: "private-user",
    password: "private-password",
    statementTimeoutMs: 1000,
  };
  const sql = `SELECT * FROM "uns_data" WHERE topic='private/  topic' LATEST ON "time" PARTITION BY "topic"`;
  const results = await Promise.all(
    ["a", "b"].map((id) =>
      diagnostics.runRequest(id, "batch-last", async () => {
        diagnostics.authenticate({ sub: id });
        return queryQuestDbHttp(diagnostics, cfg, sql, "latest-fallback");
      }),
    ),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.query, sql);
  assert.equal(calls[0]!.id, "a");
  assert.match(calls[0]!.queryId!, /^[0-9a-f-]{36}$/);
  assert.deepEqual(results[0]!.data, [[1]]);
  assert.deepEqual(results[0]!.raw["columns"], [
    { name: "value", type: "DOUBLE" },
  ]);
  assert.equal(results[0]!.raw["query"], sql);
  assert.doesNotMatch(
    JSON.stringify(events),
    /private|127\.0\.0\.1|password|Authorization/,
  );
  assert.equal(
    events.find((e) => e["event"] === "query.completed")!["reportedCount"],
    1,
  );
});

test("QuestDB failure bodies and timeouts become safe typed errors and free capacity", async (t) => {
  let slow = false;
  const server = createServer(async (_req, res) => {
    if (slow) await delay(100);
    res.statusCode = 500;
    res.end("SQL private/topic credential=secret");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const events: DiagnosticEvent[] = [];
  const diagnostics = new QueryDiagnostics({
    maxConcurrent: 1,
    maxQueued: 2,
    queueTimeoutMs: 100,
    slowQueryMs: 1,
    databaseLabel: "history-replica",
    failureCooldownMs: 0,
    emit: (e) => events.push(e),
  });
  const cfg = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    username: "u",
    password: "secret",
    statementTimeoutMs: 1000,
  };
  await assert.rejects(
    queryQuestDbHttp(diagnostics, cfg, "SELECT 1", "health"),
    (error: unknown) =>
      error instanceof QuestDbQueryError &&
      error.code === "http-error" &&
      error.httpStatus === 500 &&
      !error.message.includes("secret"),
  );
  slow = true;
  await assert.rejects(
    queryQuestDbHttp(
      diagnostics,
      { ...cfg, statementTimeoutMs: 20 },
      "SELECT 2",
      "health",
    ),
    (error: unknown) =>
      error instanceof QuestDbQueryError && error.code === "timeout",
  );
  assert.equal(diagnostics.snapshot()["active"], 0);
  assert.doesNotMatch(JSON.stringify(events), /private|credential|secret/);
  assert.equal(events.at(-1)!["outcome"], "timeout");
});

test("missing-table classification survives HTTP redaction and preserves history diagnostics", async (t) => {
  const server = createServer((_req, res) => {
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        error: "table does not exist [table=old_data]",
        query: "secret/topic",
        credential: "private",
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const events: DiagnosticEvent[] = [];
  const diagnostics = new QueryDiagnostics({
    maxConcurrent: 1,
    maxQueued: 1,
    queueTimeoutMs: 100,
    slowQueryMs: 1,
    failureCooldownMs: 0,
    databaseLabel: "replica",
    emit: (e) => events.push(e),
  });
  const cfg = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    username: "u",
    password: "p",
    statementTimeoutMs: 1000,
  };
  await assert.rejects(
    readHistory(["old_data"], "schema", () =>
      queryQuestDbHttp(
        diagnostics,
        cfg,
        'SHOW COLUMNS FROM "old_data"',
        "schema",
      ),
    ),
    (e) =>
      e instanceof HistoryReadError &&
      e.status === 409 &&
      e.diagnostic.code === "HISTORY_TABLE_MISSING",
  );
  assert.doesNotMatch(JSON.stringify(events), /secret|private|credential/);
});

test("cancelling one owner does not abort identical SQL in another cancellation scope", async (t) => {
  let calls = 0;
  const server = createServer(async (_req, res) => {
    calls++;
    await delay(100);
    res.end(JSON.stringify({ dataset: [[1]], columns: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const diagnostics = new QueryDiagnostics({
    maxConcurrent: 2,
    maxQueued: 2,
    queueTimeoutMs: 100,
    slowQueryMs: 1,
    failureCooldownMs: 5000,
    databaseLabel: "replica",
    emit: () => {},
  });
  const cfg = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    username: "u",
    password: "p",
    statementTimeoutMs: 1000,
  };
  const a = new AbortController(),
    b = new AbortController();
  const first = queryQuestDbHttp(
    diagnostics,
    cfg,
    "SELECT 1",
    "latest-fallback",
    a.signal,
  );
  const rejection = assert.rejects(
    first,
    (e) => e instanceof QuestDbQueryError && e.code === "cancelled",
  );
  const second = queryQuestDbHttp(
    diagnostics,
    cfg,
    "SELECT 1",
    "latest-fallback",
    b.signal,
  );
  while (calls < 2) await delay(1);
  a.abort();
  await rejection;
  assert.deepEqual((await second).data, [[1]]);
  assert.equal(diagnostics.snapshot()["cooldownRemainingMs"], 0);
  assert.equal(diagnostics.snapshot()["active"], 0);
});
