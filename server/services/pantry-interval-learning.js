/**
 * Modul: Nachkauf-Regel lernt aus jedem Weg auf die Einkaufsliste
 * Zweck: EINE Stelle dafuer, dass das Anlegen eines Einkaufsartikels die
 *        Nachkauf-Regel ("usually buy every X days", `restock_interval_days`)
 *        gleichnamiger Vorratszeilen an die beobachtete Taktung anpasst.
 *        Die Handanlage (routes/shopping.js, POST /:listId/items) tat das
 *        bereits allein; die Uebertraege der Kueche (Rezept -> Einkauf,
 *        Mahlzeit -> Einkauf, Woche -> Einkauf, Essensplan-Import) gingen
 *        es still uebergehen - derselbe Artikel lernte also nur dann, wenn
 *        er von Hand getippt wurde. Diese Luecke ist mit #1608 geschlossen:
 *        jeder Weg auf die Liste ist ein Einkaufs-Signal, keiner ausgenommen.
 * Abhaengigkeiten: server/db.js, server/permissions.js, ./household-modules.js
 */

import * as db from '../db.js';
import { mayWriteModule } from '../permissions.js';
import { householdDisabledModules } from './household-modules.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RESTOCK_INTERVAL_DAYS = 3650;

/**
 * Die seit dem letzten Einkauf vergangenen Tage, begrenzt auf das Fenster
 * 7–3650 - derselbe Wert, den `restock_interval_days` laut CHECK aufnehmen
 * darf. Ohne lesbares Kaufdatum null: dann weiss der Haushalt nichts ueber
 * den Takt, und die Regel bleibt stehen, wie sie ist.
 *
 * Frueher lokal in routes/shopping.js definiert; hierher gehoben, weil die
 * Uebertraege dieselbe Rechnung brauchen - zwei Fassungen derselben Formel
 * wuerden dort auseinanderlaufen, wo es niemand sieht.
 */
export function daysSincePurchase(lastPurchasedAt, now = new Date()) {
  const purchasedAt = Date.parse(lastPurchasedAt);
  if (!Number.isFinite(purchasedAt)) return null;
  return Math.min(MAX_RESTOCK_INTERVAL_DAYS, Math.max(7, Math.floor((now.getTime() - purchasedAt) / DAY_MS)));
}

/**
 * Das Lernen selbst: alle Vorratszeilen desselben Namens (ohne Gross-/
 * Kleinschreibung) MIT Nachkaufregel bekommen die seit dem letzten Einkauf
 * beobachtete Tageszahl. Nur Zeilen mit Regel - eine ohne
 * `restock_interval_days` ist vom Haushalt nie als "diese Ware kaufe ich
 * nach" behauptet worden. `last_purchased_at` bleibt unangetastet: der
 * Anker des Zyklus wandert erst, wenn der Einkauf wirklich im Vorrat ankommt
 * (POST /pantry/import-shopping), nicht schon beim Auf-die-Liste-Schreiben.
 *
 * DIE RECHTE-FRAGE ENTSCHEIDET DIE ROUTE, NICHT DIESES HELFER. Die Handanlage
 * verweigert sich ganz (403), wenn es gleichnamige Vorratszeilen gibt und der
 * Akteur den Vorrat nicht schreiben darf - dort ist das Lernen Teil der
 * Handlung. Die Uebertraege der Kueche sind primaer ein anderer Vorgang:
 * "Rezept auf die Liste" darf nicht daran scheitern, dass ausgerechnet der
 * Vorrat dazwischenkommt. Sie folgen damit dem Vorbild der Kategorie-Lesart
 * (services/shopping-pantry-category.js): ohne Schreibrecht am Vorrat bleibt
 * alles, wie es war - still und ohne 403, der Transfer selbst nie gesperrt.
 * Ist das Vorrats-Modul haushaltweit abgeschaltet, gibt es nichts zu lernen.
 *
 * GILT NICHT FUER DIE RUECKNAHME: ein Undo (`POST /shopping/items/undo-
 * transfer`) stellt diese Anpassung NICHT zurueck. Die Handanlage kennt kein
 * Undo des Lernens ebensowenig - auch ihr Loeschen laesst die gelernte Regel
 * stehen - und der Vorratspfad (quantity −1, Intervall −7) hat sein eigenes
 * Vorher/Nachher-Protokoll nur, weil ER den Vorrat als Teil der Handlung
 * bucht. Das hier ist ein Beobachtungssignal, kein Bestandsvorgang.
 *
 * @param {object} req Express-Request (Akteur fuer die Rechte-Frage)
 * @param {string} name Artikelname, wie er auf die Liste wandert
 * @param {Date} now Zeitpunkt des Einkaufs-Signals
 * @returns {boolean} true, wenn mindestens eine Regel angepasst wurde
 */
export function learnRestockInterval(req, name, now = new Date()) {
  if (householdDisabledModules(db.get()).has('pantry')) return false;
  if (!mayWriteModule(req, 'pantry')) return false;

  const raw = String(name ?? '').trim();
  if (!raw) return false;

  const matching = db.get().prepare(`
    SELECT id, last_purchased_at FROM pantry_items
    WHERE name = ? COLLATE NOCASE AND restock_interval_days IS NOT NULL
  `).all(raw);
  if (!matching.length) return false;

  const update = db.get().prepare('UPDATE pantry_items SET restock_interval_days = ? WHERE id = ?');
  let learned = false;
  for (const row of matching) {
    const intervalDays = daysSincePurchase(row.last_purchased_at, now);
    if (intervalDays !== null) {
      update.run(intervalDays, row.id);
      learned = true;
    }
  }
  return learned;
}
