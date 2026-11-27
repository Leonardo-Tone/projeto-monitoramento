import { createRequire } from 'node:module';
import { join } from 'node:path';

const AMAZON_IMAGE_HOSTS=new Set([
  'm.media-amazon.com',
  'images-na.ssl-images-amazon.com',
  'images-sa.ssl-images-amazon.com',
  'images-eu.ssl-images-amazon.com',
  'images-fe.ssl-images-amazon.com',
]);
const AMAZON_IMAGE_PATH=/^\/(?:images\/W\/[^/]+\/)?images\/I\//;

function dynamicImageUrls(raw) {
  if(!raw||typeof raw!=='string')return [];
  try {
    const parsed=JSON.parse(raw);
    return parsed&&typeof parsed==='object'?Object.keys(parsed):[];
  }catch{return [];}
}

export function safeProductImage(value,store) {
  if(typeof value!=='string')return null;
  const normalized=value.trim().startsWith('//')?`https:${value.trim()}`:value.trim();
  if(!normalized)return null;
  try {
    const url=new URL(normalized);
    if(url.protocol!=='https:'||url.username||url.password||url.port)return null;
    const valid=store==='amazon'
      ?AMAZON_IMAGE_HOSTS.has(url.hostname)&&AMAZON_IMAGE_PATH.test(url.pathname)
      :store==='ml'&&url.hostname==='http2.mlstatic.com'&&url.pathname.startsWith('/D_NQ_NP_');
    return valid?url.href:null;
  }catch{return null;}
}
export function createMetadataParser(projectRoot) {
  // Reuse the already installed HTML parser; no scripts from the product page are executed.
  const {load}=createRequire(join(projectRoot,'Amazon','amazon-monitor-core','package.json'))('cheerio');
  return (html,store)=>{
    try {
      const $=load(html);
      const title=(store==='amazon'?$('#aod-asin-title').first().text():$('.ui-pdp-title').first().text()||$('h1').first().text()||$('meta[name="twitter:title"]').attr('content')||'').replace(/\s+/g,' ').trim().slice(0,500);
      let candidates;
      if(store==='amazon'){
        const primary=$('#aod-asin-image-id').first();
        const pinnedImg=$('#pinned-image-id img, #aod-asin-image-block img, .offer-image-block img').first();
        const fallbackImgs=$('#aod-pinned-offer img, #aod-container img').toArray().flatMap(el=>[$(el).attr('src'),$(el).attr('data-src'),$(el).attr('data-a-hires')]);
        candidates=[
          primary.attr('src'),
          primary.attr('data-src'),
          primary.attr('data-a-hires'),
          primary.attr('data-old-hires'),
          ...dynamicImageUrls(primary.attr('data-a-dynamic-image')),
          pinnedImg.attr('src'),
          pinnedImg.attr('data-src'),
          pinnedImg.attr('data-a-hires'),
          ...fallbackImgs,
        ];
      }else{
        candidates=[$('meta[property="og:image"]').attr('content'),$('.ui-pdp-gallery__figure img').first().attr('data-src'),$('.ui-pdp-gallery__figure img').first().attr('src'),$('meta[name="twitter:image"]').attr('content')];
      }
      const imageUrl=candidates.map(value=>safeProductImage(value,store)).find(Boolean);
      return {...(title?{title}:{}),...(imageUrl?{imageUrl}:{}),...(title||imageUrl?{metadataSource:'monitoring-html'}:{})};
    }catch{return {};}
  };
}
export function applyMetadata(product,metadata,at=new Date().toISOString()) {
  let changed=false;
  if(typeof metadata.title==='string'&&metadata.title.trim()) {
    const title=metadata.title.replace(/\s+/g,' ').trim().slice(0,500);
    if(title!==product.title){product.title=title;changed=true;}
  }
  const image=safeProductImage(metadata.imageUrl,product.store);
  if(image&&image!==product.imageUrl){product.imageUrl=image;changed=true;}
  if(changed){product.metadataAt=at;product.metadataSource=metadata.metadataSource??'monitoring-html';}
  return changed;
}
