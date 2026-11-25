export const navigationContextChanged=error=>/Execution context was destroyed|Cannot find context with specified id|Cannot find context with id|Inspected target navigated|Cannot find object with given id|Could not find node with given id|No node with given id|Node with given id does not belong to the document/i.test(String(error?.message??error));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// This wrapper is exclusively for reads and element lookup. Never pass a cart
// mutation or a click: an interrupted read may be repeated, a purchase may not.
export async function readAcrossNavigation(page,read,{signal,timeoutMs=10000}={}){
  const deadline=Date.now()+timeoutMs;
  for(;;){
    if(signal?.aborted)throw new Error('Compra interrompida.');
    if(page.isClosed?.())throw new Error('Navegador de compra fechado.');
    try{return await read();}
    catch(error){if(!navigationContextChanged(error)||Date.now()>=deadline||page.isClosed?.())throw error;await pause(100);}
  }
}
