import type { TableSchema } from './catchall-helpers.js';
import type { QuestDbMappingEntry } from './questdb-mapping-cache.js';

export const HISTORY_SOURCE_COLUMN = '__historySourceTable';
export const MAX_HISTORY_TABLES = 8;
export type HistoryTableSource = string | { tables: string[]; columns: string[] };
export class HistorySourceError extends Error {
  readonly status = 409;
}
const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Only typed, validated identifiers can create a relation; callers cannot supply SQL. */
export function historyTableRelation(source: HistoryTableSource, where?: string, orderColumn?: string): string {
  if (typeof source === 'string') return quote(source);
  if (!source.tables.length || source.tables.length > MAX_HISTORY_TABLES ||
      source.tables.some(table => !/^[a-zA-Z0-9_-]+$/.test(table))) {
    throw new HistorySourceError('Invalid or excessive history table sources. Select one explicit table.');
  }
  const columns = source.columns.map(quote).join(', ');
  const timeColumn = orderColumn ?? ['timestamp', 'time', 'intervalStart', 'intervalEnd'].find(column => source.columns.includes(column));
  if (!timeColumn || !source.columns.includes(timeColumn)) throw new HistorySourceError('History source has no compatible ordering column.');
  const union = source.tables.map(table =>
    `SELECT ${columns}, ${literal(table)} AS ${quote(HISTORY_SOURCE_COLUMN)} FROM ${quote(table)}${where ? ` WHERE ${where}` : ''}`,
  ).join('\nUNION ALL\n');
  // first/last aggregates must see chronological input; equal-time ties use a
  // stable table-name order, never an inferred current publisher.
  return `(SELECT * FROM (${union}) ORDER BY ${quote(timeColumn)} ASC, ${quote(HISTORY_SOURCE_COLUMN)} ASC)`;
}

export function validateHistoryMappings(mappings: QuestDbMappingEntry[]): string[] {
  const tables = [...new Set(mappings.map(mapping => mapping.tableName!).filter(Boolean))].sort();
  if (tables.length > MAX_HISTORY_TABLES) {
    throw new HistorySourceError(`History has more than ${MAX_HISTORY_TABLES} mapped tables. Select one explicit table.`);
  }
  if (tables.length > 1) {
    for (const field of ['suffix', 'questdbUrl'] as const) {
      // Unknown legacy metadata is also an ambiguity when mixed with known metadata.
      const values = new Set(mappings.map(mapping => (mapping[field] ?? '').trim().replace(/\/+$/, '')));
      if (values.size > 1) {
        throw new HistorySourceError(`History mappings disagree on ${field}. Select one explicit table or review the mappings.`);
      }
    }
  }
  return tables;
}

export function combineHistorySchemas(tables: string[], schemas: TableSchema[]): {
  source: HistoryTableSource; schema: TableSchema;
} {
  const first = schemas[0];
  if (!first || schemas.length !== tables.length) throw new HistorySourceError('History schema unavailable.');
  if (tables.length === 1) return { source: tables[0]!, schema: first };
  const columns = [...first.orderedColumns];
  if (first.columns.has(HISTORY_SOURCE_COLUMN)) throw new HistorySourceError('History schema uses the reserved source-table column.');
  for (const schema of schemas) {
    if (schema.columns.size !== first.columns.size || columns.some(column =>
      !schema.columns.has(column) || !first.columnTypes.get(column) ||
      first.columnTypes.get(column) !== schema.columnTypes.get(column))) {
      throw new HistorySourceError('History tables have incompatible column names or types. Select one explicit table or migrate their schemas.');
    }
  }
  return {
    source: { tables, columns },
    schema: {
      columns: new Set([...first.columns, HISTORY_SOURCE_COLUMN]),
      orderedColumns: [...columns, HISTORY_SOURCE_COLUMN],
      columnTypes: new Map([...first.columnTypes, [HISTORY_SOURCE_COLUMN, 'STRING']]),
    },
  };
}

export function assertHistoryTransform(source: HistoryTableSource, transform: string): void {
  if (typeof source !== 'string' && transform === 'delta') {
    throw new HistorySourceError('Counter continuity across publishers is unknown. Select one explicit table for transform=delta.');
  }
}

export function historySourceMetadata(tables: string[], mappings: QuestDbMappingEntry[]) {
  return {
    mode: tables.length > 1 ? 'union' : 'single', tables,
    overlapPolicy: 'preserve-observations',
    equalTimeOrder: tables.length > 1 ? 'table-name' : null,
    provenance: mappings.filter(mapping => tables.includes(mapping.tableName ?? '')).map(mapping => ({
      table: mapping.tableName, topicPrefix: mapping.topicPrefix,
      processName: mapping.processName ?? null, packageName: mapping.packageName ?? null,
      version: mapping.version ?? null, dataGroup: mapping.dataGroup ?? null,
      suffix: mapping.suffix ?? null, registeredAt: mapping.updatedAt ?? null,
      historyId: mapping.historyId ?? null, revision: mapping.historyRevision ?? null,
      state: mapping.historyId ? (mapping.retiredAt ? 'retained' : 'active') : 'unknown',
      retiredAt: mapping.retiredAt ?? null,
    })),
  };
}
