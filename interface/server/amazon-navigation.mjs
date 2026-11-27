const origin = 'https://www.amazon.com.br';
const continueForm = /<form\b[^>]*\saction\s*=\s*["']\/errors_page\/validate["'][^>]*>/i;
const continueButton = 'form[action="/errors_page/validate"][method="get" i] button[type="submit"][alt="Continuar comprando"]:enabled';
const isAmazonUrl = url => URL.canParse(url) && new URL(url).origin === origin;
const readPage = page => page.content();

export function isAmazonShoppingWall(url, html) {
  return isAmazonUrl(url) &&
    continueForm.test(html) && /Clique no botão abaixo para continuar comprando/i.test(html);
}

function amazonShoppingWallError() {
  return Object.assign(new Error('A Amazon manteve a página “Continuar comprando” e exige verificação manual.'), {
    code: 'CAPTCHA',
  });
}

export async function continueAmazonShopping(page, { timeout, signal, readHtml = readPage, html } = {}) {
  const current = page.url();
  if (!isAmazonUrl(current)) return null;
  if (!isAmazonShoppingWall(current, html ?? await readHtml(page))) return null;
  signal?.throwIfAborted();
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout, signal }),
    page.click(continueButton),
  ]);
  signal?.throwIfAborted();
  if (isAmazonUrl(page.url()) && isAmazonShoppingWall(page.url(), await readHtml(page))) throw amazonShoppingWallError();
  return { response };
}

export async function gotoAmazonPage(page, url, { timeout, signal, readHtml = readPage } = {}) {
  const options = { waitUntil: 'domcontentloaded', timeout };
  signal?.throwIfAborted();
  const response = await page.goto(url, options);
  const continued = await continueAmazonShopping(page, { timeout, signal, readHtml });
  if (!continued) return response;
  if (continued.response?.status() !== 200 || page.url() === url || !isAmazonUrl(page.url())) {
    return continued.response;
  }
  const retried = await page.goto(url, options);
  if (isAmazonUrl(page.url()) && isAmazonShoppingWall(page.url(), await readHtml(page))) throw amazonShoppingWallError();
  return retried;
}
