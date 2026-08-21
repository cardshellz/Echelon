# Shipment Lifecycle Production Audit Manifest

Status: sanitized, reproducible evidence manifest. This file records read-only
query definitions and aggregate results; it is not a migration, remediation,
runtime configuration, or authorization to change production.

## Snapshot identity

- Audit date: 2026-08-20 (`America/New_York`).
- Production app: `cardshellz-echelon`.
- Recorded deployed release: `v2695`.
- Recorded deploy commit: `5751d5aaaf0c803039c70aa6c9809a0552be097d`.
- Analysis worktree: `codex/shipment-lifecycle-proof`.
- Database evidence was captured from one or more bounded read-only snapshots.
  Counts can change after the audit date as ordinary operations continue.
- Release metadata is recorded here from the parent trace. The release command
  is intentionally not reproduced because a separate metadata invocation
  unexpectedly emitted config values into an internal transcript. No config
  value or credential is reproduced in this manifest.

## Safety and credential boundary

Every database evidence pass used this transaction contract and rolled back:

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30000ms';
SET LOCAL lock_timeout = '3000ms';
SET LOCAL idle_in_transaction_session_timeout = '45000ms';
-- One or more SELECT statements from this manifest.
ROLLBACK;
```

Some earlier passes used shorter statement or idle timeouts, but never a weaker
transaction mode: every captured production aggregate ran under
`REPEATABLE READ READ ONLY` and ended with `ROLLBACK` in a `finally` path.

The dedicated `wms_integrity_auditor` role was verified read-only but did not
have `SELECT` on the newer shipping relations needed by this audit. The
aggregate queries therefore used the application database credential inside
the explicit read-only transaction above. No grants were changed. This is a
defense-in-depth gap: the dedicated role needs reviewed relation-level `SELECT`
grants before this audit can be rerun entirely through least privilege.

ShipStation validation used `GET` only. Credentials were supplied to the local
process without being printed. No API response body was retained by this
manifest.

## Sanitized output policy

The audit output was restricted to:

- counts, statuses, dates, and non-customer classification values;
- aggregate item-line, unit, and distinct-order counts; and
- HTTP status counts.

The output did not emit provider IDs, internal record IDs, order numbers,
tracking numbers, addresses, names, email addresses, SKUs, costs, payload
bodies, signatures, connection strings, API keys, or secrets. Queries may use
identifiers internally for joins or grouping; their values are not selected in
the reported output.

## Query hash convention

Each SQL hash is SHA-256 over the UTF-8 bytes between that query's fenced code
block, with CRLF normalized to LF and no trailing LF. Comments outside a code
block are not hashed. Parameter values are documented separately and are not
part of the query hash unless shown inside the block.

## Exact SQL inventory

### Q00 — deployed relation and column coverage

SHA-256: `e4289370ea096df4cdbd0f79c46ab4016b81774ba8d59be8c13ae786ae5c0351`

```sql
SELECT table_name,
       array_agg(column_name ORDER BY ordinal_position) AS columns
FROM information_schema.columns
WHERE table_schema = 'wms'
  AND table_name = ANY($1::text[])
GROUP BY table_name
ORDER BY table_name
```

Parameter `$1` contained only these relation names:
`combined_order_groups`, `orders`, `order_items`, `outbound_shipments`,
`outbound_shipment_items`, `shipment_tracking_history`, `shipment_requests`,
`shipment_request_items`, `shipping_engine_orders`,
`shipping_engine_order_requests`, `physical_shipments`,
`physical_shipment_items`, `shipping_provider_labels`,
`shipping_provider_label_links`, `shipping_provider_label_events`,
`carrier_tracking_events`, `carrier_tracking_packages`,
`carrier_tracking_webhook_receipts`, and `reconciliation_exceptions`.

Captured result: every relation requested by Q00 except
`carrier_tracking_packages` was returned. Q00 was a bounded preflight, not an
exhaustive schema inventory. `carrier_tracking_event_matches` was omitted from
its parameter list; Q13 and Q14 later executed successfully against that
relation in read-only snapshots. That later execution proves only that the
referenced relation and columns were available to those queries. It does not
expand Q00's coverage or prove the relation's full column inventory.

### Q01 — provider-label inventory

SHA-256: `b2a19c299b503c3d59be053a451e990a76b6b4ae02482dcc00ac62ba6ea459b0`

```sql
SELECT provider,
       label_direction,
       label_status,
       source,
       count(*)::int AS labels,
       count(*) FILTER (WHERE provider_order_id IS NOT NULL)::int AS with_provider_order,
       count(*) FILTER (WHERE label_created_at IS NOT NULL)::int AS with_provider_created_time,
       min(first_observed_at)::date AS first_observed_date,
       max(last_observed_at)::date AS last_observed_date
FROM wms.shipping_provider_labels
GROUP BY provider, label_direction, label_status, source
ORDER BY provider, label_direction, label_status, source
```

Captured result:

- 5,503 active outbound ShipStation labels;
- 39 voided outbound ShipStation labels;
- 18 active return ShipStation labels;
- 1 voided return ShipStation label; and
- 0 of 5,561 labels with `label_created_at` populated.

Observed coverage was 2026-07-21 through 2026-08-20.

### Q02 — provider-label event inventory

SHA-256: `c46d610e3312414eed52344ba65bf0dafb7396a7309b8b9e3dd28d7f0ba8158a`

```sql
SELECT event_type,
       label_status,
       count(*)::int AS events,
       count(DISTINCT shipping_provider_label_id)::int AS labels,
       min(received_at)::date AS first_received_date,
       max(received_at)::date AS last_received_date
FROM wms.shipping_provider_label_events
GROUP BY event_type, label_status
ORDER BY event_type, label_status
```

Captured result: 10,283 active observations across 5,534 labels and 67 void
events across 40 labels, for 10,350 events total. Event receipt coverage was
2026-07-21 through 2026-08-20.

### Q03 — repeated label snapshots and observed-to-void transitions

SHA-256: `3611dc6f25a785705c0b20c9f27d1b1edbdda054d6e32cfbd306f384d48f3435`

```sql
WITH per_label AS (
  SELECT shipping_provider_label_id,
         bool_or(event_type = 'label_observed') AS saw_observed,
         bool_or(event_type = 'label_voided') AS saw_voided,
         count(*)::int AS event_count
  FROM wms.shipping_provider_label_events
  GROUP BY shipping_provider_label_id
)
SELECT count(*) FILTER (WHERE saw_observed AND saw_voided)::int AS observed_then_voided_labels,
       count(*) FILTER (WHERE event_count > 1)::int AS labels_with_multiple_distinct_snapshots,
       coalesce(max(event_count), 0)::int AS max_snapshots_for_one_label
FROM per_label
```

Captured result: 13 labels contain both observation and void evidence; 4,259
labels have more than one retained label-event row; the maximum is five event
rows for one label. Despite the historical output alias, this query uses
`event_count > 1`; it does not itself count distinct payloads or prove a
same-label reprint UI action.

### Q04 — latest durable content coverage

SHA-256: `4bf871dc4cf63096a6b71736e2eb22ef8f441b4fde18921ee7d6c8a7805dc444`

```sql
WITH latest AS (
  SELECT DISTINCT ON (shipping_provider_label_id)
         shipping_provider_label_id,
         sanitized_payload
  FROM wms.shipping_provider_label_events
  ORDER BY shipping_provider_label_id, received_at DESC, id DESC
)
SELECT count(*)::int AS labels_with_event,
       count(*) FILTER (
         WHERE jsonb_typeof(sanitized_payload->'shipmentItems') = 'array'
       )::int AS labels_with_item_array,
       count(*) FILTER (
         WHERE jsonb_typeof(sanitized_payload->'shipmentItems') = 'array'
           AND jsonb_array_length(sanitized_payload->'shipmentItems') = 0
       )::int AS labels_with_zero_recognized_echelon_items,
       count(*) FILTER (
         WHERE jsonb_typeof(sanitized_payload->'shipmentItems') = 'array'
           AND jsonb_array_length(sanitized_payload->'shipmentItems') > 0
       )::int AS labels_with_recognized_echelon_items
FROM latest
```

Captured result: all 5,561 labels had a retained item array; 5,513 had at least
one recognized Echelon line key and 48 had zero recognized keys. The sanitizer
does not retain quantity. Zero recognized keys is not proof that the provider
shipment was empty.

### Q05 — outbound provider-order label patterns

SHA-256: `58020c5dee742b9a73236113b508d2b8a0c9d722c2f65838783769d644d81ad2`

```sql
WITH latest AS (
  SELECT DISTINCT ON (shipping_provider_label_id)
         shipping_provider_label_id,
         sanitized_payload
  FROM wms.shipping_provider_label_events
  ORDER BY shipping_provider_label_id, received_at DESC, id DESC
),
snapshots AS (
  SELECT l.id,
         l.provider_order_id,
         l.label_status,
         l.label_direction,
         CASE
           WHEN jsonb_typeof(e.sanitized_payload->'shipmentItems') = 'array'
           THEN jsonb_array_length(e.sanitized_payload->'shipmentItems')
           ELSE NULL
         END AS recognized_item_count,
         md5(coalesce((e.sanitized_payload->'shipmentItems')::text, 'null')) AS content_fingerprint
  FROM wms.shipping_provider_labels l
  LEFT JOIN latest e ON e.shipping_provider_label_id = l.id
  WHERE l.provider = 'shipstation'
    AND l.provider_order_id IS NOT NULL
    AND l.label_direction = 'outbound'
),
grouped AS (
  SELECT provider_order_id,
         count(*)::int AS total_labels,
         count(*) FILTER (WHERE label_status = 'active')::int AS active_labels,
         count(*) FILTER (WHERE label_status = 'voided')::int AS voided_labels,
         count(DISTINCT content_fingerprint)
           FILTER (WHERE label_status = 'active' AND recognized_item_count > 0)::int
           AS active_nonempty_content_sets,
         count(*) FILTER (
           WHERE label_status = 'active' AND recognized_item_count = 0
         )::int AS active_zero_recognized_items,
         count(*) FILTER (
           WHERE label_status = 'active' AND recognized_item_count > 0
         )::int AS active_nonempty_labels
  FROM snapshots
  GROUP BY provider_order_id
)
SELECT count(*)::int AS provider_orders,
       count(*) FILTER (WHERE total_labels >= 2)::int AS provider_orders_with_multiple_labels,
       count(*) FILTER (WHERE active_labels >= 1 AND voided_labels >= 1)::int AS void_and_active_relabel_candidates,
       count(*) FILTER (
         WHERE active_labels >= 2
           AND active_nonempty_labels = active_labels
           AND active_nonempty_content_sets = 1
       )::int AS active_active_same_recognized_content_candidates,
       count(*) FILTER (
         WHERE active_labels >= 2
           AND active_nonempty_labels = active_labels
           AND active_nonempty_content_sets > 1
       )::int AS active_active_distinct_recognized_content_candidates,
       count(*) FILTER (
         WHERE active_labels >= 1 AND active_zero_recognized_items > 0
       )::int AS provider_orders_with_active_zero_recognized_item_label
FROM grouped
```

Captured result: 5,499 outbound provider-order groups; 39 with multiple labels;
37 with at least one active and one voided label; two with at least two active
labels sharing one retained recognized-key fingerprint; zero active-active
groups with distinct retained fingerprints; and 47 provider orders with an
active zero-recognized-key label.

These are topology candidates. The query does not prove label-action intent,
event chronology, exact quantity equality, replacement, or split causality.

### Q06 — active-plus-voided retained-content comparison

SHA-256: `41d97d0ff91644c242d921a6cf9dbf0f8f9b23d3b272ab9d4064071b7ff5e2d4`

```sql
WITH latest AS (
  SELECT DISTINCT ON (shipping_provider_label_id)
         shipping_provider_label_id,
         sanitized_payload
  FROM wms.shipping_provider_label_events
  ORDER BY shipping_provider_label_id, received_at DESC, id DESC
),
snapshots AS (
  SELECT l.provider_order_id,
         l.label_status,
         CASE
           WHEN jsonb_typeof(e.sanitized_payload->'shipmentItems') = 'array'
           THEN jsonb_array_length(e.sanitized_payload->'shipmentItems')
           ELSE NULL
         END AS item_count,
         md5(coalesce((e.sanitized_payload->'shipmentItems')::text, 'null')) AS content_fingerprint
  FROM wms.shipping_provider_labels l
  LEFT JOIN latest e ON e.shipping_provider_label_id = l.id
  WHERE l.provider = 'shipstation'
    AND l.provider_order_id IS NOT NULL
    AND l.label_direction = 'outbound'
),
candidates AS (
  SELECT provider_order_id,
         count(*) FILTER (WHERE label_status = 'active')::int AS active_labels,
         count(*) FILTER (WHERE label_status = 'voided')::int AS voided_labels,
         count(DISTINCT content_fingerprint)
           FILTER (WHERE label_status = 'active' AND item_count > 0)::int
           AS active_content_sets,
         count(DISTINCT content_fingerprint)
           FILTER (WHERE label_status = 'voided' AND item_count > 0)::int
           AS voided_content_sets,
         count(DISTINCT content_fingerprint)
           FILTER (WHERE item_count > 0)::int AS all_content_sets,
         count(*) FILTER (WHERE item_count = 0)::int AS zero_recognized_item_labels
  FROM snapshots
  GROUP BY provider_order_id
  HAVING count(*) FILTER (WHERE label_status = 'active') >= 1
     AND count(*) FILTER (WHERE label_status = 'voided') >= 1
)
SELECT count(*)::int AS candidates,
       count(*) FILTER (
         WHERE zero_recognized_item_labels = 0 AND all_content_sets = 1
       )::int AS same_recognized_contents_across_voided_and_active,
       count(*) FILTER (
         WHERE zero_recognized_item_labels = 0 AND all_content_sets > 1
       )::int AS changed_recognized_contents_across_voided_and_active,
       count(*) FILTER (
         WHERE zero_recognized_item_labels > 0
       )::int AS indeterminate_due_to_zero_recognized_items
FROM candidates
```

Captured result: 37 candidate groups; 36 with one retained recognized-key
fingerprint; zero with different retained fingerprints; one indeterminate.
This result is quantity-lossy and does not prove causal replacement chronology.

### Q07 — physical-shipment status inventory

SHA-256: `c140abd7419cd5f19e4f0fa87aedf0caa32d7b24f4f21ad4458addc65a7d583f`

```sql
SELECT provider,
       status,
       count(*)::int AS shipments,
       min(created_at)::date AS first_created_date,
       max(created_at)::date AS last_created_date
FROM wms.physical_shipments
GROUP BY provider, status
ORDER BY provider, status
```

Captured result: 2,088 ShipStation shipped, one ShipStation voided, and 115
Shopify shipped physical packages, for 2,204 total. Coverage was 2026-07-23
through 2026-08-20.

### Q08 — physical-item purpose inventory

SHA-256: `72b4eea14a5324b031ccc4d8297ecdbad4aa6c68dcab2d37d1ab4992187151e5`

```sql
SELECT shipment_item_purpose,
       count(*)::int AS lines,
       coalesce(sum(quantity_shipped), 0)::int AS units
FROM wms.physical_shipment_items
GROUP BY shipment_item_purpose
ORDER BY shipment_item_purpose
```

Captured result: 4,456 customer-fulfillment lines / 10,762 units; 35
replacement lines / 86 units; 3 omission-correction lines / 3 units; and 2
concession lines / 6 units.

### Q09 — multi-package engine-order content patterns

SHA-256: `3de2a235e9383ce4a3feb8b244fb184b6e022219e375e9d74099b37dcacd2376`

```sql
WITH package_contents AS (
  SELECT ps.shipping_engine_order_id,
         ps.id AS physical_shipment_id,
         count(psi.id)::int AS lines,
         coalesce(sum(psi.quantity_shipped), 0)::int AS units,
         md5(coalesce(
           jsonb_agg(
             jsonb_build_array(
               coalesce(psi.wms_order_item_id, -1),
               psi.sku,
               psi.quantity_shipped,
               psi.shipment_item_purpose
             )
             ORDER BY coalesce(psi.wms_order_item_id, -1),
                      psi.sku,
                      psi.quantity_shipped,
                      psi.shipment_item_purpose
           ) FILTER (WHERE psi.id IS NOT NULL)::text,
           '[]'
         )) AS content_fingerprint
  FROM wms.physical_shipments ps
  LEFT JOIN wms.physical_shipment_items psi
    ON psi.physical_shipment_id = ps.id
  WHERE ps.shipping_engine_order_id IS NOT NULL
  GROUP BY ps.shipping_engine_order_id, ps.id
),
groups AS (
  SELECT shipping_engine_order_id,
         count(*)::int AS packages,
         count(DISTINCT content_fingerprint)::int AS content_sets,
         count(*) FILTER (WHERE lines = 0)::int AS empty_packages
  FROM package_contents
  GROUP BY shipping_engine_order_id
)
SELECT count(*)::int AS engine_orders_with_physical_package,
       count(*) FILTER (WHERE packages >= 2)::int AS engine_orders_with_multiple_packages,
       count(*) FILTER (
         WHERE packages >= 2 AND empty_packages = 0 AND content_sets = 1
       )::int AS multi_package_same_exact_contents,
       count(*) FILTER (
         WHERE packages >= 2 AND empty_packages = 0 AND content_sets > 1
       )::int AS multi_package_distinct_exact_contents,
       count(*) FILTER (
         WHERE packages >= 2 AND empty_packages > 0
       )::int AS multi_package_with_empty_physical_record
FROM groups
```

Captured result: 1,846 engine orders with a physical package; 202 with multiple
packages; 33 with repeated exact physical-ledger contents; 169 with distinct
exact physical-ledger contents; and zero multi-package groups with an empty
physical record.

### Q10 — provider-label link coverage

SHA-256: `03989f50045c12c95142d7da8fb93e9e38f5ca9bfa53bd00780886ad44861871`

```sql
WITH per_label AS (
  SELECT shipping_provider_label_id,
         count(*)::int AS links,
         count(*) FILTER (WHERE shipment_request_id IS NOT NULL)::int AS request_links,
         count(*) FILTER (WHERE shipping_engine_order_id IS NOT NULL)::int AS engine_links,
         count(*) FILTER (WHERE physical_shipment_id IS NOT NULL)::int AS physical_links,
         count(*) FILTER (WHERE legacy_wms_shipment_id IS NOT NULL)::int AS legacy_links
  FROM wms.shipping_provider_label_links
  GROUP BY shipping_provider_label_id
)
SELECT (SELECT count(*)::int FROM wms.shipping_provider_labels) AS labels,
       count(*)::int AS labels_with_any_link,
       count(*) FILTER (WHERE links > 1)::int AS labels_with_multiple_link_rows,
       count(*) FILTER (WHERE request_links > 0)::int AS labels_with_request_link,
       count(*) FILTER (WHERE engine_links > 0)::int AS labels_with_engine_link,
       count(*) FILTER (WHERE physical_links > 0)::int AS labels_with_physical_link,
       count(*) FILTER (WHERE legacy_links > 0)::int AS labels_with_legacy_link
FROM per_label
```

Captured result: 5,559 of 5,561 labels had at least one link; 3,038 had
multiple link rows; 2,088 had request links; 2,245 had engine-order links; 2,031
had physical links; and 5,559 had legacy-shipment links.

### Q11 — tracking-history coverage

SHA-256: `f192729e07c7f35e25e581cf1ff35abbf54d2cd45a46e2f74c64aaabfa1bbfb6`

```sql
SELECT count(*)::int AS rows,
       count(*) FILTER (WHERE voided_at IS NOT NULL)::int AS voided_rows,
       count(*) FILTER (WHERE replaced_at IS NOT NULL)::int AS replaced_rows
FROM wms.shipment_tracking_history
```

Captured result: 440 rows, including 82 with `voided_at` and 358 with
`replaced_at`. These columns do not by themselves prove provider UI action,
causal chronology, or exact content transfer.

### Q12 — ShipStation-related reconciliation exceptions

SHA-256: `6bb8622a622076ac57418297e517e69b5a1930bc050258e814b9940e0c2ad261`

```sql
SELECT rule,
       status,
       count(*)::int AS exceptions
FROM wms.reconciliation_exceptions
WHERE external_system = 'shipstation'
   OR source ILIKE '%shipstation%'
GROUP BY rule, status
ORDER BY rule, status
```

Captured open counts: two `historical_replacement_inventory_unproven`, four
`ship_notify_no_match`, and three `shipstation_unmapped_physical_shipment`.
Captured resolved counts: eight `ship_notify_no_match` and 37
`shipstation_unmapped_physical_shipment`.

### Q13 — carrier events matched to voided labels

SHA-256: `17c03a12aa8bb3a2dd89992a9c3355b3e84a200f8a92937a69008e83f9ba355a`

```sql
SELECT e.dispatch_evidence,
       count(DISTINCT l.id)::int AS labels_with_any_matched_event,
       count(DISTINCT e.id)::int AS matched_events,
       count(DISTINCT l.id) FILTER (
         WHERE e.received_at >= l.voided_at
       )::int AS labels_received_after_void,
       count(DISTINCT e.id) FILTER (
         WHERE e.received_at >= l.voided_at
       )::int AS events_received_after_void,
       count(DISTINCT l.id) FILTER (
         WHERE e.event_occurred_at IS NOT NULL
           AND e.event_occurred_at >= l.voided_at
       )::int AS labels_occurred_after_void,
       count(DISTINCT e.id) FILTER (
         WHERE e.event_occurred_at IS NOT NULL
           AND e.event_occurred_at >= l.voided_at
       )::int AS events_occurred_after_void,
       count(DISTINCT l.id) FILTER (
         WHERE coalesce(e.event_occurred_at, e.received_at) >= l.voided_at
       )::int AS labels_effective_time_after_void,
       count(DISTINCT e.id) FILTER (
         WHERE coalesce(e.event_occurred_at, e.received_at) >= l.voided_at
       )::int AS events_effective_time_after_void
FROM wms.shipping_provider_labels l
JOIN wms.carrier_tracking_event_matches m
  ON m.shipping_provider_label_id = l.id
JOIN wms.carrier_tracking_events e
  ON e.id = m.carrier_tracking_event_id
WHERE l.provider = 'shipstation'
  AND l.voided_at IS NOT NULL
  AND m.match_status = 'matched'
GROUP BY e.dispatch_evidence
ORDER BY e.dispatch_evidence
```

Captured result: the only classification was `not_confirmed`. Eleven voided
labels had 21 matched snapshots in total. Nine labels had 19 snapshots received
after void; nine labels had 18 snapshots with provider occurrence time after
void; and nine labels had 19 snapshots under the coalesced effective-time rule.
No confirmed label existed under receipt, provider-occurrence, or coalesced
timing. A separate normalized-tracking join produced the same after-void
counts. Therefore this audit observed no carrier possession after label void.

### Q14 — active-active retained-content coverage

SHA-256: `2f4cb0d7212b0aa5a3905b850a795e4a06a82244c3a4b71de67d1b22197c9234`

```sql
WITH latest AS (
  SELECT DISTINCT ON (shipping_provider_label_id)
         shipping_provider_label_id,
         sanitized_payload
  FROM wms.shipping_provider_label_events
  ORDER BY shipping_provider_label_id, received_at DESC, id DESC
),
active_labels AS (
  SELECT l.id,
         l.provider_order_id,
         md5((e.sanitized_payload->'shipmentItems')::text) AS content_fingerprint,
         jsonb_array_length(e.sanitized_payload->'shipmentItems') AS item_count
  FROM wms.shipping_provider_labels l
  JOIN latest e ON e.shipping_provider_label_id = l.id
  WHERE l.provider = 'shipstation'
    AND l.label_direction = 'outbound'
    AND l.label_status = 'active'
    AND l.provider_order_id IS NOT NULL
    AND jsonb_typeof(e.sanitized_payload->'shipmentItems') = 'array'
),
qualifying_groups AS (
  SELECT provider_order_id
  FROM active_labels
  GROUP BY provider_order_id
  HAVING count(*) >= 2
     AND count(*) FILTER (WHERE item_count > 0) = count(*)
     AND count(DISTINCT content_fingerprint) = 1
),
label_evidence AS (
  SELECT a.provider_order_id,
         a.id,
         EXISTS (
           SELECT 1
           FROM wms.carrier_tracking_event_matches m
           JOIN wms.carrier_tracking_events e
             ON e.id = m.carrier_tracking_event_id
           WHERE m.shipping_provider_label_id = a.id
             AND m.match_status = 'matched'
             AND e.dispatch_evidence = 'confirmed'
         ) AS carrier_confirmed,
         EXISTS (
           SELECT 1
           FROM wms.shipping_provider_label_links link
           WHERE link.shipping_provider_label_id = a.id
             AND link.physical_shipment_id IS NOT NULL
         ) AS has_physical_link
  FROM active_labels a
  JOIN qualifying_groups q USING (provider_order_id)
),
per_group AS (
  SELECT provider_order_id,
         count(*)::int AS active_labels,
         count(*) FILTER (WHERE carrier_confirmed)::int AS confirmed_labels,
         count(*) FILTER (WHERE has_physical_link)::int AS physical_linked_labels
  FROM label_evidence
  GROUP BY provider_order_id
)
SELECT active_labels,
       confirmed_labels,
       physical_linked_labels,
       count(*)::int AS groups
FROM per_group
GROUP BY active_labels, confirmed_labels, physical_linked_labels
ORDER BY active_labels, confirmed_labels, physical_linked_labels
```

Captured result: two groups. Each had two active labels sharing a retained
recognized-key fingerprint, exactly one confirmed label, and exactly one
physical-linked label. The durable fingerprint excludes quantity. A sampled
GET proved exact line-and-quantity equality for one group only.

### Q15 — physical packages spanning WMS orders

SHA-256: `b9bb7b58abd20a677ff2785f019f5f6fa7647cc637ef3b448c28729dd85ec6df`

```sql
WITH package_rollup AS (
  SELECT psi.physical_shipment_id,
         count(*)::int AS item_lines,
         coalesce(sum(psi.quantity_shipped), 0)::int AS units,
         count(DISTINCT oi.order_id)::int AS distinct_wms_orders
  FROM wms.physical_shipment_items psi
  JOIN wms.order_items oi
    ON oi.id = psi.wms_order_item_id
  GROUP BY psi.physical_shipment_id
  HAVING count(DISTINCT oi.order_id) > 1
)
SELECT ps.provider,
       ps.status,
       p.distinct_wms_orders,
       p.item_lines,
       p.units,
       count(*)::int AS physical_packages
FROM package_rollup p
JOIN wms.physical_shipments ps
  ON ps.id = p.physical_shipment_id
GROUP BY ps.provider,
         ps.status,
         p.distinct_wms_orders,
         p.item_lines,
         p.units
ORDER BY ps.provider,
         ps.status,
         p.distinct_wms_orders,
         p.item_lines,
         p.units
```

Captured result: three ShipStation `shipped` packages. Each spans exactly two
WMS orders and has two physical item lines. One package has 3 units, one has 4,
and one has 26. One sampled package was separately GET-verified as two valid
provider lines / four units mapping to two WMS orders.

### Q16 — OMS service-level population

SHA-256: `c82b30b2c23ca7f57c97778f05f6e5be9b43cc8a95ab48b0ca9e9aeba87d8321`

```sql
SELECT coalesce(
         nullif(lower(btrim(shipping_service_level)), ''),
         '[missing]'
       ) AS normalized_service_level,
       count(*)::int AS orders,
       min(created_at)::date AS first_created_date,
       max(created_at)::date AS last_created_date,
       min(updated_at)::date AS first_updated_date,
       max(updated_at)::date AS last_updated_date
FROM oms.oms_orders
GROUP BY coalesce(
  nullif(lower(btrim(shipping_service_level)), ''),
  '[missing]'
)
ORDER BY normalized_service_level
```

Captured result: 41,104 orders, all `standard`; no missing, blank, or other
values. Created and updated coverage was 2026-03-31 through 2026-08-20.

### Q17 — WMS service-level population

SHA-256: `c454bdea7e15f7146e3f5c702fa08fd3ec44f4bc65b4b103c65d6efb642d064b`

```sql
SELECT coalesce(
         nullif(lower(btrim(shipping_service_level)), ''),
         '[missing]'
       ) AS normalized_service_level,
       count(*)::int AS orders,
       min(created_at)::date AS first_created_date,
       max(created_at)::date AS last_created_date,
       min(updated_at)::date AS first_updated_date,
       max(updated_at)::date AS last_updated_date
FROM wms.orders
GROUP BY coalesce(
  nullif(lower(btrim(shipping_service_level)), ''),
  '[missing]'
)
ORDER BY normalized_service_level
```

Captured result: 61,403 orders, all `standard`; no missing, blank, or other
values. Created coverage was 2026-01-10 through 2026-08-20. Updated coverage
was 2026-04-22 through 2026-08-20.

### Q18 — service-level spread inside active/pending combined groups

SHA-256: `19e9db6ac25ab76db58a44871055864c392c6e9c9a055ef43b6b4e90e0bfc128`

```sql
WITH per_group AS (
  SELECT g.id,
         g.status,
         count(o.id)::int AS member_orders,
         count(DISTINCT nullif(lower(btrim(o.shipping_service_level)), ''))::int
           AS populated_service_levels,
         count(DISTINCT coalesce(
           nullif(lower(btrim(o.shipping_service_level)), ''),
           '[missing]'
         ))::int AS service_levels_including_missing,
         min(o.created_at)::date AS first_member_created_date,
         max(o.created_at)::date AS last_member_created_date
  FROM wms.combined_order_groups g
  JOIN wms.orders o
    ON o.combined_group_id = g.id
  WHERE g.status IN ('active', 'pending')
  GROUP BY g.id, g.status
)
SELECT status,
       count(*)::int AS groups_with_members,
       coalesce(sum(member_orders), 0)::int AS member_orders,
       count(*) FILTER (
         WHERE populated_service_levels > 1
       )::int AS groups_spanning_multiple_populated_service_levels,
       count(*) FILTER (
         WHERE service_levels_including_missing > 1
       )::int AS groups_spanning_levels_when_missing_is_distinct,
       count(*) FILTER (
         WHERE populated_service_levels = 0
       )::int AS groups_all_service_levels_missing,
       count(*) FILTER (
         WHERE populated_service_levels = 1
           AND service_levels_including_missing = 2
       )::int AS groups_mixing_one_populated_level_with_missing,
       min(first_member_created_date) AS first_member_created_date,
       max(last_member_created_date) AS last_member_created_date
FROM per_group
GROUP BY status
ORDER BY status
```

Captured result: 23 pending groups joined to 45 member orders; zero groups span
multiple populated service levels, include both a populated and missing class,
or have all service levels missing. Member coverage was 2026-01-26 through
2026-03-27. Because the population is entirely `standard`, this does not prove
that current grouping code safely handles expedited classes.

### Q19 — active/pending combined-group recorded totals

SHA-256: `e758f87f958e35056add72356bf46f691f8e78a33eb75ec2e58f43da7c8cb3dd`

```sql
SELECT status,
       count(*)::int AS groups,
       coalesce(sum(order_count), 0)::int AS recorded_order_count,
       min(created_at)::date AS first_group_created_date,
       max(created_at)::date AS last_group_created_date
FROM wms.combined_order_groups
WHERE status IN ('active', 'pending')
GROUP BY status
ORDER BY status
```

Snapshot provenance: Q16 through Q19 ran sequentially through the same database
client inside one `REPEATABLE READ READ ONLY` transaction and shared the same
unconditional `ROLLBACK`. Q18 and Q19 therefore describe one database snapshot.

Captured result: 25 pending group rows with recorded `order_count` totaling 51,
created 2026-02-04 through 2026-03-27. In that same snapshot, Q18 found 23 groups
joined to 45 WMS member orders. Two pending group rows therefore had no current
joined WMS member, and the recorded membership total exceeded current joined
membership by six. This is an aggregate integrity discrepancy; no member
identity was emitted.

## ShipStation GET proof samples

### Request shape

All provider validation used this request shape:

SHA-256: `b37d0167e439a88cc9d6a2f5655cade676361c64e6fcd1444384124ad5abbfe9`

```http
GET https://ssapi.shipstation.com/shipments?shipmentId={candidate_provider_label_id}&includeShipmentItems=true
Accept: application/json
Authorization: Basic {process-supplied credential; never logged or retained}
```

Only `shipmentId`, `shipDate` presence, `createDate` field presence, `voidDate`
presence, `isReturnLabel`, and `shipmentItems[].lineItemKey/quantity` were read
in memory. Values capable of identifying a shipment were not emitted.

### Deterministic sample selection

Samples were operational proof examples, not random or representative samples:

- Active-active: the earliest qualifying provider-order group by minimum local
  label row ID, limited to one group.
- Active-plus-voided: earliest qualifying groups by minimum local label row ID.
  The second pass stopped after observing one equal and one different exact
  content signature; two groups and four successful GETs were examined.
- Zero-recognized-key: the first two active outbound labels by local label row
  ID whose latest durable item array was empty after Echelon-key sanitization.
- Distinct-content multi-package: the earliest qualifying engine order by
  minimum physical-shipment row ID, limited to one group.
- Cross-WMS package: the earliest physical package by local physical-shipment
  row ID whose exact physical lines mapped to more than one WMS order.

Selection keys were used inside queries but no selected value was emitted.
Because samples were deterministic convenience samples, no frequency or
population-rate inference is valid.

### Captured GET results

- A nine-unique-label validation pass returned HTTP 200 for all nine requests.
- One active-active group had equal exact `{lineItemKey, quantity}` signatures.
  This proves equality for that group, not for the second durable candidate.
- Two active-plus-voided groups were checked: one had equal exact signatures
  and one had different exact signatures. This does not prove replacement
  intent, split intent, UI action, or A-to-B chronology.
- One multi-package group had distinct exact signatures across its provider
  packages. This does not prove which UI operation created the topology.
- Both zero-recognized-key samples had nonempty provider item arrays but no
  valid Echelon `wms-item-{id}` identity. A truly empty provider shipment was
  not observed.
- One cross-WMS provider package returned two valid mapped item lines totaling
  four units across exactly two WMS orders.
- All nine shipments in the consolidated pass exposed `shipDate` and a
  `createDate` field. Field presence does not establish label-generation,
  postage-purchase, or business-shipment timestamp semantics.

A prior larger GET batch detached from the command session before its aggregate
output was captured. It is excluded from every proof and count above. The
request method was GET-only, but no result from that attempt is evidence.


## Separate transcript-only historical-repair observation

This observation is not part of the hash-backed SQL/GET snapshot above. It is
retained to define a required safety fixture, not as independently reproducible
production proof. The one-off command ran on release `v2695` / commit `5751d5aa`:

```text
heroku run "npx tsx scripts/repair-historical-shipstation-splits.ts --dry-run --limit=1 --json --progress-every=0 --max-retries=0" -a <production-app>
```

Sanitized aggregate stdout reported:

- mode `dry-run`;
- 4 candidates, 4 provider lookups processed, and 4 provider packages loaded;
- 0 provider-missing, invalid-provider-evidence, or rate-limit outcomes;
- 0 repairable, reshaped, repaired, linked, dispatch-confirmed, dispatch-command,
  tracking-deferred, voided, or return-label outcomes; and
- 1 unsafe component with `COMPONENT_QUANTITY_PROOF_FAILED` because current
  provider membership did not cover one unit on one WMS shipment item.

No-write reachability is code-backed: the provider lookup is hard-coded GET at
`scripts/repair-historical-shipstation-splits.ts:276`; dry-run receives no
execution-audit authority at
`server/modules/oms/historical-shipstation-split-repair.service.ts:423`;
`mutationAllowed` is therefore false at line 532; and apply/finalization calls
are gated by it at line 613. The inspection queries are unlocked reads.

No standalone stdout artifact, execution-time output hash, or before/after
database snapshot was captured. Do not use this observation as authorization for
repair or migration.
## Aggregate conclusions supported by this snapshot

1. Current durable label evidence is quantity-lossy and cannot distinguish all
   exact relabel, split, active-active, invalid-row, and empty-array cases.
2. Both equal and different exact-content active-plus-voided pairs exist, but
   their causal action and chronology are not proven.
3. Two active-active groups exist in the durable ledger; each has two active
   labels, one carrier-confirmed label, and one physical-linked label. Exact
   quantity equality was sampled for one group only.
4. Three canonical physical packages span two WMS orders each.
5. Nineteen retained `not_confirmed` event snapshots across nine voided labels
   were received/effectively timestamped after void; 18 carry provider
   occurrence times after void. No confirmed carrier possession after void was
   observed.
6. The current OMS and WMS populations contain only `standard`; zero observed
   mixed-service groups cannot validate expedited grouping behavior.
7. Combined-group recorded counts and current joined membership disagree by six
   orders across an aggregate two-row group gap.

## Explicit unknowns and exclusions

The audit does not prove:

- the provider milestone represented by `createDate` or `shipDate`;
- a durable provider-authored label generation or postage-purchase timestamp;
- a reliable provider Reship action marker. Actor or approving-lead identity is
  not required by the approved policy;
- that any active-plus-voided pair was caused by replacement, split, combine,
  reprint, or another specific ShipStation UI action;
- event chronology for a void-to-new-label transfer unless separately captured;
- exact line/quantity distributions for all 37 active-plus-voided groups;
- exact quantity equality for the second active-active candidate;
- a truly empty provider shipment in current production;
- carrier possession after a label was voided;
- partial source-line allocation across B/C packages end to end;
- a combined package later split into order-subset packages end to end;
- service-class grouping behavior for expedited or unknown values;
- that `shipment_tracking_history.replaced_at` identifies a provider Reship UI
  action; or
- that aggregate database state reconstructs raw SHIP_NOTIFY response bodies.

Raw authenticated carrier-tracking callback bodies are retained separately.
Raw SHIP_NOTIFY response bodies and raw ShipStation GET responses are not
durably retained by the traced label path. No result in this manifest authorizes
historical repair, migration, production mutation, or lifecycle cutover.
