import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { request as httpRequest } from 'node:http';
import { createApplication } from '../server.mjs';
import { apiVersion } from '../panel-api.mjs';
import { productIdentity, productInput, applyObservation, amazonObservation, confirmML } from '../server/model.mjs';
import { mlResponse, startAmazon } from '../server/adapters.mjs';
import { extrairEstado, classificar } from '../server/ml-v3-core.mjs';
import { accountKeys, chromeProfile, profileFetch, createProfilePool } from '../server/profiles.mjs';
import { createMetadataParser, safeProductImage, applyMetadata } from '../server/metadata.mjs';
import { patchProductCard } from '../cards.js';
import { defaults, qualifyObservation, reputationMatches, deliveryLabel } from '../server/availability.mjs';

const item=(n=1,store='amazon')=>({store,name:`Produto ${n}`,url:store==='amazon'?`https://www.amazon.com.br/dp/B0000000${String(n).padStart(2,'0')}`:`https://produto.mercadolivre.com.br/MLB-${1000+n}-_JM`,target:100});
const projectRoot=process.env.MONITOR_PROJECT_ROOT??resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const html=(overrides={})=>`<script id="__NORDIC_RENDERING_CTX__">_n.ctx.r = ${JSON.stringify({appProps:{pageProps:{initialState:{id:'MLB1001',no_active_item:false,track:{melidata_event:{event_data:{item_id:'MLB1001',seller_id:123,item_status:'active',has_stock:true,price:99.9,...overrides}}}}}}})};</script>`;

async function application(fn,adapters={},loginOpener) {
  const data=await mkdtemp(join(tmpdir(),'vigia-test-'));
  let app;
  try {
    app=await createApplication({dataDirectory:data,adapters:{amazon:async()=>{},ml:async()=>{},...adapters},referenceProducts:[item()],loginOpener,notifier:async()=>{}});
    app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
    const url=`http://127.0.0.1:${app.server.address().port}`;
    const initial=await(await fetch(url+'/api/state')).json();
    assert.equal(initial.apiVersion,apiVersion);
    const request=async(path,method='GET',input,headers={})=>{
      const response=await fetch(url+'/api/'+path,{method,headers:method==='GET'?headers:{'Content-Type':'application/json','X-Vigia-Token':initial.token,...headers},body:method==='GET'?undefined:JSON.stringify(input??{})});
      return {status:response.status,body:await response.json()};
    };
    await fn({app,request,url,data});
  } finally {if(app)await app.close();await rm(data,{recursive:true,force:true});}
}
test('API persists products, rejects duplicates and enforces ten per store',()=>application(async({request,data})=>{
  assert.equal((await request('products','POST',item())).status,200);
  assert.equal((await request('products','POST',item())).status,400);
  for(let n=2;n<=10;n++)assert.equal((await request('products','POST',item(n))).status,200);
  assert.equal((await request('products','POST',item(11))).status,400);
  assert.equal((await request('products','POST',item(1,'ml'))).status,200);
  const persisted=JSON.parse(await readFile(join(data,'registry.json'),'utf8'));
  assert.equal(persisted.products.length,11);
  assert.equal(persisted.products[0].lastCheckedAt,null);
}));
test('catalog identity honors selected item, prevents unrelated hosts and missing selection',()=>{
  const parsed=productIdentity('https://www.mercadolivre.com.br/test/p/MLB999?pdp_filters=item_id%3AMLB123','ml');
  assert.equal(parsed.code,'MLB123');assert.equal(parsed.catalog,'MLB999');
  assert.throws(()=>productIdentity('https://www.mercadolivre.com.br/test/p/MLB999','ml'));
  assert.throws(()=>productIdentity('https://www.amazon.com.br.evil.test/dp/B000000001','amazon'));
  assert.throws(()=>productIdentity('http://www.amazon.com.br/dp/B000000001','amazon'));
  assert.throws(()=>productIdentity('https://user:secret@www.amazon.com.br/dp/B000000001','amazon'));
});
test('last successful read survives errors; attempt time is separate',()=>{
  const p=productInput(item());
  applyObservation(p,{at:'2026-11-05T13:00:00.000Z',price:99,available:true,seller:'Loja',delivery:'Amazon'});
  applyObservation(p,{at:'2026-11-05T13:01:00.000Z',error:'HTTP 429'});
  assert.equal(p.lastCheckedAt,'2026-11-05T13:00:00.000Z');assert.equal(p.lastAttemptAt,'2026-11-05T13:01:00.000Z');
  assert.equal(p.price,99);assert.equal(p.available,true);assert.equal(p.observation,'DESATUALIZADO');
});
test('Amazon absence remains unknown; known offer uses normal price and actual shipping',()=>{
  const absent=amazonObservation({horario:'2026-11-05T13:00:00Z',ofertas:[],cobertura:'PRIMEIRA_PAGINA_PARCIAL'});
  assert.equal(absent.available,null);assert.equal(absent.observation,'NAO_OBSERVADO');
  const offer=amazonObservation({ofertas:[{precoNormalCentavos:12345,freteCentavos:1000,vendedor:'Loja',enviadoPor:'Amazon'}]});
  assert.equal(offer.price,123.45);assert.equal(offer.freight,10);
});
test('ML v3 parsing validates offer and seller, paused listings never trigger availability',async()=>{
  const product=productInput({...item(1,'ml'),expectedSellerId:'123'});
  const good=await mlResponse(product,{http:200,urlFinal:product.url,html:html()});
  assert.equal(good.available,true);assert.equal(good.price,99.9);
  const mismatch=await mlResponse(product,{http:200,urlFinal:product.url,html:html({seller_id:999})});
  assert.equal(mismatch.available,null);assert.equal(mismatch.price,null);assert.equal(mismatch.observation,'identity_mismatch');
  const paused=await mlResponse(product,{http:200,urlFinal:product.url,html:html({item_status:'paused',has_stock:true})});
  assert.equal(paused.available,false);
  assert.throws(()=>extrairEstado('<html>Login</html>'));
  assert.equal(classificar({id:'MLB1001',vendedorEsperado:'123'},{idPagina:'MLB1001',idOferta:'MLB9999',vendedor:123,hasStock:true}),'identity_mismatch');
});
test('ML stops on HTTP restrictions, account challenges, wrong origin and malformed HTML',async()=>{
  const p=productInput(item(1,'ml'));
  for(const response of [
    {http:429,urlFinal:p.url,html:html()},
    {http:200,urlFinal:'https://www.mercadolivre.com.br/gz/account-verification',html:html()},
    {http:200,urlFinal:'https://evil.test/',html:html()},
    {http:200,urlFinal:p.url,html:'<html></html>'},
    {http:200,urlFinal:p.url,timeout:true},
  ])await assert.rejects(mlResponse(p,response));
});
test('API rejects cross-origin requests, missing CSRF token and private file access',()=>application(async({request,url})=>{
  assert.equal((await request('products','POST',item(),{'X-Vigia-Token':'bad'})).status,403);
  assert.equal((await request('state','GET',null,{Origin:'https://evil.test'})).status,403);
  assert.equal((await fetch(url+'/.data/registry.json')).status,404);
  assert.equal((await fetch(url+'/server.mjs')).status,404);
  const wrongHost=await new Promise((resolve,reject)=>{const req=httpRequest(url+'/',{headers:{Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(wrongHost,403);
  const home=await fetch(url+'/');assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy'),/frame-ancestors 'none'/);
}));
test('monitor integration updates UI state and persists timestamps; stop is awaited',async()=>{
  let stopped=false;
  await application(async({request,data})=>{
    await request('products','POST',item());
    assert.equal((await request('monitor/start','POST')).status,200);
    const live=(await request('state')).body;
    assert.equal(live.products[0].lastCheckedAt,'2026-11-05T14:15:16.000Z');assert.equal(live.running,true);
    assert.equal((await request('products','POST',item(2))).status,400);
    assert.equal((await request('monitor/start','POST')).status,400);
    assert.equal((await request('monitor/stop','POST')).body.running,false);
    assert.equal(stopped,true);
    const persisted=JSON.parse(await readFile(join(data,'registry.json'),'utf8'));
    assert.equal(persisted.products[0].price,88.5);
  },{amazon:async({products,signal,onStatus,onResult})=>{
    onStatus('running','Test adapter');onResult(products[0].id,{at:'2026-11-05T14:15:16.000Z',price:88.5,available:true});
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));stopped=true;
  }});
});
test('blocked store remains visible without stopping the other store',()=>application(async({request})=>{
  await request('products','POST',item());await request('products','POST',item(1,'ml'));
  await request('monitor/start','POST');
  const state=(await request('state')).body;
  assert.equal(state.shops.amazon.status,'error');assert.match(state.shops.amazon.message,/HTTP 403/);
  assert.equal(state.shops.ml.status,'running');assert.equal(state.running,true);
  await request('monitor/stop','POST');
},{amazon:async()=>{throw new Error('HTTP 403');},ml:async({signal,onStatus})=>{onStatus('running','ML test');await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}}));
test('project import is explicit, idempotent, and preserves customized rules',()=>application(async({request})=>{
  assert.equal((await request('state')).body.products.length,0);
  const first=(await request('import','POST')).body.products[0];
  await request('products/'+first.id,'PATCH',{target:75,alert:true});
  const second=(await request('import','POST')).body.products;
  assert.equal(second.length,1);assert.equal(second[0].target,75);assert.equal(second[0].alert,true);
}));
test('only one local service can own a registry, and data reloads after shutdown',async()=>{
  const data=await mkdtemp(join(tmpdir(),'vigia-restart-'));let app;
  try{
    app=await createApplication({dataDirectory:data});await app.service.add(item());
    app.service.observe(app.service.registry.products[0].id,{at:'2026-11-05T16:00:00Z',price:50,available:true});
    await assert.rejects(createApplication({dataDirectory:data}),/já está aberto/);
    await app.close();app=null;
    app=await createApplication({dataDirectory:data});assert.equal(app.service.registry.products[0].lastCheckedAt,'2026-11-05T16:00:00Z');assert.equal(app.service.state().running,false);
  }finally{if(app)await app.close();await rm(data,{recursive:true,force:true});}
});
test('startup persists auto-purchase off for legacy pending Pix before serving the panel',async()=>{
  const data=await mkdtemp(join(tmpdir(),'vigia-pix-recovery-'));let app;
  try{
    const products=[productInput({...item(1,'ml'),auto:true,alert:true}),productInput({...item(2,'ml'),auto:true,alert:true})];
    await writeFile(join(data,'registry.json'),JSON.stringify({schemaVersion:1,products,purchaseOrders:[{id:'legacy',status:'PIX_PENDING',items:[{productId:products[0].id}]}]}));
    app=await createApplication({dataDirectory:data,notifier:async()=>{}});
    assert.deepEqual(app.service.state().products.map(p=>p.auto),[false,true]);
    const saved=JSON.parse(await readFile(join(data,'registry.json'),'utf8'));assert.deepEqual(saved.products.map(p=>p.auto),[false,true]);assert.ok(saved.products.every(p=>p.alert));
    assert.equal(saved.purchaseOrders[0].status,'PIX_PENDING');assert.ok(saved.purchaseOrders[0].autoDisabledAt);assert.equal(app.service.state().running,false);
  }finally{if(app)await app.close();await rm(data,{recursive:true,force:true});}
});

test('actual Amazon v0.3 adapter processes an offline observation and releases its store lock',async()=>{
  const root=projectRoot;
  const data=await mkdtemp(join(tmpdir(),'vigia-aod-adapter-'));
  const controller=new AbortController();const results=[];const statuses=[];
  try{
    const products=[productInput({...item(),name:''})];
    await startAmazon({projectRoot:root,dataDirectory:data,products,getProducts:async()=>products,signal:controller.signal,
      onResult:(id,result)=>{results.push(result);controller.abort();},onEvent:()=>{},onStatus:(status)=>statuses.push(status),
      consultar:async()=>({totalInformado:1,totalLista:1,totalVisivel:1,cobertura:'PRIMEIRA_PAGINA_COMPLETA',ofertas:[{sellerId:'AMAZON',categoria:'AMAZON_DIRETA',vendedor:'Amazon.com.br',enviadoPor:'Amazon',precoNormalCentavos:8990,freteCentavos:0,minQty:1,maxQty:2}]})});
    assert.equal(results.length,1);assert.equal(results[0].price,89.9);assert.equal(results[0].available,true);
    assert.ok(Date.parse(results[0].at));assert.ok(statuses.includes('running'));
    const state=JSON.parse(await readFile(join(data,'amazon','state.json'),'utf8'));
    assert.equal(state.products.B000000001.snapshot.ofertas[0].precoNormalCentavos,8990);
    const {access}=await import('node:fs/promises');await assert.rejects(access(join(data,'amazon','monitor.lock')));
  }finally{await rm(data,{recursive:true,force:true});}
});

test('unnamed products use collected titles and can switch back from a manual name',async()=>{
  const data=await mkdtemp(join(tmpdir(),'vigia-product-names-'));
  let app;
  try{
    app=await createApplication({dataDirectory:data,root:projectRoot,notifier:async()=>{}});
    for(const store of ['amazon','ml']){
      const input={...item(1,store),name:'  '};
      await app.service.add(input);
      const product=app.service.state().products.find(p=>p.store===store);
      assert.equal(product.name,'');
      const title='Título do anúncio '+store;
      app.service.observe(product.id,{title,price:50,available:true});
      assert.equal(app.service.state().products.find(p=>p.id===product.id).title,title);
      await app.service.edit(product.id,{name:'Meu nome'});
      assert.equal(app.service.state().products.find(p=>p.id===product.id).name,'Meu nome');
      await app.service.edit(product.id,{name:''});
      const edited=app.service.state().products.find(p=>p.id===product.id);
      assert.equal(edited.name,'');
      assert.equal(edited.title,title);
    }
    await app.close();app=await createApplication({dataDirectory:data,root:projectRoot,notifier:async()=>{}});
    assert.deepEqual(app.service.state().products.map(p=>[p.name,p.title]),[['','Título do anúncio amazon'],['','Título do anúncio ml']]);
  }finally{if(app)await app.close();await rm(data,{recursive:true,force:true});}
});

test('ML adapter interprets actual saved HTML without executing embedded scripts',async()=>{
  const root=projectRoot;
  const saved=await readFile(join(root,'Mercado_Livre','moltres-MLB5214725509.html'),'utf8');
  const product=productInput({store:'ml',name:'Moltres Mini',url:'https://produto.mercadolivre.com.br/MLB-5214725509-_JM',expectedSellerId:'768826009'});
  const result=await mlResponse(product,{http:200,urlFinal:product.url,html:saved});
  assert.ok(Date.parse(result.at));assert.ok(['unavailable','available','unknown','identity_mismatch','unknown_identity'].includes(result.observation));
});

test('ML alerts require consecutive valid readings and do not duplicate after restart',()=>{
  const p=productInput(item(1,'ml'));
  const observation={available:true,price:50,seller:'Vendedor 123',observation:'available'};
  assert.equal(confirmML(p,observation).length,0);
  assert.equal(confirmML(p,{error:'timeout'}).length,0);
  assert.equal(confirmML(p,observation).length,0);
  assert.deepEqual(confirmML(p,observation).map(e=>e.type),['DISPONIBILIDADE_CONFIRMADA','ALVO_ATINGIDO']);
  const reloaded=JSON.parse(JSON.stringify(p));
  assert.equal(confirmML(reloaded,observation).length,0);
  assert.equal(confirmML(reloaded,{...observation,observation:'identity_mismatch'}).length,0);
  assert.equal(confirmML(reloaded,observation).length,0);
  assert.equal(confirmML(reloaded,observation).length,0);
});

test('two Chrome profiles separate purposes and share both stores, preserving the ML v3 login',()=>{
  const profiles=accountKeys.map(key=>chromeProfile(projectRoot,join(projectRoot,'interface','.data'),...key.split('/')));
  assert.equal(new Set(profiles.map(p=>p.userDataDir.toLowerCase())).size,2);
  assert.equal(profiles.find(p=>p.key==='ml/monitor').userDataDir,join(projectRoot,'Mercado_Livre','perfis','ml-chrome-headless-v3'));
  assert.equal(profiles[0].userDataDir,profiles[2].userDataDir);assert.equal(profiles[1].userDataDir,profiles[3].userDataDir);assert.notEqual(profiles[0].userDataDir,profiles[1].userDataDir);
  assert.throws(()=>chromeProfile(projectRoot,'data','amazon','../../monitor'));
});

test('four login routes use two profile purposes and close only their own store tab',async()=>{
  const opened=[];const browsers=[];
  await application(async({request})=>{
    for(const key of accountKeys){
      const response=await request('accounts/'+key+'/open','POST');
      assert.equal(response.status,200);assert.equal(response.body.accounts[key].status,'open');
    }
    assert.equal(opened.length,4);
    assert.equal(new Set(opened.map(p=>p.key)).size,4);
    assert.equal((await request('accounts/amazon/monitor/open','POST')).status,400);
    const closed=(await request('accounts/amazon/monitor/close','POST')).body.accounts;
    assert.equal(closed['amazon/monitor'].status,'closed');assert.equal(closed['amazon/purchase'].status,'open');assert.equal(closed['ml/monitor'].status,'open');
  },{},async options=>{
    opened.push(chromeProfile(options.projectRoot,options.dataDirectory,options.store,options.purpose));
    const browser=new EventEmitter();browser.closed=false;browser.close=async()=>{browser.closed=true;browser.emit('disconnected');};browsers.push(browser);return browser;
  });
  assert.ok(browsers.every(b=>b.closed));
});

test('monitor profile cannot be opened while in use; purchase session remains independent',()=>application(async({request})=>{
  await request('products','POST',item());
  await request('accounts/ml/monitor/open','POST');
  assert.equal((await request('monitor/start','POST')).status,400);
  await request('accounts/ml/monitor/close','POST');
  await request('accounts/amazon/purchase/open','POST');
  assert.equal((await request('monitor/start','POST')).status,200);
  assert.equal((await request('accounts/amazon/monitor/open','POST')).status,400);
  assert.equal((await request('accounts/ml/monitor/open','POST')).status,400);
  assert.equal((await request('accounts/amazon/purchase/close','POST')).status,200);
  assert.equal((await request('state')).body.running,true);
  await request('monitor/stop','POST');
},{amazon:async({signal,onStatus})=>{onStatus('running','Test');await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}},async()=>{
  const browser=new EventEmitter();browser.close=async()=>browser.emit('disconnected');return browser;
}));

test('Amazon transport fetches within the profile and rejects sign-in and external redirects',async()=>{
  let options;let response={status:200,url:'https://www.amazon.com.br/gp/product/ajax/aodAjaxMain/?asin=B000000001',html:'<html>Offer</html>'};
  const page={evaluate:async(fn,args)=>runInNewContext(`(${fn.toString()})(args)`,{args,AbortController,setTimeout,clearTimeout,fetch:async(url,init)=>{options=init;return {status:response.status,url:response.url,text:async()=>response.html};}})};
  const request=profileFetch(page);
  const result=await request(response.url);
  assert.equal(options.credentials,'same-origin');assert.equal(await result.text(),'<html>Offer</html>');
  response={...response,url:'https://www.amazon.com.br/ap/signin'};
  await assert.rejects(request('https://www.amazon.com.br/gp/product/ajax/aodAjaxMain/'),/login/);
  response={...response,url:'https://evil.test/'};
  await assert.rejects(request('https://www.amazon.com.br/gp/product/ajax/aodAjaxMain/'),/login/);
  await assert.rejects(request('https://evil.test/'),/Origem/);
});


test('shared profile pool launches Chrome once for both monitors and releases only after the last consumer',async()=>{
  const launched=[];
  const pool=createProfilePool(async options=>{
    const browser=new EventEmitter();browser.closed=false;browser.pages=[];
    browser.newPage=async()=>{const page=new EventEmitter();page.closed=false;page.close=async()=>{page.closed=true;page.emit('close');};browser.pages.push(page);return page;};
    browser.close=async()=>{for(const page of browser.pages)if(!page.closed)await page.close();browser.closed=true;browser.emit('disconnected');};
    launched.push({browser,options});return {browser};
  });
  const base={projectRoot,dataDirectory:join(projectRoot,'interface','.data'),purpose:'monitor',headless:true};
  const [amazon,ml]=await Promise.all([pool.acquire({...base,store:'amazon'}),pool.acquire({...base,store:'ml'})]);
  assert.equal(launched.length,1);
  const amazonPage=await amazon.browser.newPage();const mlPage=await ml.browser.newPage();
  const purchase=await pool.acquire({...base,store:'amazon',purpose:'purchase',headless:false});
  assert.equal(launched.length,2);
  await assert.rejects(pool.acquire({...base,store:'amazon',headless:false}),/compartilhado/);
  await amazon.browser.close();
  assert.equal(amazonPage.closed,true);assert.equal(mlPage.closed,false);assert.equal(launched[0].browser.closed,false);
  await ml.browser.close();assert.equal(mlPage.closed,true);assert.equal(launched[0].browser.closed,true);
  assert.equal(launched[1].browser.closed,false);
  await purchase.browser.close();assert.equal(launched[1].browser.closed,true);
});

test('profile launch failure allows a clean retry',async()=>{
  let launches=0;
  const pool=createProfilePool(async()=>{if(++launches===1)throw new Error('Chrome unavailable');const browser=new EventEmitter();browser.close=async()=>browser.emit('disconnected');return {browser};});
  const options={projectRoot,dataDirectory:join(projectRoot,'interface','.data'),store:'amazon',purpose:'monitor',headless:true};
  await assert.rejects(pool.acquire(options),/unavailable/);
  const lease=await pool.acquire(options);assert.equal(launches,2);await lease.browser.close();
});

test('saved Amazon AOD already contains the product title and product image',async()=>{
  const parse=createMetadataParser(projectRoot);
  for(const asin of ['B000GAYQJ0','B0HC8JZC1D','B0HCCTKPGN']) {
    const html=await readFile(join(projectRoot,'Amazon',`aod-${asin}.html`),'utf8');
    const metadata=parse(html,'amazon');
    assert.ok(metadata.title.length>10);assert.match(metadata.imageUrl,/^https:\/\/m\.media-amazon\.com\/images\/I\//);
    assert.doesNotMatch(metadata.title,/Filtrar por/);
  }
});

test('ML metadata is read from existing HTML only when the selected offer identity matches',async()=>{
  const parse=createMetadataParser(projectRoot);
  const html=await readFile(join(projectRoot,'Mercado_Livre','moltres-MLB5214725509.html'),'utf8');
  const product=productInput({store:'ml',name:'Moltres',url:'https://produto.mercadolivre.com.br/MLB-5214725509-_JM',expectedSellerId:'768826009'});
  const result=await mlResponse(product,{http:200,urlFinal:product.url,html},parse);
  assert.equal(result.title,'Moltres Dia');assert.match(result.imageUrl,/^https:\/\/http2\.mlstatic\.com\/D_NQ_NP_/);
  const divergent=await mlResponse({...product,expectedSellerId:'999999'},{http:200,urlFinal:product.url,html},parse);
  assert.equal(divergent.title,undefined);assert.equal(divergent.imageUrl,undefined);
});

test('metadata preserves manual name and successful read time; errors retain the last image',()=>{
  const p=productInput(item());const url='https://m.media-amazon.com/images/I/test.jpg';
  applyMetadata(p,{title:'Official product title',imageUrl:url,metadataSource:'saved-test-html'});
  assert.equal(p.name,'Produto 1');assert.equal(p.title,'Official product title');assert.equal(p.lastCheckedAt,null);
  applyObservation(p,{error:'HTTP 403'});assert.equal(p.imageUrl,url);
  assert.equal(safeProductImage('https://evil.test/product.jpg','amazon'),null);
  assert.equal(safeProductImage('javascript:alert(1)','ml'),null);
  assert.equal(safeProductImage('https://m.media-amazon.com/images/S/logo.svg','amazon'),null);
  assert.equal(safeProductImage(url,'ml'),null);
});

test('identical title and image do not update metadata or its change timestamp',()=>{
  const p=productInput(item());
  const metadata={title:'Product title',imageUrl:'https://m.media-amazon.com/images/I/one.jpg'};
  assert.equal(applyMetadata(p,metadata,'2026-11-05T10:00:00Z'),true);
  assert.equal(applyMetadata(p,{...metadata,title:' Product   title '},'2026-11-05T10:01:00Z'),false);
  assert.equal(p.metadataAt,'2026-11-05T10:00:00Z');
  assert.equal(applyMetadata(p,{},'2026-11-05T10:02:00Z'),false);
  assert.equal(p.imageUrl,metadata.imageUrl);
  assert.equal(applyMetadata(p,{...metadata,imageUrl:'https://m.media-amazon.com/images/I/two.jpg'},'2026-11-05T10:03:00Z'),true);
  assert.equal(p.metadataAt,'2026-11-05T10:03:00Z');
});

test('price and last-read refresh preserve existing photo and title elements',()=>{
  const replaced=[];
  const before=new Map(),after=new Map();
  for(const selector of ['.product-art','.product-title','.product-tags','.seller-info','.last-check','.price-area','.product-actions','.product-controls']){
    before.set(selector,{outerHTML:selector+' same',replaceWith:()=>replaced.push(selector)});
    after.set(selector,{outerHTML:selector+' same'});
  }
  after.get('.last-check').outerHTML='new last-read timestamp';after.get('.price-area').outerHTML='new price';
  const current={className:'product-card',querySelector:selector=>before.get(selector)??null};
  const next={className:'product-card',querySelector:selector=>after.get(selector)??null};
  const photo=before.get('.product-art'),title=before.get('.product-title');
  patchProductCard(current,next);
  assert.deepEqual(replaced,['.last-check','.price-area']);assert.equal(before.get('.product-art'),photo);assert.equal(before.get('.product-title'),title);
});

test('ML saved HTML exposes Full logistics, green 5 and Platinum without confusing medal and color',async()=>{
  const source=await readFile(join(projectRoot,'Mercado_Livre','moltres-MLB5214725509.html'),'utf8');
  const p=productInput({store:'ml',name:'Moltres',url:'https://produto.mercadolivre.com.br/MLB-5214725509-_JM',expectedSellerId:'768826009'});
  const result=await mlResponse(p,{http:200,urlFinal:p.url,html:source});
  assert.equal(result.delivery,'Mercado Envios Full');assert.equal(result.reputationLevel,'5_green');assert.equal(result.powerSellerStatus,'platinum');
  const bota=extrairEstado(await readFile(join(projectRoot,'Mercado_Livre','bota-MLB801319673.html'),'utf8'));
  assert.equal(deliveryLabel(bota.shippingMode,bota.logisticType),'Mercado Envios Coleta');
  assert.equal(deliveryLabel(null,null),'Não informado');
});

test('green 5 accepts only green 5; unknown reputation and a Platinum medal cannot replace the color',()=>{
  assert.equal(reputationMatches('5_green',null,'5_green'),true);
  assert.equal(reputationMatches('4_light_green','platinum','5_green'),false);
  assert.equal(reputationMatches(null,'platinum','5_green'),false);
  assert.equal(reputationMatches('5_green',null,'platinum'),false);
  assert.equal(reputationMatches('5_green','platinum','gold'),true);
  const settings=defaults();settings.ml.requireReputation=true;
  const base={available:true,price:50,observation:'available',reputationLevel:'4_light_green',powerSellerStatus:'platinum'};
  const result=qualifyObservation(base,'ml',settings);
  assert.equal(result.available,false);assert.equal(result.rawAvailable,true);assert.equal(result.eligible,false);
  assert.equal(qualifyObservation({...base,reputationLevel:'5_green'},'ml',settings).available,true);
  assert.equal(qualifyObservation({...base,available:false,reputationLevel:'5_green'},'ml',settings).available,false);
});

test('Amazon-only filter selects the direct offer even when a fulfilled third-party offer is cheaper',()=>{
  const settings=defaults();settings.amazon.onlyAmazon=true;
  const result={available:true,amazonOffers:[
    {categoria:'TERCEIRO_ENVIO_AMAZON',vendedor:'Terceiro',enviadoPor:'Amazon',precoNormalCentavos:1000},
    {categoria:'AMAZON_DIRETA',vendedor:'Amazon.com.br',enviadoPor:'Amazon',precoNormalCentavos:9000}
  ]};
  const qualified=qualifyObservation(result,'amazon',settings);
  assert.equal(qualified.price,90);assert.equal(qualified.seller,'Amazon.com.br');assert.equal(qualified.available,true);
  const thirdParty=qualifyObservation({...result,amazonOffers:result.amazonOffers.slice(0,1)},'amazon',settings);
  assert.equal(thirdParty.available,false);assert.equal(thirdParty.rawAvailable,true);assert.equal(thirdParty.eligible,false);
});

test('settings API validates, persists, reevaluates availability and passes rules to the collectors',()=>application(async({app,request,data})=>{
  const product=(await request('products','POST',item(1,'ml'))).body.products[0];
  app.service.observe(product.id,{at:'2026-11-05T13:00:00Z',available:true,reputationLevel:'4_light_green',powerSellerStatus:'platinum',observation:'available'});
  const settings=defaults();settings.ml.requireReputation=true;
  settings.amazon.purchase.enabled=true;settings.amazon.purchase.freeShippingOnly=true;
  const response=await request('settings','PATCH',settings);assert.equal(response.status,200);assert.equal(response.body.apiVersion,apiVersion);assert.equal(response.body.products[0].available,false);
  assert.deepEqual(response.body.settings.amazon.purchase,settings.amazon.purchase);
  assert.equal(response.body.products[0].lastCheckedAt,'2026-11-05T13:00:00Z');
  const bad=structuredClone(settings);bad.ml.minReputation='bogus';assert.equal((await request('settings','PATCH',bad)).status,400);
  const saved=JSON.parse(await readFile(join(data,'registry.json'),'utf8'));assert.equal(saved.settings.ml.minReputation,'5_green');
  assert.deepEqual(saved.settings.amazon.purchase,settings.amazon.purchase);
  await request('monitor/start','POST');assert.equal((await request('settings','PATCH',defaults())).status,400);await request('monitor/stop','POST');
},{ml:async({settings,signal,onStatus})=>{assert.equal(settings.ml.requireReputation,true);onStatus('running','test');await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}}));

test('editing product links preserves rules but clears data belonging to a different listing',()=>application(async({app,request})=>{
  const p=(await request('products','POST',{...item(),alert:true,auto:true})).body.products[0];
  app.service.observe(p.id,{available:true,price:50,title:'Previous title',imageUrl:'https://m.media-amazon.com/images/I/old.jpg',at:'2026-11-05T10:00:00Z'});
  const same=await request('products/'+p.id,'PATCH',{url:item().url+'?ref=test'});
  assert.equal(same.body.products[0].price,50);assert.equal(same.body.products[0].title,'Previous title');
  const changed=await request('products/'+p.id,'PATCH',{url:item(2).url,name:'Edited product'});
  const edited=changed.body.products[0];assert.equal(edited.id,p.id);assert.equal(edited.code,'B000000002');assert.equal(edited.price,null);assert.equal(edited.lastCheckedAt,null);
  assert.equal(edited.title,undefined);assert.equal(edited.imageUrl,undefined);assert.equal(edited.auto,false);assert.equal(edited.alert,true);assert.equal(edited.target,100);
  await request('products','POST',item(3));assert.equal((await request('products/'+p.id,'PATCH',{url:item(3).url})).status,400);
}));

test('ML filtering prevents confirmed availability and target alerts',()=>{
  const product=productInput(item(1,'ml'));const rules=defaults();rules.ml.requireReputation=true;
  const result=qualifyObservation({available:true,price:50,reputationLevel:'4_light_green',observation:'available'},'ml',rules);
  assert.equal(confirmML(product,result).length,0);assert.equal(confirmML(product,result).length,0);
  const green=qualifyObservation({...result,available:true,rawAvailable:true,reputationLevel:'5_green'},'ml',rules);
  assert.equal(confirmML(product,green).length,0);assert.deepEqual(confirmML(product,green).map(e=>e.type),['DISPONIBILIDADE_CONFIRMADA','ALVO_ATINGIDO']);
});

test('ML supports green alone, MercadoLider alone, both criteria, or either criterion',()=>{
  const settings=defaults();const available={available:true,observation:'available',reputationLevel:'5_green',powerSellerStatus:null};
  settings.ml.requireReputation=true;
  assert.equal(qualifyObservation(available,'ml',settings).available,true);
  settings.ml.requireReputation=false;settings.ml.requireLeader=true;
  assert.equal(qualifyObservation(available,'ml',settings).available,false);
  assert.equal(qualifyObservation({...available,reputationLevel:null,powerSellerStatus:'silver'},'ml',settings).available,true);
  settings.ml.requireReputation=true;settings.ml.matchMode='all';
  assert.equal(qualifyObservation(available,'ml',settings).available,false);
  assert.equal(qualifyObservation({...available,powerSellerStatus:'platinum'},'ml',settings).available,true);
  settings.ml.matchMode='any';
  assert.equal(qualifyObservation(available,'ml',settings).available,true);
  assert.equal(qualifyObservation({...available,reputationLevel:null,powerSellerStatus:'silver'},'ml',settings).available,true);
  assert.equal(qualifyObservation({...available,reputationLevel:null,powerSellerStatus:null},'ml',settings).available,false);
});

test('saving identical settings preserves confirmed ML alerts',()=>application(async({app,request})=>{
  const p=(await request('products','POST',item(1,'ml'))).body.products[0];
  const result={available:true,price:50,reputationLevel:'5_green',observation:'available'};
  app.service.observe(p.id,result);app.service.observe(p.id,result);
  const events=app.service.events.length;await request('settings','PATCH',defaults());
  app.service.observe(p.id,result);app.service.observe(p.id,result);
  assert.equal(app.service.events.length,events);
}));

test('ML seller parser displays the actual store name and keeps seller IDs for validation',async()=>{
  for(const [file,id,sellerId,expectedName] of [
    ['moltres-MLB5214725509.html','MLB5214725509','768826009','Pokémon'],
    ['bota-MLB801319673.html','MLB801319673','170885659','Acero']
  ]){
    const html=await readFile(join(projectRoot,'Mercado_Livre',file),'utf8');
    const p=productInput({store:'ml',name:'Test',url:`https://produto.mercadolivre.com.br/MLB-${id.slice(3)}-_JM`,expectedSellerId:sellerId});
    const result=await mlResponse(p,{http:200,urlFinal:p.url,html});
    assert.equal(result.seller,expectedName);assert.equal(result.sellerId,sellerId);
    const mismatch=await mlResponse({...p,expectedSellerId:'999'},{http:200,urlFinal:p.url,html});
    assert.equal(mismatch.seller,'Não informado');assert.equal(mismatch.sellerId,null);
  }
});

test('seller labels from a different seller or offer are ignored',()=>{
  const state={id:'MLB1001',track:{melidata_event:{event_data:{seller_id:123,item_id:'MLB1001'}}},components:{
    seller_summary:{seller:{id:999,name:'Wrong store'}},
    seller_data:{viewport_track:{melidata_event:{event_data:{seller_id:123,item_id:'MLB9999',shop_name:'Different offer'}}},components:[{id:'seller_header',title:{text:'Different offer'}}]}
  }};
  const html=`<script id="__NORDIC_RENDERING_CTX__">_n.ctx.r=${JSON.stringify({appProps:{pageProps:{initialState:state}}})}</script>`;
  assert.equal(extrairEstado(html).sellerName,null);
});

test('switching the seller display from ID to a name does not generate duplicate ML alerts',()=>{
  const p=productInput(item(1,'ml'));const base={available:true,price:50,observation:'available',seller:'Vendedor 123'};
  confirmML(p,base);assert.equal(confirmML(p,base).length,2);
  const renamed={...base,seller:'Actual store',sellerId:'123'};
  assert.equal(confirmML(p,renamed).length,0);assert.equal(confirmML(p,{...renamed,seller:'New display name'}).length,0);
});
