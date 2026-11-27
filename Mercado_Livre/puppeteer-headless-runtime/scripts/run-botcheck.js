'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {outputRoot, revision} = require('./diagnostic-environment');
const puppeteer = require('../src/puppeteer-runtime');

async function main() {
  const mode = process.argv[2] || 'headful';
  const variant = process.argv[3] || 'baseline';
  const target = process.argv[4] || 'pixelscan';
  const browserChoice = process.argv[5] || 'edge';
  if (!['edge', 'chrome'].includes(browserChoice)) throw new Error('Navegador: edge ou chrome.');
  if (!['pixelscan', 'creepjs'].includes(target)) throw new Error('Alvo: pixelscan ou creepjs.');
  const experiment = require('./experiment-variant')(variant);
  if (!['headful', 'headless'].includes(mode)) throw new Error('Use headful ou headless.');
  const chromePaths = [
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  const edgePaths = [
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];
  const executablePath = (browserChoice === 'chrome' ? process.env.RESEARCH_CHROME_EXECUTABLE : process.env.RESEARCH_EDGE_EXECUTABLE)
    || (browserChoice === 'chrome' ? chromePaths : edgePaths).find(p => fs.existsSync(p));
  if (!executablePath || !fs.existsSync(executablePath)) throw new Error(`Defina RESEARCH_${browserChoice.toUpperCase()}_EXECUTABLE com um executável existente.`);
  const options = puppeteer.buildLaunchOptions({executablePath, headless: mode === 'headless'});
  if (options.headless !== (mode === 'headless')) throw new Error('O adaptador não suporta o modo solicitado.');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${browserChoice}-${target}-${mode}-${variant}`;
  const output = path.join(outputRoot, 'artifacts', id);
  fs.mkdirSync(output, {recursive: true});
  const metadata = {
    id, mode, variant, browserChoice, packages: experiment.packages, enabledEvasions: experiment.evasions,
    nativeReference: experiment.nativeReference,
    startedAt: new Date().toISOString(), target: target === 'pixelscan' ? 'https://pixelscan.net/bot-check' : 'https://abrahamjuliot.github.io/creepjs/',
    ...revision(),
    runtimeSha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../src/puppeteer-runtime.js'))).digest('hex'),
    runnerSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    sourceHashes: Object.fromEntries(['run-botcheck.js', 'experiment-variant.js', 'collect-creepjs.js', 'audit-identity.js', 'native-metadata.js', '../src/native-identity.js', '../patches/puppeteer-runtime-24.8.1/patch-manifest.json'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex')])),
    node: process.version, platform: process.platform, options, profile: 'fresh temporary profile',
  };
  let browser;
  try {
    let launchOptions = {executablePath, headless: mode === 'headless'};
    if (experiment.prepareLaunch) launchOptions = experiment.prepareLaunch(launchOptions);
    metadata.options = puppeteer.buildLaunchOptions(launchOptions);
    browser = await experiment.launcher.launch(launchOptions);
    metadata.browser = await browser.version();
    metadata.actualHeadlessArgument = browser.process().spawnargs.filter(a => /^--headless(?:=|$)/.test(a));
    metadata.actualIdentityArguments = browser.process().spawnargs.filter(a => /^--user-agent(?:=|$)/.test(a));
    const page = await browser.newPage();
    if (experiment.preparePage) metadata.pagePreparation = await experiment.preparePage(page, metadata.browser, browserChoice);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(metadata.target, {waitUntil: 'domcontentloaded', timeout: 60000});
    if (target === 'creepjs') {
      metadata.creepjs = await require('./collect-creepjs')(page);
      metadata.verdict = 'measured'; // CreepJS exposes signals, not a PixelScan-style binary verdict.
      metadata.finalUrl = page.url();
      metadata.finishedAt = new Date().toISOString();
      metadata.pageErrors = errors;
      fs.writeFileSync(path.join(output, 'visible-text.txt'), await page.evaluate(() => document.body.innerText));
      await page.screenshot({path: path.join(output, 'result.png'), fullPage: true});
      try { metadata.identityAudit = await require('./audit-identity')(page); }
      catch (error) { metadata.identityAudit = {error: error.message}; }
      console.log(JSON.stringify({output, variant, creepjs: metadata.creepjs.ratings}));
      return;
    }
    // Read rendered text only: the page can contain hidden result templates.
    let clicked = false;
    let verdict = null;
    let body = '';
    let previousVerdict = null;
    let stableSamples = 0;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      body = await page.evaluate(() => document.body.innerText);
      if (!clicked) {
        const buttons = await page.$$('button');
        for (const button of buttons) {
          const label = await button.evaluate(el => el.innerText.trim());
          if (/^start (check|test)$/i.test(label) && await button.isVisible()) {
            await button.click(); clicked = true; break;
          }
        }
      }
      const banners = await page.evaluate(() => {
        return [...document.querySelectorAll('h1,h2,h3,h4,p,span,div')]
          .filter(el => ["You're Definitely a Human", 'Bot Behavior Detected'].includes(el.textContent.trim()))
          .map(el => {
            let visible = el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
            for (let parent = el; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) visible = false;
            }
            return {text: el.textContent.trim(), visible};
          });
      });
      metadata.banners = banners;
      const human = banners.some(b => b.visible && b.text === "You're Definitely a Human");
      const bot = banners.some(b => b.visible && b.text === 'Bot Behavior Detected');
      const currentVerdict = human !== bot ? (human ? 'human' : 'bot') : null;
      stableSamples = currentVerdict && currentVerdict === previousVerdict ? stableSamples + 1 : 1;
      previousVerdict = currentVerdict;
      if (clicked && currentVerdict && stableSamples >= 3) { verdict = currentVerdict; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    metadata.finalUrl = page.url();
    metadata.clickedStart = clicked;
    metadata.verdict = verdict || 'inconclusive';
    metadata.finishedAt = new Date().toISOString();
    metadata.pageErrors = errors;
    // Refresh after the terminal banner stabilizes; avoid a pre-click snapshot.
    body = await page.evaluate(() => document.body.innerText);
    metadata.groups = Object.fromEntries(['Navigator', 'Webdriver', 'CDP', 'User Agent'].map(label => {
      const match = body.match(new RegExp(`^${label}\\s*\\n(Clear|Detected)\\s*$`, 'm'));
      return [label, match ? match[1] : 'unknown'];
    }));
    metadata.detectedChecks = [...body.matchAll(/^([^\r\n]+)\r?\nDetected\s*$/gm)].map(match => match[1]);
    fs.writeFileSync(path.join(output, 'visible-text.txt'), body);
    await page.screenshot({path: path.join(output, 'result.png'), fullPage: true});
    console.log(JSON.stringify({output, verdict: metadata.verdict, url: metadata.finalUrl, clickedStart: clicked}));
  } catch (error) {
    metadata.error = error.message;
    metadata.verdict = 'error';
    metadata.finishedAt = new Date().toISOString();
    process.exitCode = 1;
    throw error;
  } finally {
    if (browser?.nativeIdentity) {
      metadata.nativeIdentityBeforeRelease = browser.nativeIdentity.snapshot();
      metadata.nativeIdentityRelease = await browser.nativeIdentity.releaseWorkers();
      metadata.nativeIdentityAfterRelease = browser.nativeIdentity.snapshot();
      if (metadata.nativeIdentityBeforeRelease.errors.length) {
        metadata.verdict = 'error';
        metadata.error = 'Native target initialization failed.';
        process.exitCode = 1;
      }
    }
    fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
    const reports = path.join(outputRoot, 'reports');
    fs.mkdirSync(reports, {recursive: true});
    const {options: recordedOptions, ...report} = metadata;
    report.options = {...recordedOptions, executablePath: path.basename(recordedOptions.executablePath)};
    report.localEvidence = `artifacts/${id}/`;
    fs.writeFileSync(path.join(reports, `${id}.json`), JSON.stringify(report, null, 2) + '\n');
    if (browser) await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
