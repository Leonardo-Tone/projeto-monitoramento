import { createRequire } from 'node:module';
import { join } from 'node:path';

export function safeProductImage(value,store) {
  try {
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.port)return null;
    const valid=store==='amazon'
      ?['m.media-amazon.com','images-na.ssl-images-amazon.com'].includes(url.hostname)&&url.pathname.startsWith('/images/I/')
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
      const candidates=store==='amazon'
        ?[$('#aod-asin-image-id').attr('src')]
        :[$('meta[property="og:image"]').attr('content'),$('.ui-pdp-gallery__figure img').first().attr('data-src'),$('.ui-pdp-gallery__figure img').first().attr('src'),$('meta[name="twitter:image"]').attr('content')];
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
