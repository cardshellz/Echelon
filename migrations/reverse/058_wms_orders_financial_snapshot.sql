-- REVERSE of migrations/058_wms_orders_financial_snapshot.sql
--
-- DO NOT place this file at the top level of migrations/ — the release-phase
-- auto-runner (migrations/run-migrations.ts) picks up every *.sql at that
-- level. This file lives in migrations/reverse/ so it is not auto-applied.
--
-- Apply manually (psql) ONLY if Group B+C code has been rolled back and
-- the columns can be safely dropped. Zero runtime dependents pre-Group-B.

BEGIN;

ALTER TABLE wms.orders DROP COLUMN IF EXISTS amount_paid_cents;
ALTER TABLE wms.orders DROP COLUMN IF EXISTS tax_cents;
ALTER TABLE wms.orders DROP COLUMN IF EXISTS shipping_cents;
ALTER TABLE wms.orders DROP COLUMN IF EXISTS discount_cents;
ALTER TABLE wms.orders DROP COLUMN IF EXISTS total_cents;
ALTER TABLE wms.orders DROP COLUMN IF EXISTS currency;

DROP INDEX IF EXISTS wms.idx_wms_orders_oms_fulfillment_order_id;

COMMIT;
