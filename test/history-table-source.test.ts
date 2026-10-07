import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMappedHistory, QuestDbMappingCache } from '../src/questdb-mapping-cache.js';
import { validateHistoryMappings, combineHistorySchemas, historyTableRelation, HistorySourceError, HISTORY_SOURCE_COLUMN, assertHistoryTransform, historySourceMetadata } from '../src/history-table-source.js';
import { buildDataSql, buildEntityDataSql, buildSourceSql, parseUnsPath, resolveTemporalStrategy, type TableSchema } from '../src/catchall-helpers.js';
const topic = 'enterprise/site/area/line/motor/equipment/main/temperature';
const mappings = ['old_data','new_data'].map((tableName, i) => ({topicPrefix:topic, tableName, dataGroup:i ? 'new-group':'old-group', suffix:'data', questdbUrl:'http://questdb:9000', processName:'archiver', updatedAt:'2026-10-05T10:00:00Z'}));
const schema = (columns = ['topic','asset','objectType','objectId','attribute','numberValue','timestamp']): TableSchema => ({columns:new Set(columns), orderedColumns:columns, columnTypes:new Map(columns.map(column => [column, column==='timestamp'?'TIMESTAMP':column==='numberValue'?'DOUBLE':'STRING']))});

test('publisher replacement retains both tables independent of registration order/group/date', () => {
 for (const entries of [mappings,[...mappings].reverse()]) assert.deepEqual(validateHistoryMappings(selectMappedHistory(topic,entries)), ['new_data','old_data']);
 const history = historySourceMetadata(['new_data','old_data'], mappings);
 assert.equal(history.mode,'union'); assert.equal(history.provenance[0]?.dataGroup,'old-group');
 assert.ok(!JSON.stringify(history).includes('http://'));
});
test('specific path wins over wildcard, with path boundaries and safe table identifiers', () => {
 const entries=[{topicPrefix:'enterprise/#',tableName:'broad'},...mappings,{topicPrefix:topic+'-extra',tableName:'unrelated'},{topicPrefix:topic,tableName:'bad"; drop table x;'}];
 assert.deepEqual(validateHistoryMappings(selectMappedHistory(topic,entries)),['new_data','old_data']);
 assert.equal(selectMappedHistory(topic+'-other', entries)[0]?.tableName,'broad');
 assert.equal(selectMappedHistory('enterprise', [{topicPrefix:'enterprise/#',tableName:'root'}])[0]?.tableName,'root');
 assert.equal(selectMappedHistory(topic,[{topicPrefix:'enterprise/+/area/line/motor/equipment/+/temperature',tablePrefix:'metrics',suffix:'_data'}])[0]?.tableName,'metrics_data');
});
test('sibling fallback restricts depth, parent and attribute but retains all historical candidates', () => {
 assert.equal(selectMappedHistory(topic.replace('/main/','/new/'), mappings).length,2);
 assert.equal(selectMappedHistory(topic.replace('/motor/','/motor-other/'), mappings).length,0);
 assert.equal(selectMappedHistory(topic.replace('/temperature','/status'), mappings).length,0);
 assert.equal(selectMappedHistory(topic.replace('/main/','/extra/main/'), mappings).length,0);
});
test('multi-source cache keeps last valid snapshot during controller outage',async()=>{
 let now=0; const cache=new QuestDbMappingCache({now:()=>now});
 assert.equal((await cache.resolveHistory(topic,async()=>mappings)).length,2); now=60_000;
 assert.equal((await cache.resolveHistory(topic,async()=>{throw Error('offline');})).length,2);
});
test('packet shape/database ambiguity and excessive fanout fail rather than choose a table', () => {
 for(const field of ['suffix','questdbUrl'] as const) assert.throws(()=>validateHistoryMappings([mappings[0]!, {...mappings[1]!,[field]:'different'}]),HistorySourceError);
 assert.throws(()=>validateHistoryMappings(Array.from({length:9},(_,i)=>({...mappings[0]!,tableName:'data_'+i}))),/more than 8/);
 assert.deepEqual(validateHistoryMappings([mappings[0]!,mappings[0]!]),['old_data']);
});
test('aligned schema union adds provenance without changing single-table columns',()=>{
 const first=schema(); const reverse=schema([...first.orderedColumns].reverse());
 const union=combineHistorySchemas(['old_data','new_data'],[first,reverse]);
 assert.equal(union.schema.orderedColumns.at(-1),HISTORY_SOURCE_COLUMN);
 const sql=historyTableRelation(union.source);assert.match(sql,/UNION ALL/);assert.match(sql,/'old_data' AS "__historySourceTable"/);
 assert.equal(sql.split('SELECT "topic", "asset"').length,3);
 const single=combineHistorySchemas(['old_data'],[first]);assert.equal(single.schema,first); assert.equal(historyTableRelation(single.source),'"old_data"');
});
test('schema mismatches, reserved names and unsafe identifiers fail explicitly',()=>{
 const changed=schema();changed.columnTypes.set('numberValue','STRING');
 assert.throws(()=>combineHistorySchemas(['a','b'],[schema(),changed]),/incompatible/);
 assert.throws(()=>combineHistorySchemas(['a','b'],[schema(),schema(['topic','timestamp'])]),/incompatible/);
 assert.throws(()=>combineHistorySchemas(['a','b'],[schema(['topic',HISTORY_SOURCE_COLUMN]),schema(['topic',HISTORY_SOURCE_COLUMN])]),/reserved/);
 assert.throws(()=>historyTableRelation({tables:['a";DROP'],columns:['topic']}),HistorySourceError);
});
test('raw combined SQL filters/orders/limits globally and dedupes only within a physical source',()=>{
 const union=combineHistorySchemas(['old_data','new_data'],[schema(),schema()]);
 const temporal=resolveTemporalStrategy(union.schema,'timestamp');
 const sql=buildDataSql(union.source,parseUnsPath(topic),{from:'2026-10-05T10:00:00Z',to:'2026-10-05T11:00:00Z'},15,true,union.schema,temporal);
 assert.equal(sql.match(/LIMIT/g)?.length,1);assert.match(sql,/LIMIT 15/);assert.match(sql,/UNION ALL/);
 assert.match(sql,/"attribute" = 'temperature'/);assert.match(sql,/"timestamp" >= '2026-10-05/);
 assert.match(sql,/PARTITION BY [^\n]*"__historySourceTable"/);
});
test('sampled source and entity SQL use the same union with stable identity constraints',()=>{
 const union=combineHistorySchemas(['old_data','new_data'],[schema(['topic','asset','objectType','objectId','attribute','numberValue','timestamp','stableEntityId','identityResolution']),schema(['topic','asset','objectType','objectId','attribute','numberValue','timestamp','stableEntityId','identityResolution'])]);
 const temporal=resolveTemporalStrategy(union.schema,'timestamp');
 const sampled=buildSourceSql(union.source,parseUnsPath(topic),{},false,union.schema,temporal,['numberValue']);assert.match(sampled,/UNION ALL/);
 const entity=buildEntityDataSql(union.source,'11111111-1111-4111-8111-111111111111',parseUnsPath(topic),{},10,true,union.schema,temporal);
 assert.match(entity,/UNION ALL/);assert.match(entity,/"identityResolution" = 'resolved'/);assert.match(entity,/"stableEntityId" IS NULL/);assert.match(entity,/"__historySourceTable"/);
});
test('counter delta refuses unproven cross-publisher continuity; explicit source retains delta',()=>{
 assert.throws(()=>assertHistoryTransform({tables:['old','new'],columns:[]},'delta'),/continuity/);
 assert.doesNotThrow(()=>assertHistoryTransform('old','delta'));
});
