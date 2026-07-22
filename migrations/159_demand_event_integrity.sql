-- Harden future-demand overlays as auditable purchasing inputs.
-- Existing rows remain readable while new writes are checked immediately.

ALTER TABLE procurement.demand_events
  ALTER COLUMN created_by TYPE VARCHAR(100)
  USING created_by::text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'demand_events_created_by_fk'
      AND conrelid = 'procurement.demand_events'::regclass
  ) THEN
    ALTER TABLE procurement.demand_events
      ADD CONSTRAINT demand_events_created_by_fk
      FOREIGN KEY (created_by) REFERENCES identity.users(id)
      ON DELETE SET NULL NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'demand_events_date_window_chk'
      AND conrelid = 'procurement.demand_events'::regclass
  ) THEN
    ALTER TABLE procurement.demand_events
      ADD CONSTRAINT demand_events_date_window_chk
      CHECK (end_date IS NULL OR end_date >= start_date) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'demand_event_lines_product_fk'
      AND conrelid = 'procurement.demand_event_lines'::regclass
  ) THEN
    ALTER TABLE procurement.demand_event_lines
      ADD CONSTRAINT demand_event_lines_product_fk
      FOREIGN KEY (product_id) REFERENCES catalog.products(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'demand_event_lines_variant_fk'
      AND conrelid = 'procurement.demand_event_lines'::regclass
  ) THEN
    ALTER TABLE procurement.demand_event_lines
      ADD CONSTRAINT demand_event_lines_variant_fk
      FOREIGN KEY (product_variant_id) REFERENCES catalog.product_variants(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_id_product_uidx
  ON catalog.product_variants (id, product_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'demand_event_lines_variant_product_fk'
      AND conrelid = 'procurement.demand_event_lines'::regclass
  ) THEN
    ALTER TABLE procurement.demand_event_lines
      ADD CONSTRAINT demand_event_lines_variant_product_fk
      FOREIGN KEY (product_variant_id, product_id)
      REFERENCES catalog.product_variants(id, product_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
