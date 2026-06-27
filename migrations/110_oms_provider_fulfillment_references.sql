-- Provider-neutral fulfillment references for OMS order lines.
--
-- The original fulfillment-order linkage columns on oms.oms_order_lines use
-- Shopify-specific names:
--
--   shopify_fulfillment_order_id
--   shopify_fulfillment_order_line_item_id
--
-- OMS now carries multiple providers, including eBay and dropship channels, so
-- core OMS line references need a provider-neutral contract before downstream
-- callers can migrate away from Shopify-only column names.
--
-- Safety:
--   - Additive nullable columns only.
--   - Existing Shopify columns remain in place as compatibility aliases.
--   - The backfill copies Shopify values into empty neutral columns, but never
--     overwrites an existing non-Shopify neutral provider.
--   - No runtime reader or writer changes are included in this migration.

ALTER TABLE oms.oms_order_lines
  ADD COLUMN IF NOT EXISTS fulfillment_provider varchar(40),
  ADD COLUMN IF NOT EXISTS provider_fulfillment_order_id varchar(200),
  ADD COLUMN IF NOT EXISTS provider_fulfillment_order_line_item_id varchar(200);

UPDATE oms.oms_order_lines
SET
  fulfillment_provider = COALESCE(fulfillment_provider, 'shopify'),
  provider_fulfillment_order_id = COALESCE(
    provider_fulfillment_order_id,
    shopify_fulfillment_order_id
  ),
  provider_fulfillment_order_line_item_id = COALESCE(
    provider_fulfillment_order_line_item_id,
    shopify_fulfillment_order_line_item_id
  )
WHERE (shopify_fulfillment_order_id IS NOT NULL OR shopify_fulfillment_order_line_item_id IS NOT NULL)
  AND (fulfillment_provider IS NULL OR fulfillment_provider = 'shopify')
  AND (
    fulfillment_provider IS NULL
    OR provider_fulfillment_order_id IS NULL
    OR provider_fulfillment_order_line_item_id IS NULL
  );

CREATE INDEX IF NOT EXISTS idx_oms_lines_provider_fulfillment_order
  ON oms.oms_order_lines (fulfillment_provider, provider_fulfillment_order_id)
  WHERE provider_fulfillment_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oms_lines_provider_fulfillment_line
  ON oms.oms_order_lines (fulfillment_provider, provider_fulfillment_order_line_item_id)
  WHERE provider_fulfillment_order_line_item_id IS NOT NULL;
