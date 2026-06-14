# DB Role Separation Runbook — Echelon / shellz-club-app

**Goal:** make it physically impossible for Echelon to run DDL against schema objects
owned by shellz-club-app (and vice versa), at the Postgres permission layer.

**Why:** 2026-06-11 incident — Echelon's startup migrations ran
`ALTER TABLE membership.plans DROP COLUMN IF EXISTS tier_level` on every dyno boot,
breaking the Shellz Club admin (members list 500) and storefront checkout
("Variant can only be purchased with a selling plan"). The code-level fix was
**silently reverted twice in one day** by parallel work in the repo. Only ownership
separation survives code churn. Additionally, audit found
`RUN_DRIZZLE_PUSH_ON_RELEASE=true` + Echelon's unfiltered drizzle config would
auto-drop all 21 shellz-club public tables on a successful release push.

**Ownership map (target state):**

| Objects | Owner role | Other app gets |
|---|---|---|
| `membership.*` (all 50+ tables, views, sequences) | `shellz_club` | Echelon: USAGE + SELECT/INSERT/UPDATE/DELETE + REFERENCES, no DDL |
| shellz public tables (list in §2b) | `shellz_club` | Echelon: SELECT/INSERT/UPDATE/DELETE |
| `channels.*`, `wms.*`, `oms.*`, all other Echelon schemas | default credential (unchanged) | shellz: USAGE + SELECT on channels, REFERENCES on channels.channels |
| `public` schema itself | shared | both: USAGE + CREATE |
| `public._migrations` | default credential (Echelon's release tracking — do NOT transfer) | — |

---

## Phase 0 — Preflight (10 min, read-only)

```bash
heroku login
# Identify the addon + plan. Credentials require Standard-tier or higher
# (Essential/mini/basic do NOT support pg:credentials — if Essential, STOP;
# the path is first upgrading the plan, e.g. heroku addons:upgrade).
heroku pg:info -a <db-owner-app>
# Postgres version (PG15+ revokes public CREATE by default — §2d handles it)
# Current roles:
heroku pg:psql -a <db-owner-app> -c "\du"
# Confirm everything is currently owned by the default credential:
heroku pg:psql -a <db-owner-app> -c "SELECT tableowner, count(*) FROM pg_tables WHERE schemaname IN ('membership','public','channels') GROUP BY 1;"
```

## Phase 1 — Strip Echelon's cross-ownership DDL (MUST precede Phase 3)

After the flip, any Echelon statement that does DDL on transferred objects throws
`permission denied` — and `runStartupMigrations()` is one big try/catch, so the
first failure **silently skips every later statement**, breaking Echelon's own
bootstraps. Remove from `server/db.ts` before flipping:

1. The whole "Migration 052 Subscription Engine" membership block:
   every `ALTER TABLE membership.plans|member_subscriptions|members ADD COLUMN ...`
   and the `CREATE UNIQUE INDEX ... ON membership.*` statements. (All long since
   applied in prod; they are one-time bootstraps that no longer belong here.
   The DROP COLUMN tier/tier_level lines are already removed — never restore them.)
2. Migration 049 lines: `ALTER TABLE shopify_orders ADD COLUMN source_name` +
   its index (shellz-owned table after the flip).
3. Any other statement targeting `membership.*` or the §2b public tables.

Keep: all `channels.*`, `wms.*`, `oms.*`, `inventory.*` etc. statements (Echelon
keeps ownership there). Deploy Echelon and confirm clean boot logs BEFORE Phase 3.

Guardrail bonus: any FUTURE Echelon tracked migration touching membership.* will
now fail the release phase loudly (run-migrations.ts is fail-fast) instead of
silently corrupting shellz-club.

## Phase 2 — Create credential + transfer ownership

```bash
heroku pg:credentials:create DATABASE --name shellz_club -a <db-owner-app>
heroku pg:psql -a <db-owner-app>   # connects as DEFAULT credential; run §2a–2d
```

```sql
-- ── 2a. membership schema wholesale ────────────────────────────────
ALTER SCHEMA membership OWNER TO shellz_club;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.relname, c.relkind
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'membership' AND c.relkind IN ('r','p','v','m','S')
  LOOP
    EXECUTE CASE r.relkind
      WHEN 'S' THEN format('ALTER SEQUENCE membership.%I OWNER TO shellz_club', r.relname)
      WHEN 'v' THEN format('ALTER VIEW membership.%I OWNER TO shellz_club', r.relname)
      WHEN 'm' THEN format('ALTER MATERIALIZED VIEW membership.%I OWNER TO shellz_club', r.relname)
      ELSE format('ALTER TABLE membership.%I OWNER TO shellz_club', r.relname)
    END;
  END LOOP;
END $$;

-- ── 2b. shellz-club's public tables (explicit allowlist) ───────────
-- Excluded on purpose: _migrations (Echelon's), adjustment_reasons (shadow stub).
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    '__cardshellz_manual_migrations','__drizzle_migrations','app_settings',
    'auto_draft_runs','background_jobs','blockchain_config','discounts',
    'pricing_rules','purchase_order_lines','purchase_orders',
    'reorder_exclusion_rules','shopify_collections','shopify_order_items',
    'shopify_orders','shopify_products','shopify_variants','vendor_products',
    'vendors','warehouse_settings'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO shellz_club', t);
    END IF;
  END LOOP;
END $$;
-- (Serial/identity sequences transfer automatically with their tables.)

-- ── 2c. Grants so each app keeps working ───────────────────────────
-- Echelon (= current_user, the default credential) on membership: DML, no DDL.
DO $$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA membership TO %I', current_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA membership TO %I', current_user);
  EXECUTE format('GRANT REFERENCES ON ALL TABLES IN SCHEMA membership TO %I', current_user);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA membership TO %I', current_user);
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE shellz_club IN SCHEMA membership
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO PUBLIC;  -- future shellz tables stay readable/writable for Echelon
ALTER DEFAULT PRIVILEGES FOR ROLE shellz_club IN SCHEMA membership
  GRANT USAGE, SELECT ON SEQUENCES TO PUBLIC;

-- Echelon keeps DML on the transferred public tables (it reads/writes shopify_orders):
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'app_settings','auto_draft_runs','background_jobs','blockchain_config',
    'discounts','pricing_rules','purchase_order_lines','purchase_orders',
    'reorder_exclusion_rules','shopify_collections','shopify_order_items',
    'shopify_orders','shopify_products','shopify_variants','vendor_products',
    'vendors','warehouse_settings'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO %I', t, current_user);
    END IF;
  END LOOP;
END $$;

-- shellz on Echelon's channels schema: read + future FKs.
GRANT USAGE ON SCHEMA channels TO shellz_club;
GRANT SELECT ON ALL TABLES IN SCHEMA channels TO shellz_club;
GRANT REFERENCES ON channels.channels TO shellz_club;
ALTER DEFAULT PRIVILEGES IN SCHEMA channels GRANT SELECT ON TABLES TO shellz_club;

-- ── 2d. public schema usability + role hygiene ─────────────────────
GRANT USAGE, CREATE ON SCHEMA public TO shellz_club;
-- Verify neither role is a member of the other (membership would defeat the wall):
SELECT r.rolname AS role, m.rolname AS member_of
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.member
JOIN pg_roles m ON m.oid = am.roleid
WHERE r.rolname IN ('shellz_club', current_user::text);
-- If shellz_club shows current_user (or vice versa): REVOKE shellz_club FROM <role>;
```

## Phase 3 — Point shellz-club-app at the new credential

```bash
# Preferred (auto-rotating attachment named DATABASE → manages DATABASE_URL):
heroku addons:attach <addon-name> --credential shellz_club --as DATABASE -a <shellz-app>
# If an existing DATABASE attachment blocks it: heroku addons:detach DATABASE -a <shellz-app> first.
# (Fallback: heroku pg:credentials:url DATABASE --name shellz_club -a <db-owner-app>
#  → heroku config:set DATABASE_URL='<url>' -a <shellz-app> — but manual URLs
#  do NOT auto-rotate; prefer the attachment.)
heroku restart -a <shellz-app>
```

## Phase 4 — Verify + rollback

```bash
# As Echelon (default credential) — DDL on membership must now FAIL:
heroku pg:psql -a <db-owner-app> -c "ALTER TABLE membership.plans ADD COLUMN _probe int;"
#   → ERROR: must be owner of table plans   ✅ the wall works
heroku pg:psql -a <db-owner-app> -c "SELECT count(*) FROM membership.plans;"   # ✅ still readable

# As shellz_club — its own DDL works, Echelon's schemas refuse:
psql "$(heroku pg:credentials:url DATABASE --name shellz_club -a <db-owner-app> | grep -o 'postgres://.*')" \
  -c "ALTER TABLE membership.plans ADD COLUMN _probe int; ALTER TABLE membership.plans DROP COLUMN _probe;"  # ✅
  -c "ALTER TABLE wms.orders ADD COLUMN _probe int;"   # → permission denied ✅

# Smoke: shellz admin members list, storefront PDP add-to-cart, Echelon pick-priority page.
```

**Rollback:** re-attach the default credential (`heroku addons:attach <addon> --as DATABASE -a <shellz-app>` with the default credential, or restore the old DATABASE_URL) and restart. Ownership transfers are harmless to leave in place during rollback — the default credential retains DML via §2c grants.

**Sequencing caution:** shellz deploys during the transition are fine (its migrate.ts
runs as whatever DATABASE_URL points to). Do the flip in a quiet window; total
downtime is one dyno restart.

**Related hardening (separate from this runbook):** unset `RUN_DRIZZLE_PUSH_ON_RELEASE`
on Echelon; add `tablesFilter` to Echelon's drizzle.config.ts; fix shellz-club's
broken `"membership.*"` tablesFilter (drizzle matches bare table names); partial
unique index for one-active-subscription-per-member after duplicate cleanup.
