// Copy static assets from public/ into dist/, cross-platform.
// Replaces the Unix `cp` calls in the build script so it works on Windows too.
const { cpSync, mkdirSync, existsSync } = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

const assets = [
  { from: path.join(publicDir, 'index.html'), to: path.join(distDir, 'index.html') },
  { from: path.join(publicDir, 'style.css'), to: path.join(distDir, 'style.css') },
  { from: path.join(publicDir, 'icons'), to: path.join(distDir, 'icons'), recursive: true },
];

for (const { from, to, recursive } of assets) {
  cpSync(from, to, { recursive: !!recursive, force: true });
  console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}
