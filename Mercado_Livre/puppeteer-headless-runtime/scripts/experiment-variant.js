'use strict';
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const runtime = require('../src/puppeteer-runtime');

module.exports = function variant(name) {
  if (name === 'baseline') return { launcher: runtime, packages: {}, evasions: [] };
  if (name === 'vigia-headless') {
    return {
      launcher: {
        launch: async options => {
          const integracaoPath = path.resolve(__dirname, '../../integracao-native.mjs');
          const { iniciarIntegracao } = await import(pathToFileURL(integracaoPath).href);
          const { browser } = await iniciarIntegracao(options);
          return browser;
        },
      },
      packages: {},
      evasions: [],
      nativeReference: { mode: 'vigia-iniciarIntegracao' },
    };
  }
  if (name !== 'native-integrated') throw new Error('Variante de diagnóstico desconhecida.');
  const contents = readFileSync(process.env.RESEARCH_NATIVE_REFERENCE);
  const reference = JSON.parse(contents);
  return {
    launcher: {
      launch: options => runtime.launch({
        ...options, nativeIdentity: { reference, browserChoice: reference.browserChoice },
      }),
    },
    packages: {},
    evasions: [],
    nativeReference: { id: reference.id, sha256: createHash('sha256').update(contents).digest('hex') },
  };
};
