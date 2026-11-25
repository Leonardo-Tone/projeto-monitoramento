import { projectCartEconomics } from './cart-economics.mjs';
export function projectCart(body) {
  const root=body?.data??body;
  const fail=reason=>({complete:false,items:[],reason});
  if(!Array.isArray(root?.grouped_items)||!root.grouped_items.every(group=>Array.isArray(group.polycards)))return fail('Formato do carrinho desconhecido.');
  const rows=root.grouped_items.flatMap(g=>g.polycards);
  if(rows.length>500)return fail('Carrinho excede o limite de leitura.');
  const normalizeId=value=>typeof value==='string'&&/^MLB-?\d+$/i.test(value)?value.replace('-','').toUpperCase():null;
  const variation=value=>value==null||value==='not_apply'?null:/^[1-9]\d{0,19}$/.test(String(value))?String(value):'INVALID';
  const number=value=>/^\d+$/.test(String(value))?Number(value):null;
  const items=[];const keys=new Set();
  for(const row of rows){
    const status=row.add_to_cart_capability?.cart_status;
    const match=String(row.unique_id??'').match(/^(MLB\d+)(?:_(\d+))?$/i);
    const checkboxItems=row.checkbox?.metadata?.items;
    if(!Array.isArray(checkboxItems)||checkboxItems.length!==1)return fail('Identidade da seleção desconhecida.');
    const ids=[row.metadata?.id,status?.item_id,checkboxItems[0].item_id,match?.[1]].filter(v=>v!=null).map(normalizeId);
    if(!ids.length||ids.some(id=>!id)||new Set(ids).size!==1)return fail('Identidades divergentes no carrinho.');
    const id=ids[0];
    const vars=[row.metadata?.variation_id,status?.variation_id,checkboxItems[0].variation_id,match?.[2]].filter(v=>v!==undefined).map(variation);
    if(vars.includes('INVALID')||new Set(vars.filter(Boolean)).size>1)return fail('Variação divergente.');
    const variationId=vars.find(Boolean)??null,key=id+':'+(variationId??'');
    if(keys.has(key))return fail('Anúncio e variação duplicados.');keys.add(key);
    const quantity=number(row.metadata?.quantity);
    if(!Number.isInteger(quantity)||quantity<1||typeof row.checkbox?.checked!=='boolean'||status?.quantity!=null&&Number(status.quantity)!==quantity||status?.display_quantity!=null&&Number(status.display_quantity)!==quantity)return fail('Quantidade ou seleção não confirmada.');
    const tracked=(root.tracking?.items??[]).filter(t=>normalizeId(t.item?.id)===id&&variation(t.item?.variation_id)===variationId);
    if(tracked.length>1)return fail('Preço do item ambíguo.');
    const track=tracked[0];
    const unit=track?.unit_price??row.metadata?.unit_price;
    if(track?.quantity!=null&&Number(track.quantity)!==quantity)return fail('Quantidade divergente entre as fontes.');
    items.push({itemId:id,variationId,quantity,checked:row.checkbox.checked,disabled:row.checkbox.disabled===true||status?.status!=='enabled',
      unitCents:typeof unit==='number'&&Number.isFinite(unit)&&unit>0?Math.round(unit*100):null,
      sellerId:track?.seller_id??track?.item?.seller_id??row.metadata?.seller_id??null});
  }
  const selectedSize=root.cart_properties?.active_and_selected_items_size??root.active_and_selected_items_size;
  if(selectedSize!=null&&Number(selectedSize)!==items.filter(i=>i.checked&&!i.disabled).reduce((sum,i)=>sum+i.quantity,0))return fail('Contador de unidades selecionadas divergente.');
  return {complete:true,items,economics:projectCartEconomics(root,items)};
}
// Embed only our trusted projector. HTML and server responses are never executed as code.
export const readCartInPage=new Function(`return async function readCartInPage(){
  const projectCartEconomics=${projectCartEconomics.toString()};
  const project=${projectCart.toString()};
  if(location.origin!=='https://www.mercadolivre.com.br')throw new Error('Origem inválida do carrinho.');
  const response=await fetch('/gz/cart/v3/api/cart-list',{credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error('Carrinho: HTTP '+response.status);
  const text=await response.text();if(text.length>2097152)throw new Error('Carrinho muito grande.');
  return project(JSON.parse(text));
}`)();

export async function setQuantityInPage({itemId,variationId,quantity}) {
  if(location.origin!=='https://www.mercadolivre.com.br'||!/^MLB\d+$/.test(itemId)||!Number.isInteger(quantity)||quantity<1||quantity>100||variationId!=null&&!/^[1-9]\d{0,19}$/.test(String(variationId)))throw new Error('Quantidade ou contexto inválido.');
  const response=await fetch('/gz/cart/v3/api/add-to-cart?element_id=221&client.id=6478921741981581',{method:'POST',credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000),headers:{'Content-Type':'application/json'},body:JSON.stringify({item_id:itemId,quantity,...(variationId?{variation_id:variationId}:{})})});
  if(!response.ok)throw new Error('Ajuste de quantidade: HTTP '+response.status);
  const body=await response.json(),status=body.cart_status;
  return {confirmed:status?.item_id===itemId&&status.status==='enabled'&&Number.isInteger(Number(status.quantity))&&Number(status.quantity)>0,
    ok:status?.item_id===itemId&&Number(status.quantity)===quantity&&status.status==='enabled',quantity:Number(status?.quantity),
    limits:{available:Number.isInteger(body.cart_config?.available_quantity)?body.cart_config.available_quantity:null,maximum:Number.isInteger(body.cart_config?.maximum_quantity)?body.cart_config.maximum_quantity:null,minimum:Number.isInteger(body.cart_config?.minimum_quantity)?body.cart_config.minimum_quantity:null}};
}

export function findSelectionInPage({itemId,variationId,checked}) {
  const visible=el=>el.getClientRects().length&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';
  const candidates=[];
  for(const card of document.querySelectorAll('.cl-item-card')){
    const ids=new Set();
    for(const el of [card,...card.querySelectorAll('[data-item-id],input[name="item_id"],a[href]')]){
      let id=el.getAttribute('data-item-id')??(el.getAttribute('name')==='item_id'?el.value:null);
      if(!id&&el.getAttribute('href')){try{const u=new URL(el.getAttribute('href'),location.href);if(['www.mercadolivre.com.br','produto.mercadolivre.com.br'].includes(u.hostname))id=u.searchParams.get('pdp_filters')?.match(/item_id:(MLB\d+)/)?.[1]??u.pathname.match(/(MLB-?\d+)/)?.[1];}catch{}}
      if(/^MLB-?\d+$/i.test(id??''))ids.add(id.replace('-','').toUpperCase());
    }
    if(ids.size!==1||!ids.has(itemId))continue;
    const variations=[...card.querySelectorAll('[data-variation-id],input[name="variation_id"]')].map(el=>el.getAttribute('data-variation-id')??el.value).filter(Boolean);
    if(variationId!==null&&(!variations.length||variations.some(v=>v!==variationId))||variationId===null&&variations.some(v=>v!=='not_apply'))continue;
    const boxes=[...card.querySelectorAll('input[type="checkbox"]')].filter(visible);
    if(boxes.length===1&&boxes[0].checked!==checked)candidates.push(boxes[0]);
  }
  return candidates.length===1?candidates[0]:null;
}
