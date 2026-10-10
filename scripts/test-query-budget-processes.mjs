/** Built-candidate acceptance: two separate OS processes, one synthetic HTTP sink. */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
let active=0,peak=0,completed=0;
const server=http.createServer((_req,res)=>{peak=Math.max(peak,++active);setTimeout(()=>{active--;completed++;res.end('{}');},75);});
server.listen(0,'127.0.0.1');await once(server,'listening');
const url=`http://127.0.0.1:${server.address().port}`;
const code=`import { QueryDiagnostics } from ${JSON.stringify(new URL('../dist/query-diagnostics.js',import.meta.url).href)};
import { resolveQueryDeploymentBudget } from ${JSON.stringify(new URL('../dist/query-deployment-budget.js',import.meta.url).href)};
const allocation=resolveQueryDeploymentBudget({maxConcurrent:4,maxQueued:8,deploymentBudget:{totalMaxConcurrent:2,maxInstances:2}});
const holder=new QueryDiagnostics({...allocation,maxQueued:8,databaseLabel:'synthetic',queueTimeoutMs:2000,slowQueryMs:1000,failureCooldownMs:0,emit:()=>{}});
process.send({ready:true});
await new Promise(r=>process.once('message',r));
await Promise.all(Array.from({length:6},(_,i)=>holder.query('synthetic','SELECT '+i,'history',async()=>{const r=await fetch(${JSON.stringify(url)});await r.text();return {value:{data:[]},rows:0,responseBytes:2,httpStatus:r.status};})));
process.send({done:true,maxConcurrent:holder.snapshot().limits.maxConcurrent});process.disconnect();`;
const children=[];let timer;
try {
 const actors=Array.from({length:2},()=>{const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe','ipc']});children.push(child);let done,ready;const readyPromise=new Promise(r=>ready=r);const outcome=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.ready)ready();if(m.done)done=m;});child.on('error',reject);child.on('exit',exit=>exit===0&&done?resolve(done):reject(new Error('Budget actor failed')));});return {child,readyPromise,outcome};});
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Budget acceptance deadline')),10000);});
 const work=(async()=>{await Promise.all(actors.map(a=>a.readyPromise));for(const a of actors)a.child.send('go');return Promise.all(actors.map(a=>a.outcome));})();
 const results=await Promise.race([work,deadline]);assert.equal(peak,2);assert.equal(completed,12);assert.equal(active,0);assert.ok(results.every(r=>r.maxConcurrent===1));
 console.log(JSON.stringify({scope:'two OS processes; synthetic HTTP sink; not two deployed APIs',processes:2,requests:completed,peak,perProcess:1,configuredTotal:2}));
} finally {clearTimeout(timer);for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');await new Promise(r=>server.close(r));}
