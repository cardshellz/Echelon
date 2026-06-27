# OMS/WMS Authority Operations Runbook

This runbook turns the OMS/WMS authority remediation plan into operator steps
for tracing, triaging, and repairing authority drift. It assumes the Phase 4
constraints, Phase 5 reconciliation exceptions, Phase 6 audit/cleanup scripts,
and Phase 7 monitoring are deployed.

## Guardrails

- Prefer read-only trace queries before any repair.
- Treat OMS as the commercial authority and WMS as warehouse materialization.
- Do not create fulfillable WMS work from ShipStation evidence alone.
- Do not repair a row unless the proof identifies the OMS order, OMS line, WMS
  item, and shipment involved.
- Record every manual repair in the incident ticket with SQL output, operator,
  timestamp, and resolution reason.

## Health Gate

Run the readiness audit first when investigating authority drift:

```powershell
npx tsx scripts/audit-oms-wms-authority-readiness.ts --limit=10
```

For CI or release gates:

```powershell
npx tsx scripts/audit-oms-wms-authority-readiness.ts --json --fail-on-issues
```

Use the Phase 7 health counters to prioritize rows:

- Active WMS items without OMS authority.
- Active shipments missing ShipStation identity after the configured threshold.
- Duplicate ShipStation keys.
- Reconciliation manual reviews grouped by rule.
- Line-authority over-materialization attempts.

## Order Authority Trace By Order Number

Use this when an operator has an order number, channel order id, or OMS id and
needs to prove whether warehouse work is allowed.

Replace `ORDER_REF_HERE` with the OMS id, `external_order_id`, or
`external_order_number`.

```sql
WITH target_oms AS (
  SELECT oo.*
  FROM oms.oms_orders oo
  WHERE oo.id::text = 'ORDER_REF_HERE'
     OR oo.external_order_id = 'ORDER_REF_HERE'
     OR oo.external_order_number = 'ORDER_REF_HERE'
)
SELECT
  oo.id AS oms_order_id,
  oo.external_order_id,
  oo.external_order_number,
  oo.status AS oms_status,
  oo.financial_status,
  oo.fulfillment_status,
  oo.cancelled_at,
  oo.refunded_at,
  oo.shipstation_order_id,
  oo.shipstation_order_key,
  oo.shipping_engine,
  oo.engine_order_ref,
  oo.ordered_at,
  oo.updated_at
FROM target_oms oo;

WITH target_oms AS (
  SELECT oo.*
  FROM oms.oms_orders oo
  WHERE oo.id::text = 'ORDER_REF_HERE'
     OR oo.external_order_id = 'ORDER_REF_HERE'
     OR oo.external_order_number = 'ORDER_REF_HERE'
)
SELECT
  ol.id AS oms_order_line_id,
  ol.external_line_item_id,
  ol.sku,
  ol.quantity,
  ol.channel_observed_quantity,
  ol.paid_quantity,
  ol.authority_fulfillable_quantity,
  ol.cancelled_quantity,
  ol.refunded_quantity,
  ol.wms_materialized_quantity,
  GREATEST(ol.authority_fulfillable_quantity - ol.wms_materialized_quantity, 0) AS remaining_authority,
  ol.authorization_status,
  ol.authorized_by_event_id,
  ol.authority_source_topic,
  ol.authority_source_inbox_id,
  ol.authorized_at
FROM target_oms oo
JOIN oms.oms_order_lines ol ON ol.order_id = oo.id
ORDER BY ol.id;

WITH target_oms AS (
  SELECT oo.*
  FROM oms.oms_orders oo
  WHERE oo.id::text = 'ORDER_REF_HERE'
     OR oo.external_order_id = 'ORDER_REF_HERE'
     OR oo.external_order_number = 'ORDER_REF_HERE'
)
SELECT
  wo.id AS wms_order_id,
  wo.order_number,
  wo.source,
  wo.source_table_id,
  wo.oms_fulfillment_order_id,
  wo.warehouse_status,
  wo.cancelled_at AS wms_cancelled_at,
  wo.completed_at AS wms_completed_at,
  oi.id AS wms_order_item_id,
  oi.oms_order_line_id,
  oi.sku,
  oi.quantity,
  oi.picked_quantity,
  oi.fulfilled_quantity,
  oi.status AS item_status
FROM target_oms oo
JOIN wms.orders wo
  ON (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
  OR (wo.source = 'ebay' AND wo.oms_fulfillment_order_id = oo.id::text)
  OR (wo.source = 'shopify' AND wo.source_table_id = oo.id::text)
LEFT JOIN wms.order_items oi ON oi.order_id = wo.id
ORDER BY wo.id, oi.id;
```

Interpretation:

- `remaining_authority = 0` means no additional WMS item quantity should be
  materialized for that OMS line.
- An active WMS item with `oms_order_line_id IS NULL` is a blocker.
- An active WMS item whose line belongs to a different OMS order is a blocker.
- Cancelled or refunded OMS lines should either reduce WMS quantity before pick
  or leave an explicit review exception after physical commitment.

## OMS Line Authority Trace By Channel Line Id

Use this when the question is about one channel line item rather than the whole
order.

Replace `CHANNEL_LINE_ID_HERE` with the external line item id.

```sql
SELECT
  oo.id AS oms_order_id,
  oo.external_order_number,
  ol.id AS oms_order_line_id,
  ol.external_line_item_id,
  ol.sku,
  ol.quantity,
  ol.paid_quantity,
  ol.authority_fulfillable_quantity,
  ol.cancelled_quantity,
  ol.refunded_quantity,
  ol.wms_materialized_quantity,
  ol.authorization_status
FROM oms.oms_order_lines ol
JOIN oms.oms_orders oo ON oo.id = ol.order_id
WHERE ol.external_line_item_id = 'CHANNEL_LINE_ID_HERE'
ORDER BY oo.ordered_at DESC, ol.id DESC;

SELECT
  e.id,
  e.event_type,
  e.source_topic,
  e.source_event_id,
  e.source_inbox_id,
  e.previous_paid_quantity,
  e.previous_authority_fulfillable_quantity,
  e.previous_authorization_status,
  e.paid_quantity,
  e.authority_fulfillable_quantity,
  e.cancelled_quantity,
  e.refunded_quantity,
  e.authorization_status,
  e.created_at
FROM oms.oms_order_line_authority_events e
JOIN oms.oms_order_lines ol ON ol.id = e.order_line_id
WHERE ol.external_line_item_id = 'CHANNEL_LINE_ID_HERE'
ORDER BY e.created_at, e.id;

SELECT
  wo.id AS wms_order_id,
  wo.order_number,
  wo.warehouse_status,
  oi.id AS wms_order_item_id,
  oi.quantity,
  oi.picked_quantity,
  oi.fulfilled_quantity,
  oi.status AS item_status,
  os.id AS shipment_id,
  os.status AS shipment_status,
  os.shipstation_order_id,
  os.shipstation_order_key,
  os.engine_order_ref,
  os.engine_shipment_ref
FROM oms.oms_order_lines ol
JOIN wms.order_items oi ON oi.oms_order_line_id = ol.id
JOIN wms.orders wo ON wo.id = oi.order_id
LEFT JOIN wms.outbound_shipment_items osi ON osi.order_item_id = oi.id
LEFT JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
WHERE ol.external_line_item_id = 'CHANNEL_LINE_ID_HERE'
ORDER BY wo.id, oi.id, os.id;
```

Interpretation:

- The authority event stream should explain every commercial transition.
- If WMS quantity exceeds `authority_fulfillable_quantity`, stop further pushes
  and open or update a reconciliation exception.
- If the latest event is `review`, do not manually push shipment work until the
  review exception is resolved.

## WMS Materialization Trace By WMS Order Id

Use this when the warehouse row exists and the operator needs to prove its OMS
authority.

Replace `WMS_ORDER_ID_HERE` with the WMS order id.

```sql
SELECT
  wo.id AS wms_order_id,
  wo.order_number,
  wo.source,
  wo.source_table_id,
  wo.oms_fulfillment_order_id,
  wo.warehouse_status,
  wo.cancelled_at,
  wo.completed_at,
  oo.id AS oms_order_id,
  oo.external_order_id,
  oo.external_order_number,
  oo.status AS oms_status,
  oo.financial_status,
  oo.fulfillment_status
FROM wms.orders wo
LEFT JOIN oms.oms_orders oo
  ON (wo.source IN ('oms', 'ebay') AND wo.oms_fulfillment_order_id = oo.id::text)
  OR (wo.source = 'shopify' AND wo.source_table_id = oo.id::text)
WHERE wo.id = WMS_ORDER_ID_HERE;

SELECT
  oi.id AS wms_order_item_id,
  oi.oms_order_line_id,
  oi.sku,
  oi.quantity,
  oi.picked_quantity,
  oi.fulfilled_quantity,
  oi.status AS item_status,
  ol.order_id AS oms_order_id,
  ol.external_line_item_id,
  ol.authority_fulfillable_quantity,
  ol.wms_materialized_quantity,
  ol.authorization_status,
  CASE
    WHEN ol.id IS NULL THEN 'missing_oms_line'
    WHEN oi.quantity > ol.authority_fulfillable_quantity THEN 'item_exceeds_line_authority'
    WHEN ol.wms_materialized_quantity > ol.authority_fulfillable_quantity THEN 'line_over_materialized'
    ELSE 'ok'
  END AS authority_check
FROM wms.order_items oi
LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
WHERE oi.order_id = WMS_ORDER_ID_HERE
ORDER BY oi.id;

SELECT
  os.id AS shipment_id,
  os.status,
  os.source,
  os.shipstation_order_id,
  os.shipstation_order_key,
  os.shipping_engine,
  os.engine_order_ref,
  os.engine_shipment_ref,
  os.tracking_number,
  os.requires_review,
  os.review_reason,
  os.created_at,
  os.updated_at
FROM wms.outbound_shipments os
WHERE os.order_id = WMS_ORDER_ID_HERE
ORDER BY os.created_at, os.id;
```

Interpretation:

- `missing_oms_line`, `item_exceeds_line_authority`, and
  `line_over_materialized` are blockers for new fulfillment pushes.
- More than one active WMS order for the same OMS line is invalid until future
  multi-warehouse partitioning exists.
- Split packages should appear as multiple shipments under one WMS order, not
  as duplicate full WMS orders.

## ShipStation Duplicate Key Repair

Use this when monitoring reports duplicate active ShipStation ids or keys.

```sql
SELECT
  shipstation_order_id,
  COUNT(*) AS active_count,
  ARRAY_AGG(id ORDER BY id) AS shipment_ids,
  ARRAY_AGG(order_id ORDER BY id) AS wms_order_ids,
  ARRAY_AGG(status ORDER BY id) AS statuses
FROM wms.outbound_shipments
WHERE status IN ('planned', 'queued', 'labeled', 'on_hold')
  AND shipstation_order_id IS NOT NULL
  AND COALESCE(source, '') NOT IN ('echelon_combined_child', 'shipstation_combined_child')
GROUP BY shipstation_order_id
HAVING COUNT(*) > 1
ORDER BY active_count DESC, shipstation_order_id;

SELECT
  shipstation_order_key,
  COUNT(*) AS active_count,
  ARRAY_AGG(id ORDER BY id) AS shipment_ids,
  ARRAY_AGG(order_id ORDER BY id) AS wms_order_ids,
  ARRAY_AGG(status ORDER BY id) AS statuses
FROM wms.outbound_shipments
WHERE status IN ('planned', 'queued', 'labeled', 'on_hold')
  AND NULLIF(BTRIM(shipstation_order_key), '') IS NOT NULL
  AND COALESCE(source, '') NOT IN ('echelon_combined_child', 'shipstation_combined_child')
GROUP BY shipstation_order_key
HAVING COUNT(*) > 1
ORDER BY active_count DESC, shipstation_order_key;
```

Repair decision tree:

- If one row is a combined-child fanout row, confirm its `source` is
  `echelon_combined_child` or `shipstation_combined_child`; it should not count
  against the active identity uniqueness invariant.
- If two active rows describe the same physical ShipStation shipment, keep the
  row with label/tracking/warehouse progress and cancel only the duplicate row
  that has no physical work.
- If rows belong to different physical shipments but share one ShipStation
  identity, stop pushes and open a `manual_review` reconciliation exception.
- If a database repair is required, perform it in a transaction, capture
  before/after rows, and prefer changing the duplicate shipment lifecycle
  status over clearing ShipStation evidence.

Emergency duplicate shipment quarantine:

```sql
BEGIN;

SELECT *
FROM wms.outbound_shipments
WHERE id IN (SHIPMENT_ID_TO_KEEP, SHIPMENT_ID_TO_CANCEL)
FOR UPDATE;

UPDATE wms.outbound_shipments
SET
  status = 'cancelled',
  cancelled_at = COALESCE(cancelled_at, NOW()),
  requires_review = true,
  review_reason = 'duplicate_shipstation_identity_quarantined',
  updated_at = NOW()
WHERE id = SHIPMENT_ID_TO_CANCEL
  AND status IN ('planned', 'queued')
  AND shipped_at IS NULL
  AND tracking_number IS NULL;

SELECT *
FROM wms.outbound_shipments
WHERE id IN (SHIPMENT_ID_TO_KEEP, SHIPMENT_ID_TO_CANCEL);

COMMIT;
```

Do not use the emergency quarantine for `labeled`, `shipped`, `returned`,
`lost`, or any row with tracking evidence. Those require manual review.

## Reconciliation Exception Triage

Use this when monitoring reports open manual reviews by rule.

```sql
SELECT
  rule,
  classification,
  severity,
  status,
  COUNT(*) AS count,
  MIN(first_seen_at) AS oldest,
  MAX(last_seen_at) AS newest
FROM wms.reconciliation_exceptions
WHERE status IN ('open', 'acknowledged')
GROUP BY rule, classification, severity, status
ORDER BY
  CASE severity
    WHEN 'blocker' THEN 1
    WHEN 'review' THEN 2
    WHEN 'warning' THEN 3
    ELSE 4
  END,
  oldest;

SELECT *
FROM wms.reconciliation_exceptions
WHERE status IN ('open', 'acknowledged')
  AND rule = 'RULE_HERE'
ORDER BY last_seen_at DESC
LIMIT 50;
```

Triage states:

- `open`: not yet investigated.
- `acknowledged`: operator owns the investigation, but the row still represents
  current risk.
- `resolved`: proof shows the drift was repaired or is no longer present.
- `ignored`: proof shows this is historical or intentionally non-actionable.

Resolution update:

```sql
UPDATE wms.reconciliation_exceptions
SET
  status = 'resolved',
  resolved_at = NOW(),
  resolved_by = 'OPERATOR_OR_TICKET_HERE',
  resolution = 'RESOLUTION_SUMMARY_HERE',
  updated_at = NOW()
WHERE id = EXCEPTION_ID_HERE
  AND status IN ('open', 'acknowledged');
```

Only resolve after the trace query proves the current OMS/WMS state is safe.

## Backfill Dry Run And Execute

Use this before validating authority constraints or after a production drift
incident that requires historical cleanup.

Read-only audit:

```powershell
npx tsx scripts/audit-oms-wms-authority-readiness.ts --limit=10
```

Run one blocker class:

```powershell
npx tsx scripts/audit-oms-wms-authority-readiness.ts --check=oms_wms_item_missing_oms_line_id --limit=25
```

Dry-run safe cleanup:

```powershell
npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --dry-run --operation=all --limit=25
```

Execute after reviewing the dry-run output:

```powershell
npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --execute --operation=all --limit=all --operator=OPERATOR_OR_TICKET_HERE
```

Verify after execution:

```powershell
npx tsx scripts/audit-oms-wms-authority-readiness.ts --limit=10
```

Audit the cleanup run:

```sql
SELECT
  run_id,
  operation,
  action,
  source_table,
  COUNT(*) AS rows_changed,
  MIN(created_at) AS first_change,
  MAX(created_at) AS last_change
FROM wms.oms_wms_authority_cleanup_audit
GROUP BY run_id, operation, action, source_table
ORDER BY last_change DESC;

SELECT *
FROM wms.oms_wms_authority_cleanup_audit
WHERE run_id = 'RUN_ID_HERE'
ORDER BY id;
```

## Escalation

Escalate to engineering before repair when:

- The trace has no OMS line authority event explaining the current line state.
- A labeled or shipped shipment conflicts with a cancel/refund state.
- Duplicate ShipStation identity appears on two physical shipments.
- A cleanup dry run marks rows unsafe or outside the scripted operations.
- The same reconciliation rule reopens after a documented repair.
