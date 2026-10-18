/**
 * Modul: Vollbild eines Rezepts - die Leseflaeche ueber der Rezeptseite
 * Zweck: Die Detailspalte ist schmal, und ein Rezept liest sich beim Kochen
 *        besser ohne Liste daneben. Der Kopf der Spalte traegt einen Ausgang
 *        (`maximize`), der dasselbe Detail auf die ganze Flaeche hebt.
 *
 *        Der Kanon gilt weiter: KEIN zweiter Weg zur Information. Der Inhalt
 *        kommt aus fillRecipeDetail - derselbe Baustein wie im Aufklapper und
 *        in der Spalte; nur die Flaeche ist eine andere. Diese Suite nagelt
 *        das fest, zusammen mit den Ausgaengen (X, Escape, Zurueck-Geste
 *        #871), dem Fokus-Rueckweg zum Ausloeser und dem Stand der Ansicht
 *        auf jedem Neuaufbau der Liste (Speichern, Loeschen, Filter).
 *
 *        Dazu die zwei Schichten, die ein Overlay mitbringt: die Meldungen
 *        liegen darueber (--z-modal, nicht darunter), und die Kochbuch-Teilung
 *        ab 60rem: Zutaten links in ruhiger Spalte, Rest rechts, beide
 *        Flaechen scrollen fuer sich - die Notizen behalten dabei ihr 75ch-
 *        Lesemass. Der Vollbild-Kopf fuehrt nur Bearbeiten plus Schliessen.
 *
 *        Gemessen wird der QUELLTEXT der Seite (wie Abschnitt 6 der
 *        Vorrats-Zuordnungs-Suite): eine verhaltensgetriebene Variante
 *        haette die Seite durch den Browser-Loader zu ziehen - der Aufwand
 *        steht hier nicht im Verhaeltnis, weil die Zusicherungen an der
 *        VERDRAHTUNG stehen (welcher Baustein wohin zeigt), nicht an einer
 *        Rendering-Reihenfolge.
 * Ausfuehren: npm run test:recipes-fullscreen
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { eachRule } from './css-rules.js';

// -----------------------------------------------------------------------
// Werkzeuge: Quelltext der Seite ohne Kommentare, Funktionen am Namen.
// Dasselbe Duo wie in test-recipe-ingredient-pantry-match.js Abschnitt 6.
// -----------------------------------------------------------------------

function pageSrc() {
  let seite = readFileSync(new URL('../public/pages/recipes.js', import.meta.url), 'utf8');
  for (let prev = ''; prev !== seite;) {
    prev = seite;
    seite = seite.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }
  return seite;
}

function bodyOf(seite, name) {
  const at = seite.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `function ${name}() fehlt in public/pages/recipes.js`);
  return seite.slice(at, seite.indexOf('\n}\n', at));
}

// -----------------------------------------------------------------------
// 1. Der Ausgang: genau einer, in der Spalte, nicht im Vollbild selbst.
// -----------------------------------------------------------------------

test('der Ausgang ins Vollbild steht im Kopf der Spalte und nur dort', () => {
  const seite = pageSrc();
  const kopf = bodyOf(seite, 'detailHeaderActions');

  assert.match(kopf, /!fullscreen && \{\s*label: t\('recipes\.fullscreenLabel'\), icon: 'maximize'/,
    'der Spaltenkopf nennt den Ausgang ins Vollbild');
  assert.match(kopf, /id: 'recipes-detail-fullscreen'/,
    'der Ausgang traegt eine eigene id - der Fokus-Rueckweg braucht einen stabilen Zeugen');
  assert.match(kopf, /onClick: \(\{ button \}\) => openRecipeFullscreen\(recipe\.id, button\)/,
    'der Ausgang reicht sich selbst als Ausloeser mit - sonst waere der Fokus nach dem Schliessen weg');

  // Im Vollbild faellt er weg: ein zweiter Ausgang an den Ort, an dem man
  // schon ist, waere ein zweiter Weg zur selben Flaeche.
  assert.doesNotMatch(kopf, /fullscreen && \{\s*label: t\('recipes\.fullscreenLabel'\)/,
    'im Vollbild gibt es keinen Ausgang ins Vollbild');
  assert.match(kopf, /fullscreen \? 'recipe-fullscreen-edit' : 'recipes-detail-edit'/,
    'Bearbeiten traegt eine eigene id im Vollbild - zwei Flaechen, zwei Zeugen');
});

test('der Vollbild-Kopf fuehrt nur Bearbeiten plus Schliessen', () => {
  const seite = pageSrc();
  const open = bodyOf(seite, 'openRecipeFullscreen');
  const kopf = bodyOf(seite, 'detailHeaderActions');

  assert.match(open, /actions: \[\s*\.\.\.detailHeaderActions\(recipe, \{ fullscreen: true \}\),/,
    'der Kopf entsteht aus derselben Quelle wie der der Spalte - keine zweite Version, die auseinanderlaufen kann');
  assert.match(open, /id: 'recipe-fullscreen-close'/,
    'der Schliess-Knopf traegt seine id, auf die der Anfangs-Fokus zielt');

  // Duplizieren und Loeschen verwalten den Datensatz - sie bleiben an der
  // Liste, ueber der man den Ueberblick behaelt. Beide Eintraege stehen
  // deshalb unter derselben Verneinung wie der Vollbild-Ausgang.
  assert.match(kopf, /!fullscreen && \{\s*label: t\('recipes\.duplicate'\)/,
    'Duplizieren steht nur in der Spalte');
  assert.match(kopf, /!fullscreen && !isMirrored && \{\s*label: t\('common\.delete'\)/,
    'Loeschen steht nur in der Spalte');
  assert.doesNotMatch(kopf, /if \(fullscreen\) closeRecipeFullscreen\(\)/,
    'der Loesch-Fall im Vollbild-Kopf ist weg - refreshFullscreenDetail faengt jedes Verschwinden');
});

test('die Kochbuch-Teilung siedelt den Zutaten-Knoten um, sie baut nicht zweimal', () => {
  const seite = pageSrc();
  const vollbild = bodyOf(seite, 'recipeFullscreenDetail');
  const fuellen = bodyOf(seite, 'fillFullscreenBody');

  assert.match(vollbild, /fillRecipeDetail\(detail, recipe\)/,
    'der Inhalt entsteht aus der einen Quelle, auch in der Teilung');
  assert.match(vollbild, /querySelector\('\.recipe-detail__ingredients-section'\)/,
    'die Teilung haengt am Zutaten-Abschnitt, nicht an einer zweiten Inhaltsquelle');
  assert.match(vollbild, /left\.appendChild\(ingredients\)/,
    'der Zutaten-Abschnitt wandert als KNOTEN in die linke Flaeche - renderIngredientSections findet ihn in jeder Tiefe');
  assert.match(vollbild, /recipe-fullscreen__ingredients/, 'die linke Flaeche traegt ihre Klasse');
  assert.match(vollbild, /recipe-fullscreen__rest/, 'die rechte Flaeche traegt ihre Klasse');
  assert.match(vollbild, /if \(!ingredients\) return detail;/,
    'ohne Zutaten gibt es keine Teilung - das Detail steht allein');

  assert.match(fuellen, /classList\.toggle\('recipe-fullscreen__body--split'/,
    'die Gestalt steht als Klasse am Koerper, nicht als Zustand in einem Renderer');
  assert.match(fuellen, /nodeType === Node\.DOCUMENT_FRAGMENT_NODE/,
    'die Klasse entspringt dem Bau - Fragment heisst geteilt, Element heisst einspaltig');
});

// -----------------------------------------------------------------------
// 2. Ein Baustein, drei Flaechen - der Kanon gegen den zweiten Weg.
// -----------------------------------------------------------------------

test('das Vollbild zeigt denselben Inhalt wie Aufklapper und Spalte', () => {
  const seite = pageSrc();
  const vollbild = bodyOf(seite, 'recipeFullscreenDetail');
  const spalte = bodyOf(seite, 'renderRecipePane');

  assert.match(vollbild, /fillRecipeDetail\(detail, recipe\)/,
    'recipeFullscreenDetail baut den Inhalt nicht selbst - fillRecipeDetail ist die eine Quelle');
  assert.match(spalte, /fillRecipeDetail\(detail, recipe\)/,
    'renderRecipePane baut denselben Inhalt aus derselben Quelle');
});

// -----------------------------------------------------------------------
// 3. Dialog-Semantik: benannt, modal, ueber allem ausser Meldungen.
// -----------------------------------------------------------------------

test('das Vollbild ist ein benannter, modaler Dialog ueber der Seite', () => {
  const seite = pageSrc();
  const open = bodyOf(seite, 'openRecipeFullscreen');

  assert.match(open, /setAttribute\('role', 'dialog'\)/, 'role="dialog" fehlt');
  assert.match(open, /setAttribute\('aria-modal', 'true'\)/, 'aria-modal fehlt');
  assert.match(open, /setAttribute\('aria-label', recipe\.title\)/,
    'der Rezepttitel benennt die Ansicht - dasselbe Wort, das im Kopf steht');
  assert.match(open, /document\.body\.appendChild\(overlay\)/,
    'das Vollbild haengt am body, nicht an der Seitenwurzel - ein Neuaufbau der Seite laesst es stehen');

  // Ein zweites Oeffnen raeumt das erste ab: ein Handle je Seite, kein Stapel.
  assert.match(open, /closeRecipeFullscreen\(\{ focus: false \}\);/,
    'ein vorheriges Vollbild geht zuerst zu - zwei offene Vollbilder waeren zwei Buchhaltungen');
});

// -----------------------------------------------------------------------
// 4. Drei Ausgaenge: X, Escape, Zurueck-Geste (#871) - und der Fokus
//    kehrt zum Ausloeser zurueck.
// -----------------------------------------------------------------------

test('Schliessen, Escape und Zurueck-Geste fuehren alle auf denselben Abbau', () => {
  const seite = pageSrc();
  const open = bodyOf(seite, 'openRecipeFullscreen');
  const zu = bodyOf(seite, 'closeRecipeFullscreen');

  // Escape am Dokument, abgemeldet beim Schliessen - kein toter Zeuge.
  assert.match(open, /if \(e\.key === 'Escape'\) closeRecipeFullscreen\(\)/, 'Escape schliesst');
  assert.match(zu, /document\.removeEventListener\('keydown', fs\.onKeydown\)/,
    'closeRecipeFullscreen meldet den Escape-Zeugen ab');

  // Die Zurueck-Geste (#871): derselbe Anschluss wie bei den Modul-Overlays.
  assert.match(open, /attachOverlay\(overlay, \(\) => closeRecipeFullscreen\(\)\)/,
    'die Zurueck-Geste schliesst das Vollbild statt die Seite zu verlassen (#871)');
  assert.match(zu, /dropOverlay\(fs\.overlayToken\)/,
    'closeRecipeFullscreen gibt das History-Token zurueck');

  assert.match(zu, /fs\.overlay\.remove\(\)/, 'der Knoten geht aus dem Dokument');
  assert.match(zu, /if \(focus && fs\.trigger\?\.isConnected\) fs\.trigger\.focus\(\)/,
    'der Fokus kehrt zum Ausloeser zurueck, wenn er noch steht - auf einem abgehaengten Knoten waere .focus() ein stilles No-op');
});

// -----------------------------------------------------------------------
// 5. Auf dem Stand der Seite: jeder Neuaufbau der Liste hält die Ansicht
//    mit, ein gelöschtes Rezept nimmt sie ganz mit.
// -----------------------------------------------------------------------

test('jeder Neuaufbau der Liste haelt das Vollbild auf dem Stand der Seite', () => {
  const seite = pageSrc();
  const liste = bodyOf(seite, 'renderRecipeList');
  const frisch = bodyOf(seite, 'refreshFullscreenDetail');

  assert.match(liste, /_md\?\.refresh\(\{ repaint \}\);\s*refreshFullscreenDetail\(\);/,
    'renderRecipeList haelt das Vollbild mit - sonst zeigte es den Stand vor dem Speichern im Formular');

  assert.match(frisch, /if \(!recipe\) \{\s*closeRecipeFullscreen\(\)/,
    'ein Rezept, das die Liste nicht mehr fuehrt, nimmt die Ansicht ganz mit');
  assert.match(frisch, /fillFullscreenBody\(fs\.body, recipe\)/,
    'ein noch vorhandenes Rezept wird neu gezeichnet, nicht still stehen gelassen');
  assert.match(frisch, /if \(!fs\.overlay\.isConnected\) \{/,
    'ein bereits abgeraeumtes Overlay wird nur noch abgemeldet, nicht erneut geschlossen');
});

// -----------------------------------------------------------------------
// 6. Der Ausgang heisst in jeder Sprache etwas.
// -----------------------------------------------------------------------

test('recipes.fullscreenLabel steht als nicht-leere Zeichenkende in JEDEM Dialekt', () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const dateien = readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.ok(dateien.length >= 26, 'die locale-Liste ist kleiner als bekannt - der Loop waere blind');

  const fehlen = [];
  for (const name of dateien) {
    const locale = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
    const text = locale.recipes?.fullscreenLabel;
    if (typeof text !== 'string' || text.trim() === '') fehlen.push(name);
  }
  assert.deepEqual(fehlen, [],
    'public/locales ohne recipes.fullscreenLabel (oder leer): ' + fehlen.join(', '));

  const seite = pageSrc();
  assert.match(seite, /t\('recipes\.fullscreenLabel'\)/,
    'public/pages/recipes.js ruft den Schluessel nicht auf');
});

// -----------------------------------------------------------------------
// 7. Die Schichten des Vollbilds: unter den Meldungen, in der Kochbuch-
//    Gestalt, mit duennem Akzent-Balken auf jeder Lauflaeche.
// -----------------------------------------------------------------------

test('das Vollbild liegt ueber der Seite, teilt sich ab 60rem und faerbt seinen Lauf', () => {
  const css = readFileSync(new URL('../public/styles/recipes.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const exact = (sel) => rules.find((r) => r.selector === sel);

  const flaeche = exact('.recipe-fullscreen');
  assert.ok(flaeche, '.recipe-fullscreen fehlt in recipes.css');
  assert.match(flaeche.body, /z-index: var\(--z-modal\)/,
    'die Schicht ist --z-modal wie die Formulare - Meldungen (--z-toast) liegen darueber');
  assert.match(flaeche.body, /position: fixed/, 'das Vollbild deckt die Flaeche, es rutscht nicht mit der Seite');
  assert.match(flaeche.body, /--module-accent: var\(--module-kitchen\)/,
    'der Akzent am eigenen Knoten: das Vollbild haengt ausserhalb der .recipes-page und wuerde sonst den Marken-Fallback faerben');

  const koerper = exact('.recipe-fullscreen__body');
  assert.ok(koerper, '.recipe-fullscreen__body fehlt in recipes.css');
  assert.match(koerper.body, /overscroll-behavior: contain/,
    'das Ende der Zutatenliste darf die Seite dahinter nicht mitnehmen (Scroll-Chaining)');

  const split = exact('.recipe-fullscreen__body--split');
  assert.ok(split, '.recipe-fullscreen__body--split fehlt in recipes.css');
  assert.ok(split.at.some((a) => /min-width:\s*60rem/.test(a)),
    'die Teilung ist eine Frage der Flaeche, nicht des Rezepts - sie steht in einer Media-Query');
  assert.match(split.body, /grid-template-columns: minmax\(18\.75rem, 24rem\) minmax\(0, 1fr\)/,
    'links eine ruhige Zutaten-Spalte (300-384px, rund 25 Zeichen ohne Umbruch), rechts der Rest');
  assert.match(split.body, /overflow: hidden/,
    'im geteilten Gefuege laeuft der Koerper nicht selbst - sonst gaebe es drei Scrollports');

  const flaechen = rules.find((r) => r.selector.includes('.recipe-fullscreen__ingredients')
    && r.selector.includes('.recipe-fullscreen__rest') && /overflow-y:\s*auto/.test(r.body));
  assert.ok(flaechen, 'die Regel fuer die beiden Teilflaechen fehlt in recipes.css');
  assert.match(flaechen.body, /overflow-y: auto/,
    'beide Flaechen scrollen fuer sich - eine lange Zutatenliste laeuft nicht vom Zubereitungstext weg');
  assert.match(flaechen.body, /overscroll-behavior: contain/,
    'auch die Teilflaechen brechen die Scroll-Kette');

  const detail = exact('.recipe-detail--fullscreen');
  assert.ok(detail, '.recipe-detail--fullscreen fehlt in recipes.css');
  assert.match(detail.body, /max-width: var\(--content-max-width\)/,
    'das Vollbild nutzt die breite Content-Spalte, nicht das Lesemass der Liste');
  assert.match(detail.body, /padding: 0/,
    'das Polster traegt der Koerper - das Detail selbst keins, sonst stuende es doppelt');

  const notizen = exact('.recipe-detail--fullscreen .recipe-detail__notes');
  assert.ok(notizen, '.recipe-detail--fullscreen .recipe-detail__notes fehlt in recipes.css');
  assert.match(notizen.body, /max-width: 75ch/,
    'die Notizen behalten ihr Lesemass (75ch), auch auf breiter Flaeche');

  const lauf = rules.find((r) => ['.recipe-fullscreen__body', '.recipe-fullscreen__ingredients', '.recipe-fullscreen__rest']
    .every((n) => r.selector.includes(n)) && /scrollbar-width/.test(r.body));
  assert.ok(lauf, 'die gemeinsame Scrollbar-Regel der drei Lauflaechen fehlt in recipes.css');
  assert.match(lauf.body, /scrollbar-width: thin/, 'duenn, nicht der System-Balken');
  assert.match(lauf.body, /scrollbar-color: var\(--module-accent\) transparent/,
    'Kuechen-Akzent auf transparenter Spur - dasselbe Rezept wie .list-scroller');

  const daumen = rules.find((r) => r.selector.includes('::-webkit-scrollbar-thumb')
    && r.selector.includes('.recipe-fullscreen__body') && !r.selector.includes(':hover'));
  assert.ok(daumen, 'die ::-webkit-scrollbar-thumb-Regel der Vollbild-Laeufe fehlt');
  assert.match(daumen.body, /color-mix\(in srgb, var\(--module-accent\) var\(--tint-hint\)/,
    'der Daumen traegt die dokumentierte Toenungsstufe (--tint-hint, tokens.css 6b)');
  assert.match(daumen.body, /background-clip: padding-box/,
    'der Daumen wirkt schmaler, ohne die Treffflaeche zu schrumpfen');

  const hover = rules.find((r) => r.selector.includes('::-webkit-scrollbar-thumb:hover')
    && r.selector.includes('.recipe-fullscreen__body'));
  assert.ok(hover, 'die Hover-Regel der Vollbild-Laeufe fehlt');
  assert.match(hover.body, /calc\(var\(--tint-hint\) \+ var\(--tint-state\)\)/,
    'Hover ist derselbe Sprung wie an der Liste, aus den beiden bestehenden Stufen gerechnet');
});
