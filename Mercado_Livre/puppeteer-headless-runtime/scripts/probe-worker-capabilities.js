'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {outputRoot, revision} = require('./diagnostic-environment');
const runtime = require('../src/puppeteer-runtime');
const {buildOverride} = require('./native-metadata');

async function identity() {
  return {
    scope: self.constructor.name,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: [...navigator.languages],
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    userAgentData: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues([
      'architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'uaFullVersion', 'wow64',
    ]) : null,
  };
}

function fixtureResponse(url, captureFirst = false) {
  const snapshot = `const collectIdentity = ${identity.toString()}; ${captureFirst
    ? 'const firstIdentity=collectIdentity(); const identity=async()=>({first:await firstIdentity,current:await collectIdentity()});'
    : 'const identity=collectIdentity;'} `;
  if (url === '/dedicated.js') return `${snapshot} self.onmessage = async () => self.postMessage(await identity());`;
  if (url === '/shared.js') return `${snapshot} self.onconnect = event => { const port=event.ports[0]; port.onmessage=async()=>port.postMessage(await identity()); port.start(); };`;
  if (url === '/service.js') return `${snapshot}
    self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
    self.onmessage = event => event.waitUntil(identity().then(value => event.ports[0].postMessage(value)));`;
  if (url === '/frame.html' || url === '/blank.html') return '<!doctype html><title>Local identity frame</title>';
  return `<!doctype html><title>Local worker identity probe</title><iframe src="/frame.html"></iframe>
    <script>
      const identity=${identity.toString()};
      window.ready=(async()=>{
        window.dedicated=new Worker('/dedicated.js');
        window.shared=new SharedWorker('/shared.js'); shared.port.start();
        await navigator.serviceWorker.register('/service.js');
        window.service=(await navigator.serviceWorker.ready).active;
      })();
      function request(port, serviceWorker=false) {
        return new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('Worker response timeout')),5000);
          const receive=event=>{clearTimeout(timer);resolve(event.data);};
          if(serviceWorker){const channel=new MessageChannel();channel.port1.onmessage=receive;port.postMessage('identity',[channel.port2]);}
          else{port.onmessage=receive;port.postMessage('identity');}
        });
      }
      window.readAll=async()=>({page:await identity(), workers:{
        dedicated:await request(dedicated), shared:await request(shared.port), service:await request(service,true)
      }});
    </script>`;
}

async function main() {
  const mode = process.argv[2] || 'native';
  if (!['native', 'launch-user-agent'].includes(mode)) throw new Error('Use native ou launch-user-agent.');
  let reference;
  if (mode === 'launch-user-agent') {
    if (!process.env.RESEARCH_NATIVE_REFERENCE) throw new Error('Defina RESEARCH_NATIVE_REFERENCE.');
    reference = JSON.parse(fs.readFileSync(process.env.RESEARCH_NATIVE_REFERENCE, 'utf8'));
  }
  const executablePath = process.env.RESEARCH_CHROME_EXECUTABLE || `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`;
  if (!fs.existsSync(executablePath)) throw new Error('Defina RESEARCH_CHROME_EXECUTABLE.');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-worker-capabilities-${mode}`;
  const output = path.join(outputRoot, 'artifacts', id);
  fs.mkdirSync(output, {recursive: true});
  const report = {
    id, mode, scope: 'local loopback fixture; already-running targets; not an early-initialization test',
    nativeReference: reference?.id,
    startedAt: new Date().toISOString(),
    ...revision(),
    sourceHashes: Object.fromEntries(['probe-worker-capabilities.js', 'native-metadata.js'].map(file => [file,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex')])),
    node: process.version,
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1').pathname;
    response.writeHead(200, {'Content-Type': url.endsWith('.js') ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store'});
    response.end(fixtureResponse(url));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    const launchArgs = mode === 'launch-user-agent'
      ? [`--user-agent=${buildOverride(reference, reference.browser, reference.browserChoice).userAgent}`] : [];
    browser = await runtime.launch({executablePath, headless: true, protocolTimeout: 10000, args: launchArgs});
    report.browser = await browser.version();
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin, {waitUntil: 'load', timeout: 15000});
    await page.evaluate(() => window.ready);
    report.before = await page.evaluate(() => window.readAll());
    const frame = page.frames().find(frame => frame.url().endsWith('/frame.html'));
    report.frameBefore = await frame.evaluate(identity);
    const override = buildOverride(reference || {variant: 'baseline', browser: report.browser, browserChoice: 'chrome',
      identityAudit: {page: report.before.page}}, report.browser, 'chrome');
    const root = await browser.target().createCDPSession();
    const {targetInfos} = await root.send('Target.getTargets');
    report.targets = [];
    for (const target of targetInfos.filter(target => target.url.startsWith(origin) && ['worker', 'shared_worker', 'service_worker'].includes(target.type))) {
      const result = {type: target.type, path: new URL(target.url).pathname, commands: []};
      report.targets.push(result);
      const puppeteerTarget = await browser.waitForTarget(candidate => candidate.url() === target.url, {timeout: 5000});
      const session = await puppeteerTarget.createCDPSession();
      try {
        try { result.domains = (await session.send('Schema.getDomains')).domains.map(domain => domain.name); }
        catch (error) { result.schemaError = error.message; }
        for (const method of ['Emulation.setUserAgentOverride', 'Network.setUserAgentOverride']) {
          const command = {method};
          result.commands.push(command);
          try { await session.send(method, override); command.accepted = true; }
          catch (error) { command.accepted = false; command.error = error.message; }
          command.observed = await page.evaluate(() => window.readAll());
        }
      } finally { await session.detach(); }
    }
    const pageSession = await page.createCDPSession();
    await pageSession.send('Emulation.setUserAgentOverride', override);
    report.afterPageOverride = await page.evaluate(() => window.readAll());
    report.frameAfterPageOverride = await frame.evaluate(identity);
    await page.screenshot({path: path.join(output, 'fixture.png')});
    if (report.targets.length !== 3) throw new Error(`Expected 3 worker targets, got ${report.targets.length}.`);
    report.status = 'complete';
  } catch (error) {
    report.status = 'error'; report.error = error.message; process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(report, null, 2));
    fs.mkdirSync(path.join(outputRoot, 'reports'), {recursive: true});
    fs.writeFileSync(path.join(outputRoot, 'reports', `${id}.json`), JSON.stringify(report, null, 2) + '\n');
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({id, status: report.status, error: report.error, targets: report.targets?.map(target => ({type: target.type, commands: target.commands.map(c => ({method: c.method, accepted: c.accepted, error: c.error}))}))}));
}

module.exports = {identity, fixtureResponse};
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
