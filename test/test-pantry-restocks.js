process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import * as dbmod from '../server/db.js';
import { processDuePantryRestocks } from '../server/services/pantry-restock.js';

const db = dbmod.get();
const userId = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('restock-test', 'Restock Test', 'x', 'member')
`).run().lastInsertRowid;
const category = db.prepare("SELECT name FROM shopping_categories WHERE name = 'Sonstiges' COLLATE NOCASE").get()?.name ?? 'Sonstiges';
const now = new Date('2026-10-01T12:00:00.000Z');

function reset() {
  db.prepare('DELETE FROM shopping_items').run();
  db.prepare('DELETE FROM pantry_items').run();
  db.prepare('DELETE FROM shopping_lists').run();
  db.prepare("DELETE FROM sync_config WHERE key = 'disabled_modules'").run();
}

function makeList(name = 'Shopping') {
  return db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run(name, userId).lastInsertRowid;
}

function makePantryItem(overrides = {}) {
  return db.prepare(`
    INSERT INTO pantry_items
      (name, quantity, unit, category, created_by, restock_interval_days, last_purchased_at, restock_snoozed_until, restock_list_id)
    VALUES (?, 1, 'pcs', ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'Oats', category, userId,
    overrides.interval ?? 7,
    overrides.purchasedAt ?? '2026-09-20T12:00:00.000Z',
    overrides.snoozedUntil ?? null,
    overrides.restockListId ?? null,
  ).lastInsertRowid;
}

test('due Pantry item creates one linked predicted row and repeated runs do not duplicate it', () => {
  reset();
  const listId = makeList();
  const pantryId = makePantryItem();

  assert.deepEqual(processDuePantryRestocks(db, now), { added: 1, skipped: 0, removed: 0 });
  assert.deepEqual(processDuePantryRestocks(db, now), { added: 0, skipped: 1, removed: 0 });
  const prediction = db.prepare('SELECT * FROM shopping_items WHERE predicted_pantry_item_id = ?').get(pantryId);
  assert.equal(prediction.list_id, listId);
  assert.equal(prediction.name, 'Oats');
  assert.equal(prediction.is_checked, 0);
});

test('due Pantry item is suggested on its purchase list', () => {
  reset();
  makeList('Oldest list');
  const purchaseListId = makeList('Usual shop');
  const pantryId = makePantryItem({ restockListId: purchaseListId });

  assert.deepEqual(processDuePantryRestocks(db, now), { added: 1, skipped: 0, removed: 0 });
  const prediction = db.prepare('SELECT list_id FROM shopping_items WHERE predicted_pantry_item_id = ?').get(pantryId);
  assert.equal(prediction.list_id, purchaseListId);
});

test('future purchase date, snooze, existing open item, and disabled kitchen skip predictions', () => {
  reset();
  const listId = makeList();
  makePantryItem({ name: 'Not due', purchasedAt: '2026-09-29T12:00:00.000Z' });
  makePantryItem({ name: 'Snoozed', snoozedUntil: '2026-10-08T12:00:00.000Z' });
  const duplicateId = makePantryItem({ name: 'Already listed' });
  db.prepare('INSERT INTO shopping_items (list_id, name, category) VALUES (?, ?, ?)').run(listId, 'Already listed', category);
  makePantryItem({ name: 'Kitchen disabled' });
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '[]')").run();

  const result = processDuePantryRestocks(db, now);
  assert.equal(result.added, 1, 'only the due non-duplicate rows should be suggested');
  assert.ok(db.prepare('SELECT 1 FROM shopping_items WHERE predicted_pantry_item_id = ?').get(duplicateId) === undefined);
  db.prepare("UPDATE sync_config SET value = '[\"shopping\"]' WHERE key = 'disabled_modules'").run();
  assert.deepEqual(processDuePantryRestocks(db, now), { added: 0, skipped: 0, removed: 1 });
});