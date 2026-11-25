import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { MonitoringGate } from '../server/monitoring-gate.mjs';
import { MonitoringService } from '../server/service.mjs';
import { defaults } from '../server/availability.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('purchase pause drains in-flight reads and prevents new reads on both platforms until release',async()=>{
  const gate=new MonitoringGate(),signal=new AbortController().signal,finish=deferred(),entered=deferred();
  const first=gate.run(signal,async()=>{entered.resolve();await finish.promise;});await entered.promise;
  let pauseReady=false,reads=0;
  const pause=gate.pause(signal).then(resume=>{pauseReady=true;return resume;});
  const second=gate.run(signal,async()=>{reads++;});const third=gate.run(signal,async()=>{reads++;});
  await tick();assert.equal(pauseReady,false);assert.equal(reads,0);
  finish.resolve();await first;const resume=await pause;assert.equal(reads,0);assert.equal(gate.active,0);
  resume();await Promise.all([second,third]);assert.equal(reads,2);assert.equal(gate.paused,false);
});
test('aborting a monitor cancels its blocked read without starting its network operation',async()=>{
  const gate=new MonitoringGate(),controller=new AbortController();const resume=await gate.pause(new AbortController().signal);
  let called=false;const task=gate.run(controller.signal,async()=>{called=true;});controller.abort();
  await assert.rejects(task,/interrompido/);assert.equal(called,false);resume();assert.equal(gate.events.listenerCount('changed'),0);
});
test('aborting purchase while draining releases the monitoring gate',async()=>{
  const gate=new MonitoringGate(),controller=new AbortController(),finish=deferred();
  const read=gate.run(new AbortController().signal,()=>finish.promise);const pause=gate.pause(controller.signal);controller.abort();
  await assert.rejects(pause,/interrompido/);assert.equal(gate.paused,false);finish.resolve();await read;
});
async function servicePauseFixture(fail=false){
  const next=deferred(),started=deferred(),finish=deferred(),readAgain=deferred();let reads=0;
  const settings=defaults();settings.ml.purchase.enabled=true;
  const registry={products:[{id:'ml1',store:'ml',code:'MLB123',url:'https://produto.mercadolivre.com.br/MLB-123-_JM',name:'Produto',quantity:1,target:100,price:90,sellerId:'1',auto:true,available:true,lastCheckedAt:new Date().toISOString(),mlConfirmation:{confirmed:{available:true}}},{id:'am1',store:'amazon',code:'B000000001',name:'Amazon',auto:false}],settings};
  const adapter=store=>async({withMonitoringRead,onCycle,signal,onStatus})=>{
    onStatus('running','test');await withMonitoringRead(async()=>{reads++;});onCycle({ids:[store==='ml'?'ml1':'am1'],ok:true});
    await next.promise;await withMonitoringRead(async()=>{reads++;if(reads===4)readAgain.resolve();});
    if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  };
  const service=new MonitoringService({registry,save:async()=>{},projectRoot:'test',dataDirectory:'test',adapters:{amazon:adapter('amazon'),ml:adapter('ml')},notifier:async()=>{},purchaseRunner:async({order,stage})=>{
    assert.equal(service.monitorGate.active,0);assert.equal(service.monitorGate.paused,true);
    await stage('WAITING_HUMAN','captcha',{human:{kind:'CAPTCHA'}});started.resolve();await finish.promise;
    if(fail)throw Error('test failure');return {payment:'pix',paid:false,code:'fake-test-only',items:order.items,totalCents:9000};
  }});
  service.start();await started.promise;return {service,next,finish,readAgain,reads:()=>reads};
}
test('both real service adapters remain paused during human intervention and resume after Pix preparation',async()=>{
  const f=await servicePauseFixture();
  try{
    f.next.resolve();await tick();assert.equal(f.reads(),2);
    const state=f.service.state();assert.equal(state.monitoringPaused,true);assert.equal(state.shops.amazon.status,'paused');assert.equal(state.shops.ml.status,'paused');
    f.finish.resolve();await f.service.purchases.task;await f.readAgain.promise;
    assert.equal(f.reads(),4);assert.equal(f.service.state().monitoringPaused,false);
  }finally{f.next.resolve();f.finish.resolve();await f.service.close();}
});
test('a failed purchase also releases both monitors',async()=>{
  const f=await servicePauseFixture(true);
  try{f.next.resolve();await tick();assert.equal(f.reads(),2);f.finish.resolve();await f.service.purchases.task;await f.readAgain.promise;assert.equal(f.service.registry.purchaseOrders[0].status,'BLOCKED');assert.equal(f.reads(),4);}
  finally{f.next.resolve();f.finish.resolve();await f.service.close();}
});
