-- Shipment idempotency: one outbound_shipment per external_fulfillment_id.
--
-- The Shopify fulfillment webhook handler (fulfillment.service.ts
-- processShopifyFulfillment) does a read-then-insert idempotency check on
-- external_fulfillment_id, but the column had no unique constraint — so two
-- concurrent webhooks for the same fulfillment could both pass the check and
-- both deduct inventory (double-ship). This adds the missing unique index so
-- the insert's ON CONFLICT DO NOTHING can make the path concurrency-safe.
--
-- Partial index (WHERE external_fulfillment_id IS NOT NULL) because manual /
-- api shipments legitimately have a NULL external_fulfillment_id and several
-- such rows must be allowed to coexist.
--
-- Same idempotency pattern as ship dedup (0570), reserve dedup (0577), and
-- receipt dedup (0578).

-- Pre-flight: detect existing duplicates so CREATE UNIQUE INDEX doesn't fail
-- with an opaque error. True duplicates are real double-ships and need manual
-- reconciliation (inventory may have been deducted twice) — we do NOT mutate
-- the financial record blind inside a migration.
DO $$
DECLARE
  dup_groups integer;
  sample text;
BEGIN
  SELECT COUNT(*),
         COALESCE(
           string_agg(
             format('(fulfillment=%s, rows=%s)', external_fulfillment_id, cnt),
             ', ' ORDER BY cnt DESC
           ),
           ''
         )
    INTO dup_groups, sample
  FROM (
    SELECT external_fulfillment_id, COUNT(*) AS cnt
    FROM wms.outbound_shipments
    WHERE external_fulfillment_id IS NOT NULL
    GROUP BY external_fulfillment_id
    HAVING COUNT(*) > 1
    LIMIT 25
  ) d;

  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'outbound_shipment fulfillment dedup preflight: % fulfillment id(s) have duplicate '
      'shipment rows. These are real double-ships and need manual reconciliation '
      '(inventory may have been deducted twice). Sample: %', dup_groups, sample;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_shipments_external_fulfillment_id
  ON wms.outbound_shipments (external_fulfillment_id)
  WHERE external_fulfillment_id IS NOT NULL;
