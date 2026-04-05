import { db } from './server/db.js';
import { sql } from 'drizzle-orm';
async function f() {
  const r = await db.execute(sql`SELECT json_payload FROM shopify_orders WHERE json_payload IS NOT NULL LIMIT 1`);
  if (!r.rows[0]) { console.log('no rows'); }
  else {
    const raw = r.rows[0].json_payload;
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    console.log(Object.keys(obj));
  }
  process.exit(0);
}
f();
