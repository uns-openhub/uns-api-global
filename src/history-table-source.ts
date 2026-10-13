import type { TableSchema } from './catchall-helpers.js';
import { detectEntityStorageSchema } from './entity-query-planner.js';
import type { HistoryDiagnostic } from './history-source-diagnostics.js';
import type { QuestDbMappingEntry } from './questdb-mapping-cache.js';

export const HISTORY_SOURCE_COLUMN = '__historySourceTable';
export const MAX_HISTORY_TABLES = 8;
export type HistoryTableSource = string | { tables: string[]; columns: string[]; nullableMetadata?: Record<string, string[]> };
export class HistorySourceError extends Error {
  readonly status = 409;
  constructor(message: string, readonly diagnostic?: HistoryDiagnostic) { super(message); }
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

  const timeColumn = orderColumn ?? ['timestamp', 'time', 'intervalStart', 'intervalEnd'].find(column => source.columns.includes(column));
  if (!timeColumn || !source.columns.includes(timeColumn)) throw new HistorySourceError('History source has no compatible ordering column.');
  const union = source.tables.map(table => {
    const nullable = source.nullableMetadata;
    const columns = source.columns.map(column => nullable?.[column]
      ? `${nullable[column]!.includes(table) ? 'CAST(NULL AS STRING)' : `CAST(${quote(column)} AS STRING)`} AS ${quote(column)}`
      : quote(column)).join(', ');
    // Project before filtering so identity predicates see typed NULLs in legacy
    // sources. No identity is invented; existing authorized legacy-path rules apply.
    const projected = `SELECT ${columns}, ${literal(table)} AS ${quote(HISTORY_SOURCE_COLUMN)} FROM ${quote(table)}`;
    return where ? `SELECT * FROM (${projected}) WHERE ${where}` : projected;
  }).join('\nUNION ALL\n');
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

// Only known optional identity enrichment is nullable. Missing measurement,
// time, path, session or arbitrary Table payload columns remain conflicts.
const OPTIONAL_IDENTITY_METADATA = new Set([
  'fullTopic', 'stableEntityId', 'entityTypeKey', 'identityResolution',
  'identityTimeBasis', 'identityBindingRevision', 'identityBindingDigest',
]);
const TEXT_TYPES = new Set(['STRING', 'VARCHAR', 'SYMBOL']);

export function currentHistoryTable(tables: string[], mappings: QuestDbMappingEntry[]): string | null {
  const candidates = mappings.filter(m => tables.includes(m.tableName ?? ''));
  if (candidates.some(m => !m.historyId || m.retiredAt === undefined)) return null;
  const active = [...new Set(candidates.filter(m => m.retiredAt === null)
    .map(m => m.tableName!))];
  return active.length === 1 ? active[0]! : null;
}

export function combineHistorySchemas(tables: string[], schemas: TableSchema[], mappings: QuestDbMappingEntry[] = []): {
  source: HistoryTableSource; schema: TableSchema;
} {
  const first = schemas[0];
  if (!first || schemas.length !== tables.length) throw new HistorySourceError('History schema unavailable.');
  if (tables.length === 1) return { source: tables[0]!, schema: first };
  if (!tables.length || tables.length > MAX_HISTORY_TABLES || tables.some(t => !/^[a-zA-Z0-9_-]+$/.test(t))) {
    throw new HistorySourceError('Invalid or excessive history table sources.');
  }
  if (schemas.some(schema => schema.columns.has(HISTORY_SOURCE_COLUMN))) throw new HistorySourceError('History schema uses the reserved source-table column.');
  const columns = [...new Set(schemas.flatMap(schema => schema.orderedColumns))];
  const nullableMetadata: Record<string, string[]> = {};
  const columnTypes = new Map(first.columnTypes);
  const completeOrLegacy = schemas.every(schema => detectEntityStorageSchema(schema.columns).mode !== 'partial');
  const conflicts: NonNullable<HistoryDiagnostic['conflicts']> = [];
  for (const column of columns) {
    const types = schemas.map(schema => schema.columns.has(column) ? schema.columnTypes.get(column) ?? null : null);
    const missing = schemas.some(schema => !schema.columns.has(column));
    const unknownType = schemas.some(schema => schema.columns.has(column) && !schema.columnTypes.get(column));
    // Partial identity layouts are not promoted to a complete identity contract.
    if (!unknownType && missing && OPTIONAL_IDENTITY_METADATA.has(column) && completeOrLegacy && types.every(type => type === null || TEXT_TYPES.has(type))) {
      nullableMetadata[column] = tables.filter((_, i) => types[i] === null);
      columnTypes.set(column, 'STRING');
    } else if (!missing && !unknownType && types.every(type => type !== null && TEXT_TYPES.has(type)) && types.some(type => type !== types[0])) {
      nullableMetadata[column] = [];
      columnTypes.set(column, 'STRING');
    } else if (missing || unknownType || types.some(type => type !== types[0])) {
      conflicts.push({column: /^[a-zA-Z_][a-zA-Z0-9_]{0,95}$/.test(column) ? column : '(unsupported column)',
        sources: tables.map((table, i) => ({table, type: types[i] && /^[A-Z0-9_() ,]{1,48}$/.test(types[i]!) ? types[i] : null}))});
    }
  }
  if (conflicts.length) {
    const currentTable = currentHistoryTable(tables, mappings);
    throw new HistorySourceError('History sources have incompatible column names or types. Select a source to read its history separately.', {
      code: 'HISTORY_SCHEMA_CONFLICT', scope: 'source', phase: 'schema', tables,
      action: currentTable ? 'Select the current source; older sources will not be included.' : 'Select one registered source; no unique current source is known.',
      currentTable, conflicts: conflicts.slice(0, 32),
    });
  }
  return { source: {tables, columns, ...(Object.keys(nullableMetadata).length ? {nullableMetadata} : {})},
    schema: { columns: new Set([...columns, HISTORY_SOURCE_COLUMN]), orderedColumns: [...columns, HISTORY_SOURCE_COLUMN],
      columnTypes: new Map([...columnTypes, [HISTORY_SOURCE_COLUMN, 'STRING']]) } };
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
