/**
 * Modul: Einheiten-Kuerzel (Unit abbreviations)
 * Zweck: Ausgeschriebene Einheiten ("tablespoon", "Teelöffel", "Tbsp.") auf
 *        ihre Kuerzel ziehen ("tbsp", "TL") - eine Fassung fuer Rezept- und
 *        Mahlzeit-Routen, damit dasselbe Mass nicht je nach Importer und
 *        Handeingabe unter zwei Namen in der Datenbank liegt.
 * Abhaengigkeiten: keine
 *
 * Isomorph und bewusst importfrei (Eintrag in der SHARED_ISOMORPHIC-Allowlist
 * von test-layer-boundary.js, ebenso wie pantry-units.js): der Server normiert
 * beim Schreiben, und ein Formular kann dieselbe Map fuer eine Vorschau nutzen,
 * ohne eine zweite Fassung zu pflegen.
 *
 * NUR BEKANNTE, GANZE EINHEITEN. Alles Unbekannte ("cloves", "Prise", "eine
 * große Dose") steht ungeprueft weiter im Feld - ein Kuerzel dafuer zu erraten
 * waere Raten ueber den Sinn fremder Texte, und die Spalte ist ohnehin
 * Freitext. Auch wird nichts zusammengezogen oder umgerechnet: "500 ml" ist
 * eine Menge mit Einheit, keine Einheit; die Aufteilung in beides haben die
 * Aufrufer schon.
 */

/* DEUTSCH GROSS, ENGLISCH KLEIN - weil die Kuerzel so gelesen werden.
 * "EL"/"TL" sind im Deutschen konventionell grossgeschrieben, "tbsp"/"tsp"
 * im Englischen klein; "g"/"kg"/"ml"/"l" sind SI und klein, "fl oz" zweiteilig.
 * Der Schlüssel ist kleingeschrieben, damit Gross-/Kleinschreibung des
 * Eingabewerts keine Rolle spielt - der ZIELWERT traegt seine eigene.
 *
 * KEINE UMKRECHUNGEN: "Essloeffel" und "tablespoon" sind dasselbe Mass mit
 * zwei Namen, beide zeigen auf "EL" nicht aber auf "tbsp" - eine Sprache
 * umzusetzen hiesse, beim Kochen die Rezept-Sprache mitzuwechseln.
 * "Tasse"/"cup" fehlt bewusst: "c" ist mehrdeutig (cup/century/clove), und
 * ein Wort, das schon kurz ist, braucht kein Kuerzel.
 */
const UNIT_ABBREVIATIONS = Object.freeze(new Map([
  ['tablespoon', 'tbsp'], ['tablespoons', 'tbsp'],
  ['teaspoon', 'tsp'], ['teaspoons', 'tsp'],
  ['gram', 'g'], ['grams', 'g'], ['gramm', 'g'], ['gramme', 'g'], ['grammes', 'g'],
  ['kilogram', 'kg'], ['kilograms', 'kg'], ['kilogramm', 'kg'], ['kilogramme', 'kg'], ['kilogrammes', 'kg'],
  ['milligram', 'mg'], ['milligrams', 'mg'], ['milligramm', 'mg'],
  ['liter', 'l'], ['liters', 'l'], ['litre', 'l'], ['litres', 'l'],
  ['milliliter', 'ml'], ['milliliters', 'ml'], ['millilitre', 'ml'], ['millilitres', 'ml'],
  ['ounce', 'oz'], ['ounces', 'oz'], ['unze', 'oz'], ['unzen', 'oz'],
  ['fluid ounce', 'fl oz'], ['fluid ounces', 'fl oz'],
  ['pound', 'lb'], ['pounds', 'lb'], ['pfund', 'lb'],
  ['pint', 'pt'], ['pints', 'pt'],
  ['quart', 'qt'], ['quarts', 'qt'],
  ['gallon', 'gal'], ['gallons', 'gal'],
  ['esslöffel', 'EL'], ['essloeffel', 'EL'],
  ['teelöffel', 'TL'], ['teeloeffel', 'TL'],
]));

/**
 * Eine ausgeschriebene Einheit auf ihr Kuerzel ziehen.
 *
 * Gross-/Kleinschreibung und ein abschliessender Punkt ("Tbsp.") sind egal;
 * mehrfache Leerzeichen innen ("fluid  ounce") werden gezogen. Leere Eingabe
 * ergibt null wie bisher, Unbekanntes steht weiter im Feld.
 *
 * @param {any} value Eingabe-Einheit (Freitext aus dem Request-Body)
 * @returns {string|null} Kuerzel, oder der getrimmte Originaltext; leer → null
 */
export function normalizeUnitText(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const key = s.replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase();
  return UNIT_ABBREVIATIONS.get(key) ?? s;
}
