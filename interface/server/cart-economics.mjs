// Contract observed in CEPO/manual-validator-page: one cart-list response contains
// identities, prices, current shipping, coupon campaigns and corroborating totals.
export function projectCartEconomics(root,items) {
  const fail=reason=>({complete:false,reason});
  const cents=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<1000000?Math.round(value*100):null;
  const money=row=>{
    const entries=Array.isArray(row?.value?.values)?row.value.values.filter(v=>v.key==='price'):[];
    if(entries.length===1){const v=entries[0];if(v.type==='price'&&v.price?.currency==='BRL'&&!v.price.previous)return cents(v.price.value);if(v.type==='label'&&v.label?.text?.trim()==='Grátis')return 0;return null;}
    if(entries.length>1)return null;
    const text=row?.value?.text?.replace(/\u00a0/g,' ').trim();if(text==='Grátis')return 0;
    const m=typeof text==='string'?text.match(/^(-)?\s*R\$\s*(-)?\s*(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})$/):null;
    return m?Number(m[3].replace(/\./g,''))*100*(m[1]||m[2]?-1:1)+Number(m[4])*(m[1]||m[2]?-1:1):null;
  };
  const rows=root?.summary?.ticket_rows,tracking=root?.tracking?.summary;
  if(!Array.isArray(rows)||!tracking||rows.some(r=>!['item','discount','shipping'].includes(r.id)))return fail('Resumo econômico do carrinho desconhecido.');
  if(Object.keys(root.summary).filter(k=>k.endsWith('_row')).some(k=>!['coupon_row','pix_row','total_row'].includes(k)))return fail('Parcela econômica do carrinho não reconhecida.');
  const one=id=>{const matches=rows.filter(r=>r.id===id);return matches.length===1?matches[0]:null;};
  const gross=money(one('item')),shipping=money(one('shipping')),total=money(root.summary.total_row);
  const corroborating=cents(tracking.total?.amount),shippingCheck=cents(tracking.shipping_total?.amount);
  if([gross,shipping,total,corroborating,shippingCheck].includes(null)||gross<0||shipping<0||total<0||total!==corroborating||shipping!==shippingCheck)return fail('Produtos, frete ou total não conciliados entre resumo e tracking.');
  const selected=items.filter(i=>i.checked&&!i.disabled);
  if(!selected.length||selected.some(i=>!Number.isSafeInteger(i.unitCents)))return fail('Preços dos produtos selecionados não confirmados.');
  const products=selected.reduce((sum,i)=>sum+i.unitCents*i.quantity,0);
  const discountRows=rows.filter(r=>r.id==='discount');
  let productDiscount=0;
  if(discountRows.length){
    if(discountRows.length!==1)return fail('Desconto de produto ambíguo.');
    const row=discountRows[0];const values=row?.value?.values?.filter(v=>v.key==='discount')??[];
    const value=values.length===1&&values[0].type==='price'&&values[0].price?.currency==='BRL'?cents(values[0].price.value):money(row);
    if(value===null||value>0)return fail('Desconto de produto desconhecido.');productDiscount=-value;
  }
  if(gross-productDiscount!==products)return fail('Preço unitário e subtotal dos produtos divergem.');
  const groups=root.tracking.grouping_items;
  if(!Array.isArray(groups))return fail('Grupos econômicos do carrinho não informados.');
  const active=groups.filter(g=>g.group_status==='selected');
  const selectedIds=selected.map(i=>i.itemId).sort();
  const groupIds=active.flatMap(g=>Array.isArray(g.items_id)?g.items_id:[]).sort();
  if(JSON.stringify(selectedIds)!==JSON.stringify(groupIds)||new Set(selectedIds).size!==selectedIds.length)return fail('Grupos econômicos não correspondem aos produtos selecionados.');
  const campaigns=new Map();let couponDiscount=0;
  for(const group of active){
    const quantity=selected.filter(i=>group.items_id.includes(i.itemId)).reduce((sum,i)=>sum+i.quantity,0);
    if(Number(group.total_active_quantity_items)!==quantity||!Array.isArray(group.coupons))return fail('Quantidade ou cupons do grupo não confirmados.');
    for(const coupon of group.coupons){
      const amount=cents(coupon.given_discount);
      if(coupon.type==='no_coupon'&&amount===0)continue;
      const id=String(coupon.campaign_id??'');
      if(coupon.type!=='applied_coupon'||coupon.reach_minimum!==true||!/^\d+$/.test(id)||id==='0'||amount===null||amount<=0)return fail('Cupom aplicado sem comprovação econômica.');
      campaigns.set(id,(campaigns.get(id)??0)+amount);couponDiscount+=amount;
    }
  }
  const used=tracking.used_coupons;
  if(!Number.isSafeInteger(used)||used<0||used!==campaigns.size)return fail('Contagem de cupons aplicados divergente.');
  if(used===0&&cents(tracking.discount_amount)!==0)return fail('Ausência de desconto de cupom não corroborada.');
  const couponRow=root.summary.coupon_row;
  const couponAmount=couponRow?.value?money(couponRow):null;
  if(couponAmount!==null&&couponAmount!==-couponDiscount)return fail('Valor do cupom diverge das campanhas aplicadas.');
  if(couponRow?.value&&couponAmount===null)return fail('Valor do cupom não identificado.');
  const couponType=tracking.coupons_type?.type;
  if(used===0&&!['NO_COUPON','NO_COUPON_APPLIED'].includes(couponType)||used>0&&couponType!=='APPLIED_COUPON')return fail('Estado do cupom contraditório.');
  let pixDiscount=0;
  if(root.summary.pix_row){const value=money(root.summary.pix_row);if(value===null||value>0)return fail('Desconto Pix não identificado.');pixDiscount=-value;}
  // Decrements must corroborate Pix and coupon classification, rather than
  // treating every price difference as a coupon (CEPO's economic contract).
  let pixProof=0;const couponProof=new Map();
  for(const item of selected){
    const tracked=root.tracking.items?.filter(t=>String(t.item?.id)===item.itemId&&String(t.item?.variation_id??'not_apply')===String(item.variationId??'not_apply'));
    if(tracked?.length!==1||!Array.isArray(tracked[0].price_decrement_campaigns))return fail('Campanhas de desconto do item não informadas.');
    for(const d of tracked[0].price_decrement_campaigns){const value=cents(d.amount);if(value===0)continue;if(value===null||value<0)return fail('Desconto de campanha inválido.');const id=String(d.id??'');if(d.type==='PIX')pixProof+=value;else if(campaigns.has(id))couponProof.set(id,(couponProof.get(id)??0)+value);else return fail('Campanha de desconto sem classificação.');}
  }
  if(pixProof!==pixDiscount||[...couponProof].some(([id,value])=>campaigns.get(id)!==value))return fail('Descontos Pix ou campanhas divergentes.');
  if(products+shipping-couponDiscount-pixDiscount!==total)return fail('Total do extrato não conciliado com produtos, cupons, Pix e frete.');
  return {complete:true,grossProductsCents:gross,productsCents:products,productDiscountCents:productDiscount,couponDiscountCents:couponDiscount,pixDiscountCents:pixDiscount,shippingCents:shipping,totalCents:total,usedCoupons:used,campaigns:[...campaigns].map(([id,amountCents])=>({id,amountCents}))};
}
