/**
 * Modul: Zutaten-Kategorisierung für importierte Rezepte
 * Zweck: Best-effort Zuordnung von Zutaten aus gespiegelten Rezepten (Mealie,
 *        Tandoor, ...) zu den bestehenden shopping_categories-Namen (server/db.js
 *        Migration v5). Ein vom Provider mitgeliefertes Zutaten-Label (vom Nutzer
 *        dort frei vergeben) wird zuerst versucht, dann eine Keyword-Liste auf dem
 *        Zutatennamen - beides ist Raten, kein Abgleich gegen eine feste Taxonomie.
 *        Fällt beides durch, landet die Zutat unter 'Sonstiges', genau wie jede
 *        andere unkategorisierte Zutat im Haushalt.
 * Dependencies: keine
 */

const FALLBACK_CATEGORY = 'Sonstiges';

// Deutsche, englische und norwegische Stichworte, da Provider-Instanzen in
// diesen Sprachen befüllt sein können. Reihenfolge ist irrelevant, die erste
// Übereinstimmung zählt.
const KEYWORDS = {
  'Produce': [
    'apple', 'apfel', 'banana', 'banane', 'tomato', 'tomate', 'onion', 'zwiebel',
    'garlic', 'knoblauch', 'potato', 'kartoffel', 'carrot', 'karotte', 'lemon',
    'zitrone', 'lime', 'pepper', 'paprika', 'lettuce', 'salat', 'spinach', 'spinat',
    'cucumber', 'gurke', 'vegetable', 'gemüse', 'fruit', 'obst', 'herb', 'kräuter',
<<<<<<< HEAD
    'basil', 'basilikum', 'parsley', 'petersilie', 'mushroom', 'pilz', 'løk', 'rødløk',
    'vårløk', 'hvitløk', 'potet', 'poteter', 'gulrot', 'gulrøtter', 'tomat', 'tomater',
    'agurk', 'brokkoli', 'blomkål', 'kål', 'purre', 'sopp', 'sitron', 'eple', 'epler',
    'banan', 'bananer', 'frukt', 'grønnsaker', 'persille', 'koriander', 'ingefær',
  ],
  'Backwaren': [
    'flour', 'mehl', 'bread', 'brot', 'baking powder', 'backpulver', 'yeast',
    'hefe', 'bun', 'brötchen', 'tortilla', 'noodle', 'nudel', 'pasta', 'mel',
    'hvetemel', 'brød', 'rundstykker', 'gjær', 'bakepulver', 'nudler', 'spaghetti',
  ],
  'Milchprodukte': [
    'milk', 'milch', 'cheese', 'käse', 'butter', 'cream', 'sahne', 'yogurt',
    'joghurt', 'egg', 'ei', 'eier', 'melk', 'lettmelk', 'helmelk', 'ost',
    'smør', 'fløte', 'matfløte', 'kremfløte', 'rømme', 'yoghurt',
=======
    'basil', 'basilikum', 'parsley', 'petersilie', 'mushroom', 'pilz','lettuce','greens',
    'kale', 'grünkohl','pineapple','berries','mango','mangoes','zucchini','greens','pear',
    'aprikose','apricot','berry','beere','strawberry','erdbeere','blueberry','heidelbeere',
    'raspberry','himbeere','avacado','peach'
  ],
  'Backwaren': [
    'flour', 'mehl', 'bread', 'baking powder', 'backpulver', 'yeast',
    'hefe', 'bun', 'brötchen', 'tortilla', 'noodle', 'nudel', 'pasta',
  ],
  'Milchprodukte': [
    'milk', 'milch', 'cheese', 'käse', 'butter', 'cream', 'sahne', 'yogurt',
    'joghurt','ghee','ricotta',
>>>>>>> ba5d29180 (Commit 10/8/2026)
  ],
  'Meat & Eggs': [
    'chicken', 'hähnchen', 'huhn', 'beef', 'rind', 'pork', 'schwein', 'fish',
    'fisch', 'salmon', 'lachs', 'shrimp', 'garnele', 'bacon', 'speck', 'sausage',
<<<<<<< HEAD
    'wurst', 'meat', 'fleisch', 'kylling', 'kyllingfilet', 'kjøtt', 'kjøttdeig',
    'svinekjøtt', 'storfe', 'fisk', 'laks', 'torsk', 'reker', 'pølse', 'pølser', 'skinke',
  ],
  'Tiefkühl': ['frozen', 'tiefkühl', 'tiefgefroren', 'ice cream', 'eis', 'frossen', 'frosne', 'fryst'],
  'Getränke': ['juice', 'saft', 'wine', 'wein', 'beer', 'bier', 'water', 'wasser', 'soda', 'cola', 'vin', 'øl', 'vann', 'brus'],
  'Haushalt': ['foil', 'folie', 'napkin', 'serviette', 'detergent', 'waschmittel', 'aluminiumsfolie', 'servietter', 'vaskemiddel', 'oppvaskmiddel'],
  'Drogerie': ['soap', 'seife', 'shampoo', 'toothpaste', 'zahnpasta', 'såpe', 'sjampo', 'tannkrem'],
=======
    'wurst', 'meat', 'fleisch', 'egg', 'ei', 'eier','ham','prosciutto','beef','turkey',
    'tuna','crab','lobster','tilapia','catfish','salami','bologna','pastrami','corned beef',
  ],
  'Tiefkühl': ['frozen', 'tiefkühl', 'tiefgefroren', 'ice cream', 'eis','popsicle','ice'],
  'Juice & Beverages': ['juice', 'saft', 'wine', 'wein', 'beer', 'bier', 'water', 'wasser', 'soda', 'cola', 'tea', 'tee','pop','prosecco','liquer','coke','spindrift'],
  'Haushalt': ['shampoo','foil', 'folie', 'napkin', 'serviette', 'detergent', 'waschmittel','paper','utensils','cleaner','spoon', 'fork', 'knife','towel','soap','toothpaste','brush','bürste','scrub'],
  'Drogerie': ['seife','zahnpasta'],
>>>>>>> ba5d29180 (Commit 10/8/2026)
};

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Wortgrenzen statt reinem .includes(): sonst matcht das kurze Stichwort 'ei'
// (Ei/Eier) versehentlich mitten in 'Fleisch' ('fl-ei-sch'). \p{L}/\p{N} statt
// des ASCII-\b, damit Umlaute (ä/ö/ü) keine falsche Wortgrenze erzeugen.
function containsWord(text, keyword) {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(keyword)}(?![\\p{L}\\p{N}])`, 'iu');
  return pattern.test(text);
}

function matchKeywords(text) {
  if (!text) return null;
  for (const [category, keywords] of Object.entries(KEYWORDS)) {
    if (keywords.some((kw) => containsWord(text, kw))) return category;
  }
  return null;
}

/**
 * @param {{ labelName?: string, foodName?: string }} ingredient
 * @returns {string} Name aus shopping_categories, oder 'Sonstiges' als Fallback.
 */
export function categorizeIngredient({ labelName, foodName } = {}) {
  return matchKeywords(labelName) || matchKeywords(foodName) || FALLBACK_CATEGORY;
}
