import test from "node:test";
import assert from "node:assert/strict";
import {buildPathPredicates, buildWhere, parseUnsPath, resolveTemporalStrategy, type TableSchema} from "../src/catchall-helpers.js";
import {selectArchivedLatest, buildLatestHistorySql} from "../src/latest-value-history.js";
import {HistorySourceError} from "../src/history-table-source.js";

const names = ["timestamp", "topic", "attribute", "fullTopic", "valueType", "value", "numberValue", "stringValue", "uom"];
const schema: TableSchema = {columns:new Set(names), orderedColumns:names,
  columnTypes:new Map(names.map(n=>[n,n==='timestamp'?'TIMESTAMP':n==='value'||n==='numberValue'?'DOUBLE':'STRING']))};
const temporal=resolveTemporalStrategy(schema,'auto');
const path='plant/area/line/signal';

test('complete path scopes history and latest without assuming an asset hierarchy',()=>{
  const where=buildWhere(parseUnsPath(path),{from:'2026-11-02T00:00:00Z',to:'2026-11-03T00:00:00Z',toExclusive:true},temporal,schema);
  assert.match(where,/"fullTopic" = 'plant\/area\/line\/signal'/);
  assert.match(where,/"fullTopic" IS NULL AND/);
  assert.match(where,/\) AND "timestamp" >=/);
  assert.match(where,/"timestamp" < '2026-11-03/);
  assert.match(buildLatestHistorySql('signals_data',path,schema,temporal),/"fullTopic" = 'plant\/area\/line\/signal'/);
});

test('structured and topic-only schemas preserve their previous predicates and escape literals',()=>{
  assert.deepEqual(buildPathPredicates(parseUnsPath('plant/asset/equipment/main/state'),new Set(['topic','asset','objectType','objectId','attribute'])),[
    '"topic" = \'plant\'','"asset" = \'asset\'','"objectType" = \'equipment\'','"objectId" = \'main\'','"attribute" = \'state\'']);
  assert.deepEqual(buildPathPredicates(parseUnsPath('single'),new Set(['topic'])),['"topic" = \'single\'']);
  assert.deepEqual(buildPathPredicates(parseUnsPath("plant/a'b"),new Set(['fullTopic'])),['"fullTopic" = \'plant/a\'\'b\'']);
});

for(const kind of ['string','number']) test(`archived typed ${kind} clear remains the latest observation`,()=>{
  const clear=['2026-11-02T12:01:00Z','plant/area/line','signal',path,kind,null,null,null,''];
  const old=['2026-11-02T12:00:00Z','plant/area/line','signal',path,kind,kind==='number'?42:null,kind==='number'?42:null,kind==='string'?'OLD':null,''];
  const value=selectArchivedLatest(names,[old,clear],temporal);
  assert.deepEqual(value?.values,{value:null});
  assert.equal(value?.packetShape,'data');
  assert.equal(value?.timestamp,clear[0]);
  assert.equal(value?.uom,'');
});

test('missing untyped values do not turn path metadata into table data',()=>{
  assert.equal(selectArchivedLatest(names,[['2026-11-02T12:01:00Z','plant/area/line','signal',path,null,null,null,null,'']],temporal),null);
});

test('a clear conflicts with a different value at the same time and a real string is retained',()=>{
  const clear=['2026-11-02T12:01:00Z','plant/area/line','signal',path,'string',null,null,null,''];
  const value=[...clear];value[7]='NEW';
  assert.deepEqual(selectArchivedLatest(names,[value],temporal)?.values,{value:'NEW'});
  assert.throws(()=>selectArchivedLatest(names,[clear,value],temporal),HistorySourceError);
});
