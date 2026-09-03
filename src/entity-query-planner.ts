import type {
  ControllerEntityBindingClient,
  EntityBindingInterval,
} from "./entity-binding-client.js";

export const MAX_ENTITY_HISTORY_SELECTORS = 50;
export const MAX_ENTITY_HISTORY_IDS = 20;

export type EntityHistorySelector = {
  stableEntityId: string;
  attributePath: string;
};

export function parseEntityHistorySelectors(value: unknown): EntityHistorySelector[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError("entitySelectors must be an array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`entitySelectors[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record["stableEntityId"] !== "string" || typeof record["attributePath"] !== "string") {
      throw new TypeError(`entitySelectors[${index}] requires stableEntityId and attributePath`);
    }
    return normalizeSelector({
      stableEntityId: record["stableEntityId"],
      attributePath: record["attributePath"],
    });
  });
}

export type EntityHistoryPathInterval = {
  topic: string;
  from: string;
  to: string;
  bindingRevision: string;
  bindingDigest: string;
  timeBasis: string;
};

export type EntityHistorySelectorPlan = EntityHistorySelector & {
  status: "resolved" | "not-found";
  intervals: EntityHistoryPathInterval[];
};

export type EntityHistoryPlan = {
  from: string;
  to: string;
  selectors: EntityHistorySelectorPlan[];
  bindingSource: "cache" | "controller" | "stale-cache" | "mixed";
};

export type EntityHistoryRowsMerge = {
  columns: string[];
  rows: unknown[][];
  duplicatesRemoved: number;
};

export type EntityStorageSchemaMode = "legacy" | "identity-aware" | "partial";

export type EntityStorageSchema = {
  mode: EntityStorageSchemaMode;
  stableEntityColumn: string | null;
  bindingColumn: string | null;
  missingColumns: string[];
};

const IDENTITY_REQUIRED_COLUMNS = ["stableEntityId", "identityResolution", "identityTimeBasis"] as const;
const IDENTITY_BINDING_COLUMNS = ["identityBindingId", "identityBindingRevision", "identityBindingDigest"] as const;

export function detectEntityStorageSchema(columns: Iterable<string>): EntityStorageSchema {
  const available = new Set(columns);
  const stableEntityColumn = available.has("stableEntityId") ? "stableEntityId" : null;
  const bindingColumn = IDENTITY_BINDING_COLUMNS.find((column) => available.has(column)) ?? null;
  const identityColumnsPresent = [
    ...IDENTITY_REQUIRED_COLUMNS.filter((column) => available.has(column)),
    ...IDENTITY_BINDING_COLUMNS.filter((column) => available.has(column)),
  ];
  if (identityColumnsPresent.length === 0) {
    return { mode: "legacy", stableEntityColumn: null, bindingColumn: null, missingColumns: [] };
  }
  const missingColumns: string[] = IDENTITY_REQUIRED_COLUMNS.filter((column) => !available.has(column));
  if (!bindingColumn) missingColumns.push("identityBindingId|identityBindingRevision|identityBindingDigest");
  return {
    mode: missingColumns.length ? "partial" : "identity-aware",
    stableEntityColumn,
    bindingColumn,
    missingColumns,
  };
}

type EntityIntervalReader = Pick<ControllerEntityBindingClient, "listIntervals">;

function normalizeTime(value: string | Date, name: "from" | "to"): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return parsed.toISOString();
}

function normalizeSelector(value: EntityHistorySelector): EntityHistorySelector {
  const stableEntityId = value.stableEntityId.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(stableEntityId)) {
    throw new TypeError("stableEntityId must be a valid UUID");
  }
  const attributePath = value.attributePath.trim().normalize("NFC").replace(/^\/+|\/+$/g, "");
  if (!attributePath || attributePath.includes("//") || /[+#]/.test(attributePath)) {
    throw new TypeError("attributePath must be one concrete non-empty relative path");
  }
  return { stableEntityId, attributePath };
}

function intervalMatchesAttribute(interval: EntityBindingInterval, attributePath: string): boolean {
  return interval.topic === attributePath || interval.topic.endsWith(`/${attributePath}`);
}

function maxTime(left: string, right: string): string {
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function minTime(left: string, right: string): string {
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function planIntervals(
  intervals: EntityBindingInterval[],
  attributePath: string,
  from: string,
  to: string,
): EntityHistoryPathInterval[] {
  const planned = intervals
    .filter((interval) => intervalMatchesAttribute(interval, attributePath))
    .map((interval): EntityHistoryPathInterval | null => {
      const clippedFrom = maxTime(interval.validFrom, from);
      const clippedTo = minTime(interval.validTo ?? to, to);
      if (new Date(clippedFrom).getTime() >= new Date(clippedTo).getTime()) return null;
      return {
        topic: interval.topic,
        from: clippedFrom,
        to: clippedTo,
        bindingRevision: interval.revision,
        bindingDigest: interval.digest,
        timeBasis: interval.timeBasis,
      };
    })
    .filter((interval): interval is EntityHistoryPathInterval => interval !== null)
    .sort((left, right) => left.from.localeCompare(right.from) || left.topic.localeCompare(right.topic));
  const seen = new Set<string>();
  return planned.filter((interval) => {
    const key = `${interval.topic}\0${interval.from}\0${interval.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function planEntityHistoryBindings(
  reader: EntityIntervalReader,
  selectors: EntityHistorySelector[],
  range: { from: string | Date; to: string | Date },
): Promise<EntityHistoryPlan> {
  if (!selectors.length) throw new TypeError("at least one entity selector is required");
  if (selectors.length > MAX_ENTITY_HISTORY_SELECTORS) {
    throw new RangeError(`At most ${MAX_ENTITY_HISTORY_SELECTORS} entity selectors may be planned at once`);
  }
  const normalized = selectors.map(normalizeSelector);
  const entityIds = Array.from(new Set(normalized.map((selector) => selector.stableEntityId)));
  if (entityIds.length > MAX_ENTITY_HISTORY_IDS) {
    throw new RangeError(`At most ${MAX_ENTITY_HISTORY_IDS} stable entity IDs may be planned at once`);
  }
  const from = normalizeTime(range.from, "from");
  const to = normalizeTime(range.to, "to");
  if (new Date(from).getTime() >= new Date(to).getTime()) throw new RangeError("from must be earlier than to");

  const responses = await Promise.all(entityIds.map(async (stableEntityId) => ({
    stableEntityId,
    result: await reader.listIntervals(stableEntityId, from, to),
  })));
  const byEntity = new Map(responses.map((entry) => [entry.stableEntityId, entry.result.intervals]));
  const sources = new Set(responses.map((entry) => entry.result.source));
  return {
    from,
    to,
    selectors: normalized.map((selector) => {
      const intervals = planIntervals(
        byEntity.get(selector.stableEntityId) ?? [],
        selector.attributePath,
        from,
        to,
      );
      return { ...selector, status: intervals.length ? "resolved" : "not-found", intervals };
    }),
    bindingSource: sources.size === 1 ? responses[0]!.result.source : "mixed",
  };
}

export async function planEntityCurrentBindings(
  reader: EntityIntervalReader,
  selectors: EntityHistorySelector[],
  asOf: string | Date = new Date(),
): Promise<EntityHistoryPlan> {
  const instant = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(instant.getTime())) throw new TypeError("asOf must be a valid timestamp");
  return planEntityHistoryBindings(reader, selectors, {
    from: new Date(instant.getTime() - 1),
    to: new Date(instant.getTime() + 1),
  });
}

const NON_PAYLOAD_COLUMNS = new Set([
  "topic",
  "asset",
  "objectType",
  "objectId",
  "attribute",
  "stableEntityId",
  "entityTypeKey",
  "attributeDefinitionKey",
  "identityBindingId",
  "identityBindingRevision",
  "identityBindingDigest",
  "identityResolution",
  "identityTimeBasis",
]);

export function mergeEntityHistoryRows(
  segments: Array<{ columns: string[]; rows: unknown[][] }>,
  limit: number,
): EntityHistoryRowsMerge {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  if (!segments.length) return { columns: [], rows: [], duplicatesRemoved: 0 };
  const columns = segments[0]!.columns;
  if (segments.some((segment) =>
    segment.columns.length !== columns.length
    || segment.columns.some((column, index) => column !== columns[index]))) {
    throw new Error("Entity history segments returned incompatible QuestDB columns");
  }
  const nonPathIndexes = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !NON_PAYLOAD_COLUMNS.has(column))
    .map(({ index }) => index);
  const payloadIndexes = nonPathIndexes.length
    ? nonPathIndexes
    : columns.map((_column, index) => index);
  const timeIndex = ["time", "timestamp", "intervalStart"]
    .map((column) => columns.indexOf(column))
    .find((index) => index >= 0) ?? -1;
  const allRows = segments.flatMap((segment) => segment.rows);
  const unique = new Map<string, unknown[]>();
  const identityMetadataIndexes = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) =>
      (NON_PAYLOAD_COLUMNS.has(column) && column.startsWith("identity")) || column === "stableEntityId")
    .map(({ index }) => index);
  for (const row of allRows) {
    const key = JSON.stringify(payloadIndexes.map((index) => row[index]));
    const current = unique.get(key);
    if (!current) {
      unique.set(key, row);
      continue;
    }
    const score = (candidate: unknown[]) => identityMetadataIndexes.reduce(
      (total, index) => total + (candidate[index] === null || candidate[index] === undefined || candidate[index] === "" ? 0 : 1),
      0,
    );
    if (score(row) > score(current)) unique.set(key, row);
  }
  const rows = Array.from(unique.values()).sort((left, right) => {
    if (timeIndex < 0) return 0;
    const leftTime = new Date(String(left[timeIndex] ?? "")).getTime();
    const rightTime = new Date(String(right[timeIndex] ?? "")).getTime();
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
    return rightTime - leftTime;
  }).slice(0, limit);
  return { columns: [...columns], rows, duplicatesRemoved: allRows.length - unique.size };
}
