import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{MonitoringService}from'../server/service.mjs';import{productInput}from'../server/model.mjs';
test('already confirmed available products seed history after two fresh readings, without repeating alerts',async()=>{
 const data=await mkdtemp(join(tmpdir(),'vigia-history-baseline-'));let service;
 try{const product=productInput({store:'ml',name:'Produto',url:'https://produto.mercadolivre.com.br/MLB-1001-_JM',alert:true});product.mlConfirmation={confirmed:{available:true,withinTarget:false,seller:'123'},pending:null,count:0};
 const registry={products:[product]};let notifications=0;service=new MonitoringService({registry,save:async()=>{},dataDirectory:data,projectRoot:process.env.MONITOR_PROJECT_ROOT,notifier:async()=>{notifications++;}});
 const observation={available:true,price:90,sellerId:'123',observation:'available'};
 service.observe(product.id,observation);assert.equal(registry.availabilityHistory.length,0);service.observe(product.id,observation);assert.equal(registry.availabilityHistory.length,1);assert.equal(registry.availabilityHistory[0].type,'PRIMEIRA_OBSERVACAO_DISPONIVEL');
 service.observe(product.id,observation);await service.notificationQueue;assert.equal(registry.availabilityHistory.length,1);assert.equal(notifications,0);
 }finally{if(service)await service.close();await rm(data,{recursive:true,force:true});}
});
test('history captures eligible availability even without alerts, remains immutable and does not duplicate steady reads',async()=>{
 const data=await mkdtemp(join(tmpdir(),'vigia-history-'));let service;
 try{
 const product=productInput({store:'ml',name:'Produto',url:'https://produto.mercadolivre.com.br/MLB-1001-_JM',target:100,quantity:2,alert:false});const registry={products:[product]};service=new MonitoringService({registry,save:async()=>{},dataDirectory:data,projectRoot:process.env.MONITOR_PROJECT_ROOT,notifier:async()=>{}});
 const observation={available:true,price:90,seller:'Loja',sellerId:'123',delivery:'Mercado Envios Full',reputationLevel:'5_green',powerSellerStatus:'platinum',observation:'available'};
 service.observe(product.id,observation);assert.equal(registry.availabilityHistory.length,0);service.observe(product.id,observation);assert.equal(registry.availabilityHistory.length,1);
 const saved=structuredClone(registry.availabilityHistory[0]);service.observe(product.id,{...observation,price:95});assert.equal(registry.availabilityHistory.length,1);
 await service.edit(product.id,{target:200,quantity:3});service.settings.ml.requireLeader=true;assert.deepEqual(registry.availabilityHistory[0],saved);assert.equal(saved.product.price,90);assert.equal(saved.product.quantity,2);assert.equal(saved.filters.requireLeader,false);assert.equal(saved.product.seller,'Loja');
 }finally{if(service)await service.close();await rm(data,{recursive:true,force:true});}
});
test('outside-filter offers never create availability history',async()=>{
 const data=await mkdtemp(join(tmpdir(),'vigia-history-'));let service;
 try{const product=productInput({store:'amazon',name:'Produto',url:'https://www.amazon.com.br/dp/B000GAYQJ0'});const registry={products:[product]};service=new MonitoringService({registry,save:async()=>{},dataDirectory:data,projectRoot:process.env.MONITOR_PROJECT_ROOT,notifier:async()=>{}});service.settings.amazon.onlyAmazon=true;
 for(let i=0;i<3;i++)service.observe(product.id,{available:true,price:10,eligible:false,amazonOffers:[],observation:'OFERTA_VISIVEL'});assert.equal(registry.availabilityHistory.length,0);
 }finally{if(service)await service.close();await rm(data,{recursive:true,force:true});}
});
