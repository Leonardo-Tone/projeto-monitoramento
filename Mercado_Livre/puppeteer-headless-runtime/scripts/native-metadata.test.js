'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildOverride} = require('./native-metadata');
const sample = () => ({variant: 'baseline', browser: 'Chrome/157.0.8103.39', browserChoice: 'chrome', identityAudit: {page: {
  userAgent: 'Example HeadlessChrome/157.0.0.0', platform: 'Win32', languages: ['pt-BR', 'pt', 'en-US', 'en'],
  userAgentData: {brands: [{brand: 'Google Chrome', version: '157'}], fullVersionList: [{brand: 'Google Chrome', version: '157.0.8103.39'}],
    uaFullVersion: '157.0.8103.39', platform: 'Windows', platformVersion: '19.0.0', architecture: 'x86', bitness: '64', model: '', mobile: false, wow64: false},
}}});
test('preserves native high entropy metadata, language order and false values', () => {
  const ref = sample();
  const result = buildOverride(ref, ref.browser, 'chrome');
  assert.equal(result.userAgent, 'Example Chrome/157.0.0.0');
  assert.equal(result.acceptLanguage, 'pt-BR,pt,en-US,en');
  assert.equal(result.userAgentMetadata.fullVersion, '157.0.8103.39');
  assert.equal(result.userAgentMetadata.platformVersion, '19.0.0');
  assert.equal(result.userAgentMetadata.mobile, false);
  assert.equal(result.userAgentMetadata.wow64, false);
  assert.deepEqual(result.userAgentMetadata.fullVersionList, ref.identityAudit.page.userAgentData.fullVersionList);
  result.userAgentMetadata.brands[0].brand = 'changed';
  assert.equal(ref.identityAudit.page.userAgentData.brands[0].brand, 'Google Chrome');
});
test('rejects references collected with a plugin', () => {
  const ref = sample(); ref.variant = 'stealth-ua-only';
  assert.throws(() => buildOverride(ref, ref.browser, 'chrome'), /baseline/);
});
test('rejects a different browser version or brand', () => {
  const ref = sample();
  assert.throws(() => buildOverride(ref, 'Chrome/158.0.0.0', 'chrome'), /versão/);
  assert.throws(() => buildOverride(ref, ref.browser, 'edge'), /versão/);
});
test('rejects incomplete reference instead of inventing metadata', () => {
  const ref = sample(); delete ref.identityAudit.page.userAgentData.fullVersionList;
  assert.throws(() => buildOverride(ref, ref.browser, 'chrome'), /completos/);
});
