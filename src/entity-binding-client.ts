export const MAX_ENTITY_BINDING_TOPICS = 200;

export type EntityBindingStatus = "resolved" | "not-found" | "ambiguous";

export type EntityBindingResolution = {
  topic: string;
  asOf: string | null;
  status: EntityBindingStatus;
  stableEntityId: string | null;
  entityTypeKey: string | null;
  bindingKind: "asset-prefix" | "attribute-topic" | null;
  matchedPath: string | null;
  timeBasis: string | null;
  sourceCount: number;
  revision: string | null;
  digest: string | null;
};

export type EntityBindingLookup = {
  topic: string;
  asOf: string | Date;
};

export type EntityBindingInterval = {
  topic: string;
  stableEntityId: string;
  entityTypeKey: string;
  bindingKind: "attribute-topic";
  validFrom: string;
  validTo: string | null;
  timeBasis: string;
  sourceCount: number;
  revision: string;
  digest: string;
};

type AccessTokenProvider = {
  getAccessToken(): Promise<string | undefined>;
};

type CacheEntry = {
  resolution: EntityBindingResolution;
  fetchedAt: number;
};

type IntervalCacheEntry = {
  intervals: EntityBindingInterval[];
  fetchedAt: number;
};

export type EntityBindingClientOptions = {
  graphqlUrl: string;
  tokenProvider: AccessTokenProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
  staleIfErrorMs?: number;
  now?: () => number;
};

export type EntityBindingBatchResult = {
  resolutions: EntityBindingResolution[];
  source: "cache" | "controller" | "mixed" | "stale-cache";
};

const RESOLVE_BINDINGS_QUERY = `
  query ResolveEntityObservationBindings($topics: [String!]!, $asOf: Timestamp) {
    ResolveEntityObservationBindings(topics: $topics, asOf: $asOf) {
      topic
      asOf
      status
      stableEntityId
      entityTypeKey
      bindingKind
      matchedPath
      timeBasis
      sourceCount
      revision
      digest
    }
  }
`;

const RESOLVE_BINDING_LOOKUPS_QUERY = `
  query ResolveEntityObservationBindingLookups($lookups: [EntityObservationBindingLookupInput!]!) {
    ResolveEntityObservationBindingLookups(lookups: $lookups) {
      topic
      asOf
      status
      stableEntityId
      entityTypeKey
      bindingKind
      matchedPath
      timeBasis
      sourceCount
      revision
      digest
    }
  }
`;

const LIST_BINDING_INTERVALS_QUERY = `
  query ListEntityObservationBindingIntervals(
    $stableEntityId: String!
    $from: Timestamp!
    $to: Timestamp!
    $limit: Int
  ) {
    ListEntityObservationBindingIntervals(
      stableEntityId: $stableEntityId
      from: $from
      to: $to
      limit: $limit
    ) {
      topic
      stableEntityId
      entityTypeKey
      bindingKind
      validFrom
      validTo
      timeBasis
      sourceCount
      revision
      digest
    }
  }
`;

function normalizeTopic(value: string): string {
  const topic = value.trim().normalize("NFC").replace(/^\/+|\/+$/g, "");
  if (!topic || topic.includes("//") || /[+#]/.test(topic)) {
    throw new TypeError("topic must be one concrete non-empty UNS path");
  }
  return topic;
}

function normalizeAsOf(value?: string | Date): string | null {
  if (value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("asOf must be a valid timestamp");
  return parsed.toISOString();
}

function cacheKey(topic: string, asOf: string | null): string {
  return `${asOf ?? "current"}\0${topic}`;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseResolution(value: unknown): EntityBindingResolution | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row["topic"] !== "string") return null;
  if (row["status"] !== "resolved" && row["status"] !== "not-found" && row["status"] !== "ambiguous") return null;
  const sourceCount = Number(row["sourceCount"]);
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 0) return null;
  const bindingKind = row["bindingKind"] === "asset-prefix" || row["bindingKind"] === "attribute-topic"
    ? row["bindingKind"]
    : null;
  return {
    topic: normalizeTopic(row["topic"]),
    asOf: nullableString(row["asOf"]),
    status: row["status"],
    stableEntityId: nullableString(row["stableEntityId"]),
    entityTypeKey: nullableString(row["entityTypeKey"]),
    bindingKind,
    matchedPath: nullableString(row["matchedPath"]),
    timeBasis: nullableString(row["timeBasis"]),
    sourceCount,
    revision: nullableString(row["revision"]),
    digest: nullableString(row["digest"]),
  };
}

function parseInterval(value: unknown): EntityBindingInterval | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row["topic"] !== "string"
    || typeof row["stableEntityId"] !== "string"
    || typeof row["entityTypeKey"] !== "string"
    || row["bindingKind"] !== "attribute-topic"
    || typeof row["validFrom"] !== "string"
    || typeof row["timeBasis"] !== "string"
    || typeof row["revision"] !== "string"
    || typeof row["digest"] !== "string"
  ) return null;
  const sourceCount = Number(row["sourceCount"]);
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 1) return null;
  return {
    topic: normalizeTopic(row["topic"]),
    stableEntityId: row["stableEntityId"].trim().toLowerCase(),
    entityTypeKey: row["entityTypeKey"],
    bindingKind: "attribute-topic",
    validFrom: normalizeAsOf(row["validFrom"])!,
    validTo: row["validTo"] === null ? null : normalizeAsOf(String(row["validTo"])),
    timeBasis: row["timeBasis"],
    sourceCount,
    revision: row["revision"],
    digest: row["digest"],
  };
}

export class ControllerEntityBindingClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly staleIfErrorMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly intervalCache = new Map<string, IntervalCacheEntry>();

  constructor(private readonly options: EntityBindingClientOptions) {
    if (!options.graphqlUrl.trim()) throw new TypeError("graphqlUrl is required");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.staleIfErrorMs = options.staleIfErrorMs ?? 300_000;
    this.now = options.now ?? Date.now;
    if (this.timeoutMs <= 0 || this.cacheTtlMs < 0 || this.staleIfErrorMs < this.cacheTtlMs) {
      throw new RangeError("identity binding client timing limits are invalid");
    }
  }

  async resolveTopics(topics: string[], asOf?: string | Date): Promise<EntityBindingBatchResult> {
    const normalizedTopics = Array.from(new Set(topics.map(normalizeTopic)));
    if (normalizedTopics.length > MAX_ENTITY_BINDING_TOPICS) {
      throw new RangeError(`At most ${MAX_ENTITY_BINDING_TOPICS} identity binding topics may be resolved at once`);
    }
    if (normalizedTopics.length === 0) return { resolutions: [], source: "cache" };
    const normalizedAsOf = normalizeAsOf(asOf);
    const now = this.now();
    const fresh = new Map<string, EntityBindingResolution>();
    const missing: string[] = [];
    for (const topic of normalizedTopics) {
      const cached = this.cache.get(cacheKey(topic, normalizedAsOf));
      if (cached && now - cached.fetchedAt <= this.cacheTtlMs) fresh.set(topic, cached.resolution);
      else missing.push(topic);
    }
    if (missing.length === 0) {
      return { resolutions: normalizedTopics.map((topic) => fresh.get(topic)!), source: "cache" };
    }

    try {
      const fetched = await this.fetchBindings(missing, normalizedAsOf);
      for (const resolution of fetched) {
        if (!missing.includes(resolution.topic)) continue;
        this.cache.set(cacheKey(resolution.topic, normalizedAsOf), { resolution, fetchedAt: now });
        fresh.set(resolution.topic, resolution);
      }
      // The controller intentionally omits unauthorized paths. Do not fabricate
      // path or identity details, and do not cache an omission as authoritative.
      const resolutions = normalizedTopics
        .map((topic) => fresh.get(topic))
        .filter((resolution): resolution is EntityBindingResolution => resolution !== undefined);
      return { resolutions, source: fresh.size === fetched.length ? "controller" : "mixed" };
    } catch (error) {
      for (const topic of missing) {
        const cached = this.cache.get(cacheKey(topic, normalizedAsOf));
        if (cached && now - cached.fetchedAt <= this.staleIfErrorMs) fresh.set(topic, cached.resolution);
      }
      if (fresh.size === normalizedTopics.length) {
        return {
          resolutions: normalizedTopics.map((topic) => fresh.get(topic)!),
          source: "stale-cache",
        };
      }
      throw error;
    }
  }

  invalidate(): void {
    this.cache.clear();
    this.intervalCache.clear();
  }

  async resolveLookups(lookups: EntityBindingLookup[]): Promise<EntityBindingResolution[]> {
    if (lookups.length > MAX_ENTITY_BINDING_TOPICS) {
      throw new RangeError(`At most ${MAX_ENTITY_BINDING_TOPICS} identity binding lookups may be resolved at once`);
    }
    if (lookups.length === 0) return [];
    const normalized = lookups.map((lookup) => ({
      topic: normalizeTopic(lookup.topic),
      asOf: normalizeAsOf(lookup.asOf)!,
    }));
    const token = await this.options.tokenProvider.getAccessToken();
    if (!token) throw new Error("Controller identity binding request requires a service access token");
    const response = await this.fetchImpl(this.options.graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: RESOLVE_BINDING_LOOKUPS_QUERY,
        variables: { lookups: normalized },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json() as {
      data?: { ResolveEntityObservationBindingLookups?: unknown[] | null } | null;
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || payload.errors?.length) {
      throw new Error(payload.errors?.[0]?.message ?? `Controller identity binding request failed with HTTP ${response.status}`);
    }
    const rows = payload.data?.ResolveEntityObservationBindingLookups;
    if (!Array.isArray(rows)) throw new Error("Controller temporal identity binding response is missing data");
    return rows.map(parseResolution).filter((row): row is EntityBindingResolution => row !== null);
  }

  async listIntervals(
    stableEntityId: string,
    from: string | Date,
    to: string | Date,
    limit = MAX_ENTITY_BINDING_TOPICS,
  ): Promise<{ intervals: EntityBindingInterval[]; source: "cache" | "controller" | "stale-cache" }> {
    const entityId = stableEntityId.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entityId)) {
      throw new TypeError("stableEntityId must be a valid UUID");
    }
    const normalizedFrom = normalizeAsOf(from)!;
    const normalizedTo = normalizeAsOf(to)!;
    if (new Date(normalizedFrom).getTime() >= new Date(normalizedTo).getTime()) {
      throw new RangeError("from must be earlier than to");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ENTITY_BINDING_TOPICS) {
      throw new RangeError(`limit must be between 1 and ${MAX_ENTITY_BINDING_TOPICS}`);
    }
    const key = `${entityId}\0${normalizedFrom}\0${normalizedTo}\0${limit}`;
    const now = this.now();
    const cached = this.intervalCache.get(key);
    if (cached && now - cached.fetchedAt <= this.cacheTtlMs) {
      return { intervals: cached.intervals, source: "cache" };
    }
    try {
      const token = await this.options.tokenProvider.getAccessToken();
      if (!token) throw new Error("Controller identity binding request requires a service access token");
      const response = await this.fetchImpl(this.options.graphqlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: LIST_BINDING_INTERVALS_QUERY,
          variables: { stableEntityId: entityId, from: normalizedFrom, to: normalizedTo, limit },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const payload = await response.json() as {
        data?: { ListEntityObservationBindingIntervals?: unknown[] | null } | null;
        errors?: Array<{ message?: string }>;
      };
      if (!response.ok || payload.errors?.length) {
        throw new Error(payload.errors?.[0]?.message ?? `Controller identity binding request failed with HTTP ${response.status}`);
      }
      const rows = payload.data?.ListEntityObservationBindingIntervals;
      if (!Array.isArray(rows)) throw new Error("Controller entity binding interval response is missing data");
      const intervals = rows.map(parseInterval).filter((row): row is EntityBindingInterval => row !== null);
      this.intervalCache.set(key, { intervals, fetchedAt: now });
      return { intervals, source: "controller" };
    } catch (error) {
      if (cached && now - cached.fetchedAt <= this.staleIfErrorMs) {
        return { intervals: cached.intervals, source: "stale-cache" };
      }
      throw error;
    }
  }

  private async fetchBindings(topics: string[], asOf: string | null): Promise<EntityBindingResolution[]> {
    const token = await this.options.tokenProvider.getAccessToken();
    if (!token) throw new Error("Controller identity binding request requires a service access token");
    const response = await this.fetchImpl(this.options.graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: RESOLVE_BINDINGS_QUERY,
        variables: { topics, asOf },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json() as {
      data?: { ResolveEntityObservationBindings?: unknown[] | null } | null;
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || payload.errors?.length) {
      throw new Error(payload.errors?.[0]?.message ?? `Controller identity binding request failed with HTTP ${response.status}`);
    }
    const rows = payload.data?.ResolveEntityObservationBindings;
    if (!Array.isArray(rows)) throw new Error("Controller identity binding response is missing data");
    return rows.map(parseResolution).filter((row): row is EntityBindingResolution => row !== null);
  }
}
