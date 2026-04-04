const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    await client.connect();
    
    console.log("Checking Product IDs for our SKUs...");
    const vars = await client.query(`SELECT id, sku, "productId" FROM product_variants WHERE sku ILIKE '%arm-env-sgl%'`);
    console.table(vars.rows);

    await client.end();
  } catch(e) {
    console.error("DB Query error", e);
    process.exit(1);
  }
}
run();
