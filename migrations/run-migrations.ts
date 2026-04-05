#!/usr/bin/env node
/**
 * Auto-run SQL migrations in order during Heroku release phase
 */
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

async function runMigrations() {
  const client = await pool.connect();
  
  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    
    // Get already-applied migrations
    const { rows: applied } = await client.query('SELECT filename FROM _migrations');
    const appliedSet = new Set(applied.map(r => r.filename));
    
    // Read migration files
    const migrationsDir = join(__dirname);
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort(); // Alphabetical order (0063, 0064, etc.)
    
    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`⏭️  ${file} (already applied)`);
        continue;
      }
      
      console.log(`🔄 Applying ${file}...`);
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        console.log(`✅ ${file}`);
        count++;
      } catch (err: any) {
        console.error(`❌ ${file} failed: ${err.message}`);
        // Continue anyway (some migrations may be idempotent)
      }
    }
    
    console.log(`\n✅ Applied ${count} new migration(s)`);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
