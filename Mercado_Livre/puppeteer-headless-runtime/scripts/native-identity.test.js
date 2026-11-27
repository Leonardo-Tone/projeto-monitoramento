'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {launchNativeIdentity} = require('../src/native-identity');

const reference = () => ({variant: 'baseline', browser: 'Chrome/157.0.8103.39', browserChoice: 'chrome', identityAudit: {page: {
  userAgent: 'Example HeadlessChrome/157.0.0.0', platform: 'Win32', languages: ['pt-BR', 'en'],
  userAgentData: {brands: [{brand: 'Google Chrome', version: '157'}], fullVersionList: [{brand: 'Google Chrome', version: '157.0.8103.39'}],
    uaFullVersion: '157.0.8103.39', platform: 'Windows', platformVersion: '19.0.0', architecture: 'x86', bitness: '64', model: '', mobile: false},
}}});

function fixture({version = 'Chrome/157.0.8103.39', fail = false, protocolError = 'fixture protocol failure'} = {}) {
  const connection = new EventEmitter();
  const calls = [];
  const session = {id: () => 'fixture-session', detached: false, connection: () => connection,
    send: async method => { calls.push(method); if (fail && method === 'Emulation.setUserAgentOverride') throw new Error(protocolError); }};
  const parentSession = {send: async (method, params) => {
    calls.push([method, params]);
    connection.emit('sessiondetached', session);
  }};
  const browser = new EventEmitter();
  browser.version = async () => version;
  browser.close = async () => { browser.closed = true; browser.emit('disconnected'); };
  return {browser, calls, session, parentSession, connection, puppeteer: {launch: async options => {
    browser.launchOptions = options;
    const initializer = options.targetFilter[Symbol.for('research.nativeTargetInitializer')];
    try { browser.initialization = await initializer({session, parentSession, targetInfo: {type: 'service_worker', targetId: 'fixture-target', url: 'http://fixture/one/service.js'}, waitingForDebugger: true}); }
    catch { /* TargetManager catches initializer rejection and cleans up. */ }
    return browser;
  }}};
}

test('launches with native identity, retains worker session and releases through its parent', async () => {
  const f = fixture();
  const browser = await launchNativeIdentity(f.puppeteer, {args: ['--fixture'], targetFilter: target => target.allowed},
    {reference: reference(), browserChoice: 'chrome'});
  assert.deepEqual(browser.launchOptions.args, ['--fixture', '--user-agent=Example Chrome/157.0.0.0']);
  assert.equal(browser.launchOptions.targetFilter({allowed: false}), false);
  assert.equal(browser.initialization.retainSession, true);
  assert.equal(browser.nativeIdentity.snapshot().activeWorkerSessions, 1);
  const released = await browser.nativeIdentity.releaseWorkers();
  assert.deepEqual(released, [{type: 'service_worker', released: true}]);
  assert.equal(browser.nativeIdentity.snapshot().activeWorkerSessions, 0);
  assert.deepEqual(f.calls.at(-1), ['Target.detachFromTarget', {sessionId: 'fixture-session'}]);
  await browser.close();
  assert.equal(f.connection.listenerCount('sessiondetached'), 0);
});

test('never returns a usable browser after an initialization failure', async () => {
  const f = fixture({fail: true});
  await assert.rejects(launchNativeIdentity(f.puppeteer, {}, {reference: reference(), browserChoice: 'chrome'}), /Falha/);
  assert.equal(f.browser.closed, true);
  assert.equal(f.connection.listenerCount('sessiondetached'), 0);
});

test('closes a browser whose actual version differs from the reference', async () => {
  const f = fixture({version: 'Chrome/158.0.0.0'});
  await assert.rejects(launchNativeIdentity(f.puppeteer, {}, {reference: reference(), browserChoice: 'chrome'}), /versão/);
  assert.equal(f.browser.closed, true);
});

test('rejects conflicting user agent flags before launching', async () => {
  let launched = false;
  await assert.rejects(launchNativeIdentity({launch: async () => { launched = true; }}, {args: ['--user-agent=other']},
    {reference: reference(), browserChoice: 'chrome'}), /próprio/);
  assert.equal(launched, false);
});

test('ordinary target closure cancels initialization without closing the browser', async () => {
  const f = fixture({fail: true, protocolError: 'Protocol error (Emulation.setUserAgentOverride): Target closed'});
  const browser = await launchNativeIdentity(f.puppeteer, {}, {reference: reference(), browserChoice: 'chrome'});
  assert.equal(browser.closed, undefined);
  assert.equal(browser.initialization.cancelled, true);
  assert.equal(browser.nativeIdentity.snapshot().errors.length, 0);
  assert.equal(browser.nativeIdentity.snapshot().cancelledInitializations, 1);
  assert.equal(browser.nativeIdentity.snapshot().activeWorkerSessions, 0);
  await browser.close();
});

test('scoped release leaves an unrelated live worker configured', async () => {
  const f = fixture();
  const browser = await launchNativeIdentity(f.puppeteer, {}, {reference: reference(), browserChoice: 'chrome'});
  const second = {...f.session, id: () => 'second-session'};
  const parent = {send: async () => f.connection.emit('sessiondetached', second)};
  await browser.launchOptions.targetFilter[Symbol.for('research.nativeTargetInitializer')]({
    session: second, parentSession: parent, targetInfo: {type: 'shared_worker', targetId: 'second-target', url: 'http://fixture/two/shared.js'}, waitingForDebugger: true,
  });
  const released = await browser.nativeIdentity.releaseWorkers({urlPrefix: 'http://fixture/one/'});
  assert.equal(released.length, 1);
  assert.equal(browser.nativeIdentity.snapshot().activeWorkerSessions, 1);
  await assert.rejects(browser.nativeIdentity.releaseWorkers({}), /Filtro/);
  await assert.rejects(browser.nativeIdentity.releaseWorkers({urlPrefix: ''}), /Filtro/);
  assert.equal(browser.nativeIdentity.snapshot().activeWorkerSessions, 1);
  await browser.nativeIdentity.releaseWorkers({url: 'http://fixture/two/shared.js'});
  assert.equal(browser.nativeIdentity.snapshot().activeWorkerSessions, 0);
  await browser.close();
});

test('cleanup tracks a target URL supplied after attachment', async () => {
  const f = fixture();
  const browser = await launchNativeIdentity(f.puppeteer, {}, {reference: reference(), browserChoice: 'chrome'});
  f.connection.emit('Target.targetInfoChanged', {targetInfo: {targetId: 'fixture-target', url: 'http://fixture/updated/service.js'}});
  assert.deepEqual(await browser.nativeIdentity.releaseWorkers({urlPrefix: 'http://fixture/one/'}), []);
  assert.equal((await browser.nativeIdentity.releaseWorkers({urlPrefix: 'http://fixture/updated/'})).length, 1);
  await browser.close();
  assert.equal(f.connection.listenerCount('Target.targetInfoChanged'), 0);
});

test('cleanup succeeds when its target disappears before the detach acknowledgement', async () => {
  const f = fixture();
  const browser = await launchNativeIdentity(f.puppeteer, {}, {reference: reference(), browserChoice: 'chrome'});
  f.parentSession.send = async () => { throw new Error('Protocol error (Target.detachFromTarget): No session with given id'); };
  assert.deepEqual(await browser.nativeIdentity.releaseWorkers(), [{type: 'service_worker', released: true, alreadyClosed: true}]);
  assert.equal(browser.nativeIdentity.snapshot().activeWorkerSessions, 0);
  await browser.close();
});

test('cleanup still reports genuine detach failures', async () => {
  const f = fixture();
  const browser = await launchNativeIdentity(f.puppeteer, {}, {reference: reference(), browserChoice: 'chrome'});
  f.parentSession.send = async () => { throw new Error('fixture transport failure'); };
  const results = await browser.nativeIdentity.releaseWorkers();
  assert.equal(results[0].released, false);
  assert.equal(results[0].error, 'fixture transport failure');
  assert.equal(browser.nativeIdentity.snapshot().activeWorkerSessions, 1);
  await browser.close();
});
