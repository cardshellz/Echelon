-- Persist the standalone cartonizer's verified unit-level placement plan.
-- Existing plans receive an empty array and are superseded automatically when
-- the engine version/input check next regenerates the order's active plan.

ALTER TABLE shipping.pack_plan_parcels
  ADD COLUMN IF NOT EXISTS placements JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'shipping_parcel_placements_array_chk'
      AND conrelid = 'shipping.pack_plan_parcels'::regclass
  ) THEN
    ALTER TABLE shipping.pack_plan_parcels
      ADD CONSTRAINT shipping_parcel_placements_array_chk
      CHECK (jsonb_typeof(placements) = 'array');
  END IF;
END;
$$;
