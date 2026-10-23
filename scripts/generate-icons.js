/**
 * Icon Generator for Yuvomi PWA
 * Generates all PNG icons from the repo-root icon.svg (single source of truth).
 * Sizes: 192px and 512px, both "any" and "maskable" variants
 * Maskable icons: full-bleed background, logo content stays within 80% safe zone
 * Additionally rebuilds public/favicon.ico (16/32/48 px) as a PNG-in-ICO container
 * so the browser tab icon follows the same source artwork.
 *
 * Usage: node scripts/generate-icons.js
 * Dependencies: sharp (devDependency)
 */

import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ICONS_DIR = join(ROOT, 'public', 'icons');
const SOURCE_SVG_PATH = join(ROOT, 'icon.svg');

mkdirSync(ICONS_DIR, { recursive: true });

const sourceSvg = readFileSync(SOURCE_SVG_PATH, 'utf8');
if (!sourceSvg.includes('<svg')) {
  throw new Error(`generate-icons.js: ${SOURCE_SVG_PATH} enthaelt kein <svg>`);
}

/**
 * Setzt explizite width/height auf dem Wurzel-Element: icon.svg traegt nur
 * eine viewBox, und librsvg rastert sonst in der viewBox-Groesse (160px) -
 * 512px-Ausgaben waeren dann nur hochskaliert statt scharf neu gerendert.
 */
function sized(svg, size) {
  return svg.replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
}

/**
 * Maskable-Variante: full-bleed Hintergrund. Die abgerundeten Ecken des
 * "any"-Looks wuerden nach dem Launcher-Masking als transparente Ecken
 * uebrigbleiben; jedes rx im Quell-Artwork (Hintergrund + Sheen) wird deshalb
 * generisch auf 0 gesetzt. Die Kreise liegen bereits in der maskable-
 * Safe-Zone (Ø 80 %) - am weitesten aussen: Kreis (80,106) r=24 -> 50px
 * vom Zentrum, Safe-Radius 64px.
 */
const maskableSvg = sourceSvg.replace(/\brx="\d+(?:\.\d+)?"/g, 'rx="0"');

const icons = [
  { name: 'icon-192.png',          size: 192, svg: sized(sourceSvg, 192)   },
  { name: 'icon-512.png',          size: 512, svg: sized(sourceSvg, 512)   },
  { name: 'icon-maskable-192.png', size: 192, svg: sized(maskableSvg, 192) },
  { name: 'icon-maskable-512.png', size: 512, svg: sized(maskableSvg, 512) },
  { name: 'apple-touch-icon.png',  size: 180, svg: sized(sourceSvg, 180)   },
  { name: 'favicon-32.png',        size: 32,  svg: sized(sourceSvg, 32)    },
];

for (const icon of icons) {
  const outputPath = join(ICONS_DIR, icon.name);
  await sharp(Buffer.from(icon.svg))
    .png()
    .toFile(outputPath);
  console.log(`  ✓ ${icon.name} (${icon.size}x${icon.size})`);
}

/**
 * favicon.ico: ICO-Container mit drei eingebetteten PNGs (16/32/48 px).
 * Aufbau: ICONDIR (6 B) + pro Groesse ein ICONDIRENTRY (16 B) + die PNG-Daten.
 * Sharp kann kein ICO schreiben, deshalb wird der Container hier von Hand
 * zusammengesetzt - dasselbe Format, das die bisherige favicon.ico traegt.
 */
async function buildFaviconIco() {
  const sizes = [16, 32, 48];
  const pngs = [];
  for (const size of sizes) {
    pngs.push(await sharp(Buffer.from(sized(sourceSvg, size))).png().toBuffer());
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // 1 = ICO
  header.writeUInt16LE(sizes.length, 4); // Eintraege
  const entries = Buffer.alloc(16 * sizes.length);
  let offset = 6 + 16 * sizes.length;
  pngs.forEach((png, i) => {
    const o = 16 * i;
    entries.writeUInt8(sizes[i], o);          // Breite (0 haette 256 gemeint)
    entries.writeUInt8(sizes[i], o + 1);      // Hoehe
    entries.writeUInt8(0, o + 2);             // Palettengroesse (0 = keine)
    entries.writeUInt8(0, o + 3);             // reserviert
    entries.writeUInt16LE(1, o + 4);          // Planes
    entries.writeUInt16LE(32, o + 6);         // Bittiefe
    entries.writeUInt32LE(png.length, o + 8);
    entries.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...pngs]);
}

const faviconIcoPath = join(ROOT, 'public', 'favicon.ico');
writeFileSync(faviconIcoPath, await buildFaviconIco());
console.log('  ✓ favicon.ico (16/32/48, PNG-in-ICO)');

console.log('\nIcons generated in public/icons/');
