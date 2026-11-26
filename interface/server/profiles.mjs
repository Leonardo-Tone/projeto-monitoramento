import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { closeOwnedBrowser } from './browser-cleanup.mjs';

export const accountKeys=['amazon/monitor','amazon/purchase','ml/monitor','ml/purchase'];
export function chromeProfile(projectRoot,dataDirectory,store,purpose) {
  const key=`${store}/${purpose}`;
  if(!accountKeys.includes(key))throw new Error('Conta ou finalidade inválida.');
  // Both stores share one profile per purpose. Preserve the existing ML v3 monitor login.
  const userDataDir=purpose==='monitor'
    ?join(projectRoot,'Mercado_Livre','perfis','ml-chrome-headless-v3')
    :join(dataDirectory,'chrome-profiles','purchase');
  return {key,userDataDir,profileDirectory:'Default',label:purpose==='monitor'?'Monitoramento · Amazon e Mercado Livre':'Compra · Amazon e Mercado Livre'};
}
async function launchDedicatedProfile({projectRoot,dataDirectory,store,purpose,headless}) {
  const profile=chromeProfile(projectRoot,dataDirectory,store,purpose);
  const {localizarChrome,iniciarIntegracao}=await import(pathToFileURL(join(projectRoot,'Mercado_Livre','integracao-native.mjs')).href);
  const executablePath=localizarChrome();if(!executablePath)throw new Error('Chrome não encontrado. Configure ML_CHROME_EXECUTABLE.');
  await mkdir(profile.userDataDir,{recursive:true});
  const {browser}=await iniciarIntegracao({executablePath,headless,userDataDir:profile.userDataDir,timeout:15000,args:[`--profile-directory=${profile.profileDirectory}`]});
  return {browser,profile};
}

// One Chrome process per profile, with independent pages and lifetimes for each consumer.
export function createProfilePool(launcher=launchDedicatedProfile) {
  const entries=new Map();
  const retire=(entry,key)=>entry.closing??=closeOwnedBrowser(entry.browser).finally(()=>{
    if(entries.get(key)===entry)entries.delete(key);
  });
  return {async acquire(options){
    const profile=chromeProfile(options.projectRoot,options.dataDirectory,options.store,options.purpose);
    const key=profile.userDataDir.toLowerCase();
    let entry=entries.get(key);
    if(entry?.closing){await entry.closing;return this.acquire(options);}
    if(entry?.disconnected){await retire(entry,key);return this.acquire(options);}
    if(entry&&entry.headless!==options.headless)throw new Error('Encerre a preparação do perfil compartilhado antes de monitorar.');
    if(!entry){
      entry={users:0,headless:options.headless};entries.set(key,entry);
      entry.ready=Promise.resolve().then(()=>launcher(options)).then(({browser})=>{
        entry.browser=browser;
        browser.once('disconnected',()=>{entry.disconnected=true;});
        return browser;
      }).catch(error=>{if(entries.get(key)===entry)entries.delete(key);throw error;});
    }
    entry.users++;
    const native=await entry.ready;
    const pages=new Set();
    const lease=new EventEmitter();
    let closing;
    const isCurrent=()=>!closing&&!entry.closing&&!entry.disconnected&&entries.get(key)===entry;
    const disconnected=()=>lease.emit('disconnected');
    native.once('disconnected',disconnected);
    lease.newPage=async()=>{
      if(!isCurrent())throw Object.assign(new Error('A sessão do Chrome foi encerrada.'),{code:'BROWSER_DISCONNECTED'});
      const page=await native.newPage();pages.add(page);page.once('close',()=>pages.delete(page));return page;
    };
    if(options.purpose==='monitor'&&options.headless){
      lease.isCurrent=isCurrent;
      lease.reportFailure=store=>{
        entry.failures??=new Map();
        entry.failures.set(store,Date.now());
        return [...entry.failures].some(([other,at])=>other!==store&&Date.now()-at<=60000);
      };
      lease.clearFailure=store=>entry.failures?.delete(store);
      lease.resetPages=()=>Promise.allSettled([...pages].map(page=>Promise.race([
        page.close(),
        new Promise(resolve=>setTimeout(resolve,3000)),
      ])));
      lease.restart=async()=>{
        if(entries.get(key)===entry)await retire(entry,key);
        else if(entry.closing)await entry.closing;
      };
    }
    lease.close=()=>closing??=(async()=>{
      native.off('disconnected',disconnected);
      entry.users--;
      try {
        if(entry.closing)await entry.closing;
        else if(entry.users===0){
          if(entries.get(key)===entry)await retire(entry,key);
        }else await Promise.allSettled([...pages].map(page=>Promise.race([
          page.close(),
          new Promise(resolve=>setTimeout(resolve,3000)),
        ])));
      }finally{lease.emit('disconnected');}
    })();
    return {browser:lease,profile};
  },
  async release(projectRoot,dataDirectory,store='ml',purpose='monitor'){
    const profile=chromeProfile(projectRoot,dataDirectory,store,purpose);
    const key=profile.userDataDir.toLowerCase();
    const entry=entries.get(key);
    if(entry){
      if(entry.closing)await entry.closing;
      else if(entry.browser)await retire(entry,key);
    }
  }};
}
const sharedProfiles=createProfilePool();
export const launchProfile=options=>sharedProfiles.acquire(options);
export const releaseProfile=(projectRoot,dataDirectory,store,purpose)=>sharedProfiles.release(projectRoot,dataDirectory,store,purpose);
export async function openAccountLogin(options) {
  const {browser}=await launchProfile({...options,headless:false});
  try {
    const page=await browser.newPage();
    await page.goto(options.store==='amazon'?'https://www.amazon.com.br/':'https://www.mercadolivre.com.br/',{waitUntil:'domcontentloaded',timeout:20000});
    return browser;
  } catch(error){await browser.close();throw error;}
}

// Transport runs inside the Amazon monitoring profile; session cookies never enter the UI.
export function profileFetch(page,{timeoutMs=12000,ErrorClass=Error,onHtml=null}={}) {
  const fail=(message,code='PROFILE_ACCESS')=>{throw new ErrorClass(message,{code,blocking:true});};
  return async(url)=>{
    const target=new URL(url);
    if(target.origin!=='https://www.amazon.com.br')fail('Origem Amazon inválida.');
    if(page.isClosed?.())throw Object.assign(new Error('Target closed: aba de monitoramento Amazon encerrada.'),{code:'BROWSER_DISCONNECTED'});
    let timer;
    const result=await Promise.race([
      page.evaluate(async({url,timeoutMs})=>{
        const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
        try {
          const response=await fetch(url,{credentials:'same-origin',redirect:'follow',signal:controller.signal,headers:{Accept:'text/html, */*','Accept-Language':'pt-BR,pt;q=0.9'}});
          return {status:response.status,url:response.url,html:response.status===200?await response.text():''};
        } finally {clearTimeout(timer);}
      },{url:target.href,timeoutMs}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Runtime.callFunctionOn timed out (profileFetch).'),{code:'CHROME_TIMEOUT'})),timeoutMs+5000);}),
    ]).finally(()=>clearTimeout(timer));
    const final=new URL(result.url);
    if(final.origin!==target.origin||/\/ap\/|captcha|challenge|account-verification/i.test(final.pathname))fail('A Amazon exige login ou verificação manual no perfil de monitoramento.','SESSION_REQUIRED');
    if(result.status===200&&onHtml)onHtml(result.html,target);
    return {status:result.status,text:async()=>result.html};
  };
}
