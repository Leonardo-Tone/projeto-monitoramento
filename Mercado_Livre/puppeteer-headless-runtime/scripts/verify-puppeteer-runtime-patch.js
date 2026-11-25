'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AGENT_ROOT = path.resolve(__dirname, '..');
const PATCH_ROOT = path.join(AGENT_ROOT, 'patches', 'puppeteer-runtime-24.8.1');
const PACKAGE_ROOT = path.join(AGENT_ROOT, 'node_modules', 'research-puppeteer-runtime');
const manifest = JSON.parse(fs.readFileSync(path.join(PATCH_ROOT, 'patch-manifest.json'), 'utf8'));

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

if (manifest.baseVersion !== '24.8.1' || manifest.runtimeFixMode !== 'addBinding') {
  throw new Error('Patch manifest incompatível com o runtime esperado.');
}

const pkgPath = path.join(PACKAGE_ROOT, 'package.json');
if (!fs.existsSync(pkgPath)) throw new Error('research-puppeteer-runtime não está instalado.');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.version !== '24.8.1') throw new Error(`Versão inesperada do runtime: ${pkg.version}`);

const mismatches = [];
for (const relativePath of manifest.changedFiles) {
  const basename = path.basename(relativePath);
  const sourcePath = path.join(PATCH_ROOT, 'cdp', basename);
  const targetPath = path.join(PACKAGE_ROOT, relativePath);
  const expected = manifest.sourceHashes?.[basename];
  if (!expected) mismatches.push(`${relativePath}: hash esperado ausente no manifesto`);
  else {
    if (!fs.existsSync(sourcePath)) mismatches.push(`${relativePath}: fonte ausente`);
    else if (hash(sourcePath) !== expected) mismatches.push(`${relativePath}: fonte diverge do hash registrado`);
    if (!fs.existsSync(targetPath)) mismatches.push(`${relativePath}: destino ausente`);
    else if (hash(targetPath) !== expected) mismatches.push(`${relativePath}: destino diverge do hash registrado`);
  }
}

const runtimeSource = fs.readFileSync(path.join(AGENT_ROOT, 'src', 'puppeteer-runtime.js'), 'utf8');
if (runtimeSource.indexOf("process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';") < 0) {
  mismatches.push('src/puppeteer-runtime.js: addBinding não configurado');
}
const requireIndex = runtimeSource.indexOf("require('research-puppeteer-runtime')");
const envIndex = runtimeSource.indexOf("process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';");
if (requireIndex < 0 || envIndex < 0 || requireIndex <= envIndex) {
  mismatches.push('src/puppeteer-runtime.js: addBinding precisa ocorrer antes do require');
}

if (mismatches.length) {
  console.error('[Research] Verificação do runtime Puppeteer FALHOU:');
  for (const item of mismatches) console.error(` - ${item}`);
  process.exit(1);
}

console.log(`[Research] Runtime Puppeteer 24.8.1 + ${manifest.changedFiles.length} patches verificados com sucesso.`);
for (const relativePath of manifest.changedFiles) {
  console.log(` - OK ${relativePath}`);
}
