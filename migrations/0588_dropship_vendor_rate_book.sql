-- Give dropship vendor-fulfillment charges an independently managed rate book.
-- The zone set remains useful for transit observability, while pricing is read
-- directly from state/ZIP rows owned by this book.

INSERT INTO shipping.rate_books (
  code,
  name,
  zone_set_id,
  status,
  metadata
)
SELECT
  'dropship-vendor-default',
  'Dropship vendor fulfillment',
  retail_book.zone_set_id,
  'active',
  '{"source":"dropship-shipping-setup","migration":588}'::jsonb
FROM shipping.rate_books retail_book
WHERE retail_book.code = 'shopify-retail-default'
ON CONFLICT (code) DO NOTHING;

INSERT INTO shipping.rate_book_assignments (
  rate_book_id,
  pricing_channel,
  rate_purpose,
  origin_warehouse_id,
  is_active
)
SELECT
  book.id,
  'dropship',
  'vendor_fulfillment_charge',
  NULL,
  TRUE
FROM shipping.rate_books book
WHERE book.code = 'dropship-vendor-default'
  AND NOT EXISTS (
    SELECT 1
    FROM shipping.rate_book_assignments assignment
    WHERE assignment.pricing_channel = 'dropship'
      AND assignment.rate_purpose = 'vendor_fulfillment_charge'
      AND assignment.origin_warehouse_id IS NULL
      AND assignment.is_active = TRUE
  );
