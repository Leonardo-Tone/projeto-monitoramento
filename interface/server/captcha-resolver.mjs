import { randomUUID } from 'node:crypto';
import { launchProfile, releaseProfile } from './profiles.mjs';

export function isCaptchaError(error) {
  if (!error) return false;
  const msg = String(error?.message ?? error?.error ?? error ?? '');
  const code = String(error?.code ?? '');
  return code === 'CAPTCHA' ||
    /captcha|robot check|captchacharacters|validateCaptcha|desafio de acesso|valida[çc][aã]o contra rob[ôo]s|verifica[çc][aã]o de acesso/i.test(msg);
}

export function isCaptchaPage(url = '', html = '') {
  const parsed = String(url ?? '');
  const body = String(html ?? '');
  return /captcha|challenge|account-verification|\/errors\/validateCaptcha/i.test(parsed) ||
    /<title[^>]*>[^<]*(?:captcha|robot check|verifica|challenge)/i.test(body) ||
    /id=["']captchacharacters["']/i.test(body) ||
    /<(?:iframe|div)\b[^>]*(?:g-recaptcha|h-captcha|src=["'][^"']*(?:recaptcha|hcaptcha))/i.test(body);
}

export async function revealCaptchaPage(page) {
  let client, restored = false, focused = false;
  try {
    client = await page.target().createCDPSession();
    const { windowId } = await client.send('Browser.getWindowForTarget');
    if (windowId != null) {
      await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await client.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 40, width: 1100, height: 760 } });
      restored = true;
    }
  } catch {} finally {
    if (client) await client.detach().catch(() => {});
  }
  try { await page.bringToFront(); focused = true; } catch {}
  try { await page.evaluate(() => { window.focus(); }); } catch {}
  return { restored, focused };
}

export async function openProductCaptcha({
  projectRoot,
  dataDirectory,
  product,
  signal,
  launcher = launchProfile,
  releaser = () => releaseProfile(projectRoot, dataDirectory, product.store, 'monitor'),
  notify = async () => {},
  inspect = isCaptchaPage,
  bringToFront = revealCaptchaPage,
  pollIntervalMs = 1000,
}) {
  if (signal?.aborted) return;
  // 1. Libera qualquer instância headless do perfil compartilhado de monitoramento
  await releaser().catch(() => {});
  if (signal?.aborted) return;

  // 2. Abre o navegador headful (visível) no perfil da loja
  const { browser } = await launcher({
    projectRoot,
    dataDirectory,
    store: product.store,
    purpose: 'monitor',
    headless: false,
  });

  try {
    const page = await browser.newPage();
    const targetUrl = product.url;

    // 3. Navega diretamente para o produto que gerou o captcha
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    // 4. Traz a janela para frente da tela do usuário
    await bringToFront(page).catch(() => {});

    // 5. Notifica o usuário no sistema operacional
    await notify({
      id: randomUUID(),
      title: 'Vigia · CAPTCHA detectado',
      message: `Resolva o CAPTCHA de ${product.name || product.code} na janela aberta para continuar o monitoramento.`
    }).catch(() => {});

    // 6. Aguarda o usuário resolver o captcha ou fechar o navegador
    let cleanStreak = 0;
    while (!signal?.aborted) {
      if (page.isClosed()) break;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      if (page.isClosed() || signal?.aborted) break;

      try {
        const url = page.url();
        const html = await page.content().catch(() => '');
        const challenge = inspect(url, html);

        if (!challenge && /^(https?:\/\/)/i.test(url)) {
          cleanStreak++;
          if (cleanStreak >= 2) {
            // Captcha resolvido com sucesso!
            await notify({
              id: randomUUID(),
              title: 'Vigia · CAPTCHA resolvido',
              message: `Verificação concluída para ${product.name || product.code}. Retomando monitoramento.`
            }).catch(() => {});
            // Aguarda 2 segundos para gravação dos cookies no disco
            await new Promise(resolve => setTimeout(resolve, 2000));
            break;
          }
        } else {
          cleanStreak = 0;
        }
      } catch {
        break;
      }
    }
  } finally {
    // 7. Encerra o navegador headful para liberar o perfil ao monitor
    await browser.close().catch(() => {});
  }
}
