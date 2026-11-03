import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { LatestLookupCoordinator } from '../src/latest-value-history.js';
import { isHistoryAllowed } from '../src/topic-matcher.js';
import { QueryDiagnostics } from '../src/query-diagnostics.js';
import { queryQuestDbHttp } from '../src/questdb-http.js';
import { BackgroundCacheSeed } from '../src/background-cache-seed.js';

const sources = [
  { topic: 'enterprise/blocked/#', history: false, cache: true },
  { topic: 'enterprise/#', history: true, cache: true },
];

async function fixture() {
  let sqlCalls = 0, admittedLookups = 0;
  const server = createServer((_req, res) => {
    sqlCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ columns: [{ name: 'value', type: 'INT' }], dataset: [[7]] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const diagnostics = new QueryDiagnostics({
    maxConcurrent: 1, maxQueued: 8, queueTimeoutMs: 100,
    slowQueryMs: 1000, failureCooldownMs: 0, databaseLabel: 'local-policy-test', emit: () => {},
  });
  const coordinator = new LatestLookupCoordinator<number>({
    canLoad: topic => isHistoryAllowed(sources, topic),
    runLookup: (id, load) => { admittedLookups++; return diagnostics.runRecovery(id, load); },
  });
  const load = (topic: string) => coordinator.run(topic, async signal => {
    const result = await queryQuestDbHttp(diagnostics, {
      url: `http://127.0.0.1:${address.port}`, username: 'local', password: 'test-only', statementTimeoutMs: 1000,
    }, 'SELECT 7 AS value', 'latest-fallback', signal);
    return (result.data[0] as number[])[0]!;
  });
  return { coordinator, diagnostics, load, calls: () => sqlCalls, admitted: () => admittedLookups,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

test('repeated cache-only and unconfigured latest misses never enter recovery or issue SQL', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => f.load(
      i % 2 ? 'enterprise/blocked/equipment/main/value' : 'other/site/equipment/main/value',
    )));
    assert.ok(results.every(value => value === null));
    assert.equal(f.calls(), 0);
    assert.equal(f.admitted(), 0);
    assert.equal(f.coordinator.failureCount, 0);
    assert.equal(f.diagnostics.snapshot()['active'], 0);
    assert.equal(await f.load('enterprise/healthy/equipment/main/value'), 7);
    assert.equal(f.calls(), 1, 'healthy recovery still reaches the ordinary bounded SQL path');
  } finally { await f.close(); }
});

test('startup seeding honors history:false while retaining live cache values and healthy recovery', async () => {
  const f = await fixture();
  const cache = new Map<string, number>();
  const blocked = 'enterprise/blocked/equipment/main/value', healthy = 'enterprise/healthy/equipment/main/value';
  const seed = new BackgroundCacheSeed({
    hasValue: topic => cache.has(topic), load: f.load,
    apply: (topic, value: number) => { cache.set(topic, value); return true; },
    onError: () => assert.fail('disabled SQL is a cache miss, not a recovery failure'),
  });
  try {
    assert.deepEqual(await seed.start([blocked, healthy]), { inserted: 1, interrupted: false });
    assert.equal(f.calls(), 1);
    assert.deepEqual([...cache], [[healthy, 7]]);
    cache.set(blocked, 42); // A real MQTT arrival remains available independently of SQL recovery policy.
    assert.deepEqual(await seed.start([blocked, healthy]), { inserted: 0, interrupted: false });
    assert.equal(cache.get(blocked), 42);
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});
