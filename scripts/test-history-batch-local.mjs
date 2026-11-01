/** Actual built API + local MQTT, synthetic controller/QuestDB HTTP contracts.
 * Starts only disposable loopback fixtures; no external URLs or production data.
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

const root = process.cwd();
const entry = path.resolve(root, process.env.HISTORY_BATCH_ENTRY ?? "dist/index.js");
const expectBefore = process.argv.includes("--expect-before");
const coldParallel = process.argv.includes("--cold-parallel-only");
// Zero waiting slots require one path per request: even coalesced schema
// followers count against the global waiting bound.
const expectedConcurrency = 1;
const tmp = await mkdtemp(path.join(os.tmpdir(), "openhub-history-batch-"));
const children = [], servers = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
const columns = [
  ["topic", "SYMBOL"], ["asset", "SYMBOL"], ["objectType", "SYMBOL"], ["objectId", "SYMBOL"],
  ["attribute", "SYMBOL"], ["valueType", "SYMBOL"], ["value", "DOUBLE"], ["numberValue", "DOUBLE"],
  ["uom", "VARCHAR"], ["timestamp", "TIMESTAMP"], ["interval", "LONG"], ["deleted", "BOOLEAN"], ["lastSeen", "TIMESTAMP"],
];
const topics = Array.from({ length: 8 }, (_, i) => `enterprise/site/area/line/motor/equipment/point-${i}/temperature`);
const from = "2026-11-01T09:29:59Z", to = "2026-11-01T09:30:01Z";
const timestamp = "2026-11-01T09:30:00.000000Z";
let apiLogs = "", brokerLogs = "", brokerError, apiOrigin, api;
let dataCalls = 0, active = 0, peak = 0, rowsPerRead = 1, reportedCount = 1, failDatabase = false;
let holdNext = false, heldRelease, onHeld;
let authorization = "active";
const secret = randomBytes(32).toString("hex");
const token = accessRules => jwt.sign({ sub: "local-reader", roles: ["user"], scope: "read:uns", accessRules }, secret, { expiresIn: "10m" });
const reader = token(["enterprise/#"]), denied = token(["enterprise/other/#"]);
const admin = jwt.sign({ sub: "local-admin", roles: ["admin"], scope: "read:uns", accessRules: ["enterprise/#"] }, secret, { expiresIn: "10m" });
const body = { topics, from, to, limit: 5, timeField: "timestamp", dedupe: false };
async function listen(server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function jsonBody(req) { let body = ""; for await (const chunk of req) body += chunk; return JSON.parse(body || "{}"); }
function send(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
async function call(route, options = {}, bearer = reader) {
  const response = await fetch(apiOrigin + route, { ...options, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" } });
  return { status: response.status, body: await response.json() };
}
const single = (topic, bearer = reader) => call(`/api/catchall?${new URLSearchParams({ topic, from, to, limit: "5", dedupe: "false", timeField: "timestamp" })}`, {}, bearer);
const batch = (extra = {}, bearer = reader) => call("/api/catchall/batch/range", { method: "POST", body: JSON.stringify({ ...body, ...extra }) }, bearer);
async function waitFor(run, description, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await run()) return; await delay(20); }
  throw new Error(`Deadline: ${description}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(5000)]);
  if (child.exitCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
}
try {
  const quest = await listen(http.createServer(async (req, res) => {
    const sql = new URL(req.url, "http://local").searchParams.get("query") ?? "";
    if (/^SELECT 1\s*$/i.test(sql)) return send(res, 200, { columns: [{ name: "one", type: "INT" }], dataset: [[1]] });
    if (/^SHOW COLUMNS/i.test(sql)) return send(res, 200, { columns: [{ name: "column", type: "STRING" }, { name: "type", type: "STRING" }], dataset: columns });
    const point = Number(/"objectId"\s*=\s*'point-(\d+)'/.exec(sql)?.[1]);
    if (!Number.isInteger(point)) return send(res, 400, { error: "Unexpected synthetic query" });
    dataCalls++; peak = Math.max(peak, ++active);
    let finished = false;
    const finish = () => { if (!finished) { finished = true; active--; } };
    res.once("close", finish);
    if (holdNext) {
      holdNext = false;
      await new Promise(resolve => { heldRelease = resolve; res.once("close", resolve); onHeld?.(); });
    } else await delay(300);
    if (res.destroyed) return;
    if (failDatabase) { finish(); return send(res, 500, { error: "Synthetic upstream SQL credential=must-not-leak" }); }
    const limit = Number(/LIMIT\s+(\d+)\s*$/i.exec(sql.trim())?.[1] ?? 5);
    const outputColumns = [...columns.map(([name, type]) => ({ name, type })), { name: "__historySourceTable", type: "STRING" }];
    const dataset = Array.from({ length: Math.min(rowsPerRead, limit) }, () => ["enterprise/site/area/line", "motor", "equipment", `point-${point}`, "temperature", "number", point + 10, point + 10, "C", timestamp, 60000, false, timestamp, "history_current"]);
    finish(); send(res, 200, { columns: outputColumns, dataset, count: reportedCount });
  }));
  const controller = await listen(http.createServer(async (req, res) => {
    if (req.url === "/api/auth/token-status") return send(res, authorization === "active" ? 200 : 403, { active: authorization === "active", protocolVersion: 1 });
    if (req.url === "/graphql") {
      const request = await jsonBody(req);
      if (request.query?.includes("QuestDBMappings")) return send(res, 200, { data: { QuestDBMappings: ["history_retained", "history_current"].map((tableName, i) => ({ tableName, topicPrefix: "enterprise/#", processName: "local-archiver", packageName: "local-archiver", version: "1", historyId: String(i), historyRevision: "1", retiredAt: i ? null : "2026-10-01T00:00:00Z" })) } });
      return send(res, 200, { data: { GetUnsNodes: [] } });
    }
    if (req.url?.startsWith("/api/triggers")) return send(res, 200, { triggers: [] });
    if (req.url?.startsWith("/api/captures")) return send(res, 200, { captures: [] });
    send(res, 200, {});
  }));
  const reserve = net.createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const mqttPort = reserve.address().port; await new Promise(r => reserve.close(r));
  const mqttConfig = path.join(tmp, "mosquitto.conf");
  await writeFile(mqttConfig, `listener ${mqttPort} 127.0.0.1\nallow_anonymous true\npersistence false\n`);
  const broker = spawn(process.env.MOSQUITTO_BIN ?? "mosquitto", ["-c", mqttConfig], { stdio: ["ignore", "ignore", "pipe"] });
  children.push(broker); broker.on("error", error => { brokerError = error; });
  broker.stderr.on("data", chunk => { brokerLogs = (brokerLogs + chunk).slice(-2000); });
  await waitFor(async () => {
    if (brokerError || broker.exitCode !== null) throw Error("Local MQTT unavailable; set MOSQUITTO_BIN to the installed broker executable. " + brokerLogs);
    try { const socket = net.connect(mqttPort, "127.0.0.1"); socket.on("error", () => {}); await Promise.race([once(socket, "connect"), delay(100).then(() => { throw Error(); })]); socket.destroy(); return true; } catch { return false; }
  }, "local MQTT");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, type: "module" }));
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({
    uns: { processName: "history-batch-local", instanceMode: "force", handover: false, rest: `${controller}/api`, graphql: `${controller}/graphql`, token: reader },
    infra: { host: "127.0.0.1", port: mqttPort, protocol: "mqtt" },
    authorization: { mode: "controller", statusCacheMs: 250 },
    questdb: { url: quest, username: "synthetic", password: "local-only", defaultLimit: 5, maxLimit: 5, maxLookbackHours: 24, maxScanRows: 20, maxResponseBytes: 1048576, statementTimeoutMs: 5000,
      queryDiagnostics: { maxConcurrent: 4, maxQueued: coldParallel ? 0 : 8, queueTimeoutMs: 1000, failureCooldownMs: 0, deploymentBudget: { totalMaxConcurrent: coldParallel ? 8 : 2, maxInstances: 2 } } },
    dataSources: [{ topic: "enterprise/#", history: true, cache: false }], lastValueCache: { enabled: false },
    catchAll: { apiBasePath: "/api/catchall" },
  }));
  api = spawn(process.execPath, [entry], { cwd: tmp, env: { PATH: process.env.PATH, UNS_API_JWT_SECRET: secret }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(api);
  for (const stream of [api.stdout, api.stderr]) stream.on("data", chunk => { apiLogs = (apiLogs + chunk).slice(-100000); const match = /API listening on http:\/\/[^:\s]+:(\d+)/.exec(apiLogs); if (match) apiOrigin = `http://127.0.0.1:${match[1]}`; });
  await waitFor(async () => api.exitCode !== null ? Promise.reject(Error("Built API exited during startup")) : apiOrigin && (await call("/api/catchall/diagnostics/queries", {}, admin)).status === 200, "built API readiness");
  if (expectBefore) assert.equal((await single(topics[0])).status, 200);
  const grouped = await batch();
  assert.equal(grouped.status, 200);
  if (expectBefore) {
    const failures = grouped.body.results.filter(r => r.error);
    assert.ok(failures.length > 0 && failures.every(r => r.status === 500));
    for (const topic of topics) assert.equal((await single(topic)).status, 200);
    console.log(JSON.stringify({ stage: "before-fix", batchSucceeded: grouped.body.stats.succeeded, batchFailed: grouped.body.stats.failed, failureStatuses: failures.map(r => r.status), singleSucceeded: 8, peakDatabaseConcurrency: peak }));
  } else {
    assert.equal(grouped.body.stats.succeeded, 8); assert.equal(grouped.body.stats.failed, 0); assert.equal(peak, expectedConcurrency);
    for (let i = 0; i < topics.length; i++) {
      const read = await single(topics[i]); assert.equal(read.status, 200);
      assert.deepEqual(grouped.body.results[i].data, read.body.data);
      assert.deepEqual(grouped.body.results[i].columns, read.body.stats.raw.columns.map(c => c.name));
    }
    if (coldParallel) {
      console.log(JSON.stringify({ stage: "cold-multi-source", batchSucceeded: 8, singleSucceeded: 8, exactTupleAndColumnMatches: 8, peakDatabaseConcurrency: peak, maxQueued: 0, scope: "built API and local MQTT; synthetic two-table history" }));
    } else {
    const beforeDenied = dataCalls;
    assert.equal((await batch({}, denied)).status, 403); assert.equal((await single(topics[0], denied)).status, 403);
    assert.equal((await batch({}, "not-a-jwt")).status, 401); assert.equal(dataCalls, beforeDenied);
    const badRange = await batch({ from: "not-a-timestamp" }); assert.equal(badRange.status, 400);
    rowsPerRead = 0; reportedCount = 0;
    const empty = await batch({ topics: [topics[0]] });
    assert.equal(empty.body.stats.succeeded, 1); assert.deepEqual(empty.body.results[0].data, []);
    assert.deepEqual((await single(topics[0])).body.data, []);
    rowsPerRead = 8; reportedCount = 8;
    const limited = await batch({ topics: [topics[0]], limit: 9999 });
    assert.equal(limited.body.results[0].data.length, 5); assert.equal(limited.body.results[0].stats.truncated, true);
    reportedCount = 21;
    const overScan = await batch({ topics: [topics[0]] }); assert.equal(overScan.body.results[0].status, 413);
    assert.equal((await single(topics[0])).status, 413); rowsPerRead = 1; reportedCount = 1;
    failDatabase = true;
    const failed = await batch({ topics: [topics[0]] }); assert.equal(failed.body.results[0].status, 503);
    assert.equal((await single(topics[0])).status, 503); assert.doesNotMatch(JSON.stringify(failed.body), /credential=|must-not-leak/);
    failDatabase = false; assert.equal((await single(topics[0])).status, 200);
    holdNext = true;
    const held = new Promise(resolve => { onHeld = resolve; }); const occupying = single(topics[7]); await held;
    const saturated = await batch({ topics: [topics[0]] });
    assert.equal(saturated.body.results[0].status, 503); assert.match(saturated.body.results[0].error, /queue-timeout/);
    heldRelease(); await occupying;
    holdNext = true; const admitted = new Promise(resolve => { onHeld = resolve; });
    const abort = new AbortController(), beforeAbort = dataCalls;
    const cancelled = fetch(`${apiOrigin}/api/catchall/batch/range`, { method: "POST", headers: { authorization: `Bearer ${reader}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: abort.signal });
    const aborted = assert.rejects(cancelled); await admitted; abort.abort(); await aborted;
    await waitFor(async () => active === 0, "cancelled database read"); await delay(50);
    assert.equal(dataCalls, beforeAbort + 1);
    const diagnostics = await call("/api/catchall/diagnostics/queries", {}, admin);
    assert.equal(diagnostics.status, 200); assert.equal(diagnostics.body.active, 0); assert.equal(diagnostics.body.queued, 0);
    const recovered = await batch({ topics: [topics[0]] }); assert.equal(recovered.body.stats.failed, 0);
    console.log(JSON.stringify({ stage: "fixed", batchSucceeded: 8, singleSucceeded: 8, exactTupleAndColumnMatches: 8, peakDatabaseConcurrency: peak, deniedWithoutDatabaseWork: true, emptyRange: true, configuredLimitsPreserved: true, dependencyFailure503: true, queueTimeout503: true, cancellationStoppedRemainingPaths: true, activeAfterCancel: 0, queuedAfterCancel: 0, recovered: true, scope: "built API and local MQTT; synthetic controller and QuestDB HTTP" }));
    }
  }
} catch (error) {
  const redact = text => [secret, reader, denied, admin].reduce((s, key) => s.replaceAll(key, "[local credential]"), text);
  console.error(redact(String(error))); console.error(redact(apiLogs.slice(-3000))); process.exitCode = 1;
} finally {
  heldRelease?.();
  for (const child of children.reverse()) await stop(child);
  for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await rm(tmp, { recursive: true, force: true });
}
