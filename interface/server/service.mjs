import { startAmazon, startML } from './adapters.mjs';

import { productInput, applyObservation, confirmML } from './model.mjs';

import { accountKeys, chromeProfile, openAccountLogin } from './profiles.mjs';

import { defaults, validateSettings, qualifyObservation } from './availability.mjs';

import { PurchaseManager } from './purchase-manager.mjs';

import { notifySystem } from './system-notifications.mjs';

import { randomUUID } from 'node:crypto';

import { MonitorLog } from './monitor-log.mjs';

import { MonitoringGate } from './monitoring-gate.mjs';

import { isCaptchaError, openProductCaptcha } from './captcha-resolver.mjs';


const active=status=>['starting','running','reconnecting','stopping'].includes(status);

export class MonitoringService {

  constructor({registry,save,projectRoot,dataDirectory,adapters={amazon:startAmazon,ml:startML},loginOpener=openAccountLogin,captchaOpener=openProductCaptcha,notifier=notifySystem,purchaseRunner}) {

    Object.assign(this,{registry,save,projectRoot,dataDirectory,adapters,loginOpener,captchaOpener,notifier});
    this.activeCaptcha=null;

    // Callbacks que os adaptadores registram para re-verificação instantânea.
    this.recheckHandlers=new Map();

    this.settings=validateSettings(registry.settings??defaults());registry.settings=this.settings;

    this.shops={amazon:{status:'stopped',message:'Amazon AOD v0.3'},ml:{status:'stopped',message:'ML persistente v3'}};

    this.jobs=new Map();this.events=Array.isArray(registry.events)?registry.events.slice(-100):[];this.logins=new Map();this.loginTasks=new Map();this.storageError=null;

    registry.notificationOutbox??=[];for(const n of registry.notificationOutbox)if(n.status==='SENDING')n.status='UNKNOWN';

    this.notificationQueue=Promise.resolve();
    registry.availabilityHistory??=[];

    this.monitorGate=new MonitoringGate();this.log=new MonitorLog(dataDirectory);this.cycleProducts=new Map();this.configQueue=Promise.resolve();this.cycleSequence={amazon:0,ml:0};this.runId=randomUUID();registry.pendingProductEdits??={};
    this.recoveryLog=new MonitorLog(dataDirectory,'monitoring');

    this.purchases=new PurchaseManager({registry,save,projectRoot,dataDirectory,runner:purchaseRunner,getSettings:()=>this.settings,getProducts:()=>registry.products,

      getExpectedStores:()=>['amazon','ml'].filter(store=>registry.products.some(p=>p.store===store)),isPurchaseProfileOpen:()=>['amazon/purchase','ml/purchase'].some(key=>this.logins.has(key)||this.loginTasks.has(key)),notify:notice=>this.notify(notice),pauseMonitoring:signal=>this.monitorGate.pause(signal)});

  }

  state() {

    const shops=Object.fromEntries(Object.entries(this.shops).map(([key,value])=>[key,this.activeCaptcha?{...value,status:'paused',message:`Resolva o CAPTCHA de ${this.activeCaptcha.productName} no navegador aberto.`}:this.monitorGate.paused&&['starting','running'].includes(value.status)?{...value,status:'paused',message:'Monitoramento pausado durante a compra e a verificação manual.'}:value]));

    return {products:this.displayProducts(),settings:this.settings,shops,monitoringPaused:this.monitorGate.paused,running:Object.values(this.shops).some(s=>active(s.status)),events:this.events,purchases:this.purchases.state(),notifications:this.registry.notificationOutbox.slice(-20),

      accounts:Object.fromEntries(accountKeys.map(key=>[key,{status:this.loginTasks.has(key)?'opening':this.logins.has(key)?'open':'closed',profileLabel:chromeProfile(this.projectRoot,this.dataDirectory,...key.split('/')).label}])),storageError:this.storageError};

  }

  ensureEditable() {

    if(this.purchases.state().busy||Object.values(this.shops).some(s=>active(s.status)))throw new Error('Pare o monitoramento e aguarde a compra em andamento antes de alterar produtos ou regras.');

  }

  async mutate(fn) {

    this.ensureEditable();

    const previous=structuredClone(this.registry.products);

    try {fn();await this.save(this.registry);}

    catch(e){this.registry.products=previous;throw e;}

  }

  async add(input) {

    await this.mutate(()=>{

      const product=productInput(input);

      if(this.registry.products.filter(p=>p.store===product.store).length>=10)throw new Error('O limite desta plataforma é de 10 produtos.');

      if(this.registry.products.some(p=>p.store===product.store&&p.code===product.code))throw new Error('Este anúncio já está cadastrado.');

      if(product.auto&&product.target===null)throw new Error('Defina o preço limite primeiro.');

      this.registry.products.push(product);

    });

  }

  displayProducts(){const products=structuredClone(this.registry.products);for(const [id,pending]of Object.entries(this.registry.pendingProductEdits))this.applyPatch(products,id,pending.patch);return products.map(p=>({...p,pendingEdit:Boolean(this.registry.pendingProductEdits[p.id])}));}
  configChange(fn){const task=this.configQueue.then(fn);this.configQueue=task.catch(()=>{});return task;}

  applyPatch(products,id,patch){

      const p=products.find(p=>p.id===id);if(!p)throw new Error('Produto não encontrado.');

      const fields=['target','alert','auto','name','expectedSellerId','url','quantity'];

      if(Object.keys(patch).some(k=>!fields.includes(k)))throw new Error('Campo de produto não permitido.');

      const input={...p,...patch};

      const identity=productInput(input,p);

      if(products.some(other=>other.id!==id&&other.store===p.store&&other.code===identity.code))throw new Error('Este anúncio já está cadastrado em outro produto.');

      const changed=identity.code!==p.code||(identity.catalog??null)!==(p.catalog??null)||identity.expectedSellerId!==p.expectedSellerId;

      const updated=changed?{...productInput({...input,auto:false}),id:p.id}:identity;

      if(updated.auto&&updated.target===null)updated.auto=false;

      if(p.target!==updated.target||p.expectedSellerId!==updated.expectedSellerId){delete updated.mlConfirmation;delete p.mlConfirmation;}

      if(p.alert!==updated.alert){delete updated.mlConfirmation;delete p.mlConfirmation;delete updated.availabilityNotification;delete p.availabilityNotification;}

      if(changed)products[products.indexOf(p)]=updated;else Object.assign(p,updated);

  }

  async edit(id,patch){return this.configChange(async()=>{

    if(this.purchases.state().busy)throw new Error('Aguarde a compra em andamento antes de editar.');

    const p=this.registry.products.find(p=>p.id===id);if(!p)throw new Error('Produto não encontrado.');

    if(active(this.shops[p.store].status)){

      const projected=structuredClone(this.registry.products);

      for(const [key,value]of Object.entries(this.registry.pendingProductEdits))this.applyPatch(projected,key,value.patch);

      this.applyPatch(projected,id,patch);

      const previous=this.registry.pendingProductEdits[id];

      this.registry.pendingProductEdits[id]={patch:{...(previous?.patch??{}),...patch},savedAt:new Date().toISOString()};

      try{await this.save(this.registry);}catch(error){if(previous)this.registry.pendingProductEdits[id]=previous;else delete this.registry.pendingProductEdits[id];throw error;}

    }else{const pending=this.registry.pendingProductEdits[id];await this.mutate(()=>this.applyPatch(this.registry.products,id,{...(pending?.patch??{}),...patch}));delete this.registry.pendingProductEdits[id];await this.save(this.registry);}

  });}

  prepareCycle(store){return this.configChange(async()=>{
    const previousProducts=structuredClone(this.registry.products),previousPending=structuredClone(this.registry.pendingProductEdits);
    try{
      let changed=false;
      for(const p of this.registry.products.filter(p=>p.store===store)){
        const pending=this.registry.pendingProductEdits[p.id];if(pending){this.applyPatch(this.registry.products,p.id,pending.patch);delete this.registry.pendingProductEdits[p.id];changed=true;}
      }
      if(changed)await this.save(this.registry);
    }catch(error){this.registry.products=previousProducts;this.registry.pendingProductEdits=previousPending;throw error;}
    this.cycleSequence[store]++;
    const products=structuredClone(this.registry.products.filter(p=>p.store===store));this.cycleProducts.set(store,products);return products;
  });}
  async remove(id) {

    await this.mutate(()=>{const index=this.registry.products.findIndex(p=>p.id===id);if(index<0)throw new Error('Produto não encontrado.');this.registry.products.splice(index,1);});

  }

  async importProducts(products) {

    await this.mutate(()=>{

      for(const input of products){

        const identity=productInput(input);

        if(this.registry.products.some(p=>p.store===identity.store&&p.code===identity.code))continue;

        if(this.registry.products.filter(p=>p.store===identity.store).length>=10)continue;

        this.registry.products.push(identity);

      }

    });

  }

  async handleCaptcha(product) {
    if (this.activeCaptcha || !product) return;
    this.activeCaptcha = { productId: product.id, store: product.store, productName: product.name || product.title || product.code, startedAt: new Date().toISOString() };
    const abort = new AbortController();
    let resumeGate;
    try {
      resumeGate = await this.monitorGate.pause(abort.signal);
      await this.captchaOpener({
        projectRoot: this.projectRoot,
        dataDirectory: this.dataDirectory,
        product,
        signal: abort.signal,
        notify: notice => this.notify(notice)
      });
    } finally {
      this.activeCaptcha = null;
      resumeGate?.();
    }
  }

  observe(id,result) {

    const product=this.registry.products.find(p=>p.id===id);if(!product)return;

    if(result.error && isCaptchaError(result.error)) void this.handleCaptcha(product).catch(()=>{});

    const qualified=qualifyObservation(result,product.store,this.settings);

    applyObservation(product,qualified);

    if(product.store==='ml'){const events=confirmML(product,qualified);if(events.length)for(const event of events)this.publish(event);else if(!qualified.error&&qualified.available===true&&qualified.eligible!==false){const ml=product.mlConfirmation;if(ml&&ml.count===1){const handler=this.recheckHandlers.get('ml');if(handler)handler(product);}}}

    else {

      const previous=product.availabilityNotification??{confirmed:null,pending:null,count:0};

      if(qualified.error){previous.pending=null;previous.count=0;}

      else {

        const available=qualified.available===true&&qualified.eligible!==false;

        previous.count=previous.pending===available?previous.count+1:1;previous.pending=available;

        if(previous.count>=2){if(available&&previous.confirmed!==true)this.publish({id:randomUUID(),productId:product.id,type:'DISPONIBILIDADE_CONFIRMADA',at:qualified.at??new Date().toISOString()});previous.confirmed=available;previous.count=2;}

        else if(previous.count===1&&available){const handler=this.recheckHandlers.get(product.store);if(handler)handler(product);}

      }

      product.availabilityNotification=previous;

    }

    if(!this.registry.availabilityHistory.some(row=>row.productId===id&&row.product.code===product.code)){
      const signature=JSON.stringify([product.code,product.sellerId??product.seller,product.store==='amazon'?this.settings.amazon:this.settings.ml]);
      const previous=product.historyBaseline;
      const valid=!qualified.error&&qualified.available===true&&qualified.eligible!==false;
      product.historyBaseline=valid?{signature,count:previous?.signature===signature?previous.count+1:1}:null;
      if(product.historyBaseline?.count>=2)this.publish({id:randomUUID(),productId:id,type:'PRIMEIRA_OBSERVACAO_DISPONIVEL',at:qualified.at??new Date().toISOString()});
    }
    const snapshot=this.cycleProducts.get(product.store)?.find(p=>p.id===id);if(snapshot)Object.assign(snapshot,structuredClone(product));

    if(product.store==='ml')void this.log.observation(product,qualified,{runId:this.runId,cycle:this.cycleSequence.ml}).catch(e=>{this.storageError=e.message;void this.stop();});

    this.events=this.events.slice(-100);this.registry.events=this.events;

    this.save(this.registry).catch(e=>{this.storageError='Falha ao salvar dados: '+e.message;void this.stop();});

  }

  start() {

    if(this.storageError)throw new Error(this.storageError);

    if(Object.values(this.shops).some(s=>active(s.status)))throw new Error('O monitoramento já está em andamento.');

    if(['amazon/monitor','ml/monitor'].some(key=>this.logins.has(key)||this.loginTasks.has(key)))throw new Error('Encerre a preparação do perfil compartilhado de monitoramento antes de iniciar.');

    if(!this.registry.products.length)throw new Error('Adicione um produto ou carregue a lista do projeto.');

    if(this.purchases.state().busy)throw new Error('Aguarde a compra em andamento.');

    this.purchases.resetCycles();this.runId=randomUUID();this.cycleSequence={amazon:0,ml:0};

    for(const store of ['amazon','ml']) {

      const products=this.registry.products.filter(p=>p.store===store);

      if(!products.length) {this.shops[store]={status:'stopped',message:'Nenhum produto cadastrado.'};continue;}

      const controller=new AbortController();

      this.shops[store]={status:'starting',message:'Iniciando…'};

      const promise=Promise.resolve().then(()=>this.adapters[store]({projectRoot:this.projectRoot,dataDirectory:this.dataDirectory,products:structuredClone(products),settings:structuredClone(this.settings),signal:controller.signal,

        getProducts:()=>this.prepareCycle(store),

        onResult:(id,result)=>this.observe(id,result),

        withMonitoringRead:work=>this.monitorGate.run(controller.signal,work),

        onEvent:event=>this.publish(event),

        onCaptcha:prod=>this.handleCaptcha(prod),

        registerRecheck:handler=>{this.recheckHandlers.set(store,handler);},

        onCycle:cycle=>{if(store==='ml')void this.log.event('CYCLE_END',{runId:this.runId,cycle:this.cycleSequence.ml,ok:cycle.ok}).catch(e=>{this.storageError=e.message;});if(!controller.signal.aborted)void this.purchases.cycle(store,{...cycle,products:structuredClone(this.cycleProducts.get(store)??this.registry.products.filter(p=>p.store===store))}).catch(e=>{this.storageError=e.message;void this.stop();});},

        onDiagnostic:details=>{void this.recoveryLog.event('MONITOR_RECOVERY',{store,runId:this.runId,cycle:this.cycleSequence[store],...details}).catch(e=>{this.storageError=e.message;});},
        onStatus:(status,message)=>{if(!controller.signal.aborted){
          if(status==='reconnecting')this.purchases.invalidateCycle(store);
          this.shops[store]={status,message};
        }}

      })).catch(e=>{

        if(!controller.signal.aborted){

          this.shops[store]={status:'error',message:e.message};

          // A bootstrap failure is a store error, not an attempted read of every product.

        }

      }).finally(()=>{

        if(this.shops[store].status!=='error')this.shops[store]={status:'stopped',message:controller.signal.aborted?'Monitoramento parado.':'Monitoramento encerrado.'};

        this.jobs.delete(store);this.recheckHandlers.delete(store);

        if(store==='ml')void this.log.event('MONITOR_STOP',{runId:this.runId,reason:this.shops[store].message}).catch(e=>{this.storageError=e.message;});

        if(!controller.signal.aborted)void this.purchases.cycle(store,{ok:false,terminal:true}).catch(e=>{this.storageError=e.message;});

      });

      this.jobs.set(store,{controller,promise});

    }

  }

  async stop() {

    const jobs=[...this.jobs.entries()];

    for(const [store,job] of jobs){this.shops[store]={status:'stopping',message:'Aguardando a consulta em andamento…'};job.controller.abort();}

    await Promise.allSettled([...jobs.map(([,job])=>job.promise),this.purchases.stop()]);await Promise.all([this.log.flush(),this.recoveryLog.flush()]);

  }

  async updateSettings(input) {

    this.ensureEditable();const settings=validateSettings(input);

    if(JSON.stringify(settings)===JSON.stringify(this.settings))return;

    const mlChanged=JSON.stringify(settings.ml)!==JSON.stringify(this.settings.ml);

    const previous=structuredClone(this.registry);

    try{

      this.settings=settings;this.registry.settings=settings;

      for(const p of this.registry.products){

        if(p.lastCheckedAt)Object.assign(p,qualifyObservation({...p,available:p.rawAvailable??p.available},p.store,settings));

        if(mlChanged&&p.store==='ml')delete p.mlConfirmation;

      }

      await this.save(this.registry);

    }catch(e){Object.assign(this.registry,previous);this.settings=previous.settings;throw e;}

  }

  async openLogin(store,purpose) {

    const profile=chromeProfile(this.projectRoot,this.dataDirectory,store,purpose);

    const key=profile.key;

    if(purpose==='monitor'&&Object.values(this.shops).some(s=>active(s.status)))throw new Error('Pare os monitores antes de abrir o perfil compartilhado de monitoramento.');

    if(purpose==='purchase'&&this.purchases.state().busy)throw new Error('O perfil Compra está executando um lote. Aguarde seu encerramento.');

    if(this.logins.has(key)||this.loginTasks.has(key))throw new Error('A preparação deste perfil já está aberta.');

    const task=this.loginOpener({projectRoot:this.projectRoot,dataDirectory:this.dataDirectory,store,purpose});

    this.loginTasks.set(key,task);

    try {

      const browser=await task;

      this.logins.set(key,browser);

      browser.once('disconnected',()=>{if(this.logins.get(key)===browser)this.logins.delete(key);});

    } finally {this.loginTasks.delete(key);}

  }

  async closeLogin(store,purpose) {

    const key=chromeProfile(this.projectRoot,this.dataDirectory,store,purpose).key;

    if(this.loginTasks.has(key))throw new Error('Aguarde a abertura deste navegador.');

    const browser=this.logins.get(key);

    if(browser){await browser.close();if(this.logins.get(key)===browser)this.logins.delete(key);}

  }

  async close() {

    await this.stop();await Promise.allSettled([...this.loginTasks.values()]);

    await Promise.all([...this.logins.keys()].map(key=>this.closeLogin(...key.split('/'))));

    await this.notificationQueue;await this.log.flush();await this.save(this.registry);

  }

  publish(event){

    this.events.push(event);this.events=this.events.slice(-100);this.registry.events=this.events;

    const product=this.registry.products.find(p=>p.id===event.productId);
    if(['DISPONIBILIDADE_CONFIRMADA','PRIMEIRA_OBSERVACAO_DISPONIVEL'].includes(event.type)&&product?.available===true&&product.eligible!==false&&!this.registry.availabilityHistory.some(row=>row.id===event.id)){
      const fields=['id','store','name','title','code','url','price','freight','seller','sellerId','delivery','reputationLevel','powerSellerStatus','quantity','target','rawAvailable','eligible','lastCheckedAt'];
      this.registry.availabilityHistory.push(structuredClone({id:event.id,type:event.type,productId:product.id,at:event.at,product:Object.fromEntries(fields.map(key=>[key,product[key]??null])),filters:product.store==='amazon'?{onlyAmazon:this.settings.amazon.onlyAmazon}:{requireReputation:this.settings.ml.requireReputation,minReputation:this.settings.ml.minReputation,requireLeader:this.settings.ml.requireLeader,minLeader:this.settings.ml.minLeader,matchMode:this.settings.ml.matchMode}}));
    }

    if(event.type==='DISPONIBILIDADE_CONFIRMADA'&&product?.alert)void this.notify({id:event.id,title:'Vigia · produto disponível',message:`${product.name||product.title||product.code} · ${product.store==='amazon'?'Amazon':'Mercado Livre'}${product.price!=null?' · R$ '+product.price.toFixed(2).replace('.',','):''}`}).catch(e=>{this.storageError=e.message;});

    this.save(this.registry).catch(e=>{this.storageError=e.message;void this.stop();});

  }

  notify(notice){

    if(this.registry.notificationOutbox.some(row=>row.id===notice.id))return Promise.resolve();

    const row={id:notice.id,title:notice.title,message:notice.message,status:'PENDING',createdAt:new Date().toISOString()};this.registry.notificationOutbox.push(row);this.registry.notificationOutbox=this.registry.notificationOutbox.slice(-100);

    const work=async()=>{row.status='SENDING';await this.save(this.registry);try{await this.notifier(notice);row.status='SENT';}catch(error){row.status='FAILED';row.error=String(error.message).slice(0,200);}await this.save(this.registry);return {status:row.status};};

    const task=this.notificationQueue.then(work);this.notificationQueue=task.catch(()=>{});return task;

  }

}

