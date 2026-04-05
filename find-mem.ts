import "dotenv/config";
import { db, sql } from "./server/storage/base";
async function run() {
  try {
    const res = await db.execute(sql`SELECT id, title, handle FROM shopify_products WHERE title ILIKE '%membership%' OR title ILIKE '%shellz club%' OR title ILIKE '%.club%'`);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch(e) {
    console.error(e);
  }
  process.exit(0);
}
run();
