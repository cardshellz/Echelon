-- D-QGUARD: one 'ship' inventory-ledger row per (shipment_id, order_item_id).
--
-- CORRECTED KEY (this is what made the original index build fail on prod):
--   v1 keyed on (reference_id, order_item_id). But recordShipment writes
--   reference_id = shipmentId ?? String(orderId)
--   (server/modules/inventory/application/inventory.use-cases.ts:360) — it
--   FALLS BACK to the order id when there is no shipment id. The application's
--   dedup fast-path only runs for shipment-backed ships (same file, line 279),
--   so order-id-fallback rows are intentionally NOT deduped and may legitimately
--   repeat across partial shipments of the same order line. The v1 index unique-
--   constrained those legitimate rows, so CREATE UNIQUE INDEX failed on existing
--   data.
--
--   Key on the real shipment_id column instead, scoped to shipment-backed rows.
--   This matches the invariant the application actually enforces: one 'ship'
--   ledger row per (shipment, order line). Order-id-fallback rows stay
--   unconstrained, as intended.
--
-- The index NAME is unchanged (uq_inventory_transactions_ship_dedup) so the
-- application's 23505 catch (constraint name contains "ship_dedup") still fires.

-- Pre-flight: if TRUE residual duplicates exist on the corrected key, fail loudly
-- with guidance instead of letting CREATE UNIQUE INDEX emit an opaque error.
-- These are real double-decrements (or multi-location splits) and need manual
-- reconciliation because inventory_levels may also be wrong — we do NOT mutate
-- the financial ledger blind inside a migration.
DO $$
DECLARE
  dup_groups integer;
  sample text;
BEGIN
  SELECT COUNT(*),
         COALESCE(
           string_agg(
             format('(shipment=%s, item=%s, rows=%s)', shipment_id, order_item_id, cnt),
             ', ' ORDER BY cnt DESC
           ),
           ''
         )
    INTO dup_groups, sample
  FROM (
    SELECT shipment_id, order_item_id, COUNT(*) AS cnt
    FROM inventory.inventory_transactions
    WHERE transaction_type = 'ship'
      AND shipment_id IS NOT NULL
      AND order_item_id IS NOT NULL
    GROUP BY shipment_id, order_item_id
    HAVING COUNT(*) > 1
    LIMIT 25
  ) d;

  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'ship_dedup preflight: % shipment/line group(s) still have duplicate ship ledger rows. '
      'These are real double-decrements or multi-location splits and need manual reconciliation '
      '(inventory_levels may be affected). Run scripts/diagnose-ship-dedup-dupes.sql before retrying. '
      'Sample: %', dup_groups, sample;
  END IF;
END $$;

-- Drop any prior index of this name (e.g. a v1 build keyed on reference_id)
-- so the name can't collide with a different key definition across envs.
DROP INDEX IF EXISTS inventory.uq_inventory_transactions_ship_dedup;

CREATE UNIQUE INDEX uq_inventory_transactions_ship_dedup
  ON inventory.inventory_transactions (shipment_id, order_item_id)
  WHERE transaction_type = 'ship'
    AND shipment_id IS NOT NULL
    AND order_item_id IS NOT NULL;
