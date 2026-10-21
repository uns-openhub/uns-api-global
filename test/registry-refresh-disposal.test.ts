import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TriggerRegistry} from '../src/triggers/registry.js';
import {CaptureRegistry} from '../src/captures/registry.js';

for(const [name,Registry,key] of [['triggers',TriggerRegistry,'triggers'],['captures',CaptureRegistry,'captures']] as const){
 for(const status of [401,403,503])test(`${name}: status ${status} cancels unread body and settles request cancellation`,async()=>{
  let signal:AbortSignal|undefined,cancels=0;
  const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('{"error":"synthetic"}'));},cancel(){cancels++;}});
  const registry=new Registry({controllerRestUrl:'http://local.invalid/api',getAccessToken:async()=> 'synthetic-local',refreshIntervalMs:1000,
   fetchImpl:async(_url,init)=>{signal=init?.signal??undefined;return new Response(body,{status});}});
  await registry.refresh();assert.equal(signal?.aborted,true);assert.equal(cancels,1);assert.equal(registry.size(),0);registry.stop();
 });
 test(`${name}: successful body stays usable and cancellation graph is released`,async()=>{
  const signals:AbortSignal[]=[];
  const registry=new Registry({controllerRestUrl:'http://local.invalid/api',getAccessToken:async()=> 'synthetic-local',refreshIntervalMs:1000,
   fetchImpl:async(_url,init)=>{signals.push(init!.signal!);return new Response(JSON.stringify({[key]:[]}),{headers:{'content-type':'application/json'}});}});
  for(let i=0;i<100;i++)await registry.refresh();assert.equal(signals.length,100);assert.ok(signals.every(s=>s.aborted));assert.equal(registry.getHealth().healthy,true);registry.stop();
 });
 test(`${name}: synchronous credential failure has no unhandled abort rejection`,async()=>{
  const registry=new Registry({controllerRestUrl:'http://local.invalid/api',getAccessToken:()=>{throw Error('synthetic credential failure');},refreshIntervalMs:1000});
  await registry.refresh();await new Promise(r=>setImmediate(r));assert.equal(registry.getHealth().healthy,false);registry.stop();
 });
}
