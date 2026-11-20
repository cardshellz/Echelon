# Nightly Schema-Drift Detection — Activation & Triage Runbook (`P4.1`)

## Overview

Echelon's nightly schema-drift check compares a disposable PostgreSQL 17 database built from tracked repository migrations (`migrations/baseline/schema.sql` + `migrations/baseline/reference-data.sql` + post-baseline migrations) against production's live DDL structure — **without storing any production database credentials in GitHub**.

Architecture:
1. **09:00 UTC (Heroku Scheduler):** `scripts/publish-production-structure.ts` runs inside Heroku (using Heroku's own `DATABASE_URL` in a `default_transaction_read_only=on` session), takes a structure-only `pg_dump --schema-only --no-owner --no-privileges` snapshot plus `SELECT filename FROM public._migrations`, and commits three verified artifacts (`structure.sql`, `applied-migrations.json`, `heartbeat.json`) to the `production-structure` branch of `cardshellz/Echelon`.
2. **09:30 UTC (GitHub Actions `.github/workflows/schema-drift.yml`):** Checks out `main` and `production-structure`, builds a clean PostgreSQL 17 database from the repository, reloads production's dump into a second disposable PostgreSQL 17 database so PostgreSQL expression canonicalization is identical, compares every object, and posts to `SCHEMA_DRIFT_ALERT_WEBHOOK_URL` on either structural drift or check failure (stale heartbeat, missing branch, unreleased migrations).

---

## One-Time Activation Checklist (3 Settings)

Until all three settings below are configured, the `09:30 UTC` GitHub Actions job will intentionally fail closed (`SCHEMA_DRIFT_ALERT_WEBHOOK_MISSING` or `SCHEMA_DRIFT_PRODUCTION_STRUCTURE_MISSING`) so an unconfigured check is never mistaken for a clean one.

### 1. Create Scoped GitHub Fine-Grained Token & Set Heroku Config Vars

1. In GitHub (`Settings` -> `Developer settings` -> `Personal access tokens` -> `Fine-grained tokens`), create token **`echelon-production-structure-publisher`**:
   - **Resource owner:** `cardshellz`
   - **Repository access:** Only select repositories -> `cardshellz/Echelon`
   - **Repository permissions:** `Contents: Read and write` (all other permissions `No access`)
2. Set both config vars on the production Heroku app:
   ```bash
   heroku config:set \
     SCHEMA_STRUCTURE_GITHUB_REPOSITORY="cardshellz/Echelon" \
     SCHEMA_STRUCTURE_GITHUB_TOKEN="<fine-grained-pat>" \
     --app <echelon-production-heroku-app>
   ```
3. Verify `pg_dump` 17+ and dry-run publication on a one-off Heroku dyno (writes locally only, pushes nothing):
   ```bash
   heroku run "npx tsx scripts/publish-production-structure.ts --dry-run /tmp/structure-check" \
     --app <echelon-production-heroku-app>
   ```
   Expected log line: `{"level":"info","action":"publish_production_structure","outcome":"dry_run_written","error_code":null,...}`.

### 2. Add the Nightly Heroku Scheduler Job (`09:00 UTC`)

1. Open **Heroku Scheduler** on the production Heroku app (`heroku addons:open scheduler --app <echelon-production-heroku-app>`).
2. Add a daily job:
   - **Schedule:** Every day at **`09:00 UTC`** (30 minutes before `.github/workflows/schema-drift.yml`'s `30 9 * * *` cron)
   - **Dyno size:** Standard-1X
   - **Command:**
     ```bash
     npx tsx scripts/publish-production-structure.ts
     ```
3. Run an immediate initial publish so the `production-structure` branch exists right away:
   ```bash
   heroku run "npx tsx scripts/publish-production-structure.ts" \
     --app <echelon-production-heroku-app>
   ```
   Expected log line: `{"level":"info","action":"publish_production_structure","outcome":"published","error_code":null,...}`.

### 3. Set `SCHEMA_DRIFT_ALERT_WEBHOOK_URL` in GitHub Actions Secrets & Trigger Smoke Run

1. In GitHub (`cardshellz/Echelon` -> `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`), add:
   - **Name:** `SCHEMA_DRIFT_ALERT_WEBHOOK_URL`
   - **Value:** Discord-compatible ops alert webhook URL (receives `{"content": "..."}` JSON payloads)
2. Trigger a manual verification run:
   ```bash
   gh workflow run schema-drift.yml --repo cardshellz/Echelon
   ```
3. Confirm job **`Compare repository with production`** exits `0` with `{"level":"info","action":"schema_drift_check","outcome":"no_drift","error_code":null,...}` and uploads the `schema-drift-report` artifact.

---

## Error Code Triage Reference

| `error_code` | Meaning | Operator Action |
|---|---|---|
| `SCHEMA_DRIFT_ALERT_WEBHOOK_MISSING` | GitHub secret `SCHEMA_DRIFT_ALERT_WEBHOOK_URL` is unset | Complete Step 3 above |
| `SCHEMA_DRIFT_PRODUCTION_STRUCTURE_MISSING` | Branch `production-structure` (or one of its 3 files) does not exist yet | Complete Step 2 above and run `npx tsx scripts/publish-production-structure.ts` once |
| `PRODUCTION_STRUCTURE_STALE` | `heartbeat.json` on `production-structure` is older than the freshness window | Check Heroku Scheduler logs and verify `SCHEMA_STRUCTURE_GITHUB_TOKEN` has not expired |
| `SCHEMA_DRIFT_PRODUCTION_MISSING_MIGRATIONS` | `main` has merged migration(s) not yet released to production | Deploy `main` to production (so release phase applies pending migrations) and re-publish structure |
| `SCHEMA_DRIFT_DETECTED` | Production DDL differs from a clean repository build (`only_in_production`, `only_in_repository`, or `definition_differs`) | Inspect the `schema-drift-report` workflow artifact. If `shellz-club-app` shipped shared-DB DDL or an emergency manual DDL change occurred, either codify in a tracked Echelon migration or regenerate the baseline (`node scripts/migrations/generate-baseline.mjs`) once `main` and production migrations match |
