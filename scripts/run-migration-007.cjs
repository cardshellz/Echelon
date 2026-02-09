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
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '007_velocity_replen_thresholds.sql'), 'utf-8');

  // Split on semicolons, filter empty — but keep statements that start with comments
  const statements = sql.split(';')
    .map(s => s.trim())
    .filter(s => {
      // Remove pure comment-only blocks
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

  const { rows: replenCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'replen_tier_defaults' AND column_name IN ('min_qty', 'trigger_value')
    ORDER BY column_name
  `);
  console.log('replen_tier_defaults columns:', replenCols.map(r => r.column_name));

  const { rows: rulesCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'replen_rules' AND column_name IN ('min_qty', 'trigger_value')
    ORDER BY column_name
  `);
  console.log('replen_rules columns:', rulesCols.map(r => r.column_name));

  const { rows: settingsCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'warehouse_settings' AND column_name = 'velocity_lookback_days'
  `);
  console.log('warehouse_settings has velocity_lookback_days:', settingsCols.length > 0);

  const { rows: lrcTable } = await pool.query(`
    SELECT table_name FROM information_schema.tables WHERE table_name = 'location_replen_config'
  `);
  console.log('location_replen_config table exists:', lrcTable.length > 0);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
