const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const idx = line.indexOf('=');
  if (idx > 0 && !line.startsWith('#')) {
    const key = line.substring(0, idx).trim();
    const val = line.substring(idx + 1).trim();
    if (key && val) process.env[key] = val;
  }
}
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const { rows: types } = await pool.query("SELECT location_type, count(*) as cnt FROM warehouse_locations GROUP BY location_type ORDER BY cnt DESC");
  console.log('=== LOCATION TYPES ===');
  for (const r of types) console.log(`  ${r.location_type}: ${r.cnt}`);

  const { rows: binTypes } = await pool.query("SELECT bin_type, count(*) as cnt FROM warehouse_locations GROUP BY bin_type ORDER BY cnt DESC");
  console.log('\n=== BIN TYPES ===');
  for (const r of binTypes) console.log(`  ${r.bin_type}: ${r.cnt}`);

  // Check for invalid location_type values (should be pick, reserve, receiving, staging)
  const { rows: bad } = await pool.query("SELECT id, code, location_type, bin_type FROM warehouse_locations WHERE location_type NOT IN ('pick', 'reserve', 'receiving', 'staging') LIMIT 20");
  console.log('\n=== INVALID LOCATION TYPES ===');
  console.log(bad.length ? bad : 'None');

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
