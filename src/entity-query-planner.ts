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
