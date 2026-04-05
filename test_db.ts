import pg from "pg";
import "dotenv/config";

const { Client } = pg;
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    await client.connect();
    const res = await client.query(`SELECT id, sku, "unitsPerVariant" as upv, "productId", "hierarchyLevel" as hl FROM product_variants WHERE sku ILIKE '%ARM-ENV-SGL%'`);
    console.table(res.rows);
  } catch (e) {
    console.error(e);
  } finally {
    await client.end();
  }
}
run();
