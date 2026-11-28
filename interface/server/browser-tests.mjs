import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_HISTORY = 40;
const MAX_LOG_CHARS = 48_000;
const SAFE_ID_RE = /^[a-zA-Z0-9._-]{1,120}$/;

export const BROWSER_TEST_CATEGORIES = {
  all: 'Todos os testes',
  runtime: 'Runtime',
  detectors: 'Detectores',
  stability: 'Estabilidade',
  purchase: 'Compras',
};

export const BROWSER_TEST_CATALOG = [
  {
    id: 'verify',
    name: 'Verificar patches do runtime',
    category: 'runtime',
    description: 'Confere os hashes SHA-256 dos 5 arquivos CDP modificados no Puppeteer 24.8.1 e o modo addBinding.',
    estimatedDuration: '~2 s',
    needsNetwork: false,
    needsReference: false,
    args: ['scripts/verify-puppeteer-runtime-patch.js'],
  },
  {
    id: 'identity-unit',
    name: 'Testes unitários de identidade nativa',
    category: 'runtime',
    description: 'Valida a geração de metadados de User-Agent/Client Hints e o controlador de identidade nativa.',
    estimatedDuration: '~2 s',
    needsNetwork: false,
    needsReference: false,
    args: ['--test', '--test-reporter=tap', 'scripts/native-metadata.test.js', 'scripts/native-identity.test.js'],
  },
  {
    id: 'pixelscan-headless',
    name: 'PixelScan Bot Check (Headless Vigia)',
    category: 'detectors',
    description: 'Inicia o Chrome pelo mesmo iniciarIntegracao do Vigia e testa anti-detecção no PixelScan com captura de tela.',
    estimatedDuration: '~25–45 s',
    needsNetwork: true,
    needsReference: false,
    args: ['scripts/run-botcheck.js', 'headless', 'vigia-headless', 'pixelscan', 'chrome'],
  },
  {
    id: 'creepjs-headless',
    name: 'CreepJS Fingerprint (Headless Vigia)',
    category: 'detectors',
    description: 'Inicia o Chrome pelo mesmo iniciarIntegracao do Vigia e mede sinais de headless, stealth e Página vs. Worker no CreepJS.',
    estimatedDuration: '~25–45 s',
    needsNetwork: true,
    needsReference: false,
    args: ['scripts/run-botcheck.js', 'headless', 'vigia-headless', 'creepjs', 'chrome'],
  },
  {
    id: 'integration',
    name: 'Integração nativa do Puppeteer (3 ciclos)',
    category: 'stability',
    description: 'Executa 3 ciclos completos de página, iframe e workers conferindo identidade e encerramento limpo.',
    estimatedDuration: '~15–25 s',
    needsNetwork: false,
    needsReference: true,
    args: ['scripts/test-native-integration.js', 'integrated'],
  },
  {
    id: 'stability-smoke',
    name: 'Estabilidade e concorrência (Smoke)',
    category: 'stability',
    description: 'Testa múltiplas abas simultâneas, iframe cross-site (OOPIF), 2 navegadores independentes e limpeza por escopo.',
    estimatedDuration: '~30–50 s',
    needsNetwork: false,
    needsReference: true,
    args: ['scripts/test-native-stability.js', 'smoke'],
  },
  {
    id: 'stability-soak',
    name: 'Estabilidade prolongada (Soak 5 min)',
    category: 'stability',
    description: 'Mantém ciclos contínuos por 5 minutos em loopback validando vazamento de workers e memória.',
    estimatedDuration: '~5–6 min',
    needsNetwork: false,
    needsReference: true,
    args: ['scripts/test-native-stability.js', 'soak'],
  },
  {
    id: 'purchase-amazon-pix',
    name: 'Simulação de compra · Amazon (Pix)',
    category: 'purchase',
    description: 'Simula toda a compra Amazon por Pix em Chrome headless real (100% local), sorteando aleatoriamente entre Fluxo A e Fluxo B.',
    estimatedDuration: '~10–20 s',
    needsNetwork: false,
    needsReference: false,
    cwd: 'projectRoot',
    args: ['interface/server/run-purchase-simulation.mjs', 'purchase-amazon-pix', 'random'],
  },
  {
    id: 'purchase-amazon-card',
    name: 'Simulação de compra · Amazon (Cartão)',
    category: 'purchase',
    description: 'Simula toda a compra Amazon por cartão à vista em Chrome headless real (100% local), sorteando aleatoriamente entre Fluxo A e Fluxo B.',
    estimatedDuration: '~10–20 s',
    needsNetwork: false,
    needsReference: false,
    cwd: 'projectRoot',
    args: ['interface/server/run-purchase-simulation.mjs', 'purchase-amazon-card', 'random'],
  },
  {
    id: 'purchase-ml-pix',
    name: 'Simulação de compra · Mercado Livre (Pix)',
    category: 'purchase',
    description: 'Simula todo o fluxo de compra do Mercado Livre por Pix em Chrome headless real (100% local), validando carrinho, frete e código Pix.',
    estimatedDuration: '~10–20 s',
    needsNetwork: false,
    needsReference: false,
    cwd: 'projectRoot',
    args: ['interface/server/run-purchase-simulation.mjs', 'purchase-ml-pix'],
  },
  {
    id: 'purchase-ml-card',
    name: 'Simulação de compra · Mercado Livre (Cartão)',
    category: 'purchase',
    description: 'Simula todo o fluxo de compra do Mercado Livre por cartão à vista em Chrome headless real (100% local), validando seleção do cartão e confirmação.',
    estimatedDuration: '~10–20 s',
    needsNetwork: false,
    needsReference: false,
    cwd: 'projectRoot',
    args: ['interface/server/run-purchase-simulation.mjs', 'purchase-ml-card'],
  },
];

export function locateChromeExecutable() {
  const candidates = [
    process.env.RESEARCH_CHROME_EXECUTABLE,
    process.env.ML_CHROME_EXECUTABLE,
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return candidates.find(p => existsSync(p)) ?? null;
}

function appendLog(current, chunk) {
  const next = current + chunk;
  if (next.length <= MAX_LOG_CHARS) return next;
  return '… (saída anterior truncada)\n' + next.slice(next.length - MAX_LOG_CHARS);
}

function parseTestOutputSummary(testId, report, stdout, stderr, exitCode) {
  if (report && typeof report === 'object') {
    if (testId.startsWith('pixelscan-')) {
      const verdict = report.verdict ?? (exitCode === 0 ? 'inconclusive' : 'error');
      return {
        kind: 'pixelscan',
        verdict,
        browser: report.browser ?? null,
        groups: report.groups ?? null,
        detectedChecks: Array.isArray(report.detectedChecks) ? report.detectedChecks : [],
        clickedStart: Boolean(report.clickedStart),
        finalUrl: report.finalUrl ?? null,
        error: report.error ?? null,
      };
    }
    if (testId.startsWith('creepjs-')) {
      return {
        kind: 'creepjs',
        verdict: report.verdict ?? (exitCode === 0 ? 'measured' : 'error'),
        browser: report.browser ?? null,
        ratings: report.creepjs?.ratings ?? null,
        headlessScores: report.creepjs?.headless ?? null,
        pageWorkerMatch: report.identityAudit?.pageWorkerUserAgentMatches ?? null,
        pageUserAgent: report.identityAudit?.page?.userAgent ?? null,
        workerUserAgent: report.identityAudit?.creepjsWorker?.userAgent ?? null,
        error: report.error ?? null,
      };
    }
    if (testId === 'integration') {
      const rounds = Array.isArray(report.rounds) ? report.rounds : [];
      return {
        kind: 'integration',
        status: report.status ?? (exitCode === 0 ? 'passed' : 'error'),
        browser: report.browser ?? null,
        totalRounds: rounds.length,
        passedRounds: rounds.filter(r => r?.passed).length,
        error: report.error ?? null,
      };
    }
    if (testId.startsWith('stability-')) {
      const cases = Array.isArray(report.cases) ? report.cases.map(c => ({
        name: c.name,
        status: c.status,
        durationMs: c.durationMs ?? null,
        error: c.error ?? null,
      })) : [];
      const samples = Array.isArray(report.samples) ? report.samples.length : 0;
      return {
        kind: 'stability',
        status: report.status ?? (exitCode === 0 ? 'passed' : 'error'),
        browser: report.browser ?? null,
        cases,
        passedCases: cases.filter(c => c.status === 'passed').length,
        totalCases: cases.length,
        soakSamples: samples,
        error: report.error ?? null,
      };
    }
    if (testId.startsWith('purchase-')) {
      return {
        kind: 'purchase',
        status: report.status ?? (exitCode === 0 ? 'passed' : 'failed'),
        storeLabel: report.storeLabel ?? null,
        paymentLabel: report.paymentLabel ?? null,
        flow: report.flow ?? null,
        flowLabel: report.flowLabel ?? null,
        totalCents: report.totalCents ?? null,
        finalClicks: report.finalClicks ?? null,
        trustedClicks: report.trustedClicks ?? null,
        stagesCount: report.stagesCount ?? null,
        recoveredFaults: Array.isArray(report.recoveredFaults) ? report.recoveredFaults : [],
        pixVerified: Boolean(report.pixVerified),
        orderReferences: Array.isArray(report.orderReferences) ? report.orderReferences : [],
        error: report.error ?? null,
      };
    }
    if (testId === 'probe-workers' || testId === 'probe-startup') {
      const attachments = Array.isArray(report.attachments) ? report.attachments.map(a => ({
        type: a.type,
        resumed: Boolean(a.resumed),
        accepted: Array.isArray(a.commands) ? a.commands.every(c => c.accepted !== false) : true,
        error: a.error ?? null,
      })) : [];
      return {
        kind: 'workers',
        browser: report.browser ?? null,
        mode: report.mode ?? null,
        attachments,
        error: report.error ?? null,
      };
    }
  }

  if (testId === 'verify') {
    const okFiles = (stdout.match(/^\s*-\s*OK\s+.+$/gm) ?? []).map(line => line.replace(/^\s*-\s*OK\s+/, '').trim());
    return {
      kind: 'verify',
      verifiedCount: okFiles.length,
      files: okFiles,
      error: exitCode === 0 ? null : (stderr.trim() || stdout.trim() || 'Verificação falhou.'),
    };
  }

  if (testId === 'identity-unit') {
    const passMatch = stdout.match(/(?:#|ℹ)\s*pass\s+(\d+)/i);
    const failMatch = stdout.match(/(?:#|ℹ)\s*fail\s+(\d+)/i);
    const totalMatch = stdout.match(/(?:#|ℹ)\s*tests\s+(\d+)/i);
    return {
      kind: 'unit',
      total: totalMatch ? Number(totalMatch[1]) : null,
      passed: passMatch ? Number(passMatch[1]) : null,
      failed: failMatch ? Number(failMatch[1]) : null,
      error: exitCode === 0 ? null : (stderr.trim() || 'Um ou mais testes unitários falharam.'),
    };
  }

  return {
    kind: 'generic',
    exitCode,
    error: exitCode === 0 ? null : (stderr.trim() || 'Execução encerrada com erro.'),
  };
}

function classifyRunStatus(testId, summary, exitCode, cancelled) {
  if (cancelled) return 'cancelled';
  if (exitCode !== 0) return 'failed';
  if (testId.startsWith('pixelscan-')) {
    if (summary?.verdict === 'human') return 'passed';
    if (summary?.verdict === 'bot' || summary?.verdict === 'error') return 'failed';
    return 'warning';
  }
  if (summary?.status === 'error' || summary?.status === 'failed') return 'failed';
  return 'passed';
}

export class BrowserTestRunner {
  constructor({ projectRoot, dataDirectory, appVersion = '0.0.0', chromeExecutable = null, customExecutor = null } = {}) {
    this.projectRoot = resolve(projectRoot);
    this.runtimeRoot = join(this.projectRoot, 'Mercado_Livre', 'puppeteer-headless-runtime');
    this.dataDirectory = resolve(dataDirectory);
    this.outputRoot = join(this.dataDirectory, 'browser-tests');
    this.reportsDir = join(this.outputRoot, 'reports');
    this.artifactsDir = join(this.outputRoot, 'artifacts');
    this.historyFile = join(this.outputRoot, 'history.json');
    this.referenceFile = join(this.outputRoot, 'native-reference.json');
    this.appVersion = appVersion;
    this.chromeExecutable = chromeExecutable;
    this.customExecutor = customExecutor;
    this.history = [];
    this.activeRun = null;
    this.activeBatch = null;
    this.activeChild = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await mkdir(this.reportsDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.historyFile, 'utf8'));
      if (Array.isArray(raw)) {
        this.history = raw.slice(0, MAX_HISTORY);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') this.history = [];
    }
    this.initialized = true;
  }

  async saveHistory() {
    await mkdir(this.outputRoot, { recursive: true });
    await writeFile(this.historyFile, JSON.stringify(this.history.slice(0, MAX_HISTORY), null, 2), 'utf8');
  }

  resolveChrome() {
    return this.chromeExecutable ?? locateChromeExecutable();
  }

  runtimeAvailable() {
    return existsSync(join(this.runtimeRoot, 'src', 'puppeteer-runtime.js'));
  }

  state() {
    const chromePath = this.resolveChrome();
    return {
      runtimeAvailable: this.runtimeAvailable(),
      chromeAvailable: Boolean(chromePath),
      chromeExecutable: chromePath ? basename(chromePath) : null,
      catalog: BROWSER_TEST_CATALOG.map(({ args, ...meta }) => meta),
      activeRun: this.activeRun ? { ...this.activeRun } : null,
      activeBatch: this.activeBatch ? { ...this.activeBatch } : null,
      history: this.history.slice(0, MAX_HISTORY),
    };
  }

  async ensureNativeReference(chromePath, onLog) {
    if (!chromePath) {
      throw new Error('Google Chrome não encontrado nesta máquina.');
    }
    const require = createRequire(import.meta.url);
    const puppeteer = require(join(this.runtimeRoot, 'src', 'puppeteer-runtime.js'));

    // Check existing cached reference first — verify browser version matches if possible.
    let cached = null;
    try {
      const parsed = JSON.parse(await readFile(this.referenceFile, 'utf8'));
      if (parsed?.variant === 'baseline' && parsed?.browserChoice === 'chrome' && parsed?.identityAudit?.page?.userAgentData?.uaFullVersion) {
        cached = parsed;
      }
    } catch {}

    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>Referência nativa local</title>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let browser;
    try {
      onLog('[Vigia] Coletando referência nativa local do Chrome…\n');
      browser = await puppeteer.launch({ executablePath: chromePath, headless: true, protocolTimeout: 15000 });
      const version = await browser.version();
      if (cached && cached.browser === version) {
        onLog(`[Vigia] Referência nativa em cache compatível (${version}).\n`);
        return this.referenceFile;
      }
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const pageIdentity = await page.evaluate(async () => {
        const userAgentData = navigator.userAgentData
          ? await navigator.userAgentData.getHighEntropyValues([
            'architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'uaFullVersion', 'wow64',
          ])
          : null;
        return {
          userAgent: navigator.userAgent,
          appVersion: navigator.appVersion,
          platform: navigator.platform,
          language: navigator.language,
          languages: [...navigator.languages],
          locale: Intl.DateTimeFormat().resolvedOptions().locale,
          userAgentData,
        };
      });
      const reference = {
        id: `local-baseline-${Date.now()}`,
        variant: 'baseline',
        browserChoice: 'chrome',
        browser: version,
        collectedAt: new Date().toISOString(),
        identityAudit: {
          collectedAfterDetector: false,
          page: pageIdentity,
        },
      };
      await mkdir(this.outputRoot, { recursive: true });
      await writeFile(this.referenceFile, JSON.stringify(reference, null, 2), 'utf8');
      onLog(`[Vigia] Referência nativa salva (${version}).\n`);
      return this.referenceFile;
    } finally {
      if (browser) await browser.close().catch(() => {});
      server.closeAllConnections?.();
      await new Promise(resolveClose => server.close(resolveClose));
    }
  }

  async start(testId) {
    await this.init();
    const spec = BROWSER_TEST_CATALOG.find(item => item.id === testId);
    if (!spec) {
      const err = new Error('Teste não encontrado no catálogo.');
      err.status = 400;
      throw err;
    }
    if (this.activeRun || this.activeBatch) {
      const err = new Error('Já existe um teste em execução. Aguarde ou cancele antes de iniciar outro.');
      err.status = 409;
      throw err;
    }
    if (!this.customExecutor && !this.runtimeAvailable()) {
      const err = new Error('Runtime Puppeteer headless não encontrado nesta instalação.');
      err.status = 500;
      throw err;
    }
    const chromePath = this.resolveChrome();
    if (!this.customExecutor && spec.category !== 'runtime' && !chromePath) {
      const err = new Error('Google Chrome não encontrado nesta máquina para executar os testes do navegador.');
      err.status = 400;
      throw err;
    }

    const runId = randomUUID();
    const run = {
      id: runId,
      testId: spec.id,
      testName: spec.name,
      category: spec.category,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      artifactId: null,
      hasScreenshot: false,
      summary: null,
      log: '',
      error: null,
      cancelled: false,
    };
    this.activeRun = run;

    void this._executeRun(spec, run, chromePath);
    return { ...run };
  }

  async startBatch({ category = 'all' } = {}) {
    await this.init();
    const cat = String(category || 'all').trim();
    if (!Object.hasOwn(BROWSER_TEST_CATEGORIES, cat)) {
      const err = new Error('Categoria de testes inválida.');
      err.status = 400;
      throw err;
    }
    if (this.activeRun || this.activeBatch) {
      const err = new Error('Já existe um teste ou bateria em execução. Aguarde ou cancele antes de iniciar outro.');
      err.status = 409;
      throw err;
    }
    const specs = cat === 'all'
      ? [...BROWSER_TEST_CATALOG]
      : BROWSER_TEST_CATALOG.filter(item => item.category === cat);
    if (!specs.length) {
      const err = new Error('Nenhum teste encontrado para esta categoria.');
      err.status = 400;
      throw err;
    }
    if (!this.customExecutor && !this.runtimeAvailable()) {
      const err = new Error('Runtime Puppeteer headless não encontrado nesta instalação.');
      err.status = 500;
      throw err;
    }
    const chromePath = this.resolveChrome();
    if (!this.customExecutor && specs.some(s => s.category !== 'runtime') && !chromePath) {
      const err = new Error('Google Chrome não encontrado nesta máquina para executar os testes do navegador.');
      err.status = 400;
      throw err;
    }

    const batch = {
      id: randomUUID(),
      category: cat,
      label: BROWSER_TEST_CATEGORIES[cat],
      startedAt: new Date().toISOString(),
      total: specs.length,
      completed: 0,
      passed: 0,
      warning: 0,
      failed: 0,
      cancelledCount: 0,
      currentIndex: 0,
      cancelled: false,
      testIds: specs.map(s => s.id),
      runIds: [],
    };
    this.activeBatch = batch;
    void this._executeBatch(specs, batch, chromePath);
    return { ...batch };
  }

  async _executeBatch(specs, batch, chromePath) {
    try {
      for (let i = 0; i < specs.length; i++) {
        if (batch.cancelled) break;
        const spec = specs[i];
        batch.currentIndex = i + 1;
        const run = {
          id: randomUUID(),
          testId: spec.id,
          testName: spec.name,
          category: spec.category,
          batchId: batch.id,
          status: 'running',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          durationMs: null,
          exitCode: null,
          artifactId: null,
          hasScreenshot: false,
          summary: null,
          log: '',
          error: null,
          cancelled: false,
        };
        this.activeRun = run;
        batch.runIds.push(run.id);
        await this._executeRun(spec, run, chromePath);
        batch.completed += 1;
        if (run.status === 'passed') batch.passed += 1;
        else if (run.status === 'warning') batch.warning += 1;
        else if (run.status === 'cancelled') batch.cancelledCount += 1;
        else batch.failed += 1;
      }
    } finally {
      this.activeBatch = null;
    }
  }

  async _executeRun(spec, run, chromePath) {
    const startedMs = Date.now();
    const onLog = chunk => {
      run.log = appendLog(run.log, String(chunk));
    };

    try {
      let existingReports = new Set();
      try {
        existingReports = new Set(await readdir(this.reportsDir));
      } catch {}

      let stdout = '';
      let stderr = '';
      let exitCode = 0;

      if (this.customExecutor) {
        const res = await this.customExecutor({
          spec,
          run,
          outputRoot: this.outputRoot,
          reportsDir: this.reportsDir,
          artifactsDir: this.artifactsDir,
          onLog,
          setChild: child => { this.activeChild = child; },
        });
        stdout = res?.stdout ?? '';
        stderr = res?.stderr ?? '';
        exitCode = res?.exitCode ?? 0;
      } else {
        const env = {
          ...process.env,
          MONITOR_PROJECT_ROOT: this.projectRoot,
          RESEARCH_OUTPUT_ROOT: this.outputRoot,
          RESEARCH_APP_VERSION: this.appVersion,
          ...(chromePath ? { RESEARCH_CHROME_EXECUTABLE: chromePath, ML_CHROME_EXECUTABLE: chromePath } : {}),
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        };
        delete env.NODE_TEST_CONTEXT;

        if (spec.needsReference) {
          env.RESEARCH_NATIVE_REFERENCE = await this.ensureNativeReference(chromePath, onLog);
          if (run.cancelled) throw new Error('Teste cancelado pelo administrador.');
        }

        onLog(`[Vigia] Iniciando: ${spec.name}\n`);
        exitCode = await new Promise((resolveExit, rejectExit) => {
          const child = spawn(process.execPath, spec.args, {
            cwd: spec.cwd === 'projectRoot' ? this.projectRoot : this.runtimeRoot,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          this.activeChild = child;
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', chunk => {
            stdout += chunk;
            onLog(chunk);
          });
          child.stderr.on('data', chunk => {
            stderr += chunk;
            onLog(chunk);
          });
          child.once('error', rejectExit);
          child.once('close', code => {
            this.activeChild = null;
            resolveExit(code ?? 1);
          });
        });
      }

      // Locate newly created report JSON if any
      let report = null;
      let artifactId = null;
      try {
        const afterReports = (await readdir(this.reportsDir))
          .filter(fn => fn.endsWith('.json') && !existingReports.has(fn))
          .sort();
        const newestReport = afterReports.at(-1);
        if (newestReport) {
          report = JSON.parse(await readFile(join(this.reportsDir, newestReport), 'utf8'));
          if (typeof report?.id === 'string' && SAFE_ID_RE.test(report.id)) {
            artifactId = report.id;
          }
        }
      } catch {}

      const hasScreenshot = Boolean(
        artifactId && existsSync(join(this.artifactsDir, artifactId, 'result.png'))
      );

      const summary = parseTestOutputSummary(spec.id, report, stdout, stderr, exitCode);
      run.exitCode = exitCode;
      run.artifactId = artifactId;
      run.hasScreenshot = hasScreenshot;
      run.summary = summary;
      run.status = classifyRunStatus(spec.id, summary, exitCode, run.cancelled);
      run.error = summary?.error ?? (run.status === 'failed' ? 'Teste falhou.' : null);
    } catch (error) {
      run.exitCode = run.exitCode ?? 1;
      run.status = run.cancelled ? 'cancelled' : 'failed';
      run.error = error.message;
      onLog(`\n[Erro] ${error.message}\n`);
    } finally {
      this.activeChild = null;
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - startedMs;
      const completed = { ...run };
      this.activeRun = null;
      this.history = [completed, ...this.history.filter(item => item.id !== completed.id)].slice(0, MAX_HISTORY);
      await this.saveHistory().catch(() => {});
    }
  }

  async cancel() {
    if (!this.activeRun && !this.activeBatch) {
      return { cancelled: false };
    }
    if (this.activeBatch) {
      this.activeBatch.cancelled = true;
    }
    if (this.activeRun) {
      this.activeRun.cancelled = true;
    }
    const child = this.activeChild;
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { if (!child.killed) child.kill('SIGKILL'); } catch {}
        }, 3000).unref?.();
      } catch {}
    }
    return { cancelled: true, runId: this.activeRun?.id ?? null, batchId: this.activeBatch?.id ?? null };
  }

  async clearHistory() {
    await this.init();
    this.history = [];
    await this.saveHistory();
    return this.state();
  }

  async getScreenshotBuffer(runId) {
    await this.init();
    if (!SAFE_ID_RE.test(String(runId ?? ''))) {
      const err = new Error('Identificador de execução inválido.');
      err.status = 400;
      throw err;
    }
    const found = (this.activeRun?.id === runId ? this.activeRun : null)
      ?? this.history.find(item => item.id === runId);
    if (!found || !found.artifactId || !SAFE_ID_RE.test(found.artifactId)) {
      const err = new Error('Captura de tela não encontrada para esta execução.');
      err.status = 404;
      throw err;
    }
    const imgPath = join(this.artifactsDir, found.artifactId, 'result.png');
    if (!existsSync(imgPath)) {
      const err = new Error('Arquivo de captura não encontrado.');
      err.status = 404;
      throw err;
    }
    return readFile(imgPath);
  }

  async close() {
    if (this.activeChild && !this.activeChild.killed) {
      try { this.activeChild.kill('SIGTERM'); } catch {}
    }
    this.activeChild = null;
  }
}
