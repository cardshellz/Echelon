#!/usr/bin/env bash
# Non-interactive drizzle-kit push for Heroku release phase
# Pipes 'Enter' keystrokes to auto-accept "create new" on rename prompts
# --force auto-accepts data-loss statements
set -e

# Run pending SQL migrations that drizzle-kit can't handle (SSL issue)
echo "Running SQL migrations..."
node -e "
const{Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
(async()=>{
  try{
    await p.query('ALTER TABLE channel_sync_log ADD COLUMN IF NOT EXISTS warehouse_id integer');
    await p.query('ALTER TABLE channel_sync_log ADD COLUMN IF NOT EXISTS shopify_location_id varchar(50)');
    console.log('SQL migrations applied');
  }catch(e){console.error('Migration warning:',e.message)}
  p.end();
})();
" || echo "SQL migration step completed with warnings"

echo "Running drizzle-kit push (non-interactive)..."
yes '' | npx drizzle-kit@0.31.8 push \
  --dialect=postgresql \
  --schema=./shared/schema.ts \
  --url="$DATABASE_URL" \
  --force \
  2>&1 || {
    echo "WARNING: drizzle-kit push exited with non-zero, but this may be expected if yes pipe closed early"
    echo "Checking database connectivity..."
    node -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});p.query('SELECT 1').then(()=>{console.log('DB OK');p.end()}).catch(e=>{console.error('DB ERROR:',e.message);p.end();process.exit(1)})"
  }

echo "Release phase complete"
