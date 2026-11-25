'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AGENT_ROOT = path.resolve(__dirname, '..');
const PACKAGE_NAME = 'research-puppeteer-runtime';
const PATCH_ROOT = path.join(AGENT_ROOT, 'patches', 'puppeteer-runtime-24.8.1');
const TARGET_ROOT = path.join(AGENT_ROOT, 'node_modules', PACKAGE_NAME, 'lib', 'cjs', 'puppeteer', 'cdp');
const manifestPath = path.join(PATCH_ROOT, 'patch-manifest.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.baseVersion !== '24.8.1' || manifest.runtimeFixMode !== 'addBinding') {
  throw new Error('Patch manifest incompatível com o runtime esperado.');
}

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

if (!fs.existsSync(TARGET_ROOT)) {
  throw new Error(`Runtime ${PACKAGE_NAME} não está instalado em node_modules. Rode npm install primeiro.`);
}

// Check the entire batch before the first write. A node_modules junction is
// permitted for reading, but must never patch another worktree through it.
const realAgentRoot = fs.realpathSync(AGENT_ROOT);
const realTargetRoot = fs.realpathSync(TARGET_ROOT);
const targetRelative = path.relative(realAgentRoot, realTargetRoot);
if (!targetRelative || targetRelative === '..' || targetRelative.startsWith('..' + path.sep) || path.isAbsolute(targetRelative)) {
  throw new Error('PRIVATE_DEPENDENCIES_REQUIRED: Puppeteer patch destination must remain inside this Agent execution directory.');
}
for (const relativePath of manifest.changedFiles) {
  const sourcePath = path.join(PATCH_ROOT, 'cdp', path.basename(relativePath));
  const expected = manifest.sourceHashes?.[path.basename(relativePath)];
  if (!expected || hash(sourcePath) !== expected) {
    throw new Error(`Hash divergente na origem do patch: ${relativePath}`);
  }
  const targetPath = path.join(AGENT_ROOT, 'node_modules', PACKAGE_NAME, relativePath);
  if (path.dirname(fs.realpathSync(targetPath)) !== realTargetRoot || fs.lstatSync(targetPath).isSymbolicLink() || fs.statSync(targetPath).nlink !== 1) {
    throw new Error(`PRIVATE_DEPENDENCIES_REQUIRED: redirected or shared patch file: ${relativePath}`);
  }
}

for (const relativePath of manifest.changedFiles) {
  const sourcePath = path.join(PATCH_ROOT, 'cdp', path.basename(relativePath));
  const targetPath = path.join(AGENT_ROOT, 'node_modules', PACKAGE_NAME, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  const expected = manifest.sourceHashes?.[path.basename(relativePath)];
  const actual = hash(targetPath);
  if (!expected) {
    throw new Error(`Manifesto sem hash de origem para ${relativePath}`);
  }
  if (expected !== actual) {
    throw new Error(`Hash divergente após aplicar patch: ${relativePath}`);
  }
}

console.log(`[Research] Runtime Puppeteer único aplicado em ${PACKAGE_NAME}@24.8.1 (addBinding).`);
