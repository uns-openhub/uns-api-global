import { ConfigFile } from '@uns-kit/core';
import { ControllerEntityBindingClient, MAX_ENTITY_BINDING_TOPICS } from '../entity-binding-client.js';
import {
  buildFullObservationTopic,
  chooseIdentityAuditTimeColumn,
  classifyIdentityAuditRows,
  emptyIdentityReconciliationCounts,
  identityAuditBlockers,
  identityAuditCountBlockers,
  mergeIdentityReconciliationCounts,
  type IdentityAuditRow,
  type IdentityReconciliationCounts,
} from '../identity-reconciliation-plan.js';
import { projectExtrasSchema } from '../config/project.config.extension.js';

type QuestDbConfig = {
  url: string;
  username: string;
  password: string;
  statementTimeoutMs: number;
};

type QuestDbResult = { columns: string[]; rows: unknown[][] };
type TableReport = {
  table: string;
  timeColumn: string | null;
  scannedRows: number;
  complete: boolean;
  counts: IdentityReconciliationCounts;
  blockers: string[];
};

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function positiveInteger(value: string | null, fallback: number, name: string): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function timestamp(value: string | null, fallback: Date, name: string): string {
  const parsed = value === null ? fallback : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`--${name} must be a valid timestamp`);
  return parsed.toISOString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function queryQuestDb(config: QuestDbConfig, sql: string): Promise<QuestDbResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.statementTimeoutMs);
  try {
    const url = new URL('/exec', config.url);
    url.searchParams.set('query', sql.replace(/\s+/g, ' ').trim());
    url.searchParams.set('count', 'true');
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const payload = await response.json() as {
      error?: string;
      columns?: Array<{ name?: string }>;
      dataset?: unknown[][];
    };
    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? `QuestDB request failed with HTTP ${response.status}`);
    }
    return {
      columns: payload.columns?.map((column) => column.name ?? '') ?? [],
      rows: Array.isArray(payload.dataset) ? payload.dataset : [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

function rowRecord(columns: string[], row: unknown[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
}

async function listTables(config: QuestDbConfig): Promise<string[]> {
  const result = await queryQuestDb(config, 'SHOW TABLES');
  return result.rows.flatMap((row) => typeof row[0] === 'string' ? [row[0]] : []).sort();
}

async function listColumns(config: QuestDbConfig, table: string): Promise<Set<string>> {
  const result = await queryQuestDb(config, `SHOW COLUMNS FROM ${quoteIdentifier(table)}`);
  return new Set(result.rows.flatMap((row) => typeof row[0] === 'string' ? [row[0]] : []));
}

async function auditTable(options: {
  config: QuestDbConfig;
  client: ControllerEntityBindingClient;
  table: string;
  from: string;
  to: string;
  pageSize: number;
  maxRows: number;
}): Promise<TableReport> {
  const columns = await listColumns(options.config, options.table);
  const timeColumn = chooseIdentityAuditTimeColumn(columns);
  const blockers = identityAuditBlockers({ table: options.table, columns, timeColumn });
  const counts = emptyIdentityReconciliationCounts();
  if (blockers.some((blocker) => blocker === 'missing-topic-column' || blocker === 'missing-time-column')) {
    return { table: options.table, timeColumn, scannedRows: 0, complete: false, counts, blockers };
  }
  const selected = ['topic', 'asset', 'objectType', 'objectId', 'attribute', 'stableEntityId', 'identityResolution']
    .filter((column) => columns.has(column));
  selected.push(timeColumn!);
  let scannedRows = 0;
  let complete = true;
  while (scannedRows < options.maxRows) {
    const take = Math.min(options.pageSize, options.maxRows - scannedRows);
    const result = await queryQuestDb(options.config,
      `SELECT ${selected.map(quoteIdentifier).join(', ')}
         FROM ${quoteIdentifier(options.table)}
        WHERE ${quoteIdentifier(timeColumn!)} >= ${quoteLiteral(options.from)}
          AND ${quoteIdentifier(timeColumn!)} < ${quoteLiteral(options.to)}
        ORDER BY ${quoteIdentifier(timeColumn!)}
        LIMIT ${scannedRows}, ${scannedRows + take}`);
    if (!result.rows.length) break;
    const validRows: IdentityAuditRow[] = [];
    for (const rawRow of result.rows) {
      const record = rowRecord(result.columns, rawRow);
      const topic = buildFullObservationTopic(record);
      const parsedTime = new Date(String(record[timeColumn!] ?? ''));
      if (!topic || Number.isNaN(parsedTime.getTime())) {
        counts.unresolvable += 1;
        continue;
      }
      validRows.push({
        topic,
        asOf: parsedTime.toISOString(),
        stableEntityId: typeof record['stableEntityId'] === 'string' && record['stableEntityId']
          ? record['stableEntityId'] : null,
        identityResolution: typeof record['identityResolution'] === 'string'
          ? record['identityResolution'] : null,
      });
    }
    const legacyRows = validRows.filter((row) => !(row.stableEntityId && row.identityResolution === 'resolved'));
    const resolutions = [];
    for (let offset = 0; offset < legacyRows.length; offset += MAX_ENTITY_BINDING_TOPICS) {
      resolutions.push(...await options.client.resolveLookups(
        legacyRows.slice(offset, offset + MAX_ENTITY_BINDING_TOPICS).map((row) => ({
          topic: row.topic,
          asOf: row.asOf,
        })),
      ));
    }
    mergeIdentityReconciliationCounts(counts, classifyIdentityAuditRows(validRows, resolutions));
    scannedRows += result.rows.length;
    if (result.rows.length < take) break;
    if (scannedRows >= options.maxRows) complete = false;
  }
  if (!complete) blockers.push(`scan-limit-reached:${options.maxRows}`);
  blockers.push(...identityAuditCountBlockers(counts));
  return { table: options.table, timeColumn, scannedRows, complete, counts, blockers };
}

const now = new Date();
const to = timestamp(argument('to'), now, 'to');
const from = timestamp(argument('from'), new Date(now.getTime() - 24 * 60 * 60 * 1000), 'from');
if (new Date(from).getTime() >= new Date(to).getTime()) throw new Error('--from must be earlier than --to');
const pageSize = Math.min(1_000, positiveInteger(argument('page-size'), 500, 'page-size'));
const maxRows = positiveInteger(argument('max-rows'), 200_000, 'max-rows');
const requestedTable = argument('table');
const config = await ConfigFile.loadConfig();
const extras = projectExtrasSchema.parse({ questdb: config.questdb, catchAll: config.catchAll, dataSources: config.dataSources });
if (typeof extras.questdb.url !== 'string' || typeof extras.questdb.username !== 'string' || typeof extras.questdb.password !== 'string') {
  throw new Error('Resolved QuestDB URL and credentials are required');
}
const graphqlUrl = typeof config.uns?.graphql === 'string' ? config.uns.graphql : '';
const token = process.env['UNS_IDENTITY_RECONCILIATION_TOKEN']?.trim()
  || (typeof config.uns?.token === 'string' ? config.uns.token : '');
if (!graphqlUrl || !token) throw new Error('Controller GraphQL URL and UNS_IDENTITY_RECONCILIATION_TOKEN are required');
const questDbConfig: QuestDbConfig = {
  url: extras.questdb.url,
  username: extras.questdb.username,
  password: extras.questdb.password,
  statementTimeoutMs: extras.questdb.statementTimeoutMs,
};
const client = new ControllerEntityBindingClient({
  graphqlUrl,
  tokenProvider: { getAccessToken: async () => token },
  timeoutMs: extras.questdb.statementTimeoutMs,
});
const discoveredTables = requestedTable ? [requestedTable] : await listTables(questDbConfig);
const reports: TableReport[] = [];
for (const table of discoveredTables) {
  reports.push(await auditTable({ config: questDbConfig, client, table, from, to, pageSize, maxRows }));
}
const totals = reports.reduce(
  (sum, report) => mergeIdentityReconciliationCounts(sum, report.counts),
  emptyIdentityReconciliationCounts(),
);
process.stdout.write(`${JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: 'read-only',
  window: { from, to, toExclusive: true },
  limits: { pageSize, maxRowsPerTable: maxRows },
  totals,
  tables: reports,
}, null, 2)}\n`);
