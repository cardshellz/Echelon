-- An admitted recreation invalidates prior quantity acknowledgements for this
-- exact listing, even when Walmart reuses its product ID and ATP is unchanged.
ALTER TABLE inventory.publication_listing_setup_scopes
  ADD COLUMN IF NOT EXISTS recreation_evidence jsonb;
ALTER TABLE inventory.publication_listing_setup_scopes
  ADD CONSTRAINT publication_listing_recreation_evidence_object
  CHECK (recreation_evidence IS NULL OR jsonb_typeof(recreation_evidence) = 'object');

-- Written atomically with a fresh canonical desired revision. The listing job
-- retries this handoff after a crash; the existing outbox owns transport retries
-- and quantity readback. Old setup and provider evidence remain immutable.
CREATE TABLE inventory.publication_listing_recreation_stock_receipts (
  setup_scope_id bigint PRIMARY KEY REFERENCES inventory.publication_listing_setup_scopes(id),
  external_product_id text NOT NULL CHECK (length(external_product_id) BETWEEN 1 AND 120),
  outbox_id bigint NOT NULL REFERENCES inventory.inventory_publication_outbox(id),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  actor text NOT NULL CHECK (length(actor) > 0)
);
CREATE FUNCTION inventory.guard_listing_recreation_stock_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.observed_at > NEW.created_at OR NOT EXISTS (
    SELECT 1 FROM inventory.publication_listing_setup_scopes s
    JOIN inventory.inventory_publication_outbox o ON o.id=NEW.outbox_id
      AND o.publication_target_id=s.publication_target_id AND o.product_variant_id=s.product_variant_id
      AND o.external_inventory_item_id_snapshot=s.external_inventory_item_id
    JOIN inventory.inventory_publication_targets t ON t.id=s.publication_target_id
      AND t.revision=o.publication_target_revision_snapshot
    WHERE s.id=NEW.setup_scope_id AND s.recreation_evidence IS NOT NULL
      AND o.state='queued' AND o.publication_phase='full'
      AND NOT EXISTS(SELECT 1 FROM inventory.inventory_publication_outbox newer
        WHERE newer.publication_target_id=o.publication_target_id AND newer.product_variant_id=o.product_variant_id
          AND newer.desired_revision>o.desired_revision)
  ) THEN RAISE EXCEPTION 'Recreation stock receipt requires its exact current queued publication' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_listing_recreation_stock_receipt_lineage
  BEFORE INSERT ON inventory.publication_listing_recreation_stock_receipts
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_listing_recreation_stock_receipt();
CREATE TRIGGER publication_listing_recreation_stock_receipts_immutable
  BEFORE UPDATE OR DELETE ON inventory.publication_listing_recreation_stock_receipts
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_membership_evidence();
CREATE TRIGGER publication_listing_recreation_stock_receipts_no_truncate
  BEFORE TRUNCATE ON inventory.publication_listing_recreation_stock_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_publication_membership_evidence();
CREATE INDEX publication_listing_recreation_pending_idx
  ON inventory.publication_listing_setup_scopes(publication_target_id, product_variant_id, id DESC)
  WHERE recreation_evidence IS NOT NULL;
CREATE INDEX quantity_publication_attempts_listing_setup_operation_idx
  ON inventory.quantity_publication_attempts(listing_setup_operation_id)
  WHERE listing_setup_operation_id IS NOT NULL;
