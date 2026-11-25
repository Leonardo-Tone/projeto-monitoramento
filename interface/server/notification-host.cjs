const { app, Notification, shell } = require('electron');
app.setName('Vigia');
app.setAppUserModelId('com.vigia.monitor');
app.on('window-all-closed', () => {});
let notification, keepAlive;
app.whenReady().then(() => {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(payload.id) || !Notification.isSupported()) throw new Error('unsupported');
    notification = new Notification({ title: String(payload.title).slice(0,100), body: String(payload.message).slice(0,350), silent:false, timeoutType:'never' });
    keepAlive = setInterval(() => {}, 1000);
    notification.once('show', () => process.stdout.write(`ACK ${payload.id}\n`));
    notification.once('failed', () => { process.stdout.write(`ERR ${payload.id}\n`); clearInterval(keepAlive); app.quit(); });
    notification.once('close', () => { clearInterval(keepAlive); app.quit(); });
    notification.once('click', () => {
      // Only the local panel may be opened by notification data.
      try {
        const url = new URL(payload.url);
        if (url.protocol==='http:' && url.hostname==='127.0.0.1' && url.port && url.pathname==='/' && !url.username && !url.password) shell.openExternal(url.href);
      } catch {}
      notification.close();
      clearInterval(keepAlive);app.quit();
    });
    notification.show();
  } catch {
    if (payload?.id && /^[a-zA-Z0-9-]{1,100}$/.test(payload.id)) process.stdout.write(`ERR ${payload.id}\n`);
    app.quit();
  }
});
