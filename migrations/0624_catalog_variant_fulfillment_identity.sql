-- Separate fulfillment identity from inventory management. A digital variant
-- is non-shipping and cannot participate in warehouse inventory workflows.
ALTER TABLE catalog.product_variants
  ADD COLUMN IF NOT EXISTS requires_shipping boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_variants_digital_untracked_chk'
      AND conrelid = 'catalog.product_variants'::regclass
  ) THEN
    ALTER TABLE catalog.product_variants
      ADD CONSTRAINT product_variants_digital_untracked_chk
      CHECK (requires_shipping = true OR track_inventory IS FALSE);
  END IF;
END $$;

COMMENT ON COLUMN catalog.product_variants.requires_shipping IS
  'False for digital/non-shipping variants. Such variants must also have track_inventory=false and are excluded from ATP, reservations, picking, and channel inventory publication.';
