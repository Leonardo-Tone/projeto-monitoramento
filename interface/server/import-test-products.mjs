import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApplication } from '../server.mjs';
import { createMetadataParser, applyMetadata } from './metadata.mjs';
import { mlResponse } from './adapters.mjs';

export async function importTestProducts({projectRoot,interfaceDirectory}) {
  const references=JSON.parse(await readFile(join(interfaceDirectory,'server','reference-products.json'),'utf8'));
  const app=await createApplication({dataDirectory:join(interfaceDirectory,'.data'),root:projectRoot});
  try {
    await app.service.importProducts(references);
    const parseMetadata=createMetadataParser(projectRoot);
    const saved=new Map([
      ['amazon/B000GAYQJ0','Amazon/aod-B000GAYQJ0.html'],
      ['amazon/B0HC8JZC1D','Amazon/aod-B0HC8JZC1D.html'],
      ['amazon/B0HCCTKPGN','Amazon/aod-B0HCCTKPGN.html'],
      ['ml/MLB5214725509','Mercado_Livre/moltres-MLB5214725509.html'],
    ]);
    let enriched=0;
    for(const p of app.service.registry.products) {
      const file=saved.get(p.store+'/'+p.code);
      if(!file)continue;
      let html;try{html=await readFile(join(projectRoot,file),'utf8');}catch(e){if(e.code==='ENOENT')continue;throw e;}
      const metadata=p.store==='ml'?await mlResponse(p,{http:200,urlFinal:p.url,html},parseMetadata):parseMetadata(html,p.store);
      if(p.metadataSource!=='monitoring-html'&&(metadata.title||metadata.imageUrl)){applyMetadata(p,{...metadata,metadataSource:'saved-test-html'});enriched++;}
      if(p.store==='ml'&&!p.lastCheckedAt&&metadata.observation!=='identity_mismatch'&&metadata.observation!=='unknown_identity'){
        for(const key of ['seller','sellerId','delivery','shippingMode','logisticType','reputationLevel','powerSellerStatus'])p[key]=metadata[key]??null;
        p.sellerInfoSource='saved-test-html';
      }
    }
    await app.service.save(app.service.registry);
    return {amazon:app.service.registry.products.filter(p=>p.store==='amazon').length,ml:app.service.registry.products.filter(p=>p.store==='ml').length,metadataFromSavedHtml:enriched,monitoringStarted:false};
  }finally{await app.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const interfaceDirectory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  try{console.log(JSON.stringify(await importTestProducts({interfaceDirectory,projectRoot:resolve(interfaceDirectory,'..')})));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
