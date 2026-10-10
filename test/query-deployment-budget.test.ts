import test from "node:test";
import assert from "node:assert/strict";
import { resolveQueryDeploymentBudget } from "../src/query-deployment-budget.js";
import { QueryDiagnostics } from "../src/query-diagnostics.js";
import { projectExtrasSchema } from "../src/config/project.config.extension.js";

const input = { maxConcurrent: 4, maxQueued: 8 };
test("unconfigured deployments retain existing per-process limits", () => {
  assert.deepEqual(resolveQueryDeploymentBudget(input), { maxConcurrent: 4, deploymentBudget: undefined });
});
test("floored static allocations never exceed the declared deployment ceiling", () => {
  for (let slots=1;slots<30;slots++) for(let instances=1;instances<=slots;instances++) {
    const plan=resolveQueryDeploymentBudget({...input,deploymentBudget:{totalMaxConcurrent:slots,maxInstances:instances}});
    assert.ok(plan.maxConcurrent>=1 && plan.maxConcurrent<=4);
    assert.ok(plan.maxConcurrent*instances<=slots);
    assert.equal(plan.deploymentBudget?.observedProcessCount,null);
    assert.equal(plan.deploymentBudget?.plannedMaxQueued,8*instances);
  }
});
test("invalid and zero-slot allocations fail before requests", () => {
  for(const budget of [{totalMaxConcurrent:1,maxInstances:2},{totalMaxConcurrent:0,maxInstances:1},{totalMaxConcurrent:4,maxInstances:0},{totalMaxConcurrent:4.5,maxInstances:2}]) {
    assert.throws(()=>resolveQueryDeploymentBudget({...input,deploymentBudget:budget}));
    assert.equal(projectExtrasSchema.shape.questdb.shape.queryDiagnostics.safeParse({...input,deploymentBudget:budget}).success,false);
  }
});
test("two independent holders honor their conservative allocation and expose its limits", async () => {
  const allocation=resolveQueryDeploymentBudget({...input,deploymentBudget:{totalMaxConcurrent:2,maxInstances:2}});
  const holders=[0,1].map(()=>new QueryDiagnostics({...input,...allocation,databaseLabel:"replica",queueTimeoutMs:1000,slowQueryMs:1000,failureCooldownMs:0,emit:()=>{}}));
  let active=0,peak=0;
  await Promise.all(holders.flatMap((holder,index)=>Array.from({length:3},(_,i)=>holder.query("db",`SELECT ${index*10+i}`,"history",async()=>{
    peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,10));active--;
    return {value:{data:[]},rows:0,responseBytes:0,httpStatus:200};
  }))));
  assert.equal(peak,2);
  assert.equal(active,0);
  for(const holder of holders)assert.equal((holder.snapshot().limits as {deploymentBudget:{plannedMaxConcurrent:number}}).deploymentBudget.plannedMaxConcurrent,2);
});
