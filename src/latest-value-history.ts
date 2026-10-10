import { randomUUID } from "node:crypto";
import { HistoryReadError } from "./history-source-diagnostics.js";
import {
  buildDataColumnList,
  buildSourceSql,
  parseUnsPath,
  quoteIdentifier,
  type TableSchema,
  type TemporalStrategy,
} from "./catchall-helpers.js";
import {
  HISTORY_SOURCE_COLUMN,
  HistorySourceError,
  type HistoryTableSource,
} from "./history-table-source.js";

export const LATEST_TIE_ROWS = 64;
export class LatestLookupError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}
export type ArchivedLatestValue = {
  values: Record<string, unknown>;
  uom: string | null;
  timestamp: string;
  receivedAt: number;
  selectedTables: string[];
  packetShape: "data" | "table";
};

/** No history lookback: sparse attributes may legitimately be months old. */
export function buildLatestHistorySql(
  source: HistoryTableSource,
  topic: string,
  schema: TableSchema,
  temporal: TemporalStrategy,
): string {
  const inner = buildSourceSql(
    source,
    parseUnsPath(topic),
    {},
    false,
    schema,
    temporal,
    buildDataColumnList(schema),
  );
  const tieOrder = schema.columns.has(HISTORY_SOURCE_COLUMN)
    ? `, ${quoteIdentifier(HISTORY_SOURCE_COLUMN)} ASC`
    : "";
  const order = `${quoteIdentifier(temporal.fromColumn)} DESC${temporal.toColumn !== temporal.fromColumn ? `, ${quoteIdentifier(temporal.toColumn)} DESC` : ""}`;
  const timePresent = `${quoteIdentifier(temporal.fromColumn)} IS NOT NULL${temporal.toColumn !== temporal.fromColumn ? ` AND ${quoteIdentifier(temporal.toColumn)} IS NOT NULL` : ""}`;
  return `SELECT * FROM (${inner}) WHERE ${timePresent} ORDER BY ${order}${tieOrder} LIMIT ${LATEST_TIE_ROWS + 1}`;
}

/** Date alone would collapse distinct QuestDB microseconds into one tie. */
function timestampOrder(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value))
    throw new LatestLookupError("Archived latest timestamp is invalid.");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms))
    throw new LatestLookupError("Archived latest timestamp is invalid.");
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/)?.[1] ?? "";
  return (
    BigInt(Math.floor(ms / 1000)) * 1_000_000_000n +
    BigInt(fraction.padEnd(9, "0").slice(0, 9))
  );
}

const tableMetadata = new Set([
  "topic",
  "attribute",
  "asset",
  "objectType",
  "objectId",
  "time",
  "timestamp",
  "intervalStart",
  "intervalEnd",
  "interval",
  "lastSeen",
  "deleted",
  "deletedAt",
  "createdAt",
  "expiresAt",
  "eventId",
  "foreignEventKey",
  HISTORY_SOURCE_COLUMN,
  "stableEntityId",
  "identityResolution",
  "bindingRevision",
  "bindingDigest",
]);
const nonValues = new Set([
  ...tableMetadata,
  "topic",
  "attribute",
  "asset",
  "objectType",
  "objectId",
  "valueType",
  "value",
  "numberValue",
  "stringValue",
  "uom",
  "time",
  "timestamp",
  "interval",
  "intervalStart",
  "intervalEnd",
  "lastSeen",
  "deleted",
  HISTORY_SOURCE_COLUMN,
  "stableEntityId",
  "identityResolution",
  "bindingRevision",
  "bindingDigest",
]);

function payload(
  columns: string[],
  row: unknown[],
  packetShape?: "data" | "table",
): {
  values: Record<string, unknown>;
  uom: string | null;
  packetShape: "data" | "table";
} | null {
  if (packetShape === "table") {
    const values: Record<string, unknown> = {};
    columns.forEach((name, i) => {
      if (name && !tableMetadata.has(name) && row[i] != null)
        values[name] = row[i];
    });
    return Object.keys(values).length
      ? { values, uom: null, packetShape: "table" }
      : null;
  }
  const at = (name: string): unknown => row[columns.indexOf(name)];
  const number = at("numberValue");
  const string = at("stringValue");
  const value = at("value");
  const kind = at("valueType");
  let scalar: unknown;
  if (kind === "string") scalar = typeof string === "string" ? string : value;
  else if (typeof number === "number" && Number.isFinite(number))
    scalar = number;
  else if (typeof string === "string") scalar = string;
  else if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    scalar = value;
  if (scalar !== undefined && scalar !== null)
    return {
      values: { value: scalar },
      uom: typeof at("uom") === "string" ? (at("uom") as string) : null,
      packetShape: "data",
    };
  const values: Record<string, unknown> = {};
  columns.forEach((name, i) => {
    if (name && !nonValues.has(name) && row[i] != null) values[name] = row[i];
  });
  return Object.keys(values).length
    ? { values, uom: null, packetShape: "table" }
    : null;
}
const fingerprint = (
  value: { values: Record<string, unknown>; uom: string | null } | null,
) =>
  JSON.stringify(
    value && {
      values: Object.fromEntries(
        Object.entries(value.values).sort(([a], [b]) => a.localeCompare(b)),
      ),
      uom: value.uom,
    },
  );

/** Contradictory equal-time observations are not evidence of current ownership. */
export function selectArchivedLatest(
  columns: string[],
  rows: unknown[][],
  temporal: TemporalStrategy,
  packetShape?: "data" | "table",
): ArchivedLatestValue | null {
  if (!rows.length) return null;
  const fromIndex = columns.indexOf(temporal.fromColumn);
  const toIndex = columns.indexOf(temporal.toColumn);
  if (fromIndex < 0 || toIndex < 0)
    throw new LatestLookupError("Archived latest time column is unavailable.");
  const ordered = rows
    .map((row) => ({
      row,
      from: timestampOrder(row[fromIndex]),
      to: timestampOrder(row[toIndex]),
    }))
    .sort((a, b) =>
      a.from === b.from
        ? a.to === b.to
          ? 0
          : a.to > b.to
            ? -1
            : 1
        : a.from > b.from
          ? -1
          : 1,
    );
  const newest = ordered[0]!;
  const ties = ordered.filter(
    (item) => item.from === newest.from && item.to === newest.to,
  );
  if (ties.length > LATEST_TIE_ROWS)
    throw new HistorySourceError(
      "Latest timestamp has too many overlapping observations. Review the sources.",
    );
  const value = payload(columns, newest.row, packetShape);
  if (
    ties.some(
      (item) =>
        fingerprint(payload(columns, item.row, packetShape)) !==
        fingerprint(value),
    )
  ) {
    throw new HistorySourceError(
      "History sources have different values at the latest timestamp. Review publisher ownership.",
    );
  }
  if (!value) return null;
  const sourceIndex = columns.indexOf(HISTORY_SOURCE_COLUMN);
  return {
    ...value,
    timestamp: newest.row[fromIndex] as string,
    receivedAt: Date.parse(newest.row[fromIndex] as string),
    selectedTables: [
      ...new Set(
        ties
          .map((item) => item.row[sourceIndex])
          .filter((name): name is string => typeof name === "string"),
      ),
    ].sort(),
  };
}

/** Keep a live or other successful fill that arrived while the database read ran. */
export function preserveConcurrentCacheValue<T>(
  current: T | undefined,
  archived: T,
): { entry: T; inserted: boolean } {
  return current === undefined
    ? { entry: archived, inserted: true }
    : { entry: current, inserted: false };
}

/** Coalesce seed/lazy reads; only misses/errors are throttled, with bounded storage. */
export class LatestLookupCoordinator<T> {
  private waiters = 0;
  private readonly pending = new Map<
    string,
    { lookupId: string; promise: Promise<T | null> }
  >();
  private readonly failures = new Map<
    string,
    { at: number; error?: unknown }
  >();
  constructor(
    private readonly options: {
      now?: () => number;
      timeoutMs?: number;
      cooldownMs?: number;
      maxFailures?: number;
      maxPending?: number;
      maxWaiters?: number;
      runLookup?: (
        lookupId: string,
        load: () => Promise<T | null>,
      ) => Promise<T | null>;
      onJoin?: (lookupId: string) => void;
      onThrottle?: () => void;
    } = {},
  ) {}
  get failureCount(): number {
    return this.failures.size;
  }
  async run(
    topic: string,
    load: (signal: AbortSignal) => Promise<T | null>,
  ): Promise<T | null> {
    const pending = this.pending.get(topic);
    if (pending) {
      if (this.waiters >= (this.options.maxWaiters ?? 64)) {
        this.options.onThrottle?.();
        throw new LatestLookupError(
          "Latest-value recovery is busy. Retry shortly.",
        );
      }
      this.options.onJoin?.(pending.lookupId);
      this.waiters++;
      try {
        return structuredClone(await pending.promise);
      } finally {
        this.waiters--;
      }
    }
    const now = (this.options.now ?? Date.now)();
    const previous = this.failures.get(topic);
    if (previous && now - previous.at < (this.options.cooldownMs ?? 5_000)) {
      this.options.onThrottle?.();
      if (previous.error) throw previous.error;
      return null;
    }
    if (this.pending.size >= (this.options.maxPending ?? 20))
      throw new LatestLookupError(
        "Latest-value recovery is busy. Retry shortly.",
      );
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lookupId = randomUUID();
    const run = async () => {
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => load(controller.signal)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(
                new LatestLookupError(
                  "Latest-value recovery timed out. Retry shortly.",
                ),
              );
            }, this.options.timeoutMs ?? 5_000);
          }),
        ]);
        if (result === null)
          this.remember(topic, { at: (this.options.now ?? Date.now)() });
        else this.failures.delete(topic);
        return result;
      } catch (error) {
        controller.abort();
        const safe =
          error instanceof HistorySourceError ||
          error instanceof HistoryReadError ||
          error instanceof LatestLookupError
            ? error
            : new LatestLookupError(
                "Latest-value recovery could not read all required sources. Retry when the service is available.",
              );
        this.remember(topic, {
          at: (this.options.now ?? Date.now)(),
          error: safe,
        });
        throw safe;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const promise = (
      this.options.runLookup ? this.options.runLookup(lookupId, run) : run()
    ).finally(() => {
      this.pending.delete(topic);
    });
    this.pending.set(topic, { lookupId, promise });
    return promise;
  }
  private remember(
    topic: string,
    value: { at: number; error?: unknown },
  ): void {
    this.failures.delete(topic);
    this.failures.set(topic, value);
    while (this.failures.size > (this.options.maxFailures ?? 1_000))
      this.failures.delete(this.failures.keys().next().value!);
  }
}
