import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PurchaseSession } from '../server/purchase-session.mjs';
import { closeOwnedBrowser } from '../server/browser-cleanup.mjs';
import { readPurchaseHtml } from '../server/purchase-dom.mjs';
import { clickPurchaseControl,continueCartByClick } from '../server/purchase-clicks.mjs';

test('session starts headless and reopens the same purchase profile visibly only for human intervention',async()=>{
  const launches=[],events=[];
  const session=new PurchaseSession({projectRoot:'project',dataDirectory:'data',launcher:async options=>{
    const index=launches.length;launches.push(options);events.push('launch'+index);
    return {browser:{newPage:async()=>({current:'about:blank',url(){return this.current;},goto:async function(url){events.push(['GET',url]);this.current=url;}}),close:async()=>events.push('close'+index)}};
  }});
  await session.start();assert.equal(session.headless,true);assert.equal(launches.length,1);
  session.cartPage.current='https://www.mercadolivre.com.br/captcha/wall/logged?resume=order-confirmation';
  const visible=await session.showHuman(session.cartPage);
  assert.equal(visible,session.cartPage);assert.equal(session.headless,false);assert.equal(launches.length,2);
  assert.deepEqual(launches.map(o=>[o.purpose,o.headless,o.dataDirectory]),[['purchase',true,'data'],['purchase',false,'data']]);
  assert.ok(events.indexOf('close0')<events.indexOf('launch1'));
  assert.equal(await session.showHuman(visible),visible);assert.equal(launches.length,2);
  await session.close();assert.equal(events.at(-1),'close1');
  assert.equal(events.filter(e=>Array.isArray(e)&&e[0]==='GET').length,1);
});
test('cleanup force-closes only the exact owned process if graceful browser close fails',async()=>{
  let kills=0;const child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.kill=()=>{kills++;child.exitCode=0;return true;};
  await closeOwnedBrowser({process:()=>child,close:async()=>{throw Error('disconnected');}});
  assert.equal(kills,1);
});
test('cleanup handles an unresponsive close without leaving the owned Chrome process running',async()=>{
  const child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.kill=()=>{child.exitCode=0;return true;};
  await closeOwnedBrowser({process:()=>child,close:()=>new Promise(()=>{})},{timeoutMs:10});assert.equal(child.exitCode,0);
});
test('cleanup never attempts a broad Chrome kill when no owned process handle exists',async()=>{
  await assert.rejects(()=>closeOwnedBrowser({close:async()=>{throw Error('disconnected');}}),/disconnected/);
});
test('HTML snapshots use CDP DOM reads and never evaluate page scripts',async()=>{
  const calls=[];const page={once(){},target:()=>({createCDPSession:async()=>({send:async(method,args)=>{calls.push([method,args]);if(method==='DOM.getDocument')return {root:{nodeId:3}};return {outerHTML:'<html><body>checkout</body></html>'};}})}),evaluate(){throw Error('Runtime must not be used');}};
  assert.equal(await readPurchaseHtml(page),'<html><body>checkout</body></html>');assert.deepEqual(calls.map(c=>c[0]),['DOM.getDocument','DOM.getOuterHTML']);
});
test('physical click requires an element, disposes its handle and never falls back to DOM click',async()=>{
  const events=[];const page={bringToFront:async()=>events.push('activate-tab'),evaluateHandle:async()=>({asElement:()=>({click:async()=>events.push('puppeteer-click')}),dispose:async()=>events.push('dispose')})};
  await clickPurchaseControl(page,()=>null,{}, {check:async()=>events.push('check'),beforeClick:async()=>events.push('persist')});
  assert.deepEqual(events,['check','activate-tab','persist','puppeteer-click','dispose']);
  page.evaluateHandle=async()=>({asElement:()=>null,dispose:async()=>events.push('dispose-empty')});
  await assert.rejects(()=>clickPurchaseControl(page,()=>null,{}),/única/);assert.equal(events.at(-1),'dispose-empty');
});
test('Continue installs navigation listener before one physical click and does not navigate by href',async()=>{
  const events=[];let location='https://www.mercadolivre.com.br/gz/cart/v2',resolveNavigation;
  const page={bringToFront:async()=>{},url:()=>location,waitForNavigation:()=>{events.push('listen');return new Promise(resolve=>{resolveNavigation=resolve;});},goto:()=>{throw Error('Direct navigation prohibited');},evaluateHandle:async()=>({asElement:()=>({click:async()=>{events.push('click');location='https://www.mercadolivre.com.br/gz/checkout/cart/buy';resolveNavigation({status:()=>200});}}),dispose:async()=>{}})};
  await continueCartByClick(page,'https://www.mercadolivre.com.br/gz/checkout/cart/buy?items=MLB1-Q1');assert.deepEqual(events,['listen','click']);
});
