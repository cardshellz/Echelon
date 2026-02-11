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
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '009_channel_feeds_channel_id.sql'), 'utf-8');

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

  const { rows: cols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'channel_feeds' AND column_name = 'channel_id'
  `);
  console.log('channel_feeds has channel_id:', cols.length > 0);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
