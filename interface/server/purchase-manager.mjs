import { randomUUID } from 'node:crypto';
import { candidates, resolveMlPayment } from './purchase-rules.mjs';
import { runPurchase } from './purchase-runner.mjs';
import { amazonCandidates, runAmazonPurchase } from './amazon-purchase.mjs';
import { verifyPurchaseHistory } from './account-verification.mjs';

const ordersPage=store=>store==='amazon'?'Meus Pedidos da Amazon':'Minhas compras';

export class PurchaseManager {
  constructor({registry,save,projectRoot,dataDirectory,getSettings,getProducts,getExpectedStores,isPurchaseProfileOpen,notify,runner=runPurchase,amazonRunner=runAmazonPurchase,verifyHistory=verifyPurchaseHistory,pauseMonitoring=async()=>()=>{}}) {
    Object.assign(this,{registry,save,projectRoot,dataDirectory,getSettings,getProducts,getExpectedStores,isPurchaseProfileOpen,notify,runner,amazonRunner,verifyHistory,pauseMonitoring});
    registry.purchaseOrders??=[];
    this.recoveredChanges=false;
    // Never repeat a request whose result could have reached the marketplace.
    for(const order of registry.purchaseOrders){
      if(['QUEUED','PAUSING_MONITORS','REVALIDATING','CART','CHECKOUT','FINALIZING','WAITING_HUMAN','RESUMING'].includes(order.status)){order.status='UNCERTAIN';order.human=null;order.message='Execução anterior interrompida. Verifique '+ordersPage(order.store)+' antes de rearmar.';this.recoveredChanges=true;}
      if(['PIX_PENDING','CARD_PAID'].includes(order.status)&&this.disarmProducts(order)){order.autoDisabledAt??=new Date().toISOString();this.recoveredChanges=true;}
      if(order.historyVerification?.status==='PENDING'){order.historyVerification={status:'UNAVAILABLE'};this.recoveredChanges=true;}
    }
    this.cycles=new Map();this.consumed=new Map();this.task=null;this.controller=null;this.paused=true;
  }
  resetCycles(){this.cycles.clear();this.consumed.clear();this.amazonConsumed=0;this.paused=false;}
  invalidateCycle(store){const previous=this.cycles.get(store);if(previous)previous.ok=false;}
  state(){return {busy:Boolean(this.task),error:this.failure??null,orders:this.registry.purchaseOrders.slice(-50)};}
  disarmProducts(order){
    const ids=new Set(order.items.map(item=>item.productId));let changed=false;
    for(const product of this.getProducts())if(ids.has(product.id)&&product.auto){product.auto=false;changed=true;}
    return changed;
  }
  async cycle(store,{ids=[],ok=true,terminal=false,products}={}) {
    const previous=this.cycles.get(store);this.cycles.set(store,{sequence:(previous?.sequence??0)+1,ids,ok,terminal,products});
    const settings=structuredClone(this.getSettings());
    if(this.failure||this.paused||this.task)return;
    const stores=this.getExpectedStores();
    const fresh=key=>this.cycles.get(key)?.sequence>(this.consumed.get(key)??0);
    const ml=this.cycles.get('ml'),amazon=this.cycles.get('amazon');
    let platform='ml',items=[];
    const mlReady=settings.ml.purchase.enabled&&stores.every(key=>this.cycles.get(key)?.terminal||fresh(key));
    if(mlReady&&ml?.ok&&!ml.terminal){
      items=candidates(ml.products??this.getProducts(),this.registry.purchaseOrders,new Set(ml.ids));
    }
    if(!items.length&&settings.amazon?.purchase?.enabled&&amazon?.ok&&!amazon.terminal&&
        amazon.sequence>(this.amazonConsumed??0)){
      platform='amazon';
      this.amazonConsumed=amazon.sequence;
      items=amazonCandidates(amazon.products??this.getProducts(),this.registry.purchaseOrders,new Set(amazon.ids),settings.amazon).slice(0,1);
    }
    if(mlReady)for(const key of stores)this.consumed.set(key,this.cycles.get(key).sequence);
    if(!items.length)return;
    if(this.isPurchaseProfileOpen()){await this.notify({id:randomUUID(),title:'Vigia · perfil de compra em uso',message:'Encerre a preparação do perfil Compra para permitir a compra automática.'});return;}
    const method=settings[platform].purchase.paymentMethod??'pix';
    const conditional=method==='pix_with_discount';
    const order={id:randomUUID(),store:platform,status:'QUEUED',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),items,message:'Pedido aguardando preparação no perfil Compra.',payment:conditional?null:method,paid:false};
    this.registry.purchaseOrders.push(order);
    this.controller=new AbortController();
    const work=async()=>{
      let resumeMonitoring;
      const stage=async(status,message,details={})=>{
        if(status==='FINALIZING'&&conditional&&!order.finalizationStarted){
          const expected=resolveMlPayment(method,order.cartEconomics?.pixDiscountCents);
          if(details.payment!==expected)throw new Error('Forma de pagamento divergente do desconto Pix confirmado.');
          order.payment=expected;
        }
        order.status=status;order.message=message;order.updatedAt=new Date().toISOString();
        if(status==='FINALIZING')order.finalizationStarted=true;
        for(const key of ['items','subtotalCents','shippingCents','grossShippingCents','shippingDiscountCents','beforeDiscountCents','totalCents','allocations','human','resumeStatus','cartEconomics','couponDiscountCents','pixDiscountCents'])if(key in details)order[key]=details[key];
        order.history=[...(order.history??[]),{status,message,at:order.updatedAt}].slice(-40);
        await this.save(this.registry);
      };
      try {
        await this.save(this.registry);
        await stage('PAUSING_MONITORS','Pausando as consultas da Amazon e do Mercado Livre antes da compra.');
        resumeMonitoring=await this.pauseMonitoring(this.controller.signal);
        const paymentLabel=conditional?'Pix com desconto ou cartão de crédito':method==='credit_card'?'cartão de crédito':'Pix';
        await this.notify({id:`purchase-start-${order.id}`,title:'Vigia · compra iniciada',message:`Preparando ${order.items.length} produto(s) para pagamento por ${paymentLabel}.`}).catch(()=>{});
        const runner=platform==='amazon'?this.amazonRunner:this.runner;
        const result=await runner({order:structuredClone(order),settings,projectRoot:this.projectRoot,dataDirectory:this.dataDirectory,signal:this.controller.signal,stage,notify:notice=>this.notify(notice)});
        const card=order.payment==='credit_card';
        if(!['pix','credit_card'].includes(order.payment)||result.payment!==order.payment||result.paid!==card||!card&&typeof result.code!=='string')throw new Error('O resultado da compra não confirmou a forma de pagamento escolhida.');
        const {orderReferences,...purchase}=result;
        Object.assign(order,purchase,{human:null,status:card?'CARD_PAID':'PIX_PENDING',message:card?'Pagamento com cartão confirmado. Compra automática desativada nos produtos deste pedido.':'Pix gerado. Compra automática desativada nos produtos deste pedido. Revise e pague manualmente no seu banco.',updatedAt:new Date().toISOString()});
        if(Array.isArray(orderReferences))order.historyVerification={status:'PENDING'};
        this.disarmProducts(order);order.autoDisabledAt=new Date().toISOString();
        await this.save(this.registry);
        await this.notify({id:randomUUID(),title:card?'Vigia · pagamento confirmado':'Vigia · Pix gerado',message:`Pedido com ${order.items.length} produto(s), total R$ ${(order.totalCents/100).toFixed(2).replace('.',',')}.${card?'':' Revise o Pix no painel.'}`}).catch(error=>{order.notificationError=String(error.message).slice(0,200);});
        if(Array.isArray(orderReferences)){
          order.historyVerification=await this.verifyHistory({
            store:platform,references:orderReferences,projectRoot:this.projectRoot,dataDirectory:this.dataDirectory,signal:this.controller.signal,
          }).catch(()=>({status:'UNAVAILABLE',at:new Date().toISOString()}));
          order.updatedAt=new Date().toISOString();
          await this.save(this.registry).catch(error=>{this.failure=String(error.message);});
        }
      }catch(error){
        const uncertain=order.finalizationStarted||['FINALIZING','PIX_PENDING','CARD_PAID'].includes(order.status);
        order.human=null;
        order.status=uncertain?'UNCERTAIN':this.controller.signal.aborted?'CANCELLED':'BLOCKED';
        const detail=String(error.message).slice(0,500),step=String(error.purchaseStep??order.message).slice(0,250);
        order.failure={step,name:String(error.name??'Error'),detail,at:new Date().toISOString(),...(error.cleanupWarning?{cleanupWarning:String(error.cleanupWarning).slice(0,250)}:{})};
        if(error.diagnosticFile)order.failure.diagnosticFile=error.diagnosticFile;
        if(error.diagnosticWarning)order.failure.diagnosticWarning=error.diagnosticWarning;
        order.message=(/timed out|timeout/i.test(detail)?'Tempo limite de comunicação com o Chrome. Etapa: '+step:detail).slice(0,350)+(uncertain?' Verifique '+ordersPage(order.store)+'. Não haverá nova tentativa automática.':'');order.updatedAt=new Date().toISOString();
        await this.save(this.registry);
        await this.notify({id:randomUUID(),title:uncertain?'Vigia · confira o pedido':'Vigia · compra interrompida',message:order.message}).catch(()=>{});
      }finally{resumeMonitoring?.();}
    };
    this.task=Promise.resolve().then(work).catch(error=>{this.failure=String(error.message);order.message='Falha de persistência: '+this.failure;order.status='UNCERTAIN';}).finally(()=>{this.task=null;this.controller=null;});
  }
  async stop(){this.paused=true;this.controller?.abort();if(this.task)await this.task;}
  async resolve(id){
    if(this.task)throw new Error('Aguarde a compra em andamento.');
    const order=this.registry.purchaseOrders.find(o=>o.id===id);if(!order)throw new Error('Pedido não encontrado.');
    if(order.status==='FINALIZING')throw new Error('Pedido em finalização.');
    this.disarmProducts(order);
    order.status='CLOSED';order.message='Revisado pelo usuário. Compra automática desativada nestes produtos.';order.updatedAt=new Date().toISOString();await this.save(this.registry);
  }
}
