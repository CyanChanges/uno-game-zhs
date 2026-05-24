// Generate icon manifest from public/icons/
const { readdirSync, writeFileSync } = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, '..', 'public', 'icons');
const files = readdirSync(iconsDir).filter(f => f.endsWith('.svg'));
writeFileSync(path.join(iconsDir, 'manifest.json'), JSON.stringify(files));
console.log(`Generated icon manifest with ${files.length} files`);
