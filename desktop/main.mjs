import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, safeStorage, shell } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VPS_URL = 'https://meli-gestao-sever.tail1657b1.ts.net:10000';

app.setName('Vigia');
app.setAppUserModelId('com.vigia.monitor');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let mainWindow = null;
let tray = null;
let vigiaApp = null;
let localOrigin = null;
let quitting = false;
let notifiedMinimizeToTray = false;

function getResourcesRoot() {
  return app.isPackaged ? process.resourcesPath : resolve(__dirname, '..');
}

function getIconPath(ext = 'ico') {
  return join(__dirname, 'assets', `icon.${ext}`);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function isAllowedExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function createTokenCodec() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return {
      encrypt(plain) {
        return safeStorage.encryptString(String(plain)).toString('base64');
      },
      decrypt(cipher) {
        return safeStorage.decryptString(Buffer.from(String(cipher), 'base64'));
      },
    };
  } catch {
    return null;
  }
}

function createDesktopNotifier() {
  return async ({ title, message }) => {
    if (!Notification.isSupported()) {
      throw new Error('Notificações nativas do Windows indisponíveis.');
    }
    await new Promise((resolveNotif, rejectNotif) => {
      const notification = new Notification({
        title: String(title ?? 'Vigia').slice(0, 100),
        body: String(message ?? '').slice(0, 350),
        silent: false,
        timeoutType: 'never',
        icon: getIconPath('png'),
      });
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);
        if (error) rejectNotif(error);
        else resolveNotif();
      };
      const fallbackTimer = setTimeout(() => finish(), 1500);
      fallbackTimer.unref?.();
      notification.once('show', () => finish());
      notification.once('failed', () => finish(new Error('Não foi possível exibir a notificação do Windows.')));
      notification.once('click', () => showMainWindow());
      notification.show();
    });
  };
}

async function shutdownVigia() {
  if (quitting) return;
  quitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (vigiaApp) {
    try {
      await vigiaApp.close();
    } catch {}
    vigiaApp = null;
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(getIconPath('png'));
  tray = new Tray(icon.isEmpty() ? getIconPath('ico') : icon);
  tray.setToolTip('Vigia · Monitor de produtos');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir Vigia', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: 'Sair do Vigia',
      click: async () => {
        await shutdownVigia();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => showMainWindow());
  tray.on('click', () => showMainWindow());
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Vigia · Monitor de produtos',
    icon: getIconPath('ico'),
    autoHideMenuBar: true,
    backgroundColor: '#f4f3ef',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  if (app.isPackaged) {
    mainWindow.removeMenu();
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key ?? '').toLowerCase();
      const ctrl = input.control || input.meta;
      const blocked =
        key === 'f12' ||
        key === 'f5' ||
        (ctrl && ['r', 'p', 'u', '=', '+', '-', '0'].includes(key)) ||
        (ctrl && input.shift && ['i', 'j', 'c', 'r'].includes(key)) ||
        (input.alt && ['arrowleft', 'arrowright'].includes(key));
      if (blocked) event.preventDefault();
    });
  }

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.isEditable) {
      items.push(
        { label: 'Recortar', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copiar', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Colar', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: 'Selecionar tudo', role: 'selectAll', enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText?.trim()) {
      items.push({ label: 'Copiar', role: 'copy' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  mainWindow.once('ready-to-show', () => {
    showMainWindow();
  });

  mainWindow.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (!notifiedMinimizeToTray && Notification.isSupported()) {
      notifiedMinimizeToTray = true;
      try {
        new Notification({
          title: 'Vigia continua em segundo plano',
          body: 'O monitoramento segue ativo na bandeja do Windows. Clique no ícone para abrir novamente.',
          silent: true,
          icon: getIconPath('png'),
        }).show();
      } catch {}
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (localOrigin && targetUrl.startsWith(`${localOrigin}/api/auth/start`)) {
      void shell.openExternal(targetUrl);
      return { action: 'deny' };
    }
    if (isAllowedExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (localOrigin && targetUrl.startsWith(`${localOrigin}/api/auth/start`)) {
      event.preventDefault();
      void shell.openExternal(targetUrl);
      return;
    }
    if (localOrigin && targetUrl.startsWith(`${localOrigin}/`)) {
      return;
    }
    event.preventDefault();
    if (isAllowedExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl);
    }
  });

  void mainWindow.loadURL(url);
}

app.on('second-instance', () => {
  showMainWindow();
});

app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
});

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    try {
      if (app.isPackaged) Menu.setApplicationMenu(null);
      process.env.VIGIA_DESKTOP = '1';
      const resourcesRoot = getResourcesRoot();
      const interfaceDir = join(resourcesRoot, 'interface');
      const dataDirectory = join(app.getPath('userData'), 'data');

      const { loadLocalEnv } = await import(pathToFileURL(join(interfaceDir, 'server', 'auth-client.mjs')).href);
      loadLocalEnv(join(dataDirectory, '.env'));
      if (!app.isPackaged) {
        loadLocalEnv(join(interfaceDir, '.env'));
      }

      const vpsUrl = (process.env.VIGIA_VPS_URL ?? '').trim() || DEFAULT_VPS_URL;
      const { createApplication } = await import(pathToFileURL(join(interfaceDir, 'server.mjs')).href);

      const handleUpdateRestart = async manifest => {
        if (!manifest?.installerPath) return;
        await shutdownVigia();
        const child = spawn(manifest.installerPath, ['/S'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();
        app.exit(0);
      };

      vigiaApp = await createApplication({
        dataDirectory,
        root: resourcesRoot,
        vpsUrl,
        desktopMode: true,
        currentVersion: app.getVersion(),
        tokenCodec: createTokenCodec(),
        notifier: createDesktopNotifier(),
        onAuthComplete: () => showMainWindow(),
        onRestart: handleUpdateRestart,
      });

      await new Promise((resolveListen, rejectListen) => {
        vigiaApp.server.once('error', rejectListen);
        vigiaApp.server.listen(0, '127.0.0.1', () => {
          vigiaApp.server.off('error', rejectListen);
          resolveListen();
        });
      });

      const { port } = vigiaApp.server.address();
      localOrigin = `http://127.0.0.1:${port}`;
      createTray();
      createWindow(`${localOrigin}/`);
    } catch (error) {
      dialog.showErrorBox(
        'Vigia · Erro ao iniciar',
        `Não foi possível iniciar o aplicativo Vigia:\n\n${error?.message ?? String(error)}`
      );
      await shutdownVigia();
      app.exit(1);
    }
  });
}
