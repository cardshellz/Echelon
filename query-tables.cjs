require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_name IN ('product_variants', 'product_assets')").then(res => {
  console.log(res.rows);
  process.exit(0);
}).catch(console.error);
