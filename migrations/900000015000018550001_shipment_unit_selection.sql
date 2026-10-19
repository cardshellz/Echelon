-- Explicit shipment receive-unit evidence; no historical quantity or pack guesses.
ALTER TABLE procurement.inbound_shipment_lines ADD COLUMN IF NOT EXISTS units_per_variant_snapshot integer;
ALTER TABLE procurement.inbound_shipment_lines ADD COLUMN IF NOT EXISTS dimension_basis varchar(10);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'procurement.inbound_shipment_lines'::regclass AND conname = 'inbound_shipment_line_unit_snapshot_positive') THEN
    ALTER TABLE procurement.inbound_shipment_lines ADD CONSTRAINT inbound_shipment_line_unit_snapshot_positive CHECK (units_per_variant_snapshot IS NULL OR units_per_variant_snapshot > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'procurement.inbound_shipment_lines'::regclass AND conname = 'inbound_shipment_line_dimension_basis_valid') THEN
    ALTER TABLE procurement.inbound_shipment_lines ADD CONSTRAINT inbound_shipment_line_dimension_basis_valid CHECK (dimension_basis IS NULL OR dimension_basis IN ('piece', 'carton'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'procurement.inbound_shipment_lines'::regclass AND conname = 'inbound_shipment_line_unit_snapshot_identity') THEN
    ALTER TABLE procurement.inbound_shipment_lines ADD CONSTRAINT inbound_shipment_line_unit_snapshot_identity CHECK (units_per_variant_snapshot IS NULL OR product_variant_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'procurement.inbound_shipment_lines'::regclass AND conname = 'inbound_shipment_line_carton_basis_count') THEN
    ALTER TABLE procurement.inbound_shipment_lines ADD CONSTRAINT inbound_shipment_line_carton_basis_count CHECK (dimension_basis IS DISTINCT FROM 'carton' OR (carton_count IS NOT NULL AND carton_count > 0));
  END IF;
END $$;
