import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { allowedQuantity, allocateShipping, validateEconomics, validateCart, candidates, purchaseDefaults, reviewLines, identity, resolveMlPayment } from '../server/purchase-rules.mjs';
import { createCheckoutParser, chooseShipping, validatePix, crc16 } from '../server/purchase-html.mjs';
import { projectCart, readCartInPage } from '../server/purchase-cart.mjs';
import { PurchaseManager } from '../server/purchase-manager.mjs';
import { MonitoringService } from '../server/service.mjs';
import { defaults, validateSettings } from '../server/availability.mjs';
import { notifySystem } from '../server/system-notifications.mjs';
import { checkoutSelectionInPage } from '../server/purchase-clicks.mjs';

const directory=dirname(fileURLToPath(import.meta.url));
const projectRoot=process.env.MONITOR_PROJECT_ROOT??resolve(directory,'../..');
const parser=()=>createCheckoutParser(projectRoot);
function fakePix(cents){
  const tag=(id,value)=>id+Buffer.byteLength(value).toString().padStart(2,'0')+value;
  const payload=tag('00','01')+tag('26',tag('00','br.gov.bcb.pix')+tag('01','teste@example.invalid'))+tag('52','0000')+tag('53','986')+tag('54',(cents/100).toFixed(2))+tag('58','BR')+tag('59','LOJA EXEMPLO')+tag('60','SAO PAULO')+tag('62',tag('05','***'))+'6304';
  return payload+crc16(payload);
}
const product=(n=1)=>({id:'p'+n,store:'ml',code:'MLB'+(1000+n),name:'Product '+n,url:`https://produto.mercadolivre.com.br/MLB-${1000+n}-_JM`,type:'produto',auto:true,alert:true,quantity:3,target:100,price:90,available:true,eligible:true,sellerId:'123',lastCheckedAt:new Date().toISOString(),mlConfirmation:{confirmed:{available:true}}});
const row=(id,q,checked,variationId=null)=>({unique_id:id+(variationId?'_'+variationId:''),metadata:{id,quantity:String(q),...(variationId?{variation_id:variationId}:{})},checkbox:{checked,disabled:false,metadata:{items:[{item_id:id,...(variationId?{variation_id:variationId}:{})}]}},add_to_cart_capability:{cart_status:{item_id:id,quantity:q,display_quantity:q,status:'enabled'}}});

test('final review requires individual multi-item proof and rejects lost proof on recheck',()=>{
  const expected=[{itemId:'MLB1001',quantity:2,sellerId:'123',name:'Produto A',limitCents:10000},{itemId:'MLB1002',quantity:1,sellerId:'123',name:'Produto B',limitCents:10000}];
  const verified=new Map(expected.map(item=>[identity(item),{sellerId:item.sellerId}]));
  const review={lines:expected.map(item=>({...item,unitCents:9000})),titles:['Produto A','Produto B'],subtotalCents:27000};
  assert.equal(reviewLines(review,expected,verified,String).length,2);
  assert.throws(()=>reviewLines({...review,lines:[]},expected,verified,String));
  assert.throws(()=>reviewLines({...review,lines:[review.lines[0],{...review.lines[1],quantity:3}]},expected,verified,String));
  assert.throws(()=>reviewLines({...review,lines:[{...review.lines[0],sellerId:'999'},review.lines[1]]},expected,verified,String));
});
test('single-item review fallback binds exact title and derives price from absolute quantity',()=>{
  const expected=[{itemId:'MLB1001',quantity:2,sellerId:'123',name:'Produto A'}];
  const review={lines:[],titles:['Produto A'],subtotalCents:18000};
  assert.equal(reviewLines(review,expected,new Map(),String)[0].unitCents,9000);
  assert.throws(()=>reviewLines({...review,titles:['Produto B']},expected,new Map(),String));
  assert.throws(()=>reviewLines({...review,subtotalCents:18001},expected,new Map(),String));
});
test('Electron notification uses the CEPO never-expire option and acknowledges actual show',async()=>{
  const source=await readFile(join(directory,'../server/notification-host.cjs'),'utf8');
  let instance,options,ack='',appId;
  const ready=[];
  class Notification extends EventEmitter {static isSupported(){return true;}constructor(value){super();options=value;instance=this;}show(){this.emit('show');}close(){this.emit('close');}}
  const app={setName(){},setAppUserModelId(id){appId=id;},on(){},quit(){},whenReady:()=>({then:fn=>ready.push(fn)})};
  const payload=Buffer.from(JSON.stringify({id:'test-native',title:'Vigia',message:'Teste',url:'http://127.0.0.1:4318/'})).toString('base64url');
  runInNewContext(source,{require:()=>({app,Notification,shell:{openExternal(){}}}),Buffer,URL,process:{argv:['electron','host',payload],stdout:{write:text=>{ack+=text;}}},setInterval:()=>1,clearInterval(){}});
  ready[0]();assert.equal(options.timeoutType,'never');assert.equal(appId,'com.vigia.monitor');assert.equal(ack,'ACK test-native\n');instance.emit('click');
});

test('quantity is capped to confirmed availability, without assuming the UI maximum is stock',()=>{
  assert.equal(allowedQuantity(3,{available:2,maximum:10,minimum:1}),2);
  assert.equal(allowedQuantity(3,{available:20,maximum:2,minimum:1}),2);
  assert.throws(()=>allowedQuantity(3,{available:null,maximum:10,minimum:1}));
  assert.throws(()=>allowedQuantity(3,{available:0,maximum:10,minimum:1}));
});
test('shipping is allocated in exact cents and per-unit limit is checked again after quantity reduction',()=>{
  const lines=[{name:'A',quantity:3,unitCents:9000,limitCents:10000}];
  assert.equal(validateEconomics(lines,2400,{...purchaseDefaults(),includeShipping:true}).totalCents,29400);
  assert.throws(()=>validateEconomics([{...lines[0],quantity:2}],2400,{...purchaseDefaults(),includeShipping:true}),/por unidade/);
  const allocation=allocateShipping([{quantity:1,unitCents:100},{quantity:1,unitCents:100},{quantity:1,unitCents:100}],100);
  assert.deepEqual(allocation,[34,33,33]);assert.equal(allocation.reduce((a,b)=>a+b),100);
});
test('free shipping, total shipping ceiling and unknown shipping are enforced',()=>{
  const lines=[{quantity:1,unitCents:9000,limitCents:10000}];
  assert.throws(()=>validateEconomics(lines,1,{...purchaseDefaults(),freeShippingOnly:true}),/grátis/);
  assert.throws(()=>validateEconomics(lines,101,{...purchaseDefaults(),maxShippingCents:100}),/teto/);
  assert.throws(()=>validateEconomics(lines,null,purchaseDefaults()),/Frete/);
});
test('provided shipping HTML ignores crossed-out prices and chooses fastest among free active options',async()=>{
  const groups=parser().shipping(await readFile(join(directory,'fixtures/shipping.html'),'utf8'),new Date('2026-11-05T15:00:00Z'));
  assert.equal(groups.length,1);assert.equal(groups[0].options.length,4);
  assert.ok(groups[0].options.every(option=>option.cents===0));
  const best=chooseShipping(groups[0].options);assert.match(best.label,/hoje/);assert.equal(best.value,'1663279873');
  assert.throws(()=>chooseShipping([{cents:0,deadline:null,disabled:false}]));
});
test('provided review exposes Pix selection and current totals, with duplicated responsive sections reconciled',async()=>{
  const html=await readFile(join(directory,'fixtures/review.html'),'utf8');const review=parser().review(html);
  assert.equal(review.pix,true);assert.equal(review.subtotalCents,19995);assert.equal(review.shippingCents,0);assert.equal(review.totalCents,19995);assert.equal(review.titles.length,1);
  assert.equal(parser().review(html.replace('value="pix" checked','value="account_money" checked')).pix,false);
});
test('Pix confirmation requires actual code, matching amount, BRL and valid checksum',()=>{
  const code=fakePix(19995);assert.equal(validatePix(code,19995).totalCents,19995);
  assert.throws(()=>validatePix(code,19996),/Valor/);
  assert.throws(()=>validatePix(code.slice(0,-1)+(code.endsWith('0')?'1':'0'),19995),/inválido/);
  const html=`<section data-testid="pix_copy_code_card"><span>${code}</span></section>`;
  assert.equal(parser().pix(html,19995).code,code);
  assert.throws(()=>parser().pix('<h2>Pix</h2>',19995),/não confirmado/);
});
test('cart projector preserves separate variations, absolute quantities and full selection',()=>{
  const body={grouped_items:[{polycards:[row('MLB1001',2,true,'10'),row('MLB1001',1,false,'20')]}],tracking:{items:[{item:{id:'MLB1001',variation_id:'10'},quantity:2,unit_price:90}]}};
  const cart=projectCart(body);assert.equal(cart.complete,true);assert.equal(cart.items.length,2);assert.equal(cart.items[0].unitCents,9000);
  const lines=validateCart(cart,[{itemId:'MLB1001',variationId:'10',quantity:2}]);assert.equal(lines.length,1);
  cart.items[1].checked=true;assert.throws(()=>validateCart(cart,[{itemId:'MLB1001',variationId:'10',quantity:2}]),/a mais/);
  body.grouped_items[0].polycards.push(row('MLB1001',2,true,'10'));assert.equal(projectCart(body).complete,false);
});
test('cart reader uses the authenticated same-origin request and never returns the raw private response',async()=>{
  const body={grouped_items:[],privateAddress:'NOT_FOR_UI'};let options;
  const read=runInNewContext('('+readCartInPage.toString()+')',{location:{origin:'https://www.mercadolivre.com.br'},AbortSignal,fetch:async(url,init)=>{options=init;return {ok:true,text:async()=>JSON.stringify(body)};}});
  const result=await read();assert.equal(result.complete,true);assert.equal(options.credentials,'include');assert.equal(result.privateAddress,undefined);
});
test('candidate selection requires fresh, confirmed, eligible ML products and blocks pending or uncertain orders',()=>{
  const products=[product(1),{...product(2),error:'timeout'},{...product(3),store:'amazon'},{...product(4),lastCheckedAt:'2020-01-01T00:00:00Z'}];
  assert.equal(candidates(products,[],new Set(products.map(p=>p.id))).length,1);
  assert.equal(candidates(products,[{status:'PIX_PENDING',items:[{productId:'p1'}]}],new Set(['p1'])).length,0);
  assert.equal(candidates(products,[{status:'UNCERTAIN',items:[{productId:'p1'}]}],new Set(['p1'])).length,0);
});
test('purchase settings are opt-in and legacy settings migrate without enabling purchases',()=>{
  const old=defaults();delete old.ml.purchase;
  assert.equal(validateSettings(old).ml.purchase.enabled,false);
  const bad=defaults();bad.ml.purchase.maxShippingCents=-1;assert.throws(()=>validateSettings(bad));
});
test('card settings preserve a leading zero and require exactly four digits',()=>{
  const settings=defaults();
  assert.equal(validateSettings(settings).ml.purchase.paymentMethod,'pix');
  settings.ml.purchase.paymentMethod='credit_card';
  assert.throws(()=>validateSettings(settings),/quatro últimos/);
  settings.ml.purchase.cardLastFour='0123';
  assert.equal(validateSettings(settings).ml.purchase.cardLastFour,'0123');
});
test('checkout identifies only one matching credit card and confirms the selected installment',()=>{
  const element=fields=>({getClientRects:()=>[{}],getAttribute:()=>null,closest:()=>null,...fields});
  const radio=(id,text,checked)=>[
    element({id,checked,type:'radio',name:'payment-method-radio-list'}),
    element({htmlFor:id,textContent:text}),
  ];
  const saved=radio('saved','Mastercard terminado em 0123 Até 3x sem juros',true);
  const debit=radio('debit','Cartão de débito terminado em 0123',false);
  const select=element({type:'select-one',value:'2',options:[{value:'1'},{value:'2'}]});
  const rows=[saved,debit];
  const document={querySelectorAll:selector=>{
    if(selector==='input[type="radio"]')return rows.map(row=>row[0]);
    if(selector==='label')return rows.map(row=>row[1]);
    if(selector.startsWith('select[name*="installment"'))return [select];
    return [];
  }};
  const inspect=runInNewContext('('+checkoutSelectionInPage.toString()+')',{document});
  assert.equal(inspect({cardLastFour:'0123',locateCard:true}),saved[1]);
  assert.equal(inspect({cardLastFour:'0123'}).cardInFull,false);
  assert.equal(inspect({cardLastFour:'0123',locateInstallment:true}),select);
  select.value='1';
  assert.equal(inspect({cardLastFour:'0123'}).cardInFull,true);
  rows.push(radio('duplicate','Cartão de crédito terminado em 0123',false));
  assert.equal(inspect({cardLastFour:'0123'}).hasCard,false);
});
test('conditional payment requires a saved card and chooses Pix only with a proven discount',()=>{
  const settings=defaults();
  settings.ml.purchase.paymentMethod='pix_with_discount';
  assert.throws(()=>validateSettings(settings),/quatro últimos/);
  settings.ml.purchase.cardLastFour='0123';
  assert.equal(validateSettings(settings).ml.purchase.cardLastFour,'0123');
  assert.equal(resolveMlPayment('pix_with_discount',1),'pix');
  assert.equal(resolveMlPayment('pix_with_discount',0),'credit_card');
  assert.throws(()=>resolveMlPayment('pix_with_discount',null),/Desconto Pix/);
  assert.equal(resolveMlPayment('pix',0),'pix');
  assert.equal(resolveMlPayment('credit_card',100),'credit_card');
});
test('card approval requires explicit payment evidence at checkout',()=>{
  const url='https://www.mercadolivre.com.br/gz/checkout/congrats';
  assert.equal(parser().cardApproved('<h1>Pagamento aprovado!</h1>',url),true);
  assert.equal(parser().cardApproved('<h1>Compra confirmada</h1><h2>Pagamento em análise</h2>',url),false);
  assert.equal(parser().cardApproved('<h1>Pagamento aprovado!</h1>','https://example.invalid/gz/checkout/congrats'),false);
});

function managerFixture(runner){
  const registry={schemaVersion:1,products:[product(1),product(2)],purchaseOrders:[]};const settings=defaults();settings.ml.purchase.enabled=true;const notifications=[];let saved=0;
  const manager=new PurchaseManager({registry,save:async()=>{saved++;},projectRoot,dataDirectory:'test',getSettings:()=>settings,getProducts:()=>registry.products,getExpectedStores:()=>['amazon','ml'],isPurchaseProfileOpen:()=>false,notify:async notice=>{notifications.push(notice);},runner});
  manager.resetCycles();return {registry,settings,manager,notifications,saved:()=>saved};
}
test('conditional purchase persists the selected payment before finalizing and records its actual outcome',async()=>{
  for(const [discount,payment] of [[500,'pix'],[0,'credit_card']]){
    const f=managerFixture(async({order,stage})=>{
      assert.equal(order.payment,null);
      await stage('CART','Extrato confirmado',{cartEconomics:{pixDiscountCents:discount,couponDiscountCents:250}});
      await stage('FINALIZING','Confirmando',{payment,pixDiscountCents:discount});
      assert.equal(f.registry.purchaseOrders[0].payment,payment);
      return {payment,paid:payment==='credit_card',code:payment==='pix'?fakePix(8500):undefined,totalCents:9000-discount};
    });
    Object.assign(f.settings.ml.purchase,{paymentMethod:'pix_with_discount',cardLastFour:'0123'});
    await f.manager.cycle('amazon');await f.manager.cycle('ml',{ids:['p1']});await f.manager.task;
    assert.equal(f.registry.purchaseOrders[0].status,payment==='pix'?'PIX_PENDING':'CARD_PAID');
  }
});
test('conditional purchase blocks a mismatched checkout before finalization',async()=>{
  const f=managerFixture(async({stage})=>{
    await stage('CART','Extrato confirmado',{cartEconomics:{pixDiscountCents:100}});
    await stage('FINALIZING','Confirmando',{payment:'credit_card'});
    assert.fail('A forma divergente passou pela barreira de finalização.');
  });
  Object.assign(f.settings.ml.purchase,{paymentMethod:'pix_with_discount',cardLastFour:'0123'});
  await f.manager.cycle('amazon');await f.manager.cycle('ml',{ids:['p1']});await f.manager.task;
  assert.equal(f.registry.purchaseOrders[0].status,'BLOCKED');
  assert.match(f.registry.purchaseOrders[0].message,/divergente/);
});
test('approved card order is saved and disarms only its products',async()=>{
  const f=managerFixture(async({order,settings,stage})=>{
    assert.equal(settings.ml.purchase.cardLastFour,'0123');
    await stage('FINALIZING','test');
    return {payment:'credit_card',paid:true,items:order.items,totalCents:9000};
  });
  Object.assign(f.settings.ml.purchase,{paymentMethod:'credit_card',cardLastFour:'0123'});
  await f.manager.cycle('amazon');await f.manager.cycle('ml',{ids:['p1']});await f.manager.task;
  const [order]=f.registry.purchaseOrders;
  assert.equal(order.status,'CARD_PAID');
  assert.equal(order.paid,true);
  assert.equal(order.code,undefined);
  assert.deepEqual(f.registry.products.map(item=>item.auto),[false,true]);
});
test('purchase batch waits for both platform cycles, groups products and prevents repeated orders',async()=>{
  let calls=0;
  const f=managerFixture(async({order,stage})=>{calls++;const items=order.items.map(i=>({...i,quantity:2,unitCents:9000}));await stage('CART','test',{items});await stage('FINALIZING','test');return {payment:'pix',paid:false,code:fakePix(36000),items,totalCents:36000,shippingCents:0};});
  await f.manager.cycle('ml',{ids:['p1','p2']});assert.equal(calls,0);
  await f.manager.cycle('amazon',{ids:['a1']});await f.manager.task;
  assert.equal(calls,1);assert.equal(f.registry.purchaseOrders[0].status,'PIX_PENDING');assert.equal(f.registry.purchaseOrders[0].items.length,2);assert.equal(f.registry.purchaseOrders[0].items[0].quantity,2);assert.ok(f.saved()>2);
  await f.manager.cycle('ml',{ids:['p1','p2']});await f.manager.cycle('amazon',{ids:['a1']});assert.equal(calls,1);
  assert.equal(f.notifications.length,2);
  assert.equal(f.notifications[0].title,'Vigia · compra iniciada');assert.equal(f.notifications[1].title,'Vigia · Pix gerado');
  assert.ok(f.registry.products.every(p=>p.auto===false));
});
test('confirmed Pix saves automatic purchase off for only the bought products before notifying and cannot loop after review',async()=>{
  let calls=0;const snapshots=[];
  const f=managerFixture(async({order})=>{calls++;return {payment:'pix',paid:false,code:fakePix(36000),items:order.items.map(i=>({...i,quantity:2,unitCents:9000})),totalCents:36000,orderReferences:['order:2000000002']};});
  f.registry.products.push(product(3));
  f.manager.save=async registry=>{snapshots.push(structuredClone(registry));};
  f.manager.verifyHistory=async({store,references})=>{
    assert.equal(store,'ml');
    assert.deepEqual(references,['order:2000000002']);
    assert.equal(snapshots.at(-1).purchaseOrders[0].status,'PIX_PENDING');
    assert.deepEqual(snapshots.at(-1).purchaseOrders[0].historyVerification,{status:'PENDING'});
    throw new Error('Histórico temporariamente indisponível.');
  };
  f.manager.notify=async notice=>{
    if(notice.title==='Vigia · Pix gerado'){
      const saved=snapshots.at(-1);assert.equal(saved.purchaseOrders[0].status,'PIX_PENDING');
      assert.deepEqual(saved.products.map(p=>p.auto),[false,false,true]);
      assert.ok(saved.products.every(p=>p.alert===true));
    }
  };
  await f.manager.cycle('amazon');await f.manager.cycle('ml',{ids:['p1','p2']});await f.manager.task;
  assert.deepEqual(f.registry.products.map(p=>p.auto),[false,false,true]);assert.ok(f.registry.purchaseOrders[0].autoDisabledAt);
  assert.equal(f.registry.purchaseOrders[0].status,'PIX_PENDING');
  assert.equal(f.registry.purchaseOrders[0].historyVerification.status,'UNAVAILABLE');
  await f.manager.resolve(f.registry.purchaseOrders[0].id);
  await f.manager.cycle('amazon');await f.manager.cycle('ml',{ids:['p1','p2']});assert.equal(calls,1);
});
test('legacy pending Pix disables only its own products on recovery',()=>{
  const f=managerFixture(async()=>{});
  f.registry.purchaseOrders.push({id:'pending',status:'PIX_PENDING',items:[{productId:'p1'}]});
  const recovered=new PurchaseManager({...f.manager,registry:f.registry});
  assert.deepEqual(f.registry.products.map(p=>p.auto),[false,true]);assert.equal(recovered.recoveredChanges,true);assert.ok(f.registry.purchaseOrders[0].autoDisabledAt);
});
test('uncertain finalization is persisted and never automatically repeated after restart',async()=>{
  const f=managerFixture(async({stage})=>{await stage('FINALIZING','test');throw new Error('Response lost');});
  await f.manager.cycle('amazon');await f.manager.cycle('ml',{ids:['p1','p2']});await f.manager.task;
  assert.equal(f.registry.purchaseOrders[0].status,'UNCERTAIN');
  assert.ok(f.registry.products.every(p=>p.auto===true));
  await f.manager.cycle('amazon');await f.manager.cycle('ml',{ids:['p1','p2']});assert.equal(f.registry.purchaseOrders.length,1);
  await f.manager.resolve(f.registry.purchaseOrders[0].id);assert.ok(f.registry.products.every(p=>p.auto===false));
});
test('interrupted persisted jobs are held for manual review rather than resumed',()=>{
  const f=managerFixture(async()=>{});f.registry.purchaseOrders.push({id:'old',status:'FINALIZING',items:[{productId:'p1'}]});
  new PurchaseManager({...f.manager,registry:f.registry});assert.equal(f.registry.purchaseOrders[0].status,'UNCERTAIN');
});
test('human pause preserves uncertain-finalization protection and records its history',async()=>{
  const f=managerFixture(async({stage,notify})=>{await stage('FINALIZING','test');await stage('WAITING_HUMAN','captcha',{human:{kind:'CAPTCHA'}});await notify({id:'human-test',title:'CAPTCHA',message:'test'});throw Error('browser closed');});
  await f.manager.cycle('amazon');await f.manager.cycle('ml',{ids:['p1','p2']});await f.manager.task;
  const order=f.registry.purchaseOrders[0];assert.equal(order.status,'UNCERTAIN');assert.equal(order.human,null);assert.equal(order.history.at(-1).status,'WAITING_HUMAN');assert.equal(f.notifications[1].id,'human-test');
});
test('restarting while waiting for a human never auto-resumes the saved purchase',()=>{
  const f=managerFixture(async()=>{});f.registry.purchaseOrders.push({id:'paused',status:'WAITING_HUMAN',human:{kind:'CAPTCHA'},items:[{productId:'p1'}]});
  new PurchaseManager({...f.manager,registry:f.registry});assert.equal(f.registry.purchaseOrders[0].status,'UNCERTAIN');assert.equal(f.registry.purchaseOrders[0].human,null);
});
test('availability alerts notify the operating system once per confirmed transition, without the browser',async()=>{
  const p={...product(1),store:'amazon',alert:true};const registry={products:[p]};const notices=[];
  const service=new MonitoringService({registry,save:async()=>{},projectRoot,dataDirectory:'test',notifier:async n=>notices.push(n)});
  const observed={available:true,price:90,seller:'Amazon.com.br'};
  service.observe(p.id,observed);assert.equal(notices.length,0);service.observe(p.id,observed);await service.notificationQueue;assert.equal(notices.length,1);
  service.observe(p.id,observed);service.observe(p.id,{error:'timeout'});service.observe(p.id,observed);service.observe(p.id,observed);await service.notificationQueue;assert.equal(notices.length,1);
  service.observe(p.id,{available:false});service.observe(p.id,{available:false});service.observe(p.id,observed);service.observe(p.id,observed);await service.notificationQueue;assert.equal(notices.length,2);
  assert.equal(registry.notificationOutbox[0].status,'SENT');await service.close();
});
test('native notification payload uses direct Electron arguments without shell interpolation',async()=>{
  let argumentsList,payload;
  await notifySystem({title:'Vigia',message:'Literal $(test) `text`'},{platform:'win32',spawnImpl:(exe,args,options)=>{
    assert.ok(exe.endsWith('electron.exe'));assert.equal(options.windowsHide,true);assert.equal(options.env.ELECTRON_RUN_AS_NODE,undefined);argumentsList=args;
    const child=new EventEmitter();child.stdout=new EventEmitter();payload=JSON.parse(Buffer.from(args[1],'base64url').toString('utf8'));queueMicrotask(()=>child.stdout.emit('data',Buffer.from('ACK '+payload.id+'\n')));child.kill=()=>{};return child;
  }});
  assert.equal(payload.message,'Literal $(test) `text`');assert.ok(!argumentsList.some(a=>a.includes('Literal')));
});
