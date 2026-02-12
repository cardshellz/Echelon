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
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '010_replen_schema_sync.sql'), 'utf-8');

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

  const { rows: rulesCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'replen_rules' AND column_name IN ('pick_location_type', 'source_location_type', 'source_priority')
    ORDER BY column_name
  `);
  console.log('replen_rules new columns:', rulesCols.map(r => r.column_name));

  const { rows: tasksCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'replen_tasks' AND column_name = 'execution_mode'
  `);
  console.log('replen_tasks has execution_mode:', tasksCols.length > 0);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
