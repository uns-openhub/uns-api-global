import test from 'node:test';
import assert from 'node:assert/strict';
import {combineHistorySchemas, assertHistoryTransform, HistorySourceError} from '../src/history-table-source.js';
import {buildDataSql, buildSourceSql, buildEntityDataSql, buildBucketSql, parseUnsPath, resolveTemporalStrategy, type TableSchema} from '../src/catchall-helpers.js';

// Opt-in, synthetic and loopback only. Never run against a production database.
const base=process.env['HISTORY_TEST_QUESTDB'];
test('real QuestDB legacy/enriched union: values, source, sampling and identity restrictions', {skip:!base}, async()=>{
 const url=new URL(base!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
 const names=['history_acceptance_legacy','history_acceptance_current'];
 async function query(sql:string){const u=new URL('/exec',url);u.searchParams.set('query',sql);const r=await fetch(u,{signal:AbortSignal.timeout(5000)});const b=await r.json() as any;assert.equal(r.status,200,JSON.stringify(b));return b;}
 try {
  for(const t of names)await query(`DROP TABLE IF EXISTS "${t}"`);
  const common='topic SYMBOL, asset SYMBOL, objectType SYMBOL, objectId SYMBOL, attribute SYMBOL, valueType SYMBOL, deleted BOOLEAN, lastSeen TIMESTAMP, value DOUBLE, numberValue DOUBLE, uom VARCHAR, timestamp TIMESTAMP, interval LONG';
  await query(`CREATE TABLE "${names[0]}" (${common}) TIMESTAMP(timestamp) PARTITION BY DAY BYPASS WAL`);
  await query(`CREATE TABLE "${names[1]}" (${common}, fullTopic VARCHAR, stableEntityId SYMBOL, entityTypeKey SYMBOL, identityResolution SYMBOL, identityTimeBasis SYMBOL, identityBindingRevision SYMBOL, identityBindingDigest VARCHAR) TIMESTAMP(timestamp) PARTITION BY DAY BYPASS WAL`);
  const topic='enterprise/site/area/line/motor/equipment/main/temperature';const id='11111111-1111-4111-8111-111111111111';
  for(const [i,t] of names.entries())await query(`INSERT INTO "${t}" (topic,asset,objectType,objectId,attribute,value,numberValue,uom,timestamp${i?',stableEntityId,identityResolution,identityTimeBasis,identityBindingRevision':''}) VALUES ('enterprise/site/area/line','motor','equipment','main','temperature',${i?20:10},${i?20:10},'C','2026-10-13T10:00:00.000000Z'${i?`, '${id}','resolved','event-time','1'`:''})`);
  // A different bound entity at the same authorized path must not leak into the entity result.
  await query(`INSERT INTO "${names[1]}" (topic,asset,objectType,objectId,attribute,value,numberValue,timestamp,stableEntityId,identityResolution) VALUES ('enterprise/site/area/line','motor','equipment','main','temperature',999,999,'2026-10-13T10:02:00.000000Z','22222222-2222-4222-8222-222222222222','resolved')`);
  const schemas:TableSchema[]=await Promise.all(names.map(async t=>{const b=await query(`SHOW COLUMNS FROM "${t}"`);const pairs=b.dataset.map((r:any)=>[r[0],r[1]]);return {columns:new Set<string>(pairs.map((r:any)=>r[0])),orderedColumns:pairs.map((r:any)=>r[0]),columnTypes:new Map(pairs)};}));
  const {source,schema}=combineHistorySchemas(names,schemas);const temporal=resolveTemporalStrategy(schema,'timestamp');const path=parseUnsPath(topic),range={from:'2026-10-13T09:59:00Z',to:'2026-10-13T10:01:00Z'};
  const raw=await query(buildDataSql(source,path,range,20,true,schema,temporal));
  const col=(n:string)=>raw.columns.findIndex((c:any)=>c.name===n);
  assert.equal(raw.dataset.length,2);assert.deepEqual(raw.dataset.map((r:any)=>r[col('numberValue')]).sort((a:number,b:number)=>a-b),[10,20]);assert.deepEqual(raw.dataset.map((r:any)=>r[col('__historySourceTable')]).sort(),[...names].sort());assert.equal(raw.dataset.find((r:any)=>r[col('__historySourceTable')]===names[0])[col('stableEntityId')],null);
  const sampled=await query(buildBucketSql(buildSourceSql(source,path,range,false,schema,temporal,['numberValue','uom']),temporal,'numberValue','uom','sum',60_000));assert.equal(sampled.dataset[0][1],30);
  const entity=await query(buildEntityDataSql(source,id,path,{from:range.from,to:'2026-10-13T10:03:00Z'},20,false,schema,temporal));assert.equal(entity.dataset.length,2);assert.ok(!entity.dataset.some((r:any)=>r[entity.columns.findIndex((c:any)=>c.name==='numberValue')]===999));
  assert.throws(()=>assertHistoryTransform(source,'delta'),HistorySourceError);
  const changed={...schemas[1]!,columnTypes:new Map(schemas[1]!.columnTypes)};changed.columnTypes.set('numberValue','STRING');assert.throws(()=>combineHistorySchemas(names,[schemas[0]!,changed]),HistorySourceError);
 } finally {for(const t of names)await query(`DROP TABLE IF EXISTS "${t}"`);}
});
