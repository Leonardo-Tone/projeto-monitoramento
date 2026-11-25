import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseNordicRendering, checkoutItemsFromFlox } from './checkout-items.mjs';

const normalize=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
export function arrivalDeadline(label,now=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
  const day=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day));
  const text=normalize(label);let offset;
  if(/\bhoje\b/.test(text))offset=0;
  else if(/\bamanha\b/.test(text))offset=1;
  else {
    const weekdays=['domingo','segunda','terca','quarta','quinta','sexta','sabado'];
    const mentioned=[...text.matchAll(/domingo|segunda|terca|quarta|quinta|sexta|sabado/g)].map(m=>(weekdays.indexOf(m[0])-new Date(day).getUTCDay()+7)%7);
    if(mentioned.length)offset=Math.max(...mentioned);
  }
  if(offset===undefined)return null;
  const hour=/entre as?\s+\d{1,2}\s+e\s+(\d{1,2})\s*h/.exec(text)?.[1];
  return day+offset*86400000+(hour?Math.min(23,Number(hour)):23)*3600000;
}
export function chooseShipping(options) {
  const enabled=options.filter(o=>!o.disabled);
  if(!enabled.length||enabled.some(o=>!Number.isSafeInteger(o.cents)||o.cents<0||!Number.isFinite(o.deadline)))throw new Error('Preço ou prazo de envio não confirmado.');
  return [...enabled].sort((a,b)=>a.cents-b.cents||a.deadline-b.deadline)[0];
}
export function crc16(value) {
  let crc=0xFFFF;
  for(const byte of Buffer.from(value,'utf8')){crc^=byte<<8;for(let i=0;i<8;i++)crc=crc&0x8000?((crc<<1)^0x1021)&0xFFFF:(crc<<1)&0xFFFF;}
  return crc.toString(16).toUpperCase().padStart(4,'0');
}
export function parsePixFields(code) {
  const fields=new Map();let offset=0;const bytes=Buffer.from(code,'utf8');
  while(offset<bytes.length){const tag=bytes.subarray(offset,offset+2).toString();const size=bytes.subarray(offset+2,offset+4).toString();if(!/^\d{2}$/.test(tag)||!/^\d{2}$/.test(size))throw new Error('Estrutura Pix inválida.');offset+=4;const length=Number(size);if(offset+length>bytes.length||fields.has(tag))throw new Error('Estrutura Pix inválida.');fields.set(tag,bytes.subarray(offset,offset+length).toString());offset+=length;}
  return fields;
}
export function readPixCode(code) {
  if(typeof code!=='string'||code.length>2000||!code.startsWith('000201')||!/^6304[0-9A-Fa-f]{4}$/.test(code.slice(-8))||crc16(code.slice(0,-4))!==code.slice(-4).toUpperCase())throw new Error('Código Pix ausente ou inválido.');
  return parsePixFields(code);
}
export function validatePix(code,totalCents) {
  const fields=readPixCode(code);
  if(fields.get('53')!=='986'||fields.get('58')!=='BR'||!/^\d+\.\d{2}$/.test(fields.get('54')??'')||Math.round(Number(fields.get('54'))*100)!==totalCents)throw new Error('Valor do Pix divergente ou não verificável.');
  if(![...fields.entries()].some(([key,value])=>Number(key)>=26&&Number(key)<=51&&value.includes('br.gov.bcb.pix')))throw new Error('Arranjo Pix não identificado.');
  return {code,totalCents};
}
export function createCheckoutParser(projectRoot) {
  const {load}=createRequire(join(projectRoot,'Amazon','amazon-monitor-core','package.json'))('cheerio');
  function amount($,root){
    const values=[];
    root.find('.andes-money-amount').addBack('.andes-money-amount').each((i,element)=>{
      const el=$(element);if(el.is('s')||el.closest('s').length)return;
      const whole=el.find('.andes-money-amount__fraction').first().text().replace(/\./g,'').trim();const cents=el.find('.andes-money-amount__cents').first().text().trim()||'00';
      if(/^\d+$/.test(whole)&&/^\d{2}$/.test(cents))values.push(Number(whole)*100+Number(cents));
    });
    if(!values.length&&/gr[aá]tis/i.test(root.text()))return 0;
    return values.length&&new Set(values).size===1?values[0]:null;
  }
  return {
    load,
    shipping(html,now){
      const $=load(html);const groups=[];
      $('.bf-shipping-options-list__radio-list').each((_,list)=>{
        const options=$(list).find('li').map((index,li)=>{
          const row=$(li),input=row.find('input[type="radio"]').first();
          const title=row.find('[data-andes-radio-list-title]').first();
          const accessible=title.find('.andes-visually-hidden').first().text();
          const label=(accessible||title.find('*').filter((_,el)=>$(el).children().length===0).map((_,el)=>$(el).text()).get().join(' ')||title.text()).replace(/\s+/g,' ').trim();
          return {group:input.attr('name'),value:input.attr('value'),label,cents:amount($,row.find('[data-andes-radio-list-right-content]')),deadline:arrivalDeadline(label,now),checked:input.attr('checked')!==undefined,disabled:row.attr('data-andes-state')==='disabled'||input.attr('disabled')!==undefined};
        }).get();
        if(options.length)groups.push({name:options[0].group,options});
      });return groups;
    },
    review(html){
      const $=load(html);
      const summary=key=>{
        const rows=$(`[data-testid="${key}"]`).toArray().map(el=>amount($,$(el)));
        return rows.length&&rows.every(v=>v!==null)&&new Set(rows).size===1?rows[0]:null;
      };
      const checked=$('input[type="radio"][checked]').filter((i,e)=>$(e).attr('name')==='payment-method-radio-list'||$(e).attr('name')==='transfers').toArray();
      const pix=checked.length===1&&($(checked[0]).attr('value')==='pix'||/^pix-/.test($(checked[0]).attr('id')??''));
      const titles=$('.bf-product-container').map((i,e)=>$(e).find('[data-testid="call-to-action-id-title"]').first().text().trim()||$(e).find('[data-testid="call-to-action-id-title_rich_text-0"]').first().text().trim()).get().filter(Boolean);
      const lines=$('[data-item-id][data-quantity][data-unit-price]').map((i,e)=>({itemId:$(e).attr('data-item-id'),variationId:$(e).attr('data-variation-id')??null,quantity:Number($(e).attr('data-quantity')),unitCents:Math.round(Number($(e).attr('data-unit-price'))*100),sellerId:$(e).attr('data-seller-id')})).get();
      let lineEvidenceInvalid=false;
      // Accept only explicit checkout item collections, never recommendations or analytics.
      if(!lines.length){
        const collections=[];
        $('script[type="application/json"]').each((_,element)=>{
          const text=$(element).text();if(text.length>1048576)return;
          let json;try{json=JSON.parse(text);}catch{return;}
          const state=json?.appProps?.pageProps?.initialState??json?.props?.pageProps?.initialState??json?.initialState??json;
          for(const entries of [state?.checkout?.items,state?.purchase?.items,state?.line_items]){
            if(!Array.isArray(entries)||!entries.length||entries.length>20)continue;
            const parsed=entries.map(item=>({itemId:item.item_id,variationId:item.variation_id??null,quantity:item.quantity,unitCents:typeof item.unit_price==='number'?Math.round(item.unit_price*100):null,sellerId:item.seller_id}));
            if(parsed.every(item=>/^MLB\d+$/.test(item.itemId??'')&&Number.isInteger(item.quantity)&&item.quantity>0&&Number.isSafeInteger(item.unitCents)&&item.unitCents>0))collections.push(parsed);
          }
        });
        if(collections.length){if(new Set(collections.map(list=>JSON.stringify(list))).size===1)lines.push(...collections[0]);else lineEvidenceInvalid=true;}
      }
      // Observed ML checkout contract: item prices and sellers corroborated by
      // the delivery packs of the same checkout state, never recommendation lists.
      const flox=checkoutItemsFromFlox(parseNordicRendering($('#__NORDIC_RENDERING_CTX__').text()));
      if(flox.invalid)lineEvidenceInvalid=true;
      else if(flox.present){
        if(lines.length){
          const sort=rows=>rows.map(row=>[row.itemId,String(row.variationId??''),row.quantity,row.unitCents]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
          if(JSON.stringify(sort(lines))!==JSON.stringify(sort(flox.lines)))lineEvidenceInvalid=true;
          for(const line of lines){const proof=flox.lines.find(row=>row.itemId===line.itemId&&String(row.variationId??'')===String(line.variationId??''));if(proof){if(line.sellerId!=null&&String(line.sellerId)!==proof.sellerId)lineEvidenceInvalid=true;else line.sellerId=proof.sellerId;}}
        }
        else lines.push(...flox.lines);
      }
      return {pix,subtotalCents:summary('product_row'),shippingCents:summary('shipment_row'),totalCents:summary('total_row'),titles,lines,lineEvidenceInvalid,hasFinalize:$('[data-testid="confirm_purchase_button"]').length>0};
    },
    pix(html,totalCents){const $=load(html);const codes=$('[data-testid="pix_copy_code_card"]').text().match(/000201[\s\S]{30,1900}?6304[0-9A-Fa-f]{4}/g)??[];if(new Set(codes).size!==1)throw new Error('Código Pix não confirmado na página de pagamento.');return validatePix(codes[0],totalCents);},
    cardApproved(html,url){
      const destination=new URL(url);
      if(destination.origin!=='https://www.mercadolivre.com.br'||!/^\/(?:gz\/checkout|checkout|congrats)(?:\/|$)/.test(destination.pathname))return false;
      const $=load(html);
      const headings=$('h1,h2,[role="heading"]').map((_,el)=>normalize($(el).text())).get();
      return headings.some(text=>/^(?:seu )?pagamento (?:foi )?aprovado[!.]?$/.test(text));
    },
    amount,
    normalize,
  };
}
