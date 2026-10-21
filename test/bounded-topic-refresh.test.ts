import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { request } from 'graphql-request';
import { BoundedTopicRefresh, topicSubscriptionDelta } from '../src/bounded-topic-refresh.js';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));

test('many ticks share one pending load and release the gate after completion',async()=>{
 let finish!:(v:string[])=>void,calls=0;
 const r=new BoundedTopicRefresh(()=>{calls++;return new Promise<string[]>(resolve=>{finish=resolve;});},1000);
 const first=r.refresh(); for(let i=0;i<1000;i++)assert.equal(r.refresh(),first);
 await delay(0);assert.equal(calls,1);finish(['one']);assert.deepEqual(await first,['one']);
 const second=r.refresh();await delay(0);assert.equal(calls,2);finish(['two']);assert.deepEqual(await second,['two']);
});

test('deadline bounds return, aborts transport, ignores late success, and holds a hung credential gate',async()=>{
 let finish!:(v:string[])=>void,calls=0,signal!:AbortSignal;const states:boolean[]=[];
 const r=new BoundedTopicRefresh(s=>{signal=s;calls++;return new Promise<string[]>(resolve=>{finish=resolve;});},20,s=>states.push(s));
 const first=r.refresh();assert.equal(await first,null);assert.equal(signal.aborted,true);
 for(let i=0;i<1000;i++)assert.equal(r.refresh(),first);
 assert.equal(calls,1);finish(['stale']);await delay(0);assert.deepEqual(states,[false]);
 const second=r.refresh();await delay(0);assert.equal(calls,2);finish(['fresh']);assert.deepEqual(await second,['fresh']);assert.deepEqual(states,[false,true]);
});

test('failure does not expose errors, retries recover and unchanged states stay quiet',async()=>{
 let fail=true;const states:boolean[]=[];
 const r=new BoundedTopicRefresh(async()=>{if(fail)throw Error('sensitive server response');return ['topic'];},100,s=>states.push(s));
 assert.equal(await r.refresh(),null);assert.equal(await r.refresh(),null);fail=false;
 assert.deepEqual(await r.refresh(),['topic']);assert.deepEqual(await r.refresh(),['topic']);assert.deepEqual(states,[false,true]);
});

test('actual graphql HTTP stall aborts with one concurrent request, then normal discovery recovers',async()=>{
 let stall=true,active=0,peak=0,requests=0;const sockets=new Set<import('node:net').Socket>();
 const server=http.createServer((req,res)=>{requests++;active++;peak=Math.max(peak,active);res.once('close',()=>active--);
  if(!stall){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{GetUnsNodes:[{id:1,type:'Attribute',fullTopic:'canary/a'}]}}));}});
 server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const url='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
  const r=new BoundedTopicRefresh(signal=>request({url,document:'query { GetUnsNodes { id type fullTopic } }',signal}),1000);
  const pending=r.refresh();for(let i=0;i<20;i++)assert.equal(r.refresh(),pending);
  assert.equal(await pending,null);for(let i=0;i<100&&active>0;i++)await delay(10);assert.equal(requests,1);assert.equal(peak,1);assert.equal(active,0);
  stall=false;const result:any=await r.refresh();assert.equal(result.GetUnsNodes[0].fullTopic,'canary/a');assert.equal(peak,1);
 }finally{for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));}
});

test('reordered or duplicate discovery rows do not resubscribe the same MQTT topics',()=>{
 assert.deepEqual(topicSubscriptionDelta(['b','a'],['a','b','a']),{topics:['a','b'],added:[],removed:[]});
 assert.deepEqual(topicSubscriptionDelta(['a','b','kept'],['kept','c','a']),{topics:['a','c','kept'],added:['c'],removed:['b']});
 assert.deepEqual(topicSubscriptionDelta(['UPPER','upper'],['upper']),{topics:['upper'],added:[],removed:['UPPER']});
});
