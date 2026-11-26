import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadRegistry, registryWriter, lockService } from './server/storage.mjs';
import { productInput } from './server/model.mjs';
import { validateSettings, defaults } from './server/availability.mjs';
import { MonitoringService } from './server/service.mjs';
import { recoverAbandonedAmazonLock } from './server/amazon-lock.mjs';
import { AuthClient, loadLocalEnv } from './server/auth-client.mjs';
import { AutoUpdater } from './server/updater.mjs';
import { apiVersion } from './panel-api.mjs';

const directory=dirname(fileURLToPath(import.meta.url));
const projectRoot=resolve(process.env.MONITOR_PROJECT_ROOT??join(directory,'..'));
const defaultData=join(directory,'.data');

function applyRemoteUserData(service, remoteData) {
  if (!remoteData?.exists) return false;
  if (Array.isArray(remoteData.products)) {
    const validatedProducts = [];
    const seenIds = new Set();
    const seenKeys = new Set();
    const counts = { amazon: 0, ml: 0 };
    for (const raw of remoteData.products) {
      try {
        const validated = productInput(raw, raw);
        const key = `${validated.store}:${validated.code}`;
        if (typeof raw.id !== 'string' || seenIds.has(raw.id) || seenKeys.has(key) || ++counts[validated.store] > 10) continue;
        seenIds.add(raw.id);
        seenKeys.add(key);
        validatedProducts.push({ ...raw, ...validated, id: raw.id });
      } catch {}
    }
    service.registry.products = validatedProducts;
  }
  if (remoteData.settings && typeof remoteData.settings === 'object') {
    service.settings = validateSettings(remoteData.settings);
    service.registry.settings = service.settings;
  }
  return true;
}

export async function createApplication({dataDirectory=defaultData,adapters,referenceProducts,root=projectRoot,loginOpener,notifier,purchaseRunner,vpsUrl=process.env.VIGIA_VPS_URL??'',authFetch,authNow,offlineGraceMs,updateTargetDirectory=directory,currentVersion,onRestart}={}) {
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
    const authClient=new AuthClient({dataDirectory,vpsUrl,fetchImpl:authFetch,now:authNow,offlineGraceMs});
    await authClient.init();
    const updater=new AutoUpdater({authClient,targetDirectory:updateTargetDirectory,currentVersion,onRestart});
    if(authClient.authenticated&&!authClient.offlineMode){
      try {
        const remote=await authClient.pullUserData();
        if(applyRemoteUserData(service,remote))await save(service.registry);
      } catch {}
      void updater.checkAndApply();
    }
    try{
      const recovery=await recoverAbandonedAmazonLock(dataDirectory);
      if(recovery.recovered)service.shops.amazon.message='Registro antigo recuperado. Amazon pronta para monitorar.';
    }catch(error){service.shops.amazon={status:'error',message:error.message};}
    if(service.purchases.recoveredChanges)await save(registry);
    const token=randomBytes(32).toString('hex');
    let mutationQueue=Promise.resolve();
    const staticFiles=new Map([['/','index.html'],['/index.html','index.html'],['/styles.css','styles.css'],['/app.js','app.js'],['/cards.js','cards.js']]);
    const syncToVps=async()=>{
      if(!authClient.authenticated)return;
      await authClient.pushUserData({products:service.registry.products,settings:service.settings});
    };
    const server=createServer(async(req,res)=>{
      const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
      try {
        const expectedHost=`127.0.0.1:${server.address().port}`;
        if(req.headers.host!==expectedHost)return json(403,{error:'Host não permitido.'});
        const origin=`http://${expectedHost}`;
        const url=new URL(req.url,origin);
        const isOAuthCallback=req.method==='GET'&&url.pathname==='/api/auth/callback';
        if(!isOAuthCallback&&((req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site'))return json(403,{error:'Origem não permitida.'});
        res.setHeader('X-Content-Type-Options','nosniff');
        res.setHeader('Referrer-Policy','no-referrer');
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://m.media-amazon.com https://images-na.ssl-images-amazon.com https://http2.mlstatic.com https://lh3.googleusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        if(isOAuthCallback){
          const code=url.searchParams.get('code')??'';
          if(!code)return json(400,{error:'Código de autenticação ausente.'});
          try {
            await authClient.completeCallback(code);
            const remote=await authClient.pullUserData();
            if(remote?.exists){
              if(applyRemoteUserData(service,remote))await save(service.registry);
            } else {
              await syncToVps();
            }
            void updater.checkAndApply();
            res.writeHead(302,{Location:'/', 'Cache-Control':'no-store'});
            res.end();
            return;
          } catch(error) {
            res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
            res.end(`Falha ao concluir login: ${error.message}`);
            return;
          }
        }
        if(req.method==='GET'&&url.pathname==='/api/state')return json(200,{...service.state(),auth:authClient.state(origin),update:updater.state(),token,apiVersion});
        if(req.method==='GET'&&url.pathname==='/api/availability-history')return json(200,{entries:service.registry.availabilityHistory.filter(row=>!url.searchParams.get('productId')||row.productId===url.searchParams.get('productId')).slice().reverse()});
        if(req.method==='GET'&&url.pathname==='/api/admin/allowlist'){
          if(!authClient.authenticated)return json(401,{error:'Faça login para continuar.'});
          try {return json(200,await authClient.adminListAllowlist());}catch(error){return json(error.status??400,{error:error.message});}
        }
        if(req.method==='GET'&&staticFiles.has(url.pathname)){
          const file=staticFiles.get(url.pathname);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(await readFile(join(directory,file)));return;
        }
        if(!url.pathname.startsWith('/api/'))return json(404,{error:'Página não encontrada.'});
        if(req.headers['x-vigia-token']!==token)return json(403,{error:'Atualize o painel antes de continuar.'});
        if(!String(req.headers['content-type']??'').startsWith('application/json'))return json(415,{error:'Formato não suportado.'});
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)return json(413,{error:'Solicitação muito grande.'});}
        let input;try{input=JSON.parse(body||'{}');}catch{return json(400,{error:'Dados inválidos.'});}
        if(!input||typeof input!=='object'||Array.isArray(input))return json(400,{error:'Dados inválidos.'});
        if(req.method==='POST'&&url.pathname==='/api/auth/logout'){
          await authClient.logout();
          return json(200,{...service.state(),auth:authClient.state(origin),update:updater.state(),apiVersion});
        }
        if(authClient.enabled&&!authClient.authenticated)return json(401,{error:'Faça login com sua conta Google para continuar.'});
        if(req.method==='POST'&&url.pathname==='/api/auth/sync'){
          await syncToVps();
          return json(200,{...service.state(),auth:authClient.state(origin),update:updater.state(),apiVersion});
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/allowlist'){
          try {return json(200,await authClient.adminAddEmail(input));}catch(error){return json(error.status??400,{error:error.message});}
        }
        if(req.method==='DELETE'&&url.pathname.startsWith('/api/admin/allowlist/')){
          const targetEmail=decodeURIComponent(url.pathname.slice('/api/admin/allowlist/'.length));
          try {return json(200,await authClient.adminRemoveEmail(targetEmail));}catch(error){return json(error.status??400,{error:error.message});}
        }
        const operation=async()=>{
          let shouldSync=false;
          if(req.method==='POST'&&url.pathname==='/api/products'){await service.add(input);shouldSync=true;}
          else if(req.method==='PATCH'&&url.pathname==='/api/settings'){await service.updateSettings(input);shouldSync=true;}
          else if(req.method==='POST'&&url.pathname==='/api/import'){
            const references=referenceProducts??JSON.parse(await readFile(join(directory,'server/reference-products.json'),'utf8'));
            await service.importProducts(references);
            shouldSync=true;
          }
          else if(req.method==='PATCH'&&/^\/api\/products\/[^/]+$/.test(url.pathname)){await service.edit(decodeURIComponent(url.pathname.split('/').at(-1)),input);shouldSync=true;}
          else if(req.method==='DELETE'&&/^\/api\/products\/[^/]+$/.test(url.pathname)){await service.remove(decodeURIComponent(url.pathname.split('/').at(-1)));shouldSync=true;}
          else if(req.method==='POST'&&url.pathname==='/api/monitor/start')service.start();
          else if(req.method==='POST'&&url.pathname==='/api/monitor/stop')await service.stop();
          else if(req.method==='POST'&&url.pathname==='/api/notifications/test')await service.notify({id:randomBytes(16).toString('hex'),title:'Vigia · teste de notificação',message:'Os alertas de disponibilidade e Pix aparecem nas notificações do Windows.'});
          else if(req.method==='POST'&&/^\/api\/purchases\/[^/]+\/resolve$/.test(url.pathname))await service.purchases.resolve(decodeURIComponent(url.pathname.split('/')[3]));
          else if(req.method==='POST'&&/^\/api\/accounts\/(amazon|ml)\/(monitor|purchase)\/(open|close)$/.test(url.pathname)) {
            const [,,,store,purpose,operation]=url.pathname.split('/');
            if(operation==='open')await service.openLogin(store,purpose);else await service.closeLogin(store,purpose);
          }
          else {const e=new Error('Ação não encontrada.');e.status=404;throw e;}
          if(shouldSync)await syncToVps();
          return {...service.state(),auth:authClient.state(origin),update:updater.state(),apiVersion};
        };
        const result=mutationQueue.then(operation);mutationQueue=result.catch(()=>{});
        try {return json(200,await result);}catch(error){return json(error.status??400,{error:error.message});}
      } catch(error) {if(!res.headersSent)json(500,{error:'Não foi possível concluir a solicitação: '+error.message});else res.end();}
    });
    server.requestTimeout=30000;
    return {server,service,authClient,updater,async close(){await service.close();await mutationQueue;server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));await unlock();}};
  } catch(error){await unlock();throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  loadLocalEnv(join(directory,'.env'));
  try {
    let app;
    const restartSelf=async()=>{
      setTimeout(async()=>{
        try{if(app)await app.close();}catch{}
        const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{cwd:directory,detached:true,stdio:'ignore',env:process.env});
        child.unref();
        process.exit(0);
      },1200);
    };
    app=await createApplication({onRestart:restartSelf});
    const port=Number(process.env.VIGIA_PORT??4318);
    app.server.on('error',e=>{console.error('Não foi possível abrir o painel:',e.message);void app.close().finally(()=>{process.exitCode=1;});});
    app.server.listen(port,'127.0.0.1',()=>console.log(`Vigia: http://127.0.0.1:${app.server.address().port}\nAbra INICIAR-PAINEL.cmd para usar a interface. Ctrl+C encerra o serviço e os monitores.`));
    let closing=false;
    const shutdown=()=>{if(closing)return;closing=true;void app.close().catch(e=>{console.error(e.message);process.exitCode=1;});};
    process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
  } catch(error){console.error('Falha ao iniciar:',error.message);process.exitCode=1;}
}
