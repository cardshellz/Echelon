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
const pool = new Pool({
  connectionString: process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '021_bin_assignment_variant_fk.sql'), 'utf-8');

  const statements = sql.split(';')
    .map(s => s.trim())
    .filter(s => {
      const withoutComments = s.replace(/--[^\n]*/g, '').trim();
      return withoutComments.length > 0;
    });

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

  const { rows: colCheck } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'product_locations' AND column_name = 'product_variant_id'
  `);
  console.log('product_variant_id column exists:', colCheck.length > 0);

  const { rows: totalPl } = await pool.query('SELECT COUNT(*) as cnt FROM product_locations');
  const { rows: filledPl } = await pool.query('SELECT COUNT(*) as cnt FROM product_locations WHERE product_variant_id IS NOT NULL');
  console.log(`product_locations: ${totalPl[0].cnt} total, ${filledPl[0].cnt} with product_variant_id set`);

  const { rows: idxCheck } = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'product_locations' AND indexname = 'idx_product_locations_variant_id'
  `);
  console.log('Index exists:', idxCheck.length > 0);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
