#!/usr/bin/env bash
# Non-interactive drizzle-kit push for Heroku release phase
# Pipes 'Enter' keystrokes to auto-accept "create new" on rename prompts
# --force auto-accepts data-loss statements
set -e

# Run pending SQL migrations
echo "Running SQL migrations from migrations/ folder..."
npx tsx migrations/run-migrations.ts

if [[ "${RUN_DRIZZLE_PUSH_ON_RELEASE:-false}" == "true" ]]; then
  echo "Running drizzle-kit push (non-interactive)..."
  export NODE_OPTIONS="${NODE_OPTIONS:-} --use-system-ca"
  yes '' | PGSSLMODE=require npx drizzle-kit@0.31.8 push \
    --dialect=postgresql \
    --schema=./shared/schema.ts \
    --url="$DATABASE_URL?sslmode=require" \
    --force
else
  echo "Skipping drizzle-kit push during release (set RUN_DRIZZLE_PUSH_ON_RELEASE=true to enable)."
fi

echo "Release phase complete"
