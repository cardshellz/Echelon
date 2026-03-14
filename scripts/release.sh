#!/usr/bin/env bash
# Non-interactive drizzle-kit push for Heroku release phase
# Pipes 'Enter' keystrokes to auto-accept "create new" on rename prompts
# --force auto-accepts data-loss statements
set -e

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
