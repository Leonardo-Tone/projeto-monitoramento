import {createServer} from 'node:http';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import puppeteer from './puppeteer-headless-runtime/src/puppeteer-runtime.js';

export const raiz = dirname(fileURLToPath(import.meta.url));
export function configuracao(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('node teste-ml-persistente-v3.mjs --minutos 5 [--headful]\nnode teste-ml-persistente-v3.mjs --preparar-perfil\nnode teste-ml-persistente-v3.mjs --self-test');
    process.exit(0);
  }
  const permitidos = new Set(['--minutos', '--headful', '--self-test', '--preparar-perfil']);
  let minutos = 5;
  for (let i = 0; i < argv.length; i++) {
    if (!permitidos.has(argv[i])) throw new Error(`Opcao desconhecida: ${argv[i]}`);
    if (argv[i] === '--minutos') minutos = Number(argv[++i]);
  }
  if (!Number.isFinite(minutos) || minutos <= 0 || minutos > 90) throw new Error('--minutos deve ser maior que zero e no maximo 90.');
  return {minutos, headless: !argv.includes('--headful'), selfTest: argv.includes('--self-test'), prepararPerfil: argv.includes('--preparar-perfil')};
}
export function localizarChrome() {
  return [process.env.ML_CHROME_EXECUTABLE, ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean).map(p => join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'))].find(p => p && existsSync(p));
}
export async function obterPerfil() {
  const userDataDir = join(raiz, 'perfis', 'ml-chrome-headless-v3');
  await mkdir(userDataDir, {recursive:true});
  return {ambiente:'ml-chrome-headless-v3', userDataDir, profileDirectory:'Default'};
}
async function identidade() {
  return {userAgent:navigator.userAgent, platform:navigator.platform, languages:[...navigator.languages],
    userAgentData: await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','uaFullVersion','wow64'])};
}
const referenceCache = new Map();

export async function iniciarIntegracao(options) {
  const server = createServer((req,res) => {
    if (req.url === '/worker.js') {res.setHeader('Content-Type','application/javascript');res.end(`const identidade=${identidade.toString()}; self.onmessage=async()=>self.postMessage(await identidade());`);return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Referencia local</title>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let baseline;
  let browser;
  try {
    const cacheKey = JSON.stringify([options?.executablePath ?? '', options?.headless ?? true]);
    let reference = referenceCache.get(cacheKey);
    if (!reference) {
      console.log("[Integracao] Coletando referencia local...");
      const {userDataDir: _ignoredUserDataDir, ...restOptions} = options ?? {};
      const baselineArgs = (restOptions.args || []).filter(arg => !/^--(?:profile-directory|user-data-dir)(?:=|$)/i.test(String(arg)));
      baseline = await puppeteer.launch({...restOptions, args: baselineArgs, protocolTimeout:15000});
      const page = await baseline.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      reference = {variant:'baseline', browserChoice:'chrome', browser:await baseline.version(), identityAudit:{page:await page.evaluate(identidade)}};
      referenceCache.set(cacheKey, reference);
      console.log("[Integracao] Referencia coletada; encerrando coleta...");
      await baseline.close().catch(() => {}); baseline = null;
    }
    console.log("[Integracao] Iniciando versao integrada...");
    browser = await puppeteer.launch({...options, protocolTimeout:15000, nativeIdentity:{reference,browserChoice:'chrome'}});
    const probe = await browser.newPage();
    await probe.goto(`http://127.0.0.1:${server.address().port}`);
    const atual = await probe.evaluate(identidade);
    if (atual.userAgent.includes('HeadlessChrome') || atual.userAgentData.uaFullVersion !== reference.identityAudit.page.userAgentData.uaFullVersion) throw new Error('Auditoria local da integracao falhou.');
    const worker = await probe.evaluate(() => new Promise((resolve,reject) => {
      const w = new Worker('/worker.js');
      const timer = setTimeout(() => {w.terminate();reject(new Error('Timeout no worker local'));}, 10000);
      w.onmessage = event => {clearTimeout(timer);w.terminate();resolve(event.data);};
      w.onerror = event => {clearTimeout(timer);w.terminate();reject(new Error(event.message));};
      w.postMessage('identity');
    }));
    if (worker.userAgent !== atual.userAgent || JSON.stringify(worker.userAgentData) !== JSON.stringify(atual.userAgentData)) throw new Error('Identidade divergente no worker local.');
    if (!probe.isClosed()) await probe.close().catch(() => {});
    console.log("[Integracao] Auditoria inicial aprovada.");
    return {browser, reference, auditoriaInicial:atual};
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    throw error;
  } finally {
    if (baseline) await baseline.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
