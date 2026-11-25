import { launchProfile } from './profiles.mjs';
import { purchasePageKind } from './purchase-human.mjs';

export class PurchaseSession {
  constructor({projectRoot,dataDirectory,launcher=launchProfile}){Object.assign(this,{projectRoot,dataDirectory,launcher});this.headless=true;this.browser=null;}
  async start(headless=true){
    const lease=await this.launcher({projectRoot:this.projectRoot,dataDirectory:this.dataDirectory,store:'ml',purpose:'purchase',headless});
    this.browser=lease.browser;this.headless=headless;
    try{this.cartPage=await this.browser.newPage();this.productPage=await this.browser.newPage();}
    catch(error){await this.close();throw error;}
  }
  async showHuman(page){
    if(!this.headless)return page;
    const url=page.url(),kind=purchasePageKind(url);
    if(kind==='INVALID')throw new Error('Página de verificação fora dos domínios permitidos.');
    const role=page===this.productPage?'productPage':'cartPage';
    await this.close();
    // Chrome cannot change headless mode in place. Reopen the same profile only
    // after releasing the hidden process. Never replay a form or finalization.
    await this.start(false);
    const visible=this[role];
    try{await visible.goto(url,{waitUntil:'domcontentloaded',timeout:20000});}
    catch(error){if(purchasePageKind(visible.url())==='INVALID')throw error;}
    return visible;
  }
  adoptCartPage(page){this.cartPage=page;}
  async close(){if(this.browser){const owned=this.browser;await owned.close();this.browser=null;}}
}
