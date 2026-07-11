#!/usr/bin/env node
/**
 * Auto-run SQL migrations in order during Heroku release phase
 */
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import {
  acquireMigrationAdvisoryLock,
  executeMigrationWithRetry,
  migrationErrorMessage,
  migrationRetryOptionsFromEnv,
  migrationSqlState,
  releaseMigrationAdvisoryLock,
} from './migration-executor';

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
const retryOptions = migrationRetryOptionsFromEnv(process.env);

const RENAMED_FILES: Record<string, string> = {
  "0121_replen_task_method_and_autoreplen.sql": "012_replen_task_method_and_autoreplen.sql",
  "0251_unique_variant_sku.sql": "025_unique_variant_sku.sql",
  "0501_subscription_engine.sql": "050_subscription_engine.sql",
  "0551_hub_and_spoke_warehouse.sql": "055_hub_and_spoke_warehouse.sql"
};

function hashSQL(sql: string) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function runMigrations() {
  const client = await pool.connect();
  let advisoryLockHeld = false;
  
  try {
    await acquireMigrationAdvisoryLock(client);
    advisoryLockHeld = true;

    // Check for duplicate prefixes
    const migrationsDir = join(__dirname);
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort(); // Alphabetical order (0063, 0064, etc.)

    const prefixMap = new Map<string, string>();
    for (const file of files) {
      const match = file.match(/^(\d+)_/);
      if (match) {
        const prefix = match[1];
        if (prefixMap.has(prefix)) {
          throw new Error(
            `Migration prefix collision: ${prefixMap.get(prefix)} and ${file}`,
          );
        }
        prefixMap.set(prefix, file);
      }
    }

    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    // Add content_hash for idempotent safety
    await client.query(`ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS content_hash VARCHAR(255)`);
    
    // Get already-applied migrations
    const { rows: applied } = await client.query('SELECT filename, content_hash FROM _migrations');
    const appliedSet = new Set(applied.map(r => r.filename));
    const appliedHashes = new Set(applied.map(r => r.content_hash).filter(Boolean));
    
    let count = 0;
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      const fileHash = hashSQL(sql);

      // Handle renames safely
      if (RENAMED_FILES[file] && appliedSet.has(RENAMED_FILES[file]) && !appliedSet.has(file)) {
        console.log(`📝 Updating renamed migration tracking: ${RENAMED_FILES[file]} -> ${file}`);
        await client.query("UPDATE _migrations SET filename = $1, content_hash = $2 WHERE filename = $3", [file, fileHash, RENAMED_FILES[file]]);
        appliedSet.add(file);
        appliedHashes.add(fileHash);
      }

      // Skip already-applied migrations (by filename or by hash)
      if (appliedSet.has(file) || appliedHashes.has(fileHash)) {
        if (appliedSet.has(file) && !appliedHashes.has(fileHash)) {
            // backfill hash
            await client.query("UPDATE _migrations SET content_hash = $1 WHERE filename = $2", [fileHash, file]);
        }
        console.log(`⏭️  ${file} (already applied)`);
        continue;
      }
      
      console.log(`🔄 Applying ${file}...`);
      
      try {
        const result = await executeMigrationWithRetry({
          client,
          file,
          sql,
          contentHash: fileHash,
          options: retryOptions,
          onRetry: (notice) => {
            console.warn(
              `⚠️  ${notice.file} attempt ${notice.attempt}/${notice.maxAttempts} `
              + `failed with PostgreSQL ${notice.sqlState}: ${notice.message}. `
              + `Retrying in ${notice.delayMs}ms...`,
            );
          },
        });
        console.log(`✅ ${file}`);
        if (result.attempts > 1) {
          console.log(`   Applied after ${result.attempts} attempts.`);
        }
        appliedSet.add(file);
        appliedHashes.add(fileHash);
        count++;
      } catch (error: unknown) {
        const sqlState = migrationSqlState(error);
        const sqlStateContext = sqlState ? ` (PostgreSQL ${sqlState})` : "";
        console.error(
          `❌ ${file} failed${sqlStateContext}: ${migrationErrorMessage(error)}`,
        );
        throw error; // Fail the Heroku release after bounded retries are exhausted.
      }
    }
    
    console.log(`\n✅ Applied ${count} new migration(s)`);
  } finally {
    if (advisoryLockHeld) {
      await releaseMigrationAdvisoryLock(client).catch((error) => {
        console.error('Failed to release migration advisory lock:', error);
      });
    }
    client.release();
    await pool.end();
  }
}

runMigrations().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
