import { setTimeout as sleep } from 'node:timers/promises';

const trustedHosts=new Set(['www.mercadolivre.com.br','produto.mercadolivre.com.br','mercadolivre.com.br','www.mercadopago.com.br']);
export const isTrustedMlPage=url=>{
  try {
    const {protocol,hostname,port,username,password}=new URL(url);
    return protocol==='https:'&&!port&&!username&&!password&&trustedHosts.has(hostname);
  }catch{return false;}
};
export const isMlBrowserWall=url=>isTrustedMlPage(url)&&/^\/captcha(?:\/|-|_)wall(?:\/|$)/i.test(new URL(url).pathname);

export const sameMlDestination=(actual,expected)=>{
  try {
    const a=new URL(actual),b=new URL(expected);
    if(a.origin!==b.origin||a.username||a.password)return false;
    const path=u=>u.pathname.replace(/\/$/,'');
    if(path(a)===path(b))return true;
    const item=u=>/^\/(MLB-?\d+)(?:-|\/|$)/i.exec(u.pathname)?.[1].replace('-','').toUpperCase();
    const catalog=u=>/\/p\/(MLB\d+)(?:\/|$)/i.exec(u.pathname)?.[1].toUpperCase();
    return Boolean(item(b)&&item(a)===item(b)||catalog(b)&&catalog(a)===catalog(b));
  }catch{return false;}
};

// Observe the marketplace's own navigation. The wall runs its scripts in the tab.
export async function waitForMlBrowserWall(read,{signal,timeoutMs=15000,poll=sleep}={}){
  const deadline=performance.now()+timeoutMs;
  let timer;
  let abort;
  const end=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>resolve({kind:'WALL_TIMEOUT'}),timeoutMs);
    abort=()=>reject(signal.reason);
    signal?.addEventListener('abort',abort,{once:true});
  });
  try {
    for(;;){
      signal?.throwIfAborted();
      const state=await Promise.race([read(),end]);
      if(!['WALL','LOADING'].includes(state.kind))return state;
      const remaining=deadline-performance.now();
      if(remaining<=0)return {kind:'WALL_TIMEOUT'};
      await poll(Math.min(250,remaining),undefined,{signal});
    }
  }finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',abort);
  }
}
