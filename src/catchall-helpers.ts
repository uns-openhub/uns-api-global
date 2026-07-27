import { randomUUID } from "node:crypto";
import { UnsTopicMatcher } from "@uns-kit/core/uns/uns-topic-matcher.js";

export type TimeRange = { from?: string; to?: string; note?: string };
export type TimeFieldPreference = "auto" | "timestamp" | "interval";
export type AggregateMode = "avg" | "min" | "max" | "last" | "sum" | "count";
export type HistoryTransformMode = "raw" | "delta";
export type CounterResetPolicy = "new-value" | "null";
export type SummaryTrend = "rising" | "falling" | "steady" | "unknown";

export type QuestDbRangeConfig = {
  defaultLookbackHours: number;
  maxLookbackHours: number;
};

export type ParsedPath = {
  fullPath: string;
  topic?: string | undefined;
  asset?: string | undefined;
  objectType?: string | undefined;
  objectId?: string | undefined;
  attribute?: string | undefined;
};

export type TableSchema = {
  columns: Set<string>;
  orderedColumns: string[];
  columnTypes: Map<string, string>;
};

export type TemporalStrategy = {
  mode: "timestamp" | "interval";
  fromColumn: string;
  toColumn: string;
  orderBy: string;
};

export type QuestDbHistoryResponse = {
  data: unknown[];
  raw: Record<string, unknown>;
};

export type CounterDeltaValue = {
  absoluteValue: number;
  previousValue: number | null;
  delta: number | null;
  reset: boolean;
};

type CounterBoundarySample = {
  timestampMs: number;
  rawValue: number;
  unwrappedValue: number;
  uom: string | null;
};

export type RequestQueryLike = {
  query?: Record<string, unknown> | undefined;
  originalUrl?: unknown;
  url?: unknown;
};

export type JwtClaimsLike = {
  accessRules?: unknown;
  pathFilter?: unknown;
  scope?: unknown;
  scopes?: unknown;
  permissions?: unknown;
};

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_BUCKET_AGGREGATE: AggregateMode = "last";
export const DEFAULT_HISTORY_TRANSFORM: HistoryTransformMode = "raw";
export const DEFAULT_COUNTER_RESET_POLICY: CounterResetPolicy = "new-value";

const NUMERIC_QUESTDB_TYPES = new Set(["BYTE", "SHORT", "INT", "LONG", "FLOAT", "DOUBLE"]);
const NON_VALUE_COLUMNS = new Set([
  "topic",
  "asset",
  "objectType",
  "objectId",
  "attribute",
  "valueType",
  "uom",
  "unit",
  "time",
  "timestamp",
  "intervalStart",
  "intervalEnd",
  "interval",
]);

export function normalizeBasePath(pathValue: string): string {
  const trimmed = pathValue.trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}

export function normalizeTopicPath(rawPath: string, basePath: string): string {
  const stripLeading = (value: string) => value.replace(/^\/+/, "");
  const base = stripLeading(basePath);
  let cleaned = stripLeading(rawPath);
  if (cleaned.startsWith(base)) {
    cleaned = cleaned.slice(base.length);
  }
  cleaned = cleaned.replace(/^\/+/, "").replace(/\/+$/, "");
  cleaned = cleaned.replace(/^api\/catchall\//, "");
  cleaned = cleaned.replace(/^catchall\//, "");
  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned;
  }
}

export function extractQueryParams(req: RequestQueryLike | null | undefined): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  const addValue = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length > 0) merged[key] = value[0];
      return;
    }
    merged[key] = value;
  };

  if (req?.query && typeof req.query === "object") {
    for (const [key, value] of Object.entries(req.query)) {
      addValue(key, value);
    }
  }

  const parseFromUrl = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const idx = raw.indexOf("?");
    if (idx < 0) return;
    const qs = raw.slice(idx + 1);
    if (!qs.length) return;
    const params = new URLSearchParams(qs);
    for (const [key, value] of params.entries()) {
      if (!(key in merged)) merged[key] = value;
    }
  };

  parseFromUrl(req?.originalUrl);
  parseFromUrl(req?.url);
  return merged;
}

export function parseUnsPath(path: string): ParsedPath {
  const cleaned = path.replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (!parts.length) return { fullPath: cleaned };
  const attribute = parts.pop();
  const objectId = parts.pop();
  const objectType = parts.pop();
  const asset = parts.pop();
  const topic = parts.join("/");
  return {
    fullPath: cleaned,
    topic: topic || undefined,
    asset: asset || undefined,
    objectType: objectType || undefined,
    objectId: objectId || undefined,
    attribute: attribute || undefined,
  };
}

export function clampLimit(value: unknown, fallback: number, max: number): number {
  const num = toNumber(value);
  if (num === null) return fallback;
  return Math.min(max, Math.max(1, Math.floor(num)));
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  }
  return false;
}

export function parseTimeFieldPreference(value: unknown): TimeFieldPreference {
  if (value === undefined || value === null) return "auto";
  if (typeof value !== "string") {
    throw new HttpError(400, "Invalid query param: timeField (allowed: auto|timestamp|interval)");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "auto";
  if (normalized === "auto" || normalized === "timestamp" || normalized === "interval") return normalized;
  throw new HttpError(400, "Invalid query param: timeField (allowed: auto|timestamp|interval)");
}

export function parseAggregateMode(value: unknown): AggregateMode | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "Invalid query param: aggregate (allowed: avg|min|max|last|sum|count)");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "avg" ||
    normalized === "min" ||
    normalized === "max" ||
    normalized === "last" ||
    normalized === "sum" ||
    normalized === "count"
  ) {
    return normalized;
  }
  throw new HttpError(400, "Invalid query param: aggregate (allowed: avg|min|max|last|sum|count)");
}

export function parseHistoryTransformMode(value: unknown): HistoryTransformMode {
  if (value === undefined || value === null) return DEFAULT_HISTORY_TRANSFORM;
  if (typeof value !== "string") {
    throw new HttpError(400, "Invalid query param: transform (allowed: raw|delta)");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "raw") return "raw";
  if (normalized === "delta") return "delta";
  throw new HttpError(400, "Invalid query param: transform (allowed: raw|delta)");
}

export function parseCounterResetPolicy(value: unknown): CounterResetPolicy {
  if (value === undefined || value === null) return DEFAULT_COUNTER_RESET_POLICY;
  if (typeof value !== "string") {
    throw new HttpError(400, "Invalid query param: counterResetPolicy (allowed: new-value|null)");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "new-value") return "new-value";
  if (normalized === "null") return "null";
  if (normalized === "rollover") {
    throw new HttpError(400, "counterResetPolicy=rollover is not supported yet; use new-value or null.");
  }
  throw new HttpError(400, "Invalid query param: counterResetPolicy (allowed: new-value|null)");
}

export function hasQueryValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export function parsePositiveIntegerParam(value: unknown, paramName: string): number | null {
  if (!hasQueryValue(value)) return null;
  const numericValue = toNumber(value);
  if (numericValue === null || !Number.isInteger(numericValue) || numericValue <= 0) {
    throw new HttpError(400, `Invalid query param: ${paramName} (must be a positive integer)`);
  }
  return numericValue;
}

export function estimateBucketCount(fromMs: number, toMs: number, bucketMs: number): number {
  return Math.floor(toMs / bucketMs) - Math.floor(fromMs / bucketMs) + 1;
}

export function deriveBucketMs(range: TimeRange, maxPoints: number): number {
  const fromMs = new Date(range.from!).getTime();
  const toMs = new Date(range.to!).getTime();
  let bucketMs = Math.max(1, Math.ceil((toMs - fromMs + 1) / maxPoints));
  while (estimateBucketCount(fromMs, toMs, bucketMs) > maxPoints) {
    bucketMs += 1;
  }
  return bucketMs;
}

export function resolveTemporalStrategy(schema: TableSchema, preference: TimeFieldPreference): TemporalStrategy {
  const pointTimeColumn = resolvePointTimeColumn(schema);
  const hasInterval = schema.columns.has("intervalStart") && schema.columns.has("intervalEnd");

  if (preference === "interval" && !hasInterval) {
    throw new HttpError(400, "Requested timeField=interval, but table does not contain intervalStart and intervalEnd columns.");
  }
  if (preference === "timestamp" && !pointTimeColumn) {
    throw new HttpError(400, "Requested timeField=timestamp, but table does not contain a time or timestamp column.");
  }

  if (preference === "interval" && hasInterval) {
    if (!pointTimeColumn) {
      return {
        mode: "interval",
        fromColumn: "intervalStart",
        toColumn: "intervalEnd",
        orderBy: `"intervalStart" DESC`,
      };
    }
    return {
      mode: "interval",
      fromColumn: "intervalStart",
      toColumn: "intervalEnd",
      orderBy: `"intervalStart" DESC, ${quoteIdentifier(pointTimeColumn)} DESC`,
    };
  }

  if (!pointTimeColumn) {
    throw new HttpError(400, "Table does not contain a time or timestamp column required for time filtering.");
  }
  return {
    mode: "timestamp",
    fromColumn: pointTimeColumn,
    toColumn: pointTimeColumn,
    orderBy: `${quoteIdentifier(pointTimeColumn)} DESC`,
  };
}

export function resolvePointTimeColumn(schema: TableSchema): "time" | "timestamp" | null {
  if (schema.columns.has("time")) return "time";
  if (schema.columns.has("timestamp")) return "timestamp";
  return null;
}

export function normalizeRange(from: unknown, to: unknown, cfg: QuestDbRangeConfig): TimeRange {
  const maxWindowMs = cfg.maxLookbackHours * 60 * 60 * 1000;
  const defaultWindowMs = cfg.defaultLookbackHours * 60 * 60 * 1000;
  const parse = (value: unknown): Date | null => {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const fromProvided = hasQueryValue(from);
  const toProvided = hasQueryValue(to);

  let fromDate = parse(from);
  let toDate = parse(to);
  if (fromProvided && !fromDate) {
    throw new HttpError(400, "Invalid query param: from (must be ISO timestamp/date)");
  }
  if (toProvided && !toDate) {
    throw new HttpError(400, "Invalid query param: to (must be ISO timestamp/date)");
  }

  if (!toDate) toDate = new Date();
  if (!fromDate) fromDate = new Date(toDate.getTime() - defaultWindowMs);

  if (fromDate.getTime() > toDate.getTime()) {
    [fromDate, toDate] = [toDate, fromDate];
  }

  const span = toDate.getTime() - fromDate.getTime();
  const range: TimeRange = { from: fromDate.toISOString(), to: toDate.toISOString() };
  if (span > maxWindowMs) {
    if (fromProvided || toProvided) {
      throw new HttpError(
        400,
        `Requested time-range exceeds maxLookbackHours (${cfg.maxLookbackHours}h). Reduce from/to window.`,
      );
    }
    const adjustedFrom = new Date(toDate.getTime() - maxWindowMs);
    range.from = adjustedFrom.toISOString();
    range.note = "Window truncated to maxLookbackHours.";
  }
  return range;
}

export function sanitizeTable(table: string): string | null {
  const trimmed = table.trim();
  if (!trimmed) return null;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

export function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function buildDataColumnList(schema: TableSchema): string[] {
  const preferredOrder = [
    "topic",
    "attribute",
    "asset",
    "objectType",
    "objectId",
    "valueType",
    "value",
    "numberValue",
    "uom",
    "intervalStart",
    "intervalEnd",
    "time",
    "timestamp",
    "interval",
  ];
  const preferred = preferredOrder.filter(column => schema.columns.has(column));
  const preferredSet = new Set(preferredOrder);
  const remaining = schema.orderedColumns.filter(column => !preferredSet.has(column));
  const selected = [...preferred, ...remaining];
  if (selected.length) return selected;
  return ["timestamp"];
}

export function buildDedupePartitionColumns(schema: TableSchema): string[] {
  const preferredPartition = ["topic", "asset", "objectType", "objectId", "attribute", "intervalStart", "intervalEnd"];
  const selected = preferredPartition.filter(column => schema.columns.has(column));
  if (selected.length) return selected;
  return ["topic", "asset", "objectType", "objectId", "attribute"].filter(column => schema.columns.has(column));
}

export function canApplyDedupe(dedupeRequested: boolean, schema: TableSchema): boolean {
  if (!dedupeRequested) return false;
  if (!resolvePointTimeColumn(schema)) return false;
  return buildDedupePartitionColumns(schema).length > 0;
}

export function buildWhere(parsed: ParsedPath, range: TimeRange, temporal: TemporalStrategy, schema: TableSchema): string {
  const parts: string[] = [];
  const addIfPresent = (column: string, value: string | undefined) => {
    if (!value || !schema.columns.has(column)) return;
    parts.push(`${quoteIdentifier(column)} = ${escapeLiteral(value)}`);
  };
  addIfPresent("topic", parsed.topic);
  addIfPresent("asset", parsed.asset);
  addIfPresent("objectType", parsed.objectType);
  addIfPresent("objectId", parsed.objectId);
  addIfPresent("attribute", parsed.attribute);
  if (!parts.length && parsed.fullPath && schema.columns.has("topic")) {
    parts.push(`${quoteIdentifier("topic")} = ${escapeLiteral(parsed.fullPath)}`);
  }
  if (!parts.length && parsed.fullPath) {
    throw new HttpError(
      400,
      "Table schema does not contain expected UNS path columns (topic/asset/objectType/objectId/attribute).",
    );
  }
  if (range.from) {
    parts.push(`${quoteIdentifier(temporal.toColumn)} >= ${escapeLiteral(range.from)}`);
  }
  if (range.to) {
    parts.push(`${quoteIdentifier(temporal.fromColumn)} <= ${escapeLiteral(range.to)}`);
  }
  return parts.join(" AND ");
}

export function buildSourceSql(
  table: string,
  parsed: ParsedPath,
  range: TimeRange,
  dedupe: boolean,
  schema: TableSchema,
  temporal: TemporalStrategy,
  requestedColumns: string[],
): string {
  const where = buildWhere(parsed, range, temporal, schema);
  const tableId = quoteIdentifier(table);
  const canDedupe = canApplyDedupe(dedupe, schema);
  const pointTimeColumn = resolvePointTimeColumn(schema);
  const selectedColumns = Array.from(
    new Set(
      requestedColumns
        .concat([temporal.fromColumn, temporal.toColumn])
        .concat(canDedupe && pointTimeColumn ? [pointTimeColumn, ...buildDedupePartitionColumns(schema)] : [])
        .filter(column => schema.columns.has(column)),
    ),
  );
  const selectColumns = selectedColumns.map(quoteIdentifier).join(", ");
  if (canDedupe) {
    const partitionColumns = buildDedupePartitionColumns(schema).map(quoteIdentifier).join(", ");
    return `
      SELECT ${selectColumns}
      FROM ${tableId}
      WHERE ${where}
      LATEST ON ${quoteIdentifier(pointTimeColumn!)} PARTITION BY ${partitionColumns}
    `;
  }
  return `
    SELECT ${selectColumns}
    FROM ${tableId}
    WHERE ${where}
  `;
}

export function buildDataSql(
  table: string,
  parsed: ParsedPath,
  range: TimeRange,
  limit: number,
  dedupe: boolean,
  schema: TableSchema,
  temporal: TemporalStrategy,
): string {
  const sourceSql = buildSourceSql(table, parsed, range, dedupe, schema, temporal, buildDataColumnList(schema));
  return `
    SELECT *
    FROM (${sourceSql})
    ORDER BY ${temporal.orderBy}
    LIMIT ${limit}
  `;
}

export function buildSourceCountSql(sourceSql: string): string {
  return `
    SELECT
      count() AS sourceRowCount
    FROM (${sourceSql})
  `;
}

export function isNumericQuestDbType(typeName: string | undefined): boolean {
  if (!typeName) return false;
  return NUMERIC_QUESTDB_TYPES.has(typeName.trim().toUpperCase());
}

export function resolveMetricColumn(schema: TableSchema, parsed: ParsedPath): string {
  const attributeCandidate = parsed.attribute?.trim();
  if (
    attributeCandidate &&
    schema.columns.has(attributeCandidate) &&
    isNumericQuestDbType(schema.columnTypes.get(attributeCandidate))
  ) {
    return attributeCandidate;
  }
  if (schema.columns.has("numberValue") && isNumericQuestDbType(schema.columnTypes.get("numberValue"))) {
    return "numberValue";
  }
  if (schema.columns.has("value") && isNumericQuestDbType(schema.columnTypes.get("value"))) {
    return "value";
  }

  const numericCandidates = schema.orderedColumns.filter(
    column => !NON_VALUE_COLUMNS.has(column) && isNumericQuestDbType(schema.columnTypes.get(column)),
  );
  if (numericCandidates.length === 1) {
    return numericCandidates[0]!;
  }
  if (!numericCandidates.length) {
    throw new HttpError(
      400,
      "Bucketed and summary requests require a numeric value column. Expected numberValue, value, or exactly one numeric data column.",
    );
  }
  throw new HttpError(
    400,
    `Bucketed and summary requests are ambiguous for table ${Array.from(schema.columns).join(", ")}. Add a single numeric value column or expose a dedicated numeric attribute.`,
  );
}

export function resolveUnitColumn(schema: TableSchema): string | null {
  if (schema.columns.has("uom")) return "uom";
  if (schema.columns.has("unit")) return "unit";
  return null;
}

export function buildTimeOrder(temporal: TemporalStrategy, direction: "ASC" | "DESC"): string {
  return temporal.orderBy.replace(/\b(ASC|DESC)\b/g, direction);
}

export function buildSummaryAggregateSql(sourceSql: string, metricColumn: string): string {
  const metricId = quoteIdentifier(metricColumn);
  return `
    SELECT
      count() AS sampleCount,
      avg(${metricId}) AS avgValue,
      min(${metricId}) AS minValue,
      max(${metricId}) AS maxValue
    FROM (${sourceSql})
  `;
}

export function buildSummaryBoundarySql(
  sourceSql: string,
  temporal: TemporalStrategy,
  metricColumn: string,
  unitColumn: string | null,
  direction: "ASC" | "DESC",
): string {
  const selectParts = [
    `${quoteIdentifier(temporal.toColumn)} AS boundaryTimestamp`,
    `${quoteIdentifier(metricColumn)} AS boundaryValue`,
  ];
  if (unitColumn) {
    selectParts.push(`${quoteIdentifier(unitColumn)} AS boundaryUom`);
  }
  return `
    SELECT ${selectParts.join(", ")}
    FROM (${sourceSql})
    ORDER BY ${buildTimeOrder(temporal, direction)}
    LIMIT 1
  `;
}

export function buildAggregateExpression(metricColumn: string, aggregate: AggregateMode): string {
  const metricId = quoteIdentifier(metricColumn);
  switch (aggregate) {
    case "avg":
      return `avg(${metricId})`;
    case "min":
      return `min(${metricId})`;
    case "max":
      return `max(${metricId})`;
    case "last":
      return `last(${metricId})`;
    case "sum":
      return `sum(${metricId})`;
    case "count":
      return "count()";
  }
}

export function buildBucketSql(
  sourceSql: string,
  temporal: TemporalStrategy,
  metricColumn: string,
  unitColumn: string | null,
  aggregate: AggregateMode,
  bucketMs: number,
): string {
  const timeBucketExpression = `timestamp_floor('${bucketMs}T', ${quoteIdentifier(temporal.fromColumn)})`;
  const selectParts = [
    `${timeBucketExpression} AS bucketTimestamp`,
    `${buildAggregateExpression(metricColumn, aggregate)} AS value`,
  ];
  if (unitColumn) {
    selectParts.push(`last(${quoteIdentifier(unitColumn)}) AS uom`);
  }
  return `
    SELECT ${selectParts.join(", ")}
    FROM (${sourceSql})
    GROUP BY ${timeBucketExpression}
    ORDER BY 1 ASC
  `;
}

export function buildCounterDeltaSourceSql(
  sourceSql: string,
  temporal: TemporalStrategy,
  metricColumn: string,
  unitColumn: string | null,
  resetPolicy: CounterResetPolicy,
  outputMetricColumn: string | null = null,
): string {
  const sourceTimestamp = quoteIdentifier(temporal.fromColumn);
  const sourceMetric = quoteIdentifier(metricColumn);
  const selectParts = [
    `${sourceTimestamp} AS "timestamp"`,
    `${sourceMetric} AS "counterValue"`,
    `lag(${sourceMetric}) OVER (ORDER BY ${sourceTimestamp} ASC) AS "previousCounterValue"`,
  ];
  if (unitColumn) {
    selectParts.push(`${quoteIdentifier(unitColumn)} AS "uom"`);
  }

  const counterValue = quoteIdentifier("counterValue");
  const previousCounterValue = quoteIdentifier("previousCounterValue");
  const deltaExpression = resetPolicy === "new-value"
    ? `CASE WHEN ${counterValue} >= ${previousCounterValue} THEN ${counterValue} - ${previousCounterValue} ELSE ${counterValue} END`
    : `CASE WHEN ${counterValue} >= ${previousCounterValue} THEN ${counterValue} - ${previousCounterValue} ELSE null END`;
  const outputParts = [
    `${quoteIdentifier("timestamp")} AS ${quoteIdentifier("timestamp")}`,
    `${deltaExpression} AS ${quoteIdentifier("value")}`,
  ];
  if (outputMetricColumn && outputMetricColumn !== "value") {
    outputParts.push(`${deltaExpression} AS ${quoteIdentifier(outputMetricColumn)}`);
  }
  if (unitColumn) {
    outputParts.push(`${quoteIdentifier("uom")} AS ${quoteIdentifier("uom")}`);
    const unitAlias = outputMetricColumn ? `${outputMetricColumn}_uom` : null;
    if (unitAlias && unitAlias !== "uom") {
      outputParts.push(`${quoteIdentifier("uom")} AS ${quoteIdentifier(unitAlias)}`);
    }
  }
  const resetFilter = resetPolicy === "null" ? `AND ${counterValue} >= ${previousCounterValue}` : "";

  return `
    SELECT ${outputParts.join(", ")}
    FROM (
      SELECT ${selectParts.join(", ")}
      FROM (${sourceSql})
    )
    WHERE ${previousCounterValue} IS NOT NULL
      AND ${counterValue} IS NOT NULL
      ${resetFilter}
  `;
}

export function buildCounterDeltaRawSql(
  deltaSourceSql: string,
  limit: number,
): string {
  return `
    SELECT *
    FROM (${deltaSourceSql})
    ORDER BY ${quoteIdentifier("timestamp")} DESC
    LIMIT ${limit}
  `;
}

export function buildCounterDeltaBucketSql(
  deltaSourceSql: string,
  unitColumn: string | null,
  bucketMs: number,
  outputMetricColumn: string | null = null,
): string {
  const timeBucketExpression = `timestamp_floor('${bucketMs}T', ${quoteIdentifier("timestamp")})`;
  const valueAggregate = `sum(${quoteIdentifier("value")})`;
  const selectParts = [
    `${timeBucketExpression} AS bucketTimestamp`,
    `${valueAggregate} AS value`,
  ];
  if (outputMetricColumn && outputMetricColumn !== "value") {
    selectParts.push(`${valueAggregate} AS ${quoteIdentifier(outputMetricColumn)}`);
  }
  if (unitColumn) {
    selectParts.push(`last(${quoteIdentifier("uom")}) AS uom`);
    const unitAlias = outputMetricColumn ? `${outputMetricColumn}_uom` : null;
    if (unitAlias && unitAlias !== "uom") {
      selectParts.push(`last(${quoteIdentifier("uom")}) AS ${quoteIdentifier(unitAlias)}`);
    }
  }
  return `
    SELECT ${selectParts.join(", ")}
    FROM (${deltaSourceSql})
    GROUP BY ${timeBucketExpression}
    ORDER BY 1 ASC
  `;
}

export function computeCounterDeltaValue(
  currentValue: unknown,
  previousValue: unknown,
  resetPolicy: CounterResetPolicy,
): CounterDeltaValue | null {
  const absoluteValue = toNumber(currentValue);
  if (absoluteValue === null) return null;

  const previousNumericValue = toNumber(previousValue);
  if (previousNumericValue === null) {
    return {
      absoluteValue,
      previousValue: null,
      delta: null,
      reset: false,
    };
  }

  if (absoluteValue >= previousNumericValue) {
    return {
      absoluteValue,
      previousValue: previousNumericValue,
      delta: absoluteValue - previousNumericValue,
      reset: false,
    };
  }

  return {
    absoluteValue,
    previousValue: previousNumericValue,
    delta: resetPolicy === "new-value" ? absoluteValue : null,
    reset: true,
  };
}

function toTimestampMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function questDbColumn(name: string, type: string): { name: string; type: string } {
  return { name, type };
}

function buildCounterBoundarySamples(
  rows: Record<string, unknown>[],
  timestampColumn: string,
  metricColumn: string,
  unitColumn: string | null,
  resetPolicy: CounterResetPolicy,
): CounterBoundarySample[] {
  const baseSamples = rows
    .map(row => {
      const timestampMs = toTimestampMs(row[timestampColumn]);
      const rawValue = toNumber(row[metricColumn]);
      if (timestampMs === null || rawValue === null) return null;
      const unit = unitColumn ? row[unitColumn] : null;
      return {
        timestampMs,
        rawValue,
        uom: typeof unit === "string" && unit.trim().length > 0 ? unit.trim() : null,
      };
    })
    .filter((sample): sample is { timestampMs: number; rawValue: number; uom: string | null } => sample !== null)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const samples: CounterBoundarySample[] = [];
  let previousRaw: number | null = null;
  let previousUnwrapped: number | null = null;
  let offset = 0;

  for (const sample of baseSamples) {
    if (previousRaw !== null && previousUnwrapped !== null && sample.rawValue < previousRaw) {
      offset = resetPolicy === "new-value"
        ? previousUnwrapped
        : previousUnwrapped - sample.rawValue;
    }
    const unwrappedValue = sample.rawValue + offset;
    const mapped = { ...sample, unwrappedValue };
    const last = samples[samples.length - 1];
    if (last && last.timestampMs === sample.timestampMs) {
      samples[samples.length - 1] = mapped;
    } else {
      samples.push(mapped);
    }
    previousRaw = sample.rawValue;
    previousUnwrapped = unwrappedValue;
  }

  return samples;
}

function interpolateCounterValue(samples: CounterBoundarySample[], timestampMs: number): number | null {
  if (!samples.length) return null;
  if (timestampMs < samples[0]!.timestampMs || timestampMs > samples[samples.length - 1]!.timestampMs) return null;

  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (samples[mid]!.timestampMs <= timestampMs) lo = mid;
    else hi = mid;
  }

  const before = samples[lo]!;
  if (before.timestampMs === timestampMs) return before.unwrappedValue;
  const after = samples[hi]!;
  if (after.timestampMs === timestampMs) return after.unwrappedValue;
  if (after.timestampMs <= before.timestampMs) return before.unwrappedValue;

  const ratio = (timestampMs - before.timestampMs) / (after.timestampMs - before.timestampMs);
  return before.unwrappedValue + (after.unwrappedValue - before.unwrappedValue) * ratio;
}

function unitAtOrBefore(samples: CounterBoundarySample[], timestampMs: number): string | null {
  let unit: string | null = null;
  for (const sample of samples) {
    if (sample.timestampMs > timestampMs) break;
    if (sample.uom) unit = sample.uom;
  }
  return unit;
}

export function buildBoundaryCounterDeltaResponse(
  sourceResult: QuestDbHistoryResponse,
  sourceSql: string,
  requestedRange: TimeRange,
  temporal: TemporalStrategy,
  metricColumn: string,
  unitColumn: string | null,
  bucketMs: number,
  resetPolicy: CounterResetPolicy,
  outputMetricColumn: string | null = null,
): QuestDbHistoryResponse {
  const fromMs = toTimestampMs(requestedRange.from);
  const toMs = toTimestampMs(requestedRange.to);
  const metricAlias = outputMetricColumn && outputMetricColumn !== "value" ? outputMetricColumn : null;
  const columns = [
    questDbColumn("timestamp", "TIMESTAMP"),
    questDbColumn("value", "DOUBLE"),
  ];
  if (metricAlias) columns.push(questDbColumn(metricAlias, "DOUBLE"));
  if (unitColumn) {
    columns.push(questDbColumn("uom", "STRING"));
    if (metricAlias) columns.push(questDbColumn(`${metricAlias}_uom`, "STRING"));
  }

  const raw = {
    ...sourceResult.raw,
    query: sourceSql.replace(/\s+/g, " ").trim(),
    columns,
  };
  if (fromMs === null || toMs === null || toMs <= fromMs) return { data: [], raw };

  const sourceRows = mapQuestDbRowsToObjects(sourceResult.data, sourceResult.raw);
  const samples = buildCounterBoundarySamples(sourceRows, temporal.fromColumn, metricColumn, unitColumn, resetPolicy);
  const data: unknown[][] = [];
  const firstBucketStartMs = Math.ceil(fromMs / bucketMs) * bucketMs;

  for (let bucketStartMs = firstBucketStartMs; bucketStartMs + bucketMs <= toMs; bucketStartMs += bucketMs) {
    const bucketEndMs = bucketStartMs + bucketMs;
    const startValue = interpolateCounterValue(samples, bucketStartMs);
    const endValue = interpolateCounterValue(samples, bucketEndMs);
    if (startValue === null || endValue === null) continue;
    const delta = Math.max(0, endValue - startValue);
    if (!Number.isFinite(delta)) continue;

    const row: unknown[] = [new Date(bucketStartMs).toISOString(), delta];
    if (metricAlias) row.push(delta);
    if (unitColumn) {
      const unit = unitAtOrBefore(samples, bucketEndMs) ?? unitAtOrBefore(samples, bucketStartMs);
      row.push(unit);
      if (metricAlias) row.push(unit);
    }
    data.push(row);
  }

  return { data, raw };
}

export function counterBoundarySourceRange(range: TimeRange, bucketMs: number): TimeRange {
  const fromMs = toTimestampMs(range.from);
  const toMs = toTimestampMs(range.to);
  if (fromMs === null || toMs === null || toMs <= fromMs) return range;
  const firstBucketStartMs = Math.ceil(fromMs / bucketMs) * bucketMs;
  const lastBucketEndMs = Math.floor(toMs / bucketMs) * bucketMs;
  if (lastBucketEndMs <= firstBucketStartMs) return range;
  return {
    ...range,
    from: new Date(firstBucketStartMs - bucketMs * 2).toISOString(),
    to: new Date(lastBucketEndMs + bucketMs * 2).toISOString(),
  };
}

export function toNullableNumber(value: unknown): number | null {
  return toNumber(value);
}

export function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function normalizeIsoTimestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function resolveTrend(firstValue: number | null, lastValue: number | null): SummaryTrend {
  if (firstValue === null || lastValue === null) return "unknown";
  const delta = lastValue - firstValue;
  if (Math.abs(delta) < 1e-9) return "steady";
  return delta > 0 ? "rising" : "falling";
}

export function getQuestDbColumnNames(raw: Record<string, unknown>): string[] {
  const columns = raw["columns"];
  if (!Array.isArray(columns)) return [];
  return columns
    .map(column => {
      if (!column || typeof column !== "object") return null;
      const name = (column as Record<string, unknown>)["name"];
      return typeof name === "string" ? name : null;
    })
    .filter((name): name is string => !!name);
}

export function mapQuestDbRowsToObjects(data: unknown[], raw: Record<string, unknown>): Record<string, unknown>[] {
  const columnNames = getQuestDbColumnNames(raw);
  return data.map(row => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      return { ...(row as Record<string, unknown>) };
    }
    if (Array.isArray(row) && columnNames.length) {
      const mapped: Record<string, unknown> = {};
      for (const [index, columnName] of columnNames.entries()) {
        mapped[columnName] = row[index];
      }
      return mapped;
    }
    return { value: row };
  });
}

export function stripDatasetFromQuestDbResponse(parsed: unknown, query: string): Record<string, unknown> {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const clone: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    delete clone["dataset"];
    clone["query"] = query;
    return clone;
  }

  if (Array.isArray(parsed)) {
    return { query, format: "array", rowCount: parsed.length };
  }

  if (typeof parsed === "string") {
    return { query, message: parsed };
  }

  return { query };
}

export function resolveRequestId(headerValue: unknown): string {
  if (typeof headerValue === "string" && headerValue.trim().length > 0) return headerValue.trim();
  if (Array.isArray(headerValue) && typeof headerValue[0] === "string" && headerValue[0].trim().length > 0) {
    return headerValue[0].trim();
  }
  return randomUUID();
}

export function extractBearerToken(headerValue: unknown): string | null {
  if (typeof headerValue === "string") {
    if (!headerValue.startsWith("Bearer ")) return null;
    const token = headerValue.slice(7).trim();
    return token.length ? token : null;
  }
  if (Array.isArray(headerValue)) {
    return extractBearerToken(headerValue[0]);
  }
  return null;
}

export function extractScopeSet(claims: JwtClaimsLike): Set<string> {
  const scopes: string[] = [];
  if (typeof claims.scope === "string") scopes.push(...claims.scope.split(/\s+/));
  if (typeof claims.scopes === "string") scopes.push(...claims.scopes.split(/\s+/));
  if (Array.isArray(claims.scopes)) {
    const scopeValues = claims.scopes.filter((value: unknown): value is string => typeof value === "string");
    scopes.push(...scopeValues);
  }
  if (Array.isArray(claims.permissions)) {
    const permissionValues = claims.permissions.filter((value: unknown): value is string => typeof value === "string");
    scopes.push(...permissionValues);
  }

  const normalized = scopes.map(scope => scope.trim().toLowerCase()).filter(Boolean);
  return new Set(normalized);
}

export function extractAccessRules(claims: JwtClaimsLike): string[] {
  const fromAccessRules = Array.isArray(claims.accessRules)
    ? claims.accessRules.filter((rule: unknown): rule is string => typeof rule === "string")
    : [];
  const fromPathFilter = typeof claims.pathFilter === "string" ? [claims.pathFilter] : [];

  return [...fromAccessRules, ...fromPathFilter]
    .map(rule => rule.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
}

export function isTopicAllowedByAccessRules(topic: string, accessRules: string[]): boolean {
  const normalizedTopic = topic.trim().replace(/^\/+|\/+$/g, "");
  return normalizedTopic.length > 0 && accessRules.some(rule => UnsTopicMatcher.matches(rule, normalizedTopic));
}

export function extractScanRowCount(raw: Record<string, unknown>): number | null {
  const candidates = [raw["count"], raw["rowCount"], raw["rows"]].map(toNumber).filter((v): v is number => v !== null);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

export function normalizeRequestPath(rawPath: string): string {
  const withLeadingSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  const withoutTrailing = collapsed.replace(/\/+$/, "");
  return withoutTrailing || "/";
}

export function isSwaggerDefinitionRequest(requestPath: string, configuredSwaggerPath: string | undefined): boolean {
  const normalizedConfigured = normalizeRequestPath(configuredSwaggerPath ?? "/uns-api-global/general-api/catchall-swagger.json");
  const normalizedRequest = normalizeRequestPath(requestPath);

  const knownSwaggerPaths = new Set<string>([
    normalizedConfigured,
    "/swagger",
    "/swagger.json",
    "/catchall-swagger.json",
  ]);

  if (knownSwaggerPaths.has(normalizedRequest)) {
    return true;
  }

  return normalizedRequest.endsWith("/catchall-swagger.json");
}
