/**
 * Test: Rezepte-Routen (Härtung, Coverage-Track)
 * Zweck: End-to-End über den echten Recipes-Router - härtet die bislang komplett
 *        ungetestete Route-Schicht ab. Fokus: Validierung (400), Nicht-gefunden
 *        (404), kein Besitzer-Riegel bei PUT/DELETE (#1577: das Modulrecht
 *        genuegt, `meals: read` weist der Modul-Riegel ab - gemessen in
 *        test-recipe-transfer-gate.js), Zutaten-Regeln (leerer Name übersprungen, category-Default
 *        'Sonstiges', quantity leer→null, Längen-Slicing), meal_types-Normalisierung
 *        (Default alle-4, Dedup, Invalides verworfen), Replace-Set der Zutaten bei
 *        PUT und CASCADE-Löschung. Persistenz jeweils per DB-Assertion belegt.
 * Ausführen: node --experimental-sqlite --test test/test-recipes-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: recipesRouter } = await import('../server/routes/recipes.js');
// Der Einkaufs-Router hängt mit drin, weil die Rücknahme eines Transfers über
// ihn läuft (POST /shopping/items/undo-transfer) - ohne ihn wäre nur die halbe
// Handlung getestet.
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const recipeProviders = await import('../server/services/recipe-providers/index.js');
const db = dbmod.get();

const OWNER = db.prepare(`INSERT INTO users (username, display_name, avatar_color, password_hash, role) VALUES ('owner','Owner','#112233','x','member')`).run().lastInsertRowid;
const ADMIN = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')`).run().lastInsertRowid;
const MEMBER2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('member2','Member Zwei','x','member')`).run().lastInsertRowid;

// Aktueller Akteur wird zur Request-Zeit gelesen → pro Test umschaltbar.
let actor = { id: OWNER, role: 'member' };
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/shopping', shoppingRouter);
app.use('/', recipesRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

function ingredientRows(recipeId) {
  return db.prepare('SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC').all(recipeId);
}

// Inkl. `unit` (v237) - eigener Helfer, weil `ingredientRows` oben bewusst ohne
// die neue Spalte auskommt und seine deepEqual-Asserts sonst um ein Feld wachsen.
function ingredientRowsWithUnit(recipeId) {
  return db.prepare('SELECT name, quantity, unit, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC').all(recipeId);
}

// --------------------------------------------------------------------------
// GET / (Liste)
// --------------------------------------------------------------------------
test('GET /: leere Sammlung → leeres Array', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, []);
});

// --------------------------------------------------------------------------
// POST / (Anlegen + Validierung + Zutaten-Regeln)
// --------------------------------------------------------------------------
test('POST /: fehlender Titel → 400', async () => {
  const r = await call('POST', '/', { title: '  ' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Titel/);
});

test('POST /: legt Rezept an; created_by, 201, meal_types-Default = alle vier', async () => {
  const r = await call('POST', '/', { title: 'Pfannkuchen' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.title, 'Pfannkuchen');
  // meal_types weggelassen → Normalisierung liefert alle vier Keys.
  assert.deepEqual(r.body.data.meal_types, ['breakfast', 'lunch', 'dinner', 'snack']);
  assert.deepEqual(r.body.data.ingredients, []);
  const row = db.prepare('SELECT created_by, meal_types FROM recipes WHERE id = ?').get(r.body.data.id);
  assert.equal(row.created_by, OWNER);
  assert.equal(row.meal_types, 'breakfast,lunch,dinner,snack');
});

test('POST /: meal_types werden dedupliziert und Ungültiges verworfen', async () => {
  const r = await call('POST', '/', { title: 'Nudeln', meal_types: ['lunch', 'lunch', 'pizza', 'dinner'] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data.meal_types, ['lunch', 'dinner']);
  const row = db.prepare('SELECT meal_types FROM recipes WHERE id = ?').get(r.body.data.id);
  assert.equal(row.meal_types, 'lunch,dinner');
});

// Treat-Umbenennung (2026-10): Der Schluessel bleibt 'snack' (DB-CHECK,
// Eignung, Feeds), nur das englische Etikett heisst "Treat". Importer
// schreiben aber das Wort, das sie meinen - "Dessert", "Treat" oder "Snack"
// meinen denselben Slot und ziehen auf ihn; alle Gross-/Kleinschreibungen.
test('POST /: Dessert/Treat/Snack-Aliase ziehen alle auf snack', async () => {
  const r = await call('POST', '/', {
    title: 'Kuchen',
    meal_types: ['Dessert', 'treat', 'SNACK', 'dessert'],
  });
  assert.equal(r.status, 201);
  // Alle vier Eingaben ziehen auf denselben Schluessel und fallen zusammen.
  assert.deepEqual(r.body.data.meal_types, ['snack']);
  const row = db.prepare('SELECT meal_types FROM recipes WHERE id = ?').get(r.body.data.id);
  assert.equal(row.meal_types, 'snack');
});


test('POST /: Zutaten-Regeln - leerer Name übersprungen, quantity leer→null, category-Default, Slicing', async () => {
  const longName = 'N'.repeat(250);
  const longQty = 'Q'.repeat(150);
  const r = await call('POST', '/', {
    title: 'Zutatenprobe',
    ingredients: [
      { name: '  Mehl  ', quantity: '  ', category: '' },   // quantity→null, category→'Sonstiges'
      { name: '   ', quantity: '1 EL', category: 'Backen' }, // leerer Name → übersprungen
      { name: longName, quantity: longQty, category: 'Sonstiges' }, // Slicing MAX_TITLE/MAX_SHORT
    ],
  });
  assert.equal(r.status, 201);
  const rows = ingredientRows(r.body.data.id);
  assert.equal(rows.length, 2); // leerer Name wurde nicht eingefügt
  // Ohne gesetzte Kategorie rät die Stichwort-Tabelle (haushaltseigene
  // Kategorien, services/recipe-providers/categorize.js): 'Mehl' → Backwaren.
  assert.deepEqual(rows[0], { name: 'Mehl', quantity: null, category: 'Backwaren' });
  assert.equal(rows[1].name.length, 200); // MAX_TITLE
  assert.equal(rows[1].quantity.length, 100); // MAX_SHORT
});

test('POST /: zu lange Notizen → 400 (kein Rezept angelegt)', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  const r = await call('POST', '/', { title: 'X', notes: 'a'.repeat(5001) });
  assert.equal(r.status, 400);
  const after = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  assert.equal(after, before);
});

// v237: Menge und Einheit sind zwei freie Textspalten. Der Altbestand trug die
// Einheit schon in `quantity` ("500 g"); beides zugleich bleibt erlaubt.
test('POST/PUT /: unit wird getrennt von quantity gespeichert und gelesen', async () => {
  const created = await call('POST', '/', {
    title: 'Einheitenprobe',
    ingredients: [
      { name: 'Mehl', quantity: '500', unit: 'g' },
      { name: 'Milch', quantity: '1', unit: 'l', category: 'Milchprodukte' },
      { name: 'Salz', unit: 'Prise' },              // nur Einheit, keine Menge
      { name: 'Zucker', quantity: '50 g' },          // Altform: Einheit steckt in quantity
    ],
  });
  assert.equal(created.status, 201);
  const rows = ingredientRowsWithUnit(created.body.data.id);
  // Ohne gesetzte Kategorie: Stichwort-Rater, 'Mehl' → Backwaren.
  assert.deepEqual(rows[0], { name: 'Mehl', quantity: '500', unit: 'g', category: 'Backwaren' });
  assert.deepEqual(rows[1], { name: 'Milch', quantity: '1', unit: 'l', category: 'Milchprodukte' });
  assert.deepEqual(rows[2], { name: 'Salz', quantity: null, unit: 'Prise', category: 'Sonstiges' });
  assert.deepEqual(rows[3], { name: 'Zucker', quantity: '50 g', unit: null, category: 'Sonstiges' });

  // Auch die Antwort des Servers traegt die Einheit: der POST gibt das fertig
  // angelegte Rezept zurueck (loadRecipeWithIngredients). Einen eigenen
  // GET /:id gibt es nicht - die Detailansicht liest aus der Liste (GET /),
  // und ein Aufruf hier lief nur in Express' Default-404 aus.
  assert.equal(created.body.data.ingredients[0].unit, 'g');

  // PUT ersetzt die Zutatenliste inkl. Einheit (DELETE + INSERT).
  const updated = await call('PUT', `/${created.body.data.id}`, {
    title: 'Einheitenprobe',
    ingredients: [{ name: 'Mehl', quantity: '1', unit: 'kg' }],
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(ingredientRowsWithUnit(created.body.data.id), [
    // Ohne gesetzte Kategorie: Stichwort-Rater, 'Mehl' → Backwaren.
    { name: 'Mehl', quantity: '1', unit: 'kg', category: 'Backwaren' },
  ]);
});

// Ausgeschriebene Einheiten werden beim Speichern auf ihr Kuerzel gezogen
// (utils/unit-abbreviations.js); Unbekanntes bleibt unberuehrt.
test('POST /: ausgeschriebene Einheiten werden zu Kuezeln', async () => {
  const r = await call('POST', '/', {
    title: 'Kuerzel-Rezept',
    ingredients: [
      { name: 'Öl', quantity: '2', unit: 'tablespoons' },   // → tbsp
      { name: 'Salz', quantity: '1', unit: 'Tsp.' },        // Punkt + Kleinschreibung → tsp
      { name: 'Mehl', quantity: '500', unit: 'Grams' },     // → g
      { name: 'Butter', quantity: 'Esslöffel' },            // Einheit ohne Menge → EL
      { name: 'Knoblauch', quantity: '3', unit: 'cloves' }, // unbekannt → bleibt
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rows = db.prepare('SELECT name, unit FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC').all(r.body.data.id);
  assert.deepEqual(rows.map((x) => [x.name, x.unit]), [
    ['Öl', 'tbsp'],
    ['Salz', 'tsp'],
    ['Mehl', 'g'],
    ['Butter', 'EL'],
    ['Knoblauch', 'cloves'],
  ]);
});

test('PUT /:id: Einheiten werden beim Ersetzen ebenfalls gezogen', async () => {
  const created = await call('POST', '/', {
    title: 'Kuerzel-PUT-Basis',
    ingredients: [{ name: 'Zucker', quantity: '1', unit: 'tablespoon' }],
  });
  const id = created.body.data.id;
  const r = await call('PUT', `/${id}`, {
    title: 'Kuerzel-PUT-Basis',
    ingredients: [
      { name: 'Zucker', quantity: '1', unit: 'teaspoons' },  // → tsp
      { name: 'Wasser', quantity: '500', unit: 'milliliters' }, // → ml
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = db.prepare('SELECT unit FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC').all(id);
  assert.deepEqual(rows.map((x) => x.unit), ['tsp', 'ml']);
});

// v241: Zubereitungs-Hinweis je Zutat. Das Original-Beispiel eines Importers
// (recipe_import_format_example.json) schickt eine Notiz im eigenen Feld und
// dazu Felder, die KerrPlunk nicht kennt - die muessen lautlos ignoriert werden.
test('POST /: Notiz je Zutat wird gespeichert, unbekannte Felder ignoriert', async () => {
  const r = await call('POST', '/', {
    title: 'Notiz-Rezept',
    ingredients: [
      { name: 'large onion, thinly', quantity: '1', unit: '', secondaryQuantity: '', secondaryUnit: '', note: 'sliced', category: 'Produce', nutrition: {} },
      { name: 'Mehl', quantity: '500', unit: 'g' }, // ohne Notiz → NULL
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rows = db.prepare('SELECT name, note FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC').all(r.body.data.id);
  assert.deepEqual(rows, [
    { name: 'large onion, thinly', note: 'sliced' },
    { name: 'Mehl', note: null },
  ]);
  // Die Antwort traegt die Notiz mit (SELECT * uebernimmt die neue Spalte).
  assert.equal(r.body.data.ingredients[0].note, 'sliced');
});

// v243: Zweitangabe je Zutat - Gewichtsaequivalent zur primaeren Menge, in
// ZWEI Spalten wie die primaere Aufteilung (dort begruendet: ein spaeteres
// Skalieren rechnet an der Zahl). Leerer String ist "keine Angabe" wie
// ueberall; die kanonischen Schluessel laufen ebenso durch (Rueckschreiben).
test('POST /: secondaryQuantity/secondaryUnit werden getrennt gespeichert', async () => {
  const r = await call('POST', '/', {
    title: 'Zweitangaben',
    ingredients: [
      { name: 'almond flour', quantity: '0.5', unit: 'cup', secondaryQuantity: '48', secondaryUnit: 'g' },
      { name: 'Honig', quantity: '2', unit: 'tbsp', secondary_quantity: '30', secondary_unit: 'g' }, // kanonisch
      { name: 'Salz', quantity: '1', unit: 'tsp', secondaryQuantity: '', secondaryUnit: '' },         // leer → NULL
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rows = db.prepare(`
    SELECT name, secondary_quantity, secondary_unit FROM recipe_ingredients
    WHERE recipe_id = ? ORDER BY id ASC
  `).all(r.body.data.id);
  assert.deepEqual(rows, [
    { name: 'almond flour', secondary_quantity: '48', secondary_unit: 'g' },
    { name: 'Honig', secondary_quantity: '30', secondary_unit: 'g' },
    { name: 'Salz', secondary_quantity: null, secondary_unit: null },
  ]);
  // Die Antwort traegt beide Felder (SELECT * uebernimmt die neuen Spalten).
  assert.deepEqual(
    [r.body.data.ingredients[0].secondary_quantity, r.body.data.ingredients[0].secondary_unit],
    ['48', 'g'],
  );
});

test('PUT /:id: Zweitangaben werden beim Ersetzen uebernommen und geleert', async () => {
  const created = await call('POST', '/', {
    title: 'Zweitangaben-PUT-Basis',
    ingredients: [{ name: 'Mehl', quantity: '1', unit: 'cup', secondaryQuantity: '120', secondaryUnit: 'g' }],
  });
  const id = created.body.data.id;
  assert.equal(created.body.data.ingredients[0].secondary_quantity, '120');

  // PUT ersetzt die Zutatenliste: neue Zweitangabe statt der alten, und eine
  // leere loescht (derselbe Vertrag wie quantity/unit).
  const r = await call('PUT', `/${id}`, {
    title: 'Zweitangaben-PUT-Basis',
    ingredients: [
      { name: 'Zucker', quantity: '0.5', unit: 'cup', secondaryQuantity: '100', secondaryUnit: 'g' },
      { name: 'Mehl', quantity: '1', unit: 'cup', secondaryQuantity: '', secondaryUnit: '' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = db.prepare(`
    SELECT name, secondary_quantity FROM recipe_ingredients
    WHERE recipe_id = ? ORDER BY id ASC
  `).all(id);
  assert.deepEqual(rows, [
    { name: 'Zucker', secondary_quantity: '100' },
    { name: 'Mehl', secondary_quantity: null },
  ]);
});

test('PUT /:id: Notizen werden beim Ersetzen mitgeschrieben und ueberschrieben', async () => {
  const created = await call('POST', '/', {
    title: 'Notiz-PUT-Basis',
    ingredients: [{ name: 'Zwiebel', note: 'gewürfelt' }],
  });
  const id = created.body.data.id;

  // Ersetzen: neue Notiz, alte weg; leere Notiz loescht (wie quantity/unit).
  const r = await call('PUT', `/${id}`, {
    title: 'Notiz-PUT-Basis',
    ingredients: [
      { name: 'Zwiebel', note: 'in Ringe geschnitten' },
      { name: 'Knoblauch', note: '  ' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = db.prepare('SELECT name, note FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC').all(id);
  assert.deepEqual(rows, [
    { name: 'Zwiebel', note: 'in Ringe geschnitten' },
    { name: 'Knoblauch', note: null },
  ]);
});

// --------------------------------------------------------------------------
// Naehrwerte je Portion (v242): nutritionSummary des Importers wird auf die
// kanonischen Schluessel des Gesundheitsmoduls gemappt, Natrium zu Salz
// umgerechnet (mg × 2,5 / 1000, EU-Etikett), Unbekanntes faellt still weg.
// --------------------------------------------------------------------------
test('POST /: nutritionSummary wird gemappt, Natrium zu Salz umgerechnet', async () => {
  const r = await call('POST', '/', {
    title: 'Naehrwert-Rezept',
    servings: 4,
    nutritionSummary: {
      calories: '257', carbohydrates: '23', protein: '21', fat: '10',
      saturatedFat: '1', cholesterol: '54', sodium: '1507', fiber: '2', sugar: '17',
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // DB: JSON-Text mit kanonischen Schluesseln, Cholesterin weg.
  const row = db.prepare('SELECT nutrition FROM recipes WHERE id = ?').get(r.body.data.id);
  assert.deepEqual(JSON.parse(row.nutrition), {
    energy_kcal: 257, carbs_g: 23, protein_g: 21, fat_g: 10,
    saturated_fat_g: 1, fiber_g: 2, sugar_g: 17,
    salt_g: 3.8, // 1507 mg × 2,5 / 1000, eine Nachkommastelle wie auf dem Etikett
  });
  // Antwort: geparstes Objekt, kein JSON-String.
  assert.deepEqual(r.body.data.nutrition, JSON.parse(row.nutrition));
});

test('POST /: kanonische Schluessel laufen unveraendert durch (Rueckschreiben der Antwort)', async () => {
  const r = await call('POST', '/', {
    title: 'Kanonisch',
    nutrition: { energy_kcal: 100, salt_g: 1.2 }, // nicht nutritionSummary
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data.nutrition, { energy_kcal: 100, salt_g: 1.2 });
});

test('POST /: leeres und ungueltiges nutritionSummary → NULL statt Fehler', async () => {
  const leer = await call('POST', '/', { title: 'Leer n', nutritionSummary: {} });
  assert.equal(leer.status, 201);
  assert.equal(leer.body.data.nutrition, null);

  const muell = await call('POST', '/', {
    title: 'Muell n',
    nutritionSummary: { calories: 'viel', protein: -5, cholesterol: 10 },
  });
  assert.equal(muell.status, 201); // kein 400 blockiert den Import
  assert.equal(muell.body.data.nutrition, null); // nichts Gueltiges uebrig
});

test('PUT /:id: nutrition ersetzt als Ganzes, weggelassen laesst stehen, leer loescht', async () => {
  const created = await call('POST', '/', {
    title: 'Naehrwert-PUT-Basis',
    nutritionSummary: { calories: '257', sodium: '1507' },
  });
  const id = created.body.data.id;

  // Weggelassen (Teil-Update): steht bleibt.
  const keep = await call('PUT', `/${id}`, { title: 'Naehrwert-PUT-Basis' });
  assert.equal(keep.status, 200);
  assert.deepEqual(keep.body.data.nutrition, { energy_kcal: 257, salt_g: 3.8 });

  // Mitgeschickt: ersetzt als Ganzes - alte Werte weg, auch die verschwundenen.
  const replace = await call('PUT', `/${id}`, {
    title: 'Naehrwert-PUT-Basis',
    nutrition: { energy_kcal: 300 },
  });
  assert.equal(replace.status, 200);
  assert.deepEqual(replace.body.data.nutrition, { energy_kcal: 300 });

  // Ausdruecklich geleert: null.
  const clear = await call('PUT', `/${id}`, { title: 'Naehrwert-PUT-Basis', nutritionSummary: {} });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.data.nutrition, null);
});

// --------------------------------------------------------------------------
// GET / (Aggregation, Join, Sortierung)
// --------------------------------------------------------------------------
test('GET /: Creator-Join, Zutaten aggregiert, NOCASE-Sortierung, meal_types normalisiert', async () => {
  // Frische Sicht: u.a. die bekannten Titel "Nudeln", "Pfannkuchen", "Zutatenprobe".
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  const titles = r.body.data.map((x) => x.title);
  // Der Test laeuft in einer Datei voller eigener Rezepte - die Tabelle als
  // GANZE zu behaupten hiesse, jede spaeter eingefuegte Zege haette diesen
  // Test kaputt. Gemessen wird, was dieser Test selbst anlegt: die drei
  // Titel, ihre NOCASE-ASC-Reihenfolge untereinander, und fuer die Probe
  // die vollstaendige Zeile (Creator-Join, Zutaten-Aggregation, meal_types).
  const known = ['Nudeln', 'Pfannkuchen', 'Zutatenprobe'];
  for (const title of known) assert.ok(titles.includes(title), `${title} fehlt in der Liste`);
  const knownSorted = titles.filter((t) => known.includes(t));
  assert.deepEqual(knownSorted, ['Nudeln', 'Pfannkuchen', 'Zutatenprobe'], 'NOCASE-ASC ist deterministisch (kein JS-Kollations-Orakel, das von SQLite abweichen k\u00f6nnte)');
  const probe = r.body.data.find((x) => x.title === 'Zutatenprobe');
  assert.equal(probe.creator_name, 'Owner');
  assert.equal(probe.creator_color, '#112233');
  assert.equal(probe.ingredients.length, 2);
  assert.ok(Array.isArray(probe.meal_types));
});

// --------------------------------------------------------------------------
// PUT /:id (Validierung, Auth-Gate, Replace-Set)
// --------------------------------------------------------------------------
test('PUT /:id: ungültige ID (0) → 400', async () => {
  const r = await call('PUT', '/0', { title: 'egal' });
  assert.equal(r.status, 400);
});

test('PUT /:id: nicht existent → 404', async () => {
  const r = await call('PUT', '/999999', { title: 'egal' });
  assert.equal(r.status, 404);
});

// #1577 (Entscheidung 30.09.2026): Rezepte gehoeren dem Haushalt. Wer das
// Modul schreiben darf, bearbeitet jedes Rezept - kein Besitzer-Riegel, und
// ausdruecklich auch fuer ein Mitglied ohne Admin-Rolle, denn die Regel ist
// das Modulrecht, nicht die Rolle. `meals: read` weist der Modul-Riegel in
// server/index.js ab (test-recipe-transfer-gate.js, echte Gates).
for (const who of [{ id: MEMBER2, role: 'member', label: 'anderes Mitglied' }, { id: ADMIN, role: 'admin', label: 'Admin' }]) {
  test(`PUT /:id: ${who.label} bearbeitet ein fremdes Rezept samt Zutaten (#1577)`, async () => {
    const own = await call('POST', '/', { title: 'Owners Rezept', notes: 'alt', ingredients: [{ name: 'Mehl' }] });
    const id = own.body.data.id;
    actor = { id: who.id, role: who.role };
    const r = await call('PUT', `/${id}`, { title: 'Verbessert', notes: 'neu', ingredients: [{ name: 'Dinkelmehl' }] });
    actor = { id: OWNER, role: 'member' };
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = db.prepare('SELECT title, notes, created_by FROM recipes WHERE id = ?').get(id);
    assert.equal(row.title, 'Verbessert');
    assert.equal(row.notes, 'neu');
    assert.equal(row.created_by, OWNER, 'wer es angelegt hat, bleibt stehen');
    assert.deepEqual(ingredientRows(id).map((x) => x.name), ['Dinkelmehl']);
  });
}

test('PUT /:id: Eigentümer aktualisiert Felder und ersetzt Zutaten (Replace-Set)', async () => {
  const created = await call('POST', '/', {
    title: 'Alt',
    meal_types: ['breakfast'],
    ingredients: [{ name: 'AltZutat', quantity: '1', category: 'Alt' }],
  });
  const id = created.body.data.id;
  const r = await call('PUT', `/${id}`, {
    title: 'Neu',
    notes: 'frisch',
    meal_types: ['dinner', 'dinner', 'unknown'],
    ingredients: [
      { name: 'NeuA', quantity: '2', category: 'Neu' },
      { name: 'NeuB', quantity: '', category: '' },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.title, 'Neu');
  assert.deepEqual(r.body.data.meal_types, ['dinner']);
  const rows = ingredientRows(id);
  assert.equal(rows.length, 2); // AltZutat ist weg (DELETE + Reinsert)
  assert.deepEqual(rows.map((x) => x.name), ['NeuA', 'NeuB']);
  assert.deepEqual(rows[1], { name: 'NeuB', quantity: null, category: 'Sonstiges' });
});

test('PUT /:id: Validierungsfehler → 400', async () => {
  const created = await call('POST', '/', { title: 'ValidBase' });
  const r = await call('PUT', `/${created.body.data.id}`, { title: '' });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// Neue Felder: cuisine, servings, cookTime, prepTime, diet, tags
// (Bindungs-Regressions: created_by war zuletzt auf cuisine gerutscht,
// PUT strzte mit unbenannten Validatoren - beides 500 "Internal error".)
// --------------------------------------------------------------------------
test('POST /: neue Felder landen in den richtigen Spalten; created_by bleibt der Akteur', async () => {
  const r = await call('POST', '/', {
    title: 'Ratatouille',
    cuisine: 'Französisch',
    servings: '4',
    cookTime: '45 min',
    prepTime: '20 min',
    diet: ['vegetarisch'],
    tags: ['Sommer', 'Gemüse'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.cuisine, 'Französisch');
  assert.equal(r.body.data.servings, '4');
  const row = db.prepare(`
    SELECT created_by, cuisine, cookTime, prepTime, diet, tags FROM recipes WHERE id = ?
  `).get(r.body.data.id);
  assert.equal(row.created_by, OWNER, 'Nicht-NULL-FK: die UserID muss in created_by stehen');
  assert.equal(row.cuisine, 'Französisch');
  assert.equal(row.cookTime, '45 min');
  assert.equal(row.prepTime, '20 min');
  assert.deepEqual(JSON.parse(row.diet), ['vegetarisch']);
  assert.deepEqual(JSON.parse(row.tags), ['Sommer', 'Gemüse']);
});

test('PUT /:id: neue Felder werden persistiert und ohne sie nicht angefasst', async () => {
  const created = await call('POST', '/', {
    title: 'Neue Felder PUT-Basis',
    cuisine: 'Italienisch',
    servings: '2',
    cookTime: '30 min',
    prepTime: '10 min',
  });
  const id = created.body.data.id;

  // Teil-Update ohne die neuen Felder: CASE-WHEN laesst sie stehen.
  const r1 = await call('PUT', `/${id}`, { title: 'Nur Titel' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  let row = db.prepare('SELECT cuisine, servings, cookTime, prepTime FROM recipes WHERE id = ?').get(id);
  assert.equal(row.cuisine, 'Italienisch');
  assert.equal(row.servings, '2');
  assert.equal(row.cookTime, '30 min');
  assert.equal(row.prepTime, '10 min');

  // Vollstaendiges Update schreibt die Werte um.
  const r2 = await call('PUT', `/${id}`, {
    title: 'Neue Felder PUT-Basis',
    cuisine: 'Spanisch',
    servings: '6',
    cookTime: '60 min',
    prepTime: '15 min',
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.data.cuisine, 'Spanisch');
  row = db.prepare('SELECT cuisine, servings, cookTime, prepTime FROM recipes WHERE id = ?').get(id);
  assert.equal(row.cuisine, 'Spanisch');
  assert.equal(row.servings, '6');
  assert.equal(row.cookTime, '60 min');
  assert.equal(row.prepTime, '15 min');
});

// --------------------------------------------------------------------------
// diet (v243): Die Antwort traegt ein ARRAY (withSource parst den JSON-Text),
// und der Server zieht Importer-Schreibweisen best-effort auf die kanonischen
// Schluessel - Unbekanntes bleibt wortgetreu, Dubletten nach der Normalisierung
// fallen zusammen (utils/recipe-diets.js, dort begruendet).
// --------------------------------------------------------------------------
test('POST /: diet kommt als Array zurueck, nicht als JSON-String', async () => {
  const r = await call('POST', '/', { title: 'Diet-Array', diet: ['vegan'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.diet, ['vegan'], 'die Antwort parst den JSON-Text');
});

test('POST /: Importer-Varianten werden normalisiert, Unbekanntes bleibt wortgetreu', async () => {
  const r = await call('POST', '/', {
    title: 'Diet-Normalisierung',
    diet: ['gf', 'Dairy Free', 'VEGAN', 'mediterranean', ''],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.diet, [
    'gluten-free',  // gf → Langform
    'dairy-free',   // Leerzeichen → Bindestrich, Kleinschreibung
    'vegan',        // Gross-/Kleinschreibung egal
    'mediterranean', // unbekannt: wortgetreu statt geraten
  ], 'leere Eintraege fallen weg');
  const row = db.prepare('SELECT diet FROM recipes WHERE id = ?').get(r.body.data.id);
  assert.deepEqual(JSON.parse(row.diet), ['gluten-free', 'dairy-free', 'vegan', 'mediterranean']);
});

test('POST /: normalisierte Dubletten fallen zusammen', async () => {
  const r = await call('POST', '/', {
    title: 'Diet-Dubletten',
    diet: ['gluten-free', 'gf', 'gluten free', 'Gluten-Free'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.diet, ['gluten-free']);
});

test('PUT /:id: diet ersetzt als Ganzes, weggelassen laesst stehen', async () => {
  const created = await call('POST', '/', {
    title: 'Diet-PUT-Basis',
    diet: ['vegan', 'gf'],
  });
  const id = created.body.data.id;
  assert.deepEqual(created.body.data.diet, ['vegan', 'gluten-free']);

  // Weggelassen (Teil-Update): steht bleibt.
  const keep = await call('PUT', `/${id}`, { title: 'Diet-PUT-Basis' });
  assert.equal(keep.status, 200);
  assert.deepEqual(keep.body.data.diet, ['vegan', 'gluten-free']);

  // Mitgeschickt: ersetzt als Ganzes.
  const replace = await call('PUT', `/${id}`, { title: 'Diet-PUT-Basis', diet: ['pescatarian'] });
  assert.equal(replace.status, 200, JSON.stringify(replace.body));
  assert.deepEqual(replace.body.data.diet, ['pescatarian']);
});

// v244: Abschnittstitel je Zutat ("Dry Ingredients", "Cream Cheese Glaze") -
// eine Eigenschaft der ZEILE, keine eigene Tabelle; die Ordnung der id-Spalte
// ist die Ordnung des Rezepts, und die Anzeige gruppiert nach FOLGE.
test('POST /: section wird je Zutat gespeichert, fehlende bleiben NULL', async () => {
  const r = await call('POST', '/', {
    title: 'Abschnitte',
    ingredients: [
      { name: 'Mehl', quantity: '2', unit: 'cups', section: 'Dry Ingredients' },
      { name: 'Zucker', quantity: '1', section: 'Dry Ingredients' }, // derselbe Folgetitel: keine neue Gruppe
      { name: 'Butter', quantity: '0.5', unit: 'cup', section: 'Glaze' },
      { name: 'Wasser', quantity: '1' },                               // ohne Abschnitt → NULL
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rows = db.prepare(`
    SELECT name, section FROM recipe_ingredients
    WHERE recipe_id = ? ORDER BY id ASC
  `).all(r.body.data.id);
  assert.deepEqual(rows, [
    { name: 'Mehl', section: 'Dry Ingredients' },
    { name: 'Zucker', section: 'Dry Ingredients' },
    { name: 'Butter', section: 'Glaze' },
    { name: 'Wasser', section: null },
  ]);
  // Die Antwort traegt den Abschnitt je Zutat (SELECT * uebernimmt die Spalte).
  assert.equal(r.body.data.ingredients[0].section, 'Dry Ingredients');
});

test('PUT /:id: Abschnitte ueberstehen das Ersetzen, leere loeschen', async () => {
  const created = await call('POST', '/', {
    title: 'Abschnitte-PUT-Basis',
    ingredients: [{ name: 'Mehl', section: 'Dry Ingredients' }],
  });
  const id = created.body.data.id;

  const r = await call('PUT', `/${id}`, {
    title: 'Abschnitte-PUT-Basis',
    ingredients: [
      { name: 'Mehl', section: 'Dry Ingredients' },
      { name: 'Butter', section: '' }, // leer → NULL, wie quantity/unit
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = db.prepare(`
    SELECT name, section FROM recipe_ingredients
    WHERE recipe_id = ? ORDER BY id ASC
  `).all(id);
  assert.deepEqual(rows, [
    { name: 'Mehl', section: 'Dry Ingredients' },
    { name: 'Butter', section: null },
  ]);
});

// --------------------------------------------------------------------------
// notes als Array (API-Import): Eintraege werden zu nummerierten Schritten
// --------------------------------------------------------------------------
test('POST /: notes als Array → Eintraege werden zu nummerierten Schritten', async () => {
  const r = await call('POST', '/', {
    title: 'Hähnchen-Spieße',
    notes: [
      'Mix all of the marinade ingredients together.',
      'Pan Sear: Cook the vegetables in a hot skillet over medium-high heat for 6–8 minutes. Then add the chicken.\nGrill: Thread marinated chicken onto skewers.\nBroil: Preheat the oven to broil (500°F)',
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = db.prepare('SELECT notes FROM recipes WHERE id = ?').get(r.body.data.id);
  // Nur die ARRAY-Teile werden nummeriert; Zeilenumbrueche INNERHALB eines
  // Eintrags bleiben Teil desselben Schritts.
  assert.equal(row.notes,
    'Step 1.\nMix all of the marinade ingredients together.\n\n'
    + 'Step 2.\nPan Sear: Cook the vegetables in a hot skillet over medium-high heat for 6–8 minutes. Then add the chicken.\n'
    + 'Grill: Thread marinated chicken onto skewers.\n'
    + 'Broil: Preheat the oven to broil (500°F)');
});

test('POST /: notes als Eintrag-Array → Text bleibt unnummeriert', async () => {
  const r = await call('POST', '/', { title: 'Ein Schritt', notes: ['Nur ein Schritt.'] });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.notes, 'Nur ein Schritt.');
});

test('POST /: leeres notes-Array → NULL, kein Fehler; leere Eintraege fallen weg', async () => {
  const leer = await call('POST', '/', { title: 'Leer', notes: [] });
  assert.equal(leer.status, 201);
  const rowLeer = db.prepare('SELECT notes FROM recipes WHERE id = ?').get(leer.body.data.id);
  assert.equal(rowLeer.notes, null);

  const r = await call('POST', '/', { title: 'Löcher', notes: ['  ', 'Erster', '', '  ', 'Zweiter'] });
  assert.equal(r.status, 201);
  const row = db.prepare('SELECT notes FROM recipes WHERE id = ?').get(r.body.data.id);
  // Leere Eintraege bekommen keine eigene Nummer - die Schritte zaehlen, nicht
  // die Felder.
  assert.equal(row.notes, 'Step 1.\nErster\n\nStep 2.\nZweiter');
});

test('PUT /:id: notes als Array ersetzt den Text mit nummerierten Schritten', async () => {
  const created = await call('POST', '/', { title: 'PUT-Notizen-Basis', notes: 'alter Fließtext' });
  const id = created.body.data.id;
  const r = await call('PUT', `/${id}`, {
    title: 'PUT-Notizen-Basis',
    notes: ['Schritt eins.', 'Schritt zwei.'],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = db.prepare('SELECT notes FROM recipes WHERE id = ?').get(id);
  assert.equal(row.notes, 'Step 1.\nSchritt eins.\n\nStep 2.\nSchritt zwei.');
});

// --------------------------------------------------------------------------
// 'Miscellaneous' = 'Sonstiges' (englische Anzeige): Normalisierung vor der
// Kategorisierung - Miscellaneous-Importe werden AUTOKATEGORISIERT, andere
// ausdruecklich gesetzte Kategorien bleiben unangetastet.
// --------------------------------------------------------------------------
test('POST /: category "Miscellaneous" wird zu Sonstiges normalisiert und autokategorisiert', async () => {
  const r = await call('POST', '/', {
    title: 'Misc-Normalisierung POST',
    ingredients: [
      // garlic → Produce (ganzes Wort im Namen), Miscellaneous löst es aus
      { name: 'garlic,', quantity: '3', unit: 'cloves', category: 'Miscellaneous' },
      // Unbekannter Name ohne Stichwort → bleibt Sonstiges (Fallback)
      { name: 'XYZ-Sondermehl', category: 'Miscellaneous' },
      // Kleinschreibung trifft ebenfalls
      { name: 'XYZ-Sondermilch', category: ' miscellaneous ' },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rows = ingredientRows(r.body.data.id);
  assert.equal(rows[0].category, 'Produce');
  assert.equal(rows[1].category, 'Sonstiges');
  assert.equal(rows[2].category, 'Sonstiges');
});

test('POST /: ausdruecklich gesetzte Kategorien bleiben erhalten', async () => {
  const r = await call('POST', '/', {
    title: 'Explizite Kategorie',
    ingredients: [
      { name: 'garlic', category: 'Backwaren' },       // gesetzt, NICHT umkategorisiert
      { name: 'Mehl', category: '' },                   // leer → Autokategorie
      { name: 'Schokolade', category: 'Produce' },      // fremder aber gültiger Name bleibt stehen
    ],
  });
  assert.equal(r.status, 201);
  const rows = ingredientRows(r.body.data.id);
  assert.equal(rows[0].category, 'Backwaren');
  assert.equal(rows[1].category, 'Backwaren'); // 'Mehl' → Stichwort in Backwaren
  assert.equal(rows[2].category, 'Produce');
});

test('PUT /:id: Miscellaneous wird auch beim Ersetzen normalisiert', async () => {
  const created = await call('POST', '/', {
    title: 'Misc-Normalisierung PUT-Basis',
    ingredients: [{ name: 'garlic', category: 'Miscellaneous' }],
  });
  const id = created.body.data.id;
  const r = await call('PUT', `/${id}`, {
    title: 'Misc-Normalisierung PUT-Basis',
    ingredients: [
      { name: 'tomato', category: 'Miscellaneous' },   // → Produce
      { name: 'XYZ-Nichts', category: 'Miscellaneous' }, // → Sonstiges
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = ingredientRows(id);
  assert.equal(rows[0].category, 'Produce');
  assert.equal(rows[1].category, 'Sonstiges');
});

// --------------------------------------------------------------------------
// DELETE /:id (Validierung, Auth-Gate, CASCADE)
// --------------------------------------------------------------------------
test('DELETE /:id: ungültige ID → 400', async () => {
  const r = await call('DELETE', '/0');
  assert.equal(r.status, 400);
});

test('DELETE /:id: nicht existent → 404', async () => {
  const r = await call('DELETE', '/999999');
  assert.equal(r.status, 404);
});

for (const who of [{ id: MEMBER2, role: 'member', label: 'anderes Mitglied' }, { id: ADMIN, role: 'admin', label: 'Admin' }]) {
  test(`DELETE /:id: ${who.label} löscht ein fremdes Rezept → 204 (#1577)`, async () => {
    const own = await call('POST', '/', { title: 'Fremd gelöscht', ingredients: [{ name: 'Z' }] });
    const id = own.body.data.id;
    actor = { id: who.id, role: who.role };
    const r = await call('DELETE', `/${id}`);
    actor = { id: OWNER, role: 'member' };
    assert.equal(r.status, 204);
    assert.equal(db.prepare('SELECT id FROM recipes WHERE id = ?').get(id), undefined);
    assert.equal(ingredientRows(id).length, 0);
  });
}

test('DELETE /:id: Eigentümer löscht → 204, Zutaten kaskadieren mit', async () => {
  const created = await call('POST', '/', {
    title: 'ToDelete',
    ingredients: [{ name: 'Z1' }, { name: 'Z2' }],
  });
  const id = created.body.data.id;
  assert.equal(ingredientRows(id).length, 2);
  const r = await call('DELETE', `/${id}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT id FROM recipes WHERE id = ?').get(id), undefined);
  assert.equal(ingredientRows(id).length, 0); // CASCADE
});

// --------------------------------------------------------------------------
// POST /:id/to-shopping-list (Zutaten → Einkaufsliste)
// --------------------------------------------------------------------------

function shoppingItems(listId) {
  return db.prepare('SELECT name, quantity, category, is_checked FROM shopping_items WHERE list_id = ? ORDER BY id ASC').all(listId);
}

function newList(name) {
  return db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run(name, OWNER).lastInsertRowid;
}

test('POST /:id/to-shopping-list: überträgt Zutaten mit Menge und Kategorie', async () => {
  const listId = newList('Transfer A');
  const created = await call('POST', '/', {
    title: 'Transfer-Rezept',
    ingredients: [
      { name: 'Mehl', quantity: '500 g', category: 'Backen' },
      { name: 'Milch', quantity: '1 l' },
    ],
  });
  const r = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });

  assert.equal(r.status, 200);
  assert.deepEqual({ transferred: r.body.data.transferred, skipped: r.body.data.skipped }, { transferred: 2, skipped: 0 });
  assert.deepEqual(r.body.data.added_ids.length, 2);
  const items = shoppingItems(listId);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Mehl');
  assert.equal(items[0].quantity, '500 g');
  assert.equal(items[0].category, 'Backen');
  // Die Zutat kam ohne Kategorie an und wurde beim Speichern vom Stichwort-
  // Rater bedacht: 'Milch' → Milchprodukte. Der Transfer uebernimmt die
  // gespeicherte Zutaten-Kategorie (Vorrat hat Vorrang, gibt es hier nicht).
  assert.equal(items[1].category, 'Milchprodukte');
});

// v237: getrennte Menge und Einheit werden beim Uebertrag wieder zu EINEM Text
// zusammengezogen - die Einkaufsliste kennt nur ein Mengenfeld, und
// shopping-import.js#parseQuantity liest es mit einer Regex wieder ein.
test('POST /:id/to-shopping-list: amount+unit verschmelzen zur Einkaufs-Menge', async () => {
  const listId = newList('Transfer Unit');
  const created = await call('POST', '/', {
    title: 'Einheiten-Transfer',
    ingredients: [
      { name: 'Mehl', quantity: '500', unit: 'g' },
      { name: 'Salz', unit: 'Prise' },        // keine Menge: nur die Einheit steht dann da
      { name: 'Eier', quantity: '6' },        // keine Einheit: Menge bleibt allein
    ],
  });
  const r = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });
  assert.equal(r.status, 200);

  const items = shoppingItems(listId);
  assert.deepEqual(items.map((i) => [i.name, i.quantity]), [
    ['Mehl', '500 g'],
    ['Salz', 'Prise'],
    ['Eier', '6'],
  ]);
});

test('POST /:id/to-shopping-list: überspringt, was unabgehakt schon auf der Liste liegt', async () => {
  const listId = newList('Transfer B');
  const created = await call('POST', '/', {
    title: 'Doppelt',
    ingredients: [{ name: 'Butter' }, { name: 'Eier' }],
  });
  const id = created.body.data.id;

  const first = await call('POST', `/${id}/to-shopping-list`, { listId });
  assert.equal(first.body.data.transferred, 2);

  // Zweiter Lauf darf die Liste nicht verdoppeln - ein Rezept ist eine Vorlage,
  // die mehrfach gekocht wird, und trägt kein „schon übertragen"-Flag.
  const second = await call('POST', `/${id}/to-shopping-list`, { listId });
  assert.deepEqual(second.body.data, { transferred: 0, skipped: 2, added_ids: [] });
  assert.equal(shoppingItems(listId).length, 2);
});

test('POST /:id/to-shopping-list: abgehakte Artikel blockieren die Übernahme nicht', async () => {
  const listId = newList('Transfer C');
  const created = await call('POST', '/', { title: 'Nachkauf', ingredients: [{ name: 'Salz' }] });
  const id = created.body.data.id;

  await call('POST', `/${id}/to-shopping-list`, { listId });
  db.prepare('UPDATE shopping_items SET is_checked = 1 WHERE list_id = ?').run(listId);

  // Bereits gekauft und abgehakt → beim nächsten Kochen wieder aufnehmen.
  const again = await call('POST', `/${id}/to-shopping-list`, { listId });
  assert.equal(again.body.data.transferred, 1);
  assert.equal(shoppingItems(listId).length, 2);
});

test('POST /:id/to-shopping-list: Rezept ohne Zutaten → 0/0 statt Fehler', async () => {
  const listId = newList('Transfer D');
  const created = await call('POST', '/', { title: 'Leer', ingredients: [] });
  const r = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { transferred: 0, skipped: 0, added_ids: [] });
});

test('POST /:id/to-shopping-list: fehlende oder unbekannte Liste → 400/404', async () => {
  const created = await call('POST', '/', { title: 'Ziel', ingredients: [{ name: 'X' }] });
  const id = created.body.data.id;

  const noList = await call('POST', `/${id}/to-shopping-list`, {});
  assert.equal(noList.status, 400);

  const badList = await call('POST', `/${id}/to-shopping-list`, { listId: 999999 });
  assert.equal(badList.status, 404);
});

test('POST /:id/to-shopping-list: unbekanntes Rezept → 404', async () => {
  const listId = newList('Transfer E');
  const r = await call('POST', '/999999/to-shopping-list', { listId });
  assert.equal(r.status, 404);
});

test('POST /:id/to-shopping-list: Nicht-Eigentümer darf übernehmen (kein owner-Gate)', async () => {
  const listId = newList('Transfer F');
  const created = await call('POST', '/', { title: 'Geteilt', ingredients: [{ name: 'Reis' }] });
  const id = created.body.data.id;

  // Rezepte sind Haushaltswissen: wer kocht, darf einkaufen - wie bei
  // PUT/DELETE gibt es keinen Besitzer-Riegel (#1577).
  actor = { id: ADMIN, role: 'admin' };
  const r = await call('POST', `/${id}/to-shopping-list`, { listId });
  actor = { id: OWNER, role: 'member' };
  assert.equal(r.status, 200);
  assert.equal(r.body.data.transferred, 1);
});

// Teilwahl (2026-10-21): der Client kann Zutaten ankreuzen; fehlt das Feld,
// bleibt der Weg wie er war - jeder bestaehende Client, Token und Test unberuehrt.
test('POST /:id/to-shopping-list: ingredientIds überträgt nur die gewählten Zeilen', async () => {
  const listId = newList('Transfer Teilwahl');
  const created = await call('POST', '/', {
    title: 'Teilwahl',
    ingredients: [{ name: 'Mehl' }, { name: 'Eier' }, { name: 'Salz' }],
  });
  const id = created.body.data.id;
  const rows = db.prepare('SELECT id, name FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC').all(id);
  const picked = [rows[0].id, rows[2].id];

  const r = await call('POST', `/${id}/to-shopping-list`, { listId, ingredientIds: picked });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.added_ids.length, 2);
  // Nur Mehl und Salz: das Ei blieb ungewaehlt und darf die Liste nie erreichen.
  assert.deepEqual(shoppingItems(listId).map((i) => i.name), ['Mehl', 'Salz']);
});

test('POST /:id/to-shopping-list: fremde Zutat-ID in der Auswahl → 400, nichts halb', async () => {
  const listId = newList('Transfer Fremd');
  const own = await call('POST', '/', { title: 'Eigenes', ingredients: [{ name: 'Z1' }] });
  const other = await call('POST', '/', { title: 'Anderes', ingredients: [{ name: 'Z2' }] });
  const otherRow = db.prepare('SELECT id FROM recipe_ingredients WHERE recipe_id = ?').get(other.body.data.id);

  // Eine ID eines ANDEREN Rezepts stillschweigend zu uebergehen wuerde eine
  // halbe Wahrheit zurueckgeben: die Antwort erscheint erfolgreich, aber ein
  // Teil der Auswahl kam nie an.
  const r = await call('POST', `/${own.body.data.id}/to-shopping-list`, { listId, ingredientIds: [otherRow.id] });
  assert.equal(r.status, 400);
  assert.deepEqual(shoppingItems(listId), []);
});

test('POST /:id/to-shopping-list: leere oder unsinnige Auswahl → 400', async () => {
  const created = await call('POST', '/', { title: 'Unsinn', ingredients: [{ name: 'Z3' }] });
  const id = created.body.data.id;

  // Eine leere Auswahl ist das FEHLEN einer Auswahl - der Client sendet das
  // Feld nur, wenn mindestens ein Kaetzchen steht.
  const empty = await call('POST', `/${id}/to-shopping-list`, { listId: newList('T leer'), ingredientIds: [] });
  assert.equal(empty.status, 400);

  const str = await call('POST', `/${id}/to-shopping-list`, { listId: newList('T String'), ingredientIds: ['x'] });
  assert.equal(str.status, 400);

  const neg = await call('POST', `/${id}/to-shopping-list`, { listId: newList('T negativ'), ingredientIds: [-1] });
  assert.equal(neg.status, 400);
});

test('POST /:id/to-shopping-list: doppelte IDs in der Auswahl → eine Zeile, kein Fehler', async () => {
  const listId = newList('Transfer Dublette');
  const created = await call('POST', '/', { title: 'Dublette', ingredients: [{ name: 'Z4' }] });
  const row = db.prepare('SELECT id FROM recipe_ingredients WHERE recipe_id = ?').get(created.body.data.id);

  // Der Client dedupliziert nicht - ein doppeltes Kaetzchen derselben Zeile
  // (Aufklapper UND Spalte teilen die Auswahl) darf keinen 400 oder zwei
  // Artikel geben. Der Server faltet.
  const r = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId, ingredientIds: [row.id, row.id] });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.transferred, 1);
  assert.equal(shoppingItems(listId).length, 1);
});

// Vorrats-Kategorie vor Zutaten-Kategorie (services/shopping-pantry-category.js):
// Fuehrt der Haushalt dieselbe Ware schon im Vorrat - MIT Nachkaufregel, wie bei
// der Handanlage -, gibt DER seine Kategorie her. Ohne Treffer bleibt die
// Zutaten-Kategorie stehen, und ein Vorratseintrag OHNE Nachkaufregel zaehlt
// nicht - die Handanlage vergleicht aus denselben Gruenden genauso.
test('POST /:id/to-shopping-list: Vorrats-Kategorie gewinnt bei gleichem Namen', async () => {
  const listId = newList('Transfer Vorrat');
  db.prepare(`
    INSERT INTO pantry_items (name, category, restock_interval_days, created_by)
    VALUES ('Olivenöl', 'Vorrats-Öle', 14, ?)
  `).run(OWNER);
  // Ohne Nachkaufregel: vom Haushalt nie als "kaufe ich nach" behauptet.
  db.prepare(`
    INSERT INTO pantry_items (name, category, created_by)
    VALUES ('Sesam', 'Vorrats-ohne-Regel', ?)
  `).run(OWNER);

  const created = await call('POST', '/', {
    title: 'Vorrats-Transfer',
    ingredients: [
      { name: 'olivenöl', category: 'Produce' },      // Gross/Klein ignoriert → Vorrat gewinnt
      { name: 'Sesam', category: 'Sonstiges' },       // keine Regel am Vorrat → Zutaten-Kategorie
      { name: 'Kreuzkümmel', category: 'Gewürze' },   // gar kein Vorrat → Zutaten-Kategorie
    ],
  });
  const r = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const items = shoppingItems(listId);
  assert.deepEqual(items.map((i) => [i.name, i.category]), [
    ['olivenöl', 'Vorrats-Öle'],
    ['Sesam', 'Sonstiges'],
    ['Kreuzkümmel', 'Gewürze'],
  ]);
});

// Der Rezept-Transfer ist der Pfad, der am meisten auf einmal ueberträgt - eine
// ganze Zutatenliste, in eine Liste, die der Nutzer gerade nicht ansieht. Ohne
// added_ids gaebe es nichts zurueckzunehmen (Audit 2026-07-30, P1-B).
test('POST /:id/to-shopping-list: added_ids erlauben ein exaktes Zuruecknehmen', async () => {
  const listId = newList('Transfer Undo');
  db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)').run(listId, 'Bleibt drin');

  const created = await call('POST', '/', {
    title: 'Ruecknahme',
    ingredients: [{ name: 'Zwiebel' }, { name: 'Knoblauch' }],
  });
  const r = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });
  assert.equal(r.body.data.transferred, 2);
  assert.equal(r.body.data.added_ids.length, 2);

  const undo = await call('POST', '/shopping/items/undo-transfer', { ids: r.body.data.added_ids });
  assert.equal(undo.body.data.removed, 2);
  assert.deepEqual(shoppingItems(listId).map((i) => i.name), ['Bleibt drin']);

  // Ein Rezept ist eine Vorlage: nach der Ruecknahme laesst es sich erneut
  // uebertragen, weil am Rezept nichts markiert wird.
  const again = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });
  assert.equal(again.body.data.transferred, 2);
});

// #1608: Jeder Weg auf die Liste ist ein Einkaufs-Signal - auch der Rezept-
// Transfer lernt die Nachkauf-Regel gleichnamiger Vorratszeilen wie die Hand-
// anlage. Nur was WIRKLICH neu anlegt wird, lernt; uebersprungene Dubletten
// lagen schon auf der Liste und haben beim Anlegen gelernt.
test('POST /:id/to-shopping-list: Transfer lernt die Nachkauf-Regel (#1608)', async () => {
  const listId = newList('Transfer Lernen');
  const DAY = 24 * 60 * 60 * 1000;
  const purchasedAt = new Date(Date.now() - 25 * DAY).toISOString();
  const butterId = Number(db.prepare(`
    INSERT INTO pantry_items (name, category, restock_interval_days, last_purchased_at, created_by)
    VALUES ('Lern-Butter', 'Vorrats-Kuehl', 90, ?, ?)
  `).run(purchasedAt, OWNER).lastInsertRowid);
  const regel = (id) => db.prepare('SELECT restock_interval_days d FROM pantry_items WHERE id = ?').get(id).d;

  const created = await call('POST', '/', {
    title: 'Lern-Rezept',
    ingredients: [{ name: 'lern-butter' }, { name: 'Muskat' }],
  });
  const r = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });
  assert.equal(r.body.data.transferred, 2);
  assert.equal(regel(butterId), 25, 'die Regel folgt der Taktung seit dem letzten Einkauf');

  // Zweiter Lauf ueberspringt alles - kein neues Signal, kein erneutes Lernen.
  await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });
  assert.equal(regel(butterId), 25, 'uebersprungene Dubletten lernen nicht noch einmal');
});

// --------------------------------------------------------------------------
// Recipe-Provider-Mirror: source-Feld, PUT/DELETE-Gate für gespiegelte Rezepte,
// GET /:id/provider-thumbnail. Läuft einmal je unterstütztem Provider (mealie,
// tandoor), um zu belegen, dass der generalisierte Code-Pfad nicht heimlich
// noch Mealie-spezifisch ist.
// --------------------------------------------------------------------------

// Ein Account je Provider reicht für alle Tests (base_url ist UNIQUE); jedes
// Rezept braucht nur eine eigene provider_recipe_id, um den Partial-Unique-Index
// (provider_account_id, provider_recipe_id) nicht zu verletzen.
const PROVIDER_ACCOUNTS = {
  mealie: {
    name: 'Testkonto',
    id: db.prepare(`
      INSERT INTO recipe_provider_accounts (name, base_url, api_token, provider, created_by) VALUES ('Testkonto', 'https://mealie.example.com', 'tok', 'mealie', ?)
    `).run(OWNER).lastInsertRowid,
  },
  tandoor: {
    name: 'Tandoor-Testkonto',
    id: db.prepare(`
      INSERT INTO recipe_provider_accounts (name, base_url, api_token, provider, created_by) VALUES ('Tandoor-Testkonto', 'https://tandoor.example.com', 'tok', 'tandoor', ?)
    `).run(OWNER).lastInsertRowid,
  },
};

function mirroredRecipe(title, providerRecipeId, provider = 'mealie') {
  const accountId = PROVIDER_ACCOUNTS[provider].id;
  const recipeId = db.prepare(`
    INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id) VALUES (?, ?, ?, ?)
  `).run(title, OWNER, accountId, providerRecipeId).lastInsertRowid;
  return { accountId, recipeId, provider };
}

test.after(() => recipeProviders._setAdapterFactory(null));

test('GET /:id/provider-thumbnail: natives Rezept → 404', async () => {
  const native = await call('POST', '/', { title: 'Kein Provider' });
  const r = await call('GET', `/${native.body.data.id}/provider-thumbnail`);
  assert.equal(r.status, 404);
});

function registerMirrorTests(provider) {
  const { name: accountName, id: accountId } = PROVIDER_ACCOUNTS[provider];

  test(`GET /: native Rezept trägt source "native", gespiegeltes trägt "${provider}" + Account-Name`, async () => {
    const native = await call('POST', '/', { title: 'Eigenes Rezept' });
    const { recipeId } = mirroredRecipe(`${provider}-Rezept`, `mirror-source-test-${provider}`, provider);

    const r = await call('GET', '/');
    const nativeRow = r.body.data.find((x) => x.id === native.body.data.id);
    const mirroredRow = r.body.data.find((x) => x.id === recipeId);

    assert.equal(nativeRow.source, 'native');
    assert.equal(mirroredRow.source, provider);
    assert.equal(mirroredRow.provider_account_name, accountName);
  });

  test(`PUT /:id: gespiegeltes Rezept (${provider}) → 403, auch für den Nutzer, der den Account angelegt hat`, async () => {
    const { recipeId } = mirroredRecipe('Unveränderlich', `mirror-put-test-${provider}`, provider);
    // OWNER ist zugleich created_by dieses Mirror-Rezepts (via recipe_provider_accounts.created_by),
    // MEMBER2 ist es nicht - seit #1577 gibt es keinen Besitzer-Riegel mehr, also
    // muss das provider_account_id-Gate fuer beide allein greifen.
    const r = await call('PUT', `/${recipeId}`, { title: 'Gehackt' });
    assert.equal(r.status, 403);
    actor = { id: MEMBER2, role: 'member' };
    const r2 = await call('PUT', `/${recipeId}`, { title: 'Gehackt' });
    actor = { id: OWNER, role: 'member' };
    assert.equal(r2.status, 403);
    assert.match(r2.body.error, /Mirrored/);
    const row = db.prepare('SELECT title FROM recipes WHERE id = ?').get(recipeId);
    assert.equal(row.title, 'Unveränderlich');
  });

  test(`DELETE /:id: gespiegeltes Rezept (${provider}) → 403`, async () => {
    const { recipeId } = mirroredRecipe('Unlöschbar', `mirror-delete-test-${provider}`, provider);
    const r = await call('DELETE', `/${recipeId}`);
    assert.equal(r.status, 403);
    actor = { id: MEMBER2, role: 'member' };
    const r2 = await call('DELETE', `/${recipeId}`);
    actor = { id: OWNER, role: 'member' };
    assert.equal(r2.status, 403);
    assert.match(r2.body.error, /Mirrored/);
    assert.ok(db.prepare('SELECT id FROM recipes WHERE id = ?').get(recipeId));
  });

  test(`POST /:id/to-shopping-list: funktioniert unverändert für gespiegelte Rezepte (${provider})`, async () => {
    const listId = newList(`Transfer ${provider}`);
    const { recipeId } = mirroredRecipe(`${provider}-Transfer`, `mirror-shopping-test-${provider}`, provider);
    db.prepare(`INSERT INTO recipe_ingredients (recipe_id, name, quantity, category) VALUES (?, 'Reis', '1 kg', 'Sonstiges')`).run(recipeId);

    const r = await call('POST', `/${recipeId}/to-shopping-list`, { listId });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.transferred, 1);
    assert.equal(r.body.data.added_ids.length, 1);
  });

  test(`GET /:id/provider-thumbnail: gespiegelt (${provider}), aber provider_has_image=0 → 404, Adapter wird nicht aufgerufen`, async () => {
    const recipeId = db.prepare(`
      INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_has_image) VALUES (?, ?, ?, ?, 0)
    `).run('Ohne Bild', OWNER, accountId, `thumb-none-${provider}`).lastInsertRowid;
    recipeProviders._setAdapterFactory(() => ({
      fetchThumbnail: async () => { throw new Error('sollte nicht aufgerufen werden'); },
    }));
    const r = await call('GET', `/${recipeId}/provider-thumbnail`);
    recipeProviders._setAdapterFactory(null);
    assert.equal(r.status, 404);
  });

  test(`GET /:id/provider-thumbnail: proxied Bytes und Content-Type vom Fake-Adapter (${provider})`, async () => {
    const recipeId = db.prepare(`
      INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_slug, provider_has_image) VALUES (?, ?, ?, ?, ?, 1)
    `).run('Mit Bild', OWNER, accountId, `thumb-yes-${provider}`, `slug-yes-${provider}`).lastInsertRowid;

    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    recipeProviders._setAdapterFactory(() => ({
      fetchThumbnail: async ({ id, slug }) => {
        assert.equal(id, `thumb-yes-${provider}`);
        assert.equal(slug, `slug-yes-${provider}`);
        return { buffer: png1x1, mime: 'image/png' };
      },
    }));

    const res = await fetch(`${baseUrl}/${recipeId}/provider-thumbnail`);
    recipeProviders._setAdapterFactory(null);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, png1x1.length);
  });

  test(`GET /:id/provider-thumbnail: Bild seit letztem Sync beim Provider gelöscht (404 vom Adapter, ${provider}) → 404 statt 500`, async () => {
    const recipeId = db.prepare(`
      INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_has_image) VALUES (?, ?, ?, ?, 1)
    `).run('Geloescht', OWNER, accountId, `thumb-gone-${provider}`).lastInsertRowid;
    recipeProviders._setAdapterFactory(() => ({
      fetchThumbnail: async () => { const err = new Error('Thumbnail request failed (404)'); err.status = 404; throw err; },
    }));
    const r = await call('GET', `/${recipeId}/provider-thumbnail`);
    recipeProviders._setAdapterFactory(null);
    assert.equal(r.status, 404);
  });

  test(`GET /:id/provider-thumbnail: nicht in der MIME-Allowlist (z. B. SVG, ${provider}) → 415`, async () => {
    const recipeId = db.prepare(`
      INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_has_image) VALUES (?, ?, ?, ?, 1)
    `).run('SVG', OWNER, accountId, `thumb-svg-${provider}`).lastInsertRowid;
    recipeProviders._setAdapterFactory(() => ({
      fetchThumbnail: async () => ({ buffer: Buffer.from('<svg/>'), mime: 'image/svg+xml' }),
    }));
    const r = await call('GET', `/${recipeId}/provider-thumbnail`);
    recipeProviders._setAdapterFactory(null);
    assert.equal(r.status, 415);
  });
}

registerMirrorTests('mealie');
registerMirrorTests('tandoor');

// --------------------------------------------------------------------------
// #750: Eine leere Auswahl ist eine Antwort, keine Lücke. Vorher machte die
// Normalisierung daraus stillschweigend alle vier Mahlzeiten - sichtbar erst,
// wenn der Nutzer das Rezept wieder zum Bearbeiten öffnete.
// --------------------------------------------------------------------------

test('POST /: eine leere meal_types-Liste bleibt leer (#750)', async () => {
  const r = await call('POST', '/', { title: 'Grundbrühe', meal_types: [] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data.meal_types, [], 'die Abwahl darf nicht in alle vier umschlagen');
  const row = db.prepare('SELECT meal_types FROM recipes WHERE id = ?').get(r.body.data.id);
  assert.equal(row.meal_types, '', 'in der Spalte steht der leere Wert, nicht die volle Liste');
});

test('PUT /:id: die leere Auswahl übersteht das erneute Öffnen (#750)', async () => {
  // Der gemeldete Ablauf: anlegen, alle Haken entfernen, speichern, wieder
  // öffnen. Genau hier standen vorher wieder alle vier Haken.
  const created = await call('POST', '/', { title: 'Fond', meal_types: ['dinner'] });
  const id = created.body.data.id;

  const cleared = await call('PUT', `/${id}`, { title: 'Fond', meal_types: [] });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.data.meal_types, []);

  // Das Formular befüllt sich aus der Liste (ein GET /:id gibt es nicht), also
  // muss der leere Stand genau dort ankommen - das war die Stelle, an der
  // vorher wieder alle vier Haken standen.
  const list = await call('GET', '/');
  const reopened = list.body.data.find((x) => x.id === id);
  assert.deepEqual(reopened.meal_types, []);
});

test('PUT /:id: ein Teil-Update ohne meal_types lässt die Auswahl stehen (#750)', async () => {
  // Sonst nähme jeder Aufruf, der das Feld nicht mitschickt, die bewusst leere
  // Auswahl wieder mit - die Nachbar-Falle des eigentlichen Fehlers.
  const created = await call('POST', '/', { title: 'Sud', meal_types: [] });
  const id = created.body.data.id;

  const renamed = await call('PUT', `/${id}`, { title: 'Sud, verfeinert' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body.data.meal_types, []);

  const kept = db.prepare('SELECT title, meal_types FROM recipes WHERE id = ?').get(id);
  assert.equal(kept.title, 'Sud, verfeinert');
  assert.equal(kept.meal_types, '');
});

// --------------------------------------------------------
// Eigenes Rezeptbild (#1059, Schritt 2)
// --------------------------------------------------------

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('POST /recipes: ein eigenes Bild wird gespeichert, aber nie mitgeliefert', async () => {
  const r = await call('POST', '/', { title: 'Mit Bild', image_data: PNG_1X1 });
  assert.equal(r.status, 201);
  // DIE DATEN SELBST GEHEN NIE MIT: eine Data-URL von bis zu 5 MB in jeder
  // Listenzeile waere ein Vielfaches der Antwort, fuer eine 32px-Vorschau.
  assert.equal(r.body.data.image_data, undefined, 'image_data darf nicht in der Antwort stehen');
  assert.equal(r.body.data.has_own_image, true, 'das Flag sagt, dass es eins gibt');
});

test('GET /recipes: die Liste traegt das Flag, nicht das Bild', async () => {
  const r = await call('GET', '/');
  const mitBild = r.body.data.find((x) => x.title === 'Mit Bild');
  assert.ok(mitBild, 'das Rezept muss in der Liste stehen');
  assert.equal(mitBild.image_data, undefined);
  assert.equal(mitBild.has_own_image, true);
});

test('GET /recipes/:id/image liefert das Bild als Datei', async () => {
  const created = await call('POST', '/', { title: 'Bildabruf', image_data: PNG_1X1 });
  const res = await fetch(`${baseUrl}/${created.body.data.id}/image`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  // Das Bild steht im Browser-Cache sonst bis zu einer Stunde - auch nach dem Abmelden.
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 0, 'die Datei darf nicht leer sein');
});

test('GET /recipes/:id/image: ohne Bild 404', async () => {
  const ohne = await call('POST', '/', { title: 'Ohne Bild' });
  assert.equal(ohne.body.data.has_own_image, false);
  const res = await fetch(`${baseUrl}/${ohne.body.data.id}/image`);
  assert.equal(res.status, 404);
});

test('PUT /recipes: ohne das Feld bleibt das Bild stehen, null loescht es', async () => {
  // Der wichtigere Fall ist der erste: ein Speichern, das nur den Titel aendert,
  // darf das Bild nicht stillschweigend abraeumen - und es auch nicht erneut
  // hochladen muessen.
  const created = await call('POST', '/', { title: 'Bleibt', image_data: PNG_1X1 });
  const id = created.body.data.id;

  const ohneFeld = await call('PUT', `/${id}`, { title: 'Bleibt, neuer Titel' });
  assert.equal(ohneFeld.body.data.has_own_image, true, 'ohne Feld unveraendert');

  const geloescht = await call('PUT', `/${id}`, { title: 'Bleibt', image_data: null });
  assert.equal(geloescht.body.data.has_own_image, false, 'null loescht');
  assert.equal((await fetch(`${baseUrl}/${id}/image`)).status, 404);
});

test('POST /recipes: ein Bild, dessen Inhalt nicht zum Typ passt -> 400', async () => {
  // Der Praefix kommt aus dem Browser des Absenders (#937); geprueft wird der
  // Inhalt. Hier steht ein PNG-Rumpf unter einer JPEG-Deklaration.
  const gelogen = PNG_1X1.replace('image/png', 'image/jpeg');
  const r = await call('POST', '/', { title: 'Gelogen', image_data: gelogen });
  assert.equal(r.status, 400);
});
