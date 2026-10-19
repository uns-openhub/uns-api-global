import test from 'node:test';
import assert from 'node:assert/strict';
import { rawExportRange, completeRawExportPage } from '../src/raw-export-window.js';
import { buildDataSql, resolveTemporalStrategy, parseUnsPath } from '../src/catchall-helpers.js';
const options={summary:false,sampled:false,transform:'raw',dedupe:false};
const query={exportWindow:'half-open',from:'2026-10-16T00:00:00.000001Z',to:'2026-10-16T01:00:00.000002Z'};
test('opt-in preserves precise half-open bounds without changing normal requests',()=>{
 assert.equal(rawExportRange({}, {}, options),null);
 const range=rawExportRange(query,{},options)!;
 assert.equal(range.from,query.from);assert.equal(range.to,query.to);assert.equal(range.toExclusive,true);
 const columns=['topic','asset','objectType','objectId','attribute','timestamp','numberValue','uom'];
 const schema={columns:new Set(columns),orderedColumns:columns,columnTypes:new Map(columns.map(c=>[c,c==='timestamp'?'TIMESTAMP':'STRING']))};
 const sql=buildDataSql('raw_export_data',parseUnsPath('canary/raw-export/asset/equipment/main/value'),range,2001,false,schema,resolveTemporalStrategy(schema,'timestamp'));
 assert.ok(sql.includes('>= \'2026-10-16T00:00:00.000001Z\''));assert.ok(sql.includes('< \'2026-10-16T01:00:00.000002Z\''));
 assert.ok(sql.includes('LIMIT 2001'));assert.ok(!sql.includes('LATEST ON'));
});
test('requires explicit precision-preserving bounds and raw no-dedupe mode',()=>{
 for(const patch of [{exportWindow:'other'},{from:''},{from:'2026-10-16'},{to:query.from},{to:'2026-10-15T00:00:00Z'},{from:'2026-10-16T00:00:00+02:00'}]) assert.throws(()=>rawExportRange({...query,...patch},{},options));
 for(const patch of [{summary:true},{sampled:true},{transform:'delta'},{dedupe:true}]) assert.throws(()=>rawExportRange(query,{},{...options,...patch}));
});
test('exactly maxLimit concurrent readings are complete, lookahead never leaks extra row',()=>{
 for(const size of [0,1999,2000,2001]){
 const result=completeRawExportPage({data:Array.from({length:size},(_,i)=>[i]),raw:{columns:[]}},2000);
 assert.equal(result.data.length,Math.min(size,2000));assert.equal(result.truncated,size>2000);
 }
});

test('response disconnect cancels in-flight read and removes listener after completion',async()=>{
 const {EventEmitter}=await import('node:events');const {cancelRawExportOnDisconnect}=await import('../src/raw-export-window.js');
 const res=Object.assign(new EventEmitter(),{writableEnded:false});const cancellation=cancelRawExportOnDisconnect(res);
 assert.equal(res.listenerCount('close'),1);res.emit('close');assert.equal(cancellation.signal.aborted,true);cancellation.dispose();assert.equal(res.listenerCount('close'),0);
 const finished=Object.assign(new EventEmitter(),{writableEnded:true});const done=cancelRawExportOnDisconnect(finished);finished.emit('close');assert.equal(done.signal.aborted,false);done.dispose();
});

test('upstream response row cap cannot masquerade as a complete SQL result',()=>{
 assert.equal(completeRawExportPage({data:Array(1000).fill([]),raw:{count:2001}},2000).truncated,true);
});

test('fractional precision cannot bypass the configured time-window guard',()=>{
 assert.throws(()=>rawExportRange({...query,from:'2026-10-16T00:00:00.000000Z',to:'2026-10-16T01:00:00.000001Z'},{},{...options,maxLookbackHours:1}),/maxLookbackHours/);
 assert.throws(()=>rawExportRange({...query,from:'2026-02-31T00:00:00Z'},{},options),/calendar/);
});
