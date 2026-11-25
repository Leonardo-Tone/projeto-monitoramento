'use strict';

// Runtime único de Puppeteer do Agent.
// Todos os browsers lançados via Puppeteer passam pelo mesmo runtime 24.8.1
// e pelos quatro patches do experimento (addBinding), em vez de misturar
// internals 24.8.1 e 25.11.0 entre módulos.
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';
delete process.env.REBROWSER_PATCHES_DEBUG;

const puppeteer = require('cepo-puppeteer-runtime');

const RUNTIME_PACKAGE = 'cepo-puppeteer-runtime@24.8.1';
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
  const pixelscanPositioned = extras.includes('--cepo-pixelscan-positioned');
  const primaryPositioned = extras.includes('--cepo-primary-positioned');
  const common = COMMON_EDGE_ARGS.filter((arg) => {
    if (arg !== '--start-maximized') return true;
    return !(startMinimized || pixelscanPositioned || primaryPositioned);
  });
  return Array.from(new Set([
    ...common,
    ...extras.filter((arg) => !['--cepo-pixelscan-positioned', '--cepo-primary-positioned'].includes(arg)),
  ].filter(Boolean).map(String)));
}

function buildLaunchOptions(options = {}) {
  return {
    headless: false,
    defaultViewport: DEFAULT_VIEWPORT,
    ...options,
    headless: false, // O CEPO usa sempre o navegador normal, nas coordenadas configuradas.
    defaultViewport: options.defaultViewport === undefined ? DEFAULT_VIEWPORT : options.defaultViewport,
    args: mergeArgs(options.args),
  };
}

function launch(options = {}) {
  return puppeteer.launch(buildLaunchOptions(options));
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
