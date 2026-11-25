'use strict';

// Runtime único de Puppeteer para os experimentos.
// Todos os browsers lançados via Puppeteer passam pelo mesmo runtime 24.8.1
// e pelos quatro patches do experimento (addBinding), em vez de misturar
// internals 24.8.1 e 25.11.0 entre módulos.
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';
delete process.env.REBROWSER_PATCHES_DEBUG;

const puppeteer = require('research-puppeteer-runtime');

const RUNTIME_PACKAGE = 'research-puppeteer-runtime@24.8.1';
const DEFAULT_VIEWPORT = Object.freeze({
  width: 1912,
  height: 948,
  deviceScaleFactor: 1,
});
const COMMON_EDGE_ARGS = Object.freeze([
  '--start-maximized',
  '--edge-skip-compat-layer-relaunch',
  '--disable-blink-features=AutomationControlled',
]);

function mergeArgs(args = []) {
  const extras = Array.from(new Set((Array.isArray(args) ? args : []).filter(Boolean).map(String).filter(arg => !/^--headless(?:=|$)/i.test(arg))));
  const startMinimized = extras.includes('--start-minimized');
  const pixelscanPositioned = extras.includes('--research-pixelscan-positioned');
  const primaryPositioned = extras.includes('--research-primary-positioned');
  const common = COMMON_EDGE_ARGS.filter((arg) => {
    if (arg !== '--start-maximized') return true;
    return !(startMinimized || pixelscanPositioned || primaryPositioned);
  });
  return Array.from(new Set([
    ...common,
    ...extras.filter((arg) => !['--research-pixelscan-positioned', '--research-primary-positioned'].includes(arg)),
  ].filter(Boolean).map(String)));
}

function buildLaunchOptions(options = {}) {
  if (options.headless !== undefined && typeof options.headless !== 'boolean') {
    throw new TypeError('headless deve ser true ou false para comparar o mesmo navegador.');
  }
  return {
    headless: false,
    defaultViewport: DEFAULT_VIEWPORT,
    ...options,
    headless: options.headless === undefined ? false : options.headless,
    defaultViewport: options.defaultViewport === undefined ? DEFAULT_VIEWPORT : options.defaultViewport,
    args: mergeArgs(options.args),
  };
}

function launch(options = {}) {
  const {nativeIdentity, ...launchOptions} = options;
  if (nativeIdentity) {
    return require('./native-identity').launchNativeIdentity(puppeteer, buildLaunchOptions(launchOptions), nativeIdentity);
  }
  return puppeteer.launch(buildLaunchOptions(launchOptions));
}

module.exports = {
  ...puppeteer,
  launch,
  buildLaunchOptions,
  mergeArgs,
  COMMON_EDGE_ARGS,
  DEFAULT_VIEWPORT,
  RUNTIME_PACKAGE,
};
