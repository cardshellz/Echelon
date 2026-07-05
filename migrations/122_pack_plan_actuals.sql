-- Pack plan actuals — PACKING PAGE v2 (calibration loop).
--
-- v1 pushed the predicted box into ShipStation notes; v2 lets the pack
-- station confirm the ACTUAL box + weight used per parcel. Predicted
-- (box_id / est_weight_grams) vs actual (actual_box_id /
-- actual_weight_grams) on the SAME row makes the calibration join trivial.
--
-- Additive only. actual_box_id is SET NULL on box deletion so a retired
-- box never blocks catalog cleanup nor loses the weight observation.

ALTER TABLE shipping.pack_plan_parcels
  ADD COLUMN IF NOT EXISTS actual_box_id INTEGER REFERENCES shipping.box_catalog(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actual_weight_grams INTEGER,
  ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS packed_by VARCHAR(120);

-- Re-runnable: constraints have no IF NOT EXISTS, so drop-then-add.
ALTER TABLE shipping.pack_plan_parcels
  DROP CONSTRAINT IF EXISTS shipping_parcel_actual_weight_chk;
ALTER TABLE shipping.pack_plan_parcels
  ADD CONSTRAINT shipping_parcel_actual_weight_chk
  CHECK (actual_weight_grams IS NULL OR actual_weight_grams > 0);

-- Calibration reads filter on confirmed parcels.
CREATE INDEX IF NOT EXISTS shipping_parcel_packed_at_idx
  ON shipping.pack_plan_parcels(packed_at)
  WHERE packed_at IS NOT NULL;
