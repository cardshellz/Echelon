-- Migration 099: Per-warehouse SLA order cutoff + timezone
--
-- Adds two columns to inventory.warehouse_settings so each warehouse carries
-- its own fulfillment-day cutoff and the timezone that cutoff is expressed in.
-- These drive sla_due_at / sort_rank (server/modules/orders/sort-rank.ts).
--
-- WHY per-warehouse: a cutoff is "when does the carrier truck leave THIS
-- building," in THIS building's local clock. A multi-DC operation needs an
-- East-coast cutoff in ET and a West-coast cutoff in PT independently. The
-- timezone travels with the cutoff because a wall-clock cutoff is meaningless
-- without it.
--
-- WHY it matters: previously addBusinessDays() bucketed the placed instant
-- using the server's AMBIENT timezone (no explicit tz), so an order placed at
-- 11 PM that crossed midnight in the server's zone silently earned the next
-- day's SLA. The cutoff replaces that midnight knife-edge with a deliberate,
-- configurable threshold, and the explicit timezone removes the ambient-tz
-- dependence entirely.
--
-- Resolution order at read time (sort-rank.ts / settings.resolver.ts):
--   order's warehouse row → DEFAULT row → global default_timezone → hardcoded.
--
-- Column semantics:
--   order_cutoff_local  NULL → no cutoff (legacy: SLA from the raw placed day,
--                              just timezone-explicit). "HH:MM" 24h otherwise.
--   timezone            NULL → fall back to the global default_timezone.

ALTER TABLE inventory.warehouse_settings
  ADD COLUMN IF NOT EXISTS order_cutoff_local varchar(5),
  ADD COLUMN IF NOT EXISTS timezone           varchar(64);

-- Seed the timezone on existing rows to match TODAY's effective behavior
-- (the Heroku dyno runs Eastern; the Leonberg PA warehouse is Eastern). This
-- is behaviorally a no-op — it just makes the implicit explicit. Only fill
-- rows that don't already carry a value.
UPDATE inventory.warehouse_settings
SET timezone = 'America/New_York'
WHERE timezone IS NULL;

-- Seed a sensible starting cutoff (2 PM warehouse-local). This is the only
-- behavior-changing value: once the cutoff logic ships and SLAs are recomputed,
-- after-cutoff orders roll to the next business day's wave. It is fully tunable
-- per warehouse via the settings UI; seeded here so the feature is live-ready
-- and the backfill preview has a value to compute against.
UPDATE inventory.warehouse_settings
SET order_cutoff_local = '14:00'
WHERE order_cutoff_local IS NULL;
