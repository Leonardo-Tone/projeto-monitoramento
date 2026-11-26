import { purchaseDefaults, validatePurchaseSettings } from './purchase-rules.mjs';
export const reputationLevels=['1_red','2_orange','3_yellow','4_light_green','5_green'];
export const reputationMedals=['silver','gold','platinum'];
export const defaults=()=>({amazon:{onlyAmazon:false,purchase:purchaseDefaults()},ml:{requireReputation:false,minReputation:'5_green',requireLeader:false,minLeader:'silver',matchMode:'all',purchase:purchaseDefaults()}});
export function validateSettings(input) {
  if(!input||Object.keys(input).some(k=>!['amazon','ml'].includes(k)))throw new Error('Configuração inválida.');
  const amazon=input.amazon,raw=input.ml;
  const ml=raw?{...raw,requireLeader:raw.requireLeader??false,minLeader:raw.minLeader??'silver',matchMode:raw.matchMode??'all'}:null;
  // Migrate the previous combined selector without changing its meaning.
  if(ml&&raw.requireLeader===undefined&&reputationMedals.includes(raw.minReputation)){ml.requireLeader=raw.requireReputation;ml.minLeader=raw.minReputation;ml.requireReputation=false;ml.minReputation='5_green';}
  if(!amazon||Object.keys(amazon).some(k=>!['onlyAmazon','purchase'].includes(k))||typeof amazon.onlyAmazon!=='boolean')throw new Error('Configuração Amazon inválida.');
  const amazonPurchase=validatePurchaseSettings(amazon.purchase);
  if(amazonPurchase.paymentMethod!=='pix')throw new Error('A compra automática da Amazon aceita somente Pix.');
  if(!ml||Object.keys(ml).some(k=>!['requireReputation','minReputation','requireLeader','minLeader','matchMode','purchase'].includes(k))||typeof ml.requireReputation!=='boolean'||typeof ml.requireLeader!=='boolean'||!reputationLevels.includes(ml.minReputation)||!reputationMedals.includes(ml.minLeader)||!['all','any'].includes(ml.matchMode))throw new Error('Selecione critérios de reputação válidos.');
  return {amazon:{onlyAmazon:amazon.onlyAmazon,purchase:amazonPurchase},ml:{requireReputation:ml.requireReputation,minReputation:ml.minReputation,requireLeader:ml.requireLeader,minLeader:ml.minLeader,matchMode:ml.matchMode,purchase:validatePurchaseSettings(ml.purchase)}};
}
export function reputationMatches(level,medal,minimum) {
  if(reputationMedals.includes(minimum))return reputationMedals.includes(medal)&&reputationMedals.indexOf(medal)>=reputationMedals.indexOf(minimum);
  return reputationLevels.includes(level)&&reputationLevels.indexOf(level)>=reputationLevels.indexOf(minimum);
}
export function deliveryLabel(mode,type) {
  if(mode!=='me2')return 'Não informado';
  return ({fulfillment:'Mercado Envios Full',cross_docking:'Mercado Envios Coleta',drop_off:'Mercado Envios · postagem',xd_drop_off:'Mercado Envios · agência',self_service:'Mercado Envios Flex'})[type]??'Mercado Envios';
}
export function qualifyObservation(result,store,settings=defaults()) {
  if(result.error)return result;
  let data={...result,rawAvailable:result.rawAvailable??result.available??null,eligible:true,eligibilityReason:null};
  if(store==='amazon'&&Array.isArray(result.amazonOffers)){
    const offers=result.amazonOffers.filter(o=>Number.isInteger(o.precoNormalCentavos)).sort((a,b)=>a.precoNormalCentavos-b.precoNormalCentavos);
    const eligible=settings.amazon.onlyAmazon?offers.filter(o=>o.categoria==='AMAZON_DIRETA'):offers;
    const offer=eligible[0]??offers[0];
    Object.assign(data,{rawAvailable:offers.length?true:null,available:eligible.length?true:offers.length?false:null,
      price:offer?offer.precoNormalCentavos/100:null,seller:offer?.vendedor??'Não informado',delivery:offer?.enviadoPor??'Não informado',freight:offer?.freteCentavos==null?null:offer.freteCentavos/100,
      eligible:!settings.amazon.onlyAmazon||eligible.length>0,eligibilityReason:settings.amazon.onlyAmazon&&!eligible.length?'Nenhuma oferta vendida e entregue pela Amazon foi observada.':null});
  }else if(store==='ml'&&(settings.ml.requireReputation||settings.ml.requireLeader)){
    const criteria=[];
    if(settings.ml.requireReputation)criteria.push(reputationMatches(result.reputationLevel,null,settings.ml.minReputation));
    if(settings.ml.requireLeader)criteria.push(reputationMatches(null,result.powerSellerStatus,settings.ml.minLeader));
    data.eligible=settings.ml.matchMode==='any'?criteria.some(Boolean):criteria.every(Boolean);
    data.eligibilityReason=data.eligible?null:!result.reputationLevel&&!result.powerSellerStatus?'Reputação e medalha do vendedor não informadas.':'O vendedor não atende aos critérios de reputação configurados.';
    data.available=data.rawAvailable===true&&!data.eligible?false:data.rawAvailable;
  }
  return data;
}
