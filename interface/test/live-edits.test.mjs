import test from 'node:test';import assert from'node:assert/strict';
import{mkdtemp,rm,readFile}from'node:fs/promises';import{dirname,join,resolve}from'node:path';import{tmpdir}from'node:os';import{fileURLToPath}from'node:url';
import{MonitoringService}from'../server/service.mjs';import{productInput}from'../server/model.mjs';
const projectRoot = process.env.MONITOR_PROJECT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
async function fixture(fn){const data=await mkdtemp(join(tmpdir(),'vigia-edits-'));const registry={products:[productInput({store:'ml',url:'https://produto.mercadolivre.com.br/MLB-1001-_JM',name:'Original',quantity:1,target:100,alert:true})]};const service=new MonitoringService({registry,save:async()=>{},projectRoot,dataDirectory:data,notifier:async()=>{}});try{await fn(service,registry,data);}finally{await service.close();await rm(data,{recursive:true,force:true});}}
test('edits saved in a running cycle stay pending and merge until the next cycle',()=>fixture(async(s,r)=>{
 s.shops.ml.status='running';const id=r.products[0].id;const first=await s.prepareCycle('ml');
 await s.edit(id,{quantity:3,target:80});await s.edit(id,{name:'Editado'});
 assert.equal(r.products[0].quantity,1);assert.equal(first[0].target,100);assert.equal(s.state().products[0].quantity,3);assert.equal(s.state().products[0].pendingEdit,true);
 const second=await s.prepareCycle('ml');assert.equal(second[0].quantity,3);assert.equal(second[0].target,80);assert.equal(second[0].name,'Editado');assert.equal(s.state().products[0].pendingEdit,false);
}));
test('link changes do not assign an old observation to the new product',()=>fixture(async(s,r)=>{
 s.shops.ml.status='running';const id=r.products[0].id;await s.prepareCycle('ml');await s.edit(id,{url:'https://produto.mercadolivre.com.br/MLB-1002-_JM'});
 s.observe(id,{available:true,price:90,sellerId:'123',observation:'available'});assert.equal(r.products[0].code,'MLB1001');assert.equal(s.state().products[0].code,'MLB1002');assert.equal(s.state().products[0].price,null);
 await s.prepareCycle('ml');assert.equal(r.products[0].code,'MLB1002');assert.equal(r.products[0].lastCheckedAt,null);
}));
test('ML logs preserve every success and failure with the effective cycle rules',()=>fixture(async(s,r,data)=>{
 await s.prepareCycle('ml');const id=r.products[0].id;s.observe(id,{at:'2026-11-06T15:00:00Z',available:true,price:90,sellerId:'123',observation:'available'});s.observe(id,{at:'2026-11-06T15:01:00Z',error:'HTTP 403'});await s.log.flush();
 const rows=(await readFile(join(data,'ml','observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.length,2);assert.equal(rows[0].price,90);assert.equal(rows[0].cycle,1);assert.equal(rows[0].unitLimit,100);assert.equal(rows[1].type,'READ_ERROR');assert.equal(rows[1].error,'HTTP 403');assert.ok(!JSON.stringify(rows).includes('cookie'));
}));
test('edits remain blocked during a purchase and reject invalid quantities',()=>fixture(async(s,r)=>{
 const id=r.products[0].id;s.shops.ml.status='running';await assert.rejects(s.edit(id,{quantity:0}),/Quantidade/);s.purchases.task=Promise.resolve();await assert.rejects(s.edit(id,{quantity:2}),/compra/);s.purchases.task=null;
}));
