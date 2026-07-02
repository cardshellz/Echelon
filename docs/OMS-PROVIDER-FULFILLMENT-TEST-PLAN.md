# OMS Provider Fulfillment Reference Test Plan

This runbook validates the provider-neutral OMS fulfillment-reference changes
merged through PR #734. It is written for PowerShell on Windows and assumes the
repository is `cardshellz/Echelon`.

## Scope

Validate that:

- OMS order lines have the neutral provider columns.
- Shopify compatibility aliases backfill into the neutral fields.
- Shopify fulfillment push reads neutral fields first and ignores explicit
  non-Shopify provider lines.
- eBay direct tracking ignores explicit non-eBay provider lines.
- Dropship marketplace tracking ignores explicit non-dropship provider lines.
- Ops health/reconciliation reports provider-reference drift only for real
  transition gaps.

## Local Checkout

From a home computer with Git, Node, and npm available:

```powershell
git clone https://github.com/cardshellz/Echelon.git
cd Echelon
git checkout main
git pull --ff-only origin main
npm.cmd ci
```

If the repo already exists locally:

```powershell
cd C:\path\to\Echelon
git checkout main
git pull --ff-only origin main
npm.cmd ci
```

## Automated Validation

Run typecheck:

```powershell
npm.cmd run check
```

Run the focused provider-contract suite:

```powershell
npx.cmd vitest run server/modules/oms/__tests__/unit/provider-fulfillment-reference-migration.test.ts server/modules/oms/__tests__/unit/ingest-fulfillment-orders.test.ts server/modules/oms/__tests__/unit/push-shopify-fulfillment.test.ts server/modules/oms/__tests__/unit/ebay-tracking-push-regression.test.ts server/modules/dropship/__tests__/unit/dropship-marketplace-tracking.repository.test.ts server/modules/dropship/__tests__/unit/dropship-order-acceptance.repository.test.ts server/modules/oms/__tests__/unit/oms-flow-reconciliation.service.test.ts server/modules/oms/__tests__/unit/ops-health.service.test.ts
```

Expected result:

- `npm.cmd run check` exits with code `0`.
- Vitest reports all listed test files and tests passed.
- Console warnings from mocked test DB objects, such as
  `db.insert is not a function`, are acceptable when the test still passes.

## Read-Only Database Checks

Use these after the deployment and migrations have run. For Heroku:

```powershell
heroku.cmd pg:psql --app cardshellz-echelon
```

### 1. Columns Exist

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'oms'
  AND table_name = 'oms_order_lines'
  AND column_name IN (
    'fulfillment_provider',
    'provider_fulfillment_order_id',
    'provider_fulfillment_order_line_item_id',
    'shopify_fulfillment_order_id',
    'shopify_fulfillment_order_line_item_id'
  )
ORDER BY column_name;
```

Expected result:

- All five columns are present.

### 2. Provider Distribution

```sql
SELECT
  COALESCE(NULLIF(BTRIM(fulfillment_provider), ''), '(legacy blank)') AS fulfillment_provider,
  COUNT(*)::int AS line_count
FROM oms.oms_order_lines
GROUP BY 1
ORDER BY line_count DESC;
```

Expected result:

- Existing legacy rows may show `(legacy blank)`.
- New Shopify/eBay/dropship rows should increasingly show `shopify`, `ebay`,
  or `dropship`.

### 3. Shopify Alias Backfill Gaps

```sql
SELECT COUNT(*)::int AS shopify_alias_neutral_gap_count
FROM oms.oms_order_lines
WHERE (
    NULLIF(BTRIM(shopify_fulfillment_order_id), '') IS NOT NULL
    OR NULLIF(BTRIM(shopify_fulfillment_order_line_item_id), '') IS NOT NULL
  )
  AND COALESCE(LOWER(NULLIF(BTRIM(fulfillment_provider), '')), 'shopify') = 'shopify'
  AND (
    LOWER(NULLIF(BTRIM(fulfillment_provider), '')) IS DISTINCT FROM 'shopify'
    OR NULLIF(BTRIM(provider_fulfillment_order_id), '') IS NULL
    OR NULLIF(BTRIM(provider_fulfillment_order_line_item_id), '') IS NULL
  );
```

Expected result:

- `0` after migration `112_oms_provider_fulfillment_reference_backfill.sql`
  has run.
- A nonzero value means Shopify alias rows still need neutral-field repair.

### 4. Provider Reference Drift Sample

```sql
WITH provider_reference_rows AS (
  SELECT
    ol.order_id AS oms_order_id,
    oo.external_order_number,
    ol.id AS oms_order_line_id,
    ol.sku,
    ol.fulfillment_provider,
    LOWER(NULLIF(BTRIM(ol.fulfillment_provider), '')) AS normalized_fulfillment_provider,
    NULLIF(BTRIM(ol.provider_fulfillment_order_id), '') AS provider_fulfillment_order_id,
    NULLIF(BTRIM(ol.provider_fulfillment_order_line_item_id), '') AS provider_fulfillment_order_line_item_id,
    NULLIF(BTRIM(ol.shopify_fulfillment_order_id), '') AS shopify_fulfillment_order_id,
    NULLIF(BTRIM(ol.shopify_fulfillment_order_line_item_id), '') AS shopify_fulfillment_order_line_item_id
  FROM oms.oms_order_lines ol
  JOIN oms.oms_orders oo ON oo.id = ol.order_id
),
provider_reference_drift AS (
  SELECT
    *,
    CASE
      WHEN normalized_fulfillment_provider IS DISTINCT FROM 'shopify'
        THEN 'provider_context_missing_or_mismatched'
      WHEN provider_fulfillment_order_id IS DISTINCT FROM shopify_fulfillment_order_id
        THEN 'fulfillment_order_id_mismatch'
      WHEN provider_fulfillment_order_line_item_id IS DISTINCT FROM shopify_fulfillment_order_line_item_id
        THEN 'fulfillment_order_line_item_id_mismatch'
      ELSE 'unknown'
    END AS drift_reason
  FROM provider_reference_rows
  WHERE (
      normalized_fulfillment_provider = 'shopify'
      OR shopify_fulfillment_order_id IS NOT NULL
      OR shopify_fulfillment_order_line_item_id IS NOT NULL
    )
    AND (
      normalized_fulfillment_provider IS DISTINCT FROM 'shopify'
      OR provider_fulfillment_order_id IS DISTINCT FROM shopify_fulfillment_order_id
      OR provider_fulfillment_order_line_item_id IS DISTINCT FROM shopify_fulfillment_order_line_item_id
    )
)
SELECT *
FROM provider_reference_drift
ORDER BY oms_order_id DESC, oms_order_line_id DESC
LIMIT 20;
```

Expected result:

- Ideally no rows.
- Any returned row should match the ops-health issue
  `OMS_PROVIDER_FULFILLMENT_REFERENCE_DRIFT` and should be investigated.

## Controlled Workflow Smoke Tests

Run these only in an environment where creating test orders and pushes is safe.

### Shopify

1. Create or identify a Shopify test order that receives fulfillment-order data.
2. Let webhook ingestion run.
3. Confirm the OMS lines carry both neutral fields and Shopify aliases:

```sql
SELECT
  ol.id,
  ol.fulfillment_provider,
  ol.provider_fulfillment_order_id,
  ol.provider_fulfillment_order_line_item_id,
  ol.shopify_fulfillment_order_id,
  ol.shopify_fulfillment_order_line_item_id
FROM oms.oms_order_lines ol
JOIN oms.oms_orders oo ON oo.id = ol.order_id
WHERE oo.external_order_number = '<SHOPIFY_ORDER_NUMBER>'
ORDER BY ol.id;
```

Expected result:

- `fulfillment_provider = 'shopify'`.
- Provider-neutral fulfillment ids match the Shopify alias columns.
- Fulfillment push succeeds and does not include explicit non-Shopify lines.

### eBay

1. Ingest or identify a direct eBay test order.
2. Confirm its OMS lines are eBay-owned:

```sql
SELECT
  ol.id,
  ol.external_line_item_id,
  ol.fulfillment_provider,
  ol.quantity
FROM oms.oms_order_lines ol
JOIN oms.oms_orders oo ON oo.id = ol.order_id
JOIN channels.channels c ON c.id = oo.channel_id
WHERE c.provider = 'ebay'
ORDER BY oo.created_at DESC, ol.id
LIMIT 20;
```

Expected result:

- New direct eBay lines show `fulfillment_provider = 'ebay'`.
- Tracking push payload includes only eBay-owned or legacy blank-provider rows.

### Dropship

1. Accept a dropship test order.
2. Confirm accepted OMS lines are dropship-owned:

```sql
SELECT
  ol.id,
  ol.external_line_item_id,
  ol.fulfillment_provider,
  ol.quantity
FROM oms.oms_order_lines ol
JOIN oms.oms_orders oo ON oo.id = ol.order_id
WHERE oo.raw_payload::text ILIKE '%dropship_order_acceptance%'
   OR ol.fulfillment_provider = 'dropship'
ORDER BY oo.created_at DESC, ol.id
LIMIT 20;
```

Expected result:

- Accepted dropship lines show `fulfillment_provider = 'dropship'`.
- Dropship marketplace tracking includes only dropship-owned or legacy
  blank-provider rows.

## Pass Criteria

The change is healthy when:

- Local typecheck passes.
- Focused Vitest suite passes.
- Provider columns exist in the database.
- Shopify alias backfill gaps are `0`.
- `OMS_PROVIDER_FULFILLMENT_REFERENCE_DRIFT` is absent, or every row is a known
  transition leftover with a clear remediation path.
- New Shopify, eBay, and dropship test orders stamp the expected provider owner.
- Tracking/fulfillment pushes do not include lines explicitly owned by another
  provider.

## Notes

- Shopify alias columns intentionally remain during the transition window.
- Legacy blank `fulfillment_provider` rows are intentionally treated as
  compatible with the current provider path so historical orders keep working.
- Future cleanup can remove alias fallbacks only after production data and
  webhook paths no longer rely on the Shopify alias columns.
