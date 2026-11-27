'use strict';

module.exports = async function collect(page) {
  await page.waitForFunction(() => /\d+% headless/.test(document.body.innerText), {timeout: 90000});
  // Allow async result cards to settle, without clicking or modifying the page.
  await new Promise(resolve => setTimeout(resolve, 5000));
  return page.evaluate(() => {
    const clean = (element, compact = false) => {
      if (!element) return '';
      const copy = element.cloneNode(true);
      copy.querySelectorAll('style,script,input,.modal-container').forEach(el => el.remove());
      copy.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
      const text = copy.textContent.trim();
      return compact ? text.replace(/\s+/g, ' ') : text;
    };
    const ratings = Object.fromEntries(['like-headless', 'headless', 'stealth'].map(name => {
      const text = document.querySelector(`.${name}-rating`)?.innerText || '';
      return [name, /^\s*(\d+)%/.test(text) ? Number(text.match(/(\d+)%/)[1]) : null];
    }));
    const checks = Object.fromEntries(['creep-like-headless', 'creep-headless', 'creep-stealth'].map(name => {
      const text = clean(document.querySelector(`.modal-content[for="toggle-open-${name}"] > div`));
      return [name, Object.fromEntries([...text.matchAll(/^(\w+): (true|false)\s*$/gm)].map(m => [m[1], m[2] === 'true']))];
    }));
    const titles = [...document.querySelectorAll('strong')].map(el => el.textContent.trim());
    const cards = [...document.querySelectorAll('strong')].filter(el => /^(Headless|Lies|Lie Detection|Trash|Error|Errors|Worker|Navigator|WebGL)$/i.test(el.textContent.trim())).map(el => ({title: el.textContent.trim(), text: el.parentElement.innerText})).filter(card => card.text);
    const anomalies = [...document.querySelectorAll('.lies, .lied, .rejected')].map(el => clean(el, true)).filter(Boolean);
    const details = [...document.querySelectorAll('.modal-content')].filter(el => /lie|trash|error|headless|stealth/i.test(el.getAttribute('for') || '')).map(el => ({id: el.getAttribute('for'), text: clean(el.querySelector('div'))}));
    return {collectorRevision: 2, ratings, checks, cards, anomalies, details, titles};
  });
};
