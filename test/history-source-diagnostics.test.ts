import test from 'node:test';
import assert from 'node:assert/strict';
import {readHistory, QuestDbRequestError, HistoryReadError} from '../src/history-source-diagnostics.js';
import {historySourceMetadata} from '../src/history-table-source.js';
import {QUESTDB_HISTORY_MAPPINGS_QUERY} from '../src/questdb-mapping-cache.js';
async function diagnose(error: QuestDbRequestError, phase: 'query' | 'schema' = 'query') {
 try { await readHistory(['old_data','new_data'], phase, async()=>{throw error;}); assert.fail('must reject'); }
 catch(e) { assert.ok(e instanceof HistoryReadError); return e; }
}
for(const phase of ['schema','query'] as const) test(`missing source is attributed in ${phase}, including warm cache`,async()=>{
 const e=await diagnose(new QuestDbRequestError('response',400,'table does not exist [table=old_data]'),phase);
 assert.equal(e.status,409);assert.equal(e.diagnostic.code,'HISTORY_TABLE_MISSING');assert.deepEqual(e.diagnostic.tables,['old_data']);assert.equal(e.diagnostic.scope,'source');assert.equal(e.diagnostic.phase,phase);
});
test('unrelated identifier never becomes a failing selected source',async()=>{
 const e=await diagnose(new QuestDbRequestError('response',400,'table does not exist [table=private_unrelated]'));
 assert.equal(e.diagnostic.scope,'request');assert.ok(!JSON.stringify(e.diagnostic).includes('private_unrelated'));
});
for(const [error,code] of [
 [new QuestDbRequestError('unavailable'),'HISTORY_DATABASE_UNAVAILABLE'],
 [new QuestDbRequestError('timeout'),'HISTORY_DATABASE_TIMEOUT'],
 [new QuestDbRequestError('response',401,'secret credentials'),'HISTORY_DATABASE_ACCESS_DENIED'],
 [new QuestDbRequestError('response',403,'secret credentials'),'HISTORY_DATABASE_ACCESS_DENIED'],
 [new QuestDbRequestError('response',503,'http://private-host'),'HISTORY_DATABASE_UNAVAILABLE'],
] as const) test(code+' stays database-wide and safe',async()=>{
 const e=await diagnose(error);assert.equal(e.status,503);assert.equal(e.diagnostic.code,code);assert.equal(e.diagnostic.scope,'database');assert.ok(!JSON.stringify(e.diagnostic).includes('secret'));assert.ok(!JSON.stringify(e.diagnostic).includes('http://'));
});
test('unknown query errors do not disclose upstream SQL/message',async()=>{
 const e=await diagnose(new QuestDbRequestError('response',400,'SELECT private_secret FROM credentials'));
 assert.equal(e.diagnostic.code,'HISTORY_READ_FAILED');assert.ok(!e.message.includes('SELECT'));assert.ok(!JSON.stringify(e.diagnostic).includes('private_secret'));
});
test('repair retries complete read; helper never returns partial data',async()=>{
 let fail=true;const read=()=>readHistory(['old_data','new_data'],'query',async()=>{if(fail)throw new QuestDbRequestError('response',400,'table does not exist [table=old_data]');return [10,20];});
 await assert.rejects(read,HistoryReadError);fail=false;assert.deepEqual(await read(),[10,20]);
});
test('unrelated validation retains its existing error contract',async()=>{
 const original=Error('invalid range');await assert.rejects(()=>readHistory(['old_data'],'query',async()=>{throw original;}),e=>e===original);
});
test('provenance is scoped to selected table, retains status and never exposes database URL',()=>{
 const entries=[{tableName:'old_data',historyId:'old-id',historyRevision:'3',retiredAt:'2026-10-06T08:00Z',processName:'old',questdbUrl:'http://secret'}, {tableName:'new_data',historyId:'new-id',retiredAt:null,processName:'new'}, {tableName:'legacy_data'}];
 const old=historySourceMetadata(['old_data'],entries);assert.equal(old.provenance.length,1);assert.equal(old.provenance[0]?.state,'retained');assert.equal(old.provenance[0]?.processName,'old');assert.ok(!JSON.stringify(old).includes('http://'));
 assert.equal(historySourceMetadata(['new_data'],entries).provenance[0]?.state,'active');assert.equal(historySourceMetadata(['legacy_data'],entries).provenance[0]?.state,'unknown');assert.match(QUESTDB_HISTORY_MAPPINGS_QUERY,/historyId historyRevision retiredAt/);
});

import {LatestLookupCoordinator} from '../src/latest-value-history.js';
test('latest coordinator retains safe structured failures through cooldown and recovery',async()=>{
 let now=0;const c=new LatestLookupCoordinator<number>({now:()=>now});
 const error=await diagnose(new QuestDbRequestError('response',400,'table does not exist [table=old_data]'));
 await assert.rejects(c.run('topic',async()=>{throw error;}),e=>e===error);
 await assert.rejects(c.run('topic',async()=>99),e=>e===error);
 now=5001;assert.equal(await c.run('topic',async()=>20),20);assert.equal(c.failureCount,0);
});
