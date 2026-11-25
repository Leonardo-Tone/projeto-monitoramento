export function monitorFailure(error) {
  const message = String(error?.message ?? error ?? '').split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]');
  const status = error?.status ?? (Number(/\bHTTP (\d{3})\b/i.exec(message)?.[1]) || null);
  const networkCode = error?.networkCode ?? /\b(?:net::)?(ERR_[A-Z_]+|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b/i.exec(message)?.[1] ?? null;
  let kind = 'READ_ERROR';
  if (error?.blocking || [401, 403, 429, 503].includes(status) ||
      /captcha|login|verificaç[ãa]o|desafio|origem .*divergente/i.test(message)) kind = 'ACCESS';
  else if (error?.code === 'BROWSER_DISCONNECTED' || /target closed|session closed|connection closed|browser disconnected/i.test(message)) kind = 'BROWSER_DISCONNECTED';
  else if (/Runtime\.callFunctionOn timed out|Protocol error.*timed out|protocolTimeout/i.test(message)) kind = 'CHROME_TIMEOUT';
  else if (status) kind = 'HTTP';
  else if (networkCode || /failed to fetch|networkerror|load failed/i.test(message)) kind = 'NETWORK';
  else if (/aborterror|timeout|timed out/i.test(message)) kind = 'REQUEST_TIMEOUT';
  const retryable = ['BROWSER_DISCONNECTED', 'CHROME_TIMEOUT', 'NETWORK', 'REQUEST_TIMEOUT'].includes(kind) ||
    kind === 'HTTP' && [408, 500, 502, 504].includes(status);
  return { kind, status, networkCode, message, retryable };
}

export function trackNetworkFailures(page) {
  const failures = new Map();
  page.on('requestfailed', request => {
    if (!['document', 'fetch', 'xhr'].includes(request.resourceType())) return;
    const code = /^net::(ERR_[A-Z_]+)$/.exec(request.failure()?.errorText ?? '')?.[1];
    if (!code || code === 'ERR_ABORTED') return;
    if (failures.size >= 50) failures.delete(failures.keys().next().value);
    failures.set(request.url(), code);
  });
  return {
    clear: url => failures.delete(url),
    attach(error, url) {
      const code = failures.get(url);
      if (!code) return error;
      return Object.assign(new Error(error.message + ' (' + code + ')', { cause: error }), {
        code: error.code, blocking: error.blocking, status: error.status, networkCode: code,
      });
    },
  };
}

// A collector returns one outcome per product. Only the final attempt leaves
// this function, so observations and purchase eligibility use a single batch.
export function createMonitorRecovery({ store, signal, open, clearPages, onStatus, onDiagnostic, runningMessage }) {
  let browser;
  let restarted = false;
  const disconnected = () => Object.assign(new Error('Chrome de monitoramento desconectado.'), { code: 'BROWSER_DISCONNECTED' });
  const report = (action, failure) => onDiagnostic({ action, ...failure });

  async function replaceBrowser() {
    const previous = browser;
    if (previous) {
      await previous.restart();
      await previous.close();
    }
    clearPages();
    signal.throwIfAborted();
    browser = await open(true);
  }

  return {
    async start() { browser = await open(false); },
    async close() { await browser?.close(); },
    async run(collect) {
      let retriedTab = false;
      let reconnecting = false;
      for (;;) {
        signal.throwIfAborted();
        let results, failure, error;
        try {
          if (!browser.isCurrent()) throw disconnected();
          results = await collect(browser);
          if (!browser.isCurrent()) throw disconnected();
          const failures = results.filter(result => !result.ok).map(result => monitorFailure(result.erro));
          failure = failures.find(item => !item.retryable) ?? failures[0];
        } catch (caught) {
          error = caught;
          failure = monitorFailure(caught);
        }
        signal.throwIfAborted();
        if (!failure) {
          browser.clearFailure(store);
          restarted = false;
          if (reconnecting) {
            report('RECOVERED');
            onStatus('running', runningMessage);
          }
          return results;
        }
        report('READ_FAILED', failure);
        if (!failure.retryable) browser.clearFailure(store);
        const bothFailed = failure.retryable && browser.reportFailure(store);
        const replace = !browser.isCurrent() || bothFailed || failure.kind === 'BROWSER_DISCONNECTED' ||
          retriedTab && failure.kind === 'CHROME_TIMEOUT';
        if (failure.retryable && replace && !restarted) {
          restarted = true;
          reconnecting = true;
          onStatus('reconnecting', 'Reconectando: reiniciando o Chrome compartilhado.');
          report('RESTART_BROWSER', failure);
          try { await replaceBrowser(); }
          catch (caught) {
            signal.throwIfAborted();
            report('RECOVERY_FAILED', monitorFailure(caught));
            throw caught;
          }
          continue;
        }
        if (failure.retryable && !retriedTab && !restarted) {
          retriedTab = true;
          reconnecting = true;
          onStatus('reconnecting', 'Reconectando: reabrindo as abas de monitoramento.');
          report('REOPEN_TABS', failure);
          clearPages();
          await browser.resetPages();
          continue;
        }
        if (reconnecting) {
          report('RETRY_EXHAUSTED', failure);
          onStatus('running', runningMessage);
        }
        if (error) throw error;
        return results;
      }
    },
  };
}
