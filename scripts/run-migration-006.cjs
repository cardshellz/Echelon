const fs = require('fs');
const path = require('path');

// Load .env
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
const pool = new Pool({
  connectionString: process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '006_location_type_taxonomy.sql'), 'utf-8');

  // Split on semicolons, filter empty
  const statements = sql.split(';').map(s => s.trim()).filter(s => s && !s.startsWith('--'));

  console.log(`Running ${statements.length} statements...\n`);

  for (const stmt of statements) {
    const preview = stmt.replace(/\s+/g, ' ').substring(0, 80);
    try {
      const result = await pool.query(stmt);
      console.log(`  OK (${result.rowCount} rows): ${preview}...`);
    } catch (e) {
      console.error(`  FAIL: ${preview}...`);
      console.error(`    ${e.message}`);
    }
  }

  // Verify
  console.log('\n=== VERIFICATION ===');
  const { rows: types } = await pool.query("SELECT location_type, count(*) as cnt FROM warehouse_locations GROUP BY location_type ORDER BY cnt DESC");
  console.log('Location types:', types);
  const { rows: bins } = await pool.query("SELECT bin_type, count(*) as cnt FROM warehouse_locations GROUP BY bin_type ORDER BY cnt DESC");
  console.log('Bin types:', bins);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
