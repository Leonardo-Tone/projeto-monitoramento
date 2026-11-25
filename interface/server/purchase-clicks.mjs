// Browser-side functions only locate controls. Mouse events always come from
// Puppeteer's ElementHandle.click(), including delivery and payment options.
import { readAcrossNavigation, navigationContextChanged } from './purchase-navigation.mjs';
import { isMlBrowserWall } from './ml-verification.mjs';
export function locatePurchaseControl({kind,group,value}) {
  const visible=el=>el.getClientRects().length>0&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';
  const paymentModal=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],.andes-modal__content')].find(el=>visible(el)&&el.querySelector('input[type="radio"][name="transfers"],input[type="radio"][name="payment-method-radio-list"]'));
  const scope=(kind==='pix'||kind==='continue')&&paymentModal?paymentModal:document;
  if(kind==='shipping'||kind==='pix'){
    const inputs=[...scope.querySelectorAll('input[type="radio"]')].filter(input=>!input.disabled&&(kind==='shipping'?input.name===group&&input.value===value:(input.value==='pix'||input.id.startsWith('pix-'))));
    const labels=inputs.map(input=>[...scope.querySelectorAll('label')].find(label=>label.htmlFor===input.id)??input).filter(visible);
    return labels.length===1?labels[0]:null;
  }
  if(kind==='showPayments'){
    const links=[...document.querySelectorAll('.bf-payments__footer_action a,.bf-payments__footer_action button')].filter(el=>visible(el)&&/^Mostrar (todos|mais)$/i.test(el.textContent.trim().replace(/\s+/g,' ')));
    return links.length===1?links[0]:null;
  }
  if(kind==='add'){
    const buttons=[...document.querySelectorAll('button,a[role="button"],a.andes-button')].filter(el=>visible(el)&&el.textContent.trim()==='Adicionar ao carrinho');
    const matches=buttons.filter(el=>[el.getAttribute('href'),el.getAttribute('formaction'),(el.form??el.closest('form'))?.getAttribute('action')].filter(Boolean).every(value=>{try{const url=new URL(value,location.href);return url.protocol==='https:'&&['www.mercadolivre.com.br','produto.mercadolivre.com.br'].includes(url.hostname)&&!/checkout|payment|purchase|order/i.test(url.pathname);}catch{return false;}}));
    return matches.length===1?matches[0]:null;
  }
  const buttons=[...scope.querySelectorAll(kind==='final'?'button[data-testid="confirm_purchase_button"]':'button[data-testid="continue_button"]')].filter(visible);
  return buttons.length===1?buttons[0]:null;
}
export function checkoutSelectionInPage({cardLastFour=null,locateCard=false,locateInstallment=false}={}){
  const visible=el=>el.getClientRects().length>0&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';
  const modal=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],.andes-modal__content')].find(el=>visible(el)&&el.querySelector('input[type="radio"][name="transfers"],input[type="radio"][name="payment-method-radio-list"]'));
  const scope=modal??document;
  const radios=[...document.querySelectorAll('input[type="radio"]')];
  const control=input=>[...document.querySelectorAll('label')].find(label=>label.htmlFor===input.id)??input;
  const payments=[...scope.querySelectorAll('input[type="radio"]')].filter(input=>!input.disabled&&(input.name==='payment-method-radio-list'||input.name==='transfers')&&visible(control(input)));
  const selected=payments.filter(input=>input.checked);
  const normalize=text=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
  const cards=cardLastFour?payments.filter(input=>{
    const label=control(input),row=input.closest('.bf-payments__radio-item')??label;
    const text=normalize((label.getAttribute('aria-label')??'')+' '+row.textContent);
    const endings=[...text.matchAll(/(?:terminad[oa]\s+em\s+|\*{2,}\s*|•{2,}\s*)(\d{4})(?!\d)/g)].map(match=>match[1]);
    const credit=/\b(?:credito|sem juros|parcelas?)\b/.test(text)||row.getAttribute('data-payment-type')==='credit_card'||input.getAttribute('data-payment-type')==='credit_card';
    return credit&&!/\b(?:debito|pre.pago)\b/.test(text)&&endings.length>0&&endings.every(end=>end===cardLastFour);
  }):[];
  const card=cards.length===1?cards[0]:null;
  if(locateCard)return card?control(card):null;
  const cardSelected=Boolean(card&&selected.length===1&&selected[0]===card);
  const cardRow=card?.closest('.bf-payments__radio-item')??(card?control(card):null);
  const installmentText=normalize(cardRow?.textContent??'').replace(/\bate\s+\d+\s*x\b/g,'');
  const installmentControls=cardSelected?[...scope.querySelectorAll('select[name*="installment" i],input[type="radio"][name*="installment" i]')].filter(el=>!el.disabled&&visible(el.type==='radio'?control(el):el)):[];
  const installments=installmentControls.filter(el=>el.type!=='radio'||el.checked);
  const singlePayment=installmentControls.filter(el=>el.type==='radio'?el.value==='1':[...el.options].some(option=>option.value==='1'&&!option.disabled));
  const installment=singlePayment.length===1?singlePayment[0]:null;
  if(locateInstallment)return installment?.type==='radio'?control(installment):installment;
  const cardInFull=cardSelected&&(installmentControls.length?installments.length===1&&installments[0].value==='1':
    /\b(?:a vista|1\s*x)\b/.test(installmentText)&&!/\b(?:[2-9]\d*|1\d+)\s*x\b/.test(installmentText));
  const securityFields=[...document.querySelectorAll('input[autocomplete="cc-csc"],input[name="security_code"],input[name="securityCode"],input[name="cvv"],input[name="cvc"]')].filter(visible);
  return {
    shipping:radios.filter(input=>input.name.startsWith('shipping-options-')&&input.checked).map(input=>({group:input.name,value:input.value})),
    hasPix:payments.some(input=>input.value==='pix'||input.id.startsWith('pix-')),
    pix:selected.length===1&&(selected[0].value==='pix'||selected[0].id.startsWith('pix-')),
    hasCard:card!==null,
    cardSelected,
    cardInFull,
    installmentChoice:installment?(installment.type==='radio'?'radio':'select'):null,
    securityCodeVisible:securityFields.length>0,
    securityCodeRequired:securityFields.some(input=>!/^\d{3,4}$/.test(input.value)),
    canContinue:[...scope.querySelectorAll('button[data-testid="continue_button"]')].some(visible),
    canFinalize:!modal&&[...document.querySelectorAll('button[data-testid="confirm_purchase_button"]')].some(visible),
  };
}
export async function clickPurchaseControl(page,locate,args,{check=async()=>{},beforeClick,signal,selectValue}={}) {
  await check(page);
  // Even headless Chrome has an active tab. Puppeteer's visibility/scroll
  // checks can wait forever for IntersectionObserver in a background tab.
  // CEPO activates the target tab before physical input for the same reason.
  await page.bringToFront();
  let handle;
  try{handle=await readAcrossNavigation(page,()=>page.evaluateHandle(locate,args),{signal});}
  catch(error){await check(page);throw error;}
  try {
    const element=handle.asElement();
    if(!element){await check(page);throw new Error('Controle esperado não identificado de forma única.');}
    if(beforeClick)await beforeClick();
    try{
      if(selectValue===undefined)await element.click();
      else if(!(await element.select(selectValue)).includes(selectValue))throw new Error('A opção de pagamento à vista não foi aplicada.');
    }
    catch(error){if(!navigationContextChanged(error)||page.isClosed?.())throw error;return {inputAttempted:true,contextChanged:true};}
    return {inputAttempted:true,contextChanged:false};
  }finally{try{await handle.dispose();}catch(error){if(!navigationContextChanged(error))throw error;}}
}
export async function continueCartByClick(page,href,{check=async()=>{},signal}={}) {
  const source=new URL(page.url());
  if(source.origin!=='https://www.mercadolivre.com.br'||!/^\/gz\/cart\/v[23]\/?$/.test(source.pathname))throw new Error('Continuar só pode ser acionado no carrinho confirmado.');
  let navigation;
  await clickPurchaseControl(page,({href})=>{
    const links=[...document.querySelectorAll('a.cl-summary__button')].filter(el=>el.getClientRects().length&&el.getAttribute('aria-disabled')!=='true'&&/^Continuar\b/.test(el.textContent.trim())&&el.href===href);
    return links.length===1?links[0]:null;
  },{href},{check,signal,beforeClick:()=>{
    // Register before the real click; absorb a navigation timeout only after
    // checking the resulting page. A timeout never causes a second click.
    navigation=page.waitForNavigation({waitUntil:'domcontentloaded',timeout:20000}).then(response=>({response}),error=>({error}));
  }});
  const outcome=await navigation;
  const isCheckout=value=>{const url=new URL(value);return url.origin==='https://www.mercadolivre.com.br'&&url.pathname.startsWith('/gz/checkout/');};
  const verification=await check(page,{expectedDestination:isCheckout,enteredWall:isMlBrowserWall(outcome.response?.url?.())});
  const url=new URL(page.url());
  if(url.protocol!=='https:'||url.hostname!=='www.mercadolivre.com.br'||!url.pathname.startsWith('/gz/checkout/'))throw new Error('O clique em Continuar não abriu o checkout confirmado.');
  if(!verification?.wallCleared&&outcome.response&&outcome.response.status()!==200)throw new Error('Checkout: HTTP '+outcome.response.status());
}
