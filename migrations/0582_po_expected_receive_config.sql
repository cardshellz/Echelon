ALTER TABLE procurement.purchase_order_lines
  ADD COLUMN IF NOT EXISTS expected_receive_variant_id integer;

ALTER TABLE procurement.purchase_order_lines
  ADD COLUMN IF NOT EXISTS expected_receive_units_per_variant integer DEFAULT 1;

UPDATE procurement.purchase_order_lines
SET expected_receive_variant_id = product_variant_id
WHERE expected_receive_variant_id IS NULL
  AND product_variant_id IS NOT NULL;

UPDATE procurement.purchase_order_lines pol
SET expected_receive_units_per_variant = COALESCE(
  NULLIF(pol.units_per_uom, 0),
  NULLIF(pv.units_per_variant, 0),
  1
)
FROM catalog.product_variants pv
WHERE pol.expected_receive_variant_id = pv.id
  AND (
    pol.expected_receive_units_per_variant IS NULL
    OR pol.expected_receive_units_per_variant <= 0
  );

UPDATE procurement.purchase_order_lines
SET expected_receive_units_per_variant = 1
WHERE expected_receive_units_per_variant IS NULL
  OR expected_receive_units_per_variant <= 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'purchase_order_lines_expected_receive_variant_id_fkey'
      AND conrelid = 'procurement.purchase_order_lines'::regclass
  ) THEN
    ALTER TABLE procurement.purchase_order_lines
      ADD CONSTRAINT purchase_order_lines_expected_receive_variant_id_fkey
      FOREIGN KEY (expected_receive_variant_id)
      REFERENCES catalog.product_variants(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS purchase_order_lines_expected_receive_variant_idx
  ON procurement.purchase_order_lines(expected_receive_variant_id)
  WHERE expected_receive_variant_id IS NOT NULL;
