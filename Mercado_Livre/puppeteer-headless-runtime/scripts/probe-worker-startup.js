'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {outputRoot, revision} = require('./diagnostic-environment');
const runtime = require('../src/puppeteer-runtime');
const {buildOverride} = require('./native-metadata');
const {identity, fixtureResponse} = require('./probe-worker-capabilities');

async function main() {
  const mode = process.argv[2] || 'worker-early';
  if (!['page-only', 'worker-early', 'hybrid-native'].includes(mode)) throw new Error('Use page-only, worker-early ou hybrid-native.');
  const referencePath = process.env.RESEARCH_NATIVE_REFERENCE;
  const externalReference = mode === 'hybrid-native'
    ? JSON.parse(fs.readFileSync(referencePath || '', 'utf8')) : null;
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-worker-startup-${mode}`;
  const directory = path.join(outputRoot, 'artifacts', id);
  fs.mkdirSync(directory, {recursive: true});
  const report = {
    id, mode, scope: 'local loopback fixture; debugger-wait before first script; no JS property patches',
    startedAt: new Date().toISOString(),
    ...revision(),
    sourceHashes: Object.fromEntries(['probe-worker-startup.js', 'probe-worker-capabilities.js', 'native-metadata.js'].map(file => [file,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex')])),
    attachments: [],
  };
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    response.writeHead(200, {'Content-Type': route.endsWith('.js') ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store'});
    response.end(fixtureResponse(route, true));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  const pending = new Set();
  try {
    const executablePath = process.env.RESEARCH_CHROME_EXECUTABLE || `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`;
    const args = externalReference
      ? [`--user-agent=${buildOverride(externalReference, externalReference.browser, 'chrome').userAgent}`] : [];
    browser = await runtime.launch({executablePath, headless: true, protocolTimeout: 10000, args});
    report.browser = await browser.version();
    const root = await browser.target().createCDPSession();
    const connection = root.connection();
    // Diagnostic only: remove Puppeteer's default auto-resume before using one
    // explicitly managed session tree. Do not use normal Page APIs after this.
    await connection.send('Target.setAutoAttach', {autoAttach: false, waitForDebuggerOnStart: false, flatten: true});
    const {targetId} = await root.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await root.send('Target.attachToTarget', {targetId, flatten: true});
    const pageSession = connection.session(sessionId);
    await pageSession.send('Page.enable');
    async function navigate(url) {
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pageSession.off('Page.loadEventFired', done); reject(new Error('Local page load timeout')); }, 15000);
        const done = () => { clearTimeout(timer); resolve(); };
        pageSession.once('Page.loadEventFired', done);
      });
      await pageSession.send('Page.navigate', {url});
      await loaded;
    }
    async function evaluate(expression) {
      const result = await pageSession.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    const origin = `http://127.0.0.1:${server.address().port}`;
    await navigate(`${origin}/blank.html`);
    report.beforePreparation = await evaluate(`(${identity.toString()})()`);
    report.nativeReference = externalReference?.identityAudit.page || report.beforePreparation;
    if (externalReference) {
      report.nativeReferenceId = externalReference.id;
      report.nativeReferenceSha256 = crypto.createHash('sha256').update(fs.readFileSync(referencePath)).digest('hex');
    }
    const override = buildOverride(externalReference || {variant: 'baseline', browser: report.browser, browserChoice: 'chrome',
      identityAudit: {page: report.nativeReference}}, report.browser, 'chrome');
    const onAttached = event => {
      if (!['worker', 'shared_worker', 'service_worker'].includes(event.targetInfo.type)) return;
      const task = (async () => {
        const attachment = {type: event.targetInfo.type, waitingForDebugger: event.waitingForDebugger, commands: []};
        report.attachments.push(attachment);
        const session = connection.session(event.sessionId);
        try {
          if (mode === 'worker-early' || mode === 'hybrid-native') {
            const command = {method: 'Emulation.setUserAgentOverride'};
            attachment.commands.push(command);
            const configuration = session.send(command.method, override, {timeout: 3000});
            if (mode === 'hybrid-native') {
              // The service worker can require release of its browser-side start
              // gate before its inspector accepts configuration. Measure the
              // first script's identity to detect any resulting race.
              await session.send('Runtime.runIfWaitingForDebugger');
              attachment.resumed = true;
            }
            try { await configuration; command.accepted = true; }
            catch (error) { command.accepted = false; command.error = error.message; }
          }
        } catch (error) { attachment.error = error.message; }
        finally {
          try { if (!attachment.resumed) await session.send('Runtime.runIfWaitingForDebugger'); attachment.resumed = true; }
          catch (error) { attachment.resumeError = error.message; }
        }
      })();
      pending.add(task); task.finally(() => pending.delete(task));
    };
    root.on('Target.attachedToTarget', onAttached);
    pageSession.on('Target.attachedToTarget', onAttached);
    const attachOptions = {autoAttach: true, waitForDebuggerOnStart: true, flatten: true};
    report.attachmentStrategy = 'browser session owns shared workers; page session owns service and dedicated workers';
    await root.send('Target.setAutoAttach', {...attachOptions, filter: [{type: 'shared_worker'}]});
    await pageSession.send('Target.setAutoAttach', {...attachOptions, filter: [{type: 'worker'}, {type: 'service_worker'}]});
    await pageSession.send('Emulation.setUserAgentOverride', override);
    await navigate(`${origin}/`);
    await evaluate('window.ready');
    report.observed = await evaluate('window.readAll()');
    await Promise.all([...pending]);
    for (const type of ['worker', 'shared_worker', 'service_worker']) {
      const attachment = report.attachments.find(attachment => attachment.type === type);
      if (!attachment || !attachment.waitingForDebugger || !attachment.resumed || attachment.error) {
        throw new Error(`Early coverage not established for ${type}`);
      }
    }
    report.status = 'complete';
  } catch (error) { report.status = 'error'; report.error = error.message; process.exitCode = 1; }
  finally {
    await Promise.allSettled([...pending]);
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outputRoot, 'reports', `${id}.json`), JSON.stringify(report, null, 2) + '\n');
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({id, mode, status: report.status, error: report.error, attachments: report.attachments,
    workers: report.observed && Object.fromEntries(Object.entries(report.observed.workers).map(([name, data]) => [name,
      {firstHeadless: /HeadlessChrome/.test(data.first.userAgent), currentHeadless: /HeadlessChrome/.test(data.current.userAgent),
        fullVersion: data.current.userAgentData?.uaFullVersion}]))}));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
