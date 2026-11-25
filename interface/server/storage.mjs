import { mkdir, readFile, writeFile, rename, open, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { processOwnerAlive } from './process-owner.mjs';

export async function loadRegistry(directory) {
  await mkdir(directory,{recursive:true});
  try {
    const registry=JSON.parse(await readFile(join(directory,'registry.json'),'utf8'));
    if(registry.schemaVersion!==1||!Array.isArray(registry.products)) throw new Error('Formato do cadastro incompatível.');
    return registry;
  } catch(e) {if(e.code==='ENOENT') return {schemaVersion:1,products:[]};throw e;}
}
export function registryWriter(directory) {
  let queue=Promise.resolve();
  return registry=>{
    const serialized=JSON.stringify(registry,null,2);
    const work=async()=>{
      const temporary=join(directory,`registry.tmp-${randomUUID()}`);
      try { await writeFile(temporary,serialized,'utf8');await rename(temporary,join(directory,'registry.json')); }
      finally {await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    };
    const pending=queue.then(work);queue=pending.catch(()=>{});return pending;
  };
}
export async function lockService(directory,{isAlive=processOwnerAlive}={}) {
  await mkdir(directory,{recursive:true});
  const path=join(directory,'service.lock');
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const lock=await open(path,'wx');await lock.writeFile(String(process.pid));
      return async()=>{await lock.close();await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});};
    } catch(e) {
      if(e.code!=='EEXIST')throw e;
      const identity=await stat(path);
      const contents=await readFile(path,'utf8');
      const pid=Number(contents);
      if(!Number.isInteger(pid)||pid<=0)throw new Error('Lock inválido. Verifique se outra instância está aberta.');
      let alive;
      try {alive=isAlive(pid,identity.mtimeMs);}
      catch(error) {
        if(error.code!=='EPERM')throw error;
        throw new Error(`O Windows não permitiu verificar o processo ${pid} do Vigia. A trava do painel foi preservada.`,{cause:error});
      }
      if(alive)throw new Error('O painel já está aberto em outro processo.');
      const current=await stat(path);
      if(current.ino!==identity.ino||current.dev!==identity.dev||current.mtimeMs!==identity.mtimeMs||await readFile(path,'utf8')!==contents)
        throw new Error('A trava do painel mudou durante a conferência. Abra o painel novamente.');
      await unlink(path);
    }
  }
  throw new Error('Não foi possível reservar a instância do painel.');
}
