import { db, sql } from "../server/storage/base";
import "dotenv/config";

async function run() {
  const r = await db.execute(sql`SELECT table_name, table_schema FROM information_schema.tables WHERE table_name IN ('products', 'product_variants')`);
  console.log(r.rows);
  
  const b = await db.execute(sql`SELECT schema_name FROM information_schema.schemata`);
  console.log("Schemas:", b.rows.map(x => x.schema_name));
  
  process.exit(0);
}
run();
