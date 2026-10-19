import { HttpError, type TimeRange } from './catchall-helpers.js';

/** Explicit opt-in: normal chart/history requests retain their inclusive bounds. */
export function rawExportRange(query: Record<string, unknown>, range: TimeRange,
  options: { summary: boolean; sampled: boolean; transform: string; dedupe: boolean; maxLookbackHours?: number }): TimeRange | null {
  if (query['exportWindow'] === undefined) return null;
  if (query['exportWindow'] !== 'half-open' || options.summary || options.sampled || options.transform !== 'raw' || options.dedupe) {
    throw new HttpError(400, 'exportWindow=half-open requires raw rows, dedupe=false and explicit UTC from/to.');
  }
  const precise = (key: 'from' | 'to'): string => {
    const value = query[key];
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new HttpError(400, 'Raw export bounds require explicit UTC timestamps with up to nine fractional digits.');
    }
    // normalizeRange has already enforced the configured lookback budget. Keep
    // fractional precision instead of rounding nanosecond split points to Date ms.
    if (new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new HttpError(400, 'Raw export contains an invalid calendar date.');
    return value;
  };
  const from = precise('from'), to = precise('to');
  const canonical = (value: string) => value.replace(/(?:\.(\d+))?Z$/, (_, fraction: string | undefined) => '.' + (fraction ?? '').padEnd(9, '0') + 'Z');
  if (canonical(from) >= canonical(to)) throw new HttpError(400, 'Raw export requires from before to.');
  if (options.maxLookbackHours !== undefined) {
    const nanos = (value: string) => BigInt(Date.parse(value.slice(0, 19) + 'Z')) * 1_000_000n + BigInt((value.split('.')[1]?.slice(0, -1) ?? '').padEnd(9, '0'));
    if (nanos(to) - nanos(from) > BigInt(Math.floor(options.maxLookbackHours * 3_600_000)) * 1_000_000n) {
      throw new HttpError(400, 'Raw export exceeds the configured maxLookbackHours. Narrow the time range.');
    }
  }
  return { ...range, from, to, toExclusive: true };
}

/** Look ahead by exactly one, return at most the configured maxLimit. */
export function completeRawExportPage(result: {data: unknown[]; raw: Record<string, unknown>}, limit: number) {
  return { data: result.data.slice(0, limit), raw: result.raw, truncated: result.data.length > limit || (typeof result.raw["count"] === "number" && result.raw["count"] > result.data.length) };
}

/** Closing an aborted response cancels the one active bounded QuestDB read. */
export function cancelRawExportOnDisconnect(response: {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  writableEnded: boolean;
}): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const disconnected = () => { if (!response.writableEnded) controller.abort(); };
  response.once('close', disconnected);
  return { signal: controller.signal, dispose: () => response.off('close', disconnected) };
}
