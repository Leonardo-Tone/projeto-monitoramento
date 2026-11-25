export const purchaseDefaults=()=>({enabled:false,freeShippingOnly:false,maxShippingCents:null,includeShipping:false,paymentMethod:'pix',cardLastFour:null});
export function validatePurchaseSettings(input={}) {
  const defaults=purchaseDefaults();
  const value={...defaults,...input};
  if(Object.keys(value).some(k=>!Object.hasOwn(defaults,k))||['enabled','freeShippingOnly','includeShipping'].some(k=>typeof value[k]!=='boolean')||value.maxShippingCents!==null&&(!Number.isSafeInteger(value.maxShippingCents)||value.maxShippingCents<0||value.maxShippingCents>9999999999))throw new Error('Configuração de compra ou frete inválida.');
  if(!['pix','credit_card','pix_with_discount'].includes(value.paymentMethod))throw new Error('Forma de pagamento inválida.');
  if(value.paymentMethod!=='pix'&&(typeof value.cardLastFour!=='string'||!/^\d{4}$/.test(value.cardLastFour)))throw new Error('Informe os quatro últimos dígitos do cartão salvo no perfil Compra.');
  if(value.paymentMethod==='pix')value.cardLastFour=null;
  return value;
}
export function resolveMlPayment(method,pixDiscountCents) {
  if(method!=='pix_with_discount')return method;
  if(!Number.isSafeInteger(pixDiscountCents)||pixDiscountCents<0)throw new Error('Desconto Pix não confirmado no carrinho.');
  return pixDiscountCents>0?'pix':'credit_card';
}
export function identity(item) {
  const id=item.itemId??item.code;
  if(typeof id!=='string'||!/^MLB\d+$/.test(id))throw new Error('Anúncio ML inválido.');
  let variation=item.variationId??null;
  if(variation==='not_apply')variation=null;
  if(variation!==null&&!/^[1-9]\d{0,19}$/.test(String(variation)))throw new Error('Variação do anúncio inválida.');
  return `${id}:${variation??''}`;
}
export function allowedQuantity(wanted,limits) {
  if(!Number.isInteger(wanted)||wanted<1||wanted>100)throw new Error('Quantidade deve ficar entre 1 e 100.');
  if(!Number.isInteger(limits.available)||limits.available<0||!Number.isInteger(limits.maximum)||limits.maximum<1||!Number.isInteger(limits.minimum)||limits.minimum<1)throw new Error('Limites de quantidade não confirmados pelo carrinho.');
  const result=Math.min(wanted,limits.available,limits.maximum);
  if(result<limits.minimum)throw new Error('Quantidade disponível abaixo do mínimo da oferta.');
  return result;
}
export function allocateShipping(lines,shippingCents) {
  if(!Number.isSafeInteger(shippingCents)||shippingCents<0)throw new Error('Frete não informado.');
  const total=lines.reduce((sum,line)=>sum+line.unitCents*line.quantity,0);
  if(!Number.isSafeInteger(total)||total<=0)throw new Error('Subtotal inválido.');
  const allocated=lines.map((line,index)=>{
    const numerator=BigInt(shippingCents)*BigInt(line.unitCents)*BigInt(line.quantity);
    return {index,cents:Number(numerator/BigInt(total)),remainder:numerator%BigInt(total)};
  });
  let remaining=shippingCents-allocated.reduce((sum,row)=>sum+row.cents,0);
  for(const row of [...allocated].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1)){if(remaining-->0)row.cents++;}
  return allocated.map(row=>row.cents);
}
export function validateEconomics(lines,shippingCents,rules) {
  if(rules.freeShippingOnly&&shippingCents!==0)throw new Error('A compra exige frete grátis.');
  if(rules.maxShippingCents!==null&&shippingCents>rules.maxShippingCents)throw new Error('Frete acima do teto configurado.');
  const allocations=allocateShipping(lines,shippingCents);
  for(const [i,line]of lines.entries()){
    if(!Number.isInteger(line.quantity)||line.quantity<1||!Number.isSafeInteger(line.unitCents)||line.unitCents<=0||!Number.isSafeInteger(line.limitCents)||line.limitCents<=0)throw new Error('Preço ou quantidade não confirmado.');
    if(line.unitCents*line.quantity+(rules.includeShipping?allocations[i]:0)>line.limitCents*line.quantity)throw new Error(`Preço por unidade acima do limite: ${line.name??line.itemId}.`);
  }
  return {allocations,subtotalCents:lines.reduce((s,l)=>s+l.unitCents*l.quantity,0),shippingCents,totalCents:lines.reduce((s,l)=>s+l.unitCents*l.quantity,0)+shippingCents};
}
export function validateCart(cart,expected) {
  if(!cart.complete||!Array.isArray(cart.items))throw new Error('Leitura incompleta do carrinho.');
  const allKeys=cart.items.map(identity);
  if(new Set(allKeys).size!==allKeys.length)throw new Error('Anúncio/variação duplicado no carrinho.');
  const selected=cart.items.filter(item=>item.checked);
  if(selected.length!==expected.length)throw new Error('Há produtos a mais ou a menos selecionados no carrinho.');
  return expected.map(wanted=>{
    const actual=selected.find(item=>identity(item)===identity(wanted));
    if(!actual||actual.disabled||actual.quantity!==wanted.quantity)throw new Error('Identidade, seleção ou quantidade divergente no carrinho.');
    if(wanted.sellerId&&String(actual.sellerId)!==String(wanted.sellerId))throw new Error('Vendedor divergente no carrinho.');
    if(!Number.isSafeInteger(actual.unitCents)||actual.unitCents<=0)throw new Error('Preço unitário do carrinho desconhecido.');
    return {...wanted,unitCents:actual.unitCents};
  });
}
export function candidates(products,orders,freshIds,now=Date.now()) {
  const blocked=new Set(orders.filter(order=>!['CANCELLED','CLOSED'].includes(order.status)).flatMap(order=>order.items.map(item=>item.productId)));
  return products.filter(p=>p.store==='ml'&&p.auto&&p.available===true&&p.eligible!==false&&!p.error&&freshIds.has(p.id)&&p.target>0&&Number.isFinite(p.price)&&p.price<=p.target&&p.sellerId&&p.mlConfirmation?.confirmed?.available===true&&!blocked.has(p.id)&&now-Date.parse(p.lastCheckedAt)<90000).map(p=>({productId:p.id,itemId:p.code,variationId:p.variationId??null,catalog:p.catalog,type:p.type,sellerId:p.sellerId,name:p.title||p.name||p.code,url:p.url,quantity:p.quantity??1,requestedQuantity:p.quantity??1,limitCents:Math.round(p.target*100)}));
}
export function reviewLines(review,expected,verified,normalize) {
  if(review.lineEvidenceInvalid)throw new Error('Identidades, quantidades ou preços conflitantes na revisão do checkout.');
  if(review.lines.length)return validateCart({complete:true,items:review.lines.map(item=>({...item,sellerId:item.sellerId??verified.get(identity(item))?.sellerId,checked:true,disabled:false}))},expected);
  if(expected.length===1&&review.titles.length===1&&normalize(review.titles[0])===normalize(expected[0].name)&&Number.isSafeInteger(review.subtotalCents)){
    const item=expected[0];if(review.subtotalCents%item.quantity!==0)throw new Error('Preço unitário final não verificável.');
    return [{...item,unitCents:review.subtotalCents/item.quantity}];
  }
  throw new Error('Revisão do lote sem preços e identidades individuais verificáveis. É necessária revisão manual.');
}
export function validateCartStatement(cart,expected,rules) {
  const lines=validateCart(cart,expected),statement=cart.economics;
  if(statement?.complete!==true)throw new Error(statement?.reason??'Extrato econômico do carrinho incompleto.');
  const limits=validateEconomics(lines,statement.shippingCents,rules);
  if(limits.subtotalCents!==statement.productsCents||statement.totalCents!==statement.productsCents+statement.shippingCents-statement.couponDiscountCents-statement.pixDiscountCents)throw new Error('Extrato econômico não corresponde aos produtos do lote.');
  return {...limits,totalCents:statement.totalCents,couponDiscountCents:statement.couponDiscountCents,pixDiscountCents:statement.pixDiscountCents,usedCoupons:statement.usedCoupons};
}
