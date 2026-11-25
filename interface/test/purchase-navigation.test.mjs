import test from 'node:test';
import assert from 'node:assert/strict';
import {readAcrossNavigation}from'../server/purchase-navigation.mjs';
import {clickPurchaseControl}from'../server/purchase-clicks.mjs';

const changed=()=>new Error('Execution context was destroyed, most likely because of a navigation.');
test('a read interrupted by reload is repeated after the old context disappears',async()=>{
  let calls=0;const result=await readAcrossNavigation({},async()=>{if(++calls===1)throw changed();return 'Pix available';});assert.equal(result,'Pix available');assert.equal(calls,2);
});
test('read retry never swallows unrelated failures and obeys cancellation',async()=>{
  let calls=0;await assert.rejects(()=>readAcrossNavigation({},async()=>{calls++;throw Error('HTTP 403');}),/HTTP 403/);assert.equal(calls,1);
  const controller=new AbortController();controller.abort();await assert.rejects(()=>readAcrossNavigation({},async()=>{throw Error('must not run');},{signal:controller.signal}),/interrompida/);
});
test('lookup can recover from navigation before one physical click',async()=>{
  let lookups=0,clicks=0;
  const page={bringToFront:async()=>{},evaluateHandle:async()=>{if(++lookups===1)throw changed();return {asElement:()=>({click:async()=>{clicks++;}}),dispose:async()=>{}};}};
  await clickPurchaseControl(page,()=>null,{});assert.equal(lookups,2);assert.equal(clicks,1);
});
test('a context destroyed during input never triggers a second click',async()=>{
  let clicks=0;
  const page={bringToFront:async()=>{},evaluateHandle:async()=>({asElement:()=>({click:async()=>{clicks++;throw changed();}}),dispose:async()=>{throw changed();}})};
  const result=await clickPurchaseControl(page,()=>null,{});assert.equal(result.contextChanged,true);assert.equal(clicks,1);
});
test('persistence failure before finalization prevents all input',async()=>{
  let clicks=0;
  const page={bringToFront:async()=>{},evaluateHandle:async()=>({asElement:()=>({click:async()=>{clicks++;}}),dispose:async()=>{}})};
  await assert.rejects(()=>clickPurchaseControl(page,()=>null,{}, {beforeClick:async()=>{throw Error('disk unavailable');}}),/disk unavailable/);assert.equal(clicks,0);
});
