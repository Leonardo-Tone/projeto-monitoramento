import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadRegistry, registryWriter, lockService } from './server/storage.mjs';
import { productInput } from './server/model.mjs';
import { safeProductImage } from './server/metadata.mjs';
import { validateSettings, defaults } from './server/availability.mjs';
import { MonitoringService } from './server/service.mjs';
import { recoverAbandonedAmazonLock } from './server/amazon-lock.mjs';
import { AuthClient, loadLocalEnv } from './server/auth-client.mjs';
import { AutoUpdater } from './server/updater.mjs';
import { BrowserTestRunner } from './server/browser-tests.mjs';
import { apiVersion } from './panel-api.mjs';

const directory=dirname(fileURLToPath(import.meta.url));
const projectRoot=resolve(process.env.MONITOR_PROJECT_ROOT??join(directory,'..'));
const defaultData=join(directory,'.data');
const appVersion=JSON.parse(await readFile(join(directory,'package.json'),'utf8')).version;

const SYNC_INPUT_FIELDS = ['id', 'store', 'url', 'name', 'target', 'quantity', 'alert', 'auto', 'expectedSellerId'];
const PRODUCT_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const LOCAL_STATE_TTL_MS = 5 * 60 * 1000;

function pickSyncProduct(raw) {
  const picked = {};
  for (const key of SYNC_INPUT_FIELDS) {
    if (raw && Object.hasOwn(raw, key) && raw[key] !== undefined) {
      picked[key] = raw[key];
    }
  }
  if (typeof raw?.title === 'string' && raw.title.trim()) {
    picked.title = raw.title.replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  const safeImg = safeProductImage(raw?.imageUrl, raw?.store);
  if (safeImg) picked.imageUrl = safeImg;
  return picked;
}

function safeDecodeParam(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    const err = new Error('Parâmetro de URL inválido.');
    err.status = 400;
    throw err;
  }
}

export function applyRemoteUserData(service, remoteData) {
  if (!remoteData?.exists) return false;
  if (Array.isArray(remoteData.products)) {
    const existingList = Array.isArray(service.registry?.products) ? service.registry.products : [];
    const existingById = new Map(existingList.filter(p => p && typeof p.id === 'string').map(p => [p.id, p]));
    const existingByIdentity = new Map(existingList.filter(p => p?.store && p?.code).map(p => [`${p.store}:${p.code}`, p]));
    const validatedProducts = [];
    const seenIds = new Set();
    const seenKeys = new Set();
    const counts = { amazon: 0, ml: 0 };
    for (const raw of remoteData.products) {
      try {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !PRODUCT_ID_RE.test(raw.id)) continue;
        const picked = pickSyncProduct(raw);
        const probe = productInput(picked, null);
        const key = `${probe.store}:${probe.code}`;
        if (seenIds.has(picked.id) || seenKeys.has(key) || ++counts[probe.store] > 10) continue;
        const candidateLocal = existingById.get(picked.id) ?? existingByIdentity.get(key) ?? null;
        const sameIdentity = candidateLocal &&
          candidateLocal.store === probe.store &&
          candidateLocal.code === probe.code &&
          (candidateLocal.catalog ?? null) === (probe.catalog ?? null);
        const validated = sameIdentity ? { ...productInput(picked, candidateLocal), id: picked.id } : { ...probe, id: picked.id };
        if (validated.auto && validated.target === null) validated.auto = false;
        if (sameIdentity) {
          if (candidateLocal.target !== validated.target || candidateLocal.expectedSellerId !== validated.expectedSellerId || candidateLocal.alert !== validated.alert) {
            delete validated.mlConfirmation;
            delete validated.availabilityNotification;
          }
        }
        if (!validated.title && picked.title) validated.title = picked.title;
        if (!validated.imageUrl && picked.imageUrl) validated.imageUrl = picked.imageUrl;
        seenIds.add(picked.id);
        seenKeys.add(key);
        validatedProducts.push(validated);
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

export async function createApplication({dataDirectory=defaultData,adapters,referenceProducts,root=projectRoot,loginOpener,notifier,purchaseRunner,vpsUrl=process.env.VIGIA_VPS_URL??'',authFetch,authNow,offlineGraceMs,heartbeatIntervalMs=60_000,updateTargetDirectory=directory,currentVersion,onRestart,tokenCodec=null,onAuthComplete=null,desktopMode=process.env.VIGIA_DESKTOP==='1',browserTestRunner=null}={}) {
  const unlock=await lockService(dataDirectory);
  let heartbeatTimer=null;
  try {
    const registry=await loadRegistry(dataDirectory);
    const ids=new Set();const identities=new Set();const counts={amazon:0,ml:0};
    for(const p of registry.products){
      const validated=productInput(p,p);const key=validated.store+':'+validated.code;
      if(typeof p.id!=='string'||ids.has(p.id)||identities.has(key)||++counts[p.store]>10)throw new Error('Cadastro persistido inválido. Os arquivos foram preservados.');
      ids.add(p.id);identities.add(key);
    }
    const save=registryWriter(dataDirectory);
    let syncToVps=async()=>null;
    const service=new MonitoringService({registry,save,projectRoot:root,dataDirectory,adapters,loginOpener,notifier,purchaseRunner,onProductsDisarmed:()=>syncToVps().catch(()=>{})});
    const clearAccountLocalState=async()=>{
      service.registry.products=[];
      service.settings=defaults();
      service.registry.settings=service.settings;
      service.events=[];
      service.registry.events=[];
      service.registry.availabilityHistory=[];
      service.registry.purchaseOrders=[];
      service.registry.notificationOutbox=[];
      service.registry.pendingProductEdits={};
      delete service.registry.ownerUserId;
      service.shops={amazon:{status:'stopped',message:'Pronto para monitorar'},ml:{status:'stopped',message:'Pronto para monitorar'}};
      await save(service.registry);
    };
    const handleSessionRevoked=async()=>{
      await service.stop();
      await clearAccountLocalState();
    };
    const authClient=new AuthClient({dataDirectory,vpsUrl,fetchImpl:authFetch,now:authNow,offlineGraceMs,onSessionRevoked:handleSessionRevoked,tokenCodec});
    await authClient.init();
    const browserTests=browserTestRunner??new BrowserTestRunner({projectRoot:root,dataDirectory,appVersion});
    await browserTests.init();
    const requireAdmin=()=>{
      if(!authClient.enabled||!authClient.authenticated){
        const e=new Error('Faça login como administrador para continuar.');
        e.status=401;
        throw e;
      }
      if(authClient.session?.user?.role!=='admin'){
        const e=new Error('Acesso restrito a administradores.');
        e.status=403;
        throw e;
      }
    };
    const isServiceBusy=()=>Boolean(service.state().running||service.purchases.state().busy);
    const updater=new AutoUpdater({authClient,targetDirectory:updateTargetDirectory,currentVersion,onRestart,desktopMode,shouldDeferRestart:isServiceBusy});
    let lastAppliedRemoteUpdatedAt=null;
    syncToVps=async()=>{
      if(!authClient.authenticated)return null;
      const products=service.registry.products.map(pickSyncProduct);
      const pushed=await authClient.pushUserData({products,settings:service.settings});
      if(pushed?.updatedAt)lastAppliedRemoteUpdatedAt=pushed.updatedAt;
      return pushed;
    };
    const ensureAccountOwner=async(userId)=>{
      if(!userId)return;
      if(service.registry.ownerUserId&&service.registry.ownerUserId!==userId){
        await service.stop();
        await clearAccountLocalState();
      }
      service.registry.ownerUserId=userId;
    };
    if(authClient.authenticated&&!authClient.offlineMode){
      try {
        await ensureAccountOwner(authClient.session?.user?.id);
        if(authClient.pendingSync||service.purchases.recoveredChanges){
          await syncToVps();
        }
        const remote=await authClient.pullUserData();
        if(remote?.exists){
          if(applyRemoteUserData(service,remote)){
            lastAppliedRemoteUpdatedAt=remote.updatedAt??null;
            await save(service.registry);
          }
        } else {
          await save(service.registry);
        }
      } catch {}
      void updater.checkAndApply();
    }
    let heartbeatRunning=false;
    if(authClient.enabled&&heartbeatIntervalMs>0){
      heartbeatTimer=setInterval(async()=>{
        if(heartbeatRunning||!authClient.authenticated)return;
        heartbeatRunning=true;
        try {
          const hadPendingSync=authClient.pendingSync;
          const user=await authClient.verifySession().catch(()=>null);
          if(!user||authClient.offlineMode||!authClient.authenticated)return;
          if(hadPendingSync||authClient.pendingSync){
            await syncToVps();
          }
          const remote=await authClient.pullUserData().catch(()=>null);
          if(remote?.exists&&remote.updatedAt!==lastAppliedRemoteUpdatedAt&&!service.state().running&&!service.purchases.state().busy){
            if(applyRemoteUserData(service,remote)){
              lastAppliedRemoteUpdatedAt=remote.updatedAt??null;
              await save(service.registry);
            }
          }
        } finally {
          heartbeatRunning=false;
        }
      },heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }
    try{
      const recovery=await recoverAbandonedAmazonLock(dataDirectory);
      if(recovery.recovered)service.shops.amazon.message='Registro antigo recuperado. Amazon pronta para monitorar.';
    }catch(error){service.shops.amazon={status:'error',message:error.message};}
    if(service.purchases.recoveredChanges)await save(registry);
    const token=randomBytes(32).toString('hex');
    let mutationQueue=Promise.resolve();
    const pendingLocalStates=new Map();
    const issueLocalState=()=>{
      const now=Date.now();
      for(const [k,exp]of pendingLocalStates)if(exp<now)pendingLocalStates.delete(k);
      if(pendingLocalStates.size>=100){
        const oldest=pendingLocalStates.keys().next().value;
        if(oldest)pendingLocalStates.delete(oldest);
      }
      const value=randomBytes(24).toString('base64url');
      pendingLocalStates.set(value,now+LOCAL_STATE_TTL_MS);
      return value;
    };
    const consumeLocalState=received=>{
      if(!received||typeof received!=='string')return false;
      const now=Date.now();
      for(const [k,exp]of pendingLocalStates)if(exp<now)pendingLocalStates.delete(k);
      const recvBuf=Buffer.from(received,'utf8');
      let matched=null;
      for(const key of pendingLocalStates.keys()){
        const keyBuf=Buffer.from(key,'utf8');
        if(keyBuf.length===recvBuf.length&&timingSafeEqual(keyBuf,recvBuf))matched=key;
      }
      if(!matched)return false;
      pendingLocalStates.delete(matched);
      return true;
    };
    const staticFiles=new Map([['/','index.html'],['/index.html','index.html'],['/styles.css','styles.css'],['/app.js','app.js'],['/cards.js','cards.js']]);
    const sanitizedState=()=>{
      const base=service.state();
      if(authClient.enabled&&!authClient.authenticated){
        return {...base,products:[],events:[],purchases:{busy:false,orders:[]}};
      }
      return base;
    };
    const server=createServer(async(req,res)=>{
      const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
      try {
        const expectedHost=`127.0.0.1:${server.address().port}`;
        if(req.headers.host!==expectedHost)return json(403,{error:'Host não permitido.'});
        const origin=`http://${expectedHost}`;
        const url=new URL(req.url,origin);
        const isOAuthCallback=req.method==='GET'&&url.pathname==='/api/auth/callback';
        const isRootNavigation=req.method==='GET'&&url.pathname==='/'&&req.headers['sec-fetch-mode']==='navigate';
        if(!isOAuthCallback&&!isRootNavigation&&((req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site'))return json(403,{error:'Origem não permitida.'});
        res.setHeader('X-Content-Type-Options','nosniff');
        res.setHeader('Referrer-Policy','no-referrer');
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://m.media-amazon.com https://images-na.ssl-images-amazon.com https://images-sa.ssl-images-amazon.com https://images-eu.ssl-images-amazon.com https://images-fe.ssl-images-amazon.com https://http2.mlstatic.com https://lh3.googleusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        if(req.method==='GET'&&url.pathname==='/api/auth/start'){
          if(!authClient.enabled)return json(400,{error:'Servidor VPS não configurado.'});
          const localState=issueLocalState();
          const callback=`${origin}/api/auth/callback?local_state=${encodeURIComponent(localState)}`;
          const target=`${authClient.vpsUrl}/auth/google/start?callback=${encodeURIComponent(callback)}`;
          res.writeHead(302,{Location:target,'Cache-Control':'no-store'});
          res.end();
          return;
        }
        if(isOAuthCallback){
          const receivedState=url.searchParams.get('local_state')??'';
          if(!consumeLocalState(receivedState)){
            return json(400,{error:'Estado de autenticação local inválido ou expirado.'});
          }
          const code=url.searchParams.get('code')??'';
          if(!code)return json(400,{error:'Código de autenticação ausente.'});
          try {
            const user=await authClient.completeCallback(code);
            await ensureAccountOwner(user?.id);
            const remote=await authClient.pullUserData();
            if(remote?.exists){
              if(applyRemoteUserData(service,remote)){
                lastAppliedRemoteUpdatedAt=remote.updatedAt??null;
                await save(service.registry);
              }
            } else {
              await save(service.registry);
              await syncToVps();
            }
            void updater.checkAndApply();
            if(typeof onAuthComplete==='function'){try{onAuthComplete(user);}catch{}}
            if(desktopMode){
              res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"});
              res.end('<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Vigia · Login concluído</title><style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f4f3ef;color:#1d1c1a;display:grid;place-items:center;min-height:100vh;padding:24px}.card{background:#fff;border:1px solid #e2dfd7;border-radius:14px;max-width:420px;width:100%;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.06)}.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:#1f7a4c18;color:#1f7a4c;margin-bottom:12px}h1{margin:0 0 10px;font-size:20px}p{margin:0;line-height:1.5;color:#52504a;font-size:14px}</style></head><body><main class="card"><span class="badge">Vigia · Autenticação</span><h1>Login concluído!</h1><p>Sua conta Google foi conectada com sucesso. Você já pode fechar esta aba e voltar ao aplicativo Vigia.</p></main></body></html>');
              return;
            }
            res.writeHead(302,{Location:'/', 'Cache-Control':'no-store'});
            res.end();
            return;
          } catch(error) {
            res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
            res.end(`Falha ao concluir login: ${error.message}`);
            return;
          }
        }
        if(req.method==='GET'&&url.pathname==='/api/state')return json(200,{...sanitizedState(),auth:authClient.state(origin),update:updater.state(),token,apiVersion,appVersion});
        if(req.method==='GET'&&url.pathname==='/api/availability-history'){
          if(authClient.enabled&&!authClient.authenticated)return json(401,{error:'Faça login com sua conta Google para continuar.'});
          return json(200,{entries:service.registry.availabilityHistory.filter(row=>!url.searchParams.get('productId')||row.productId===url.searchParams.get('productId')).slice().reverse()});
        }
        if(req.method==='GET'&&url.pathname==='/api/admin/allowlist'){
          if(!authClient.authenticated)return json(401,{error:'Faça login para continuar.'});
          try {return json(200,await authClient.adminListAllowlist());}catch(error){return json(error.status??400,{error:error.message});}
        }
        if(req.method==='GET'&&url.pathname==='/api/admin/browser-tests'){
          try {requireAdmin();return json(200,browserTests.state());}catch(error){return json(error.status??400,{error:error.message});}
        }
        if(req.method==='GET'&&/^\/api\/admin\/browser-tests\/runs\/[^/]+\/screenshot$/.test(url.pathname)){
          try {
            requireAdmin();
            const runId=safeDecodeParam(url.pathname.split('/')[5]);
            const png=await browserTests.getScreenshotBuffer(runId);
            res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});
            res.end(png);
            return;
          }catch(error){return json(error.status??400,{error:error.message});}
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
          await service.stop();
          await authClient.logout();
          await clearAccountLocalState();
          return json(200,{...sanitizedState(),auth:authClient.state(origin),update:updater.state(),apiVersion});
        }
        if(authClient.enabled&&!authClient.authenticated)return json(401,{error:'Faça login com sua conta Google para continuar.'});
        if(req.method==='POST'&&url.pathname==='/api/auth/sync'){
          await syncToVps();
          return json(200,{...sanitizedState(),auth:authClient.state(origin),update:updater.state(),apiVersion});
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/allowlist'){
          try {return json(200,await authClient.adminAddEmail(input));}catch(error){return json(error.status??400,{error:error.message});}
        }
        if(req.method==='DELETE'&&url.pathname.startsWith('/api/admin/allowlist/')){
          const targetEmail=safeDecodeParam(url.pathname.slice('/api/admin/allowlist/'.length));
          try {return json(200,await authClient.adminRemoveEmail(targetEmail));}catch(error){return json(error.status??400,{error:error.message});}
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/browser-tests/run'){
          try {
            requireAdmin();
            const run=await browserTests.start(String(input.testId??'').trim());
            return json(202,{run,state:browserTests.state()});
          }catch(error){return json(error.status??400,{error:error.message});}
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/browser-tests/run-batch'){
          try {
            requireAdmin();
            const batch=await browserTests.startBatch({category:String(input.category??'all').trim()});
            return json(202,{batch,state:browserTests.state()});
          }catch(error){return json(error.status??400,{error:error.message});}
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/browser-tests/cancel'){
          try {
            requireAdmin();
            const result=await browserTests.cancel();
            return json(200,{...result,state:browserTests.state()});
          }catch(error){return json(error.status??400,{error:error.message});}
        }
        if(req.method==='DELETE'&&url.pathname==='/api/admin/browser-tests/history'){
          try {
            requireAdmin();
            return json(200,await browserTests.clearHistory());
          }catch(error){return json(error.status??400,{error:error.message});}
        }
        if(req.method==='POST'&&url.pathname==='/api/updates/apply'){
          await updater.applyReadyUpdate();
          return json(200,{...sanitizedState(),auth:authClient.state(origin),update:updater.state(),apiVersion});
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
          else if(req.method==='PATCH'&&/^\/api\/products\/[^/]+$/.test(url.pathname)){await service.edit(safeDecodeParam(url.pathname.split('/').at(-1)),input);shouldSync=true;}
          else if(req.method==='DELETE'&&/^\/api\/products\/[^/]+$/.test(url.pathname)){await service.remove(safeDecodeParam(url.pathname.split('/').at(-1)));shouldSync=true;}
          else if(req.method==='POST'&&url.pathname==='/api/monitor/start'){
            if(authClient.enabled){
              const verified=await authClient.verifySession().catch(err=>{
                if(err.status===401)return null;
                throw err;
              });
              if(!verified||!authClient.authenticated){
                const e=new Error('Sessão revogada ou expirada. Faça login novamente.');
                e.status=401;
                throw e;
              }
            }
            service.start();
          }
          else if(req.method==='POST'&&url.pathname==='/api/monitor/stop')await service.stop();
          else if(req.method==='POST'&&url.pathname==='/api/notifications/test')await service.notify({id:randomBytes(16).toString('hex'),title:'Vigia · teste de notificação',message:'Os alertas de disponibilidade e Pix aparecem nas notificações do Windows.'});
          else if(req.method==='POST'&&/^\/api\/purchases\/[^/]+\/resolve$/.test(url.pathname)){await service.purchases.resolve(safeDecodeParam(url.pathname.split('/')[3]));shouldSync=true;}
          else if(req.method==='POST'&&/^\/api\/accounts\/(amazon|ml)\/(monitor|purchase)\/(open|close)$/.test(url.pathname)) {
            const [,,,store,purpose,operation]=url.pathname.split('/');
            if(operation==='open')await service.openLogin(store,purpose);else await service.closeLogin(store,purpose);
          }
          else {const e=new Error('Ação não encontrada.');e.status=404;throw e;}
          if(shouldSync)await syncToVps();
          return {...sanitizedState(),auth:authClient.state(origin),update:updater.state(),apiVersion};
        };
        const result=mutationQueue.then(operation);mutationQueue=result.catch(()=>{});
        try {return json(200,await result);}catch(error){return json(error.status??400,{error:error.message});}
      } catch(error) {if(!res.headersSent)json(error.status??500,{error:error.status?error.message:'Não foi possível concluir a solicitação: '+error.message});else res.end();}
    });
    server.requestTimeout=30000;
    return {server,service,authClient,updater,browserTests,async close(){if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null;}await browserTests.close();await service.close();await mutationQueue;server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));await unlock();}};
  } catch(error){if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null;}await unlock();throw error;}
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
    app.server.listen(port,'127.0.0.1',()=>console.log(`Vigia: http://127.0.0.1:${app.server.address().port}\nCtrl+C encerra o serviço e os monitores.`));
    let closing=false;
    const shutdown=()=>{if(closing)return;closing=true;void app.close().catch(e=>{console.error(e.message);process.exitCode=1;});};
    process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
  } catch(error){console.error('Falha ao iniciar:',error.message);process.exitCode=1;}
}
