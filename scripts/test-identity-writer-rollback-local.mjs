#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  buildEntityDataSql,
  parseUnsPath,
  resolveTemporalStrategy,
} from "../dist/catchall-helpers.js";
import {
  detectEntityStorageSchema,
  mergeEntityHistoryRows,
} from "../dist/entity-query-planner.js";

const questDbUrl = new URL(
  process.env["QUESTDB_ROLLBACK_TEST_URL"] ?? "http://localhost:9000",
);
const username = process.env["QUESTDB_ROLLBACK_TEST_USERNAME"];
const password = process.env["QUESTDB_ROLLBACK_TEST_PASSWORD"];
const fromWriterVersion = process.env["IDENTITY_ROLLBACK_FROM_WRITER_VERSION"] ?? "5.2.16";
const toWriterVersion = process.env["IDENTITY_ROLLBACK_TO_WRITER_VERSION"] ?? "5.2.15";
const tableName = `identity_writer_rollback_${Date.now()}_${randomUUID().slice(0, 8)}`;
const stableEntityId = "11111111-1111-4111-8111-111111111111";
const oldTopic = "enterprise/site/line-a/PRESS-14/equipment/main/temperature";
const newTopic = "enterprise/site/line-b/PRESS-14/equipment/main/temperature";
const cutover = "2026-09-01T10:00:00.000Z";
const requestTimeoutMs = 5_000;
let tableCreated = false;

if ((username && !password) || (!username && password)) {
  throw new Error(
    "QUESTDB_ROLLBACK_TEST_USERNAME and QUESTDB_ROLLBACK_TEST_PASSWORD must be provided together.",
  );
}

main().catch(error => {
  console.error(
    `Identity writer rollback smoke failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

async function main() {
  let evidence;
  try {
    await execQuestDb(createArchiverTableSql());
    tableCreated = true;
    await writeIlp(identityAwareLine());
    await writeIlp(legacyWriterLine());
    await waitForRows(2);

    const physicalRows = await execQuestDb(`SELECT * FROM "${tableName}" ORDER BY time`);
    const schema = tableSchemaFromResponse(physicalRows);
    assert.deepEqual(detectEntityStorageSchema(schema.columns), {
      mode: "identity-aware",
      stableEntityColumn: "stableEntityId",
      bindingColumn: "identityBindingRevision",
      missingColumns: [],
    });

    const oldSegment = await runEntityIntervalQuery(schema, oldTopic, {
      from: "2026-09-01T09:00:00.000Z",
      to: cutover,
      toExclusive: true,
    });
    const newSegment = await runEntityIntervalQuery(schema, newTopic, {
      from: cutover,
      to: "2026-09-01T11:00:00.000Z",
    });
    const merged = mergeEntityHistoryRows([oldSegment, newSegment], 10);
    const columnIndex = indexColumns(merged.columns);

    assert.equal(merged.rows.length, 2, "dual reader must return both pre- and post-rollback rows");
    assert.deepEqual(
      merged.rows.map(row => row[columnIndex.numberValue]),
      [11, 10],
      "entity history must remain in descending event-time order",
    );
    assert.equal(
      merged.rows[0]?.[columnIndex.stableEntityId],
      null,
      "the post-rollback writer row must remain valid without identity evidence",
    );
    assert.equal(
      merged.rows[1]?.[columnIndex.stableEntityId],
      stableEntityId,
      "the pre-rollback identity evidence must be retained",
    );

    evidence = {
      writerRollback: `${fromWriterVersion} -> ${toWriterVersion}`,
      storageSchema: "identity-aware with nullable identity evidence",
      rowsRead: merged.rows.length,
      identityAwareRows: 1,
      legacyRowsAfterRollback: 1,
      bindingBoundary: cutover,
      temporaryTableRemoved: true,
    };
  } finally {
    if (tableCreated) {
      await execQuestDb(`DROP TABLE "${tableName}"`);
    }
  }
  console.log("Identity writer rollback smoke passed.");
  console.log(JSON.stringify(evidence, null, 2));
}

function createArchiverTableSql() {
  return `CREATE TABLE "${tableName}" (`
    + '"time" TIMESTAMP,'
    + '"topic" SYMBOL,'
    + '"attribute" SYMBOL,'
    + '"asset" SYMBOL,'
    + '"objectType" SYMBOL,'
    + '"objectId" SYMBOL,'
    + '"numberValue" DOUBLE,'
    + '"fullTopic" STRING'
    + ') TIMESTAMP("time") PARTITION BY DAY';
}

function identityAwareLine() {
  return [
    `${tableName},topic=enterprise/site/line-a,asset=PRESS-14,objectType=equipment,objectId=main,attribute=temperature,stableEntityId=${stableEntityId},entityTypeKey=openhub.asset,identityResolution=resolved,identityTimeBasis=source-event-time,identityBindingRevision=7`,
    `numberValue=10.0,fullTopic="${oldTopic}",identityBindingDigest="sha256:${"1".repeat(64)}"`,
    toNanoseconds("2026-09-01T09:59:00.000Z"),
  ].join(" ");
}

function legacyWriterLine() {
  return [
    `${tableName},topic=enterprise/site/line-b,asset=PRESS-14,objectType=equipment,objectId=main,attribute=temperature`,
    `numberValue=11.0,fullTopic="${newTopic}"`,
    toNanoseconds("2026-09-01T10:01:00.000Z"),
  ].join(" ");
}

function toNanoseconds(value) {
  return String(BigInt(new Date(value).getTime()) * 1_000_000n);
}

async function writeIlp(line) {
  const url = new URL("/write", questDbUrl);
  url.searchParams.set("precision", "n");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...authorizationHeader(),
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: `${line}\n`,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`QuestDB ILP write returned HTTP ${response.status}: ${await response.text()}`);
  }
}

async function execQuestDb(query) {
  const url = new URL("/exec", questDbUrl);
  url.searchParams.set("query", query);
  const response = await fetch(url, {
    headers: authorizationHeader(),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`QuestDB returned a non-JSON response for ${query}: ${body}`);
  }
  if (!response.ok || payload?.error) {
    throw new Error(`QuestDB query failed for ${query}: ${payload?.error ?? `HTTP ${response.status}`}`);
  }
  return payload;
}

function authorizationHeader() {
  if (!username || !password) return {};
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

async function waitForRows(expected) {
  const deadline = Date.now() + requestTimeoutMs;
  while (Date.now() < deadline) {
    const response = await execQuestDb(`SELECT count() AS rowCount FROM "${tableName}"`);
    if (Number(response?.dataset?.[0]?.[0]) === expected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`QuestDB did not expose ${expected} rows within ${requestTimeoutMs}ms`);
}

function tableSchemaFromResponse(response) {
  assert.ok(Array.isArray(response?.columns), "QuestDB response must include columns");
  const columns = response.columns.map(column => String(column.name));
  return {
    columns: new Set(columns),
    orderedColumns: columns,
    columnTypes: new Map(response.columns.map(column => [String(column.name), String(column.type)])),
  };
}

async function runEntityIntervalQuery(schema, topic, range) {
  const sql = buildEntityDataSql(
    tableName,
    stableEntityId,
    parseUnsPath(topic),
    range,
    10,
    false,
    schema,
    resolveTemporalStrategy(schema, "auto"),
  );
  const response = await execQuestDb(sql);
  return {
    columns: response.columns.map(column => String(column.name)),
    rows: response.dataset,
  };
}

function indexColumns(columns) {
  const indexes = Object.fromEntries(columns.map((column, index) => [column, index]));
  for (const required of ["numberValue", "stableEntityId"]) {
    assert.notEqual(indexes[required], undefined, `QuestDB result is missing ${required}`);
  }
  return indexes;
}
