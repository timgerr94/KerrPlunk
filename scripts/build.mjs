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
import { createHash } from 'node:crypto';
import { build, transform } from 'esbuild';

// Esbuild-Plugin: root-relative Imports (/api.js, /components/modal.js, …)
// werden aus public/ aufgelöst, nicht vom Dateisystem-Root.
const publicDirPlugin = {
  name: 'public-dir-resolver',
  setup(build) {
    build.onResolve({ filter: /^\// }, (args) => {
      const resolvedPath = path.join(publicDir, args.path.slice(1));
      if (fs.existsSync(resolvedPath)) {
        return { path: resolvedPath, namespace: 'file' };
      }
    });
  },
};

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

// Content-hash the shell bundle for immutable caching.
const shellBundleContent = fs.readFileSync(path.join(distDir, 'styles', SHELL_BUNDLE));
const shellHash = createHash('sha256').update(shellBundleContent).digest('hex').slice(0, 8);
const hashedShellName = `shell.${shellHash}.css`;
fs.renameSync(
  path.join(distDir, 'styles', SHELL_BUNDLE),
  path.join(distDir, 'styles', hashedShellName),
);

// Asset manifest so server and SW can resolve hashed names.
fs.writeFileSync(
  path.join(distDir, '.asset-manifest.json'),
  JSON.stringify({ [SHELL_BUNDLE]: hashedShellName }, null, 2),
);

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
  `  <link rel="stylesheet" href="/styles/${hashedShellName}" />` +
  indexHtml.slice(to);
writeTracked(path.join(distDir, 'index.html'), distHtml);

/** JS hashing: kritische Shell-Scripts für immutable Caching. */
const shellScripts = ['lang-init.js', 'theme-init.js'];
const scriptHashes = {};
for (const name of shellScripts) {
  const srcPath = path.join(distDir, name);
  const content = fs.readFileSync(srcPath);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  const hashedName = name.replace(/\.js$/, `.${hash}.js`);
  fs.renameSync(srcPath, path.join(distDir, hashedName));
  scriptHashes[name] = hashedName;
}

// Asset manifest ergänzen.
const manifestPath = path.join(distDir, '.asset-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
Object.assign(manifest, scriptHashes);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// dist/index.html: Script-Tags auf hashed Namen umschreiben.
for (const [original, hashed] of Object.entries(scriptHashes)) {
  distHtml = distHtml.replace(`src="/${original}"`, `src="/${hashed}"`);
}
writeTracked(path.join(distDir, 'index.html'), distHtml);

// dist/sw.js: APP_SHELL-Einträge auf hashed Namen umschreiben.
const swSrc = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
let swDist = swSrc;
for (const [original, hashed] of Object.entries(scriptHashes)) {
  swDist = swDist.replace(`'/${original}'`, `'/${hashed}'`);
}
fs.writeFileSync(path.join(distDir, 'sw.js'), swDist);

// CSS hashing: kritische Seiten-Stylesheets für immutable Caching.
const shellCssFiles = ['meals.css', 'recipes.css'];
const cssHashes = {};
for (const name of shellCssFiles) {
  const srcPath = path.join(distDir, 'styles', name);
  const content = fs.readFileSync(srcPath);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  const hashedName = name.replace(/\.css$/, `.${hash}.css`);
  fs.renameSync(srcPath, path.join(distDir, 'styles', hashedName));
  cssHashes[name] = hashedName;
}

// Asset manifest ergänzen.
const cssManifestPath = path.join(distDir, '.asset-manifest.json');
const cssManifest = JSON.parse(fs.readFileSync(cssManifestPath, 'utf8'));
Object.assign(cssManifest, cssHashes);
fs.writeFileSync(cssManifestPath, JSON.stringify(cssManifest, null, 2));

// dist/sw.js: APP_SHELL-Einträge auf hashed CSS-Namen umschreiben.
let cssSwDist = fs.readFileSync(path.join(distDir, 'sw.js'), 'utf8');
for (const [original, hashed] of Object.entries(cssHashes)) {
  cssSwDist = cssSwDist.replace(`'/styles/${original}'`, `'/styles/${hashed}'`);
}
fs.writeFileSync(path.join(distDir, 'sw.js'), cssSwDist);

/** Page-Module bündeln: meals.js + recipes.js mit allen Transitiv-Imports.
 *  Jedes `import()` im Router löst sonst einen ES-Modul-Import-Wasserfall
 *  (Seite + 20+ transitive Imports) aus. Bundling reduziert das auf 1 Request. */
const pageModules = ['pages/meals.js', 'pages/recipes.js'];
const pageModuleHashes = {};
for (const entry of pageModules) {
  const bundled = await build({
    entryPoints: [path.join(publicDir, entry)],
    bundle: true,
    minify: true,
    charset: 'utf8',
    plugins: [publicDirPlugin],
    external: [],
    write: false,
  });
  const content = bundled.outputFiles[0].contents;
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  const hashedName = entry.replace(/\.js$/, `.${hash}.js`);
  const destPath = path.join(distDir, hashedName);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content);
  pageModuleHashes[entry] = hashedName;
}

// Asset manifest ergänzen.
const manifestPath2 = path.join(distDir, '.asset-manifest.json');
const manifest2 = JSON.parse(fs.readFileSync(manifestPath2, 'utf8'));
Object.assign(manifest2, pageModuleHashes);
Object.assign(manifest2, cssHashes);
fs.writeFileSync(manifestPath2, JSON.stringify(manifest2, null, 2));

// Asset-Map für den Router: originaler Pfad -> gehaschter Pfad.
const allHashes = { ...pageModuleHashes, ...cssHashes };
const assetMapContent = `export const assetMap = new Map(${JSON.stringify([...Object.entries(allHashes)])});\n`;
fs.writeFileSync(path.join(distDir, '_asset-map.js'), assetMapContent);

// dist/sw.js: PAGE_MODULES-Einträge auf hashed Namen umschreiben.
let swDist2 = fs.readFileSync(path.join(distDir, 'sw.js'), 'utf8');
for (const [original, hashed] of Object.entries(pageModuleHashes)) {
  swDist2 = swDist2.replace(`'${original}'`, `'${hashed}'`);
}
fs.writeFileSync(path.join(distDir, 'sw.js'), swDist2);

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
const shellOut = fs.statSync(path.join(distDir, 'styles', hashedShellName)).size;
const cssAfter = shellOut + cssFiles.reduce((s, f) => {
  const hashed = cssHashes[f] || f;
  return s + fs.statSync(path.join(distDir, 'styles', hashed)).size;
}, 0);
const distTotal = treeBytes(distDir);
console.log(`shell bundle: ${shellStyles.length} Dateien -> ${hashedShellName}  ${(shellRawBytes / 1024).toFixed(1)} KB raw -> ${(shellOut / 1024).toFixed(1)} KB minifiziert`);
console.log(`css gesamt : ${cssFiles.length + shellStyles.length} Dateien  ${(rawBytes / 1024).toFixed(1)} KB -> ${(cssAfter / 1024).toFixed(1)} KB`);
console.log(`dist gesamt : ${(distTotal / 1024 / 1024).toFixed(1)} MB Mirror (Quelle public/ ohne dist: ${((treeBytes(publicDir) - distTotal) / 1024 / 1024).toFixed(1)} MB)`);
console.log(`index.html : 22 <link rel="stylesheet"> -> 1 <link rel="stylesheet" href="/styles/${hashedShellName}" />`);
console.log(`scripts    : ${Object.keys(scriptHashes).length} Shell-Scripts gehasht -> immutable Caching`);
console.log(`page-modules: ${Object.keys(pageModuleHashes).length} Seiten-Module gebündelt + gehasht`);
console.log(`css-hashed  : ${Object.keys(cssHashes).length} Seiten-CSS gehasht -> immutable Caching`);