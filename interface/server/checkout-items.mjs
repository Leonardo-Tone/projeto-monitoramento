export function parseNordicRendering(text){
  if(typeof text!=='string'||text.length>2097152)return null;
  const match=/_n\.ctx\.r\s*=\s*(\{)/.exec(text);if(!match)return null;
  const start=match.index+match[0].length-1;let depth=0,quoted=false,escape=false;
  for(let i=start;i<text.length;i++){
    const c=text[i];if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;}
    else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{return JSON.parse(text.slice(start,i+1));}catch{return null;}}
  }return null;
}
export function checkoutItemsFromFlox(json){
  const tracks=json?.appProps?.pageProps?.flox?.floxPreloadedState?.['@meli/web/flox/FLOX_STATE']?.pendingTracks;
  if(!Array.isArray(tracks))return {present:false,lines:[]};
  if(tracks.length>40)return {present:true,invalid:true,lines:[]};
  const collections=[];
  const variation=value=>value==null||value==='not_apply'?null:/^[1-9]\d{0,19}$/.test(String(value))?String(value):'INVALID';
  const key=item=>item.itemId+':'+(item.variationId??'');
  for(const entry of tracks)for(const track of (entry.tracking?.tracks??[]).slice(0,40)){
    const data=track.data?.event_data,items=data?.items,packs=data?.shipping?.pack_details;
    if(!Array.isArray(items)||!Array.isArray(packs))continue;
    if(!items.length||items.length>10||packs.length>20)return {present:true,invalid:true,lines:[]};
    const lines=items.map(row=>({itemId:row.item?.id,variationId:variation(row.item?.variation),sellerId:row.item?.seller_id==null?null:String(row.item.seller_id),quantity:row.quantity,unitCents:typeof row.unit_price==='number'?Math.round(row.unit_price*100):null,currency:row.currency_id}));
    const packItems=packs.flatMap(pack=>Array.isArray(pack.items)?pack.items:[]).map(row=>({itemId:row.id,variationId:variation(row.variation),quantity:row.quantity}));
    if(lines.some(row=>!/^MLB\d+$/.test(row.itemId??'')||row.variationId==='INVALID'||!/^\d{1,20}$/.test(row.sellerId??'')||!Number.isInteger(row.quantity)||row.quantity<1||row.quantity>100||!Number.isSafeInteger(row.unitCents)||row.unitCents<=0||row.currency!=='BRL'))return {present:true,invalid:true,lines:[]};
    if(packItems.length!==lines.length||new Set(lines.map(key)).size!==lines.length||new Set(packItems.map(key)).size!==packItems.length||lines.some(line=>{const pack=packItems.find(p=>key(p)===key(line));return !pack||pack.quantity!==line.quantity;}))return {present:true,invalid:true,lines:[]};
    collections.push(lines.map(({currency,...line})=>line).sort((a,b)=>key(a).localeCompare(key(b))));
  }
  if(!collections.length)return {present:false,lines:[]};
  if(new Set(collections.map(list=>JSON.stringify(list))).size!==1)return {present:true,invalid:true,lines:[]};
  return {present:true,lines:collections[0]};
}
