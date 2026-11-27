'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {outputRoot, revision} = require('./diagnostic-environment');
const runtime = require('../src/puppeteer-runtime');
const {fixtureResponse, identity} = require('./probe-worker-capabilities');

async function main() {
  const mode = process.argv[2] || 'integrated';
  if (!['baseline', 'integrated'].includes(mode)) throw new Error('Use baseline ou integrated.');
  const referenceBytes = fs.readFileSync(process.env.RESEARCH_NATIVE_REFERENCE || '');
  const reference = JSON.parse(referenceBytes.toString('utf8'));
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-puppeteer-integration-${mode}`;
  const output = path.join(outputRoot, 'artifacts', id);
  fs.mkdirSync(output, {recursive: true});
  const report = {id, mode, startedAt: new Date().toISOString(), rounds: [],
    ...revision(),
    nativeReference: {id: reference.id, sha256: crypto.createHash('sha256').update(referenceBytes).digest('hex')},
    sourceHashes: Object.fromEntries(['scripts/test-native-integration.js', 'scripts/probe-worker-capabilities.js', 'src/native-identity.js', 'src/puppeteer-runtime.js',
      'patches/puppeteer-runtime-24.8.1/patch-manifest.json'].map(file => [file,
      crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', file))).digest('hex')])),
  };
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    response.writeHead(200, {'Content-Type': route.endsWith('.js') ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store'});
    response.end(fixtureResponse(route, true));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    const options = {executablePath: process.env.RESEARCH_CHROME_EXECUTABLE || `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      headless: true, protocolTimeout: 15000};
    if (mode === 'integrated') options.nativeIdentity = {reference, browserChoice: 'chrome'};
    browser = await runtime.launch(options);
    report.browser = await browser.version();
    const targetAudit = await browser.target().createCDPSession();
    assert.equal(report.browser, reference.browser);
    const expected = reference.identityAudit.page;
    const expectedUA = mode === 'integrated' ? expected.userAgent.replace('HeadlessChrome/', 'Chrome/') : expected.userAgent;
    for (let round = 1; round <= 3; round++) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`, {waitUntil: 'load', timeout: 15000});
      await page.evaluate(() => window.ready);
      const observed = await page.evaluate(() => window.readAll());
      const frame = page.frames().find(frame => frame.url().endsWith('/frame.html'));
      const frameIdentity = await frame.evaluate(identity);
      const entry = {round, observed, frameIdentity};
      report.rounds.push(entry);
      const scopes = [observed.page, frameIdentity];
      for (const data of Object.values(observed.workers)) {
        assert.deepEqual(data.first, data.current, `worker first/current round ${round}`);
        scopes.push(data.first, data.current);
      }
      for (const scope of scopes) {
        assert.equal(scope.userAgent, expectedUA, `${scope.scope} UA round ${round}`);
        for (const field of ['userAgentData', 'platform', 'language', 'languages', 'locale']) {
          assert.deepEqual(scope[field], expected[field], `${scope.scope} ${field} round ${round}`);
        }
      }
      await page.evaluate(async () => {
        dedicated.terminate(); shared.port.close();
        await Promise.all((await navigator.serviceWorker.getRegistrations()).map(registration => registration.unregister()));
      });
      await page.close();
      if (browser.nativeIdentity) {
        entry.beforeRelease = browser.nativeIdentity.snapshot();
        entry.released = await browser.nativeIdentity.releaseWorkers();
        entry.afterRelease = browser.nativeIdentity.snapshot();
        assert.equal(entry.afterRelease.errors.length, 0);
        assert.equal(entry.afterRelease.activeWorkerSessions, 0);
        assert.ok(entry.released.every(result => result.released));
      }
      const deadline = Date.now() + 3000;
      do {
        const {targetInfos} = await targetAudit.send('Target.getTargets');
        entry.remainingWorkerTargets = targetInfos.filter(target =>
          target.url.startsWith(`http://127.0.0.1:${server.address().port}/`) &&
          ['worker', 'shared_worker', 'service_worker'].includes(target.type)).map(target => ({type: target.type, url: target.url}));
        if (!entry.remainingWorkerTargets.length) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      assert.equal(entry.remainingWorkerTargets.length, 0, `worker targets still alive after cleanup round ${round}`);
      entry.passed = true;
    }
    report.status = 'passed';
  } catch (error) { report.status = 'error'; report.error = error.message; process.exitCode = 1; }
  finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outputRoot, 'reports', `${id}.json`), JSON.stringify(report, null, 2) + '\n');
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({id, status: report.status, error: report.error, passedRounds: report.rounds.filter(round => round.passed).length}));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
