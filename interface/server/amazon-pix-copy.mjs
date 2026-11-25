import { setTimeout as delay } from 'node:timers/promises';
import { parsePixFields, readPixCode, validatePix } from './purchase-html.mjs';

export function validateAmazonPix(code, expectedCents, portalCents) {
  if (portalCents !== expectedCents) throw new Error('O valor exibido no Pix diverge da revisão da Amazon.');
  const fields = readPixCode(code);
  if (fields.get('01') !== '12') return validatePix(code, expectedCents);
  if (fields.get('53') !== '986' || fields.get('58') !== 'BR') throw new Error('Moeda ou país do Pix inválidos.');
  const references = [];
  for (const [id, value] of fields) {
    if (Number(id) < 26 || Number(id) > 51) continue;
    const account = parsePixFields(value);
    if (account.get('00')?.toLowerCase() !== 'br.gov.bcb.pix') continue;
    const location = account.get('25');
    if (!location || /[:\\\s]/.test(location) || !location.includes('/')) throw new Error('Referência do Pix dinâmico inválida.');
    const url = new URL('https://' + location);
    if (url.username || url.password || !url.hostname.includes('.') || url.pathname === '/') throw new Error('Referência do Pix dinâmico inválida.');
    references.push(url);
  }
  if (references.length !== 1) throw new Error('Referência do Pix dinâmico não confirmada.');
  return { code, totalCents: portalCents };
}

// Installed before the portal scripts. During the copy click, capture the
// widget's write in memory so every format in the Windows clipboard survives.
export function installAmazonPixCopy(origin) {
  if (location.origin !== origin || globalThis.__vigiaAmazonPixCopy) return;
  const clipboard = navigator.clipboard && Object.getPrototypeOf(navigator.clipboard);
  let active = null;
  const capture = (state, value) => {
    if (active === state && typeof value === 'string' && value.length <= 2000) state.value = value;
  };
  const originalWriteText = clipboard?.writeText;
  const originalWrite = clipboard?.write;
  const originalExec = Document.prototype.execCommand;
  if (typeof originalWriteText !== 'function' || typeof originalExec !== 'function') return;
  clipboard.writeText = function (value) {
    if (!active) return originalWriteText.call(this, value);
    capture(active, value);
    return Promise.resolve();
  };
  if (typeof originalWrite === 'function') {
    clipboard.write = async function (items) {
      const state = active;
      if (!state) return originalWrite.call(this, items);
      const text = items.find(item => item.types.includes('text/plain'));
      if (text) capture(state, await (await text.getType('text/plain')).text());
    };
  }
  Document.prototype.execCommand = function (command, ...args) {
    if (!active || String(command).toLowerCase() !== 'copy') return originalExec.call(this, command, ...args);
    const element = this.activeElement;
    const selected = typeof element?.value === 'string' && element.selectionStart != null
      ? element.value.slice(element.selectionStart, element.selectionEnd) : String(this.getSelection() ?? '');
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData });
    (element ?? this).dispatchEvent(event);
    capture(active, clipboardData.getData('text/plain') || selected);
    return true;
  };
  globalThis.__vigiaAmazonPixCopy = action => {
    if (action === 'arm') {
      if (active) return false;
      active = { value: null };
      return true;
    }
    if (action === 'read') return active?.value ?? null;
    if (action === 'clear') active = null;
    return null;
  };
}

export async function captureAmazonPix(page, button, { signal, timeoutMs = 2500 } = {}) {
  const control = action => page.evaluate(action => globalThis.__vigiaAmazonPixCopy?.(action), action);
  if (!await control('arm')) throw new Error('Captura local do Pix indisponível nesta página.');
  try {
    signal?.throwIfAborted();
    await button.click();
    const deadline = Date.now() + timeoutMs;
    do {
      signal?.throwIfAborted();
      const code = await control('read');
      if (typeof code === 'string' && code.trim()) return code.trim();
      await delay(100, undefined, { signal });
    } while (Date.now() < deadline);
    return null;
  } finally {
    await control('clear').catch(() => {});
  }
}
