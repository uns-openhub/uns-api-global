import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BUCKET_AGGREGATE,
  DEFAULT_COUNTER_RESET_POLICY,
  DEFAULT_HISTORY_TRANSFORM,
  HttpError,
  buildBucketSql,
  buildBoundaryCounterDeltaResponse,
  buildCounterDeltaBucketSql,
  buildCounterDeltaRawSql,
  buildCounterDeltaSourceSql,
  buildDataColumnList,
  buildDataSql,
  buildDedupePartitionColumns,
  buildSourceCountSql,
  buildSourceSql,
  buildSummaryAggregateSql,
  buildSummaryBoundarySql,
  buildTimeOrder,
  buildWhere,
  canApplyDedupe,
  clampLimit,
  computeCounterDeltaValue,
  counterBoundarySourceRange,
  deriveBucketMs,
  escapeLiteral,
  estimateBucketCount,
  extractAccessRules,
  extractBearerToken,
  extractQueryParams,
  extractScanRowCount,
  extractScopeSet,
  getQuestDbColumnNames,
  hasQueryValue,
  isNumericQuestDbType,
  isTopicAllowedByAccessRules,
  isSwaggerDefinitionRequest,
  mapQuestDbRowsToObjects,
  normalizeBasePath,
  normalizeIsoTimestamp,
  normalizeRange,
  normalizeRequestPath,
  normalizeTopicPath,
  parseAggregateMode,
  parseCounterResetPolicy,
  parseHistoryTransformMode,
  parsePositiveIntegerParam,
  parseTimeFieldPreference,
  parseUnsPath,
  quoteIdentifier,
  resolveMetricColumn,
  resolveRequestId,
  resolveTemporalStrategy,
  resolveTrend,
  resolveUnitColumn,
  sanitizeTable,
  stripDatasetFromQuestDbResponse,
  toBoolean,
  toNumber,
  toNullableString,
  type TableSchema,
} from "../src/catchall-helpers.js";

function makeSchema(columns: Array<[string, string?]>): TableSchema {
  return {
    columns: new Set(columns.map(([name]) => name)),
    orderedColumns: columns.map(([name]) => name),
    columnTypes: new Map(columns.map(([name, type]) => [name, type ?? "SYMBOL"])),
  };
}

const rawSchema = makeSchema([
  ["topic", "SYMBOL"],
  ["attribute", "SYMBOL"],
  ["asset", "SYMBOL"],
  ["objectType", "SYMBOL"],
  ["objectId", "SYMBOL"],
  ["valueType", "SYMBOL"],
  ["value", "DOUBLE"],
  ["numberValue", "DOUBLE"],
  ["uom", "VARCHAR"],
  ["timestamp", "TIMESTAMP"],
  ["interval", "LONG"],
  ["deleted", "BOOLEAN"],
  ["lastSeen", "TIMESTAMP"],
]);

test("path and query helpers normalize controller-style requests", () => {
  assert.equal(normalizeBasePath("api/catchall/"), "/api/catchall");
  assert.equal(
    normalizeTopicPath(
      "/api/catchall/enterprise%2Fsite%2Farea%2Ftp-1%2Fenergy-resource%2Fmain%2Fcurrent/",
      "/api/catchall",
    ),
    "enterprise/site/area/tp-1/energy-resource/main/current",
  );

  const query = extractQueryParams({
    query: { limit: "3", summaryOnly: false },
    originalUrl: "/api/catchall/foo?table=uns_sensor_data&bucketMs=60000",
    url: "/api/catchall/foo?table=ignored",
  });
  assert.deepEqual(query, {
    limit: "3",
    summaryOnly: false,
    table: "uns_sensor_data",
    bucketMs: "60000",
  });

  assert.deepEqual(parseUnsPath("enterprise/site/area/tp-1/energy-resource/main/current"), {
    fullPath: "enterprise/site/area/tp-1/energy-resource/main/current",
    topic: "enterprise/site/area",
    asset: "tp-1",
    objectType: "energy-resource",
    objectId: "main",
    attribute: "current",
  });
});

test("sub-asset paths keep parent assets in topic and leaf asset in asset", () => {
  const parsed = parseUnsPath("enterprise/site/area/line/furnace-1/material/main/daily-production");

  assert.deepEqual(parsed, {
    fullPath: "enterprise/site/area/line/furnace-1/material/main/daily-production",
    topic: "enterprise/site/area/line",
    asset: "furnace-1",
    objectType: "material",
    objectId: "main",
    attribute: "daily-production",
  });

  const where = buildWhere(
    parsed,
    { from: "2026-06-19T10:00:00.000Z", to: "2026-06-19T11:00:00.000Z" },
    resolveTemporalStrategy(rawSchema, "timestamp"),
    rawSchema,
  );

  assert.match(where, /"topic" = 'enterprise\/site\/area\/line'/);
  assert.match(where, /"asset" = 'furnace-1'/);
  assert.match(where, /"objectType" = 'material'/);
  assert.match(where, /"objectId" = 'main'/);
  assert.match(where, /"attribute" = 'daily-production'/);
});

test("Nested asset catch-all SQL filters by parent topic and leaf asset", () => {
  const parsed = parseUnsPath("enterprise/site/area/wash-line/pump-skid-1/equipment/main/temperature");
  assert.deepEqual(parsed, {
    fullPath: "enterprise/site/area/wash-line/pump-skid-1/equipment/main/temperature",
    topic: "enterprise/site/area/wash-line",
    asset: "pump-skid-1",
    objectType: "equipment",
    objectId: "main",
    attribute: "temperature",
  });

  const temporal = resolveTemporalStrategy(rawSchema, "timestamp");
  const range = {
    from: "2026-06-19T13:00:00.000Z",
    to: "2026-06-19T14:00:00.000Z",
  };
  const rawSql = buildDataSql("uns_sensor_data", parsed, range, 50, true, rawSchema, temporal).replace(/\s+/g, " ").trim();

  assert.match(rawSql, /WHERE "topic" = 'enterprise\/site\/area\/wash-line'/);
  assert.match(rawSql, /"asset" = 'pump-skid-1'/);
  assert.match(rawSql, /"objectType" = 'equipment'/);
  assert.match(rawSql, /"objectId" = 'main'/);
  assert.match(rawSql, /"attribute" = 'temperature'/);
  assert.match(rawSql, /LATEST ON "timestamp" PARTITION BY "topic", "asset", "objectType", "objectId", "attribute"/);
  assert.doesNotMatch(rawSql, /pump-skid-1\/equipment/);
});

test("basic parsing and validation helpers reject invalid input", () => {
  assert.equal(toNumber("42"), 42);
  assert.equal(toNumber("nope"), null);
  assert.equal(toBoolean("true"), true);
  assert.equal(toBoolean("yes"), true);
  assert.equal(toBoolean("0"), false);
  assert.equal(hasQueryValue(""), false);
  assert.equal(hasQueryValue("x"), true);
  assert.equal(clampLimit("200", 50, 100), 100);
  assert.equal(clampLimit(undefined, 50, 100), 50);
  assert.equal(sanitizeTable("uns_sensor_data"), "uns_sensor_data");
  assert.equal(sanitizeTable("uns_line-1-avg-temp_data"), "uns_line-1-avg-temp_data");
  assert.equal(sanitizeTable("bad table"), null);
  assert.equal(escapeLiteral("O'Hara"), "'O''Hara'");
  assert.equal(quoteIdentifier('bad"name'), '"bad""name"');
  assert.equal(DEFAULT_BUCKET_AGGREGATE, "last");
  assert.equal(DEFAULT_HISTORY_TRANSFORM, "raw");
  assert.equal(DEFAULT_COUNTER_RESET_POLICY, "new-value");

  assert.equal(parseTimeFieldPreference(undefined), "auto");
  assert.equal(parseTimeFieldPreference("interval"), "interval");
  assert.equal(parseAggregateMode(undefined), null);
  assert.equal(parseAggregateMode("SUM"), "sum");
  assert.equal(parseHistoryTransformMode(undefined), "raw");
  assert.equal(parseHistoryTransformMode("DELTA"), "delta");
  assert.equal(parseCounterResetPolicy(undefined), "new-value");
  assert.equal(parseCounterResetPolicy("null"), "null");
  assert.equal(parsePositiveIntegerParam("120", "maxPoints"), 120);

  assert.throws(() => parseTimeFieldPreference("bad"), (error: unknown) => {
    return error instanceof HttpError && error.status === 400;
  });
  assert.throws(() => parseAggregateMode("median"), (error: unknown) => {
    return error instanceof HttpError && error.status === 400;
  });
  assert.throws(() => parseHistoryTransformMode("rate"), (error: unknown) => {
    return error instanceof HttpError && error.status === 400;
  });
  assert.throws(() => parseCounterResetPolicy("rollover"), (error: unknown) => {
    return error instanceof HttpError && error.status === 400;
  });
  assert.throws(() => parsePositiveIntegerParam("0", "bucketMs"), (error: unknown) => {
    return error instanceof HttpError && error.status === 400;
  });
});

test("normalizeRange enforces lookback rules and swaps reversed bounds", () => {
  const swapped = normalizeRange("2026-03-07T12:00:00.000Z", "2026-03-07T10:00:00.000Z", {
    defaultLookbackHours: 24,
    maxLookbackHours: 168,
  });
  assert.equal(swapped.from, "2026-03-07T10:00:00.000Z");
  assert.equal(swapped.to, "2026-03-07T12:00:00.000Z");

  assert.throws(() => normalizeRange("bad", undefined, { defaultLookbackHours: 24, maxLookbackHours: 168 }), (error: unknown) => {
    return error instanceof HttpError && error.status === 400;
  });

  assert.throws(
    () =>
      normalizeRange("2026-03-01T00:00:00.000Z", "2026-03-10T00:00:00.000Z", {
        defaultLookbackHours: 24,
        maxLookbackHours: 24,
      }),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});

test("temporal strategy uses timestamp by default and interval only when requested", () => {
  const intervalSchema = makeSchema([
    ["topic", "SYMBOL"],
    ["intervalStart", "TIMESTAMP"],
    ["intervalEnd", "TIMESTAMP"],
    ["timestamp", "TIMESTAMP"],
  ]);
  assert.deepEqual(resolveTemporalStrategy(intervalSchema, "auto"), {
    mode: "timestamp",
    fromColumn: "timestamp",
    toColumn: "timestamp",
    orderBy: '"timestamp" DESC',
  });
  assert.deepEqual(resolveTemporalStrategy(intervalSchema, "interval"), {
    mode: "interval",
    fromColumn: "intervalStart",
    toColumn: "intervalEnd",
    orderBy: '"intervalStart" DESC, "timestamp" DESC',
  });

  assert.equal(resolveTemporalStrategy(rawSchema, "auto").mode, "timestamp");
  assert.throws(
    () => resolveTemporalStrategy(rawSchema, "interval"),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});

test("raw mode SQL covers the simplest latest 3 records from/to use case", () => {
  const parsed = parseUnsPath("enterprise/site/area/tp-1/energy-resource/main/current");
  const temporal = resolveTemporalStrategy(rawSchema, "timestamp");
  const range = {
    from: "2026-03-06T10:00:00.000Z",
    to: "2026-03-06T11:00:00.000Z",
  };

  const rawSql = buildDataSql("uns_sensor_data", parsed, range, 3, false, rawSchema, temporal).replace(/\s+/g, " ").trim();
  assert.match(rawSql, /WHERE "topic" = 'enterprise\/site\/area'/);
  assert.match(rawSql, /"attribute" = 'current'/);
  assert.match(rawSql, /"timestamp" >= '2026-03-06T10:00:00.000Z'/);
  assert.match(rawSql, /"timestamp" <= '2026-03-06T11:00:00.000Z'/);
  assert.match(rawSql, /ORDER BY "timestamp" DESC LIMIT 3$/);
  assert.equal(rawSql.includes("LATEST ON"), false);

  const dedupedSql = buildDataSql("uns_sensor_data", parsed, range, 3, true, rawSchema, temporal).replace(/\s+/g, " ").trim();
  assert.match(dedupedSql, /LATEST ON "timestamp" PARTITION BY "topic", "asset", "objectType", "objectId", "attribute"/);
});

test("schema-aware raw helpers keep preferred columns first and apply dedupe only when possible", () => {
  assert.deepEqual(buildDataColumnList(rawSchema), [
    "topic",
    "attribute",
    "asset",
    "objectType",
    "objectId",
    "valueType",
    "value",
    "numberValue",
    "uom",
    "timestamp",
    "interval",
    "deleted",
    "lastSeen",
  ]);

  assert.deepEqual(buildDedupePartitionColumns(rawSchema), [
    "topic",
    "asset",
    "objectType",
    "objectId",
    "attribute",
  ]);

  assert.equal(canApplyDedupe(true, rawSchema), true);
  assert.equal(canApplyDedupe(false, rawSchema), false);
  assert.equal(canApplyDedupe(true, makeSchema([["topic"], ["attribute"]])), false);
});

test("where clause falls back to topic-only tables and rejects schemas without UNS path columns", () => {
  const topicOnlySchema = makeSchema([
    ["topic", "SYMBOL"],
    ["timestamp", "TIMESTAMP"],
  ]);
  const where = buildWhere(
    parseUnsPath("enterprise/site/area/tp-1/energy-resource/main/current"),
    { from: "2026-03-06T10:00:00.000Z", to: "2026-03-06T11:00:00.000Z" },
    resolveTemporalStrategy(topicOnlySchema, "timestamp"),
    topicOnlySchema,
  );
  assert.match(where, /^"topic" = 'enterprise\/site\/area'/);

  const fallbackWhere = buildWhere(
    { fullPath: "enterprise/site/area/topic-only" },
    { from: "2026-03-06T10:00:00.000Z", to: "2026-03-06T11:00:00.000Z" },
    resolveTemporalStrategy(topicOnlySchema, "timestamp"),
    topicOnlySchema,
  );
  assert.match(fallbackWhere, /^"topic" = 'enterprise\/site\/area\/topic-only'/);

  assert.throws(
    () =>
      buildWhere(
        parseUnsPath("enterprise/site/area/tp-1/energy-resource/main/current"),
        { from: "2026-03-06T10:00:00.000Z", to: "2026-03-06T11:00:00.000Z" },
        { mode: "timestamp", fromColumn: "timestamp", toColumn: "timestamp", orderBy: '"timestamp" DESC' },
        makeSchema([["timestamp", "TIMESTAMP"]]),
      ),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});

test("metric resolution handles attribute-specific, fallback, single dynamic, and error cases", () => {
  const attributeSchema = makeSchema([
    ["topic", "SYMBOL"],
    ["current", "DOUBLE"],
    ["uom", "VARCHAR"],
    ["timestamp", "TIMESTAMP"],
  ]);
  assert.equal(resolveMetricColumn(attributeSchema, parseUnsPath("enterprise/site/area/tp-1/energy-resource/main/current")), "current");
  assert.equal(resolveUnitColumn(attributeSchema), "uom");

  assert.equal(resolveMetricColumn(rawSchema, parseUnsPath("enterprise/site/area/tp-1/energy-resource/main/current")), "numberValue");

  const singleDynamicNumeric = makeSchema([
    ["topic", "SYMBOL"],
    ["pressure", "DOUBLE"],
    ["timestamp", "TIMESTAMP"],
  ]);
  assert.equal(resolveMetricColumn(singleDynamicNumeric, parseUnsPath("enterprise/site/area/tp-1/energy-resource/main/current")), "pressure");

  const noNumeric = makeSchema([
    ["topic", "SYMBOL"],
    ["status", "SYMBOL"],
    ["timestamp", "TIMESTAMP"],
  ]);
  assert.throws(
    () => resolveMetricColumn(noNumeric, parseUnsPath("enterprise/site/area/tp-1/energy-resource/main/current")),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );

  const ambiguous = makeSchema([
    ["topic", "SYMBOL"],
    ["currentA", "DOUBLE"],
    ["currentB", "DOUBLE"],
    ["timestamp", "TIMESTAMP"],
  ]);
  assert.throws(
    () => resolveMetricColumn(ambiguous, parseUnsPath("enterprise/site/area/tp-1/energy-resource/main/current")),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});

test("bucket derivation and SQL generation support aggregate chart output", () => {
  const range = { from: "2026-03-06T10:00:00.000Z", to: "2026-03-06T11:00:00.000Z" };
  const bucketMs = deriveBucketMs(range, 120);
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  assert.equal(estimateBucketCount(fromMs, toMs, bucketMs) <= 120, true);
  assert.equal(bucketMs > 0, true);

  const sourceSql = buildSourceSql(
    "uns_sensor_data",
    parseUnsPath("enterprise/site/area/tp-1/energy-resource/main/current"),
    range,
    false,
    rawSchema,
    resolveTemporalStrategy(rawSchema, "timestamp"),
    ["numberValue", "uom"],
  );
  const bucketSql = buildBucketSql(
    sourceSql,
    resolveTemporalStrategy(rawSchema, "timestamp"),
    "numberValue",
    "uom",
    "avg",
    60000,
  ).replace(/\s+/g, " ").trim();
  assert.match(bucketSql, /timestamp_floor\('60000T', "timestamp"\) AS bucketTimestamp/);
  assert.match(bucketSql, /avg\("numberValue"\) AS value/);
  assert.match(bucketSql, /last\("uom"\) AS uom/);
  assert.match(bucketSql, /ORDER BY 1 ASC$/);
});

test("counter delta SQL derives raw row deltas at query time", () => {
  const parsed = parseUnsPath("enterprise/site/area/tp-1/energy-resource/main/current");
  const temporal = resolveTemporalStrategy(rawSchema, "timestamp");
  const range = {
    from: "2026-03-06T10:00:00.000Z",
    to: "2026-03-06T11:00:00.000Z",
  };
  const sourceSql = buildSourceSql("uns_sensor_data", parsed, range, false, rawSchema, temporal, ["numberValue", "uom"]);

  const deltaSourceSql = buildCounterDeltaSourceSql(sourceSql, temporal, "numberValue", "uom", "new-value")
    .replace(/\s+/g, " ")
    .trim();
  assert.match(deltaSourceSql, /lag\("numberValue"\) OVER \(ORDER BY "timestamp" ASC\) AS "previousCounterValue"/);
  assert.match(deltaSourceSql, /"previousCounterValue" IS NOT NULL/);
  assert.match(deltaSourceSql, /ELSE "counterValue" END AS "value"/);
  assert.match(deltaSourceSql, /"uom" AS "uom"/);

  const rawDeltaSql = buildCounterDeltaRawSql(deltaSourceSql, 50).replace(/\s+/g, " ").trim();
  assert.match(rawDeltaSql, /ORDER BY "timestamp" DESC LIMIT 50$/);

  const bucketDeltaSql = buildCounterDeltaBucketSql(deltaSourceSql, "uom", 60000).replace(/\s+/g, " ").trim();
  assert.match(bucketDeltaSql, /timestamp_floor\('60000T', "timestamp"\) AS bucketTimestamp/);
  assert.match(bucketDeltaSql, /sum\("value"\) AS value/);
  assert.match(bucketDeltaSql, /last\("uom"\) AS uom/);
  assert.match(bucketDeltaSql, /ORDER BY 1 ASC$/);

  const nullResetSql = buildCounterDeltaSourceSql(sourceSql, temporal, "numberValue", null, "null")
    .replace(/\s+/g, " ")
    .trim();
  assert.match(nullResetSql, /ELSE null END AS "value"/);
  assert.match(nullResetSql, /AND "counterValue" >= "previousCounterValue"/);
});

test("counter delta value derives live deltas from adjacent counter states", () => {
  assert.deepEqual(computeCounterDeltaValue(120, 100, "new-value"), {
    absoluteValue: 120,
    previousValue: 100,
    delta: 20,
    reset: false,
  });
  assert.deepEqual(computeCounterDeltaValue(10, 120, "new-value"), {
    absoluteValue: 10,
    previousValue: 120,
    delta: 10,
    reset: true,
  });
  assert.deepEqual(computeCounterDeltaValue(10, 120, "null"), {
    absoluteValue: 10,
    previousValue: 120,
    delta: null,
    reset: true,
  });
  assert.deepEqual(computeCounterDeltaValue(120, null, "new-value"), {
    absoluteValue: 120,
    previousValue: null,
    delta: null,
    reset: false,
  });
  assert.equal(computeCounterDeltaValue("not-a-number", 100, "new-value"), null);
});

test("counter boundary source range expands around full buckets only", () => {
  assert.deepEqual(
    counterBoundarySourceRange(
      {
        from: "2026-03-06T10:00:30.000Z",
        to: "2026-03-06T10:02:30.000Z",
      },
      60_000,
    ),
    {
      from: "2026-03-06T09:59:00.000Z",
      to: "2026-03-06T10:04:00.000Z",
    },
  );

  const range = {
    from: "2026-03-06T10:00:00.000Z",
    to: "2026-03-06T10:00:30.000Z",
  };
  assert.deepEqual(counterBoundarySourceRange(range, 60_000), range);
});

test("counter boundary response interpolates bucket edges and skips partial buckets", () => {
  const temporal = resolveTemporalStrategy(rawSchema, "timestamp");
  const sourceResult = {
    data: [
      ["2026-03-06T09:59:00.000Z", 90, "Nm3"],
      ["2026-03-06T10:00:00.000Z", 100, "Nm3"],
      ["2026-03-06T10:00:59.000Z", 110, "Nm3"],
      ["2026-03-06T10:01:02.000Z", 120, "Nm3"],
      ["2026-03-06T10:02:00.000Z", 130, "Nm3"],
      ["2026-03-06T10:03:00.000Z", 140, "Nm3"],
    ],
    raw: {
      columns: [
        { name: "timestamp", type: "TIMESTAMP" },
        { name: "numberValue", type: "DOUBLE" },
        { name: "uom", type: "STRING" },
      ],
      count: 6,
    },
  };

  const exactRange = buildBoundaryCounterDeltaResponse(
    sourceResult,
    "SELECT raw counter rows",
    {
      from: "2026-03-06T10:00:00.000Z",
      to: "2026-03-06T10:02:00.000Z",
    },
    temporal,
    "numberValue",
    "uom",
    60_000,
    "new-value",
  );
  assert.equal(exactRange.data.length, 2);
  assert.deepEqual((exactRange.raw.columns as Array<{ name: string }>).map(column => column.name), [
    "timestamp",
    "value",
    "uom",
  ]);
  assert.equal((exactRange.data[0] as unknown[])[0], "2026-03-06T10:00:00.000Z");
  assert.ok(Math.abs(Number((exactRange.data[0] as unknown[])[1]) - 13.333333333333329) < 1e-9);
  assert.equal((exactRange.data[0] as unknown[])[2], "Nm3");
  assert.equal((exactRange.data[1] as unknown[])[0], "2026-03-06T10:01:00.000Z");
  assert.ok(Math.abs(Number((exactRange.data[1] as unknown[])[1]) - 16.66666666666667) < 1e-9);

  const partialRange = buildBoundaryCounterDeltaResponse(
    sourceResult,
    "SELECT raw counter rows",
    {
      from: "2026-03-06T10:00:30.000Z",
      to: "2026-03-06T10:02:30.000Z",
    },
    temporal,
    "numberValue",
    "uom",
    60_000,
    "new-value",
  );
  assert.deepEqual(
    partialRange.data.map(row => (row as unknown[])[0]),
    ["2026-03-06T10:01:00.000Z"],
  );
});

test("counter boundary response handles resets by policy", () => {
  const temporal = resolveTemporalStrategy(rawSchema, "timestamp");
  const sourceResult = {
    data: [
      ["2026-03-06T10:00:00.000Z", 100],
      ["2026-03-06T10:01:00.000Z", 120],
      ["2026-03-06T10:02:00.000Z", 10],
      ["2026-03-06T10:03:00.000Z", 30],
    ],
    raw: {
      columns: [
        { name: "timestamp", type: "TIMESTAMP" },
        { name: "numberValue", type: "DOUBLE" },
      ],
      count: 4,
    },
  };
  const range = {
    from: "2026-03-06T10:00:00.000Z",
    to: "2026-03-06T10:03:00.000Z",
  };

  const newValue = buildBoundaryCounterDeltaResponse(
    sourceResult,
    "SELECT reset counter rows",
    range,
    temporal,
    "numberValue",
    null,
    60_000,
    "new-value",
  );
  assert.deepEqual(newValue.data.map(row => (row as unknown[])[1]), [20, 10, 20]);

  const nullPolicy = buildBoundaryCounterDeltaResponse(
    sourceResult,
    "SELECT reset counter rows",
    range,
    temporal,
    "numberValue",
    null,
    60_000,
    "null",
  );
  assert.deepEqual(nullPolicy.data.map(row => (row as unknown[])[1]), [20, 0, 20]);
});

test("summary SQL and formatting helpers support full-range summaries", () => {
  const temporal = resolveTemporalStrategy(rawSchema, "timestamp");
  const summaryAggregateSql = buildSummaryAggregateSql("SELECT * FROM foo", "numberValue").replace(/\s+/g, " ").trim();
  assert.match(summaryAggregateSql, /^SELECT count\(\) AS sampleCount, avg\("numberValue"\) AS avgValue,/);

  const boundarySql = buildSummaryBoundarySql("SELECT * FROM foo", temporal, "numberValue", "uom", "DESC").replace(/\s+/g, " ").trim();
  assert.match(boundarySql, /"timestamp" AS boundaryTimestamp/);
  assert.match(boundarySql, /"numberValue" AS boundaryValue/);
  assert.match(boundarySql, /"uom" AS boundaryUom/);
  assert.match(boundarySql, /ORDER BY "timestamp" DESC LIMIT 1$/);

  assert.equal(buildTimeOrder(temporal, "ASC"), '"timestamp" ASC');
  assert.equal(buildSourceCountSql("SELECT * FROM foo").replace(/\s+/g, " ").trim(), 'SELECT count() AS sourceRowCount FROM (SELECT * FROM foo)');
  assert.equal(normalizeIsoTimestamp("2026-03-06T10:47:41.610000Z"), "2026-03-06T10:47:41.610Z");
  assert.equal(toNullableString(" A "), "A");
  assert.equal(resolveTrend(1, 2), "rising");
  assert.equal(resolveTrend(2, 1), "falling");
  assert.equal(resolveTrend(2, 2), "steady");
  assert.equal(resolveTrend(null, 2), "unknown");
});

test("QuestDB response helpers map tuple datasets and counts correctly", () => {
  const raw = {
    columns: [
      { name: "topic", type: "SYMBOL" },
      { name: "timestamp", type: "TIMESTAMP" },
      { name: "numberValue", type: "DOUBLE" },
    ],
    count: 3,
  } as Record<string, unknown>;

  assert.deepEqual(getQuestDbColumnNames(raw), ["topic", "timestamp", "numberValue"]);
  assert.deepEqual(mapQuestDbRowsToObjects([["enterprise/site/area", "2026-03-06T10:47:41.610000Z", 2028]], raw), [
    {
      topic: "enterprise/site/area",
      timestamp: "2026-03-06T10:47:41.610000Z",
      numberValue: 2028,
    },
  ]);

  assert.deepEqual(stripDatasetFromQuestDbResponse({ dataset: [1, 2], count: 2 }, "SELECT 1"), {
    count: 2,
    query: "SELECT 1",
  });
  assert.deepEqual(stripDatasetFromQuestDbResponse([1, 2, 3], "SELECT 1"), {
    query: "SELECT 1",
    format: "array",
    rowCount: 3,
  });
  assert.equal(extractScanRowCount({ count: 3, rowCount: 2 }), 3);
});

test("auth and request-id helpers normalize claims and headers", () => {
  const requestId = resolveRequestId(undefined);
  assert.equal(typeof requestId, "string");
  assert.equal(requestId.length > 0, true);
  assert.equal(resolveRequestId(" abc "), "abc");

  assert.equal(extractBearerToken("Bearer token123"), "token123");
  assert.equal(extractBearerToken(["Bearer token456"]), "token456");
  assert.equal(extractBearerToken("Basic nope"), null);

  assert.deepEqual(
    Array.from(
      extractScopeSet({
        scope: "read:uns write:uns",
        scopes: ["UNS:READ"],
        permissions: ["read:*"],
      }),
    ).sort(),
    ["read:*", "read:uns", "uns:read", "write:uns"],
  );

  assert.deepEqual(extractAccessRules({ accessRules: ["#/foo/", " bar "], pathFilter: "/baz/" }), [
    "#/foo",
    "bar",
    "baz",
  ]);

  assert.equal(
    isTopicAllowedByAccessRules("enterprise/site/utilities/north/gas-meter/natural-gas/interval-consumption", ["enterprise/site/utilities/#"]),
    true,
  );
  assert.equal(
    isTopicAllowedByAccessRules("enterprise/site/utilities/north/gas-meter/natural-gas/interval-consumption", [
      "enterprise/site/utilities/bi-export-api/process-segment/energy-consumption/data",
    ]),
    false,
  );
});

test("request path helpers recognize swagger routes and numeric type support", () => {
  assert.equal(normalizeRequestPath("api//catchall///"), "/api/catchall");
  assert.equal(isSwaggerDefinitionRequest("/swagger", undefined), true);
  assert.equal(isSwaggerDefinitionRequest("/docs/catchall-swagger.json", "/uns-api-global/general-api/catchall-swagger.json"), true);
  assert.equal(isSwaggerDefinitionRequest("/api/catchall/enterprise/site/area", "/uns-api-global/general-api/catchall-swagger.json"), false);
  assert.equal(isNumericQuestDbType("DOUBLE"), true);
  assert.equal(isNumericQuestDbType("BOOLEAN"), false);
});
