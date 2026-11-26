import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const execFileAsync = promisify(execFile);

export function compareSemver(a, b) {
  const pa = String(a ?? '0.0.0').replace(/^v/, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = String(b ?? '0.0.0').replace(/^v/, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export function validateTarListing(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('l') || line.startsWith('h')) {
      throw new Error('Atualização bloqueada por segurança: o pacote contém links simbólicos ou hardlinks.');
    }
    const gnuMatch = line.match(/^[a-zA-Z-]{10}\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/);
    const bsdMatch = !gnuMatch ? line.match(/^[a-zA-Z-]{10}\s+\d+\s+\S+\s+\S+\s+\d+\s+(?:\S+\s+\d+|\d+\s+\S+)\s+\S+\s+(.+)$/) : null;
    const entryPath = (gnuMatch?.[1] ?? bsdMatch?.[1] ?? line.split(/\s+/).slice(5).join(' ')).trim();
    if (!entryPath) continue;
    if (entryPath.startsWith('/') || entryPath.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(entryPath)) {
      throw new Error('Atualização bloqueada por segurança: caminho absoluto detectado no pacote.');
    }
    const segments = entryPath.split(/[\\/]+/);
    if (segments.some(seg => seg === '..')) {
      throw new Error('Atualização bloqueada por segurança: caminho fora do diretório de destino (Tar Slip).');
    }
  }
}

export class AutoUpdater {
  constructor({ authClient, targetDirectory, currentVersion, onRestart = null, desktopMode = process.env.VIGIA_DESKTOP === '1', platform = process.platform } = {}) {
    this.authClient = authClient;
    this.targetDirectory = targetDirectory;
    this.currentVersion = currentVersion ?? null;
    this.onRestart = onRestart;
    this.desktopMode = Boolean(desktopMode);
    this.platform = platform;
    this.status = 'idle'; // idle | checking | downloading | installing | restarting | up_to_date | error
    this.availableVersion = null;
    this.notes = '';
    this.error = null;
    this.inFlight = null;
  }

  async resolveCurrentVersion() {
    if (this.currentVersion) return this.currentVersion;
    try {
      const pkg = JSON.parse(await readFile(join(this.targetDirectory, 'package.json'), 'utf8'));
      this.currentVersion = pkg.version || '0.0.0';
    } catch {
      this.currentVersion = '0.0.0';
    }
    return this.currentVersion;
  }

  state() {
    return {
      status: this.status,
      currentVersion: this.currentVersion,
      availableVersion: this.availableVersion,
      notes: this.notes,
      error: this.error,
    };
  }

  async checkAndApply() {
    if (!this.authClient?.authenticated || this.authClient.offlineMode) return false;
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      this.error = null;
      this.status = 'checking';
      const current = await this.resolveCurrentVersion();
      let manifest;
      try {
        manifest = await this.authClient.fetchLatestUpdate();
      } catch (err) {
        this.status = 'error';
        this.error = err.message;
        return false;
      }

      if (!manifest?.available || !manifest.version || compareSemver(manifest.version, current) <= 0) {
        this.status = 'up_to_date';
        return false;
      }

      const safeFilename = basename(String(manifest.filename ?? ''));
      const isExe = safeFilename.endsWith('.exe');
      const isTarGz = safeFilename.endsWith('.tar.gz');
      if (!safeFilename || safeFilename !== manifest.filename || (!isExe && !isTarGz)) {
        this.status = 'error';
        this.error = 'Nome de pacote de atualização inválido.';
        return false;
      }
      if (this.desktopMode && (!isExe || this.platform !== 'win32')) {
        this.status = 'up_to_date';
        return false;
      }
      if (!this.desktopMode && !isTarGz) {
        this.status = 'up_to_date';
        return false;
      }

      this.availableVersion = manifest.version;
      this.notes = manifest.notes || '';
      this.status = 'downloading';

      const tempDir = await mkdtemp(join(tmpdir(), 'vigia-update-'));
      let keepTempForInstaller = false;
      try {
        const buffer = await this.authClient.downloadUpdate(safeFilename);
        const actualHash = createHash('sha256').update(buffer).digest('hex');
        if (actualHash !== String(manifest.sha256).toLowerCase()) {
          throw new Error('Verificação SHA-256 falhou. Atualização abortada por segurança.');
        }

        const archivePath = join(tempDir, safeFilename);
        await writeFile(archivePath, buffer);

        this.status = 'installing';
        if (isExe) {
          keepTempForInstaller = true;
          this.currentVersion = manifest.version;
          this.status = 'restarting';
          if (typeof this.onRestart === 'function') {
            await this.onRestart({ ...manifest, installerPath: archivePath });
          }
          return true;
        }

        const { stdout: listing } = await execFileAsync('tar', ['-tvzf', archivePath], { timeout: 30000 });
        validateTarListing(listing);

        await execFileAsync('tar', [
          '-xzf', archivePath,
          '--exclude=.data',
          '--exclude=.runtime',
          '--exclude=.env',
          '-C', this.targetDirectory,
        ], { timeout: 60000 });

        this.currentVersion = manifest.version;
        this.status = 'restarting';
        if (typeof this.onRestart === 'function') {
          await this.onRestart(manifest);
        }
        return true;
      } catch (err) {
        this.status = 'error';
        this.error = err.message;
        return false;
      } finally {
        if (!keepTempForInstaller) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    })();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }
}
