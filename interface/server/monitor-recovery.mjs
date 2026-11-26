export function monitorFailure(error) {
  const message = String(error?.message ?? error ?? '').split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]');
  const status = error?.status ?? (Number(/\bHTTP (\d{3})\b/i.exec(message)?.[1]) || null);
  const networkCode = error?.networkCode ?? /\b(?:net::)?(ERR_[A-Z_]+|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b/i.exec(message)?.[1] ?? null;
  let kind = 'READ_ERROR';
  if (error?.blocking || [401, 403, 429, 503].includes(status) ||
      /captcha|login|verificaç[ãa]o|desafio|origem .*divergente/i.test(message)) kind = 'ACCESS';
  else if (error?.code === 'BROWSER_DISCONNECTED' || /target closed|session closed|connection closed|browser disconnected|session with given id not found|target with given id not found/i.test(message)) kind = 'BROWSER_DISCONNECTED';
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

function isProductLevelFailure(failure) {
  if (!failure) return false;
  if (failure.kind === 'HTTP' && failure.status === 404) return true;
  if (/origem .*divergente/i.test(failure.message)) return true;
  return false;
}

function waitAbortable(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Operação cancelada.'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Operação cancelada.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withCycleWatchdog(task, timeoutMs, signal) {
  if (!timeoutMs || timeoutMs <= 0) return task();
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => done(reject, signal.reason ?? new Error('Operação cancelada.'));
    const timer = setTimeout(() => {
      done(reject, Object.assign(new Error(`Protocol error: ciclo excedeu ${timeoutMs} ms (protocolTimeout).`), { code: 'CHROME_TIMEOUT' }));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(task).then(val => done(resolve, val), err => done(reject, err));
  });
}

// A collector returns one outcome per product. Only the final attempt leaves
// this function, so observations and purchase eligibility use a single batch.
export function createMonitorRecovery({
  store,
  signal,
  open,
  clearPages,
  onStatus,
  onDiagnostic,
  runningMessage,
  retryDelayMs = 1500,
  restartDelayMs = 3000,
  restartCooldownMs = 60_000,
  cycleTimeoutMs = 90_000,
  maxRecoveryAttempts = 3,
}) {
  let browser;
  let lastRestartAt = null;
  let consecutiveFailures = 0;
  let reconnections = 0;
  const disconnected = () => Object.assign(new Error('Chrome de monitoramento desconectado.'), { code: 'BROWSER_DISCONNECTED' });
  const inRestartCooldown = () => lastRestartAt !== null && Date.now() - lastRestartAt < restartCooldownMs;
  const report = (action, failure) => onDiagnostic({ action, consecutiveFailures, reconnections, ...failure });

  async function replaceBrowser() {
    const previous = browser;
    if (previous) {
      await previous.restart?.();
      await previous.close?.();
      browser = null;
    }
    clearPages();
    for (let attempt = 1; attempt <= maxRecoveryAttempts; attempt++) {
      signal.throwIfAborted();
      try {
        browser = await open(true);
        return;
      } catch (caught) {
        signal.throwIfAborted();
        if (attempt >= maxRecoveryAttempts) throw caught;
        report('RECOVERY_RETRY', monitorFailure(caught));
        await waitAbortable(restartDelayMs * attempt, signal);
      }
    }
  }

  return {
    async start() { browser = await open(false); },
    async close() { await browser?.close?.(); },
    async run(collect) {
      let retriedTab = false;
      let reconnecting = false;
      for (;;) {
        signal.throwIfAborted();
        let results, failure, error;
        try {
          if (!browser || !browser.isCurrent()) throw disconnected();
          results = await withCycleWatchdog(() => collect(browser), cycleTimeoutMs, signal);
          if (!browser || !browser.isCurrent()) throw disconnected();
          const list = Array.isArray(results) ? results : [];
          const failures = list
            .filter(result => result && !result.ok)
            .map(result => monitorFailure(result.erro))
            .filter(item => !isProductLevelFailure(item));
          failure = failures.find(item => !item.retryable) ?? failures[0];
        } catch (caught) {
          error = caught;
          failure = monitorFailure(caught);
        }
        signal.throwIfAborted();
        if (!failure) {
          browser.clearFailure?.(store);
          lastRestartAt = null;
          consecutiveFailures = 0;
          if (reconnecting) {
            reconnections++;
            report('RECOVERED');
            onStatus('running', runningMessage);
          }
          return results;
        }
        consecutiveFailures++;
        report('READ_FAILED', failure);
        if (!failure.retryable) browser?.clearFailure?.(store);
        const bothFailed = failure.retryable && browser?.reportFailure?.(store);
        const replace = !browser || !browser.isCurrent() || bothFailed || failure.kind === 'BROWSER_DISCONNECTED' ||
          retriedTab && failure.kind === 'CHROME_TIMEOUT';
        if (failure.retryable && replace && !inRestartCooldown()) {
          lastRestartAt = Date.now();
          reconnecting = true;
          onStatus('reconnecting', 'Reconectando: reiniciando o Chrome compartilhado.');
          report('RESTART_BROWSER', failure);
          try {
            await replaceBrowser();
          } catch (caught) {
            signal.throwIfAborted();
            report('RECOVERY_FAILED', monitorFailure(caught));
            throw caught;
          }
          continue;
        }
        if (failure.retryable && !retriedTab && !inRestartCooldown()) {
          retriedTab = true;
          reconnecting = true;
          onStatus('reconnecting', 'Reconectando: reabrindo as abas de monitoramento.');
          report('REOPEN_TABS', failure);
          clearPages();
          await browser.resetPages?.();
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
