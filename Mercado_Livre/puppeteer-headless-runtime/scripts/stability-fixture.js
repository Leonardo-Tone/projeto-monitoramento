'use strict';
const {identity} = require('./probe-worker-capabilities');

module.exports = function fixture(url, alternateOrigin) {
  const parsed = new URL(url, 'http://127.0.0.1');
  const pathname = parsed.pathname;
  const directory = pathname.slice(0, pathname.lastIndexOf('/') + 1);
  const leaf = pathname.split('/').at(-1);
  const read = identity.toString();
  if (leaf === 'identity.mjs') return `export const read=${read};`;
  if (leaf === 'module-worker.mjs' || leaf === 'nested-child.mjs') return `import {read} from './identity.mjs';
    const first=read(); self.onmessage=async()=>self.postMessage({first:await first,current:await read()});`;
  if (leaf === 'dedicated.js') return `const read=${read};const first=read();self.onmessage=async()=>self.postMessage({first:await first,current:await read()});`;
  if (leaf === 'nested.js') return `const read=${read};const first=read();const child=new Worker('./nested-child.mjs',{type:'module'});
    self.onmessage=()=>{child.onmessage=async event=>self.postMessage({first:await first,current:await read(),child:event.data});child.postMessage('identity');};`;
  if (leaf === 'shared.js') return `const read=${read};const first=read();self.onconnect=event=>{const port=event.ports[0];
    port.onmessage=async()=>port.postMessage({first:await first,current:await read()});port.start();};`;
  if (leaf === 'service.js') return `const read=${read};const first=read();const version=${Number(parsed.searchParams.get('v') || 1)};
    self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
    self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
    self.onmessage=event=>event.waitUntil((async()=>event.ports[0].postMessage({version,first:await first,current:await read()}))());`;
  if (leaf === 'frame.html') return `<!doctype html><title>cross-site identity frame</title><script>
    const read=${read};window.firstIdentity=read();window.readIdentity=async()=>({first:await firstIdentity,current:await read()});</script>`;
  if (leaf === 'cleanup.html') return '<!doctype html><title>Local fixture cleanup</title>';
  return `<!doctype html><title>Stability fixture</title>
    <iframe src="${alternateOrigin}${directory}frame.html"></iframe><script type="module">
    import {read} from './identity.mjs';
    const first=read();
    function request(port,service=false){return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Worker reply timeout')),10000);
      const done=event=>{clearTimeout(timer);resolve(event.data);};
      if(service){const channel=new MessageChannel();channel.port1.onmessage=event=>{done(event);channel.port1.close();};port.postMessage('read',[channel.port2]);}
      else{port.onmessage=done;port.postMessage('read');}
    });}
    const workers={dedicated:new Worker('./dedicated.js'),module:new Worker('./module-worker.mjs',{type:'module'}),
      nested:new Worker('./nested.js'),shared:new SharedWorker('./shared.js')};workers.shared.port.start();
    let registration;
    window.updateService=async version=>{
      registration=await navigator.serviceWorker.register('./service.js?v='+version,{scope:'./'});
      const deadline=Date.now()+15000;
      while(!registration.active || registration.active.state!=='activated' || !registration.active.scriptURL.endsWith('?v='+version)){
        if(Date.now()>deadline)throw new Error('Service update timeout');await new Promise(resolve=>setTimeout(resolve,20));
      }
      return request(registration.active,true);
    };
    window.ready=window.updateService(1);
    window.stopService=async()=>registration.unregister();
    window.readAll=async()=>({page:{first:await first,current:await read()},workers:{
      dedicated:await request(workers.dedicated),module:await request(workers.module),
      nested:await request(workers.nested),shared:await request(workers.shared.port),service:await request(registration.active,true)}});
    window.closeClient=()=>{workers.dedicated.terminate();workers.module.terminate();workers.nested.terminate();workers.shared.port.close();};
    window.shutdown=async()=>{window.closeClient();if(registration)await registration.unregister();};
    window.burn=duration=>{const end=performance.now()+duration;while(performance.now()<end){};return duration;};
    </script>`;
};
