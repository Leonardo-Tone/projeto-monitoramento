import { readFile, stat, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { processOwnerAlive } from './process-owner.mjs';

const recoveries=new Map();
function processAlive(pid,recordedAtMs){
  try{return processOwnerAlive(pid,recordedAtMs);}
  catch(error){throw new Error('Não foi possível confirmar o dono da trava Amazon; o arquivo foi preservado.',{cause:error});}
}
export function recoverAbandonedAmazonLock(dataDirectory,{isAlive=processAlive,pid=process.pid}={}){
  const path=resolve(dataDirectory,'amazon','monitor.lock');
  const previous=recoveries.get(path)??Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{
    let text,identity;
    try{text=await readFile(path,'utf8');identity=await stat(path);}
    catch(error){if(error.code==='ENOENT')return {recovered:false};throw error;}
    let owner;try{owner=JSON.parse(text);}catch{throw new Error('Registro da execução Amazon inválido. O arquivo foi preservado para análise.');}
    if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw new Error('Dono da execução Amazon não identificado. O arquivo foi preservado.');
    if(isAlive(owner.pid,identity.mtimeMs))return {recovered:false,activePid:owner.pid};
    // Only the service that owns this registry may recover its Amazon lock.
    // This outer exclusive lock serializes recovery across different processes;
    // the map above serializes concurrent attempts inside the same process.
    const serviceOwner=Number(await readFile(join(dataDirectory,'service.lock'),'utf8').catch(()=>''));
    if(serviceOwner!==pid)throw new Error('A recuperação da Amazon exige a instância exclusiva do painel. A trava foi preservada.');
    const current=await stat(path),fresh=await readFile(path,'utf8');
    if(fresh!==text||current.ino!==identity.ino||current.dev!==identity.dev||current.mtimeMs!==identity.mtimeMs||isAlive(owner.pid,current.mtimeMs))throw new Error('A execução Amazon mudou durante a conferência; a trava foi preservada.');
    const archive=join(dataDirectory,'amazon',`monitor.lock.abandoned-${owner.pid}-${randomUUID()}.json`);
    await rename(path,archive);
    return {recovered:true,oldPid:owner.pid,archive};
  });
  recoveries.set(path,task);
  void task.finally(()=>{if(recoveries.get(path)===task)recoveries.delete(path);}).catch(()=>{});
  return task;
}
