process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import pg from 'pg';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();
const connectionString = process.env.DATABASE_URL.includes('sslmode') ? process.env.DATABASE_URL : process.env.DATABASE_URL + '?sslmode=require';
const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
async function run() {
  const { rows } = await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema IN ('public', 'oms', 'wms')");
  const schema = {};
  for (const row of rows) {
    if (!schema[row.table_name]) schema[row.table_name] = [];
    schema[row.table_name].push(row.column_name);
  }
  fs.writeFileSync('schema-dump.json', JSON.stringify(schema, null, 2));
  process.exit(0);
}
run();
