import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthorizationStatus } from '../src/authorization-status.js';
import { projectExtrasSchema } from '../src/config/project.config.extension.js';
const active = () => Response.json({ active: true, protocolVersion: 1 });
function fixture(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async () => active()) {
 let now=10000, calls=0;
 const status=new AuthorizationStatus({controllerRest:'http://localhost:3200/api/',now:()=>now,fetch:async (...args)=>{calls++;return handler(...args);}});
 return {status,calls:()=>calls,advance:(ms:number)=>{now+=ms;}};
}
test('coalesces a burst, caches for five seconds, and refreshes at expiry',async()=>{
 let release!:()=>void; const gate=new Promise<void>(r=>{release=r;});
 const f=fixture(async()=>{await gate;return active();});
 const burst=Array.from({length:20},()=>f.status.check('secret-token'));assert.equal(f.calls(),1);release();await Promise.all(burst);
 f.advance(4999);await f.status.check('secret-token');assert.equal(f.calls(),1);
 f.advance(1);await f.status.check('secret-token');assert.equal(f.calls(),2);
 assert.equal(f.status.snapshot().coalesced,19);assert.doesNotMatch(JSON.stringify(f.status.snapshot()),/secret-token|[a-f0-9]{64}/);
});
for(const code of [401,403]) test(`caches ${code} denial without returning a stale positive`,async()=>{
 let revoked=false;const f=fixture(async()=>revoked?new Response('',{status:code}):active());
 await f.status.check('one');revoked=true;f.advance(5000);
 await assert.rejects(f.status.check('one'),{status:code});await assert.rejects(f.status.check('one'),{status:code});assert.equal(f.calls(),2);
});
test('fails closed after TTL, bounds retries, and recovers without implicit offline mode',async()=>{
 let failed=false;const f=fixture(async()=>failed?new Response('',{status:503}):active());
 await f.status.check('one');failed=true;f.advance(4999);await f.status.check('one');assert.equal(f.calls(),1);
 f.advance(1);await assert.rejects(f.status.check('one'),{status:503});await assert.rejects(f.status.check('two'),{status:503});assert.equal(f.calls(),2);
 failed=false;f.advance(1000);await f.status.check('one');assert.equal(f.calls(),3);
});
test('limits concurrent authorities to four with no waiting queue',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const f=fixture(async()=>{await gate;return active();});
 const pending=Array.from({length:4},(_,i)=>f.status.check(String(i)));
 await assert.rejects(f.status.check('fifth'),{status:503});assert.equal(f.status.snapshot().activeChecks,4);assert.equal(f.calls(),4);
 release();await Promise.all(pending);assert.equal(f.status.snapshot().activeChecks,0);
});
test('bounds token-digest storage to 1024 entries',async()=>{
 const f=fixture();for(let i=0;i<1030;i++)await f.status.check(String(i));assert.equal(f.status.snapshot().cacheEntries,1024);
 await f.status.check('0');assert.equal(f.calls(),1031);
});
for(const [label,response] of [
 ['missing contract',()=>new Response('',{status:404})],['HTML',()=>new Response('private HTML')],
 ['inactive 200',()=>Response.json({active:false,protocolVersion:1})],['wrong protocol',()=>Response.json({active:true,protocolVersion:2})],
 ['bad JSON',()=>new Response('{',{headers:{'content-type':'application/json'}})],['oversized JSON',()=>Response.json({active:true,protocolVersion:1,extra:'x'.repeat(5000)})],
] as const)test(`rejects ${label} without auth fallback`,async()=>{const f=fixture(async()=>response());await assert.rejects(f.status.check('one'),{status:503});});
test('fails closed without configured authority; offline mode must be explicit',async()=>{
 await assert.rejects(new AuthorizationStatus({}).check('one'),{status:503});
 let calls=0;await new AuthorizationStatus({mode:'offline',fetch:async()=>{calls++;return active();}}).check('one');assert.equal(calls,0);
});
test('uses only self bearer, POST and redirect rejection',async()=>{
 const f=fixture(async(url,options)=>{assert.equal(url,'http://localhost:3200/api/auth/token-status');assert.equal(options?.method,'POST');assert.equal(options?.redirect,'error');assert.deepEqual(options?.headers,{authorization:'Bearer private',accept:'application/json'});return active();});await f.status.check('private');
});
test('rejects a result older than its status lifetime',async()=>{
 const f=fixture(async()=>{f.advance(5000);return active();});await assert.rejects(f.status.check('one'),{status:503});
});
test('aborts a slow authority within the request deadline',async()=>{
 const keepAlive=setInterval(()=>{},100);try{
 const f=fixture(async(_url,options)=>new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(Error('private timeout')))));
 const start=Date.now();await assert.rejects(f.status.check('one'),{status:503});assert.ok(Date.now()-start<2500);assert.equal(f.status.snapshot().activeChecks,0);
 }finally{clearInterval(keepAlive);}
});
test('schema defaults and rejects invalid cache bounds or unknown modes',()=>{
 const schema=projectExtrasSchema.shape.authorization;assert.deepEqual(schema.parse(undefined),{mode:'controller',statusCacheMs:5000});
 for(const statusCacheMs of [0,249,30001,500.5])assert.equal(schema.safeParse({statusCacheMs}).success,false);
 assert.equal(schema.safeParse({mode:'automatic'}).success,false);
});
