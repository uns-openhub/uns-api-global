import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { authorizeBearer, canInspectRuntime } from '../src/authorize-bearer.js';
import { AuthorizationStatus, authorizationStatusForConfig } from '../src/authorization-status.js';
import { runtimeInspectionKind } from '../src/catchall-helpers.js';

const secret='only-a-local-test-secret';
const sign=(claims:Record<string,unknown>)=>jwt.sign(claims,secret,{algorithm:'HS256',expiresIn:60});
const verify=async(token:string)=>jwt.verify(token,secret,{algorithms:['HS256']}) as Record<string,unknown>;
const auth={jwtSecret:secret};
const fetchResult=(principalType='user')=>Response.json({active:true,protocolVersion:1,principalType,configuredAccessAuthority:2});

test('validates the real bearer signature before invoking Controller status',async()=>{
  let calls=0;const status=new AuthorizationStatus({controllerRest:'http://localhost/api',fetch:async()=>{calls++;return fetchResult();}});
  const token=sign({sub:'user',roles:['user']});
  await assert.rejects(authorizeBearer(token.slice(0,-2)+'xx',verify,status,auth));
  const expired=jwt.sign({sub:'user'},secret,{algorithm:'HS256',expiresIn:-1});
  await assert.rejects(authorizeBearer(expired,verify,status,auth));
  assert.equal(calls,0);
  assert.equal((await authorizeBearer(token,verify,status,auth)).sub,'user');assert.equal(calls,1);
});
test('keeps the existing standalone HMAC user mode without allowing a machine bypass',async()=>{
  let calls=0;const status=new AuthorizationStatus({mode:'offline',controllerRest:'http://localhost/api',fetch:async()=>{calls++;return fetchResult('machine');}});
  const user=sign({sub:'user',roles:['user']}),machine=sign({sub:'machine',machineIdentityId:'machine',serviceToken:true});
  await authorizeBearer(user,verify,status,auth);assert.equal(calls,0);
  await authorizeBearer(machine,verify,status,auth);assert.equal(calls,1);
});
test('does not treat a configured-service claim as an offline standalone user',async()=>{
  let calls=0;
  const status=new AuthorizationStatus({mode:'offline',controllerRest:'http://localhost/api',fetch:async()=>{
    calls++;return new Response(null,{status:403});
  }});
  const token=sign({sub:'legacy',configuredService:{protocol:2,operationId:'old'}});
  await assert.rejects(authorizeBearer(token,verify,status,auth),{status:403});
  assert.equal(calls,1);
});
test('does not treat an operator delegation claim as an offline standalone user',async()=>{
  let calls=0;
  const status=new AuthorizationStatus({mode:'offline',controllerRest:'http://localhost/api',fetch:async()=>{
    calls++;return new Response(null,{status:403});
  }});
  const token=sign({sub:'legacy',unsOperatorDelegation:{protocol:1}});
  await assert.rejects(authorizeBearer(token,verify,status,auth),{status:403});
  assert.equal(calls,1);
});
test('limits unfiltered runtime inspection to an active administrator, excluding machine tokens',async()=>{
  const status=new AuthorizationStatus({controllerRest:'http://localhost/api',fetch:async()=>fetchResult('user')});
  const read=async(claims:Record<string,unknown>)=>canInspectRuntime(await authorizeBearer(sign(claims),verify,status,auth));
  assert.equal(await read({sub:'admin',roles:['admin'],accessRules:['#']}),true);
  assert.equal(await read({sub:'reader',roles:['user'],scopes:['read:uns'],accessRules:['#']}),false);
  assert.equal(await read({sub:'machine',machineIdentityId:'id',serviceToken:true,roles:['admin'],scopes:['read:uns'],accessRules:['#']}),false);
  assert.equal(await read({sub:'broker',catalogPublication:{operation:'summary'},roles:['admin']}),false);
  assert.equal(await read({sub:'machine',configuredService:{protocol:2},roles:['admin']}),false);
  assert.equal(await read({sub:'delegate',unsOperatorDelegation:{protocol:1},roles:['admin']}),false);
});
test('matches each runtime inspection endpoint under direct, mounted and controller-rebased paths',()=>{
  for (const kind of ['triggers','captures'] as const) {
    for (const path of [`/${kind}/runtime`,`/api/${kind}/runtime`,`/api/catchall/${kind}/runtime`,
      `/catchall/${kind}/runtime`,`api//catchall//${kind}/runtime/`]) {
      assert.equal(runtimeInspectionKind(path,'/api/catchall'),kind,path);
    }
    for (const path of [`/api/custom/${kind}/runtime`,`/custom/${kind}/runtime`])
      assert.equal(runtimeInspectionKind(path,'/api/custom/'),kind,path);
    assert.equal(runtimeInspectionKind(`/custom/${kind}/runtime`,'/custom'),kind);
    for (const path of [`/site/${kind}/runtime`,`/api/catchall/site/${kind}/runtime`,
      `/api/catchall/${kind}/runtime/extra`,`/catchall/${kind}/runtime-other`])
      assert.equal(runtimeInspectionKind(path,'/api/catchall'),null,path);
  }
});
test('all rebased runtime endpoints preserve administrator, reader and service authorization',async()=>{
  const status=new AuthorizationStatus({controllerRest:'http://localhost/api',fetch:async()=>fetchResult('user')});
  const callers=await Promise.all([
    {claims:{sub:'admin',roles:['admin']},allowed:true},
    {claims:{sub:'reader',roles:['user'],scopes:['read:uns'],accessRules:['#']},allowed:false},
    {claims:{sub:'service',roles:['admin'],machineIdentityId:'id',serviceToken:true,scopes:['read:uns'],accessRules:['#']},allowed:false},
  ].map(async ({claims,allowed})=>({claims:await authorizeBearer(sign(claims),verify,status,auth),allowed})));
  for (const kind of ['triggers','captures'] as const) {
    for (const path of [`/${kind}/runtime`,`/api/${kind}/runtime`,`/api/catchall/${kind}/runtime`,`/catchall/${kind}/runtime`]) {
      for (const {claims,allowed} of callers) {
        assert.equal(runtimeInspectionKind(path,'/api/catchall'),kind,path);
        assert.equal(canInspectRuntime(claims),allowed,`${path} ${String(claims.sub)}`);
      }
    }
  }
});
test('never caches a verified service bearer after its status changes',async()=>{
  let active=true,calls=0;
  const status=new AuthorizationStatus({controllerRest:'http://localhost/api',fetch:async()=>{calls++;return active?fetchResult('machine'):new Response(null,{status:403});}});
  const token=sign({sub:'machine',machineIdentityId:'machine',serviceToken:true,scopes:['read:uns'],accessRules:['plant/#']});
  await authorizeBearer(token,verify,status,auth);active=false;
  await assert.rejects(authorizeBearer(token,verify,status,auth),{status:403});assert.equal(calls,2);
});
test('does not authorize a signed service or broker bearer from an old Controller',async()=>{
  let calls=0;const status=new AuthorizationStatus({controllerRest:'http://localhost/api',fetch:async()=>{
    calls++;return Response.json({active:true,protocolVersion:1,principalType:'user'});
  }});
  const service=sign({sub:'machine',machineIdentityId:'machine',serviceToken:true});
  const broker=sign({sub:'machine',serviceToken:true,catalogPublication:{operation:'summary'}});
  await assert.rejects(authorizeBearer(service,verify,status,auth),{status:503});
  await assert.rejects(authorizeBearer(broker,verify,status,auth),{status:503});
  assert.equal(calls,2);
});
test('never caches the short-lived catalog broker bearer, even if its subject is a user',async()=>{
  let allowed=true,calls=0;
  const status=new AuthorizationStatus({controllerRest:'http://localhost/api',fetch:async()=>{calls++;return allowed?fetchResult('user'):new Response(null,{status:403});}});
  const token=sign({sub:'machine',serviceToken:true,catalogPublication:{operation:'summary'},scopes:['read:uns'],accessRules:['private/history']});
  await authorizeBearer(token,verify,status,auth);allowed=false;
  await assert.rejects(authorizeBearer(token,verify,status,auth),{status:403});assert.equal(calls,2);
});
test('checks the broker bearer against configured uns.rest on every invocation',async()=>{
  let calls=0,active=true;
  const token=sign({sub:'machine',machineIdentityId:'machine',serviceToken:true,
    catalogPublication:{operation:'summary',revision:7},scopes:['read:uns'],accessRules:['private/history']});
  const status=authorizationStatusForConfig({uns:{rest:'http://controller.example:3200/api/'}},{fetch:async(url,options)=>{
    calls++;assert.equal(url,'http://controller.example:3200/api/auth/token-status');
    assert.equal(options?.method,'POST');assert.equal(options?.redirect,'error');
    assert.deepEqual(options?.headers,{authorization:`Bearer ${token}`,accept:'application/json'});assert.equal(options?.body,undefined);
    return active?fetchResult('machine'):new Response(null,{status:403});
  }});
  await authorizeBearer(token,verify,status,auth);active=false;
  await assert.rejects(authorizeBearer(token,verify,status,auth),{status:403});assert.equal(calls,2);
});
test('retains caching for a verified user when the Controller confirms user type',async()=>{
  let calls=0;const status=new AuthorizationStatus({controllerRest:'http://localhost/api',fetch:async()=>{calls++;return fetchResult('user');}});
  const token=sign({sub:'user',roles:['user'],scopes:['read:uns'],accessRules:['plant/#']});
  await authorizeBearer(token,verify,status,auth);await authorizeBearer(token,verify,status,auth);assert.equal(calls,1);
});
