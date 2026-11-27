'use strict';

// Post-measurement inspection only; no worker creation or property replacement.
module.exports = async function auditIdentity(page) {
  return page.evaluate(async () => {
    const userAgentData = navigator.userAgentData
      ? await navigator.userAgentData.getHighEntropyValues([
        'architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'uaFullVersion', 'wow64',
      ]) : null;
    const read = selector => document.querySelector(selector)?.innerText.trim() || null;
    const pageIdentity = {
      userAgent: navigator.userAgent, appVersion: navigator.appVersion,
      platform: navigator.platform, language: navigator.language,
      languages: [...navigator.languages], locale: Intl.DateTimeFormat().resolvedOptions().locale,
      userAgentData,
    };
    const worker = {
      kind: [...document.querySelectorAll('.aside-note-bottom')].map(el => el.innerText.trim()).find(text => /WorkerGlobalScope/.test(text)) || null,
      userAgent: read('[title="WorkerNavigator.userAgent"]'),
      userAgentDataDisplay: read('[title^="WorkerNavigator.userAgentData"]'),
      languageDisplay: read('[title^="WorkerNavigator.language"]'),
    };
    return {
      collectedAfterDetector: true, page: pageIdentity, creepjsWorker: worker,
      pageWorkerUserAgentMatches: worker.userAgent === null ? null : worker.userAgent === pageIdentity.userAgent,
    };
  });
};
