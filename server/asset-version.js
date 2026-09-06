const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ASSET_VERSION_TOKEN = '__ASSET_VERSION__';
const ASSET_VERSION_FILES = [
  'public/index.html',
  'public/css/style.css',
  'public/css/lobby.css',
  'public/css/table.css',
  'public/css/panels.css',
  'public/css/responsive.css',
  'public/css/tokens.css',
  'public/js/three-loader.js',
  'public/js/app-state.js',
  'public/js/app-init.js',
  'public/js/lobby-socket.js',
  'public/js/table-render.js',
  'public/js/ui-panels.js',
  'public/js/side-panel.js',
  'public/js/tournament-field.js',
  'public/js/app.js',
  'public/js/room-3d.js',
  'public/vendor/fonts/google-fonts.css',
  'public/vendor/three/three.r128.min.js',
];

function computeAssetVersion(rootDir) {
  const explicit = process.env.ASSET_VERSION && process.env.ASSET_VERSION.trim();
  if (explicit) return explicit;

  const hash = crypto.createHash('sha1');
  for (const relPath of ASSET_VERSION_FILES) {
    const filePath = path.join(rootDir, relPath);
    if (!fs.existsSync(filePath)) continue;
    hash.update(relPath);
    hash.update(fs.readFileSync(filePath));
  }
  return hash.digest('hex').slice(0, 10);
}

function renderIndexTemplate(rootDir, assetVersion) {
  const templatePath = path.join(rootDir, 'public', 'index.html');
  const template = fs.readFileSync(templatePath, 'utf8');
  return template.replaceAll(ASSET_VERSION_TOKEN, assetVersion);
}

module.exports = { ASSET_VERSION_TOKEN, computeAssetVersion, renderIndexTemplate };
