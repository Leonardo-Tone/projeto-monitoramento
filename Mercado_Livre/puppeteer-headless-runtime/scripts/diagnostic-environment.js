'use strict';
const { mkdirSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { execFileSync } = require('node:child_process');

const outputRoot = resolve(process.env.RESEARCH_OUTPUT_ROOT || join(__dirname, '..'));

function revision() {
  mkdirSync(join(outputRoot, 'reports'), { recursive: true });
  if (process.env.RESEARCH_APP_VERSION) return { appVersion: process.env.RESEARCH_APP_VERSION };
  const git = (...args) => execFileSync('git', args, {
    cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }).trim();
  try { return { commit: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')) }; }
  catch { return {}; }
}

module.exports = { outputRoot, revision };
