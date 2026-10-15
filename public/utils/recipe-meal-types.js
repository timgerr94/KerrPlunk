const RECIPE_MEAL_TYPE_KEYS = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack']);

/**
 * Die Mahlzeiten eines Rezepts als geprüfte Liste.
 *
 * LEER IST EINE ANTWORT, KEINE LÜCKE: Wer alle Haken entfernt, meint „dieses
 * Rezept gehört in keine Mahlzeit" - es soll dann weder im Mahlzeit-Filter noch
 * in der Zufallsauswahl des Menüplans auftauchen. Bis v2.8.0 machte eine leere
 * Auswahl daraus stillschweigend alle vier Mahlzeiten; sichtbar wurde das erst
 * beim nächsten Öffnen des Formulars (#750).
 *
 * Fehlt die Angabe dagegen ganz (`null`/`undefined` - ein Aufrufer, der das Feld
 * nicht mitschickt), gilt weiterhin die Vorgabe „alle". Das ist der Unterschied
 * zwischen „nichts gewählt" und „nicht gefragt": Die Spalte ist seit ihrer
 * Migration NOT NULL mit allen vier als Vorgabe, ein leerer Wert kann also nur
 * aus einer bewussten Abwahl stammen.
 *
 * @param {string[]|string|null|undefined} value Kommaliste, Array oder nichts
 * @returns {string[]} bekannte Mahlzeiten-Schlüssel, ohne Dubletten
 */
function normalizeRecipeMealTypes(value) {
  if (value === null || value === undefined) return [...RECIPE_MEAL_TYPE_KEYS];
  
  const source = Array.isArray(value)
    ? value
    : String(value)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

  // Normalize every incoming string to lowercase before validating it
  const normalizedSource = source.map((type) => String(type).toLowerCase());

  // Filter against your valid keys and deduplicate using Set
  return [...new Set(normalizedSource.filter((type) => RECIPE_MEAL_TYPE_KEYS.includes(type)))];
}
/**
 * Erklärt das Rezept diese Mahlzeit? Maßstab für alles, was OHNE Zutun des
 * Nutzers auswählt - der Zufallsvorschlag des Menüplans vor allem. Ein Rezept
 * ohne Mahlzeit erklärt keine und kommt dort nicht mehr vor (#750).
 */
function recipeSupportsMealType(recipe, mealType) {
  return normalizeRecipeMealTypes(recipe?.meal_types).includes(mealType);
}

/**
 * Darf der Nutzer dieses Rezept selbst in diese Mahlzeit legen?
 *
 * Weiter gefasst als recipeSupportsMealType, und das ist der Punkt: „gehört in
 * keine Mahlzeit" hält ein Rezept aus der Automatik heraus, es soll es nicht
 * unbrauchbar machen. Wer es von Hand in den Dienstagabend zieht, hat die
 * Entscheidung ja gerade getroffen. Ohne diese Trennung wäre ein Rezept ohne
 * Mahlzeit weder auswählbar noch einplanbar - nur noch Text in einer Liste.
 */
function recipeAllowsMealType(recipe, mealType) {
  const types = normalizeRecipeMealTypes(recipe?.meal_types);
  return types.length === 0 || types.includes(mealType);
}

export {
  RECIPE_MEAL_TYPE_KEYS,
  normalizeRecipeMealTypes,
  recipeSupportsMealType,
  recipeAllowsMealType,
};
