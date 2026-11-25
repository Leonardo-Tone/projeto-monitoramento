import { EventEmitter } from 'node:events';

export class MonitoringGate {
  constructor(){this.paused=false;this.active=0;this.events=new EventEmitter();}
  changed(signal){
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{this.events.off('changed',done);signal.removeEventListener('abort',abort);};
      const done=()=>{cleanup();resolve();};
      const abort=()=>{cleanup();reject(new Error('Monitoramento interrompido.'));};
      this.events.once('changed',done);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  async run(signal,work){
    while(this.paused){if(signal.aborted)throw new Error('Monitoramento interrompido.');await this.changed(signal);}
    if(signal.aborted)throw new Error('Monitoramento interrompido.');
    this.active++;
    try{return await work();}finally{this.active--;this.events.emit('changed');}
  }
  async pause(signal){
    if(this.paused)throw new Error('Monitoramento já reservado para uma compra.');
    this.paused=true;
    const resume=()=>{this.paused=false;this.events.emit('changed');};
    try{while(this.active){if(signal.aborted)throw new Error('Compra interrompida.');await this.changed(signal);}if(signal.aborted)throw new Error('Compra interrompida.');return resume;}
    catch(error){resume();throw error;}
  }
}
