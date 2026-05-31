-- D-DUPEVENT: Prevent duplicate shipment event rows on webhook replay.
-- recordShipmentEventV2 inserts into oms_order_events without any dedup,
-- so replayed SHIP_NOTIFY webhooks create duplicate event rows. This
-- partial unique index ensures only one event per (order, event_type,
-- wms_shipment_id) combination for shipment-related events.
--
-- The index uses the JSONB details->>'wmsShipmentId' field as the
-- discriminator since each SHIP_NOTIFY carries the WMS shipment ID.
--
-- CLEANUP: Remove existing duplicate rows (keep earliest per group).
-- These are redundant notification events from webhook replays — the side
-- effects (status changes, fulfillment writes) already fired on the first
-- event. Keeping one copy preserves the audit trail accurately.

-- Step 1: Remove duplicate event rows, keeping the earliest (lowest id) per group.
DELETE FROM oms.oms_order_events
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY order_id, event_type, (details->>'wmsShipmentId')
             ORDER BY id
           ) AS rn
    FROM oms.oms_order_events
    WHERE event_type IN (
      'shipped_via_shipstation',
      'cancelled_via_shipstation',
      'voided_via_shipstation'
    )
    AND details->>'wmsShipmentId' IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Step 2: Create the dedup index now that duplicates are cleaned.
DROP INDEX IF EXISTS oms.uq_oms_order_events_shipment_dedup;

CREATE UNIQUE INDEX uq_oms_order_events_shipment_dedup
  ON oms.oms_order_events (
    order_id,
    event_type,
    (details->>'wmsShipmentId')
  )
  WHERE event_type IN (
    'shipped_via_shipstation',
    'cancelled_via_shipstation',
    'voided_via_shipstation'
  )
  AND details->>'wmsShipmentId' IS NOT NULL;
