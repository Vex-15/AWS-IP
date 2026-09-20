// postbuild.cjs — Rename dist/*.js → *.mjs and fix local imports
// so AWS Lambda treats the files as ES modules unconditionally.
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');

const jsFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));

for (const file of jsFiles) {
  const filePath = path.join(distDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Fix local relative imports: from './tools.js' → from './tools.mjs'
  content = content.replace(/from\s+'(\.\/[^']+)\.js'/g, "from '$1.mjs'");

  const mjsPath = path.join(distDir, file.replace('.js', '.mjs'));
  fs.writeFileSync(mjsPath, content);
  fs.unlinkSync(filePath);

  console.log(`  ${file} → ${file.replace('.js', '.mjs')}`);
}

// Also remove .d.ts files (not needed at runtime)
const dtsFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.d.ts'));
for (const file of dtsFiles) {
  fs.unlinkSync(path.join(distDir, file));
}

console.log(`✅ Converted ${jsFiles.length} files to .mjs`);
