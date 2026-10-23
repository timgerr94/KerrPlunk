/**
 * Modul: Rezepte (Recipes)
 * Zweck: REST-API-Routen fuer Rezept-CRUD inkl. Zutaten
 * Abhaengigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, num, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';
import { normalizeRecipeMealTypes } from '../../public/utils/recipe-meal-types.js';
import { ingredientMatchKey } from '../../public/utils/ingredient-match-key.js';
import { normalizeUnitText, pureUnitAbbreviation } from '../../public/utils/unit-abbreviations.js';
import { normalizeRecipeDiet } from '../../public/utils/recipe-diets.js';
import { categorizeIngredient, normalizeIncomingCategory } from '../services/recipe-providers/categorize.js';
import { getAdapter } from '../services/recipe-providers/index.js';
import { dataUrlContentMatches } from '../utils/file-signature.js';
import { mayReadModule, mayWriteModule } from '../permissions.js';
import { pantryCategoryFor } from '../services/shopping-pantry-category.js';
import { learnRestockInterval } from '../services/pantry-interval-learning.js';

const log = createLogger('Recipes');
const router = express.Router();

/**
 * quantity + unit zu EINEM Anzeigetext zusammenziehen.
 *
 * recipe_ingredients traegt seit v237 Menge und Einheit getrennt, damit die
 * Anzeige im Rezept sie einzeln zeigen und ein spaeteres Skalieren die Einheit
 * unangetastet lassen kann. Nach aussen in die Einkaufsliste gilt weiterhin das
 * alte, flache Format: shopping_items.quantity ist ein einzelner Text, und
 * server/services/shopping-import.js#parseQuantity liest ihn mit einer Regex
 * wieder ein - "500" + "g" getrennt zu uebergeben gaebe dort keinen Platz fuer
 * die zweite Spalte. Hier ist die einzige Stelle, an der beide zusammenlaufen.
 */
function flattenQuantity(quantity, unit) {
  const q = String(quantity ?? '').trim();
  const u = String(unit ?? '').trim();
  if (!u) return q || null;
  return q ? `${q} ${u}` : u;
}

/* NOTIZEN ALS ARRAY: EIN IMPORTER SCHICKT SCHRITTE, KEINEN FLIESSTEXT.
 *
 * Die Spalte `notes` ist ein einzelner Text, aber der API-Import fremder
 * Systeme liefert die Zubereitung oft als Array - ein Eintrag je Schritt.
 * `str()` riefe darauf `String(val)` und klebte die Schritte mit Kommas an
 *einander: aus zwei Schritten wurde ein Satz, und die Reihenfolge blieb zwar
 *erhalten, die Gliederung aber weg. Genau die soll hier entstehen.
 *
 * MEHRERE TEILE WERDEN NUMMERIERT, und zwar nur dann: ein Einzelschritt traegt
 * keine "Step 1."-Zeile, die niemand bestellt hat, und ein leeres Array ist
 * wie ein leeres Feld - `null`, kein Fehler. Interne Zeilenumbrueche eines
 * Eintrags bleiben unangetastet: sie sind Teil desselben Schritts (der Import
 * liefert z.B. "Pan Sear: ...\nGrill: ..." als EINEN Schritt) und werden nicht
 * in eigene Schritte zerlegt - das waere Raten ueber den Sinn fremder Texte.
 *
 * Die Laengenpruefung (MAX_TEXT) laeuft danach ganz normal in `str()` - ein
 * Array, das zusammengesetzt laenger als 5000 Zeichen ist, wird wie jeder
 * andere zu lange Text mit 400 abgewiesen, nicht still gekuerzt.
 */
function normalizeRecipeNotes(value) {
  if (!Array.isArray(value)) return value;
  const parts = value.map((part) => String(part ?? '').trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return parts.map((text, i) => `Step ${i + 1}.\n${text}`).join('\n\n');
}

/* NAHRWERTE JE PORTION ALS EIN JSON-FREITEXT (v242), WIE DIET UND TAGS.
 *
 * Der Importer schickt einen Satz camelCase-Namen mit String-Zahlen
 * (recipe_import_format_example.json: "calories":"257", "sodium":"1507").
 * Gespeichert werden die KANONISCHEN Schluessel aus dem Gesundheitsmodul
 * (server/services/health-nutrition.js#NUTRIENT_KEYS) - dieselben Namen, die
 * ein spaeterer "ins Gesundheits-Tagebuch"-Weg liest, und dieselbe
 * EU-Etiketten-Reihenfolge. Zwei Uebersetzungen passieren hier:
 *
 * - DER NAME: calories→energy_kcal, carbohydrates→carbs_g, ... - und die
 *   kanonischen Namen selbst ebenso (ein Client, der zurueckschreibt, was
 *   GET geliefert hat, schickt bereits energy_kcal).
 * - NATRIUM ZU SALZ: das Gesundheitsmodell kennt kein sodium_mg; die EU-
 *   Naehrwerttabelle nennt Salz. Umrechnung mg × 2,5 / 1000, auf eine
 *   Nachkommastelle gerundet wie auf der Packung (1507 mg → 3,8 g).
 *   Cholesterin hat im Modell keinen Platz und faellt STILL weg - wie jedes
 *   unbekannte Feld des Importers (secondaryQuantity, nutrition je Zutat, ...),
 *   kein 400, das den ganzen Import blockierte.
 *
 * String-Zahlen werden gezogen ("257" → 257), alles Nicht-Numerische und
 * Negative faellt weg; bleibt nichts uebrig, ist das Feld leer (null) - auch
 * bei ausdruecklich mitgeschicktem leeren Objekt, derselbe Vertrag wie notes.
 */
const NUTRITION_FIELD_MAP = new Map([
  ['calories', 'energy_kcal'], ['energy_kcal', 'energy_kcal'],
  ['carbohydrates', 'carbs_g'], ['carbs_g', 'carbs_g'],
  ['protein', 'protein_g'], ['protein_g', 'protein_g'],
  ['fat', 'fat_g'], ['fat_g', 'fat_g'],
  ['saturatedFat', 'saturated_fat_g'], ['saturated_fat_g', 'saturated_fat_g'],
  ['fiber', 'fiber_g'], ['fiber_g', 'fiber_g'],
  ['sugar', 'sugar_g'], ['sugar_g', 'sugar_g'],
  // mg → g Salz, × 2,5 ÷ 1000, eine Nachkommastelle wie auf dem Etikett.
  ['sodium', 'salt_g'],
  // Der kanonische Schluessel selbst gehoert dazu - er ist die Rueckschreib-
  // Seite derselben Zusage wie energy_kcal & Co.: ein Client, der abschreibt,
  // was GET geliefert hat, verloere sonst still den Salzwert.
  ['salt_g', 'salt_g'],
]);

function normalizeRecipeNutrition(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [raw, rawVal] of Object.entries(value)) {
    const target = NUTRITION_FIELD_MAP.get(raw);
    if (!target) continue; // unbekannter Naehrwert: still weglassen, kein 400
    let n = Number(String(rawVal).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) continue;
    if (raw === 'sodium') n = Math.round(n * 2.5 / 100) / 10;
    out[target] = n;
  }
  return Object.keys(out).length ? out : null;
}

// Nicht-skriptfähige Rasterformate (kein SVG), dieselbe Allowlist wie der
// DMS-Vorschau-Proxy (server/routes/dms.js) - dort wie hier landet ein
// Content-Type, den ein Drittsystem liefert, direkt im Response-Header.
const THUMBNAIL_MIME = new Set(['image/webp', 'image/jpeg', 'image/png']);
function normalizeMime(value) { return String(value || '').split(';')[0].trim().toLowerCase(); }

// Mirror-Rezepte tragen provider_account_id; native Rezepte haben diese Spalte
// NULL. `source` liest den tatsaechlichen Provider-Namen (mealie/tandoor/...)
// vom verknuepften Account statt ihn hart zu verdrahten - das ist der einzige
// Unterschied, den Frontend und Zugriffsschutz brauchen, um ein Rezept korrekt
// zu behandeln, und er erweitert sich automatisch um jeden neuen Provider.
function withSource(recipe) {
  // DAS BILD SELBST GEHT NIE MIT (#1059, Schritt 2). `SELECT r.*` zieht die
  // Spalte mit, und eine Data-URL von bis zu 5 MB je Zeile machte aus der
  // Rezeptliste ein Vielfaches ihrer selbst - fuer eine Vorschau von 32 Pixeln,
  // die ohnehin ueber `GET /recipes/:id/image` kommt. Uebrig bleibt das Flag,
  // das die Oberflaeche wirklich braucht: gibt es eins?
  //
  // DIE NAEHRWERTE kommen als JSON-Text aus der Spalte (v242, wie diet/tags)
  // und gehen als OBJEKT in die Antwort: sie sind acht benannte Zahlen, keine
  // Freitext-Liste wie die Tags, und der Browserteil liest sie Feld fuer Feld.
  //
  // DIET DAGEGEN ALS ARRAY (und nicht wie tags als JSON-String): das Modal
  // baut daraus Umschalt-Chips und das Detail eine Kommaliste - zwei Stellen,
  // die je JSON.parse riefen und an einem kaputten Wert stianden. Diet ist
  // eine kurze Liste bekannter Werte, kein Freitext. `tags` bleibt bewusst
  // String: sein Verbraucher ist ungeklaert, und ein halber Umbau waere die
  // zweite Fassung derselben Frage.
  const { image_data, nutrition, diet, ...rest } = recipe;
  let nutritionData = null;
  if (nutrition) {
    try { nutritionData = JSON.parse(nutrition); } catch { nutritionData = null; }
  }
  let dietList = [];
  if (diet) {
    try { dietList = JSON.parse(diet); } catch { dietList = []; }
    if (!Array.isArray(dietList)) dietList = [];
  }
  return {
    ...rest,
    has_own_image: !!image_data,
    nutrition: nutritionData,
    diet: dietList,
    source: recipe.provider_account_id ? recipe.provider_type : 'native',
  };
}

/* DIE BESTAETIGTE ZUORDNUNG ZU EINER VORRATSZEILE (#1314, Stufe 1).
 *
 * Sie haengt NICHT an `recipe_ingredients.id`, und das ist keine Vorsicht,
 * sondern eine Messung: PUT /:id weiter unten loescht alle Zutaten eines
 * Rezepts und legt sie neu an, der Provider-Sync ebenso. Eine ID-Verbindung
 * waere nach dem naechsten Speichern still verschwunden. Gespeichert ist
 * deshalb (recipe_id, normalisierter Name) - siehe Migration 222.
 *
 * WAS HIER NICHT PASSIERT: nichts wird geraten. Eine Zutat ohne Zeile in
 * `recipe_ingredient_pantry_matches` bekommt `pantry_item_id: null` und sonst
 * gar nichts - kein "fehlt", kein "vorhanden". Stufe 1 weiss nur, worauf der
 * Haushalt gezeigt hat; unbekannt ist nicht fehlend (docs/DECISIONS.md
 * Abschnitt 7).
 */
function attachPantryMatches(req, ingredients) {
  if (!ingredients.length) return ingredients;

  // DAS RECHT AM LESEWEG, spiegelbildlich zum Schreibweg weiter unten. Der Pfad
  // haengt unter /recipes und gehoert dem Scope-Modul `meals`; der globale
  // Riegel in server/index.js urteilt am ersten Pfadsegment und fragt deshalb
  // nie nach `pantry`. Benannt wird hier aber eine Zeile des VORRATS, mit
  // ihrem Namen. Dieselbe Mischstelle wie die Import-Kandidaten in
  // server/routes/birthdays.js (Pfad `calendar`, Inhalt aus `contacts`), und
  // derselbe Aufruf schliesst sie: `mayReadModule` prueft beide Achsen,
  // Mitgliedsrecht UND Token-Scope.
  //
  // Dass `pantryMatchEl()` in public/pages/recipes.js bei `access === 'none'`
  // nichts zeichnet, ist KEIN Ersatz: das ist eine Darstellungsentscheidung,
  // und GET /api/v1/recipes beantwortet die Frage am Browser vorbei.
  //
  // Was zurueckbleibt, ist `null` und nicht das Weglassen der Felder: die Zutat
  // ist fuer diesen Betrachter unzugeordnet, und die Antwort behaelt ihre Form.
  if (!mayReadModule(req, 'pantry')) {
    return ingredients.map((ing) => ({ ...ing, pantry_item_id: null, pantry_item_name: null }));
  }
  const recipeIds = [...new Set(ingredients.map((i) => i.recipe_id))];
  const placeholders = recipeIds.map(() => '?').join(',');
  const rows = db.get().prepare(`
    SELECT m.recipe_id, m.ingredient_key, m.pantry_item_id, p.name AS pantry_item_name
    FROM recipe_ingredient_pantry_matches m
    JOIN pantry_items p ON p.id = m.pantry_item_id
    WHERE m.recipe_id IN (${placeholders})
  `).all(...recipeIds);

  const byKey = new Map(rows.map((r) => [`${r.recipe_id}\x00${r.ingredient_key}`, r]));
  return ingredients.map((ing) => {
    const hit = byKey.get(`${ing.recipe_id}\x00${ingredientMatchKey(ing.name)}`);
    return {
      ...ing,
      pantry_item_id: hit ? hit.pantry_item_id : null,
      pantry_item_name: hit ? hit.pantry_item_name : null,
    };
  });
}

function loadRecipeWithIngredients(req, id) {
  const recipe = db.get().prepare(`
    SELECT r.*, u.display_name AS creator_name, u.avatar_color AS creator_color,
           p.name AS provider_account_name, p.provider AS provider_type
    FROM recipes r
    LEFT JOIN users u ON u.id = r.created_by
    LEFT JOIN recipe_provider_accounts p ON p.id = r.provider_account_id
    WHERE r.id = ?
  `).get(id);

  if (!recipe) return null;

  const ingredients = attachPantryMatches(req, db.get().prepare(`
    SELECT * FROM recipe_ingredients
    WHERE recipe_id = ?
    ORDER BY id ASC
  `).all(id));

  return withSource({ ...recipe, meal_types: normalizeRecipeMealTypes(recipe.meal_types), ingredients });
}

router.get('/', (req, res) => {
  try {
    const recipes = db.get().prepare(`
      SELECT r.*, u.display_name AS creator_name, u.avatar_color AS creator_color,
             p.name AS provider_account_name, p.provider AS provider_type
      FROM recipes r
      LEFT JOIN users u ON u.id = r.created_by
      LEFT JOIN recipe_provider_accounts p ON p.id = r.provider_account_id
      ORDER BY r.title COLLATE NOCASE ASC, r.id DESC
    `).all();

    const ids = recipes.map((r) => r.id);
    let ingredientMap = {};

    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const ingredients = attachPantryMatches(req, db.get().prepare(`
        SELECT * FROM recipe_ingredients
        WHERE recipe_id IN (${placeholders})
        ORDER BY id ASC
      `).all(...ids));

      for (const ing of ingredients) {
        if (!ingredientMap[ing.recipe_id]) ingredientMap[ing.recipe_id] = [];
        ingredientMap[ing.recipe_id].push(ing);
      }
    }

    res.json({ data: recipes.map((r) => withSource({
      ...r,
      meal_types: normalizeRecipeMealTypes(r.meal_types),
      ingredients: ingredientMap[r.id] || [],
    })) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/* EIN EIGENES BILD JE REZEPT (#1059, Schritt 2).
 *
 * Dieselbe Regel wie beim Gegenstandsfoto (routes/inventory/items.js) und beim
 * Geburtstagsbild: eine Bild-Data-URL, dieselbe Groessengrenze, und der Inhalt
 * muss zu seinem deklarierten Typ passen (#937) - der Praefix kommt aus dem
 * Browser des Absenders und ist fuer sich genommen keine Auskunft.
 *
 * `undefined` heisst "nicht mitgeschickt" und laesst das gespeicherte Bild
 * stehen; `null` oder der leere String loeschen es. Ohne diese Unterscheidung
 * raeumte jedes Teil-Update das Bild ab - derselbe Fehler, den `meal_types`
 * weiter unten schon einmal hatte.
 */
const MAX_RECIPE_IMAGE_LENGTH = 6_990_507; // ~5 MB Rohbild in base64, wie inventory/birthdays
/** Erlaubte Bild-MIME-Typen für Rezepte. SVG wird nun unterstützt - sowohl base64-codiert als auch als rohe data-URL. */
const RECIPE_IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml)(;base64,[A-Za-z0-9+\/=]+)?$/;

function validateRecipeImage(val) {
  if (val === undefined) return { value: undefined, error: null };
  if (val === null || val === '') return { value: null, error: null };
  const s = String(val).trim();
  if (s.length > MAX_RECIPE_IMAGE_LENGTH) return { value: null, error: 'Image is too large.' };
  if (!RECIPE_IMAGE_RE.test(s)) return { value: null, error: 'Image must be a valid image data URL.' };
  // Prüfe, ob Inhalt zum MIME-Typ passt (unterstützt sowohl base64-codiert als auch rohe data-URLs)
  if (!validateImageContent(s)) return { value: null, error: 'Image content does not match its image type.' };
  return { value: s, error: null };
}

/**
 * Validiert, ob der Inhalt einer data-URL zu ihrem MIME-Typ passt.
 *
 * BISHER pruefte diese Funktion nur SVG und liess ALLES ANDERE mit einem
 * pauschalen `return true` durch (#937): ein PNG unter JPEG-Deklaration wurde
 * angenommen - und der base64-SVG-Zweig rief `contentMatchesMime` auf, das
 * hier gar nicht importiert war, sodass jede base64-SVG-Angabe in einem 500
 * endete statt in einer Antwort. Beides ist mit dem gemeinsamen Pruefer
 * gegangen: dataUrlContentMatches kennt die Signatur jedes erlaubten Bild-
 * Typs (utils/file-signature.js, dort begruendet) und dekodiert selbst nur
 * den Kopf der Datei.
 *
 * Roh-Data-URLs ohne `;base64,` lehnt RECIPE_IMAGE_RE weiter oben bereits ab
 * - der optionale Base64-Rumpf ist der einzige zulaessige Koerper. Die
 * Funktion bleibt trotzdem als eigene Stufe, damit sich die Fehlermeldung
 * der Inhaltspruefung von der der Formpruefung unterscheidet.
 *
 * @param {string} dataUrl - Die data-URL zur Validierung
 * @returns {boolean} true wenn der Inhalt zum deklarierten Typ passt
 */
function validateImageContent(dataUrl) {
  return dataUrlContentMatches(dataUrl);
}

router.post('/', (req, res) => {
  try {
    const { ingredients = [] } = req.body;

    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vNotes = str(normalizeRecipeNotes(req.body.notes), 'Notizen', { max: MAX_TEXT, required: false });
    const vRecipeUrl = str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
    const mealTypes = normalizeRecipeMealTypes(req.body.meal_types);
    const vImageUrl = req.body.image_url;  // NEW: Get image_url
    const vImage = validateRecipeImage(req.body.image_data);
    const vCuisine = str(req.body.cuisine, 'Cuisine', { max: MAX_TEXT, required: false });
    const vCookTime = str(req.body.cookTime, 'Cook Time', { max: MAX_TEXT, required: false });
    const vPrepTime = str(req.body.prepTime, 'Prep Time', { max: MAX_TEXT, required: false });
    // Diet: kuratierte Schluessel plus Importer-Varianten ("gf"), Best-Effort
    // gezogen (utils/recipe-diets.js, dort begruendet) - Unbekanntes bleibt
    // wortgetreu statt wegzufallen; Duplikate nach der Normalisierung fallen
    // still zusammen.
    const vDiet = (Array.isArray(req.body.diet) ? req.body.diet : [])
      .map(normalizeRecipeDiet).filter(Boolean);
    const vDietList = [...new Set(vDiet)];
    const vTags = Array.isArray(req.body.tags) ? req.body.tags : [];

    // Naehrwerte JE PORTION (v242): der Importer nennt das Feld
    // `nutritionSummary`, die kanonische Antwort (`nutrition`) schreibt ein
    // Client unveraendert zurueck - beides ist dasselbe Feld.
    const nutritionData = normalizeRecipeNutrition(req.body.nutritionSummary ?? req.body.nutrition);
    const nutritionJson = nutritionData ? JSON.stringify(nutritionData) : null;

    const errors = collectErrors([vTitle, vNotes, vRecipeUrl, vImage, vCuisine, vCookTime, vPrepTime]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const recipeId = db.transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO recipes (title, notes, recipe_url, meal_types, image_data, image_url, servings, cuisine, cookTime, prepTime, diet, tags, nutrition, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(vTitle.value, vNotes.value, vRecipeUrl.value, mealTypes.join(','),
        vImage.value ?? null, vImageUrl ?? null, req.body.servings ?? null,
        vCuisine.value ?? null, vCookTime.value ?? null, vPrepTime.value ?? null,
        JSON.stringify(vDietList), JSON.stringify(vTags), nutritionJson,
        req.authUserId || req.session.userId);

      const rid = Number(result.lastInsertRowid);
      const insertIng = db.get().prepare(`
        INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit, secondary_quantity, secondary_unit, note, section, category)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const ing of ingredients) {
        const name = String(ing.name || '').trim().slice(0, MAX_TITLE);
        let quantity = String(ing.quantity || '').trim().slice(0, MAX_SHORT) || null;
        // Ausgeschriebene Einheiten ("tablespoon") auf ihr Kuerzel ("tbsp")
        // ziehen - eine Fassung (utils/unit-abbreviations.js, dort begruendet).
        // Unbekanntes ("cloves") bleibt, wie es ist; die Laengengrenze gilt
        // danach weiter.
        let unit = normalizeUnitText(ing.unit)?.slice(0, MAX_SHORT) || null;
        // EIN REINES EINHEITSWORT ALS MENGE gehoert in die Einheitenspalte:
        // ein Importer schickt "Esslöffel" dorthin, wo gerade ein Feld frei
        // ist. Nur bekannte, ganze Einheiten ziehen ("50 g" ist eine Menge
        // mit Einheit, "Prise" unbekannt - beides bleibt, wie es liegt).
        if (!unit && quantity) {
          const moved = pureUnitAbbreviation(quantity);
          if (moved) { unit = moved.slice(0, MAX_SHORT); quantity = null; }
        }
        // Zweitangabe (v243): Importer schicken ein Gewichtsaequivalent zur
        // primaeren Menge ("0.5 cup" plus "48 g") im camelCase-Paar; die
        // kanonischen Schluessel (secondary_quantity) laufen ebenso durch - ein
        // Client, der zurueckschreibt, was GET geliefert hat, schickt sie schon.
        // Zwei Spalten wie die primaere Aufteilung (v237, dort begruendet:
        // ein spaeteres Skalieren rechnet an der Zahl, nicht am Text).
        const secondaryQuantity = String(ing.secondaryQuantity ?? ing.secondary_quantity ?? '').trim().slice(0, MAX_SHORT) || null;
        const secondaryUnit = normalizeUnitText(ing.secondaryUnit ?? ing.secondary_unit)?.slice(0, MAX_SHORT) || null;
        // Die Notiz einer Zutat ist Zubereitungs-Kontext ("thinly sliced"),
        // den Importer im eigenen Feld mitschicken - dieselbe Laengenklasse
        // wie Menge und Einheit (v241).
        const note = String(ing.note || '').trim().slice(0, MAX_SHORT) || null;
        // ABSCHNITT (v244): Importer schicken die Gruppe als Feld je Zutat
        // ("Dry Ingredients", "Cream Cheese Glaze") - die Liste bleibt FLACH,
        // die Reihenfolge der Eintraege bleibt die des Rezepts, und die
        // Anzeige gruppiert nach FOLGE, nicht nach Wert. Freitext wie der Name,
        // dieselbe Laengenklasse; NULL/'' = ohne Ueberschrift.
        const section = String(ing.section || '').trim().slice(0, MAX_SHORT) || null;
        // Automatic category matching using the same logic as Shopping List,
        // but only if the user hasn't already set a specific category.
        // 'Miscellaneous' ist die englische ANZEIGE von 'Sonstiges' - ein
        // Importer schickt das Label, nicht den gespeicherten Namen. Ohne die
        // Uebersetzung blieb es als scheinbar gesetzte Kategorie stehen und
        // fiel im Modal still auf den ersten Dropdown-Eintrag zurueck.
        const rawCategory = normalizeIncomingCategory(ing.category);
        let category;
        if (rawCategory && rawCategory !== 'Sonstiges') {
          // User has already selected a category - preserve it
          category = rawCategory.slice(0, MAX_SHORT) || 'Sonstiges';
        } else {
          // No user-selected category - run automatic matching
          category = String(categorizeIngredient({ foodName: name }) || 'Sonstiges').trim().slice(0, MAX_SHORT) || 'Sonstiges';
        }
        if (name) insertIng.run(rid, name, quantity, unit, secondaryQuantity, secondaryUnit, note, section, category);
      }

      return rid;
    });

    const created = loadRecipeWithIngredients(req, recipeId);
    res.status(201).json({ data: created });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungueltige Rezept-ID', code: 400 });

    const existing = db.get().prepare('SELECT id, provider_account_id, meal_types FROM recipes WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Recipe not found', code: 404 });
    // KEIN Besitzer-Riegel (#1577, Entscheidung 30.09.2026): Rezepte gehoeren
    // dem Haushalt wie Aufgaben, Einkauf und Notizen. Wer das Modulrecht
    // `meals: write` hat, bearbeitet und loescht jedes Rezept - das prueft der
    // Modul-Riegel in server/index.js (moduleAccessVerdict), fuer Mitglieds-
    // rechte und Token-Scopes; `meals: read` bleibt dort abgewiesen. `created_by`
    // sagt nur, wer ein Rezept angelegt hat, nicht wer es aendern darf.
    //
    // Mirror-Rezepte sind read-only: der Quell-Provider bleibt Quelle der
    // Wahrheit für ihren Inhalt - fuer jeden, auch fuer den Nutzer, der den
    // Provider-Account angelegt hat (und damit als created_by dieser Rezepte gilt).
    if (existing.provider_account_id) return res.status(403).json({ error: 'Mirrored recipes are managed by their source provider and cannot be edited here.', code: 403 });

    const { ingredients = [] } = req.body;

    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vNotes = str(normalizeRecipeNotes(req.body.notes), 'Notizen', { max: MAX_TEXT, required: false });
    const vRecipeUrl = str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
    const mealTypes = normalizeRecipeMealTypes(
      req.body.meal_types === undefined ? existing.meal_types : req.body.meal_types
    );
    const vImage = validateRecipeImage(req.body.image_data);
    const vCuisine = str(req.body.cuisine, 'Cuisine', { max: MAX_TEXT, required: false });
    const vCookTime = str(req.body.cookTime, 'Cook Time', { max: MAX_TEXT, required: false });
    const vPrepTime = str(req.body.prepTime, 'Prep Time', { max: MAX_TEXT, required: false });
    // Diet wie im POST-Zweig (dort begruendet): Normalisierung Best-Effort,
    // Duplikate fallen nach dem Ziehen still zusammen.
    const vDiet = (Array.isArray(req.body.diet) ? req.body.diet : [])
      .map(normalizeRecipeDiet).filter(Boolean);
    const vDietList = [...new Set(vDiet)];
    const vTags = Array.isArray(req.body.tags) ? req.body.tags : [];

    // Naehrwerte wie im POST-Zweig (dort begruendet): `nutritionSummary` des
    // Importers und die kanonische Antwort `nutrition` sind dasselbe Feld.
    // Ist KEINES von beiden mitgeschickt, bleibt der gespeicherte Stand
    // stehen - derselbe Feld-Vertrag wie cuisine und tags daneben.
    const nutritionInput = req.body.nutritionSummary ?? req.body.nutrition;
    const nutritionData = normalizeRecipeNutrition(nutritionInput);
    const nutritionJson = nutritionData ? JSON.stringify(nutritionData) : null;

    const errors = collectErrors([vTitle, vNotes, vRecipeUrl, vImage, vCuisine, vCookTime, vPrepTime]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    db.transaction(() => {
      // COALESCE fuer das Bild: ein nicht mitgeschicktes Feld (undefined -> NULL
      // als Bindung) laesst das gespeicherte stehen. Geloescht wird nur mit
      // ausdruecklichem null/'' - dann traegt vImage.value ebenfalls null, und
      // die Fallunterscheidung unten setzt es.
      db.get().prepare(`
        UPDATE recipes
        SET title = ?, notes = ?, recipe_url = ?, meal_types = ?,
            image_data = CASE WHEN ? = 1 THEN ? ELSE image_data END,
            image_url = CASE WHEN ? = 1 THEN ? ELSE image_url END,
            servings = CASE WHEN ? = 1 THEN ? ELSE servings END,
            cuisine = CASE WHEN ? = 1 THEN ? ELSE cuisine END,
            cookTime = CASE WHEN ? = 1 THEN ? ELSE cookTime END,
            prepTime = CASE WHEN ? = 1 THEN ? ELSE prepTime END,
            diet = CASE WHEN ? = 1 THEN ? ELSE diet END,
            tags = CASE WHEN ? = 1 THEN ? ELSE tags END,
            nutrition = CASE WHEN ? = 1 THEN ? ELSE nutrition END
        WHERE id = ?
      `).run(vTitle.value, vNotes.value, vRecipeUrl.value, mealTypes.join(','),
        vImage.value === undefined ? 0 : 1, vImage.value ?? null,
        req.body.image_url === undefined ? 0 : 1, req.body.image_url ?? null,
        req.body.servings === undefined ? 0 : 1, req.body.servings ?? null,
        req.body.cuisine === undefined ? 0 : 1, vCuisine.value ?? null,
        req.body.cookTime === undefined ? 0 : 1, vCookTime.value ?? null,
        req.body.prepTime === undefined ? 0 : 1, vPrepTime.value ?? null,
        req.body.diet === undefined ? 0 : 1, JSON.stringify(vDietList),
        req.body.tags === undefined ? 0 : 1, JSON.stringify(vTags),
        nutritionInput === undefined ? 0 : 1, nutritionJson, id);

      db.get().prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);

      const insertIng = db.get().prepare(`
        INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit, secondary_quantity, secondary_unit, note, section, category)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const ing of ingredients) {
        const name = String(ing.name || '').trim().slice(0, MAX_TITLE);
        let quantity = String(ing.quantity || '').trim().slice(0, MAX_SHORT) || null;
        // Ausgeschriebene Einheiten auf ihr Kuerzel ziehen wie im POST-Zweig
        // (dort begruendet).
        let unit = normalizeUnitText(ing.unit)?.slice(0, MAX_SHORT) || null;
        // Ein reines Einheitswort als Menge wandert in die Einheitenspalte -
        // dieselbe Regel wie im POST-Zweig (dort begruendet).
        if (!unit && quantity) {
          const moved = pureUnitAbbreviation(quantity);
          if (moved) { unit = moved.slice(0, MAX_SHORT); quantity = null; }
        }
        // Zweitangabe wie im POST-Zweig (dort begruendet, v243).
        const secondaryQuantity = String(ing.secondaryQuantity ?? ing.secondary_quantity ?? '').trim().slice(0, MAX_SHORT) || null;
        const secondaryUnit = normalizeUnitText(ing.secondaryUnit ?? ing.secondary_unit)?.slice(0, MAX_SHORT) || null;
        // Notiz wie im POST-Zweig (dort begruendet, v241).
        const note = String(ing.note || '').trim().slice(0, MAX_SHORT) || null;
        // Abschnitt wie im POST-Zweig (dort begruendet, v244).
        const section = String(ing.section || '').trim().slice(0, MAX_SHORT) || null;
        // Automatic category matching using the same logic as Shopping List,
        // but only if the user hasn't already set a specific category.
        // 'Miscellaneous' → 'Sonstiges' wie im POST-Zweig (dort begruendet).
        const rawCategory = normalizeIncomingCategory(ing.category);
        let category;
        if (rawCategory && rawCategory !== 'Sonstiges') {
          // User has already selected a category - preserve it
          category = rawCategory.slice(0, MAX_SHORT) || 'Sonstiges';
        } else {
          // No user-selected category - run automatic matching
          category = String(categorizeIngredient({ foodName: name }) || 'Sonstiges').trim().slice(0, MAX_SHORT) || 'Sonstiges';
        }
        if (name) insertIng.run(id, name, quantity, unit, secondaryQuantity, secondaryUnit, note, section, category);
      }

      // VERWAISTE ZUORDNUNGEN ABRAEUMEN, IN DERSELBEN TRANSAKTION (#1314).
      //
      // Die Zuordnung haengt am normalisierten Namen, nicht an
      // `recipe_ingredients.id` - sonst waere sie nach genau diesem DELETE weg.
      // Der Preis dafuer steht hier: wird eine Zutat umbenannt, zeigt ihre
      // Zuordnung auf einen Namen, den dieses Rezept nicht mehr traegt. Kein FK
      // und kein Trigger fassen das, weil die Zutatenzeile als Bezug nie
      // existiert hat.
      //
      // Unsichtbar waere sie damit, aber nicht weg: taucht dieselbe Schreibweise
      // spaeter wieder auf, haengt `attachPantryMatches` die alte Vorratszeile
      // wieder an - eine Zuordnung, die in dieser Form nie jemand bestaetigt hat,
      // und damit genau die geratene Aussage, die docs/DECISIONS.md Abschnitt 7
      // ausschliesst. Der Bestaetigungsweg unten lehnt aus demselben Grund eine
      // Zutat ab, die es im Rezept nicht gibt; hier ist die Rueckseite davon.
      //
      // GEMESSEN WIRD AN DER TABELLE, NICHT AM REQUEST: die Namen kommen aus dem,
      // was gerade wirklich eingefuegt wurde (`if (name)` laesst leere aus).
      // Geloescht wird zeilenweise ueber die wenigen vorhandenen Zuordnungen
      // statt mit einem NOT IN ueber alle Zutaten - eine Zutatenliste ist
      // unbegrenzt, die Zahl der Bindungen einer Anweisung nicht.
      const vorhandeneZuordnungen = db.get().prepare(
        'SELECT ingredient_key FROM recipe_ingredient_pantry_matches WHERE recipe_id = ?',
      ).all(id);
      if (vorhandeneZuordnungen.length) {
        const gueltigeKeys = new Set(
          db.get().prepare('SELECT name FROM recipe_ingredients WHERE recipe_id = ?').all(id)
            .map((r) => ingredientMatchKey(r.name)),
        );
        const loeseZuordnung = db.get().prepare(
          'DELETE FROM recipe_ingredient_pantry_matches WHERE recipe_id = ? AND ingredient_key = ?',
        );
        for (const row of vorhandeneZuordnungen) {
          if (!gueltigeKeys.has(row.ingredient_key)) loeseZuordnung.run(id, row.ingredient_key);
        }
      }
    });

    const updated = loadRecipeWithIngredients(req, id);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * GET /api/v1/recipes/:id/image
 * Liefert das selbst hochgeladene Rezeptbild als Datei (#1059, Schritt 2).
 *
 * ALS ROUTE UND NICHT IN DER LISTE. Die Spalte traegt eine Data-URL von bis zu
 * 5 MB; sie an jeder Mahlzeit einer Wochenansicht mitzuschicken waere ein
 * Vielfaches der ganzen uebrigen Antwort, fuer eine Vorschau von 32 Pixeln.
 * Die Listen tragen deshalb nur ein Flag, und das Bild holt sich der Browser
 * hier - genau wie beim Provider-Thumbnail nebenan, das aus demselben Grund
 * ein Proxy ist.
 */
router.get('/:id/image', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const row = db.get().prepare('SELECT image_data FROM recipes WHERE id = ?').get(id);
    if (!row?.image_data) return res.status(404).json({ error: 'No image available.', code: 404 });

    const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(row.image_data);
    if (!match) return res.status(415).json({ error: 'Stored image is not readable.', code: 415 });

    const buffer = Buffer.from(match[2], 'base64');
    res.setHeader('Content-Type', match[1]);
    res.setHeader('Content-Length', String(buffer.length));
    // Dieselben Kopfzeilen wie der Provider-Proxy: der Browser soll den Typ
    // nicht raten, und ein Bild aus der eigenen Datenbank bleibt nicht als
    // Kopie im Browser-Cache liegen - der ueberlebt das Abmelden.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.end(buffer);
  } catch (err) {
    log.error('GET /:id/image error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const existing = db.get().prepare('SELECT id, provider_account_id FROM recipes WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Recipe not found.', code: 404 });
    // Siehe PUT /:id: kein Besitzer-Riegel, das Modulrecht `meals: write`
    // genuegt (#1577). Mirror-Rezepte lassen sich nur durch Löschen des
    // Provider-Accounts entfernen (DELETE /recipe-providers/accounts/:id), nicht
    // einzeln hier.
    if (existing.provider_account_id) return res.status(403).json({ error: 'Mirrored recipes are managed by their source provider and cannot be deleted here.', code: 403 });

    const result = db.get().prepare('DELETE FROM recipes WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Recipe not found', code: 404 });

    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * GET /api/v1/recipes/:id/provider-thumbnail
 * Proxied das Rezeptbild eines Recipe-Providers (Mealie, Tandoor, ...). Kein
 * direkter <img src> auf den Provider möglich: dessen Medien-Route verlangt
 * denselben Bearer-Token wie jeder andere Endpunkt, und der darf den Client nie
 * erreichen (siehe publicAccount() in routes/recipe-providers.js) - also holt
 * der Server die Bytes und reicht sie durch, wie der DMS-Vorschau-Proxy es für
 * Paperless/Papra tut.
 */
router.get('/:id/provider-thumbnail', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const recipe = db.get().prepare(
      'SELECT provider_account_id, provider_recipe_id, provider_slug, provider_has_image FROM recipes WHERE id = ?'
    ).get(id);
    if (!recipe?.provider_account_id || !recipe.provider_has_image) {
      return res.status(404).json({ error: 'No thumbnail available.', code: 404 });
    }

    const account = db.get().prepare('SELECT * FROM recipe_provider_accounts WHERE id = ?').get(recipe.provider_account_id);
    if (!account) return res.status(404).json({ error: 'No thumbnail available.', code: 404 });

    const thumb = await getAdapter(account).fetchThumbnail({ id: recipe.provider_recipe_id, slug: recipe.provider_slug });
    const mime = normalizeMime(thumb?.mime);
    if (!thumb?.buffer?.length || !THUMBNAIL_MIME.has(mime)) {
      return res.status(415).json({ error: 'Thumbnail not available.', code: 415 });
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(thumb.buffer.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.end(thumb.buffer);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'No thumbnail available.', code: 404 });
    log.error('GET /:id/provider-thumbnail error:', err);
    res.status(502).json({ error: 'Recipe provider thumbnail proxy failed.', code: 502 });
  }
});

// --------------------------------------------------------
// Integration: Rezeptzutaten → Einkaufsliste
// --------------------------------------------------------

/**
 * POST /api/v1/recipes/:id/to-shopping-list
 * Zutaten eines Rezepts auf eine Einkaufsliste übernehmen.
 * Body: { listId: number }
 * Response: { data: { transferred: number, skipped: number, added_ids: number[] } }
 *
 * Anders als bei Mahlzeiten wird hier NICHTS am Rezept markiert: ein Rezept ist
 * eine Vorlage, die beliebig oft gekocht wird - ein „schon übertragen"-Flag wie
 * meal_ingredients.on_shopping_list wäre nach dem ersten Einkauf für immer
 * gesetzt. Stattdessen überspringt der Import, was unter demselben Namen bereits
 * unabgehakt auf der Liste liegt; doppeltes Übernehmen fügt also nichts hinzu,
 * statt die Liste zu verdoppeln.
 *
 * `added_ids` trägt das Undo im Client, wie bei `/shopping/:listId/import-pantry`.
 * Ohne die IDs gäbe es nichts zurückzunehmen: die Anzahl kennt erst der Server
 * (er überspringt Duplikate), und dieser Pfad überträgt am meisten auf einmal -
 * eine ganze Zutatenliste in eine Liste, die der Nutzer gerade nicht ansieht
 * (Audit 2026-07-30, P1-B).
 */
router.post('/:id/to-shopping-list', (req, res) => {
  try {
    // Dieselbe Regel wie im Essensplan (#1290, ausfuehrlich in
    // routes/meals.js): `/recipes` gehoert dem Scope-Modul `meals`, angelegt
    // werden `shopping_items`. Wer in den Einkauf schreibt, braucht dessen
    // Schreibrecht - als Mitglied wie als Token. Vor den 404ern, damit die
    // Antwort keine Rezept- und Listen-IDs bestaetigt.
    if (!mayWriteModule(req, 'shopping')) {
      return res.status(403).json({ error: 'Write access to the shopping list is required.', code: 403 });
    }

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const recipe = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.', code: 404 });

    const vList = num(req.body.listId, 'Listen-ID', { required: true });

    // TEILAUSWAHL (Checkboxen vor den Zutaten im Detail): `ingredientIds` ist
    // OPTIONAL - fehlt es, uebernimmt der Pfad wie bisher die ganze Liste
    // (jeder bestehende Client, Token und Test bleibt unberuehrt). Steht es,
    // MUSS es ein nicht-leeres Array positiver Zahlen sein, und jede ID muss
    // zu DIESEM Rezept gehoeren: eine fremde ID stillschweigend zu
    // uebergehen wuerde eine halbe Wahrheit zurueckgeben - die Antwort
    // erscheint erfolgreich, aber ein Teil der Auswahl kam nie an. Der 400er
    // nennt den Widerspruch beim Namen. Bei einer leeren Auswahl bleibt es
    // beim Client (der Knopf faellt auf „Alle zurueck"): ein leerer Transfer
    // waere keine Auswahl, sondern das Fehlen einer.
    let ingredientIds = null;
    if (req.body.ingredientIds !== undefined) {
      const raw = req.body.ingredientIds;
      const ok = Array.isArray(raw) && raw.length > 0
        && raw.every((v) => Number.isInteger(v) && v > 0);
      if (!ok) {
        return res.status(400).json({ error: 'ingredientIds must be a non-empty array of ingredient IDs.', code: 400 });
      }
      ingredientIds = [...new Set(raw)];
    }

    const errors = collectErrors([vList]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const list = db.get().prepare('SELECT id FROM shopping_lists WHERE id = ?').get(vList.value);
    if (!list) return res.status(404).json({ error: 'Shopping list not found.', code: 404 });

    const ingredients = db.get().prepare(
      ingredientIds
        ? `SELECT id, name, quantity, unit, category FROM recipe_ingredients
             WHERE recipe_id = ? AND id IN (${ingredientIds.map(() => '?').join(',')})
             ORDER BY id ASC`
        : 'SELECT id, name, quantity, unit, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC',
    ).all(...(ingredientIds ? [id, ...ingredientIds] : [id]));
    // JEDE gewaehlte ID muss eine Zeile ergeben - sonst enthielt die Auswahl
    // eine ID eines anderen Rezepts (oder eine geloeschte). Beides ist kein
    // Teiltransfer, sondern eine Auswahl, die der Bestand nicht hergibt.
    if (ingredientIds && ingredients.length !== ingredientIds.length) {
      return res.status(400).json({ error: 'Every ingredient ID must belong to this recipe.', code: 400 });
    }
    if (!ingredients.length) return res.json({ data: { transferred: 0, skipped: 0, added_ids: [] } });

    // Ein Zeitpunkt fuer den ganzen Transfer: alle Zutaten einer Uebernahme
    // lernen dieselbe beobachtete Taktung, nicht je Zeile eine leicht andere.
    const purchaseSignalAt = new Date();

    const result = db.transaction(() => {
      const existing = db.get().prepare(
        'SELECT name FROM shopping_items WHERE list_id = ? AND is_checked = 0',
      ).all(vList.value);
      const present = new Set(existing.map((i) => i.name.trim().toLowerCase()));

      const insertItem = db.get().prepare(`
        INSERT INTO shopping_items (list_id, name, quantity, category)
        VALUES (?, ?, ?, ?)
      `);

      const addedIds = [];
      let skipped = 0;
      for (const ing of ingredients) {
        const key = ing.name.trim().toLowerCase();
        if (present.has(key)) { skipped += 1; continue; }
        // Fuehrt der Haushalt dieselbe Ware schon im Vorrat (mit Nachkauf-
        // regel), gibt DER seine Kategorie her - wie beim manuellen Anlegen
        // eines Artikels, damit dieselbe Ware nicht je nach Weg in zwei
        // Kategorien landet. Ohne Treffer bleibt die Zutaten-Kategorie stehen.
        const category = pantryCategoryFor(req, ing.name) ?? (ing.category || 'Sonstiges');
        const info = insertItem.run(vList.value, ing.name, flattenQuantity(ing.quantity, ing.unit), category);
        present.add(key);
        addedIds.push(Number(info.lastInsertRowid));
        // Dasselbe Einkaufs-Signal wie bei der Handanlage (#1608): nur was
        // WIRKLICH neu anlegt wird, lernt - uebersprungenes liegt schon auf
        // der Liste und hat beim Anlegen gelernt. Das Undo nimmt die Regel
        // nicht zurueck (dort begruendet).
        learnRestockInterval(req, ing.name, purchaseSignalAt);
      }
      return { transferred: addedIds.length, skipped, added_ids: addedIds };
    });

    res.json({ data: result });
  } catch (err) {
    log.error('POST /:id/to-shopping-list error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// --------------------------------------------------------
// Integration: Rezeptzutat → Vorratszeile (#1314, Stufe 1)
// --------------------------------------------------------

/**
 * PUT /api/v1/recipes/:id/ingredient-match
 * Die bestaetigte Zuordnung einer Rezeptzutat zu einer Zeile im Vorrat setzen
 * oder loesen.
 * Body: { name: string, pantryItemId: number|null }
 * Response: { data: { name, ingredient_key, pantry_item_id, pantry_item_name } }
 *
 * NUR AUF BESTAETIGUNG, UND DESHALB ALS EIGENER WEG. Die Zuordnung haette auch
 * ein Feld im Rezept-PUT sein koennen - dann haette jeder Speichervorgang,
 * jedes Formular und jeder Client sie mitgeschrieben, und ein Client, der das
 * Feld nicht kennt, haette sie geloescht. Ein eigener Aufruf ist die einzige
 * Form, in der "ein Mensch hat das bestaetigt" auch technisch stimmt: es gibt
 * keinen anderen Weg, auf dem eine Zuordnung entsteht (docs/DECISIONS.md
 * Abschnitt 7 - eine geratene Zuordnung ist der gepflegte Katalog, eine
 * Ableitung nach der anderen).
 *
 * `pantryItemId: null` loest die Zuordnung. Derselbe Weg, dasselbe Recht: das
 * Loesen ist derselbe Schreibvorgang, nur rueckwaerts.
 *
 * DAS RECHT. Wie bei /recipes/:id/to-shopping-list nebenan: der Pfad haengt
 * unter `/recipes` und gehoert damit dem Scope-Modul `meals` - der globale
 * Riegel in server/index.js urteilt am ersten Pfadsegment und fragt nur danach.
 * Benannt wird hier aber eine Zeile des VORRATS, und sie wird dauerhaft in ein
 * anderes Modul eingehaengt. Wer das tut, braucht das Schreibrecht des Vorrats,
 * auf beiden Achsen (Mitgliedsrecht und Token-Scope). Der Riegel steht vor den
 * 404ern, damit die Antwort keine Rezept- und Vorrats-IDs bestaetigt.
 */
router.put('/:id/ingredient-match', (req, res) => {
  try {
    if (!mayWriteModule(req, 'pantry')) {
      return res.status(403).json({ error: 'Write access to the pantry is required.', code: 403 });
    }

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid recipe ID.', code: 400 });

    const vName = str(req.body.name, 'Zutat', { max: MAX_TITLE });
    const errors = collectErrors([vName]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const key = ingredientMatchKey(vName.value);
    if (!key) return res.status(400).json({ error: 'Zutat darf nicht leer sein.', code: 400 });

    const recipe = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.', code: 404 });

    // DIE ZUTAT MUSS ES GEBEN. Sonst stuende eine Aussage ueber etwas in der
    // Tabelle, das in diesem Rezept nicht vorkommt - und sie bliebe dort
    // liegen, bis zufaellig jemand eine Zutat genau so nennt.
    const ingredients = db.get().prepare('SELECT name FROM recipe_ingredients WHERE recipe_id = ?').all(id);
    const treffer = ingredients.find((i) => ingredientMatchKey(i.name) === key);
    if (!treffer) return res.status(404).json({ error: 'Ingredient not found in this recipe.', code: 404 });

    const raw = req.body.pantryItemId;
    if (raw === null || raw === undefined || raw === '') {
      db.get().prepare(
        'DELETE FROM recipe_ingredient_pantry_matches WHERE recipe_id = ? AND ingredient_key = ?',
      ).run(id, key);
      return res.json({
        data: { name: treffer.name, ingredient_key: key, pantry_item_id: null, pantry_item_name: null },
      });
    }

    const vItem = num(raw, 'Vorrats-ID', { required: true });
    const itemErrors = collectErrors([vItem]);
    if (itemErrors.length) return res.status(400).json({ error: itemErrors.join(' '), code: 400 });

    const item = db.get().prepare('SELECT id, name FROM pantry_items WHERE id = ?').get(vItem.value);
    if (!item) return res.status(404).json({ error: 'Pantry item not found.', code: 404 });

    // Ein erneutes Bestaetigen ERSETZT die alte Aussage (Primaerschluessel
    // recipe_id + ingredient_key), statt eine zweite danebenzulegen.
    db.get().prepare(`
      INSERT INTO recipe_ingredient_pantry_matches (recipe_id, ingredient_key, pantry_item_id, confirmed_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(recipe_id, ingredient_key) DO UPDATE SET
        pantry_item_id = excluded.pantry_item_id,
        confirmed_by   = excluded.confirmed_by
    `).run(id, key, item.id, req.authUserId || req.session.userId);

    res.json({
      data: { name: treffer.name, ingredient_key: key, pantry_item_id: item.id, pantry_item_name: item.name },
    });
  } catch (err) {
    log.error('PUT /:id/ingredient-match error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
