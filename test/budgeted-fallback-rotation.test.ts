import assert from 'node:assert/strict';
import test from 'node:test';
import {BudgetedFallbackRotation} from '../src/budgeted-fallback-rotation.js';

test('permanently empty first twenty paths cannot starve a later archived manifest',()=>{
  const scheduler=new BudgetedFallbackRotation(20);
  const misses=[...Array.from({length:20},(_,i)=>'empty-'+i),'manifest'];
  assert.equal(scheduler.select(misses).includes('manifest'),false);
  const next=scheduler.select(misses);assert.equal(next.length,20);assert.equal(next.includes('manifest'),true);
});

test('visits every missing candidate with the same bounded budget, including wrap-around',()=>{
  for(const size of [1,19,20,21,40,41,139,500]){
    const scheduler=new BudgetedFallbackRotation(20),input=Array.from({length:size},(_,i)=>i),visited=new Set<number>();
    for(let round=0;round<Math.ceil(size/20);round++){
      const selected=scheduler.select(input);assert.equal(selected.length,Math.min(size,20));assert.equal(new Set(selected).size,selected.length);selected.forEach(i=>visited.add(i));
    }
    assert.equal(visited.size,size);
  }
});

test('adapts to changing filtered candidates, retains no caller data and selects synchronously',()=>{
  const scheduler=new BudgetedFallbackRotation(2);
  assert.deepEqual(scheduler.select(['a','b','c']),['a','b']);
  assert.deepEqual(scheduler.select(['c','d','e']),['e','c']);
  assert.deepEqual(scheduler.select([]),[]);
  assert.deepEqual(scheduler.select(['only-authorized']),['only-authorized']);
  assert.deepEqual(scheduler.select(['x','y','z']),['x','y']);
});

test('rejects invalid budgets',()=>{
  for(const value of [0,-1,NaN,Infinity,1.5])assert.throws(()=>new BudgetedFallbackRotation(value));
});


test('interleaved different requests cannot reset a stable request cursor',()=>{
  const scheduler=new BudgetedFallbackRotation(20);
  const first=Array.from({length:40},(_,i)=>'a-'+i),other=Array.from({length:40},(_,i)=>'b-'+i);
  assert.deepEqual(scheduler.select(first,first),first.slice(0,20));
  scheduler.select(other,other);
  assert.deepEqual(scheduler.select(first,first),first.slice(20));
});

test('bounded cursor retention evicts least recently used requests',()=>{
  const scheduler=new BudgetedFallbackRotation(1,2),input=['first','second'];
  assert.deepEqual(scheduler.select(input,['a']),['first']);
  scheduler.select(input,['b']);
  assert.deepEqual(scheduler.select(input,['a']),['second']);
  scheduler.select(input,['c']);
  assert.deepEqual(scheduler.select(input,['b']),['first']);
  for(const capacity of [0,-1,NaN,Infinity,1.5])assert.throws(()=>new BudgetedFallbackRotation(1,capacity));
});
