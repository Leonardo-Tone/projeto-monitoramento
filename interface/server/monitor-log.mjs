import{mkdir,open}from'node:fs/promises';import{join}from'node:path';
export class MonitorLog{
 constructor(dataDirectory,scope='ml'){this.directory=join(dataDirectory,scope);this.queue=Promise.resolve();}
 append(file,row){const task=this.queue.then(async()=>{await mkdir(this.directory,{recursive:true});const handle=await open(join(this.directory,file),'a');try{await handle.writeFile(JSON.stringify(row)+'\n');await handle.sync();}finally{await handle.close();}});this.queue=task.catch(()=>{});return task;}
 observation(product,result,{runId,cycle}={}){return this.append('observations.jsonl',{schemaVersion:1,type:result.error?'READ_ERROR':'OBSERVATION',runId,cycle,at:result.at??new Date().toISOString(),productId:product.id,itemId:product.code,price:result.price??null,available:result.available??null,sellerId:result.sellerId??null,delivery:result.delivery??null,eligible:result.eligible??null,error:result.error??null,quantity:product.quantity??1,unitLimit:product.target??null});}
 event(type,details={}){return this.append('events.jsonl',{schemaVersion:1,type,at:new Date().toISOString(),...details});}
 flush(){return this.queue;}
}
