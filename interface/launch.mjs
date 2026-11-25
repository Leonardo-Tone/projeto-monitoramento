import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {apiVersion} from './panel-api.mjs';

const port=Number(process.env.VIGIA_PORT??4318);
export const panelUrl=`http://127.0.0.1:${Number.isInteger(port)&&port>0&&port<=65535?port:4318}`;
export async function panelStatus(fetchImpl=fetch){
  try{
    const response=await fetchImpl(panelUrl+'/api/state',{signal:AbortSignal.timeout(2000),redirect:'error'});
    if(!response.ok)return 'unavailable';
    const state=await response.json();
    if(!Number.isInteger(state.apiVersion)||!Array.isArray(state.products)||!state.shops?.amazon||!state.shops?.ml)return 'unavailable';
    return state.apiVersion>=apiVersion?'ready':'outdated';
  }catch{return 'unavailable';}
}
export const panelIsRunning=async fetchImpl=>await panelStatus(fetchImpl)==='ready';
export function browserCommand(env=process.env,exists=existsSync){
  const roots=[env.ProgramFiles,env['ProgramFiles(x86)'],env.LOCALAPPDATA].filter(Boolean);
  for(const relative of [['Google','Chrome','Application','chrome.exe'],['Microsoft','Edge','Application','msedge.exe']]){
    for(const root of roots){const executable=join(root,...relative);if(exists(executable))return {executable,args:['--new-tab',panelUrl],windowsHide:false};}
  }
  return {executable:'powershell.exe',args:['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',`Start-Process '${panelUrl}' -ErrorAction Stop`],windowsHide:true};
}
async function openPanel(){
  const command=browserCommand();
  await new Promise((resolve,reject)=>{
    const child=spawn(command.executable,command.args,{windowsHide:command.windowsHide,detached:true,stdio:'ignore'});
    child.once('error',reject);
    child.once('spawn',()=>{child.unref();resolve();});
  });
}
async function launch(){
  const status=await panelStatus();
  if(status==='outdated'){
    console.error('O serviço aberto é de uma versão anterior. Encerre a instância anterior do Vigia e execute INICIAR-PAINEL.cmd novamente.');
    process.exitCode=1;
    return;
  }
  if(status==='ready'){
    console.log('O painel ja esta aberto. Abrindo no navegador, sem interromper o monitoramento.');
    await openPanel();return;
  }
  console.log(`Abrindo ${panelUrl}. Mantenha esta janela aberta. Ctrl+C encerra o servico.`);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:'inherit',windowsHide:true});
  let stopped=false;
  const finished=new Promise(resolve=>{
    child.on('error',error=>{console.error('Nao foi possivel iniciar:',error.message);stopped=true;resolve(1);});
    child.on('exit',code=>{stopped=true;resolve(code??1);});
  });
  const stop=()=>child.kill('SIGTERM');process.on('SIGINT',stop);process.on('SIGTERM',stop);
  for(let attempt=0;attempt<20&&!stopped;attempt++){
    if(await panelIsRunning()){await openPanel();break;}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  const code=await finished;
  // Handle two simultaneous launches without displaying a false failure.
  if(code&&await panelIsRunning()){await openPanel();process.exitCode=0;}else process.exitCode=code;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await launch();
