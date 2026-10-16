/**
 * Modul: Vorrats-Kategorie fuer Zutaten-Uebertraege
 * Zweck: EINE Lesart dafuer, welche Einkaufs-Kategorie eine Zutat bekommt, wenn
 *        der Haushalt dieselbe Ware schon im Vorrat fuehrt - fuer alle Uebertrage
 *        der Kueche (Rezept -> Einkauf, Mahlzeit -> Einkauf, Woche -> Einkauf,
 *        Essensplan-Import), die vorher jeweils die gespeicherte Zutaten-
 *        Kategorie ungeprueft uebernahmen.
 * Abhaengigkeiten: server/db.js, server/permissions.js, ./household-modules.js
 */

import * as db from '../db.js';
import { mayReadModule } from '../permissions.js';
import { householdDisabledModules } from './household-modules.js';

/* DER VORRAT ALS QUELLE DER KATEGORIE - NUR GELESEN, NIE ZURUECKGESCHRIEBEN.
 *
 * Das manuelle Anlegen eines Artikels (routes/shopping.js, POST /:listId/items)
 * macht diese Suche bereits: ein gleichnamiger Vorratseintrag mit Nachkauf-
 * regel gibt seine Kategorie her. Die Uebertrage taten es bislang nicht - dieselbe
 * Ware lag also in der Handanlage in der Kategorie des Vorrats und aus einem
 * Rezept in der der Zutat, zwei Antworten auf dieselbe Frage. Diese Funktion
 * ist die gemeinsame Rueckseite: sie liest dieselben Zeilen wie die Handanlage
 * (nur Vorrat mit Nachkaufregel, `restock_interval_days IS NOT NULL` - eine Zeile
 * ohne Regel ist vom Haushalt nie als "diese Ware kaufe ich nach" behauptet
 * worden) und denselben Best-Match (niedrigste ID, Gross-/Kleinschreibung und
 * einfache Plural-Formen wie in der Handanlage).
 *
 * NUR LESEN, UND DAMIT KEIN NEUES RECHT AM SCHREIBWEG. Der Uebertrag schreibt
 * in `shopping_items` und braucht deshalb `shopping: write` - der Vorrat wird
 * hier bloss EINEM Namen nach gelesen, dieselbe Mischstelle wie
 * `attachPantryMatches()` in routes/recipes.js: `mayReadModule(req, 'pantry')`
 * entscheidet, und ohne das Recht bleibt die gespeicherte Zutaten-Kategorie
 * stehen, still und ohne 403 - der Einkauf selbst wird davon nicht unmoeglich
 * gemacht, er fuehlt sich nur nicht am Vorrat entlang. Ist das Vorrats-Modul
 * haushaltweit abgeschaltet, gibt es schlicht nichts zu suchen.
 *
 * @param {object} req Express-Request (Akteur fuer die Rechte-Frage)
 * @param {string} name Zutatenname, wie er auf die Liste wandert
 * @returns {string|null} Kategorie der passenden Vorratszeile, sonst null
 */
export function pantryCategoryFor(req, name) {
  if (householdDisabledModules(db.get()).has('pantry')) return null;
  if (!mayReadModule(req, 'pantry')) return null;

  const raw = String(name ?? '').trim();
  if (!raw) return null;

  const matching = db.get().prepare(`
    SELECT id, name, category FROM pantry_items
    WHERE name = ? COLLATE NOCASE AND restock_interval_days IS NOT NULL
  `).all(raw);
  if (!matching.length) return null;

  // Dieselbe Best-Match-Regel wie die Handanlage: erst die niedrigste ID,
  // dann - darueber - Vorzug fuer die Plural-Form des schon Gewaehlten.
  let best = matching[0];
  for (const item of matching) {
    if (item.id < best.id) best = item;
  }
  for (const item of matching) {
    if (item.id < best.id && namesMatch(best.name, item.name)) best = item;
  }
  return best.category || null;
}

// Abschrift der Namens-Angleichung aus routes/shopping.js (Handanlage): exakt
// ohne Gross-/Kleinschreibung, zusaetzlich einfache Plural-Formen ("Eier"/"Ei").
// Bewusst keine eigene Verbesserung: zwei Fassungen dieses Vergleichs wuerden
// dort auseinanderlaufen, wo es niemand sieht - die Handanlage nimmt "Eier" an,
// der Uebertrag nicht.
function namesMatch(name1, name2) {
  const n1 = String(name1).toLowerCase().trim();
  const n2 = String(name2).toLowerCase().trim();
  if (n1 === n2) return true;
  if (n1.endsWith('s') && n2 === n1.slice(0, -1)) return true;
  if (n2.endsWith('s') && n1 === n2.slice(0, -1)) return true;
  return false;
}
