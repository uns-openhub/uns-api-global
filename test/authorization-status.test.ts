import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthorizationStatus } from '../src/authorization-status.js';
import { projectExtrasSchema } from '../src/config/project.config.extension.js';

const user={claims:{sub:'verified-user'},standaloneHmac:false};
const standaloneUser={...user,standaloneHmac:true};
const machine={claims:{sub:'machine',machineIdentityId:'machine',serviceToken:true},standaloneHmac:false};
const legacyService={claims:{sub:'user',serviceToken:true},standaloneHmac:false};
const broker={claims:{sub:'machine',machineIdentityId:'machine',serviceToken:true,catalogPublication:{operation:'summary'}},standaloneHmac:false};
const active = (principalType:unknown='user') => Response.json({active:true,protocolVersion:1,principalType,configuredAccessAuthority:2});
function fixture(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async () => active()) {
  let now=10000,calls=0;
  const status=new AuthorizationStatus({controllerRest:'http://localhost:3200/api/',now:()=>now,fetch:async (...args)=>{calls++;return handler(...args);}});
  return {status,calls:()=>calls,advance:(ms:number)=>{now+=ms;}};
}

test('caches and coalesces only an explicitly confirmed ordinary user',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let block=false;
  const f=fixture(async()=>{if(block)await gate;return active();});
  await f.status.check('user-token',user);
  f.advance(4999);await f.status.check('user-token',user);assert.equal(f.calls(),1);
  f.advance(1);block=true;
  const burst=Array.from({length:20},()=>f.status.check('user-token',user));assert.equal(f.calls(),2);
  release();await Promise.all(burst);
  assert.equal(f.status.snapshot().coalesced,19);
  assert.doesNotMatch(JSON.stringify(f.status.snapshot()),/user-token|[a-f0-9]{64}/);
});
test('coalesces the first burst of 32 requests only after a positive user classification',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const f=fixture(async()=>{await gate;return active('user');});
  const burst=Array.from({length:32},()=>f.status.check('first-user',user));
  assert.equal(f.calls(),1);release();await Promise.all(burst);
  assert.equal(f.calls(),1);assert.equal(f.status.snapshot().coalesced,31);
});
for(const principal of ['machine','unknown'] as const)
  test(`a first ${principal} result cannot authorize concurrent followers`,async()=>{
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let count=0;
    const f=fixture(async()=>{count++;if(count===1){await gate;return active(principal);}
      return new Response(null,{status:403});});
    // No machine hints: classification has to come from the Controller.
    const burst=Array.from({length:32},()=>f.status.check('first-token',user));
    assert.equal(f.calls(),1);release();const results=await Promise.allSettled(burst);
    assert.equal(results[0]?.status,'fulfilled');
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    for(const result of results.slice(1)) {
      assert.equal(result.status,'rejected');
      if(result.status==='rejected')assert.ok([403,503].includes(result.reason.status));
    }
    assert.ok(f.calls()>1);assert.equal(f.status.snapshot().cacheEntries,0);
  });
for(const [name,caller] of [['machine',machine],['legacy service',legacyService],['catalog broker',broker]] as const)
  test(`${name} always has live status even if the Controller says user`,async()=>{
    let allowed=true;const f=fixture(async()=>allowed?active():new Response(null,{status:403}));
    await f.status.check('token',caller);allowed=false;
    await assert.rejects(f.status.check('token',caller),{status:403});assert.equal(f.calls(),2);
  });
test('unknown principals with configured authority are checked every time',async()=>{
  const f=fixture(async()=>Response.json({active:true,protocolVersion:1,configuredAccessAuthority:2}));
  await f.status.check('user',user);await f.status.check('user',user);assert.equal(f.calls(),2);
  assert.equal(f.status.snapshot().cacheEntries,0);
});
for(const [name,caller] of [['machine',machine],['legacy service',legacyService],['catalog broker',broker]] as const)
  test(`an older Controller without configured authority cannot approve ${name}`,async()=>{
    // Even a Controller returning principalType user cannot override a service hint.
    for(const principalType of ['user','machine',undefined]) {
      const f=fixture(async()=>Response.json({active:true,protocolVersion:1,principalType}));
      await assert.rejects(f.status.check('token',caller),{status:503});
      assert.equal(f.status.snapshot().cacheEntries,0);
    }
  });
for(const marker of [null,0,1,3,'2',true,{},[]])
  test(`configured authority requires numeric version 2, rejecting ${JSON.stringify(marker)}`,async()=>{
    const f=fixture(async()=>Response.json({active:true,protocolVersion:1,principalType:'machine',configuredAccessAuthority:marker}));
    await assert.rejects(f.status.check('machine',machine),{status:503});
  });
test('preserves confirmed user status without the configured authority capability',async()=>{
  const f=fixture(async()=>Response.json({active:true,protocolVersion:1,principalType:'user'}));
  await f.status.check('user',user);await f.status.check('user',user);assert.equal(f.calls(),1);
});
test('an old ambiguous response cannot authorize an unclassified bearer',async()=>{
  const f=fixture(async()=>Response.json({active:true,protocolVersion:1}));
  await assert.rejects(f.status.check('unknown',user),{status:503});
  assert.equal(f.status.snapshot().cacheEntries,0);
});
test('unrecognized principalType never enables positive caching',async()=>{
  const f=fixture(async()=>active('future-principal'));
  await f.status.check('user',user);await f.status.check('user',user);assert.equal(f.calls(),2);
});
test('does not coalesce concurrent machine requests or reuse status across revocation',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let call=0;
  const f=fixture(async()=>{call++;if(call===1){await gate;return active('machine');}return new Response(null,{status:403});});
  const first=f.status.check('same-machine',machine);
  await assert.rejects(f.status.check('same-machine',machine),{status:403});
  release();await first;assert.equal(f.calls(),2);
});
test('a formerly cached user whose classification changes cannot coalesce a machine result',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let call=0;
  const f=fixture(async()=>{call++;if(call===1)return active('user');if(call===2){await gate;return active('machine');}return new Response(null,{status:403});});
  await f.status.check('same',user);f.advance(5000);
  const first=f.status.check('same',user),second=f.status.check('same',user);
  release();await first;await assert.rejects(second,{status:403});assert.equal(f.calls(),3);
});
test('a coalesced user cannot accept a status response that has already gone stale',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let call=0;
  const f=fixture(async()=>{call++;if(call===1)return active();await gate;f.advance(5000);return active();});
  await f.status.check('same',user);f.advance(5000);
  const first=f.status.check('same',user),second=f.status.check('same',user);
  release();
  const results=await Promise.allSettled([first,second]);
  assert.equal(results[0]?.status,'rejected');assert.equal(results[1]?.status,'rejected');assert.equal(f.calls(),2);
});
for(const code of [401,403])test(`preserves Controller ${code} denial without caching it`,async()=>{
  let revoked=false;const f=fixture(async()=>revoked?new Response(null,{status:code}):active());
  await f.status.check('one',user);revoked=true;f.advance(5000);
  await assert.rejects(f.status.check('one',user),{status:code});await assert.rejects(f.status.check('one',user),{status:code});assert.equal(f.calls(),3);
});
test('does not reuse an expired user status during an outage',async()=>{
  let failed=false;const f=fixture(async()=>failed?new Response(null,{status:503}):active());
  await f.status.check('one',user);failed=true;f.advance(4999);await f.status.check('one',user);assert.equal(f.calls(),1);
  f.advance(1);await assert.rejects(f.status.check('one',user),{status:503});await assert.rejects(f.status.check('two',user),{status:503});assert.equal(f.calls(),2);
  failed=false;f.advance(1000);await f.status.check('one',user);assert.equal(f.calls(),3);
});
test('limits concurrent checks with no waiting queue',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const f=fixture(async()=>{await gate;return active('machine');});
  const pending=Array.from({length:16},(_,i)=>f.status.check(String(i),machine));
  await assert.rejects(f.status.check('seventeenth',machine),{status:503});assert.equal(f.status.snapshot().activeChecks,16);
  release();await Promise.all(pending);assert.equal(f.status.snapshot().activeChecks,0);
});
test('bounds confirmed-user cache entries to 1024 without caching service results',async()=>{
  const f=fixture();for(let i=0;i<1030;i++)await f.status.check(String(i),user);
  assert.equal(f.status.snapshot().cacheEntries,1024);await f.status.check('0',user);assert.equal(f.calls(),1031);
});
for(const [label,response] of [
  ['missing endpoint',()=>new Response(null,{status:404})],['HTML',()=>new Response('private HTML')],
  ['inactive 200',()=>Response.json({active:false,protocolVersion:1})],['wrong protocol',()=>Response.json({active:true,protocolVersion:2})],
  ['bad JSON',()=>new Response('{',{headers:{'content-type':'application/json'}})],['oversized JSON',()=>Response.json({active:true,protocolVersion:1,extra:'x'.repeat(5000)})],
] as const)test(`rejects ${label} without fallback`,async()=>{
  const f=fixture(async()=>response());await assert.rejects(f.status.check('one',machine),{status:503});
});
test('standalone offline HMAC preserves user behavior but never bypasses machine or JWKS tokens',async()=>{
  await assert.rejects(new AuthorizationStatus({}).check('one',machine),{status:503});
  let calls=0;const status=new AuthorizationStatus({mode:'offline',fetch:async()=>{calls++;return active();}});
  await status.check('standalone-user',standaloneUser);assert.equal(calls,0);
  await assert.rejects(status.check('machine',{...machine,standaloneHmac:true}),{status:503});
  await assert.rejects(status.check('jwks-user',user),{status:503});
});
test('any verified machine or broker hint requires status even in standalone offline mode',async()=>{
  const status=new AuthorizationStatus({mode:'offline'});
  for(const claims of [{serviceToken:false},{machineIdentityId:'x'},{identityType:'machine'},{tokenVersion:1},
    {workloadIdentityType:'MICROSERVICE'},{catalogPublication:{}},{catalogLaunch:{}},{configuredServiceLaunch:{}}])
    await assert.rejects(status.check('token',{claims,standaloneHmac:true}),{status:503});
});
test('sends only the self bearer with POST and rejects redirects',async()=>{
  const f=fixture(async(url,options)=>{assert.equal(url,'http://localhost:3200/api/auth/token-status');assert.equal(options?.method,'POST');assert.equal(options?.redirect,'error');
    assert.deepEqual(options?.headers,{authorization:'Bearer private',accept:'application/json'});return active('machine');});
  await f.status.check('private',machine);
});
test('rejects credential-bearing or malformed status URLs without exposing them',()=>{
  for(const controllerRest of ['http://user:secret@localhost/api','http://localhost/api?token=secret','file:///secret','not a url with secret']) {
    try {new AuthorizationStatus({controllerRest});assert.fail('Expected an invalid URL');}
    catch(error) {assert.equal((error as Error).message,'Unsupported authorization status URL');}
  }
});
test('rejects a slow user result that outlives its permitted cache lifetime',async()=>{
  const f=fixture(async()=>{f.advance(5000);return active();});await assert.rejects(f.status.check('one',user),{status:503});
});
test('fails closed at deadline without exposing underlying errors',async()=>{
  const f=fixture(async(_url,options)=>new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(Error('private timeout')))));
  const start=Date.now();await assert.rejects(f.status.check('private',machine),{status:503,message:'Authorization status authority unavailable'});
  assert.ok(Date.now()-start<2500);assert.equal(f.status.snapshot().activeChecks,0);
});
test('keeps the concurrency permit until an abort-ignoring transport really settles',async()=>{
  let release!:(response:Response)=>void;
  const f=fixture(async()=>new Promise<Response>(resolve=>{release=resolve;}));
  await assert.rejects(f.status.check('machine',machine),{status:503});
  assert.equal(f.status.snapshot().activeChecks,1);
  release(active('machine'));
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.status.snapshot().activeChecks,0);
});
test('schema retains legacy config bounds and default',()=>{
  const schema=projectExtrasSchema.shape.authorization;assert.deepEqual(schema.parse(undefined),{mode:'controller',statusCacheMs:5000});
  for(const statusCacheMs of [0,249,30001,500.5])assert.equal(schema.safeParse({statusCacheMs}).success,false);
  assert.equal(schema.safeParse({mode:'automatic'}).success,false);
});
