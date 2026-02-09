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
  // Fix the 108 bin locations that were missed
  const r1 = await pool.query("UPDATE warehouse_locations SET location_type = 'pick', bin_type = 'bin' WHERE location_type = 'bin'");
  console.log(`Fixed ${r1.rowCount} bin → pick locations`);

  // Also fix defaults that were missed (replen_rule_overrides doesn't exist yet, skip it)
  const r2 = await pool.query("ALTER TABLE warehouse_locations ALTER COLUMN location_type SET DEFAULT 'pick'");
  console.log('Set warehouse_locations.location_type default to pick');

  // Verify
  const { rows: types } = await pool.query("SELECT location_type, count(*) as cnt FROM warehouse_locations GROUP BY location_type ORDER BY cnt DESC");
  console.log('\nLocation types:', types);
  const { rows: bins } = await pool.query("SELECT bin_type, count(*) as cnt FROM warehouse_locations GROUP BY bin_type ORDER BY cnt DESC");
  console.log('Bin types:', bins);

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
