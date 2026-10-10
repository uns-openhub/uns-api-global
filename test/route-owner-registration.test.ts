import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RouteOwnerRegistration, routeRegistrationEnvironment } from '../src/route-owner-registration.js';
const options = {controllerBase:'http://controller:3200',tokenFile:'/not-used',controllerName:'a',instanceId:'one',version:'v1.0.1',processName:'reader',launchId:'launch',token:async()=> 'private-token'};
const receipt = {protocolVersion:1,expiresInMs:30000,binding:{controllerName:'a',instanceId:'one',version:'v1.0.1',processName:'reader',apiHost:'http://runtime:4000',deploymentId:'launch:12:123'}};
test('sends only the origin with a dedicated bearer and coalesces registration', async () => {
 let calls=0, ready=0;
 const client = new RouteOwnerRegistration({...options,fetch:async (_url,init) => {
  calls++; assert.equal(init?.redirect,'error'); assert.equal(init?.body,JSON.stringify({apiHost:'http://runtime:4000'}));
  assert.equal((init?.headers as Record<string,string>).authorization,'Bearer private-token');
  return new Response(JSON.stringify(receipt),{status:201});
 },onReady:async()=>{ready++;}});
 client.observe([{apiBase:'http://runtime:4000'}]); await Promise.all([client.renew(),client.renew()]);
 assert.equal(calls,1); assert.equal(ready,1); await client.renew(); assert.equal(ready,1); client.stop();
});
test('failed or mismatched receipts do not grant readiness; recovery republishes once', async () => {
 let mode='bad', ready=0;
 const client = new RouteOwnerRegistration({...options,fetch:async()=>new Response(JSON.stringify(mode==='bad'?{...receipt,binding:{...receipt.binding,instanceId:'other'}}:receipt),{status:201}),onReady:async()=>{ready++;}});
 client.observe([{apiBase:'http://runtime:4000'}]); assert.equal(await client.renew(),false); assert.equal(ready,0);
 mode='good'; assert.equal(await client.renew(),true); assert.equal(ready,1); client.stop();
});
test('rejects oversized chunked receipts and redirects/HTTP failure without logging a token', async () => {
 for (const response of [new Response('x'.repeat(5000),{status:201}),new Response('{}',{status:403})]) {
  const client=new RouteOwnerRegistration({...options,fetch:async()=>response});client.observe([{apiBase:'http://runtime:4000'}]);assert.equal(await client.renew(),false);client.stop();
 }
});
test('only one credential-free HTTP origin is observed', () => {
 const client=new RouteOwnerRegistration(options);
 assert.throws(()=>client.observe([{apiBase:'http://user:secret@runtime:4000'}]));
 assert.throws(()=>client.observe([{apiBase:'http://one:4000'},{apiBase:'http://two:4000'}]));client.stop();
});
test('direct and legacy launches remain autonomous; managed incomplete launch fails explicitly', () => {
 assert.equal(routeRegistrationEnvironment({}),undefined);
 assert.equal(routeRegistrationEnvironment({RTT_NODE:'api'}),undefined);
 assert.throws(()=>routeRegistrationEnvironment({RTT_NODE:'api',UNS_ROUTE_TOKEN_FILE:'/file'}));
 assert.equal(routeRegistrationEnvironment({RTT_NODE:'api',UNS_ROUTE_TOKEN_FILE:'/file',UNS_ROUTE_CONTROLLER_NAME:'a',RTT_INSTANCE_ID:'one',version:'v1',UNS_ROUTE_LAUNCH_ID:'launch',UNS_CONTROLLER_HOST:'::1',UNS_CONTROLLER_PORT:'3200'})?.controllerBase,'http://[::1]:3200');
});

test('PM2 bare versions match canonical receipts and state changes are reported once', async () => {
 let fail=true; const states: boolean[]=[];
 const client=new RouteOwnerRegistration({...options,version:'1.0.1',onState:ready=>states.push(ready),fetch:async()=>{if(fail)throw Error('private transport detail');return new Response(JSON.stringify(receipt),{status:201});}});
 client.observe([{apiBase:'http://runtime:4000'}]);assert.equal(await client.renew(),false);await client.renew();
 fail=false;assert.equal(await client.renew(),true);await client.renew();assert.deepEqual(states,[false,true]);client.stop();
});
test('targets the launcher owning controller base and rejects credential-bearing bases', () => {
 const env={RTT_NODE:'api',UNS_ROUTE_TOKEN_FILE:'/file',UNS_ROUTE_CONTROLLER_NAME:'a',RTT_INSTANCE_ID:'one',version:'1.0.1',UNS_ROUTE_LAUNCH_ID:'launch',UNS_CONTROLLER_HOST:'host.containers.internal',UNS_CONTROLLER_PORT:'3200',UNS_CONTROLLER_PUBLIC_BASE:'http://127.0.0.1:3201'};
 assert.equal(routeRegistrationEnvironment(env)?.controllerBase,'http://127.0.0.1:3201');
 for(const base of ['http://user:secret@owner:3200','http://owner:3200/path','http://owner:3200?secret=x','file:///tmp/owner']) assert.throws(()=>routeRegistrationEnvironment({...env,UNS_CONTROLLER_PUBLIC_BASE:base}));
});
