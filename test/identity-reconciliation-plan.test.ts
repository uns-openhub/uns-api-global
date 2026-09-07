import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFullObservationTopic,
  chooseIdentityAuditTimeColumn,
  classifyIdentityAuditRows,
  identityAuditBlockers,
  identityAuditCountBlockers,
} from '../src/identity-reconciliation-plan.js';

test('classifies identity-aware and event-time legacy rows without current-owner fallback', () => {
  const rows = [
    { topic: 'site/a/value', asOf: '2026-09-01T09:00:00.000Z', stableEntityId: 'id-1', identityResolution: 'resolved' },
    { topic: 'site/b/value', asOf: '2026-09-01T10:00:00.000Z', stableEntityId: null, identityResolution: null },
    { topic: 'site/c/value', asOf: '2026-09-01T11:00:00.000Z', stableEntityId: null, identityResolution: null },
    { topic: 'site/d/value', asOf: '2026-09-01T12:00:00.000Z', stableEntityId: null, identityResolution: null },
  ];
  const counts = classifyIdentityAuditRows(rows, [
    { topic: rows[1]!.topic, asOf: rows[1]!.asOf, status: 'resolved' },
    { topic: rows[2]!.topic, asOf: rows[2]!.asOf, status: 'ambiguous' },
    { topic: rows[3]!.topic, asOf: rows[3]!.asOf, status: 'not-found' },
  ] as never);
  assert.deepEqual(counts, {
    'identity-aware': 1,
    'legacy-resolvable': 1,
    ambiguous: 1,
    unresolvable: 1,
  });
  assert.deepEqual(identityAuditCountBlockers(counts), [
    'ambiguous-rows:1',
    'unresolvable-rows:1',
  ]);
});

test('reconstructs exact UNS topics and reports schemas that cannot be audited safely', () => {
  assert.equal(buildFullObservationTopic({
    topic: '/site/line-a/', asset: 'press-14', objectType: 'equipment', objectId: 'main', attribute: 'temperature',
  }), 'site/line-a/press-14/equipment/main/temperature');
  assert.equal(chooseIdentityAuditTimeColumn(['topic', 'timestamp', 'time']), 'time');
  assert.deepEqual(identityAuditBlockers({
    table: 'partial', columns: new Set(['topic', 'time', 'stableEntityId']), timeColumn: 'time',
  }), ['partial-identity-schema:identityResolution,identityTimeBasis']);
  assert.deepEqual(identityAuditBlockers({
    table: 'unsafe', columns: new Set(['value']), timeColumn: null,
  }), ['missing-topic-column', 'missing-time-column']);
});
