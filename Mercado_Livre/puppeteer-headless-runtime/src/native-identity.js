'use strict';

const {buildOverride} = require('../scripts/native-metadata');
const INITIALIZER = Symbol.for('research.nativeTargetInitializer');
const WORKERS = new Set(['worker', 'shared_worker', 'service_worker']);
const TARGETS = new Set(['page', 'iframe', ...WORKERS]);

async function launchNativeIdentity(puppeteer, options, configuration) {
  const {reference, browserChoice = 'chrome'} = configuration;
  const override = buildOverride(reference, reference.browser, browserChoice);
  if ((options.args || []).some(arg => /^--user-agent(?:=|$)/.test(arg))) {
    throw new Error('nativeIdentity gerencia seu próprio argumento de user agent.');
  }
  const events = [];
  const sessions = new Map();
  const connections = new Map();
  let browser;
  let closing = false;
  const filter = options.targetFilter;
  const targetFilter = target => filter ? filter(target) : true;
  Object.defineProperty(targetFilter, INITIALIZER, {value: async ({session, parentSession, targetInfo, waitingForDebugger}) => {
    if (!TARGETS.has(targetInfo.type)) return;
    const event = {type: targetInfo.type, waitingForDebugger, startedAt: new Date().toISOString()};
    events.push(event);
    const connection = session.connection();
    if (!connections.has(connection)) {
      const detached = targetSession => sessions.delete(targetSession.id());
      const changed = ({targetInfo: info}) => {
        for (const item of sessions.values()) if (item.targetId === info.targetId) item.url = info.url;
      };
      connection.on('sessiondetached', detached);
      connection.on('Target.targetInfoChanged', changed);
      connections.set(connection, {detached, changed});
    }
    sessions.set(session.id(), {session, parentSession, type: targetInfo.type, targetId: targetInfo.targetId, url: targetInfo.url || ''});
    try {
      const configured = session.send('Emulation.setUserAgentOverride', override, {timeout: 10000});
      // Service-worker inspector initialization can depend on releasing the
      // browser-side startup gate. Queue configuration first, then release it.
      const resumed = session.send('Runtime.runIfWaitingForDebugger');
      await Promise.all([configured, resumed]);
      event.status = 'configured';
      return {retainSession: WORKERS.has(targetInfo.type)};
    } catch (error) {
      if (session.detached || /Target closed|Session closed|No (?:target|session) with given id/i.test(error.message)) {
        event.status = 'cancelled'; event.error = error.message;
        sessions.delete(session.id());
        return {cancelled: true};
      }
      event.status = 'error'; event.error = error.message;
      // Never silently return an apparently successful measurement after an
      // initializer failure. TargetManager handles detachment without rejection.
      if (browser && !closing) {
        closing = true;
        void browser.close().catch(() => {});
      }
      throw error;
    } finally { event.finishedAt = new Date().toISOString(); }
  }});
  function snapshot() {
    return {
      mode: 'Puppeteer TargetManager initializer',
      events: events.map(event => ({...event})),
      activeWorkerSessions: [...sessions.values()].filter(value => WORKERS.has(value.type)).length,
      activeWorkers: [...sessions.values()].filter(value => WORKERS.has(value.type)).map(value => ({type: value.type, url: value.url})),
      cancelledInitializations: events.filter(event => event.status === 'cancelled').length,
      errors: events.filter(event => event.status === 'error').map(event => ({...event})),
    };
  }
  try {
    browser = await puppeteer.launch({...options, targetFilter,
      args: [...(options.args || []), `--user-agent=${override.userAgent}`]});
    buildOverride(reference, await browser.version(), browserChoice);
    if (snapshot().errors.length) throw new Error('Falha na inicialização nativa de um alvo.');
    Object.defineProperty(browser, 'nativeIdentity', {value: {
      snapshot,
      async releaseWorkers(filter) {
        if (filter !== undefined && (!filter || typeof filter !== 'object' ||
            !Object.keys(filter).length || Object.keys(filter).some(key => !['urlPrefix', 'url'].includes(key)) ||
            Object.values(filter).some(value => typeof value !== 'string' || !value))) {
          throw new Error('Filtro de liberação deve conter urlPrefix ou url não vazios.');
        }
        const outcomes = [];
        for (const [id, item] of [...sessions]) {
          if (!WORKERS.has(item.type) || item.session.detached) continue;
          if (filter?.urlPrefix && !item.url.startsWith(filter.urlPrefix)) continue;
          if (filter?.url && item.url !== filter.url) continue;
          try {
            await item.parentSession.send('Target.detachFromTarget', {sessionId: id});
            sessions.delete(id);
            outcomes.push({type: item.type, released: true});
          } catch (error) {
            if (item.session.detached || /Target closed|Session closed|No (?:target|session) with given id/i.test(error.message)) {
              sessions.delete(id);
              outcomes.push({type: item.type, released: true, alreadyClosed: true});
            } else outcomes.push({type: item.type, released: false, error: error.message});
          }
        }
        return outcomes;
      },
    }});
    browser.once('disconnected', () => {
      for (const [connection, listeners] of connections) {
        connection.off('sessiondetached', listeners.detached);
        connection.off('Target.targetInfoChanged', listeners.changed);
      }
      connections.clear(); sessions.clear();
    });
    return browser;
  } catch (error) {
    for (const [connection, listeners] of connections) {
      connection.off('sessiondetached', listeners.detached);
      connection.off('Target.targetInfoChanged', listeners.changed);
    }
    if (browser) await browser.close().catch(() => {});
    throw error;
  }
}

module.exports = {launchNativeIdentity};
