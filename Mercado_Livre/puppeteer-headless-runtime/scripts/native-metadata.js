'use strict';

function buildOverride(reference, actualBrowser, browserChoice) {
  if (reference.variant !== 'baseline' || reference.identityAudit?.error || !reference.identityAudit?.page) {
    throw new Error('A referência deve ser uma coleta baseline válida com auditoria de identidade.');
  }
  if (reference.browser !== actualBrowser || reference.browserChoice !== browserChoice) {
    throw new Error('A referência deve corresponder ao navegador e à versão em execução.');
  }
  const native = reference.identityAudit.page;
  const data = native.userAgentData;
  if (!data || !Array.isArray(data.brands) || !data.brands.length ||
      !Array.isArray(data.fullVersionList) || !data.fullVersionList.length ||
      !data.uaFullVersion || !data.platformVersion || !Array.isArray(native.languages) || !native.languages.length) {
    throw new Error('Referência sem Client Hints completos ou idiomas nativos.');
  }
  const metadata = {};
  for (const key of ['brands', 'fullVersionList', 'platform', 'platformVersion', 'architecture', 'model', 'mobile', 'bitness', 'wow64']) {
    if (data[key] !== undefined) metadata[key] = JSON.parse(JSON.stringify(data[key]));
  }
  metadata.fullVersion = data.uaFullVersion;
  return {
    userAgent: native.userAgent.replace('HeadlessChrome/', 'Chrome/'),
    acceptLanguage: native.languages.join(','),
    platform: native.platform,
    userAgentMetadata: metadata,
  };
}

module.exports = {buildOverride};
