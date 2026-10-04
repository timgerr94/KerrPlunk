import { runExternalJob } from '../utils/restore-state.js';
import { createLogger } from '../logger.js';
import { householdDisabledModules } from './household-modules.js';

const log = createLogger('PantryRestock');
const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_INTERVAL_MS = DAY_MS;

export function processDuePantryRestocks(database, now = new Date()) {
  const disabled = householdDisabledModules(database);
  if (disabled.has('pantry') || disabled.has('shopping')) {
    const removed = database.prepare('DELETE FROM shopping_items WHERE predicted_pantry_item_id IS NOT NULL').run();
    return { added: 0, skipped: 0, removed: removed.changes };
  }

  const list = database.prepare('SELECT id FROM shopping_lists ORDER BY created_at ASC, id ASC LIMIT 1').get();
  if (!list) return { added: 0, skipped: 0 };

  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const removed = database.prepare(`
    DELETE FROM shopping_items
    WHERE predicted_pantry_item_id IN (
      SELECT id FROM pantry_items
      WHERE restock_interval_days IS NULL OR last_purchased_at IS NULL
         OR datetime(last_purchased_at, '+' || restock_interval_days || ' days') > datetime(?)
         OR (restock_snoozed_until IS NOT NULL AND datetime(restock_snoozed_until) > datetime(?))
    )
  `).run(nowIso, nowIso).changes;
  const items = database.prepare(`
    SELECT * FROM pantry_items
    WHERE restock_interval_days IS NOT NULL AND last_purchased_at IS NOT NULL
    ORDER BY last_purchased_at ASC, id ASC
  `).all();
  const categoryNames = database.prepare('SELECT name FROM shopping_categories ORDER BY sort_order ASC').all().map((row) => row.name);
  const defaultCategory = categoryNames.includes('Sonstiges') ? 'Sonstiges' : categoryNames.at(-1) ?? 'Sonstiges';
  const hasPrediction = database.prepare(`
    SELECT 1 FROM shopping_items WHERE predicted_pantry_item_id = ?
  `);
  const hasOpenDuplicate = database.prepare(`
    SELECT 1 FROM shopping_items
    WHERE is_checked = 0 AND name = ? COLLATE NOCASE
    LIMIT 1
  `);
  const insertPrediction = database.prepare(`
    INSERT OR IGNORE INTO shopping_items (list_id, name, category, predicted_pantry_item_id)
    VALUES (?, ?, ?, ?)
  `);

  return database.transaction(() => {
    let added = 0;
    let skipped = 0;
    for (const item of items) {
      const purchasedAt = Date.parse(item.last_purchased_at);
      if (!Number.isFinite(purchasedAt)) { skipped += 1; continue; }
      const dueAt = purchasedAt + Number(item.restock_interval_days) * DAY_MS;
      const snoozedUntil = item.restock_snoozed_until ? Date.parse(item.restock_snoozed_until) : NaN;
      if (dueAt > nowMs || (Number.isFinite(snoozedUntil) && snoozedUntil > nowMs)) continue;
      if (hasPrediction.get(item.id) || hasOpenDuplicate.get(item.name)) { skipped += 1; continue; }

      const category = categoryNames.includes(item.category) ? item.category : defaultCategory;
      insertPrediction.run(item.restock_list_id ?? list.id, item.name, category, item.id);
      added += 1;
    }
    return { added, skipped, removed };
  })();
}

export function startPantryRestockScheduler(database) {
  const run = () => {
    runExternalJob(() => processDuePantryRestocks(database))
      .then((result) => {
        if (result.added) log.info(`Added ${result.added} due Pantry restock suggestion(s).`);
      })
      .catch((err) => log.error('Pantry restock scan failed:', err?.message || err));
  };
  setTimeout(run, 10_000).unref();
  setInterval(run, RUN_INTERVAL_MS).unref();
  log.info('Pantry restock scan active (daily, with startup catch-up).');
}