const m = await import('/app/server/db.js');
const db = m.get();
const rows = db.prepare(
  "SELECT i.name, i.quantity, i.unit, i.secondary_quantity, i.secondary_unit "
  + "FROM recipe_ingredients i JOIN recipes r ON r.id = i.recipe_id "
  + "WHERE r.title LIKE '%Gingerbread%' ORDER BY i.id ASC LIMIT 8"
).all();
console.log(JSON.stringify(rows, null, 1));
