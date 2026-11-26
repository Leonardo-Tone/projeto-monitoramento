import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extrairEstado, classificar, prepararAba, consultarProduto, consultarCatalogo } from './ml-v3-core.mjs';
import { amazonObservation } from './model.mjs';
import { launchProfile, profileFetch } from './profiles.mjs';
import { createMetadataParser } from './metadata.mjs';
import { deliveryLabel, reputationLevels, reputationMedals } from './availability.mjs';
import { recoverAbandonedAmazonLock } from './amazon-lock.mjs';
import { checkMonitorAccount, checkMonitoringAccounts } from './account-verification.mjs';
import { createMonitorRecovery, trackNetworkFailures } from './monitor-recovery.mjs';
import { isCaptchaError } from './captcha-resolver.mjs';

const moduleAt=(...parts)=>import(pathToFileURL(join(...parts)).href);
const verification=url=>/account-verification|captcha|challenge|\/login|\/auth\//i.test(url??'');
function monitoringRecovery({store,projectRoot,dataDirectory,signal,settings,products,onStatus,onDiagnostic,clearPages,runningMessage}) {
  return createMonitorRecovery({
    store,signal,onStatus,onDiagnostic,clearPages,runningMessage,
    async open(reconnecting){
      const {browser}=await launchProfile({projectRoot,dataDirectory,store,purpose:'monitor',headless:true});
      try{
        if(reconnecting)await checkMonitorAccount({store,purpose:'monitor',browser,projectRoot,signal});
        else await checkMonitoringAccounts({
          store,browser,projectRoot,dataDirectory,signal,onStatus,
          purchaseEnabled:settings?.[store]?.purchase?.enabled&&products.some(product=>product.auto),
        });
        return browser;
      }catch(error){await browser.close().catch(()=>{});throw error;}
    },
  });
}
export async function mlRuntime(projectRoot) {
  return moduleAt(projectRoot,'Mercado_Livre','integracao-native.mjs');
}
export async function startAmazon({projectRoot,dataDirectory,products,signal,onResult,onEvent,onStatus,onCycle=()=>{},onDiagnostic=()=>{},consultar=null,settings,withMonitoringRead=work=>work(),getProducts=null,registerRecheck=()=>{},onCaptcha=null}) {
  if(signal.aborted)return;
  const recovery=await recoverAbandonedAmazonLock(dataDirectory);
  if(recovery.activePid)throw new Error(`A Amazon já está sendo usada pelo processo ${recovery.activePid}. O monitor ativo foi preservado.`);
  if(recovery.recovered)onStatus('starting','Registro de execução anterior da Amazon recuperado. Iniciando o monitor…');
  const core=join(projectRoot,'Amazon','amazon-monitor-core','src');
  const [{Monitor},{FileStore},{consultarAod,AodError},{validarConfig}]=await Promise.all([
    moduleAt(core,'monitor.mjs'),moduleAt(core,'store.mjs'),moduleAt(core,'client.mjs'),moduleAt(core,'config.mjs')]);
  const config=validarConfig({schemaVersion:1,intervalSeconds:15,maxConcurrency:3,timeoutMs:12000,maxConsecutiveFailures:3,confirmationCycles:2,
    products:products.map(p=>({asin:p.code,name:p.name||p.title||p.code,enabled:true,categories:settings?.amazon.onlyAmazon?['AMAZON_DIRETA']:['AMAZON_DIRETA','TERCEIRO_ENVIO_AMAZON','TERCEIRO_ENVIO_PROPRIO'],target:{maxPriceCents:p.target==null?null:Math.round(p.target*100),priceBasis:'NORMAL',includeShipping:false}}))});
  const store=new FileStore(join(dataDirectory,'amazon'));
  let transport, amazonPage, fetchImpl;
  const metadataByAsin=new Map();
  // Fila de produtos Amazon que precisam de re-verificação instantânea.
  const recheckQueue=[];
  registerRecheck(product=>{recheckQueue.push(product);});
  // Interruptible waits preserve the core scheduler while making Stop responsive.
  const sleep=ms=>new Promise(resolve=>{if(signal.aborted)return resolve();const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,ms);signal.addEventListener('abort',finish,{once:true});});
  const runningMessage='Amazon AOD v0.3 consultas a cada 15 s';
  if(!consultar){
    onStatus('starting','Preparando o perfil Chrome de monitoramento Amazon…');
    transport=monitoringRecovery({store:'amazon',projectRoot,dataDirectory,signal,settings,products,onStatus,onDiagnostic,runningMessage,
      clearPages:()=>{amazonPage=null;fetchImpl=null;}});
  }
  const parseMetadata=transport?createMetadataParser(projectRoot):null;
  const ensureAmazonPage=async browser=>{
    if(!fetchImpl||!amazonPage||amazonPage.isClosed?.()){
      const page=await browser.newPage();
      const network=trackNetworkFailures(page);
      const response=await page.goto('https://www.amazon.com.br/',{waitUntil:'domcontentloaded',timeout:20000});
      if(!response)throw new Error('Falha de rede ao abrir a Amazon (net::ERR_FAILED).');
      if(response.status()!==200)throw new Error('Amazon: HTTP '+response.status());
      const html=await page.content();
      if(/\/ap\/|captcha|challenge/i.test(new URL(page.url()).pathname)||/robot check|captchacharacters|\/errors\/validateCaptcha/i.test(html))throw new Error('Prepare o login ou a verificação no perfil de monitoramento Amazon antes de iniciar.');
      const fetch=profileFetch(page,{timeoutMs:config.timeoutMs,ErrorClass:AodError,onHtml:(html,url)=>metadataByAsin.set(url.searchParams.get('asin'),parseMetadata(html,'amazon'))});
      amazonPage=page;
      fetchImpl=async url=>{
        network.clear(url);
        try{return await fetch(url);}
        catch(error){throw network.attach(error,url);}
      };
    }
  };
  const collectAmazon=collect=>transport.run(async browser=>{
    metadataByAsin.clear();
    await ensureAmazonPage(browser);
    return collect();
  });
  const baseConsultar=consultar??((asin,options)=>consultarAod(asin,{...options,fetchImpl}));
  const consultarFn=async(asin,options)=>{
    try{
      return await baseConsultar(asin,options);
    }catch(error){
      if(isCaptchaError(error)&&onCaptcha){
        const prod=byAsin.get(asin);
        if(prod){
          await onCaptcha(prod);
          return await baseConsultar(asin,options);
        }
      }
      throw error;
    }
  };
  const monitor=new Monitor({
    config,store,sleep,
    consultar:consultarFn,
    coletarCiclo:collect=>withMonitoringRead(()=>transport?collectAmazon(collect):collect()),
  });
  let byAsin=new Map(products.map(p=>[p.code,p]));
  let pendingCycle=null;
  const originalCycle=monitor.ciclo.bind(monitor);
  monitor.ciclo=async number=>{
    if(getProducts){products=await getProducts();byAsin=new Map(products.map(p=>[p.code,p]));metadataByAsin.clear();
      config.products=validarConfig({...config,products:products.map(p=>({asin:p.code,name:p.name||p.title||p.code,enabled:true,categories:settings?.amazon.onlyAmazon?['AMAZON_DIRETA']:['AMAZON_DIRETA','TERCEIRO_ENVIO_AMAZON','TERCEIRO_ENVIO_PROPRIO'],target:{maxPriceCents:p.target==null?null:Math.round(p.target*100),priceBasis:'NORMAL',includeShipping:false}}))}).products;
    }
    pendingCycle=null;
    const result=await originalCycle(number);
    // Re-verificação instantânea: re-consulta produtos Amazon que foram detectados como disponíveis.
    while(recheckQueue.length&&!signal.aborted){
      const toRecheck=[...recheckQueue];recheckQueue.length=0;
      for(const product of toRecheck){
        if(signal.aborted)break;
        try{
          const asin=product.code;
          let dados;
          if(transport){
            const [entry]=await withMonitoringRead(()=>transport.run(async browser=>{
              await ensureAmazonPage(browser);
              try{return [{ok:true,value:await consultarFn(asin,{timeoutMs:config.timeoutMs})}];}
              catch(erro){return [{ok:false,erro}];}
            }));
            if(!entry?.ok)throw entry?.erro??new Error('Falha na re-verificação Amazon.');
            dados=entry.value;
          }else{
            dados=await withMonitoringRead(()=>consultarFn(asin,{timeoutMs:config.timeoutMs}));
          }
          const configProduct=config.products.find(p=>p.asin===asin);
          if(!configProduct)continue;
          const {construirSnapshot:buildSnap}=await moduleAt(core,'domain.mjs');
          const snapshot=buildSnap(dados,configProduct);
          const observation={...amazonObservation(snapshot),...(metadataByAsin.get(asin)??{})};
          onResult(product.id,observation);
        }catch(error){
          onResult(product.id,{at:new Date().toISOString(),error:error.message});
        }
      }
    }
    if(pendingCycle&&!signal.aborted)onCycle(pendingCycle);
    return result;
  };
  monitor.on('snapshot',snapshot=>onResult(byAsin.get(snapshot.asin).id,{...amazonObservation(snapshot),...metadataByAsin.get(snapshot.asin)}));
  monitor.on('problem',e=>onResult(byAsin.get(e.asin).id,{at:e.horario,error:`${e.code}: ${e.message}`}));
  monitor.on('event',e=>onEvent({id:e.id,productId:byAsin.get(e.asin)?.id,type:e.tipo,at:e.horario}));
  monitor.on('cycle',cycle=>{pendingCycle={ids:products.map(p=>p.id),ok:cycle.falhas===0};});
  monitor.on('status',e=>{if(e.status==='RODANDO')onStatus('running',runningMessage);else if(e.status==='INTERROMPIDO'&&!signal.aborted)onStatus('error',e.motivo??'Monitor interrompido.');});
  const abort=()=>monitor.parar('PARADA_MANUAL');
  signal.addEventListener('abort',abort,{once:true});
  try {
    if(transport)await withMonitoringRead(()=>transport.start());
    await monitor.preparar();
    if(signal.aborted)return;
    await monitor.executar({seconds:Infinity});
  } finally {signal.removeEventListener('abort',abort);try{await store.fechar();}finally{await transport?.close();}}
}

export async function mlResponse(product,response,parseMetadata=()=>({})) {
  const at=new Date().toISOString();
  if(verification(response.urlFinal))throw new Error(response.erro??'ML exige login ou verificação manual. Prepare o perfil de monitoramento nas configurações.');
  if(response.http!==200||response.erro||response.timeout||!response.html)throw new Error(response.timeout?'Timeout no Mercado Livre.':`Falha ML: HTTP ${response.http??'sem resposta'}${response.erro?' · '+response.erro:''}`);
  const expectedOrigin=product.type==='produto'?'https://produto.mercadolivre.com.br':'https://www.mercadolivre.com.br';
  if(new URL(response.urlFinal).origin!==expectedOrigin)throw new Error('Origem da resposta ML divergente. Use o link final do anúncio ou catálogo.');
  if(/<title[^>]*>[^<]*(?:captcha|verifica|challenge)/i.test(response.html))throw new Error('Verificação de acesso no ML.');
  const state=extrairEstado(response.html);
  const availability=classificar({id:product.code,catalogo:product.catalog,vendedorEsperado:product.expectedSellerId},state);
  const identityOk=!['identity_mismatch','unknown_identity'].includes(availability);
  return {at,available:availability==='available'?true:availability==='unavailable'?false:null,
    price:identityOk&&Number.isFinite(Number(state.preco))&&state.preco!==null?Number(state.preco):null,
    seller:identityOk&&state.sellerName?state.sellerName:'Não informado',
    sellerId:identityOk&&state.vendedor!=null?String(state.vendedor):null,
    variationId:identityOk?state.variationId??null:null,
    delivery:identityOk?deliveryLabel(state.shippingMode,state.logisticType):'Não informado',
    shippingMode:identityOk?state.shippingMode:null,logisticType:identityOk?state.logisticType:null,
    reputationLevel:identityOk&&reputationLevels.includes(state.reputationLevel)?state.reputationLevel:null,
    powerSellerStatus:identityOk&&reputationMedals.includes(state.powerSellerStatus)?state.powerSellerStatus:null,
    observation:availability,coverage:'ANUNCIO_SELECIONADO',...(identityOk?parseMetadata(response.html,'ml'):{})};
}

export async function collectMLProducts({traditional,catalogs,productPage,catalogPage,signal,consult}) {
  let index=0;
  const results=[];
  const read=async(product,page,fn)=>{
    try{results.push({ok:true,product,value:await consult(product,page,fn)});}
    catch(erro){results.push({ok:false,product,erro});}
  };
  await Promise.all(Array.from({length:Math.min(3,traditional.length)},async()=>{
    while(!signal.aborted&&index<traditional.length){
      const product=traditional[index++];
      await read(product,productPage,'produto');
    }
  }));
  for(const product of catalogs){
    if(signal.aborted)break;
    await read(product,catalogPage,'catalogo');
  }
  return results;
}

export async function startML({projectRoot,dataDirectory,products,signal,onResult,onStatus,onCycle=()=>{},onDiagnostic=()=>{},withMonitoringRead=work=>work(),getProducts=null,settings,registerRecheck=()=>{},onCaptcha=null}) {
  let productPage,catalogPage;
  const networkByPage=new WeakMap();
  const parseMetadata=createMetadataParser(projectRoot);
  const runningMessage='ML persistente v3 consultas a cada 15 s';
  const transport=monitoringRecovery({store:'ml',projectRoot,dataDirectory,signal,settings,products,onStatus,onDiagnostic,runningMessage,
    clearPages:()=>{productPage=null;catalogPage=null;}});
  // Fila de produtos que precisam de re-verificação instantânea.
  const recheckQueue=[];
  registerRecheck(product=>{recheckQueue.push(structuredClone(product));});
  async function ensureMLPages(browser){
    const traditional=products.filter(p=>p.type==='produto');
    const catalogs=products.filter(p=>p.type==='catalogo');
    if(traditional.length&&(!productPage||productPage.isClosed?.())){
      const bootstrap=await prepararAba(browser,'produto',traditional[0].url,'https://produto.mercadolivre.com.br',true,signal);
      if(!bootstrap.pronto)throw new Error(bootstrap.erro??'ML não pôde preparar a aba: '+bootstrap.motivo+'. Faça login manual nas configurações.');
      productPage=bootstrap.page;
      networkByPage.set(productPage,trackNetworkFailures(productPage));
    }
    if(catalogs.length&&(!catalogPage||catalogPage.isClosed?.())){
      const bootstrap=await prepararAba(browser,'catalogo','https://www.mercadolivre.com.br/','https://www.mercadolivre.com.br',false,signal);
      if(!bootstrap.pronto)throw new Error(bootstrap.erro??'ML não pôde preparar o catálogo: '+bootstrap.motivo+'.');
      catalogPage=bootstrap.page;
      networkByPage.set(catalogPage,trackNetworkFailures(catalogPage));
    }
    return {traditional,catalogs};
  }
  async function collect(browser){
    const {traditional,catalogs}=await ensureMLPages(browser);
    const consult=async(product,page,fn)=>{
      const network=networkByPage.get(page);
      network.clear(product.url);
      try {
        const response=await fn(page,{url:product.url},{browser,signal});
        signal.throwIfAborted();
        return await mlResponse(product,response,parseMetadata);
      }catch(erro){
        if(isCaptchaError(erro)&&onCaptcha){
          await onCaptcha(product);
          const retryResp=await fn(page,{url:product.url},{browser,signal});
          signal.throwIfAborted();
          return await mlResponse(product,retryResp,parseMetadata);
        }
        throw network.attach(erro,product.url);
      }
    };
    return collectMLProducts({traditional,catalogs,productPage,catalogPage,signal,consult:async(product,page,kind)=>
      consult(product,page,kind==='produto'?consultarProduto:consultarCatalogo)});
  }
  async function recheckProduct(browser,product){
    await ensureMLPages(browser);
    const page=product.type==='produto'?productPage:catalogPage;
    const fn=product.type==='produto'?consultarProduto:consultarCatalogo;
    if(!page)return null;
    const network=networkByPage.get(page);
    network.clear(product.url);
    try {
      const response=await fn(page,{url:product.url},{browser,signal});
      signal.throwIfAborted();
      return await mlResponse(product,response,parseMetadata);
    }catch(erro){
      if(isCaptchaError(erro)&&onCaptcha){
        await onCaptcha(product);
        const retryResp=await fn(page,{url:product.url},{browser,signal}).catch(()=>null);
        if(retryResp){
          try{return await mlResponse(product,retryResp,parseMetadata);}catch{}
        }
      }
      return {error:network.attach(erro,product.url).message};
    }
  }
  try {
    onStatus('starting','Preparando o navegador persistente do ML v3…');
    if(signal.aborted)return;
    await withMonitoringRead(()=>transport.start());
    if(signal.aborted)return;
    let next=Date.now();
    onStatus('running',runningMessage);
    while(!signal.aborted){
      if(getProducts)products=await getProducts();
      const results=await withMonitoringRead(()=>transport.run(collect));
      if(signal.aborted)break;
      for(const {ok,product,value,erro} of results)onResult(product.id,ok?value:{error:erro.message});
      // Re-verificação instantânea: re-consulta produtos que acabaram de ser detectados como disponíveis.
      while(recheckQueue.length&&!signal.aborted){
        const toRecheck=[...recheckQueue];recheckQueue.length=0;
        const recheckResults=await withMonitoringRead(()=>transport.run(async browser=>{
          const out=[];
          for(const product of toRecheck){
            if(signal.aborted)break;
            const result=await recheckProduct(browser,product);
            if(result)out.push({ok:!result.error,product,result,erro:result.error?new Error(result.error):null});
          }
          return out;
        }));
        if(signal.aborted)break;
        for(const {product,result} of recheckResults)onResult(product.id,result);
      }
      onCycle({ids:products.map(p=>p.id),ok:results.every(result=>result.ok)});
      next+=15_000;
      if(next<Date.now()+500)next+=Math.ceil((Date.now()+500-next)/15_000)*15_000;
      await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,Math.max(0,next-Date.now()));signal.addEventListener('abort',finish,{once:true});if(signal.aborted)finish();});
    }
  } finally {await transport.close();}
}

