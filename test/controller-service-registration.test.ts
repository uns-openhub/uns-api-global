import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControllerServiceRegistration } from '../src/controller-service-registration.js';

test('controller unavailable at startup does not abort remaining initialization, and later refresh recovers', async () => {
 let available=false, attempts=0; const states:boolean[]=[];
 const registration=new ControllerServiceRegistration(async()=>{attempts++;if(!available)throw Error('unavailable');},ready=>states.push(ready));
 assert.equal(await registration.refresh(),false);
 available=true;assert.equal(await registration.refresh(),true);assert.equal(attempts,2);assert.deepEqual(states,[false,true]);
});
test('coalesces an in-flight request; no overlapping attempts',async()=>{
 let finish!:()=>void;let calls=0;const registration=new ControllerServiceRegistration(()=>{calls++;return new Promise<void>(resolve=>{finish=resolve;});});
 const first=registration.refresh();assert.equal(registration.refresh(),first);assert.equal(calls,1);finish();assert.equal(await first,true);
 const again=registration.refresh();assert.equal(calls,2);finish();assert.equal(await again,true);
});
test('failed current credentials never count as successful registration and are retried with current inputs',async()=>{
 let credential='revoked';const states:boolean[]=[];const registration=new ControllerServiceRegistration(async()=>{if(credential==='revoked')throw Error('403');},ready=>states.push(ready));
 assert.equal(await registration.refresh(),false);assert.equal(await registration.refresh(),false);assert.deepEqual(states,[false]);
 credential='rotated';assert.equal(await registration.refresh(),true);credential='revoked';assert.equal(await registration.refresh(),false);assert.deepEqual(states,[false,true,false]);
});
test('malformed receipt rejection is recoverable and repeated states are quiet',async()=>{
 let valid=false;const states:boolean[]=[];const registration=new ControllerServiceRegistration(async()=>{if(!valid)throw Error('invalid receipt with sensitive body');},ready=>states.push(ready));
 assert.equal(await registration.refresh(),false);assert.equal(await registration.refresh(),false);valid=true;assert.equal(await registration.refresh(),true);assert.equal(await registration.refresh(),true);assert.deepEqual(states,[false,true]);
});
