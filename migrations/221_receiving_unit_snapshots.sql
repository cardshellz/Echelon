-- Preserve the received variant's unit basis and exact shipment source for new
-- receipts. Historical rows remain NULL and require explicit evidence review.
BEGIN;

ALTER TABLE procurement.receiving_lines
  ADD COLUMN IF NOT EXISTS units_per_variant_snapshot integer,
  ADD COLUMN IF NOT EXISTS inbound_shipment_line_id integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receiving_lines_unit_snapshot_positive_chk' AND conrelid = 'procurement.receiving_lines'::regclass) THEN
    ALTER TABLE procurement.receiving_lines ADD CONSTRAINT receiving_lines_unit_snapshot_positive_chk
      CHECK (units_per_variant_snapshot IS NULL OR units_per_variant_snapshot > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receiving_lines_inbound_shipment_line_fk' AND conrelid = 'procurement.receiving_lines'::regclass) THEN
    ALTER TABLE procurement.receiving_lines ADD CONSTRAINT receiving_lines_inbound_shipment_line_fk
      FOREIGN KEY (inbound_shipment_line_id) REFERENCES procurement.inbound_shipment_lines(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS receiving_lines_inbound_shipment_line_idx
  ON procurement.receiving_lines(inbound_shipment_line_id) WHERE inbound_shipment_line_id IS NOT NULL;

COMMIT;
