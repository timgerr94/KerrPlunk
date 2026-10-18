/**
 * Modul: Ernaehrungsformen (Diets) fuer Rezepte
 * Zweck: Die sechs kuratierten Diets als Schluessel + i18n, die Anzeige-Reihenfolge
 *        und eine best-effort-Normalisierung fuer Importer-Schreibweisen.
 * Abhaengigkeiten: keine
 *
 * Isomorph und bewusst importfrei (Eintrag in der SHARED_ISOMORPHIC-Allowlist
 * von test-layer-boundary.js): der Server normiert beim Schreiben, das Modal
 * baut aus derselben Liste seine Umschalt-Chips - zwei Fassungen wuerden an
 * dem Wert auseinanderlaufen, den beide sehen.
 *
 * KURATIERT, NICHT GESCHLOSSEN. Die Liste legt fest, was das Modal als Chips
 * ANBIETET; der Server speichert jede Ernaehrungsform, die ein Importer
 * schickt. Die Normalisierung unten ordnet nur gelaeufigen Schreibweisen
 * ("gf", "dairy free") ihre kanonische Form zu - was sie nicht kennt, bleibt
 * wortgetreu stehen (dasselbe Prinzip wie units: kein Kuerzel erraten).
 */

/** Die kuratierten Diets in Anzeige-Reihenfolge (auch-chip-Reihenfolge im Modal). */
export const RECIPE_DIET_KEYS = Object.freeze([
  'vegan', 'vegetarian', 'pescatarian', 'gluten-free', 'dairy-free', 'nut-free',
]);

/** i18n-Schluessel je Diet - t() liest sie, alle Locales tragen sie. */
export function recipeDietLabelKey(diet) {
  return `recipes.diet_${diet}`;
}

/* BEST-EFFORT, KEIN KATALOG. Gelaeufige Kurz- und Variantenschreibweisen, die
 * Importer schicken, werden auf die kanonischen Schluessel gezogen - getrimmt,
 * kleingeschrieben, Bindestrich statt Leerzeichen. Alles, was hier nicht
 * steht, bleibt wortgetreu: ein unbekannter Wert ist eine Aussage des
 * Absenders ("mediterranean"), und Raten waere genau die Ableitung, die
 * docs/DECISIONS.md Abschnitt 7 ablehnt. */
const DIET_VARIANTS = new Map([
  // gluten-free
  ['gf', 'gluten-free'], ['glutenfree', 'gluten-free'], ['gluten free', 'gluten-free'],
  ['g-free', 'gluten-free'], ['coeliac', 'gluten-free'], ['celiac', 'gluten-free'],
  // dairy-free
  ['df', 'dairy-free'], ['dairyfree', 'dairy-free'], ['dairy free', 'dairy-free'],
  ['lactose-free', 'dairy-free'], ['lactosefree', 'dairy-free'], ['lactose free', 'dairy-free'],
  ['milk-free', 'dairy-free'], ['milk free', 'dairy-free'],
  // nut-free
  ['nf', 'nut-free'], ['nutfree', 'nut-free'], ['nut free', 'nut-free'],
  ['peanut-free', 'nut-free'], ['peanut free', 'nut-free'],
  // pescatarian
  ['pescetarian', 'pescatarian'], ['pescatarian diet', 'pescatarian'],
  // vegetarian
  ['veggie', 'vegetarian'], ['vegetarian diet', 'vegetarian'],
  // vegan
  ['vegan diet', 'vegan'],
]);

/**
 * Eine Importer-Diet auf ihre kanonische Form ziehen, wenn gelaeufig.
 *
 * Trimmt, kleinschreibt, vereinheitlicht Trennzeichen zu Bindestrich und
 * zieht gelaeufige Kurznamen ("gf") auf ihre Langform. Unbekanntes bleibt
 * wortgetreu (getrimmt, Bindestrich) - es wird nicht weggeworfen und nicht
 * geraten. Leere Eintraege fallen weg.
 *
 * @param {any} value Eintrag aus dem diet-Array
 * @returns {string|null} kanonischer Schluessel, wortgetreuer Text, oder null
 */
export function normalizeRecipeDiet(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (RECIPE_DIET_KEYS.includes(key)) return key;
  return DIET_VARIANTS.get(key) ?? raw.replace(/[\s_]+/g, '-');
}
