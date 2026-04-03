import "dotenv/config";
import { db, sql } from "./server/storage/base";
async function run() {
  try {
    const res = await db.execute(sql`
      SELECT cc.shop_domain, c.name, c.is_default 
      FROM channel_connections cc
      JOIN channels c ON c.id = cc.channel_id
      WHERE c.provider = 'shopify'
    `);
    console.log(res.rows);
  } catch(e) {
    console.error(e);
  }
  process.exit(0);
}
run();
