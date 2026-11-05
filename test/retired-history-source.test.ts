import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryReadError, QuestDbRequestError, readHistory } from '../src/history-source-diagnostics.js';
import { historySourceMetadata, readAvailableHistory } from '../src/history-table-source.js';
import type { QuestDbMappingEntry } from '../src/questdb-mapping-cache.js';

const tables = ['old_data', 'new_data'];
const retired = { tableName: 'old_data', historyId: 'old', retiredAt: '2026-10-13T00:00:00Z' };
const current = { tableName: 'new_data', historyId: 'new', retiredAt: null };
const mappings = [retired, current];
const missing = (name: string, status = 400) =>
  new QuestDbRequestError('response', status, `table does not exist [table=${name}]`);

for (const phase of ['schema', 'query'] as const) {
  test(`automatic history retries after a retired table disappears during ${phase}`, async () => {
    const attempts: string[][] = [];
    const history = await readAvailableHistory({ tables, mappings, allowMissingRetained: true }, (selected, missingTables) => {
      attempts.push(selected);
      return readHistory(selected, phase, async () => {
        if (selected.includes('old_data')) throw missing('old_data');
        return historySourceMetadata(selected, mappings, missingTables);
      });
    });
    assert.deepEqual(attempts, [tables, ['new_data']]);
    assert.deepEqual(history.tables, ['new_data']);
    assert.deepEqual(history.missingTables, ['old_data']);
    assert.equal(history.complete, false);
  });
}

test('automatic history keeps retained sources that are readable, including after recreation', async () => {
  const history = await readAvailableHistory({ tables, mappings, allowMissingRetained: true },
    async (selected, missingTables) => historySourceMetadata(selected, mappings, missingTables));
  assert.deepEqual(history.tables, tables);
  assert.equal(history.missingTables, undefined);
});

const strictCases: Array<{ name: string; entries: QuestDbMappingEntry[]; error: QuestDbRequestError; enabled?: boolean; code: string }> = [
  { name: 'strict request', entries: mappings, error: missing('old_data'), enabled: false, code: 'HISTORY_TABLE_MISSING' },
  { name: 'active source', entries: mappings, error: missing('new_data'), code: 'HISTORY_TABLE_MISSING' },
  { name: 'shared active source', entries: [...mappings, { ...current, tableName: 'old_data' }], error: missing('old_data'), code: 'HISTORY_TABLE_MISSING' },
  { name: 'unknown mapping state', entries: [{ tableName: 'old_data' }, current], error: missing('old_data'), code: 'HISTORY_TABLE_MISSING' },
  { name: 'unrelated source', entries: mappings, error: missing('other_data'), code: 'HISTORY_READ_FAILED' },
  { name: 'database denied', entries: mappings, error: missing('old_data', 403), code: 'HISTORY_DATABASE_ACCESS_DENIED' },
  { name: 'database unavailable', entries: mappings, error: missing('old_data', 503), code: 'HISTORY_DATABASE_UNAVAILABLE' },
];
for (const { name, entries, error, enabled = true, code } of strictCases) {
  test(`${name} remains a single failed attempt`, async () => {
    let attempts = 0;
    await assert.rejects(readAvailableHistory({ tables, mappings: entries, allowMissingRetained: enabled },
      selected => readHistory(selected, 'query', async () => { attempts++; throw error; })),
    (err: unknown) => err instanceof HistoryReadError && err.diagnostic.code === code);
    assert.equal(attempts, 1);
  });
}

test('automatic history fails when no source remains', async () => {
  const bothRetired = [retired, { ...current, retiredAt: retired.retiredAt }];
  await assert.rejects(readAvailableHistory({ tables, mappings: bothRetired, allowMissingRetained: true },
    selected => readHistory(selected, 'schema', async () => { throw missing(selected[0]!); })),
  (err: unknown) => err instanceof HistoryReadError && err.diagnostic.tables[0] === 'new_data');
});
