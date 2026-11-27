'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {outputRoot, revision} = require('./diagnostic-environment');
const runtime = require('../src/puppeteer-runtime');
const fixture = require('./stability-fixture');

async function main() {
  const mode = process.argv[2] || 'smoke';
  if (!['smoke', 'soak'].includes(mode)) throw new Error('Use smoke ou soak.');
  const durationMs = mode === 'soak' ? 300000 : 0;
  const referenceBytes = fs.readFileSync(process.env.RESEARCH_NATIVE_REFERENCE || '');
  const reference = JSON.parse(referenceBytes.toString('utf8'));
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-stability-${mode}`;
  const output = path.join(outputRoot, 'artifacts', id);
  fs.mkdirSync(output, {recursive: true});
  const report = {id, mode, startedAt: new Date().toISOString(), cases: [], samples: [],
    ...revision(),
    nativeReference: {id: reference.id, sha256: crypto.createHash('sha256').update(referenceBytes).digest('hex')},
    sourceHashes: Object.fromEntries(['scripts/test-native-stability.js','scripts/stability-fixture.js','src/native-identity.js',
      'src/puppeteer-runtime.js','patches/puppeteer-runtime-24.8.1/patch-manifest.json'].map(file=>[file,
      crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'..',file))).digest('hex')])),
  };
  let port;
  const server = http.createServer((request,response)=>{
    const pathname = new URL(request.url,'http://127.0.0.1').pathname;
    response.writeHead(200,{'Content-Type':/\.(mjs|js)$/.test(pathname)?'text/javascript':'text/html','Cache-Control':'no-store','Origin-Agent-Cluster':'?1'});
    response.end(fixture(request.url,`http://localhost:${port}`));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  port=server.address().port;
  const origin=`http://127.0.0.1:${port}`;
  const expected=reference.identityAudit.page;
  const expectedUA=expected.userAgent.replace('HeadlessChrome/','Chrome/');
  let browser, audit;
  let sequence=0;
  function validate(value) {
    if(value.first){assert.deepEqual(value.first,value.current,'first/current identity differs');validate(value.first);}
    else if(value.userAgent){
      assert.equal(value.userAgent,expectedUA,`${value.scope}: UA`);
      for(const field of ['userAgentData','platform','language','languages','locale'])assert.deepEqual(value[field],expected[field],`${value.scope}: ${field}`);
    }
    if(value.child)validate(value.child);
    if(value.page)validate(value.page);
    if(value.workers)Object.values(value.workers).forEach(validate);
  }
  async function sample(page) {
    const values=await page.evaluate(()=>window.readAll());validate(values);
    const frame=page.frames().find(frame=>frame.url().startsWith(`http://localhost:${port}/`));
    assert.ok(frame,'cross-site frame missing');
    const framed=await frame.evaluate(()=>window.readIdentity());validate(framed);
    return {scopes:8,serviceVersion:values.workers.service.version};
  }
  async function open(instance=browser, existingScope) {
    const scope=existingScope||`${origin}/suite/case-${++sequence}/`;
    const page=await instance.newPage();
    await page.goto(`${scope}index.html`,{waitUntil:'load',timeout:20000});
    await page.evaluate(()=>window.ready);
    await sample(page);
    return {page,scope};
  }
  async function cleanup(tab, instance=browser, targetAudit=audit) {
    if(!tab.page.isClosed()){
      await tab.page.evaluate(()=>window.shutdown());
      await tab.page.close();
    }
    const released=await instance.nativeIdentity.releaseWorkers({urlPrefix:tab.scope});
    assert.ok(released.every(item=>item.released),`session release failed: ${JSON.stringify(released.filter(item=>!item.released))}`);
    const deadline=Date.now()+4000;
    let remaining=[];
    do {
      remaining=(await targetAudit.send('Target.getTargets')).targetInfos.filter(target=>target.url.startsWith(tab.scope)&&['worker','shared_worker','service_worker'].includes(target.type));
      if(!remaining.length)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }while(Date.now()<deadline);
    assert.equal(remaining.length,0,'worker targets leaked after scoped cleanup');
    return released.length;
  }
  async function runCase(name,fn){
    const entry={name,startedAt:new Date().toISOString()};report.cases.push(entry);
    const started=Date.now();
    try{entry.result=await fn();entry.status='passed';}
    catch(error){entry.status='failed';entry.error=error.message;throw error;}
    finally{entry.durationMs=Date.now()-started;console.log(JSON.stringify({case:name,status:entry.status,durationMs:entry.durationMs,error:entry.error}));}
  }
  try {
    const options={executablePath:process.env.RESEARCH_CHROME_EXECUTABLE||`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      headless:true,protocolTimeout:20000,args:['--site-per-process'],nativeIdentity:{reference,browserChoice:'chrome'}};
    browser=await runtime.launch(options);report.browser=await browser.version();
    audit=await browser.target().createCDPSession();
    await runCase('modules, nested workers, cross-site frame, service update',async()=>{
      const tab=await open();
      const updated=await tab.page.evaluate(()=>window.updateService(2));validate(updated);assert.equal(updated.version,2);
      await sample(tab.page);
      const oldReleased=await browser.nativeIdentity.releaseWorkers({url:`${tab.scope}service.js?v=1`});
      assert.ok(oldReleased.every(item=>item.released));
      await sample(tab.page);
      await tab.page.evaluate(()=>window.stopService());
      await browser.nativeIdentity.releaseWorkers({url:`${tab.scope}service.js?v=2`});
      const restarted=await tab.page.evaluate(()=>window.updateService(3));validate(restarted);assert.equal(restarted.version,3);
      await sample(tab.page);
      assert.ok(browser.nativeIdentity.snapshot().events.some(event=>event.type==='iframe'&&event.status==='configured'),'OOPIF initialization not observed');
      return {oldVersionSessionsReleased:oldReleased.length,workerSessionsReleased:await cleanup(tab)};
    });
    await runCase('three concurrent tabs and isolated cleanup',async()=>{
      const tabs=await Promise.all([open(),open(),open()]);
      await Promise.all(tabs.map(tab=>sample(tab.page)));
      await cleanup(tabs[0]);
      await Promise.all(tabs.slice(1).map(tab=>sample(tab.page)));
      await Promise.all(tabs.slice(1).map(tab=>cleanup(tab)));
      return {tabs:3};
    });
    await runCase('two independent browser instances',async()=>{
      const second=await runtime.launch(options);
      try{
        const secondAudit=await second.target().createCDPSession();
        const firstTab=await open();const secondTab=await open(second);
        await Promise.all([sample(firstTab.page),sample(secondTab.page)]);
        await cleanup(firstTab);await sample(secondTab.page);
        assert.equal(second.nativeIdentity.snapshot().errors.length,0);
        await cleanup(secondTab,second,secondAudit);
        return {browsers:2};
      }finally{await second.close();}
    });
    await runCase('two tabs sharing the same service and shared worker scope',async()=>{
      const first=await open();const second=await open(browser,first.scope);
      await Promise.all([sample(first.page),sample(second.page)]);
      await first.page.evaluate(()=>window.closeClient());
      await first.page.close();
      // A shared scope is released only after its last measuring client ends.
      await sample(second.page);
      await cleanup(second);
      return {tabs:2,sharedScope:true,cleanupAfterLastClient:true};
    });
    await runCase('browser restart with persisted service-worker registration',async()=>{
      const profile=path.join(output,'restart-profile');
      const profileOptions={...options,userDataDir:profile};
      let instance=await runtime.launch(profileOptions);
      let saved;
      try{
        saved=await open(instance);await sample(saved.page);
        await instance.close();
        instance=await runtime.launch(profileOptions);
        const check=await instance.newPage();
        await check.goto(`${origin}/cleanup.html`,{waitUntil:'load'});
        const persisted=await check.evaluate(async scope=>{
          const registration=await navigator.serviceWorker.getRegistration(scope);
          return registration?{scope:registration.scope,scriptURL:registration.active?.scriptURL}:null;
        },saved.scope);
        assert.ok(persisted,'service-worker registration did not persist across browser restart');
        assert.equal(persisted.scope,saved.scope);
        assert.equal(persisted.scriptURL,`${saved.scope}service.js?v=1`);
        await check.close();
        const resumed=await open(instance,saved.scope);await sample(resumed.page);
        const resumedAudit=await instance.target().createCDPSession();
        await cleanup(resumed,instance,resumedAudit);
        assert.equal(instance.nativeIdentity.snapshot().errors.length,0);
        return {restarts:1,profile:'task-owned local profile',persistedRegistrationVerifiedBeforeReload:true};
      }finally{await instance.close().catch(()=>{});}
    });
    await runCase('abrupt tab closure during startup',async()=>{
      let attempts=0;
      for(let i=0;i<6;i++){
        const page=await browser.newPage();
        const scope=`${origin}/suite/cancel-${i}/`;
        const navigation=page.goto(`${scope}index.html`,{waitUntil:'load',timeout:10000}).catch(()=>{});
        await new Promise(resolve=>setTimeout(resolve,15));
        await page.close();await navigation;attempts++;
        assert.ok(browser.connected,'browser disconnected on ordinary tab cancellation');
        const cleaner=await browser.newPage();
        await cleaner.goto(`${origin}/cleanup.html`,{waitUntil:'load'});
        await cleaner.evaluate(async scope=>{const registration=await navigator.serviceWorker.getRegistration(scope);if(registration)await registration.unregister();},scope);
        await cleaner.close();
        await browser.nativeIdentity.releaseWorkers({urlPrefix:scope});
      }
      const probe=await open();await cleanup(probe);
      return {attempts};
    });
    await runCase('repeated churn with persistent peer tab',async()=>{
      const persistent=await open();
      const started=Date.now();let cycles=0;
      do{
        const pressure=persistent.page.evaluate(()=>window.burn(150));
        const tabs=await Promise.all([open(),open()]);
        await pressure;
        await Promise.all([persistent.page.evaluate(()=>window.burn(40)),...tabs.map(tab=>tab.page.evaluate(()=>window.burn(40)))]);
        await Promise.all(tabs.map(tab=>sample(tab.page)));
        await Promise.all(tabs.map(tab=>cleanup(tab)));
        await sample(persistent.page);cycles++;
        const state=browser.nativeIdentity.snapshot();
        assert.equal(state.errors.length,0,'initializer errors during churn');
        assert.ok(state.activeWorkers.every(worker=>worker.url.startsWith(persistent.scope)),'unrelated worker session retained during soak');
        let processes;
        try{const info=await audit.send('SystemInfo.getProcessInfo');processes=info.processInfo.reduce((counts,item)=>({...counts,[item.type]:(counts[item.type]||0)+1}),{});}
        catch(error){processes={measurementError:error.message};}
        report.samples.push({elapsedMs:Date.now()-started,cycles,activeWorkerSessions:state.activeWorkerSessions,eventCount:state.events.length,node:process.memoryUsage(),processes});
        console.log(JSON.stringify({phase:'churn',cycles,elapsedMs:Date.now()-started,activeWorkerSessions:state.activeWorkerSessions}));
        if(durationMs&&Date.now()-started<durationMs)await new Promise(resolve=>setTimeout(resolve,4000));
      }while(cycles<3||Date.now()-started<durationMs);
      await cleanup(persistent);
      return {cycles,durationMs:Date.now()-started};
    });
    report.finalState=browser.nativeIdentity.snapshot();
    await browser.nativeIdentity.releaseWorkers();
    report.afterFinalRelease=browser.nativeIdentity.snapshot();
    assert.equal(report.afterFinalRelease.activeWorkerSessions,0);
    report.status='passed';
  } catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
  finally{
    if(browser?.nativeIdentity)report.finalState=browser.nativeIdentity.snapshot();
    if(browser){
      try{await browser.close();report.browserConnectedAfterClose=browser.connected;report.browserExitCode=browser.process()?.exitCode;}
      catch(error){report.closeError=error.message;report.status='failed';process.exitCode=1;}
    }
    await new Promise(resolve=>server.close(resolve));
    report.finishedAt=new Date().toISOString();
    fs.writeFileSync(path.join(output,'metadata.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(outputRoot, 'reports',`${id}.json`),JSON.stringify(report,null,2)+'\n');
  }
  console.log(JSON.stringify({id,status:report.status,error:report.error,cases:report.cases.map(item=>({name:item.name,status:item.status}))}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
