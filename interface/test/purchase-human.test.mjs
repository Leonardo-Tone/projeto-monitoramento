import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPurchaseHumanGate, purchasePageKind, revealPurchasePage, RevalidatePurchase } from '../server/purchase-human.mjs';
import { runPurchase } from '../server/purchase-runner.mjs';
import { defaults } from '../server/availability.mjs';
const projectRoot = process.env.MONITOR_PROJECT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('purchase gate recognizes the actual ML CAPTCHA route, login and visible challenges while rejecting foreign origins',()=>{
  assert.equal(purchasePageKind('https://www.mercadolivre.com.br/captcha/wall/logged'),'WALL');
  assert.equal(purchasePageKind('https://www.mercadolivre.com.br/captcha/wall/logged','',true),'CAPTCHA');
  assert.equal(purchasePageKind('https://www.mercadolivre.com.br/p/MLB123','Segurança — Mercado Livre'),'CAPTCHA');
  assert.equal(purchasePageKind('https://www.mercadolivre.com.br/p/MLB123','',true),'CAPTCHA');
  assert.equal(purchasePageKind('https://www.mercadolivre.com.br/login'),'LOGIN');
  assert.equal(purchasePageKind('https://example.invalid/captcha'),'INVALID');
  assert.equal(purchasePageKind('https://www.mercadolivre.com.br:4318/captcha'),'INVALID');
  assert.equal(purchasePageKind('https://www.mercadolivre.com.br/gz/cart/v2'),'READY');
});
test('CEPO window reveal restores normal state before positioning and focusing the challenge tab',async()=>{
  const calls=[];
  const client={send:async(method,args)=>{calls.push([method,args]);return {windowId:7};},detach:async()=>calls.push(['detach'])};
  const page={target:()=>({createCDPSession:async()=>client}),bringToFront:async()=>calls.push(['focus'])};
  assert.deepEqual(await revealPurchasePage(page),{restored:true,focused:true});
  assert.equal(calls[1][1].bounds.windowState,'normal');assert.equal(calls[2][1].bounds.left,40);assert.equal(calls.at(-1)[0],'focus');
});
test('reveal still focuses the tab if window restoration is unavailable',async()=>{
  let focused=false;
  const result=await revealPurchasePage({target(){throw Error('unavailable');},bringToFront:async()=>{focused=true;}});
  assert.equal(focused,true);assert.equal(result.restored,false);
});
function gateFixture(states,afterFinalize=false){
  const stages=[],notices=[];let revealed=0,reads=0,sleeps=0;const controller=new AbortController();
  const gate=createPurchaseHumanGate({signal:controller.signal,stage:async(...args)=>stages.push(args),notify:async n=>notices.push(n),reveal:async()=>{revealed++;return {restored:true,focused:true};},inspectPage:async()=>({kind:states[Math.min(reads++,states.length-1)]}),sleep:async()=>{sleeps++;}});
  return {run:()=>gate({},{afterFinalize}),stages,notices,controller,reads:()=>reads,sleeps:()=>sleeps,revealed:()=>revealed};
}
test('human pause notifies once and requires two consecutive normal readings before revalidation',async()=>{
  const f=gateFixture(['CAPTCHA','CAPTCHA','READY','CAPTCHA','READY','READY']);
  await assert.rejects(f.run,RevalidatePurchase);
  assert.equal(f.revealed(),1);assert.equal(f.notices.length,1);assert.equal(f.reads(),6);
  assert.equal(f.stages[0][0],'WAITING_HUMAN');assert.equal(f.stages.at(-1)[0],'RESUMING');assert.equal(f.stages.at(-1)[2].human,null);
});
test('after finalization human resolution resumes only confirmation, without restarting the purchase',async()=>{
  const f=gateFixture(['CAPTCHA','READY','READY'],true);await f.run();
  assert.equal(f.stages.at(-1)[0],'FINALIZING');assert.equal(f.notices.length,1);
});
test('stopping interrupts a human pause without waiting for CAPTCHA completion',async()=>{
  const controller=new AbortController();let paused;
  const waiting=new Promise(resolve=>{paused=resolve;});
  const guard=createPurchaseHumanGate({signal:controller.signal,stage:async()=>{},notify:async()=>{},reveal:async()=>({}),inspectPage:async()=>({kind:'CAPTCHA'}),sleep:async()=>{paused();await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));}});
  const task=guard({});await waiting;controller.abort();await assert.rejects(task,/interrompida/);
});
test('closing the browser during the pause terminates the attempt rather than replaying it',async()=>{
  let reads=0;
  const guard=createPurchaseHumanGate({signal:new AbortController().signal,stage:async()=>{},notify:async()=>{},reveal:async()=>({}),inspectPage:async()=>{if(reads++)throw Error('Navegador fechado');return {kind:'CAPTCHA'};},sleep:async()=>{}});
  await assert.rejects(()=>guard({}),/fechado/);
});
test('browser wall that does not clear is revealed and notified even when page inspection cannot run',async()=>{
  const controller=new AbortController();let focused=0,notified=0,evaluated=0;
  const page={url:()=> 'https://www.mercadolivre.com.br/captcha/wall/logged',evaluate:async()=>{evaluated++;throw Error('execution context blocked');}};
  const guard=createPurchaseHumanGate({wallTimeoutMs:0,signal:controller.signal,stage:async()=>{},reveal:async()=>{focused++;return {focused:true};},notify:async()=>{notified++;controller.abort();},sleep:async()=>{}});
  await assert.rejects(()=>guard(page),/interrompida/);assert.equal(evaluated,0);assert.equal(focused,1);assert.equal(notified,1);
});
test('browser wall clears without notifying or accepting a different destination',async()=>{
  const expected='https://www.mercadolivre.com.br/gz/cart/v2';
  let url='https://www.mercadolivre.com.br/captcha/wall/logged',sleeps=0;
  const guard=createPurchaseHumanGate({signal:new AbortController().signal,stage:async()=>assert.fail('unexpected human pause'),
    inspectPage:async()=>({kind:purchasePageKind(url)}),sleep:async()=>{url=++sleeps===1?'https://www.mercadolivre.com.br/':expected;}});
  assert.deepEqual(await guard({url:()=>url},{expectedDestination:value=>value===expected}),{wallCleared:true});
  assert.equal(sleeps,2);
});
for(const timeout of [false,true])test(`runner switches the same purchase profile from hidden to visible for CAPTCHA (timeout: ${timeout})`,async()=>{
  const events=[];let launches=0,closed=0,focused=0,validations=0,latestProduct;
  const itemUrl='https://www.mercadolivre.com.br/p/MLB123?pdp_filters=item_id:MLB456';
  await assert.rejects(()=>runPurchase({
    order:{items:[{itemId:'MLB456',catalog:'MLB123',sellerId:'1',quantity:1,limitCents:100,url:itemUrl}]},settings:defaults(),projectRoot,dataDirectory:'test',signal:new AbortController().signal,notify:async()=>{},
    htmlReader:async page=>page.content(),
    stage:async(status,message)=>{if(message==='Conferindo anúncios e carrinho no perfil de compra.'&&++validations===2)throw Error('STOP_AFTER_REVALIDATION');},
    launcher:async options=>{
      const index=launches++;assert.equal(options.headless,index===0);events.push('launch'+index);let count=0;
      return {browser:{newPage:async()=>{
        const role=count++?'product':'cart';
        const page={current:'about:blank',url(){return this.current;},async goto(url){this.current=role==='product'&&index===0?'https://www.mercadolivre.com.br/captcha/wall/logged':url;if(role==='product'&&index===0&&timeout)throw Error('Navigation timeout');return {status:()=>200};},content:async()=>'<html><title>Carrinho</title></html>',evaluate:async()=>({complete:true,items:[]})};
        if(role==='product')latestProduct=page;return page;
      },close:async()=>{closed++;events.push('close'+index);}}};
    },
    humanGateFactory:options=>createPurchaseHumanGate({...options,inspectPage:async p=>({kind:purchasePageKind(p.url(),'',p.url().includes('/captcha/'))}),reveal:async()=>{focused++;return {focused:true};},sleep:async()=>{latestProduct.current=itemUrl;}}),
  }),/STOP_AFTER_REVALIDATION/);
  assert.equal(launches,2);assert.equal(focused,1);assert.equal(validations,2);assert.equal(closed,2);assert.deepEqual(events,['launch0','close0','launch1','close1']);
});
