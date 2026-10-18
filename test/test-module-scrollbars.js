/**
 * Modul: Der duenne Akzent-Balken an allen app-eigenen Scrollports
 * Zweck: .list-scroller (Einkauf/Vorrat/Rezepte-Listen) hatte ihn laengst;
 *        Hauptscroller (.app-content), per-Page-Scrollports, die Detail-
 *        spalten aller Liste+Detail-Module und die Formular-Koerper zeigten
 *        auf Windows/Firefox/Chromium dagegen den vollen System-Balken - ein
 *        grauer Block am Rand jedes Moduls, das sichtbar dem Betriebssystem
 *        gehoerte statt der App. Diese Suite nagelt die EINE Regel fest, die
 *        alle vier Ports traegt - nicht je Modul, denn eine Allowlist ueber
 *        N Dateien deckt keine Regel ab (derselbe Satz wie bei der
 *        .page-scrollport-Rolle in layout.css).
 *
 *        Dazu die beiden Sonderfaelle am Rand der Regel:
 *          - die NAV-SIDEBAR faerbt auf die MARKE, nicht auf das Modul -
 *            sie gehoert keinem und darf dessen Farbe nicht annehmen;
 *          - das REZEPT-VOLLBILD bringt seinen Kuechen-Akzent selbst mit,
 *            weil es an document.body haengt, ausserhalb jeder Seitenwurzel.
 *
 *        .list-scroller bleibt unberuehrt: test-shopping prueft ihn dort am
 *        Wortlaut - hier nur die Gegenprobe, dass nichts doppelt erfunden
 *        wurde.
 * Ausfuehren: npm run test:module-scrollbars
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

const layoutCss = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
const listRowCss = readFileSync(new URL('../public/styles/list-row.css', import.meta.url), 'utf8');
const recipesCss = readFileSync(new URL('../public/styles/recipes.css', import.meta.url), 'utf8');

const layoutRules = [...eachRule(layoutCss)];
const recipesRules = [...eachRule(recipesCss)];

/* Erste Regel, deren Selektor JEDES der Worte nennt und deren Rumpf passt -
 * der Scanner liefert Selektorenlisten als einen String (css-rules.js),
 * deshalb includes() statt Gleichheit. */
const sharedRule = layoutRules.find((r) => ['.app-content', '.page-scrollport', '.split-view__detail', '.modal-panel__body']
  .every((s) => r.selector.includes(s)) && /scrollbar-width/.test(r.body));

test('die vier app-Scrollports teilen EINE duenne Akzent-Regel', () => {
  assert.ok(sharedRule,
    'die gemeinsame Regel (.app-content, .page-scrollport, .split-view__detail, .modal-panel__body) fehlt in layout.css');
  assert.match(sharedRule.body, /scrollbar-width:\s*thin/, 'duenn, nicht der System-Balken');
  assert.match(sharedRule.body, /scrollbar-color:\s*var\(--module-accent, var\(--color-accent\)\) transparent/,
    'Modul-Akzent MIT Marken-Fallback: die Token setzt die Seiten-Wurzel, body-nahe Ports erben sie nicht');
});

test('der Chromium-Daumen ist abgerundet, getoent und hat einen Hover', () => {
  const breite = layoutRules.find((r) => r.selector.includes('.app-content')
    && r.selector.includes('::-webkit-scrollbar') && !r.selector.includes('track') && !r.selector.includes('thumb'));
  assert.ok(breite, 'die ::-webkit-scrollbar-Regel der vier Ports fehlt in layout.css');
  assert.match(breite.body, /width:\s*10px/, 'dieselbe Spurbreite wie .list-scroller');

  const daumen = layoutRules.find((r) => r.selector.includes('::-webkit-scrollbar-thumb')
    && r.selector.includes('.split-view__detail') && !r.selector.includes(':hover'));
  assert.ok(daumen, 'die Daumen-Regel der vier Ports fehlt in layout.css');
  assert.match(daumen.body, /color-mix\(in srgb, var\(--module-accent, var\(--color-accent\)\) var\(--tint-hint\)/,
    'der Daumen traegt die dokumentierte Toenungsstufe (--tint-hint, tokens.css 6b)');
  assert.match(daumen.body, /background-clip:\s*padding-box/,
    'der Daumen wirkt schmaler, ohne die Treffflaeche zu schrumpfen');

  const hover = layoutRules.find((r) => r.selector.includes('::-webkit-scrollbar-thumb:hover')
    && r.selector.includes('.modal-panel__body'));
  assert.ok(hover, 'die Hover-Regel der vier Ports fehlt in layout.css');
  assert.match(hover.body, /calc\(var\(--tint-hint\) \+ var\(--tint-state\)\)/,
    'Hover ist derselbe Sprung wie an der Liste, aus den beiden bestehenden Stufen gerechnet');
});

test('.list-scroller bleibt unberuehrt - die Listen behalten ihre eigene Regel', () => {
  assert.match(listRowCss, /\.list-scroller\s*\{\s*scrollbar-width:\s*thin;\s*scrollbar-color:\s*var\(--module-accent\)\s*transparent;\s*\}/,
    'die Regel der Listen (list-row.css) ist die unveraenderte Vorlage - test-shopping prueft sie dort am Wortlaut');
});

test('die Seitenleiste faerbt auf die Marke, nicht auf das Modul', () => {
  // Zwei Regeln tragen diesen Selektor (position:relative und der Lauf) -
  // gemeint ist die mit dem Lauf.
  const items = layoutRules.find((r) => r.selector === '.nav-sidebar__items' && /scrollbar-width/.test(r.body));
  assert.ok(items, '.nav-sidebar__items fehlt in layout.css');
  assert.match(items.body, /scrollbar-width:\s*thin/, 'duenn bleibt duenn (#970-Ruecknahme unangetastet)');
  assert.match(items.body, /scrollbar-color:\s*color-mix\(in srgb, var\(--color-accent\) var\(--tint-hint\), transparent\) transparent/,
    'die Marke statt System-Grau - die Seitenleiste gehoert keinem Modul und darf dessen Farbe nicht annehmen');

  const daumen = layoutRules.find((r) => r.selector.includes('.nav-sidebar__items::-webkit-scrollbar-thumb'));
  assert.ok(daumen, 'der Daumen der Seitenleiste fehlt in layout.css');
  assert.match(daumen.body, /var\(--color-accent\)/, 'auch der Chromium-Daumen der Seitenleiste traegt die Marke');
});

test('das Rezept-Vollbild faerbt seine Lauflaechen auf den Kuechen-Akzent', () => {
  const traeger = recipesRules.find((r) => r.selector === '.recipe-fullscreen');
  assert.ok(traeger, '.recipe-fullscreen fehlt in recipes.css');
  assert.match(traeger.body, /--module-accent:\s*var\(--module-kitchen\)/,
    'das Vollbild haengt an document.body und muss den Akzent selbst mitbringen');

  const lauf = recipesRules.find((r) => ['.recipe-fullscreen__body', '.recipe-fullscreen__ingredients', '.recipe-fullscreen__rest']
    .every((s) => r.selector.includes(s)) && /scrollbar-width/.test(r.body));
  assert.ok(lauf, 'die gemeinsame Scrollbar-Regel der drei Vollbild-Lauflaechen fehlt in recipes.css');
  assert.match(lauf.body, /scrollbar-color:\s*var\(--module-accent\) transparent/, 'Akzent auf transparenter Spur');
});
