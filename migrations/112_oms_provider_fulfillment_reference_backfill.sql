-- Repair Shopify provider-neutral fulfillment references after the transition.
--
-- Migration 110 introduced the neutral columns and copied existing Shopify
-- fulfillment-order aliases. Runtime writers now maintain both sets, but rows
-- created in the transition window can still have Shopify alias values without
-- neutral provider references.
--
-- Safety:
--   - Idempotent data repair only.
--   - Copies Shopify aliases into missing neutral fields.
--   - Normalizes blank/missing Shopify provider context to `shopify`.
--   - Never touches rows that already declare a non-Shopify provider.

UPDATE oms.oms_order_lines
SET
  fulfillment_provider = 'shopify',
  provider_fulfillment_order_id = COALESCE(
    NULLIF(BTRIM(provider_fulfillment_order_id), ''),
    NULLIF(BTRIM(shopify_fulfillment_order_id), '')
  ),
  provider_fulfillment_order_line_item_id = COALESCE(
    NULLIF(BTRIM(provider_fulfillment_order_line_item_id), ''),
    NULLIF(BTRIM(shopify_fulfillment_order_line_item_id), '')
  )
WHERE (
    NULLIF(BTRIM(shopify_fulfillment_order_id), '') IS NOT NULL
    OR NULLIF(BTRIM(shopify_fulfillment_order_line_item_id), '') IS NOT NULL
  )
  AND COALESCE(LOWER(NULLIF(BTRIM(fulfillment_provider), '')), 'shopify') = 'shopify'
  AND (
    COALESCE(LOWER(NULLIF(BTRIM(fulfillment_provider), '')), '') <> 'shopify'
    OR NULLIF(BTRIM(provider_fulfillment_order_id), '') IS NULL
    OR NULLIF(BTRIM(provider_fulfillment_order_line_item_id), '') IS NULL
  );
