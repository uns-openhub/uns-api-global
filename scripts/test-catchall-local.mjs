#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const configPath = path.join(repoRoot, "config.json");
const configTemplatePath = path.resolve(
  repoRoot,
  process.env["CATCHALL_TEST_CONFIG"] ?? "config-example.json",
);
const logPath = path.join(os.tmpdir(), `uns-api-global-catchall-smoke-${Date.now()}.log`);

const controllerBaseUrl = process.env["CATCHALL_TEST_CONTROLLER_BASE"] ?? "http://localhost:8180";
const loginEmail = process.env["CATCHALL_TEST_LOGIN_EMAIL"] ?? "admin@example.com";
const loginPassword = process.env["CATCHALL_TEST_LOGIN_PASSWORD"];
const tableName = process.env["CATCHALL_TEST_TABLE"] ?? "uns_sensor_data";
const waitTimeoutMs = Number(process.env["CATCHALL_TEST_WAIT_TIMEOUT_MS"] ?? "45000");
const discoveryLookbackHours = [2, 24, 72, 168];

const topicPaths = (
  process.env["CATCHALL_TEST_TOPICS"] ??
  "enterprise/site/area/line/motor-1/equipment/main/current," +
    "enterprise/site/area/line/motor-1/equipment/main/voltage"
)
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

if (topicPaths.length < 1) {
  throw new Error("CATCHALL_TEST_TOPICS must contain at least one full UNS attribute path.");
}

const topics = topicPaths.map((topicPath, index) => ({
  name: topicPath.split("/").at(-1) || `topic-${index + 1}`,
  path: topicPath,
}));

let child = null;
let originalConfig = null;
let configRestored = false;

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

main().catch(async error => {
  console.error(`Catch-all local smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`Service log: ${logPath}`);
  await cleanup();
  process.exit(1);
});

async function main() {
  if (!loginPassword) {
    throw new Error("CATCHALL_TEST_LOGIN_PASSWORD is required.");
  }
  JSON.parse(await fs.readFile(configTemplatePath, "utf8"));

  originalConfig = await fs.readFile(configPath, "utf8").catch(() => null);
  await fs.copyFile(configTemplatePath, configPath);

  await runCommand("pnpm", ["run", "build"], { name: "build" });
  await startService();

  const token = await loginWithRetry();

  const windows = new Map();
  for (const topic of topics) {
    windows.set(topic.name, await waitForTopicData(topic, token));
  }

  for (const topic of topics) {
    const window = windows.get(topic.name);
    await runTopicChecks(topic, window, token);
  }

  await runValidationChecks(topics[0], windows.get(topics[0].name), token);

  console.log("Catch-all local smoke test passed.");
  console.log(`Verified topics: ${topics.map(topic => topic.path).join(", ")}`);
  console.log(`Service log: ${logPath}`);
  await cleanup();
}

async function cleanup() {
  await stopService();
  if (!configRestored) {
    await restoreConfig();
  }
}

async function restoreConfig() {
  if (configRestored) return;
  if (originalConfig === null) {
    await fs.rm(configPath, { force: true });
  } else {
    await fs.writeFile(configPath, originalConfig, "utf8");
  }
  configRestored = true;
}

async function runCommand(command, args, options = {}) {
  const { name = command } = options;
  await new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    proc.on("error", reject);
    proc.on("exit", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${name} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function startService() {
  const logStream = createWriteStream(logPath, { flags: "a" });
  child = spawn("node", ["dist/index.js"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  child.on("exit", code => {
    if (code !== null && code !== 0) {
      logStream.write(`\nProcess exited with code ${code}\n`);
    }
  });
}

async function stopService() {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 5000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    child.kill("SIGTERM");
  });
}

async function loginWithRetry() {
  return await waitFor(async () => {
    const response = await fetch(new URL("/api/auth/login", controllerBaseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: loginEmail,
        password: loginPassword,
        rememberMe: false,
      }),
    }).catch(() => null);

    if (!response || !response.ok) return null;
    const payload = await response.json();
    if (!payload || typeof payload.accessToken !== "string" || !payload.accessToken.trim()) {
      throw new Error("Login succeeded but did not return accessToken.");
    }
    return payload.accessToken;
  }, waitTimeoutMs, "controller login");
}

async function waitForTopicData(topic, token) {
  return await waitFor(async () => {
    for (const lookbackHours of discoveryLookbackHours) {
      const window = createTimeWindow(lookbackHours);
      const response = await callCatchAll(topic.path, {
        table: tableName,
        from: window.from,
        to: window.to,
        summaryOnly: "false",
        dedupe: "false",
        limit: "1",
      }, token);

      if (response.status === 200 && Array.isArray(response.json?.data) && response.json.data.length > 0) {
        const latestTimestamp = extractTupleTimestamp(response.json);
        if (!latestTimestamp) {
          throw new Error(`Could not extract latest timestamp from ${topic.name} raw response.`);
        }
        return buildFocusedWindow(latestTimestamp, lookbackHours);
      }
      if (response.status === 404 || response.status === 500 || response.status === 502 || response.status === 503) {
        return null;
      }
      if (response.status === 413) {
        continue;
      }
      if (response.status === 200) {
        continue;
      }
      throw new Error(`Unexpected status while waiting for ${topic.name} catch-all data: ${response.status}`);
    }

    return null;
  }, waitTimeoutMs, `${topic.name} catch-all data`);
}

async function runTopicChecks(topic, window, token) {
  const raw = await callCatchAll(topic.path, {
    table: tableName,
    from: window.from,
    to: window.to,
    summaryOnly: "false",
    dedupe: "false",
    limit: "3",
  }, token);
  expectStatus(raw, 200, `${topic.name} raw`);
  assert(Array.isArray(raw.json.data) && raw.json.data.length > 0, `${topic.name} raw response did not return rows.`);
  assert(Array.isArray(raw.json.stats?.raw?.columns), `${topic.name} raw response is missing stats.raw.columns.`);
  assert(raw.json.stats?.limitApplied === true, `${topic.name} raw response should report limitApplied=true.`);

  const aggregateOnlyRaw = await callCatchAll(topic.path, {
    table: tableName,
    from: window.from,
    to: window.to,
    summaryOnly: "false",
    dedupe: "false",
    limit: "2",
    aggregate: "avg",
  }, token);
  expectStatus(aggregateOnlyRaw, 200, `${topic.name} aggregate-only raw`);
  assert(Array.isArray(aggregateOnlyRaw.json.data) && aggregateOnlyRaw.json.data.length > 0, `${topic.name} aggregate-only request should still return raw rows.`);
  assert(Array.isArray(aggregateOnlyRaw.json.stats?.raw?.columns), `${topic.name} aggregate-only request should still expose raw columns.`);
  assert(aggregateOnlyRaw.json.stats?.bucketed !== true, `${topic.name} aggregate-only request must not activate bucketing.`);

  const summary = await callCatchAll(topic.path, {
    table: tableName,
    from: window.from,
    to: window.to,
    summaryOnly: "true",
    dedupe: "false",
    limit: "1",
  }, token);
  expectStatus(summary, 200, `${topic.name} summary`);
  assert(summary.json.data && !Array.isArray(summary.json.data), `${topic.name} summary should return an object.`);
  for (const key of ["sampleCount", "lastValue", "avg", "min", "max", "latestTimestamp", "trend"]) {
    assert(key in summary.json.data, `${topic.name} summary is missing ${key}.`);
  }
  assert(summary.json.data.sampleCount > 0, `${topic.name} summary sampleCount should be > 0.`);
  assert(summary.json.stats?.limitApplied === false, `${topic.name} summary must ignore limit clipping.`);
  assert(summary.json.stats?.sourceRowCount === summary.json.data.sampleCount, `${topic.name} summary sourceRowCount mismatch.`);

  const bucket = await callCatchAll(topic.path, {
    table: tableName,
    from: window.from,
    to: window.to,
    bucketMs: "60000",
    aggregate: "avg",
    dedupe: "false",
  }, token);
  expectStatus(bucket, 200, `${topic.name} bucketed avg`);
  assert(bucket.json.stats?.bucketed === true, `${topic.name} bucketed response should report bucketed=true.`);
  assert(bucket.json.stats?.bucketMs === 60000, `${topic.name} bucketed response should echo bucketMs=60000.`);
  assert(bucket.json.stats?.aggregate === "avg", `${topic.name} bucketed response should echo aggregate=avg.`);
  assert(Array.isArray(bucket.json.data) && bucket.json.data.length > 0, `${topic.name} bucketed response should return rows.`);
  assertAscendingTimestamps(bucket.json.data, `${topic.name} bucketed response`);
  assertNumericValues(bucket.json.data, `${topic.name} bucketed response`);

  const maxPoints = await callCatchAll(topic.path, {
    table: tableName,
    from: window.from,
    to: window.to,
    maxPoints: "120",
    dedupe: "false",
  }, token);
  expectStatus(maxPoints, 200, `${topic.name} maxPoints`);
  assert(maxPoints.json.stats?.bucketed === true, `${topic.name} maxPoints response should be bucketed.`);
  assert(maxPoints.json.stats?.rowCount <= 120, `${topic.name} maxPoints response exceeded 120 rows.`);

  console.log(
    `[ok] ${topic.name}: discovered in ${window.discoveryWindowHours}h window, ` +
      `raw=${raw.json.stats.rowCount}, summary=${summary.json.data.sampleCount}, ` +
      `bucketed=${bucket.json.stats.rowCount}, maxPoints=${maxPoints.json.stats.rowCount}`,
  );
}

async function runValidationChecks(topic, window, token) {
  const invalidAggregate = await callCatchAll(topic.path, {
    table: tableName,
    from: window.from,
    to: window.to,
    bucketMs: "60000",
    aggregate: "median",
  }, token);
  expectStatus(invalidAggregate, 400, "invalid aggregate");

  const maxPointsMissingRange = await callCatchAll(topic.path, {
    table: tableName,
    maxPoints: "120",
  }, token);
  expectStatus(maxPointsMissingRange, 400, "maxPoints without from/to");
}

async function callCatchAll(topicPath, query, token) {
  const url = new URL(`/api/catchall/${encodeURIComponent(topicPath)}`, controllerBaseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { rawText: text };
  }
  return { status: response.status, json };
}

function createTimeWindow(lookbackHours) {
  const toMs = Date.now() + 60 * 1000;
  const fromMs = toMs - lookbackHours * 60 * 60 * 1000;
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

function buildFocusedWindow(latestTimestamp, discoveryWindowHours) {
  const latestMs = Date.parse(latestTimestamp);
  assert(Number.isFinite(latestMs), `Invalid timestamp discovered from raw REST response: ${latestTimestamp}`);
  return {
    from: new Date(latestMs - 60 * 60 * 1000).toISOString(),
    to: new Date(latestMs + 60 * 1000).toISOString(),
    latestTimestamp,
    discoveryWindowHours,
  };
}

function extractTupleTimestamp(payload) {
  const columns = payload?.stats?.raw?.columns;
  const firstRow = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!Array.isArray(columns) || !Array.isArray(firstRow)) return null;
  const index = columns.findIndex(column => column && typeof column === "object" && column.name === "timestamp");
  if (index < 0) return null;
  const value = firstRow[index];
  return typeof value === "string" ? value : null;
}

function assertAscendingTimestamps(rows, label) {
  let previous = null;
  for (const row of rows) {
    assert(typeof row.timestamp === "string", `${label} row is missing timestamp.`);
    const current = Date.parse(row.timestamp);
    assert(Number.isFinite(current), `${label} row has invalid timestamp ${row.timestamp}.`);
    if (previous !== null) {
      assert(current >= previous, `${label} timestamps are not ascending.`);
    }
    previous = current;
  }
}

function assertNumericValues(rows, label) {
  for (const row of rows) {
    assert(typeof row.value === "number" && Number.isFinite(row.value), `${label} row value is not numeric.`);
  }
}

function expectStatus(response, expectedStatus, label) {
  assert(
    response.status === expectedStatus,
    `${label} expected HTTP ${expectedStatus} but got ${response.status}: ${JSON.stringify(response.json)}`,
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitFor(fn, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await sleep(1000);
  }
  throw new Error(`Timed out while waiting for ${label}.`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
