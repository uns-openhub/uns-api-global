import { sanitizeTable } from "./catchall-helpers.js";

export type QuestDbMappingEntry = {
  topicPrefix?: string | null;
  tableName?: string | null;
  tablePrefix?: string | null;
  dataGroup?: string | null;
  suffix?: string | null;
  questdbUrl?: string | null;
  processName?: string | null;
  packageName?: string | null;
  version?: string | null;
  updatedAt?: string | null;
  historyId?: string | null;
  historyRevision?: string | null;
  retiredAt?: string | null;
};
// History readers explicitly request retained sources. An unsupported controller
// contract fails visibly instead of silently falling back to a partial active set.
export const QUESTDB_HISTORY_MAPPINGS_QUERY = `query QuestMappings { QuestDBMappings(includeHistory: true) { topicPrefix tableName tablePrefix dataGroup suffix questdbUrl processName packageName version updatedAt historyId historyRevision retiredAt } }`;

type LoadMappings = (signal: AbortSignal) => Promise<QuestDbMappingEntry[]>;

/** Retain all physical sources at the most specific matching topic rule. */
export function selectMappedHistory(topic: string, mappings: QuestDbMappingEntry[]): QuestDbMappingEntry[] {
  const normalized = topic.replace(/^\/+|\/+$/g, "");
  const segments = normalized.split('/');
  const candidates = mappings.flatMap(entry => {
    const prefix = (entry.topicPrefix ?? '').replace(/^\/+|\/+$/g, '');
    const suffix = (entry.suffix ?? '').replace(/^_+/, '');
    const table = sanitizeTable((entry.tableName || (entry.tablePrefix && suffix ? entry.tablePrefix + '_' + suffix : entry.tablePrefix) || '').trim());
    if (!prefix || !table) return [];
    const parts = prefix.split('/');
    if (parts.some((part, i) => part === '#' && i !== parts.length - 1)) return [];
    const wildcard = parts.includes('#') || parts.includes('+');
    const matches = wildcard
      ? parts.every((part, i) => part === '#' || (i < segments.length && (part === '+' || part === segments[i]))) &&
        (parts.at(-1) === '#' || parts.length === segments.length)
      : normalized === prefix || normalized.startsWith(prefix + '/');
    return [{ entry: { ...entry, tableName: table }, prefix, matches,
      score: parts.filter(part => part !== '+' && part !== '#').join('/').length }];
  });
  const direct = candidates.filter(candidate => candidate.matches);
  if (direct.length) {
    const score = Math.max(...direct.map(candidate => candidate.score));
    return direct.filter(candidate => candidate.score === score).map(candidate => candidate.entry);
  }
  // Only a sibling Object ID under the same parent and attribute is eligible.
  if (segments.length < 3) return [];
  const parent = segments.slice(0, -2).join('/');
  return candidates.filter(candidate => {
    const parts = candidate.prefix.split('/');
    return parts.length === segments.length && parts.slice(0, -2).join('/') === parent &&
      parts.at(-1) === segments.at(-1) && !parts.includes('+') && !parts.includes('#');
  }).map(candidate => candidate.entry);
}

/** Legacy single-source users (cache seeding) retain their existing lookup contract. */
export function selectMappedTable(topic: string, mappings: QuestDbMappingEntry[]): string | null {
  return selectMappedHistory(topic, mappings)[0]?.tableName ?? null;
}

/** One cache and cooldown for all topics; unknown-topic traffic cannot grow a negative cache. */
export class QuestDbMappingCache {
  private entries: QuestDbMappingEntry[] = [];
  private fetchedAt: number | null = null;
  private lastRefreshAt: number | null = null;
  private lastMissRefreshAt: number | null = null;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly options: {
      now?: () => number;
      ttlMs?: number;
      cooldownMs?: number;
      timeoutMs?: number;
      onError?: () => void;
    } = {},
  ) {}

  async resolve(topic: string, load: LoadMappings): Promise<string | null> {
    return (await this.resolveHistory(topic, load))[0]?.tableName ?? null;
  }

  async resolveHistory(topic: string, load: LoadMappings): Promise<QuestDbMappingEntry[]> {
    const now = this.now();
    const expired = this.fetchedAt === null || now - this.fetchedAt >= (this.options.ttlMs ?? 60_000);
    if (expired) await this.refresh(load, false);
    const mappings = selectMappedHistory(topic, this.entries);
    if (mappings.length) return mappings;
    if (!expired) await this.refresh(load, true);
    else this.lastMissRefreshAt = this.lastRefreshAt;
    return selectMappedHistory(topic, this.entries);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private refresh(load: LoadMappings, miss: boolean): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    const lastAttempt = miss ? this.lastMissRefreshAt : this.lastRefreshAt;
    if (
      lastAttempt !== null &&
      now - lastAttempt < (this.options.cooldownMs ?? 5_000)
    )
      return Promise.resolve();
    this.lastRefreshAt = now;
    // Every refresh already checks all misses. Allow a single warm-cache miss
    // after a successful ordinary load, then coalesce/throttle subsequent ones.
    if (miss) this.lastMissRefreshAt = now;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.inFlight = (async () => {
      try {
        const entries = await Promise.race([
          Promise.resolve().then(() => load(controller.signal)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("Mapping refresh timed out"));
            }, this.options.timeoutMs ?? 3_000);
          }),
        ]);
        this.entries = entries;
        this.fetchedAt = this.now();
      } catch {
        this.lastMissRefreshAt = this.lastRefreshAt;
        // Keep the last valid snapshot so a controller outage does not break known topics.
        this.options.onError?.();
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
}
