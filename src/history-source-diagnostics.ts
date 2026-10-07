/** Safe public diagnostics. Raw upstream errors are never serialized. */
export class QuestDbRequestError extends Error {
  constructor(readonly kind: 'response' | 'unavailable' | 'timeout', readonly upstreamStatus?: number,
    readonly upstreamMessage?: string) { super('QuestDB request failed'); }
}
export type HistoryDiagnostic = {
  code: string; scope: 'source' | 'database' | 'request'; phase: 'schema' | 'query';
  tables: string[]; action: string;
};
export class HistoryReadError extends Error {
  constructor(readonly status: number, message: string, readonly diagnostic: HistoryDiagnostic) { super(message); }
}
export async function readHistory<T>(tables: string[], phase: 'schema' | 'query', read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (!(error instanceof QuestDbRequestError)) throw error;
    const safeTables = tables.filter(t => /^[a-zA-Z0-9_-]+$/.test(t));
    // Attribute only a literal table named by QuestDB, and only within this request.
    const missing = error.upstreamMessage?.match(/^table does not exist \[table=([a-zA-Z0-9_-]+)\]$/i)?.[1] ?? error.upstreamMessage?.match(/^table does not exist\s*[:=]\s*["'`]?([a-zA-Z0-9_-]+)["'`]?\s*(?:$|[\]\n])/i)?.[1];
    if (missing && safeTables.includes(missing)) {
      throw new HistoryReadError(409, `History source '${missing}' is unavailable.`, {
        code: 'HISTORY_TABLE_MISSING', scope: 'source', phase, tables: [missing],
        action: 'Restore this table and retry, or explicitly select another registered source. Automatic history requires every selected source.',
      });
    }
    const denied = error.upstreamStatus === 401 || error.upstreamStatus === 403;
    const timeout = error.kind === 'timeout';
    const unavailable = error.kind === 'unavailable' || (error.upstreamStatus ?? 0) >= 500;
    throw new HistoryReadError(denied || timeout || unavailable ? 503 : 409,
      denied ? 'History database access was denied.' : timeout ? 'History database request timed out.' : unavailable ? 'History database is unavailable.' : 'Selected history sources could not be read.', {
        code: denied ? 'HISTORY_DATABASE_ACCESS_DENIED' : timeout ? 'HISTORY_DATABASE_TIMEOUT' : unavailable ? 'HISTORY_DATABASE_UNAVAILABLE' : 'HISTORY_READ_FAILED',
        scope: denied || timeout || unavailable ? 'database' : 'request', phase, tables: safeTables,
        action: denied ? 'Check the history service database credentials and permissions, then retry.' : timeout ? 'Check database health or narrow the requested time range, then retry.' : unavailable ? 'Check the history database connection and service health, then retry.' : 'Review the selected source schemas and history service diagnostics, then retry.',
      });
  }
}
