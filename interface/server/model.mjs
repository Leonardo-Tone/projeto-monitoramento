import { randomUUID } from 'node:crypto';
import { applyMetadata } from './metadata.mjs';

export function productIdentity(value, store) {
  let u;
  try { u = new URL(value); } catch { throw new Error('Informe um link válido.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('Use um link HTTPS da loja, sem credenciais.');
  if (store === 'amazon') {
    if (!['amazon.com.br','www.amazon.com.br'].includes(u.hostname)) throw new Error('Use o link completo da Amazon Brasil.');
    const asin = u.pathname.match(/\/(?:dp|gp\/product)\/([a-z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
    if (!asin) throw new Error('O link Amazon precisa conter /dp/ASIN ou /gp/product/ASIN.');
    return { code:asin, type:'amazon', url:`https://www.amazon.com.br/dp/${asin}` };
  }
  if (store !== 'ml' || !['produto.mercadolivre.com.br','www.mercadolivre.com.br','mercadolivre.com.br'].includes(u.hostname)) throw new Error('Use um link completo do Mercado Livre Brasil.');
  const catalog = u.pathname.match(/\/(?:p\/(MLB\d+)|up\/(MLBU\d+))(?:\/|$)/i)?.slice(1).find(Boolean)?.toUpperCase();
  const item = catalog ? u.searchParams.get('pdp_filters')?.match(/(?:^|\|)item_id:(MLB\d+)(?:\||$)/i)?.[1]?.toUpperCase() : u.pathname.match(/(MLB)-?(\d+)/i)?.slice(1).join('').toUpperCase();
  if (!item) throw new Error(catalog ? 'No catálogo, use o link da oferta com pdp_filters=item_id:MLB… para identificar o anúncio exato.' : 'Não foi possível identificar o código MLB do anúncio.');
  if (!catalog && u.hostname !== 'produto.mercadolivre.com.br') throw new Error('Use o link do anúncio em produto.mercadolivre.com.br ou um catálogo com a oferta selecionada.');
  if (!catalog) return { code:item,type:'produto',url:`https://produto.mercadolivre.com.br/MLB-${item.slice(3)}-_JM` };
  u.hash='';
  return {code:item,catalog,type:'catalogo',url:u.href};
}

export function productInput(input, existing = null) {
  if (!input || !['amazon','ml'].includes(input.store)) throw new Error('Selecione uma plataforma válida.');
  const rawName=input.name??'';
  if (typeof rawName!=='string') throw new Error('Nome do produto inválido.');
  const name=rawName.trim();
  if (name.length>100) throw new Error('O nome deve ter até 100 caracteres.');
  if (typeof input.url!=='string'||input.url.length>2000) throw new Error('Link inválido.');
  const identity=productIdentity(input.url,input.store);
  const target=input.target??null;
  if(target!==null&&(!Number.isFinite(target)||target<=0||target>99999999.99)) throw new Error('Preço limite inválido.');
  for(const key of ['alert','auto']) if(input[key]!==undefined&&typeof input[key]!=='boolean') throw new Error('Regra inválida.');
  const expectedSellerId=input.expectedSellerId||null;
  const quantity=input.quantity??existing?.quantity??1;
  if(!Number.isInteger(quantity)||quantity<1||quantity>100)throw new Error('Quantidade deve ficar entre 1 e 100.');
  if(expectedSellerId!==null&&(typeof expectedSellerId!=='string'||!/^\d{1,20}$/.test(expectedSellerId))) throw new Error('O ID do vendedor deve conter apenas números.');
  return {
    ...(existing??{}),id:existing?.id??randomUUID(),store:input.store,name,...identity,catalog:identity.catalog??null,
    expectedSellerId:input.store==='ml'?expectedSellerId:null,
    target:target===null?null:Math.round(target*100)/100,
    quantity,
    alert:input.alert??existing?.alert??false,
    auto:input.auto??existing?.auto??false,
    price:existing?.price??null,available:existing?.available??null,
    seller:existing?.seller??'Não informado',delivery:existing?.delivery??'Não informado',
    freight:existing?.freight??null,art:existing?.art??'box',sample:false,
    lastCheckedAt:existing?.lastCheckedAt??null,lastAttemptAt:existing?.lastAttemptAt??null,
    error:existing?.error??null,observation:existing?.observation??null,
  };
}

export function applyObservation(product, result) {
  const at=result.at??new Date().toISOString();
  product.lastAttemptAt=at;
  if(result.error) {
    product.error=String(result.error).slice(0,300);
    product.observation='DESATUALIZADO';
    return;
  }
  product.lastCheckedAt=at;
  product.error=null;
  product.price=result.price??null;
  product.available=result.available??null;
  product.seller=result.seller??'Não informado';
  product.delivery=result.delivery??'Não informado';
  product.freight=result.freight??null;
  product.observation=result.observation??null;
  product.coverage=result.coverage??null;
  for(const key of ['sellerId','variationId','rawAvailable','eligible','eligibilityReason','shippingMode','logisticType','reputationLevel','powerSellerStatus','amazonOffers'])if(key in result)product[key]=result[key];
  if(product.store==='ml')product.sellerInfoSource='monitoring-html';
  applyMetadata(product,result,at);
}

export function amazonObservation(snapshot) {
  const offers=(snapshot.ofertas??[]).filter(o=>Number.isInteger(o.precoNormalCentavos));
  offers.sort((a,b)=>a.precoNormalCentavos-b.precoNormalCentavos);
  const offer=offers[0];
  return {at:snapshot.horario,price:offer?offer.precoNormalCentavos/100:null,available:offer?true:null,
    seller:offer?.vendedor,delivery:offer?.enviadoPor,freight:offer?.freteCentavos==null?null:offer.freteCentavos/100,
    observation:offer?'OFERTA_VISIVEL':'NAO_OBSERVADO',coverage:snapshot.cobertura,amazonOffers:snapshot.ofertas??[]};
}

// Two consecutive valid ML observations; errors and identity mismatches reset candidates.
export function confirmML(product,result) {
  const previous=product.mlConfirmation??{confirmed:null,pending:null,count:0};
  if(result.error||!['available','unavailable'].includes(result.observation)) {
    product.mlConfirmation={...previous,pending:null,count:0};return [];
  }
  const sellerIdentity=result.sellerId!=null?String(result.sellerId):result.seller??null;
  // Display-name improvements must not look like a new seller or trigger an alert.
  if(result.sellerId!=null){
    if(previous.confirmed?.seller===`Vendedor ${sellerIdentity}`)previous.confirmed.seller=sellerIdentity;
    if(previous.pending){try{const pending=JSON.parse(previous.pending);if(pending.seller===`Vendedor ${sellerIdentity}`){pending.seller=sellerIdentity;previous.pending=JSON.stringify(pending);}}catch{/* Older invalid pending signatures will be replaced. */}}
  }
  const current={available:result.available===true&&result.eligible!==false,withinTarget:result.available===true&&result.eligible!==false&&product.target!==null&&result.price!==null&&result.price<=product.target,seller:sellerIdentity};
  const signature=JSON.stringify(current);
  const count=signature===previous.pending?previous.count+1:1;
  if(count<2){product.mlConfirmation={...previous,pending:signature,count};return [];}
  const before=previous.confirmed;
  product.mlConfirmation={confirmed:current,pending:signature,count:2};
  const events=[];
  if(current.available&&(!before?.available||before.seller!==current.seller))events.push('DISPONIBILIDADE_CONFIRMADA');
  if(current.withinTarget&&!before?.withinTarget)events.push('ALVO_ATINGIDO');
  return events.map(type=>({id:randomUUID(),productId:product.id,type,at:result.at??new Date().toISOString()}));
}
