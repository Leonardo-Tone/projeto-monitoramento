import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadRegistry, registryWriter, lockService } from './server/storage.mjs';
import { productInput } from './server/model.mjs';
import { MonitoringService } from './server/service.mjs';
import { recoverAbandonedAmazonLock } from './server/amazon-lock.mjs';
import { apiVersion } from './panel-api.mjs';

const directory=dirname(fileURLToPath(import.meta.url));
const projectRoot=resolve(process.env.MONITOR_PROJECT_ROOT??join(directory,'..'));
const defaultData=join(directory,'.data');
export async function createApplication({dataDirectory=defaultData,adapters,referenceProducts,root=projectRoot,loginOpener,notifier,purchaseRunner}={}) {
  const unlock=await lockService(dataDirectory);
  try {
    const registry=await loadRegistry(dataDirectory);
    const ids=new Set();const identities=new Set();const counts={amazon:0,ml:0};
    for(const p of registry.products){
      const validated=productInput(p,p);const key=validated.store+':'+validated.code;
      if(typeof p.id!=='string'||ids.has(p.id)||identities.has(key)||++counts[p.store]>10)throw new Error('Cadastro persistido inválido. Os arquivos foram preservados.');
      ids.add(p.id);identities.add(key);
    }
    const save=registryWriter(dataDirectory);
    const service=new MonitoringService({registry,save,projectRoot:root,dataDirectory,adapters,loginOpener,notifier,purchaseRunner});
    try{
      const recovery=await recoverAbandonedAmazonLock(dataDirectory);
      if(recovery.recovered)service.shops.amazon.message='Registro antigo recuperado. Amazon pronta para monitorar.';
    }catch(error){service.shops.amazon={status:'error',message:error.message};}
    if(service.purchases.recoveredChanges)await save(registry);
    const token=randomBytes(32).toString('hex');
    let mutationQueue=Promise.resolve();
    const staticFiles=new Map([['/','index.html'],['/index.html','index.html'],['/styles.css','styles.css'],['/app.js','app.js'],['/cards.js','cards.js']]);
    const server=createServer(async(req,res)=>{
      const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
      try {
        const expectedHost=`127.0.0.1:${server.address().port}`;
        if(req.headers.host!==expectedHost)return json(403,{error:'Host não permitido.'});
        const origin=`http://${expectedHost}`;
        if((req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site')return json(403,{error:'Origem não permitida.'});
        res.setHeader('X-Content-Type-Options','nosniff');
        res.setHeader('Referrer-Policy','no-referrer');
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://m.media-amazon.com https://images-na.ssl-images-amazon.com https://http2.mlstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const url=new URL(req.url,origin);
        if(req.method==='GET'&&url.pathname==='/api/state')return json(200,{...service.state(),token,apiVersion});
        if(req.method==='GET'&&url.pathname==='/api/availability-history')return json(200,{entries:service.registry.availabilityHistory.filter(row=>!url.searchParams.get('productId')||row.productId===url.searchParams.get('productId')).slice().reverse()});
        if(req.method==='GET'&&staticFiles.has(url.pathname)){
          const file=staticFiles.get(url.pathname);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(await readFile(join(directory,file)));return;
        }
        if(!url.pathname.startsWith('/api/'))return json(404,{error:'Página não encontrada.'});
        if(req.headers['x-vigia-token']!==token)return json(403,{error:'Atualize o painel antes de continuar.'});
        if(!String(req.headers['content-type']??'').startsWith('application/json'))return json(415,{error:'Formato não suportado.'});
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)return json(413,{error:'Solicitação muito grande.'});}
        let input;try{input=JSON.parse(body||'{}');}catch{return json(400,{error:'Dados inválidos.'});}
        if(!input||typeof input!=='object'||Array.isArray(input))return json(400,{error:'Dados inválidos.'});
        const operation=async()=>{
          if(req.method==='POST'&&url.pathname==='/api/products')await service.add(input);
          else if(req.method==='PATCH'&&url.pathname==='/api/settings')await service.updateSettings(input);
          else if(req.method==='POST'&&url.pathname==='/api/import'){
            const references=referenceProducts??JSON.parse(await readFile(join(directory,'server/reference-products.json'),'utf8'));
            await service.importProducts(references);
          }
          else if(req.method==='PATCH'&&/^\/api\/products\/[^/]+$/.test(url.pathname))await service.edit(decodeURIComponent(url.pathname.split('/').at(-1)),input);
          else if(req.method==='DELETE'&&/^\/api\/products\/[^/]+$/.test(url.pathname))await service.remove(decodeURIComponent(url.pathname.split('/').at(-1)));
          else if(req.method==='POST'&&url.pathname==='/api/monitor/start')service.start();
          else if(req.method==='POST'&&url.pathname==='/api/monitor/stop')await service.stop();
          else if(req.method==='POST'&&url.pathname==='/api/notifications/test')await service.notify({id:randomBytes(16).toString('hex'),title:'Vigia · teste de notificação',message:'Os alertas de disponibilidade e Pix aparecem nas notificações do Windows.'});
          else if(req.method==='POST'&&/^\/api\/purchases\/[^/]+\/resolve$/.test(url.pathname))await service.purchases.resolve(decodeURIComponent(url.pathname.split('/')[3]));
          else if(req.method==='POST'&&/^\/api\/accounts\/(amazon|ml)\/(monitor|purchase)\/(open|close)$/.test(url.pathname)) {
            const [,,,store,purpose,operation]=url.pathname.split('/');
            if(operation==='open')await service.openLogin(store,purpose);else await service.closeLogin(store,purpose);
          }
          else {const e=new Error('Ação não encontrada.');e.status=404;throw e;}
          return {...service.state(),apiVersion};
        };
        const result=mutationQueue.then(operation);mutationQueue=result.catch(()=>{});
        try {return json(200,await result);}catch(error){return json(error.status??400,{error:error.message});}
      } catch(error) {if(!res.headersSent)json(500,{error:'Não foi possível concluir a solicitação: '+error.message});else res.end();}
    });
    server.requestTimeout=30000;
    return {server,service,async close(){await service.close();await mutationQueue;server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));await unlock();}};
  } catch(error){await unlock();throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {
    const app=await createApplication();
    const port=Number(process.env.VIGIA_PORT??4318);
    app.server.on('error',e=>{console.error('Não foi possível abrir o painel:',e.message);void app.close().finally(()=>{process.exitCode=1;});});
    app.server.listen(port,'127.0.0.1',()=>console.log(`Vigia: http://127.0.0.1:${app.server.address().port}\nAbra INICIAR-PAINEL.cmd para usar a interface. Ctrl+C encerra o serviço e os monitores.`));
    let closing=false;
    const shutdown=()=>{if(closing)return;closing=true;void app.close().catch(e=>{console.error(e.message);process.exitCode=1;});};
    process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
  } catch(error){console.error('Falha ao iniciar:',error.message);process.exitCode=1;}
}
