import { launchProfile } from './profiles.mjs';
import { mlResponse } from './adapters.mjs';
import { qualifyObservation } from './availability.mjs';
import { identity, allowedQuantity, validateCart, validateEconomics, reviewLines, validateCartStatement, resolveMlPayment } from './purchase-rules.mjs';
import { createCheckoutParser, chooseShipping } from './purchase-html.mjs';
import { readCartInPage, setQuantityInPage, findSelectionInPage } from './purchase-cart.mjs';
import { createPurchaseHumanGate, RevalidatePurchase, revealPurchasePage } from './purchase-human.mjs';
import { clickPurchaseControl, continueCartByClick, locatePurchaseControl, checkoutSelectionInPage } from './purchase-clicks.mjs';
import { PurchaseSession } from './purchase-session.mjs';
import { readPurchaseHtml } from './purchase-dom.mjs';
import { readAcrossNavigation } from './purchase-navigation.mjs';
import { isMlBrowserWall, sameMlDestination } from './ml-verification.mjs';
import { checkoutOrderReferences } from './account-verification.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const safePage=url=>{try{const u=new URL(url);return u.protocol==='https:'&&['www.mercadolivre.com.br','produto.mercadolivre.com.br','www.mercadopago.com.br'].includes(u.hostname)&&!u.username&&!u.password&&!/account-verification|captcha|challenge|\/login|\/auth\//i.test(u.pathname);}catch{return false;}};

export async function runPurchase({order,settings,projectRoot,dataDirectory,signal,stage:publishStage,notify,launcher=launchProfile,humanGateFactory=createPurchaseHumanGate,captureCheckout=null,htmlReader=readPurchaseHtml}) {
  const parser=createCheckoutParser(projectRoot),rules=settings.ml.purchase;
  const method=rules.paymentMethod??'pix';
  let card,paymentOptions;
  const hasPayment=selection=>card?selection.hasCard:selection.hasPix;
  const paymentSelected=selection=>card?selection.cardSelected:selection.pix;
  let checkpoint='Preparando o perfil Compra.',failure,completed;
  const stage=async(status,message,details)=>{checkpoint=message;return publishStage(status,message,details);};
  let cartPage,productPage;const verified=new Map();
  const session=new PurchaseSession({projectRoot,dataDirectory,launcher});
  const syncPages=()=>{cartPage=session.cartPage;productPage=session.productPage;};
  const readHtml=page=>readAcrossNavigation(page,()=>htmlReader(page),{signal});
  const readValue=(page,fn,args)=>readAcrossNavigation(page,()=>page.evaluate(fn,args),{signal});
  const check=humanGateFactory({signal,stage,notify,openVisible:async page=>{const visible=await session.showHuman(page);syncPages();return visible;}});
  let finalizationStarted=false;
  const go=async(page,url)=>{
    await check();if(!safePage(url))throw new Error('Destino de navegação inválido.');
    let response,navigationError;
    try{response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});}
    catch(error){navigationError=error;}
    if(page.url()==='about:blank'&&navigationError)throw navigationError;
    const verification=await check(page,{enteredWall:isMlBrowserWall(response?.url?.()),expectedDestination:actual=>sameMlDestination(actual,url)});
    if(!verification?.wallCleared){
      if(navigationError)throw navigationError;
      if(response?.status()!==200)throw new Error('Navegação de compra: HTTP '+response?.status());
    }
    const html=await readHtml(page);if(/<title[^>]*>[^<]*(captcha|robot check|verifica)/i.test(html))throw new Error('Verificação de acesso no perfil de compra.');return html;
  };
  const readCart=async()=>{
    await check(cartPage);const cart=await readValue(cartPage,readCartInPage);
    for(const line of cart.items??[]){const evidence=verified.get(identity(line));if(evidence){if(line.sellerId!=null&&String(line.sellerId)!==String(evidence.sellerId))throw new Error('Vendedor divergente entre o anúncio e o carrinho.');line.sellerId=String(evidence.sellerId);}}
    return cart;
  };
  const handleClick=(page,fn,args,beforeClick)=>clickPurchaseControl(page,fn,args,{check,beforeClick,signal});
  const stableCart=async(expected)=>{
    let previous=null;
    for(let i=0;i<16;i++){
      await check();const cart=await readCart();
      if(!cart.complete)throw new Error(cart.reason??'Leitura incompleta do carrinho.');
      let lines;try{lines=validateCart(cart,expected);validateCartStatement(cart,expected,rules);}catch(error){previous=null;if(i===15)throw error;await delay(250);continue;}
      const signature=JSON.stringify({items:lines.map(l=>[identity(l),l.quantity,l.unitCents,l.sellerId]),economics:cart.economics});
      if(signature===previous)return {cart,lines};previous=signature;await delay(250);
    }throw new Error('O carrinho não estabilizou.');
  };
  const readReview=async()=>{
    await check(cartPage);
    const review=parser.review(await readHtml(cartPage));
    const selection=await readValue(cartPage,checkoutSelectionInPage,paymentOptions);
    review.paymentConfirmed=card?selection.cardInFull:selection.pix;
    review.cardSelected=selection.cardSelected;
    review.installmentChoice=selection.installmentChoice;
    review.securityCodeRequired=selection.securityCodeRequired;
    review.hasFinalize=selection.canFinalize;return review;
  };
  const selectedShipping=async()=>{
    await check(cartPage);
    const groups=parser.shipping(await readHtml(cartPage),new Date());if(!groups.length)throw new Error('Opções de envio não identificadas.');
    const selected=(await readValue(cartPage,checkoutSelectionInPage)).shipping;
    let total=0;for(const group of groups){const best=chooseShipping(group.options);const actual=selected.filter(s=>s.group===group.name);if(actual.length!==1||actual[0].value!==best.value)throw new Error('A opção de envio selecionada não é a mais barata/rápida atual.');total+=best.cents;}return total;
  };
  try {
    await stage('REVALIDATING','Conferindo os anúncios no perfil de compra.');
    // The conditional mode may need the visible card security prompt.
    await session.start(method==='pix',{signal});syncPages();
    for(;;){
      try {
        verified.clear();
        await stage('REVALIDATING','Conferindo anúncios e carrinho no perfil de compra.');
        await go(cartPage,'https://www.mercadolivre.com.br/gz/cart/v2');
        let cart=await readCart();if(!cart.complete)throw new Error(cart.reason??'Não foi possível ler o carrinho completo.');
        const expected=[];
        for(const item of order.items){
          await check();const html=await go(productPage,item.url);
          const result=qualifyObservation(await mlResponse({code:item.itemId,catalog:item.catalog,expectedSellerId:item.sellerId,type:item.type??(item.catalog?'catalogo':'produto'),url:item.url},{http:200,urlFinal:productPage.url(),html}), 'ml',settings);
          if(result.available!==true||result.eligible===false||result.sellerId!==String(item.sellerId)||String(result.variationId??'')!==String(item.variationId??'')||!Number.isFinite(result.price)||Math.round(result.price*100)>item.limitCents)throw new Error('Oferta não atende mais às regras: '+item.name);
          verified.set(identity(item),{sellerId:item.sellerId});
          cart=await readCart();let line=cart.items.find(l=>identity(l)===identity(item));
          if(!line){
            await stage('CART','Adicionando os produtos elegíveis ao carrinho.');
            await handleClick(productPage,locatePurchaseControl,{kind:'add'});
            await go(cartPage,'https://www.mercadolivre.com.br/gz/cart/v2');
            for(let poll=0;poll<12;poll++){cart=await readCart();if(!cart.complete)throw new Error('Carrinho incompleto após inclusão.');line=cart.items.find(l=>identity(l)===identity(item));if(line)break;await check();await delay(250);}
            if(!line)throw new Error('Inclusão no carrinho não confirmada.');
          }
          await check(cartPage);
          const capacity=await cartPage.evaluate(setQuantityInPage,{itemId:item.itemId,variationId:item.variationId??null,quantity:line.quantity});
          if(!capacity.confirmed)throw new Error('Não foi possível confirmar os limites de quantidade.');
          const quantity=allowedQuantity(item.quantity,capacity.limits);
          if(quantity!==capacity.quantity){const result=await cartPage.evaluate(setQuantityInPage,{itemId:item.itemId,variationId:item.variationId??null,quantity});if(!result.ok)throw new Error('Ajuste de quantidade não confirmado.');}
          expected.push({...item,quantity});
        }
        // Selection applies to the entire complete inventory, never just the visible target.
        await go(cartPage,'https://www.mercadolivre.com.br/gz/cart/v2');cart=await readCart();
        const wanted=new Set(expected.map(identity));
        for(const item of cart.items){
          const checked=wanted.has(identity(item));
          if(item.checked!==checked){await handleClick(cartPage,findSelectionInPage,{itemId:item.itemId,variationId:item.variationId,checked});await delay(250);}
        }
        const stable=await stableCart(expected);
        const diagnosticCartHtml=captureCheckout?await readHtml(cartPage):null;
        const statement=validateCartStatement(stable.cart,expected,rules);
        const chosenPayment=resolveMlPayment(method,statement.pixDiscountCents);
        card=chosenPayment==='credit_card';
        paymentOptions=card?{cardLastFour:rules.cardLastFour}:undefined;
        const payment=card?'cartão de crédito':'Pix';
        await stage('CART','Extrato do carrinho validado: produtos, quantidades, preços, descontos e frete.',{cartEconomics:stable.cart.economics});
        const href=await readValue(cartPage,()=>{
          const links=[...document.querySelectorAll('a.cl-summary__button')].filter(a=>a.getClientRects().length&&/^Continuar\b/.test(a.textContent.trim()));return links.length===1?links[0].href:null;
        });
        if(!href||!safePage(href))throw new Error('Link Continuar do carrinho não confirmado.');
        const bound=new URL(href).searchParams.get('items');
        if(!bound)throw new Error('O checkout não informou os itens vinculados ao carrinho.');
        const binding=new Map(bound.split(',').map(value=>{const match=value.match(/^(MLB\d+)(?:_(\d+))?-Q(\d+)$/);if(!match)throw new Error('Vínculo do checkout inválido.');return [`${match[1]}:${match[2]??''}`,Number(match[3])];}));
        if(binding.size!==expected.length||expected.some(item=>binding.get(identity(item))!==item.quantity))throw new Error('Os produtos do link Continuar divergem do lote.');
        await stage('CHECKOUT','Clicando em Continuar no carrinho.',{items:stable.lines});
        await continueCartByClick(cartPage,href,{check,signal});
        await stage('CHECKOUT','Continuar acionado. Aguardando as opções de entrega carregarem.');
        let shippingReady=false;
        for(let poll=0;poll<60;poll++){
          await check(cartPage);
          if(parser.shipping(await readHtml(cartPage),new Date()).length){shippingReady=true;break;}
          await delay(250);
        }
        if(!shippingReady)throw new Error('A etapa de entrega do checkout não carregou opções de frete reconhecidas.');
        await stage('CHECKOUT','Etapa de entrega carregada. Conferindo a melhor opção de frete.');
        if(captureCheckout){
          await captureCheckout({cartHtml:diagnosticCartHtml,checkoutHtml:await readHtml(cartPage),items:stable.lines});
          return {diagnosticOnly:true,orderCreated:false};
        }
        for(let round=0;round<4;round++){
          await check(cartPage);
          const groups=parser.shipping(await readHtml(cartPage),new Date());if(!groups.length)throw new Error('Opções de envio não identificadas.');let changed=false;
          for(const group of groups){
            const best=chooseShipping(group.options);
            const selected=(await readValue(cartPage,checkoutSelectionInPage)).shipping.some(input=>input.group===group.name&&input.value===best.value);
            if(!selected){await stage('CHECKOUT','Selecionando a entrega pelo clique real do Puppeteer.');await handleClick(cartPage,locatePurchaseControl,{kind:'shipping',group:group.name,value:best.value});changed=true;await delay(400);}
          }
          if(!changed)break;if(round===3)throw new Error('As opções de frete não estabilizaram.');
        }
        // Product-page banners cannot establish the actual freight for this address and quantity.
        validateEconomics(stable.lines,await selectedShipping(),rules);
        await stage('CHECKOUT',`Frete selecionado e validado. Conferindo pagamento por ${payment}.`);
        let selection=await readValue(cartPage,checkoutSelectionInPage,paymentOptions);
        let paymentSourcePage=null;
        const adoptPaymentPage=page=>{session.adoptCartPage(page);syncPages();};
        const restorePaymentSource=()=>{if(cartPage.isClosed?.()&&paymentSourcePage&&!paymentSourcePage.isClosed?.())adoptPaymentPage(paymentSourcePage);};
        if(!hasPayment(selection)){
          await stage('CHECKOUT',`Abrindo a lista completa de pagamentos para localizar ${payment}.`);
          const source=cartPage;let popup;
          const opened=page=>{popup=page;};source.on('popup',opened);
          try{
            await handleClick(source,locatePurchaseControl,{kind:'showPayments'});
            for(let i=0;i<60&&!hasPayment(selection);i++){
              await check();await delay(250);
              if(popup&&popup.url()!=='about:blank'&&!popup.isClosed?.()&&cartPage!==popup){paymentSourcePage=source;adoptPaymentPage(popup);}
              await check(cartPage);selection=await readValue(cartPage,checkoutSelectionInPage,paymentOptions);
            }
          }finally{source.off('popup',opened);}
        }
        if(!hasPayment(selection))throw new Error(card?'Cartão de crédito configurado indisponível ou ambíguo no checkout.':'Pix indisponível no checkout.');
        if(!paymentSelected(selection)){
          await stage('CHECKOUT',`Selecionando pagamento por ${payment}.`);
          if(card)await handleClick(cartPage,checkoutSelectionInPage,{...paymentOptions,locateCard:true});
          else await handleClick(cartPage,locatePurchaseControl,{kind:'pix'});
          for(let i=0;i<40;i++){await check(cartPage);selection=await readValue(cartPage,checkoutSelectionInPage,paymentOptions);if(paymentSelected(selection))break;await delay(250);}
          if(!paymentSelected(selection))throw new Error(`A seleção de ${payment} não foi confirmada.`);
        }
        if(selection.canContinue){
          await stage('CHECKOUT',`Avançando para a revisão do pagamento por ${payment}.`);
          try{await handleClick(cartPage,locatePurchaseControl,{kind:'continue'});}
          catch(error){if(!cartPage.isClosed?.()||!paymentSourcePage||paymentSourcePage.isClosed?.())throw error;restorePaymentSource();}
        }
        let review,installmentAttempted=false,waitingForSecurity=false;
        for(let i=0;i<40;i++){
          restorePaymentSource();review=await readReview();
          if(card&&review.cardSelected&&review.securityCodeRequired){
            if(!waitingForSecurity){
              waitingForSecurity=true;
              await stage('WAITING_HUMAN','Digite o código de segurança na janela do Mercado Livre e aguarde a conferência.',{human:{kind:'CARD_SECURITY'}});
              await revealPurchasePage(cartPage);
              await notify?.({title:'Vigia · verificação do cartão',message:'Digite o código de segurança na janela do Mercado Livre.'}).catch(()=>{});
            }
            await delay(500);i=0;continue;
          }
          if(waitingForSecurity){
            waitingForSecurity=false;
            await stage('CHECKOUT','Conferindo novamente o pagamento com cartão.',{human:null});
          }
          if(review.hasFinalize&&review.paymentConfirmed)break;
          if(card&&!review.paymentConfirmed&&review.installmentChoice&&!installmentAttempted){
            installmentAttempted=true;
            await clickPurchaseControl(cartPage,checkoutSelectionInPage,{...paymentOptions,locateInstallment:true},{
              check,signal,selectValue:review.installmentChoice==='select'?'1':undefined,
            });
          }
          await delay(250);
        }
        if(!review?.paymentConfirmed||!review.hasFinalize)throw new Error(card?'Cartão configurado e pagamento à vista não confirmados na revisão.':'Revisão final com Pix não confirmada.');
        // Preserve individual limits: aggregated totals alone cannot prove a multi-product checkout.
        const finalLines=reviewLines(review,stable.lines,verified,parser.normalize);
        const baseEconomics=validateEconomics(finalLines,review.shippingCents,rules);
        const pixDiscountCents=card?0:statement.pixDiscountCents;
        const economics={...baseEconomics,couponDiscountCents:statement.couponDiscountCents,pixDiscountCents,totalCents:baseEconomics.totalCents-statement.couponDiscountCents-pixDiscountCents};
        if(await selectedShipping()!==review.shippingCents)throw new Error('O frete final diverge das opções selecionadas.');
        if(review.subtotalCents!==economics.subtotalCents||review.totalCents!==economics.totalCents)throw new Error('Total do checkout não reconciliado com produtos e frete.');
        // Recheck the cart in a separate owned tab just before finalization.
        await go(productPage,'https://www.mercadolivre.com.br/gz/cart/v2');
        const lastSnapshot=await readValue(productPage,readCartInPage);
        for(const line of lastSnapshot.items??[]){const ev=verified.get(identity(line));if(ev&&line.sellerId==null)line.sellerId=ev.sellerId;}
        const lastLines=validateCart(lastSnapshot,finalLines);
        const lastStatement=validateCartStatement(lastSnapshot,finalLines,rules);
        if(lastStatement.couponDiscountCents!==statement.couponDiscountCents||lastStatement.pixDiscountCents!==statement.pixDiscountCents)throw new Error('Cupons ou descontos mudaram durante a revisão final.');
        if(lastLines.some((line,i)=>line.unitCents!==finalLines[i].unitCents))throw new Error('Preço mudou durante a revisão.');
        const finalReview=await readReview();
        if(!finalReview.paymentConfirmed||!finalReview.hasFinalize||card&&finalReview.securityCodeRequired||finalReview.totalCents!==review.totalCents||finalReview.subtotalCents!==review.subtotalCents||finalReview.shippingCents!==review.shippingCents)throw new Error('Pagamento ou valores mudaram antes de finalizar.');
        const finalProof=reviewLines(finalReview,finalLines,verified,parser.normalize);
        if(finalProof.some((line,index)=>line.unitCents!==finalLines[index].unitCents))throw new Error('Preço individual mudou na revisão final.');
        if(await selectedShipping()!==finalReview.shippingCents)throw new Error('Frete alterado antes de finalizar.');
        await check(cartPage);
        await handleClick(cartPage,locatePurchaseControl,{kind:'final'},async()=>{
          finalizationStarted=true;
          await stage('FINALIZING',`Finalizando o pedido com pagamento por ${payment}.`,{items:finalLines,...economics,payment:chosenPayment});
        });
        if(card){
          let requestedSecurity=false;
          for(let i=0;i<40||requestedSecurity;i++){
            await check(cartPage,{afterFinalize:true});await delay(500);
            const html=await readHtml(cartPage);
            if(parser.cardApproved(html,cartPage.url())){
              const orderReferences=checkoutOrderReferences({store:'ml',urls:[cartPage.url()],html,projectRoot});
              completed={...economics,items:finalLines,payment:'credit_card',paid:true,orderReferences};
              return completed;
            }
            const selection=await readValue(cartPage,checkoutSelectionInPage,paymentOptions);
            if(selection.securityCodeRequired&&!requestedSecurity){
              requestedSecurity=true;
              await stage('WAITING_HUMAN','Conclua a verificação do cartão na janela do Mercado Livre.',{human:{kind:'CARD_SECURITY'}});
              await revealPurchasePage(cartPage);
              await notify?.({title:'Vigia · verificação do cartão',message:'Conclua a verificação na janela do Mercado Livre.'}).catch(()=>{});
            }
            if(requestedSecurity&&!selection.securityCodeVisible){
              requestedSecurity=false;i=0;
              await stage('FINALIZING','Conferindo a confirmação de pagamento com cartão.',{human:null});
            }
          }
          throw new Error('O Mercado Livre não confirmou o pagamento com cartão.');
        }
        for(let i=0;i<40;i++){
          await check(cartPage,{afterFinalize:true});await delay(500);
          try{
            const html=await readHtml(cartPage);
            const pix=parser.pix(html,economics.totalCents);
            const orderReferences=checkoutOrderReferences({store:'ml',urls:[cartPage.url()],html,projectRoot});
            completed={...pix,...economics,items:finalLines,payment:'pix',paid:false,orderReferences};
            return completed;
          }catch(error){if(i===39)throw error;}
        }
        throw new Error('Geração do Pix não confirmada.');
      }catch(error){
        if(error instanceof RevalidatePurchase&&!finalizationStarted)continue;
        throw error;
      }
    }
  }catch(error){failure=error;error.purchaseStep=checkpoint;throw error;}
  finally {
    try{await session.close();}
    catch(error){if(completed)completed.cleanupWarning=String(error.message);else if(failure)failure.cleanupWarning=String(error.message);else throw error;}
  }
}
