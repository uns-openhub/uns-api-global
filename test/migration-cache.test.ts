import test from 'node:test';
import assert from 'node:assert/strict';
import { automationCacheTopics } from '../src/migration-state.js';

test('automation state includes all referenced peers and excludes the disposable general cache', () => {
  const definitions = [{ sourceTopic: 'factory/a', config: { leftTopic: 'factory/b', rightTopic: 'factory/c', snapshotTopics: ['factory/d'], conditions: [{ topic: 'factory/e' }] } },
    { inputMappings: [{ topic: 'factory/f' }], startCondition: { topic: 'factory/start' }, stopCondition: { topic: 'factory/stop' } }];
  const topics = automationCacheTopics(definitions);
  assert.deepEqual(topics, ['factory/a','factory/b','factory/c','factory/d','factory/e','factory/f','factory/start','factory/stop']);
  const cache = new Map(Array.from({length: 20000}, (_, i) => ['unrelated/'+i, i])); cache.set('factory/a', 0);
  const transferred = topics.flatMap(topic => cache.has(topic) ? [[topic, cache.get(topic)]] : []);
  assert.deepEqual(transferred, [['factory/a', 0]]);
  assert.ok(topics.includes('factory/start')); // Missing values stay absent at the target too.
});
