-- Add explicit parcel charge semantics without changing existing fixed-band
-- rows. A NULL max_measure is a true open-ended final band.

ALTER TABLE shipping.rate_table_rows
  DROP CONSTRAINT IF EXISTS shipping_rate_row_measure_chk;

ALTER TABLE shipping.rate_table_rows
  ALTER COLUMN max_measure DROP NOT NULL,
  ADD COLUMN charge_model varchar(40) NOT NULL DEFAULT 'fixed_band',
  ADD COLUMN per_started_pound_cents bigint;

ALTER TABLE shipping.rate_table_rows
  ADD CONSTRAINT shipping_rate_row_measure_chk
    CHECK (
      min_measure >= 0
      AND (max_measure IS NULL OR max_measure >= min_measure)
    ),
  ADD CONSTRAINT shipping_rate_row_charge_model_chk
    CHECK (charge_model IN ('fixed_band', 'base_plus_per_started_pound')),
  ADD CONSTRAINT shipping_rate_row_charge_config_chk
    CHECK (
      (
        charge_model = 'fixed_band'
        AND per_started_pound_cents IS NULL
      )
      OR (
        charge_model = 'base_plus_per_started_pound'
        AND min_measure = 0
        AND max_measure IS NULL
        AND max_shipment_weight_grams IS NULL
        AND per_started_pound_cents IS NOT NULL
        AND per_started_pound_cents >= 0
      )
    );

DROP INDEX IF EXISTS shipping.shipping_rate_row_band_idx;

CREATE UNIQUE INDEX shipping_rate_row_band_idx
  ON shipping.rate_table_rows (
    rate_table_id,
    COALESCE(origin_warehouse_id, 0),
    destination_country,
    destination_region,
    COALESCE(postal_prefix, ''),
    min_measure,
    COALESCE(max_measure, -1),
    COALESCE(max_shipment_weight_grams, 0),
    charge_model
  );
