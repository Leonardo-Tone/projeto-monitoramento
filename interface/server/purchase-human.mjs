import { randomUUID } from 'node:crypto';
import { inspectPurchasePage } from './purchase-dom.mjs';
import { isMlBrowserWall, waitForMlBrowserWall } from './ml-verification.mjs';

const hosts=new Set(['www.mercadolivre.com.br','produto.mercadolivre.com.br','www.mercadopago.com.br']);
export function purchasePageKind(url,title='',challengeVisible=false) {
  let parsed;try{parsed=new URL(url);}catch{return 'INVALID';}
  if(parsed.protocol!=='https:'||!hosts.has(parsed.hostname)||parsed.username||parsed.password||parsed.port)return 'INVALID';
  if(isMlBrowserWall(url)&&!challengeVisible)return 'WALL';
  if(/(?:^|\/)(captcha|challenge|challenge-platform|account-verification|blocked|access-denied)(?:\/|$)/i.test(parsed.pathname)||challengeVisible||/captcha|robot check|verifica[çc][aã]o|seguran[çc]a\s*[—–-]\s*mercado livre/i.test(title))return 'CAPTCHA';
  if(/\/(?:login|auth|identification|registration)(?:\/|$)/i.test(parsed.pathname))return 'LOGIN';
  return 'READY';
}
export class RevalidatePurchase extends Error {
  constructor(){super('Verificação concluída; revalidando produtos e carrinho.');this.name='RevalidatePurchase';}
}
export async function revealPurchasePage(page) {
  let client,restored=false,focused=false;
  try {
    client=await page.target().createCDPSession();
    const {windowId}=await client.send('Browser.getWindowForTarget');
    if(windowId!=null){
      await client.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
      await client.send('Browser.setWindowBounds',{windowId,bounds:{left:40,top:40,width:1100,height:760}});
      restored=true;
    }
  }catch{}finally{if(client)await client.detach().catch(()=>{});}
  try{await page.bringToFront();focused=true;}catch{}
  return {restored,focused};
}
async function inspect(page) {
  if(page.isClosed?.())throw new Error('Navegador de compra fechado durante a verificação.');
  const url=page.url();
  const routeKind=purchasePageKind(url);
  if(routeKind==='INVALID')throw new Error('Destino de navegação inválido no perfil de compra.');
  if(routeKind==='CAPTCHA'||routeKind==='LOGIN')return {kind:routeKind};
  try {
    const state=await inspectPurchasePage(page);
    if(url!==page.url())return {kind:'LOADING'};
    const kind=purchasePageKind(url,state.title,state.challengeVisible);
    return {kind:kind==='READY'&&!state.loaded?'LOADING':kind};
  }catch(error){if(page.isClosed?.())throw error;return {kind:routeKind==='WALL'?'WALL':'LOADING'};}
}
function wait(ms,signal) {
  return new Promise((resolve,reject)=>{
    const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(new Error('Compra interrompida.'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},ms);
    signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  });
}
export function createPurchaseHumanGate({signal,stage,notify=async()=>{},inspectPage=inspect,reveal=revealPurchasePage,sleep=wait,openVisible=async page=>page,wallTimeoutMs=15000}) {
  return async function guard(page,{afterFinalize=false,expectedDestination,enteredWall=false}={}) {
    if(signal.aborted)throw new Error('Compra interrompida.');
    if(!page)return;
    let state=await inspectPage(page);
    for(let loading=0;state.kind==='LOADING'&&loading<40;loading++){await sleep(250,signal);state=await inspectPage(page);}
    if(state.kind==='WALL'||enteredWall&&state.kind==='READY'){
      state=await waitForMlBrowserWall(async()=>{
        const current=await inspectPage(page);
        return current.kind==='READY'&&expectedDestination&&!expectedDestination(page.url())?{kind:'LOADING'}:current;
      },{signal,timeoutMs:wallTimeoutMs,poll:ms=>sleep(ms,signal)});
      if(state.kind==='READY')return {wallCleared:true};
      if(state.kind==='WALL_TIMEOUT')state={kind:'CAPTCHA'};
    }
    if(state.kind==='LOADING')throw new Error('A página de compra não terminou de carregar para conferência.');
    if(state.kind==='INVALID')throw new Error('Destino de navegação inválido no perfil de compra.');
    if(!['CAPTCHA','LOGIN'].includes(state.kind))return;
    const kind=state.kind,startedAt=new Date().toISOString();
    await stage('WAITING_HUMAN',kind==='CAPTCHA'?'Resolva o CAPTCHA no navegador de compra. A tentativa está pausada.':'Conclua o login no navegador de compra. A tentativa está pausada.',{human:{kind,startedAt},resumeStatus:afterFinalize?'FINALIZING':'REVALIDATING'});
    try{page=await openVisible(page);}
    catch(error){await notify({id:randomUUID(),title:'Vigia · verificação necessária',message:'A compra foi pausada, mas não foi possível abrir a janela de verificação. Confira o perfil Compra.'}).catch(()=>{});throw error;}
    const visibility=await reveal(page).catch(()=>({restored:false,focused:false}));
    await stage('WAITING_HUMAN','Aguardando sua verificação no navegador de compra. Depois, os dados serão conferidos novamente.',{human:{kind,startedAt,...visibility},resumeStatus:afterFinalize?'FINALIZING':'REVALIDATING'});
    await notify({id:randomUUID(),title:'Vigia · verificação necessária',message:kind==='CAPTCHA'?'Resolva o CAPTCHA na janela de compra que foi aberta. O pedido está pausado.':'Conclua o login na janela de compra. O pedido está pausado.'}).catch(()=>{});
    let clean=0;
    while(clean<2){
      await sleep(1000,signal);if(signal.aborted)throw new Error('Compra interrompida.');
      state=await inspectPage(page);
      if(state.kind==='INVALID')throw new Error('A verificação saiu dos domínios permitidos da compra.');
      clean=state.kind==='READY'?clean+1:0;
    }
    await stage(afterFinalize?'FINALIZING':'RESUMING',afterFinalize?'Verificação concluída. Conferindo o resultado do pedido.':'Verificação concluída. Conferindo novamente anúncios, carrinho e preços.',{human:null});
    if(!afterFinalize)throw new RevalidatePurchase();
  };
}
