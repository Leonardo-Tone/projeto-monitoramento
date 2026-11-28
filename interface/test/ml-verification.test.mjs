import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { consultarCatalogo, consultarProduto } from '../server/ml-v3-core.mjs';
import { waitForMlBrowserWall, sameMlDestination } from '../server/ml-verification.mjs';
import { productIdentity } from '../server/model.mjs';

const product={url:'https://produto.mercadolivre.com.br/MLB-123-_JM'};
const wall='https://www.mercadolivre.com.br/captcha/wall/logged';
const productHtml='<html><title>Anúncio</title><body>Produto</body></html>';

function navigationPage({captcha=false}={}){
  const page=new EventEmitter();
  const frame={};
  let current='about:blank',closed=false;
  page.mainFrame=()=>frame;
  page.url=()=>current;
  page.isClosed=()=>closed;
  page.close=async()=>{closed=true;};
  const navigate=(url,status)=>{
    current=url;
    const response={status:()=>status,url:()=>url,request:()=>({isNavigationRequest:()=>true,frame:()=>frame})};
    page.emit('response',response);
    return response;
  };
  page.goto=async()=>navigate(wall,403);
  page.content=async()=>productHtml;
  page.target=()=>({createCDPSession:async()=>({send:async method=>{
    if(method==='DOM.getDocument')return {root:{nodeId:1}};
    if(method==='DOM.getOuterHTML'){
      if(!captcha&&current===wall){
        navigate(product.url,200);
        return {outerHTML:'<html><body>Verificando</body></html>'};
      }
      return {outerHTML:captcha?'<html><body><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></body></html>':productHtml};
    }
    if(method==='DOM.querySelectorAll')return {nodeIds:[2]};
    if(method==='DOM.getBoxModel')return {model:{width:300,height:70}};
    throw Error(method);
  }})});
  return page;
}

test('monitor uses the actual response from the listing after the browser wall redirects',async()=>{
  const result=await consultarCatalogo(navigationPage(),product);
  assert.equal(result.http,200);
  assert.equal(result.urlFinal,product.url);
  assert.equal(result.html,productHtml);
});

test('redirect from a fetch opens a real tab in the same profile and closes only that tab',async()=>{
  const tab=navigationPage();
  const result=await consultarProduto({evaluate:async()=>({navigationRequired:true})},product,{browser:{newPage:async()=>tab}});
  assert.equal(result.http,200);
  assert.equal(tab.isClosed(),true);
});

test('monitor reports a visible CAPTCHA without waiting for the wall timeout',async()=>{
  const result=await consultarCatalogo(navigationPage({captcha:true}),product);
  assert.match(result.erro,/CAPTCHA no Mercado Livre/);
  assert.equal(result.html,null);
});

test('wall timeout also bounds an inspection that does not respond',async()=>{
  assert.deepEqual(await waitForMlBrowserWall(()=>new Promise(()=>{}),{timeoutMs:10}),{kind:'WALL_TIMEOUT'});
});

test('Mercado Livre /up/MLBU user-product URLs with pdp_filters=item_id are accepted and matched',()=>{
  const raw='https://www.mercadolivre.com.br/colecao-premium-ditto-pokemon-30-anos-copag/up/MLBU4784057981?pdp_filters=item_id%3AMLB7447549256&matt_event_ts=1795489829693#polycard_client=recommendations';
  const id=productIdentity(raw,'ml');
  assert.equal(id.code,'MLB7447549256');
  assert.equal(id.catalog,'MLBU4784057981');
  assert.equal(id.type,'catalogo');
  assert.equal(id.url.includes('#'),false);
  assert.equal(sameMlDestination('https://www.mercadolivre.com.br/outro-slug/up/MLBU4784057981',id.url),true);
  assert.throws(()=>productIdentity('https://www.mercadolivre.com.br/produto/up/MLBU4784057981','ml'),/pdp_filters=item_id:MLB/);
});
