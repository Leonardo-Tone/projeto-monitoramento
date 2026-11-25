// DOM reads do not need Runtime.callFunctionOn. In particular, a checkout that
// is replacing its JS context must not turn a simple HTML read into a timeout.
const sessions=new WeakMap();
async function clientFor(page){
  let client=sessions.get(page);
  if(!client){client=await page.target().createCDPSession();sessions.set(page,client);page.once?.('close',()=>sessions.delete(page));}
  return client;
}
export async function readPurchaseHtml(page){
  const client=await clientFor(page);
  try{
    const {root}=await client.send('DOM.getDocument',{depth:0,pierce:false});
    const {outerHTML}=await client.send('DOM.getOuterHTML',{nodeId:root.nodeId});
    if(typeof outerHTML!=='string'||outerHTML.length>10000000)throw new Error('HTML do checkout ausente ou acima do limite.');
    return outerHTML;
  }catch(error){sessions.delete(page);await client.detach().catch(()=>{});throw error;}
}
export async function inspectPurchasePage(page){
  const html=await readPurchaseHtml(page);
  const title=html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]??'';
  let challengeVisible=false;
  if(/captcha|challenge|data-sitekey/i.test(html)){
    const client=await clientFor(page);
    const {root}=await client.send('DOM.getDocument',{depth:0,pierce:false});
    const {nodeIds}=await client.send('DOM.querySelectorAll',{nodeId:root.nodeId,selector:'iframe[src*="recaptcha"][src*="/anchor"]:not([src*="size=invisible"]),iframe[src*="recaptcha"][src*="/bframe"],iframe[src*="hcaptcha.com"][src*="checkbox"],.g-recaptcha[data-sitekey]:not([data-size="invisible"]),.h-captcha[data-sitekey]:not([data-size="invisible"])'});
    for(const nodeId of nodeIds.slice(0,20))try{const {model}=await client.send('DOM.getBoxModel',{nodeId});if(model.width>=20&&model.height>=20){challengeVisible=true;break;}}catch{}
  }
  return {title,challengeVisible,loaded:/<body\b/i.test(html)};
}
