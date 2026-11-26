import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from './env.mjs';
import { openDatabase } from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(__dirname, '.env'));

const dbPath = process.env.DB_PATH ? resolve(__dirname, process.env.DB_PATH) : join(__dirname, 'data', 'vigia-vps.sqlite');
const releasesDir = process.env.RELEASES_DIR ? resolve(__dirname, process.env.RELEASES_DIR) : join(__dirname, 'releases');
const db = openDatabase(dbPath);

const [command, arg1, arg2, ...rest] = process.argv.slice(2);

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function writeManifest({ version, filename, sha256, notes, format }) {
  mkdirSync(releasesDir, { recursive: true });
  const manifest = {
    version,
    filename,
    format: format || (filename.endsWith('.exe') ? 'exe' : 'tar.gz'),
    sha256,
    notes: notes || '',
    publishedAt: new Date().toISOString(),
  };
  writeFileSync(join(releasesDir, 'latest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

try {
  if (command === 'list') {
    const rows = db.listAllowedEmails();
    if (!rows.length) {
      console.log('Nenhum e-mail autorizado cadastrado.');
    } else {
      console.table(rows.map(r => ({
        email: r.email,
        papel: r.role,
        nome: r.name || '-',
        ultimoLogin: r.lastLoginAt || 'nunca',
        nota: r.note || '',
      })));
    }
  } else if (command === 'add') {
    const email = arg1;
    const roleOrNote = arg2;
    if (!email) throw new Error('Uso: node cli.mjs add <email@gmail.com> [user|admin] [nota]');
    const isRole = roleOrNote === 'admin' || roleOrNote === 'user';
    const role = isRole ? roleOrNote : 'user';
    const note = isRole ? rest.join(' ') : [roleOrNote, ...rest].filter(Boolean).join(' ');
    const entry = db.addAllowedEmail(email, { role, note, addedBy: 'cli' });
    console.log(`Autorizado: ${entry.email} (${entry.role})`);
  } else if (command === 'remove') {
    const email = arg1;
    if (!email) throw new Error('Uso: node cli.mjs remove <email@gmail.com>');
    const removed = db.removeAllowedEmail(email);
    console.log(removed ? `Removido e sessões revogadas: ${email}` : `E-mail não encontrado: ${email}`);
  } else if (command === 'publish') {
    const version = arg1;
    const archivePath = arg2;
    const notes = rest.join(' ');
    if (!version || !archivePath) throw new Error('Uso: node cli.mjs publish <versao> <caminho.exe|caminho.tar.gz> [notas]');
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Versão inválida. Use o formato X.Y.Z (ex.: 0.12.0).');
    const resolvedSrc = resolve(archivePath);
    const isExe = resolvedSrc.toLowerCase().endsWith('.exe');
    const isTarGz = resolvedSrc.toLowerCase().endsWith('.tar.gz');
    if (!isExe && !isTarGz) throw new Error('Formato não suportado. Informe um instalador .exe ou pacote .tar.gz.');
    mkdirSync(releasesDir, { recursive: true });
    const filename = isExe ? `Vigia-Setup-${version}.exe` : `vigia-${version}.tar.gz`;
    const dest = join(releasesDir, filename);
    copyFileSync(resolvedSrc, dest);
    const sha256 = sha256File(dest);
    const manifest = writeManifest({ version, filename, sha256, notes, format: isExe ? 'exe' : 'tar.gz' });
    console.log(`Atualização publicada: v${manifest.version} (${filename})`);
    console.log(`SHA-256: ${manifest.sha256}`);
  } else if (command === 'pack') {
    const version = arg1;
    const notes = [arg2, ...rest].filter(Boolean).join(' ');
    if (!version) throw new Error('Uso: node cli.mjs pack <versao> [notas]');
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Versão inválida. Use o formato X.Y.Z (ex.: 0.12.0).');
    const interfaceDir = resolve(__dirname, '..', 'interface');
    mkdirSync(releasesDir, { recursive: true });
    const filename = `vigia-${version}.tar.gz`;
    const dest = join(releasesDir, filename);
    execFileSync('tar', [
      '-czf', dest,
      '--exclude=.data',
      '--exclude=.runtime',
      '--exclude=.env',
      '--exclude=node_modules',
      '-C', interfaceDir,
      '.',
    ]);
    const sha256 = sha256File(dest);
    const manifest = writeManifest({ version, filename, sha256, notes });
    console.log(`Pacote gerado e publicado: v${manifest.version} (${dest})`);
    console.log(`SHA-256: ${manifest.sha256}`);
  } else {
    console.log('Comandos disponíveis:');
    console.log('  node cli.mjs list');
    console.log('  node cli.mjs add <email@gmail.com> [user|admin] [nota]');
    console.log('  node cli.mjs remove <email@gmail.com>');
    console.log('  node cli.mjs pack <versao> [notas]');
    console.log('  node cli.mjs publish <versao> <arquivo.tar.gz> [notas]');
  }
} catch (err) {
  console.error('Erro:', err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
