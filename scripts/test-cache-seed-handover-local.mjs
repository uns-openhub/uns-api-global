/** Actual API processes and SDK handover over loopback MQTT. Controller and SQL
 * responses are synthetic. No production addresses or persistent state.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import jwt from 'jsonwebtoken';

const require = createRequire(import.meta.resolve('@uns-kit/core'));
const { connect } = require('mqtt');
const entry = path.resolve(process.env.CACHE_SEED_ENTRY ?? 'dist/index.js');
const before = process.argv.includes('--expect-before');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'openhub-cache-seed-handover-'));
const servers = [], children = [], logs = { source: '', target: '' }, origins = {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const secret = randomBytes(32).toString('hex');
const token = jwt.sign({ sub: 'local-cache-reader', roles: ['admin'], scope: 'read:uns', accessRules: ['enterprise/#'] }, secret, { expiresIn: '10m' });
const topics = Array.from({ length: 2000 }, (_, i) => `enterprise/site/area/line/motor/equipment/point-${i}/temperature`);
const columns = [['topic','SYMBOL'],['asset','SYMBOL'],['objectType','SYMBOL'],['objectId','SYMBOL'],['attribute','SYMBOL'],['valueType','SYMBOL'],['value','DOUBLE'],['numberValue','DOUBLE'],['uom','VARCHAR'],['timestamp','TIMESTAMP'],['interval','LONG'],['deleted','BOOLEAN'],['lastSeen','TIMESTAMP']];
const queries = { source: 0, target: 0 };
let releaseSeed, client, pulse;
const seedGate = new Promise(resolve => { releaseSeed = resolve; });
async function listen(server) { server.listen(0,'127.0.0.1'); await once(server,'listening'); servers.push(server); return `http://127.0.0.1:${server.address().port}`; }
function send(res,status,body) { if(res.destroyed)return; res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body)); }
async function waitFor(check, description, timeout=15000) { const until=Date.now()+timeout;while(Date.now()<until){if(await check())return;await delay(20);}throw Error('Deadline: '+description); }
async function call(owner, route, body) { const r=await fetch(origins[owner]+route,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}; }
async function launch(owner, quest, controller, mqttPort, returning=false) {
  const successor=owner==='target'||returning;
  logs[owner]='';
  delete origins[owner];
  const dir=path.join(tmp,owner);await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'package.json'),JSON.stringify({name:'uns-api-global',version:'4.1.24',type:'module'}));
  await writeFile(path.join(dir,'config.json'),JSON.stringify({
    uns:{processName:'cache-seed-handover-local',instanceMode:successor?'handover':'force',handover:true,handoverProtocol:'correlated-v2',rest:controller+'/api',graphql:controller+'/graphql',token},
    infra:{host:'127.0.0.1',port:mqttPort,protocol:'mqtt'},
    authorization:{mode:'controller',statusCacheMs:250},
    questdb:{url:quest,username:'synthetic',password:'local-only',defaultLimit:5,maxLimit:5,maxLookbackHours:24,maxScanRows:20,maxResponseBytes:1048576,statementTimeoutMs:5000,queryDiagnostics:{maxConcurrent:4,maxQueued:8,queueTimeoutMs:1000,failureCooldownMs:0}},
    dataSources:[{topic:'enterprise/#',history:true,cache:true}],lastValueCache:{enabled:true,topicRefreshIntervalMs:30000,staleTtlMs:86400000},catchAll:{apiBasePath:'/api/catchall'},
  }));
  const child=spawn(process.execPath,[entry],{cwd:dir,env:{PATH:process.env.PATH,UNS_API_JWT_SECRET:secret,...(successor?{UNS_HANDOVER_ID:randomUUID()}:{})},stdio:['ignore','pipe','pipe']});children.push(child);
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{logs[owner]=(logs[owner]+bytes).slice(-200000);const match=/API listening on http:\/\/[^:\s]+:(\d+)/.exec(logs[owner]);if(match)origins[owner]='http://127.0.0.1:'+match[1];});
  await waitFor(()=>{if(child.exitCode!==null)throw Error(owner+' exited during startup');return !!origins[owner];},owner+' HTTP listener');return child;
}
try {
  const databases={};
  for(const owner of ['source','target'])databases[owner]=await listen(http.createServer(async(req,res)=>{
    const sql=new URL(req.url,'http://local').searchParams.get('query')??'';
    if(/^SELECT 1\s*$/i.test(sql))return send(res,200,{columns:[{name:'one',type:'INT'}],dataset:[[1]]});
    if(/^SHOW COLUMNS/i.test(sql))return send(res,200,{columns:[{name:'column',type:'STRING'},{name:'type',type:'STRING'}],dataset:columns});
    queries[owner]++;
    if(owner==='source')await Promise.race([seedGate,once(res,'close')]);
    await delay(100);
    send(res,200,{columns:columns.map(([name,type])=>({name,type})),dataset:[],count:0});
  }));
  const controller=await listen(http.createServer(async(req,res)=>{
    if(req.url==='/api/auth/token-status')return send(res,200,{active:true,protocolVersion:1});
    if(req.url==='/graphql'){
      let raw='';for await(const c of req)raw+=c;const q=JSON.parse(raw||'{}').query??'';
      if(q.includes('QuestDBMappings'))return send(res,200,{data:{QuestDBMappings:[{tableName:'history_current',topicPrefix:'enterprise/#',processName:'local-archiver',packageName:'local-archiver',version:'1',historyId:'1',historyRevision:'1',retiredAt:null}]}});
      return send(res,200,{data:{GetUnsNodes:topics.map((fullTopic,id)=>({id,type:'Attribute',fullTopic}))}});
    }
    if(req.url?.startsWith('/api/triggers'))return send(res,200,{triggers:[]});
    if(req.url?.startsWith('/api/captures'))return send(res,200,{captures:[]});
    send(res,200,{});
  }));
  const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const mqttPort=reserve.address().port;await new Promise(done=>reserve.close(done));
  const brokerConfig=path.join(tmp,'mosquitto.conf');await writeFile(brokerConfig,`listener ${mqttPort} 127.0.0.1\nallow_anonymous true\npersistence false\n`);
  const broker=spawn(process.env.MOSQUITTO_BIN??'mosquitto',['-c',brokerConfig],{stdio:'ignore'});children.push(broker);let brokerError;broker.on('error',e=>{brokerError=e;});
  await waitFor(async()=>{if(brokerError)throw brokerError;try{const s=net.connect(mqttPort,'127.0.0.1');s.on('error',()=>{});await Promise.race([once(s,'connect'),delay(100).then(()=>{throw Error();})]);s.destroy();return true;}catch{return false;}},'MQTT broker');
  client=connect(`mqtt://127.0.0.1:${mqttPort}`);await once(client,'connect');
  pulse=setInterval(()=>client.publish(topics[0],JSON.stringify({version:'2.0.0',message:{data:{time:new Date().toISOString(),value:99,uom:'C'}}}),{qos:1}),30);
  const source=await launch('source',databases.source,controller,mqttPort);
  await waitFor(async()=>queries.source>=4&&(await call('source','/api/catchall/diagnostics/queries')).status===200,'active source with held initial seed',45000);
  const started=Date.now();
  const target=await launch('target',databases.target,controller,mqttPort);
  await waitFor(()=>logs.source.includes('Received handover request'),'source ownership release',30000);
  const atRelease=queries.source, releasedAt=Date.now();
  if(!before)assert.equal(queries.target,0,'passive target must not seed from history');
  releaseSeed();
  if(before){
    await delay(750);
    assert.ok(queries.source>atRelease&&queries.target>0,'old application must reproduce seed admission during transfer');
    assert.equal(source.exitCode,null,'full seed still blocks source completion');
    console.log(JSON.stringify({stage:'before-fix',sourceQueries:queries.source,targetQueries:queries.target,sourceStillRunning:source.exitCode===null,scope:'actual API+SDK+MQTT; synthetic HTTP controller/SQL'}));
  }else{
    await waitFor(async()=>source.exitCode===0&&(await call('target','/api/catchall/diagnostics/queries')).status===200,'clean source exit and active successor',12000);
    assert.equal(queries.source,atRelease,'paused source must not admit the rest of 2000 seed topics');
    const current=await call('target','/api/catchall/batch/last',{topics:[topics[0]]});
    assert.equal(current.status,200);assert.equal(current.body.results[0].value,99);assert.equal(current.body.results[0].uom,'C');assert.equal(current.body.results[0].source,'cache');
    assert.equal(target.exitCode,null);assert.match(logs.source,/Handover source drain completed/);
    const forward={sourceSeedQueries:queries.source,sourceQueriesAtRelease:atRelease,sourceExit:source.exitCode,elapsedMs:Date.now()-started,releaseToActiveMs:Date.now()-releasedAt};
    const returning=await launch('source',databases.source,controller,mqttPort,true);
    await waitFor(()=>logs.target.includes('Received handover request'),'reverse source ownership release',30000);
    const reverseQueriesAtRelease=queries.target,reverseReleasedAt=Date.now();
    await waitFor(async()=>target.exitCode===0&&(await call('source','/api/catchall/diagnostics/queries')).status===200,'reverse clean source exit and active successor',12000);
    assert.equal(queries.target,reverseQueriesAtRelease,'reverse release must also stop new seed lookups');
    await waitFor(async()=>{const r=await call('source','/api/catchall/batch/last',{topics:[topics[0]]});return r.status===200&&r.body.results[0].value===99&&r.body.results[0].uom==='C';},'live value after reverse ownership');
    assert.equal(returning.exitCode,null);assert.match(logs.target,/Handover source drain completed/);
    console.log(JSON.stringify({stage:'fixed',topics:topics.length,forward,reverse:{queriesAtRelease:reverseQueriesAtRelease,sourceExit:target.exitCode,releaseToActiveMs:Date.now()-reverseReleasedAt},targetSeedStartsAfterActivation:true,liveValue:99,uom:'C',scope:'actual API+SDK+MQTT; synthetic HTTP controller/SQL, not Controller coordinator or real QuestDB'}));
  }
}catch(error){const redact=x=>[secret,token].reduce((s,k)=>s.replaceAll(k,'[local credential]'),x);console.error(redact(String(error)));console.error(redact(JSON.stringify({source:logs.source.slice(-1500),target:logs.target.slice(-1500)})));process.exitCode=1;}
finally{
  clearInterval(pulse);releaseSeed?.();if(client)await client.endAsync(true);
  for(const child of children.reverse()){if(child.exitCode!==null)continue;child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000)]);if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}}
  for(const server of servers){server.closeAllConnections();await new Promise(done=>server.close(done));}
  await rm(tmp,{recursive:true,force:true});
}
