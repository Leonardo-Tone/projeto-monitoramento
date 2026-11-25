import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { runPurchase } from '../server/purchase-runner.mjs';
import { defaults } from '../server/availability.mjs';
import { crc16 } from '../server/purchase-html.mjs';
import { checkoutSelectionInPage } from '../server/purchase-clicks.mjs';
import { closeOwnedBrowser } from '../server/browser-cleanup.mjs';

for(const [moreLabel,navigatePayments,card=false] of [['Mostrar mais',false],['Mostrar todos',false],['Mostrar todos',true],['Mostrar todos','popup'],['Cartão',false,true]])test(`full purchase flow: ${moreLabel}, payments navigation ${navigatePayments}, trusted clicks and one finalization`,{
  skip:process.env.VIGIA_BROWSER_TESTS!=='1',timeout:120000,
},async()=>{
  const root=process.env.MONITOR_PROJECT_ROOT,require=createRequire(import.meta.url);
  const puppeteer=require(join(root,'Mercado_Livre','puppeteer-headless-runtime','src','puppeteer-runtime.js'));
  const {localizarChrome}=await import(new URL('file:///'+root.replace(/\\/g,'/')+'/Mercado_Livre/integracao-native.mjs'));
  const profile=await mkdtemp(join(tmpdir(),'vigia-browser-'));
  const items=new Map([['MLB1999',{quantity:1,checked:true,unit:20}]]),events=[],stages=[];let native,finalClicks=0,chosenShipping='slow',contextLossPending=false,contextLossInjected=0;
  const selected=()=>[...items].filter(([,i])=>i.checked);
  const total=()=>selected().reduce((sum,[,i])=>sum+i.unit*i.quantity,0);
  const money=value=>({value:{values:[{key:'price',type:'price',price:{value,currency:'BRL'}}]}});
  const htmlMoney=value=>`<span class="andes-money-amount"><span class="andes-money-amount__fraction">${Math.floor(value)}</span><span class="andes-money-amount__cents">${Math.round(value*100)%100?String(Math.round(value*100)%100).padStart(2,'0'):'00'}</span></span>`;
  const cart=()=>({grouped_items:[{polycards:[...items].map(([id,i])=>({unique_id:id,metadata:{id,quantity:String(i.quantity)},checkbox:{checked:i.checked,disabled:false,metadata:{items:[{item_id:id}]}},add_to_cart_capability:{cart_status:{item_id:id,quantity:i.quantity,display_quantity:i.quantity,status:'enabled'}}}))}],cart_properties:{active_and_selected_items_size:selected().reduce((s,[,i])=>s+i.quantity,0)},summary:{ticket_rows:[{id:'item',...money(total())},{id:'shipping',...money(0)}],total_row:money(total()),coupon_row:{id:'coupon'}},tracking:{summary:{total:{amount:total()},shipping_total:{amount:0},discount_amount:0,used_coupons:0,coupons_type:{type:'NO_COUPON'}},items:[...items].map(([id,i])=>({item:{id},quantity:i.quantity,unit_price:i.unit,price_decrement_campaigns:[{id:'not_apply',type:'not_apply',amount:0}]})),grouping_items:[...items].map(([id,i])=>({group_status:i.checked?'selected':'unselected',items_id:[id],total_active_quantity_items:i.checked?i.quantity:0,coupons:[{type:'no_coupon',reach_minimum:false,given_discount:0}]}))}});
  const action=(type,extra='')=>`fetch('/test/action',{method:'POST',body:JSON.stringify({type:'${type}',trusted:event.isTrusted${extra}})})`;
  const product=id=>`<!doctype html><title>Produto de teste</title><h1 class="ui-pdp-title">${id}</h1><script id="__NORDIC_RENDERING_CTX__">_n.ctx.r = ${JSON.stringify({appProps:{pageProps:{initialState:{id,no_active_item:false,track:{melidata_event:{event_data:{item_id:id,seller_id:123,item_status:'active',has_stock:true,price:90}}}}}}})};</script><button onclick="${action('add',`,id:'${id}'`)}">Adicionar ao carrinho</button>`;
  const cartHtml=()=>`<!doctype html><title>Carrinho teste</title>${[...items].map(([id,i])=>`<div class="cl-item-card" data-item-id="${id}"><input type="checkbox" ${i.checked?'checked':''} onclick="${action('selection',`,id:'${id}',checked:this.checked`)}.then(()=>location.reload())"></div>`).join('')}<a class="cl-summary__button" href="https://www.mercadolivre.com.br/gz/checkout/cart/buy?items=${selected().map(([id,i])=>id+'-Q'+i.quantity).join(',')}">Continuar (${selected().reduce((s,[,i])=>s+i.quantity,0)})</a>`;
  const shipping=()=>`<ul class="bf-shipping-options-list__radio-list">${[['slow','Chegará domingo',0,true],['fast','Chegará amanhã',0,false],['paid','Chegará hoje',5,false]].map(([value,title,price,checked])=>`<li><input type="radio" name="shipping-options-1" value="${value}" id="ship-${value}" ${value===chosenShipping?'checked':''} onclick="${action('shipping',`,value:'${value}'`)}"><label for="ship-${value}" data-andes-radio-list-title>${title}</label><span data-andes-radio-list-right-content>${price===0?'Grátis':htmlMoney(price)}</span></li>`).join('')}</ul>`;
  const proof=()=>selected().map(([id,i])=>`<div data-item-id="${id}" data-quantity="${i.quantity}" data-unit-price="${i.unit}" data-seller-id="123"></div>`).join('');
  const checkoutHtml=(paymentList=false)=>`<!doctype html><title>Checkout teste</title>${shipping()}<div data-testid="product_row">${htmlMoney(total())}</div><div data-testid="shipment_row">Grátis</div><div data-testid="total_row">${htmlMoney(total())}</div>${proof()}<div class="bf-payments__footer_action"><a href="#" id="more">${moreLabel}</a></div><input type="radio" name="payment-method-radio-list" id="card" value="credit" checked><label for="card">Cartão</label><div id="payments" role="dialog" style="display:none"></div><div id="review"></div><script>
  function showPayments(){document.getElementById('payments').style.display='block';document.getElementById('payments').innerHTML='<input type="radio" name="transfers" id="pix-test" value="pix"><label for="pix-test">Pix</label><button data-testid="continue_button" id="pay-continue">Continuar</button>';document.getElementById('pix-test').onclick=function(event){${action('pix')};};document.getElementById('pay-continue').onclick=function(event){if(!document.getElementById('pix-test').checked)throw Error('Pix was not selected');${action('continue-payment')};document.getElementById('payments').innerHTML='';document.getElementById('payments').style.display='none';document.getElementById('review').innerHTML='<input type="radio" name="payment-method-radio-list" id="selected-pix" value="pix" checked><label for="selected-pix">Pix</label><button data-testid="confirm_purchase_button" id="final">Pagar e finalizar</button>';document.getElementById('final').onclick=async function(event){const r=await fetch('/test/finalize',{method:'POST',body:JSON.stringify({trusted:event.isTrusted})});const p=await r.json();document.body.innerHTML='<div data-testid="pix_copy_code_card">'+p.code+'</div>';};};}
  document.getElementById('more').onclick=function(event){${action('more')};${navigatePayments==='popup'?"const child=window.open('about:blank');window.addEventListener('message',function ready(event){if(event.data==='test-payment-popup-ready'){child.location.href='/gz/checkout/payment-options';window.removeEventListener('message',ready);}});":navigatePayments?"location.href='/gz/checkout/payment-options';":"showPayments();"}return false;};
  ${paymentList?'showPayments();':''}
  </script>`;
  const cardCheckout=()=>`<!doctype html><title>Checkout teste</title>${shipping()}<div data-testid="product_row">${htmlMoney(total())}</div><div data-testid="shipment_row">Grátis</div><div data-testid="total_row">${htmlMoney(total())}</div>${proof()}
    <input type="radio" name="payment-method-radio-list" id="wrong" checked><label for="wrong">Cartão de crédito terminado em 2345 · à vista</label>
    <input type="radio" name="payment-method-radio-list" id="saved-card" value="master_123456" onclick="${action('credit_card')}"><label for="saved-card">Mastercard terminado em 0123 · à vista · sem juros</label>
    <button data-testid="confirm_purchase_button" onclick="if(document.getElementById('saved-card').checked)fetch('/test/finalize',{method:'POST',body:JSON.stringify({trusted:event.isTrusted})}).then(()=>location.href='/gz/checkout/congrats')">Pagar e finalizar</button>`;
  const pix=()=>{const tag=(id,value)=>id+Buffer.byteLength(value).toString().padStart(2,'0')+value;const payload=tag('00','01')+tag('26',tag('00','br.gov.bcb.pix')+tag('01','teste@example.invalid'))+tag('52','0000')+tag('53','986')+tag('54',total().toFixed(2))+tag('58','BR')+tag('59','TESTE')+tag('60','SAO PAULO')+tag('62',tag('05','***'))+'6304';return payload+crc16(payload);};
  const intercept=async request=>{
    const u=new URL(request.url());let body;
    try{
      if(u.hostname!=='www.mercadolivre.com.br')return request.abort();
      if(u.pathname==='/test/action'){
        body=JSON.parse(request.postData());events.push(body);assert.equal(body.trusted,true);
        if(body.type==='add'&&!items.has(body.id))items.set(body.id,{quantity:1,checked:true,unit:90});
        if(body.type==='shipping')chosenShipping=body.value;
        if(body.type==='selection')items.get(body.id).checked=body.checked;
        return request.respond({status:200,contentType:'application/json',body:'{}'});
      }
      if(u.pathname==='/test/finalize'){body=JSON.parse(request.postData());assert.equal(body.trusted,true);finalClicks++;events.push({type:'final',trusted:true});return request.respond({status:200,contentType:'application/json',body:JSON.stringify({code:pix()})});}
      if(u.pathname==='/gz/cart/v3/api/cart-list')return request.respond({status:200,contentType:'application/json',body:JSON.stringify(cart())});
      if(u.pathname==='/gz/cart/v3/api/add-to-cart'){
        body=JSON.parse(request.postData());const capacity=body.item_id==='MLB1001'?2:4;const item=items.get(body.item_id);item.quantity=Math.min(body.quantity,capacity);events.push({type:'quantity',id:body.item_id,quantity:item.quantity});
        return request.respond({status:200,contentType:'application/json',body:JSON.stringify({cart_status:{item_id:body.item_id,quantity:item.quantity,status:'enabled'},cart_config:{available_quantity:capacity,maximum_quantity:10,minimum_quantity:1}})});
      }
      if(u.pathname==='/gz/cart/v2')return request.respond({status:200,contentType:'text/html; charset=utf-8',body:cartHtml()});
      if(u.pathname==='/gz/checkout/cart/buy'){events.push({type:'continue-cart'});return request.respond({status:200,contentType:'text/html; charset=utf-8',body:card?cardCheckout():checkoutHtml()});}
      if(u.pathname==='/gz/checkout/congrats'&&card)return request.respond({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><h1>Pagamento aprovado</h1>'});
      if(u.pathname==='/gz/checkout/payment-options'){contextLossPending=true;return request.respond({status:200,contentType:'text/html; charset=utf-8',body:checkoutHtml(true)});}
      const id=u.searchParams.get('pdp_filters')?.match(/item_id:(MLB\d+)/)?.[1];
      if(id&&u.pathname.includes('/p/'))return request.respond({status:200,contentType:'text/html; charset=utf-8',body:product(id)});
      return request.abort();
    }catch(error){await request.abort().catch(()=>{});throw error;}
  };
  try{
    const configure=async page=>{await page.setRequestInterception(true);page.on('request',intercept);const evaluate=page.evaluate.bind(page);page.evaluate=async(fn,...args)=>{if(fn===checkoutSelectionInPage&&contextLossPending){contextLossPending=false;contextLossInjected++;throw Error('Execution context was destroyed, most likely because of a navigation.');}return evaluate(fn,...args);};page.on('popup',async popup=>{await configure(popup);await popup.evaluate(()=>window.opener.postMessage('test-payment-popup-ready','*'));});return page;};
    const settings=defaults();settings.ml.purchase.freeShippingOnly=true;
    if(card)Object.assign(settings.ml.purchase,{paymentMethod:'credit_card',cardLastFour:'0123'});
    const result=await runPurchase({projectRoot:root,dataDirectory:'test',settings,signal:new AbortController().signal,notify:async()=>{},stage:async(status,message)=>stages.push({status,message}),order:{items:[1,2].map(n=>({itemId:'MLB100'+n,catalog:'MLB900'+n,type:'catalogo',sellerId:'123',url:`https://www.mercadolivre.com.br/product/p/MLB900${n}?pdp_filters=item_id:MLB100${n}`,name:'MLB100'+n,quantity:n===1?3:1,requestedQuantity:n===1?3:1,limitCents:10000}))},launcher:async options=>{
      assert.equal(options.headless,!card);native=await puppeteer.launch({headless:true,executablePath:localizarChrome(),userDataDir:profile,protocolTimeout:15000});
      return {browser:{newPage:async()=>configure(await native.newPage()),close:()=>closeOwnedBrowser(native)}};
    }});
    assert.equal(result.payment,card?'credit_card':'pix');assert.equal(result.paid,card);assert.equal(result.totalCents,27000);assert.equal(result.items[0].quantity,2);assert.equal(result.items[1].quantity,1);assert.equal(finalClicks,1);assert.equal(items.get('MLB1999').checked,false);
    const actions=events.filter(e=>['continue-cart','shipping','more','pix','credit_card','continue-payment','final'].includes(e.type));
    assert.deepEqual(actions.map(e=>e.type),card?['continue-cart','shipping','credit_card','final']:['continue-cart','shipping','more','pix','continue-payment','final']);assert.equal(actions[1].value,'fast');
    assert.equal(stages.filter(s=>s.status==='FINALIZING').length,1);assert.equal(contextLossInjected,navigatePayments?1:0);
  }finally{
    if(native?.isConnected())await closeOwnedBrowser(native);
    const tempRoot=resolve(tmpdir())+sep;if(!resolve(profile).startsWith(tempRoot)||!profile.includes('vigia-browser-'))throw Error('Diretório de teste inesperado');await rm(profile,{recursive:true,force:true});
  }
});
