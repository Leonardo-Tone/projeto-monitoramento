import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const executable=fileURLToPath(new URL('../.runtime/electron/electron.exe',import.meta.url));
const script=fileURLToPath(new URL('./notification-host.cjs',import.meta.url));
export function notifySystem({title,message,id=randomUUID()},{platform=process.platform,spawnImpl=spawn}={}) {
  if(platform!=='win32')return Promise.reject(new Error('Alertas nativos requerem Windows.'));
  if(!/^[a-zA-Z0-9-]{1,100}$/.test(id))return Promise.reject(new Error('Identificador de alerta inválido.'));
  const port=Number(process.env.VIGIA_PORT??4318);
  const payload=Buffer.from(JSON.stringify({id,title:String(title).slice(0,100),message:String(message).slice(0,350),url:`http://127.0.0.1:${Number.isInteger(port)&&port>0&&port<=65535?port:4318}/`})).toString('base64url');
  return new Promise((resolve,reject)=>{
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    // Arguments are passed directly, with no shell. Keep the native process alive until dismissal.
    const child=spawnImpl(executable,[script,payload],{windowsHide:true,detached:true,stdio:['ignore','pipe','ignore'],env});
    let buffer='',settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
    const timer=setTimeout(()=>{finish(new Error('Tempo esgotado ao mostrar o alerta do Windows.'));child.kill();},15000);
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString('utf8');
      let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(line==='ACK '+id)finish();if(line==='ERR '+id)finish(new Error('Não foi possível mostrar o alerta fixo.'));}
      if(buffer.length>4096)buffer='';
    });
    child.on('error',finish);
    child.on('close',()=>finish(new Error('O componente de alertas foi encerrado antes da confirmação.')));
    child.unref?.();child.stdout.unref?.();
  });
}
