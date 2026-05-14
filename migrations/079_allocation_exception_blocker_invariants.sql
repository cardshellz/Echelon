-- Harden allocation blockers so one order item can have only one active
-- shipment-blocking exception. Existing stale terminal-order blockers are
-- resolved first, then duplicate active blockers are cancelled before the
-- partial unique index is created.

UPDATE wms.allocation_exceptions ae
SET
  status = 'resolved',
  resolution = 'terminal_order_shipment_blocker_cleanup',
  resolved_at = NOW(),
  updated_at = NOW(),
  metadata = COALESCE(ae.metadata, '{}'::jsonb) || jsonb_build_object(
    'recoveredBy', '079_allocation_exception_blocker_invariants',
    'recoveredAt', NOW(),
    'recoveryReason', 'terminal_order_no_active_demand',
    'orderStatus', o.warehouse_status
  )
FROM wms.orders o
WHERE ae.order_id = o.id
  AND o.warehouse_status IN ('shipped', 'cancelled')
  AND ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
  AND (
    ae.status = 'blocked'
    OR LOWER(COALESCE(ae.metadata->>'shipmentBlocking', 'false')) = 'true'
  );

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY order_item_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM wms.allocation_exceptions
  WHERE status NOT IN ('resolved', 'resolved_inline', 'cancelled')
    AND (
      status = 'blocked'
      OR LOWER(COALESCE(metadata->>'shipmentBlocking', 'false')) = 'true'
    )
)
UPDATE wms.allocation_exceptions ae
SET
  status = 'cancelled',
  resolution = 'duplicate_open_blocker_migration',
  resolved_at = NOW(),
  updated_at = NOW(),
  metadata = COALESCE(ae.metadata, '{}'::jsonb) || jsonb_build_object(
    'recoveredBy', '079_allocation_exception_blocker_invariants',
    'recoveredAt', NOW(),
    'recoveryReason', 'duplicate_open_blocker'
  )
FROM ranked
WHERE ae.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS allocation_exceptions_one_open_blocker_per_item_idx
  ON wms.allocation_exceptions(order_item_id)
  WHERE status NOT IN ('resolved', 'resolved_inline', 'cancelled')
    AND (
      status = 'blocked'
      OR LOWER(COALESCE(metadata->>'shipmentBlocking', 'false')) = 'true'
    );
