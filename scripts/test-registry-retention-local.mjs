/** Opt-in local diagnostic, not a CI heap threshold or production stability claim.
 * Build first; run with node --expose-gc. No real credentials or external calls.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {TriggerRegistry} from '../dist/triggers/registry.js';
import {CaptureRegistry} from '../dist/captures/registry.js';
assert.equal(typeof global.gc,'function','Run node --expose-gc scripts/test-registry-retention-local.mjs');
const rounds=Number(process.env.REGISTRY_BENCH_ROUNDS??1000),status=Number(process.env.REGISTRY_BENCH_STATUS??403);
assert.ok(Number.isInteger(rounds)&&rounds>=100&&rounds<=10000);
assert.ok([200,401,403,503].includes(status));
let received=0;
const server=http.createServer((_req,res)=>{
 received++;res.writeHead(status,{'content-type':'application/json'});
 res.end(JSON.stringify(status===200?{triggers:[],captures:[]}:{error:'Synthetic local denial'}));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const collect=async()=>{global.gc();await new Promise(r=>setTimeout(r,100));global.gc();return process.memoryUsage();};
try{
 const deps={controllerRestUrl:'http://127.0.0.1:'+server.address().port,getAccessToken:async()=> 'synthetic-local-only',refreshIntervalMs:1000};
 const registries=[new TriggerRegistry(deps),new CaptureRegistry(deps)];
 try{
  for(let i=0;i<10;i++)for(const registry of registries)await registry.refresh();const before=await collect();
  for(let i=0;i<rounds;i++)for(const registry of registries)await registry.refresh();const after=await collect();
  assert.equal(received,(rounds+10)*2);
  console.log(JSON.stringify({node:process.version,platform:process.platform,status,measuredRequests:rounds*2,warmupRequests:20,received,before,after,retainedHeapDeltaBytes:after.heapUsed-before.heapUsed},null,2));
 }finally{for(const registry of registries)registry.stop();}
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
