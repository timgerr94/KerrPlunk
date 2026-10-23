/**
 * Build: Minify + CSS Shell-Bundle + dist/ Mirror.
 *
 * Entscheidungen (aus dem Plan):
 *   - dist/ ist ein kompletter Mirror von public/ mit minifizierten Varianten.
 *   - Shell-CSS (22 Dateien aus index.html) zu EINER shell.css gebündelt + minifiziert.
 *   - Alle weiteren Stylesheets und JS werden transform-only minifiziert, Pfade unverändert.
 *   - index.html: die 22 <link>-Zeilen gegen EINE <link href="/styles/shell.css"> getauscht.
 *   - Kein Hashing, keine Import-Rewriting in JS (api.js bleibt Modul-Identitaet erhalten).
 *   - Server: zwei express.static (dist vor public).
 *
 * Aufruf (im Docker-Container mit bind-mounted Repo):
 *   docker run --rm -v ${PWD}:/w -w /w kerrplunk:recovery node /w/scripts/build.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const publicDir = path.join(repoRoot, 'public');
const distDir = path.join(publicDir, 'dist');
const stylesDir = path.join(publicDir, 'styles');

const SHELL_BUNDLE = 'shell.css';

// Diese JS-Dateien bleiben unangetastet (keine Minify, sondern Kopie).
const JS_SKIP = new Set(['lucide.min.js', 'sw.js']);
// Beim Minify-Walk ueberspringen (nichts davon wird minifiziert); vendor
// gehoert trotzdem in den Mirror und wird im copyTree mitgenommen.
const DIR_SKIP = new Set(['dist', 'vendor', 'node_modules']);
// Beim Kopieren ueberspringen: ausschliesslich dist selbst (Ausgabeziel).
const COPY_SKIP = new Set(['dist']);

function trackBefore(p) {
  // (not used in this version; kept for symmetry with earlier attempt)
}

function writeTracked(dest, content) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
}

function copyTracked(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Shell-Liste exakt aus index.html extrahieren. */
const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const shellLinks = [...indexHtml.matchAll(/<link rel="stylesheet" href="\/styles\/([^"]+\.css)"\s*\/>/g)];
if (shellLinks.length < 5) {
  console.error(`build: ${shellLinks.length} Stylesheet-Links in index.html gefunden - Regex kaputt?`);
  process.exit(1);
}
const shellStyles = shellLinks.map((m) => m[1]);

/** dist leeren. */
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

/** 1. Shell-Bundle: esbuild stdin mit @import-Kette, bundle:true, minify:true. */
const shellEntry = shellStyles.map((name) => `@import "${name}";`).join('\n');
await build({
  stdin: { contents: shellEntry, loader: 'css', resolveDir: stylesDir },
  bundle: true,
  minify: true,
  charset: 'utf8',
  // Absolute url()-Pfade (skins.css-Fonts) sind Laufzeit-URLs des Servers,
  // keine Build-Eingaben: dist spiegelt /fonts ohnehin byteweise, der Pfad
  // bleibt genau so stehen wie in der Quelle.
  external: ['/fonts/*', '/icons/*', '/vendor/*'],
  outfile: path.join(distDir, 'styles', SHELL_BUNDLE),
  logLevel: 'warning',
});

/** 2. Per-Route-Stylesheets: transform-only (kein Bundling). */
const shellSet = new Set(shellStyles);
const cssFiles = fs.readdirSync(stylesDir).filter((f) => f.endsWith('.css') && !shellSet.has(f));
for (const name of cssFiles) {
  const srcPath = path.join(stylesDir, name);
  const src = fs.readFileSync(srcPath, 'utf8');
  const out = await transform(src, { loader: 'css', minify: true, charset: 'utf8' });
  writeTracked(path.join(distDir, 'styles', name), out.code);
}

/** 3. JS: transform-only minify. */
async function minifyJsTree(relDir) {
  const absDir = path.join(publicDir, relDir);
  if (!fs.existsSync(absDir)) return;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!DIR_SKIP.has(entry.name)) await minifyJsTree(path.join(relDir, entry.name));
      continue;
    }
    if (!entry.name.endsWith('.js') || JS_SKIP.has(entry.name)) continue;
    const srcPath = path.join(absDir, entry.name);
    const src = fs.readFileSync(srcPath, 'utf8');
    const out = await transform(src, { loader: 'js', minify: true, charset: 'utf8' });
    writeTracked(path.join(distDir, relDir, entry.name), out.code);
  }
}
await minifyJsTree('.');
await minifyJsTree('pages');
await minifyJsTree('utils');
await minifyJsTree('components');
await minifyJsTree('settings');

/** 4. Alles andere byteweise kopieren (fonts, icons, locales, vendor, manifest, offline/HTML). */
function copyTree(relDir) {
  const absDir = path.join(publicDir, relDir);
  if (!fs.existsSync(absDir)) return;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = relDir === '.' ? entry.name : path.join(relDir, entry.name);
    const src = path.join(publicDir, rel);
    if (entry.isDirectory()) {
      if (!COPY_SKIP.has(entry.name)) copyTree(rel);
      continue;
    }
    const dest = path.join(distDir, rel);
    if (fs.existsSync(dest)) continue;
    copyTracked(src, dest);
  }
}
copyTree('.');

/** 5. dist/index.html: 22 Stylesheet-Links gegen EINEN tauschen. */
let distHtml = indexHtml;
const first = shellLinks[0];
const last = shellLinks[shellLinks.length - 1];
const from = indexHtml.indexOf(first[0]);
const to = indexHtml.indexOf(last[0]) + last[0].length;
if (from === -1 || to < from) {
  console.error('build: Stylesheet-Block in index.html nicht auffindbar.');
  process.exit(1);
}
distHtml =
  indexHtml.slice(0, from) +
  `  <link rel="stylesheet" href="/styles/${SHELL_BUNDLE}" />` +
  indexHtml.slice(to);
writeTracked(path.join(distDir, 'index.html'), distHtml);

/** 6. Zusammenfassung. */
function treeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? treeBytes(p) : fs.statSync(p).size;
  }
  return total;
}
const shellRawBytes = shellStyles.reduce((s, n) => s + fs.statSync(path.join(stylesDir, n)).size, 0);
const rawBytes = shellRawBytes +
  cssFiles.reduce((s, f) => s + fs.statSync(path.join(stylesDir, f)).size, 0);
const shellOut = fs.statSync(path.join(distDir, 'styles', SHELL_BUNDLE)).size;
const cssAfter = shellOut + cssFiles.reduce((s, f) => s + fs.statSync(path.join(distDir, 'styles', f)).size, 0);
const distTotal = treeBytes(distDir);
console.log(`shell bundle: ${shellStyles.length} Dateien -> ${SHELL_BUNDLE}  ${(shellRawBytes / 1024).toFixed(1)} KB raw -> ${(shellOut / 1024).toFixed(1)} KB minifiziert`);
console.log(`css gesamt : ${cssFiles.length + shellStyles.length} Dateien  ${(rawBytes / 1024).toFixed(1)} KB -> ${(cssAfter / 1024).toFixed(1)} KB`);
console.log(`dist gesamt : ${(distTotal / 1024 / 1024).toFixed(1)} MB Mirror (Quelle public/ ohne dist: ${((treeBytes(publicDir) - distTotal) / 1024 / 1024).toFixed(1)} MB)`);
console.log(`index.html : 22 <link rel="stylesheet"> -> 1 <link rel="stylesheet" href="/styles/${SHELL_BUNDLE}" />`);