import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundCacheSeed } from '../src/background-cache-seed.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('release stops a large initial fill, waits for admitted reads and rejects late cache writes', async () => {
  const pending = Array.from({ length: 4 }, () => deferred<number>());
  const calls: string[] = [], cache = new Map<string, number>();
  const seed = new BackgroundCacheSeed({
    hasValue: topic => cache.has(topic),
    load: topic => { const index = calls.push(topic) - 1; return pending[index]!.promise; },
    apply: (topic, value: number) => { cache.set(topic, value); return true; },
    onError: () => assert.fail('No lookup should fail'),
  });
  const run = seed.start(Array.from({ length: 20_000 }, (_, i) => 'enterprise/point/' + i));
  assert.equal(calls.length, 4);
  seed.pause();
  let settled = false;
  void run.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'accepted reads still belong to the drain');
  // The source state or a live packet arrives before an older seed response.
  cache.set(calls[0]!, 99);
  pending.forEach((value, i) => value.resolve(i));
  assert.deepEqual(await run, { inserted: 0, interrupted: true });
  assert.equal(calls.length, 4, 'remaining 19,996 topics never reach SQL');
  assert.deepEqual([...cache], [[calls[0], 99]]);
});

test('the next owner can warm its missing cache after the previous reads settle', async () => {
  const held = deferred<number>();
  const calls: string[] = [], cache = new Map<string, number>();
  let hold = true;
  const seed = new BackgroundCacheSeed({
    hasValue: topic => cache.has(topic),
    load: async topic => { calls.push(topic); return hold ? held.promise : 5; },
    apply: (topic, value: number) => { if (cache.has(topic)) return false; cache.set(topic, value); return true; },
    onError: () => assert.fail('No lookup should fail'),
  });
  const first = seed.start(['enterprise/a']);
  assert.equal(seed.start(['enterprise/other']), first, 'no overlapping seed generations');
  seed.pause(); held.resolve(1); await first;
  hold = false; cache.set('enterprise/a', 99);
  assert.deepEqual(await seed.start(['enterprise/a', 'enterprise/b']), { inserted: 1, interrupted: false });
  assert.deepEqual([...cache], [['enterprise/a', 99], ['enterprise/b', 5]]);
  assert.deepEqual(calls, ['enterprise/a', 'enterprise/b']);
});

test('missing values and failed lookups do not prevent valid cache recovery', async () => {
  const cache = new Map<string, number>(); let errors = 0;
  const seed = new BackgroundCacheSeed({
    hasValue: topic => cache.has(topic),
    load: async topic => { if (topic === 'bad') throw Error('unavailable'); return topic === 'empty' ? null : 7; },
    apply: (topic, value: number) => { cache.set(topic, value); return true; },
    onError: () => { errors++; },
  });
  assert.deepEqual(await seed.start(['empty', 'bad', 'valid']), { inserted: 1, interrupted: false });
  assert.deepEqual([...cache], [['valid', 7]]);
  assert.equal(errors, 1);
  assert.deepEqual(await seed.start([]), { inserted: 0, interrupted: false });
});
