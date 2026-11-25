import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,readdir,rm } from 'node:fs/promises';
import {tmpdir}from'node:os';import{join}from'node:path';
import{recoverAbandonedAmazonLock}from'../server/amazon-lock.mjs';
import{createApplication}from'../server.mjs';
import{spawn}from'node:child_process';import{once}from'node:events';
import{startAmazon}from'../server/adapters.mjs';import{productInput}from'../server/model.mjs';
import { processOwnerAlive } from '../server/process-owner.mjs';
import { lockService } from '../server/storage.mjs';

test('Windows recovers locks from before reboot while preserving same-boot locks when probing is denied',()=>fixture(async(data,path)=>{
  const denied=()=>{throw Object.assign(new Error('kill EPERM'),{code:'EPERM'});};
  const isAlive=(pid,recordedAtMs)=>processOwnerAlive(pid,recordedAtMs,{
    platform:'win32',bootTimeMs:Date.now()+60000,probe:denied,
  });
  await assert.rejects(lockService(data,{isAlive:(pid,recordedAtMs)=>processOwnerAlive(pid,recordedAtMs,{
    platform:'win32',bootTimeMs:Date.now()-60000,probe:denied,
  })}),/trava do painel foi preservada/);
  await writeFile(join(data,'service.lock'),'2772');
  await writeFile(path,JSON.stringify({pid:2772}));
  const unlock=await lockService(data,{isAlive});
  try{
    assert.equal(await readFile(join(data,'service.lock'),'utf8'),String(process.pid));
    assert.equal((await recoverAbandonedAmazonLock(data,{isAlive})).recovered,true);
  }finally{await unlock();}
}));

async function fixture(fn){
  const data=await mkdtemp(join(tmpdir(),'vigia-amazon-lock-'));
  try{await mkdir(join(data,'amazon'));await writeFile(join(data,'service.lock'),String(process.pid));await fn(data,join(data,'amazon','monitor.lock'));}
  finally{await rm(data,{recursive:true,force:true});}
}
test('Amazon recovers only a proven dead owner and preserves its lock record and all monitor data',()=>fixture(async(data,path)=>{
  const owner={pid:999,startedAt:'2026-11-05T19:54:18Z'},state='{"schemaVersion":1,"products":{"ASIN":{"price":123}}}';
  await writeFile(path,JSON.stringify(owner));await writeFile(join(data,'amazon','state.json'),state);await writeFile(join(data,'amazon','events.jsonl'),'history\n');
  const recovery=await recoverAbandonedAmazonLock(data,{isAlive:()=>false});assert.equal(recovery.recovered,true);assert.equal(recovery.oldPid,999);
  assert.deepEqual(JSON.parse(await readFile(recovery.archive,'utf8')),owner);await assert.rejects(readFile(path),{code:'ENOENT'});
  assert.equal(await readFile(join(data,'amazon','state.json'),'utf8'),state);assert.equal(await readFile(join(data,'amazon','events.jsonl'),'utf8'),'history\n');
}));
test('a live owner is never displaced',()=>fixture(async(data,path)=>{
  const value=JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()});await writeFile(path,value);
  assert.equal((await recoverAbandonedAmazonLock(data)).recovered,false);assert.equal(await readFile(path,'utf8'),value);
}));
test('unknown owner and invalid lock are preserved for review',()=>fixture(async(data,path)=>{
  await writeFile(path,'invalid');await assert.rejects(recoverAbandonedAmazonLock(data),/preservado/);assert.equal(await readFile(path,'utf8'),'invalid');
  await writeFile(path,JSON.stringify({pid:999}));await assert.rejects(recoverAbandonedAmazonLock(data,{isAlive:()=>{throw Error('EPERM');}}),/EPERM/);assert.equal(JSON.parse(await readFile(path,'utf8')).pid,999);
}));
test('recovery requires ownership of the service lock, not just an apparently dead Amazon PID',()=>fixture(async(data,path)=>{
  await writeFile(path,JSON.stringify({pid:999}));await writeFile(join(data,'service.lock'),'123');
  await assert.rejects(recoverAbandonedAmazonLock(data,{isAlive:()=>false}),/instância exclusiva/);assert.equal(JSON.parse(await readFile(path,'utf8')).pid,999);
}));
test('concurrent recovery calls archive the stale lock exactly once',()=>fixture(async(data,path)=>{
  await writeFile(path,JSON.stringify({pid:999}));const results=await Promise.all([recoverAbandonedAmazonLock(data,{isAlive:()=>false}),recoverAbandonedAmazonLock(data,{isAlive:()=>false})]);
  assert.equal(results.filter(r=>r.recovered).length,1);assert.equal((await readdir(join(data,'amazon'))).filter(name=>name.includes('abandoned')).length,1);
}));
test('startup repairs an abandoned Amazon lock before the monitor starts',async()=>{
  const data=await mkdtemp(join(tmpdir(),'vigia-amazon-restart-'));let app;
  try{
    const child=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true});await once(child,'exit');
    await mkdir(join(data,'amazon'));await writeFile(join(data,'amazon','monitor.lock'),JSON.stringify({pid:child.pid,startedAt:new Date().toISOString()}));
    app=await createApplication({dataDirectory:data,notifier:async()=>{}});
    assert.equal(app.service.state().shops.amazon.status,'stopped');assert.match(app.service.state().shops.amazon.message,/recuperado/);await assert.rejects(readFile(join(data,'amazon','monitor.lock')),{code:'ENOENT'});
    assert.equal((await readdir(join(data,'amazon'))).filter(name=>name.includes('abandoned')).length,1);
  }finally{if(app)await app.close();await rm(data,{recursive:true,force:true});}
});
test('Amazon adapter recovers after an interrupted process and releases its lock on successive stops',()=>fixture(async(data,path)=>{
  const child=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true});await once(child,'exit');await writeFile(path,JSON.stringify({pid:child.pid,startedAt:new Date().toISOString()}));
  const product=productInput({store:'amazon',name:'Produto de teste',url:'https://www.amazon.com.br/dp/B000GAYQJ0'});let reads=0;
  for(let attempt=0;attempt<2;attempt++){
    const controller=new AbortController();
    await startAmazon({projectRoot:process.env.MONITOR_PROJECT_ROOT,dataDirectory:data,products:[product],signal:controller.signal,onResult:()=>{reads++;},onEvent:()=>{},onStatus:()=>{},onCycle:()=>controller.abort(),consultar:async()=>({totalInformado:1,totalLista:1,totalVisivel:1,cobertura:'PRIMEIRA_PAGINA_COMPLETA',ofertas:[{sellerId:'AMAZON',categoria:'AMAZON_DIRETA',vendedor:'Amazon.com.br',enviadoPor:'Amazon',precoNormalCentavos:8990,freteCentavos:0,minQty:1,maxQty:2}]})});
    await assert.rejects(readFile(path),{code:'ENOENT'});
  }
  assert.equal(reads,2);assert.equal((await readdir(join(data,'amazon'))).filter(name=>name.includes('abandoned')).length,1);
}));
