'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const name = pkg.name;

const distDir = path.join(root, 'dist');
const zipName = `${name}-${version}.zip`;
const zipPath = path.join(distDir, zipName);

// Files to include (matches package.json "files" field)
const includes = [
  'index.js',
  'openclaw.plugin.json',
  'package.json',
  'README.md',
  'HOOK.md',
  'skills/',
];

// Clean dist
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true });
}
fs.mkdirSync(distDir, { recursive: true });

// Build zip command
const fileArgs = includes
  .filter(f => fs.existsSync(path.join(root, f)))
  .map(f => `"${f}"`)
  .join(' ');

execSync(`cd "${root}" && zip -r "${zipPath}" ${fileArgs}`, { stdio: 'inherit' });

const stat = fs.statSync(zipPath);
const sizeKB = (stat.size / 1024).toFixed(1);

console.log(`\n✅ Built: dist/${zipName} (${sizeKB} KB)`);
