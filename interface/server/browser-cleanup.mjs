function deadline(task,ms) {
  let timer;
  return Promise.race([Promise.resolve().then(task),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('O Chrome não respondeu ao encerramento.')),ms);})]).finally(()=>clearTimeout(timer));
}
export async function closeOwnedBrowser(browser,{timeoutMs=5000}={}) {
  const child=browser.process?.();
  try{await deadline(()=>browser.close(),timeoutMs);}
  catch(error){
    // Only the exact process handle returned by our own launcher may be killed.
    if(child&&(child.exitCode!=null||child.signalCode!=null))return;
    if(!child)throw error;
    if(child.kill()===false)throw error;
  }
  if(child&&child.exitCode==null&&child.signalCode==null){
    try{await deadline(()=>new Promise(resolve=>{if(child.exitCode!=null||child.signalCode!=null)return resolve();child.once('exit',resolve);}),1000);}
    catch{
      if(child.exitCode==null&&child.signalCode==null){
        try{child.kill('SIGKILL');}catch{}
        if(child.exitCode==null&&child.signalCode==null&&child.kill()===false)throw new Error('Não foi possível encerrar o Chrome da compra.');
      }
    }
  }
}
