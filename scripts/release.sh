#!/usr/bin/env bash
# Non-interactive drizzle-kit push for Heroku release phase
# Pipes 'Enter' keystrokes to auto-accept "create new" on rename prompts
# --force auto-accepts data-loss statements
set -e

# Run pending SQL migrations
echo "Running SQL migrations from migrations/ folder..."
npx tsx migrations/run-migrations.ts

# Legacy idempotent schema fallbacks. These used to run inside the web process
# on every boot, where one blocked table lock kept the app from starting. They
# run here instead, once per release, while the previous release still serves.
echo "Running legacy schema fallbacks..."
npx tsx scripts/release-schema-fallbacks.ts

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

# Read-only check that the customer order editor's inspection SQL still runs
# against this database. A failure stops the release (set -e).
echo "Running order editor read smoke check..."
npx tsx scripts/release-smoke-order-edit.ts

echo "Release phase complete"
