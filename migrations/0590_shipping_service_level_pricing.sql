-- Price checkout-owned service levels instead of provider-owned carrier
-- methods. Shared rate tables are still unused in production, so replace the
-- carrier-first shape rather than carrying a compatibility layer forward.

TRUNCATE TABLE shipping.rate_table_rows, shipping.rate_tables RESTART IDENTITY;

ALTER TABLE shipping.service_levels
  ADD COLUMN fulfillment_mode varchar(30) NOT NULL DEFAULT 'parcel',
  ADD COLUMN promise_min_business_days integer,
  ADD COLUMN promise_max_business_days integer;

ALTER TABLE shipping.service_levels
  ADD CONSTRAINT shipping_service_level_fulfillment_mode_chk
    CHECK (fulfillment_mode IN ('parcel', 'freight')),
  ADD CONSTRAINT shipping_service_level_promise_chk
    CHECK (
      (
        promise_min_business_days IS NULL
        AND promise_max_business_days IS NULL
      )
      OR (
        promise_min_business_days IS NOT NULL
        AND promise_max_business_days IS NOT NULL
        AND promise_min_business_days >= 0
        AND promise_max_business_days >= promise_min_business_days
      )
    );

UPDATE shipping.service_levels
SET
  fulfillment_mode = 'parcel',
  promise_min_business_days = CASE code
    WHEN 'standard' THEN 3
    WHEN 'expedited' THEN 2
    WHEN 'express' THEN 1
    ELSE promise_min_business_days
  END,
  promise_max_business_days = CASE code
    WHEN 'standard' THEN 7
    WHEN 'expedited' THEN 3
    WHEN 'express' THEN 1
    ELSE promise_max_business_days
  END,
  display_name = CASE code
    WHEN 'expedited' THEN 'Priority Shipping'
    WHEN 'express' THEN 'Overnight Shipping'
    ELSE display_name
  END,
  description = CASE code
    WHEN 'standard' THEN 'Economical parcel delivery'
    WHEN 'expedited' THEN 'Faster parcel delivery'
    WHEN 'express' THEN 'Next-business-day parcel delivery'
    ELSE description
  END,
  is_active = CASE WHEN code = 'standard' THEN TRUE ELSE FALSE END,
  updated_at = now()
WHERE code IN ('standard', 'expedited', 'express');

INSERT INTO shipping.service_levels (
  code,
  display_name,
  description,
  sort_order,
  is_active,
  fulfillment_mode,
  promise_min_business_days,
  promise_max_business_days
)
VALUES (
  'pallet_freight',
  'Pallet Freight',
  'Palletized freight delivery for larger orders',
  40,
  FALSE,
  'freight',
  NULL,
  NULL
)
ON CONFLICT (code) DO NOTHING;

DROP INDEX IF EXISTS shipping.shipping_rate_table_carrier_service_idx;

ALTER TABLE shipping.rate_tables
  ALTER COLUMN rate_book_id SET NOT NULL,
  DROP COLUMN carrier,
  DROP COLUMN service_code,
  ADD COLUMN service_level_id integer NOT NULL
    REFERENCES shipping.service_levels(id) ON DELETE RESTRICT,
  ADD COLUMN pricing_basis varchar(30) NOT NULL DEFAULT 'shipment_weight';

ALTER TABLE shipping.rate_tables
  ADD CONSTRAINT shipping_rate_table_pricing_basis_chk
    CHECK (pricing_basis IN ('shipment_weight', 'pallet_count'));

CREATE INDEX shipping_rate_table_service_level_idx
  ON shipping.rate_tables(rate_book_id, service_level_id, status);

DROP INDEX IF EXISTS shipping.shipping_rate_row_band_idx;

ALTER TABLE shipping.rate_table_rows
  DROP CONSTRAINT IF EXISTS shipping_rate_row_weight_chk;

ALTER TABLE shipping.rate_table_rows
  RENAME COLUMN min_weight_grams TO min_measure;

ALTER TABLE shipping.rate_table_rows
  RENAME COLUMN max_weight_grams TO max_measure;

ALTER TABLE shipping.rate_table_rows
  ADD COLUMN max_shipment_weight_grams integer;

ALTER TABLE shipping.rate_table_rows
  ADD CONSTRAINT shipping_rate_row_measure_chk
    CHECK (min_measure >= 0 AND max_measure >= min_measure),
  ADD CONSTRAINT shipping_rate_row_shipment_weight_chk
    CHECK (
      max_shipment_weight_grams IS NULL
      OR max_shipment_weight_grams > 0
    );

CREATE UNIQUE INDEX shipping_rate_row_band_idx
  ON shipping.rate_table_rows (
    rate_table_id,
    COALESCE(origin_warehouse_id, 0),
    destination_country,
    destination_region,
    COALESCE(postal_prefix, ''),
    min_measure,
    max_measure,
    COALESCE(max_shipment_weight_grams, 0)
  );
