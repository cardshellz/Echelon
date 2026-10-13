-- Initial quantities are resolved by inventory immediately before each feed
-- attempt. The immutable setup scope describes the command; the exact quantity
-- belongs to that attempt, so a definitely-unsent retry can use fresh ATP.
ALTER TABLE inventory.publication_listing_setup_scopes
  ALTER COLUMN desired_quantity DROP NOT NULL,
  ADD COLUMN quantity_source text NOT NULL DEFAULT 'fixed_zero'
    CHECK (quantity_source IN ('fixed_zero', 'canonical_at_submission')),
  ADD CONSTRAINT publication_listing_setup_quantity_source_check
    CHECK ((quantity_source = 'fixed_zero' AND desired_quantity IS NOT NULL AND desired_quantity = 0)
      OR (quantity_source = 'canonical_at_submission' AND desired_quantity IS NULL));

ALTER TABLE inventory.quantity_publication_attempts
  ADD COLUMN listing_setup_intent jsonb,
  ADD CONSTRAINT quantity_publication_setup_intent_check
    CHECK (listing_setup_intent IS NULL OR
      (listing_setup_operation_id IS NOT NULL AND jsonb_typeof(listing_setup_intent) = 'object'));

COMMENT ON COLUMN inventory.quantity_publication_attempts.listing_setup_intent IS
  'Inventory-owned, immutable exact initial quantities resolved from canonical ATP for this provider attempt. The historical owner_kind listing_setup_zero also identifies canonical initial listing attempts.';
COMMENT ON TABLE inventory.publication_listing_setup_scopes IS
  'Immutable initial-listing identities. Canonical-at-submission commands record exact quantities on each quantity_publication_attempt, never reuse a stale review quantity.';

CREATE FUNCTION inventory.guard_initial_listing_quantity_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.listing_setup_intent IS DISTINCT FROM OLD.listing_setup_intent THEN
    RAISE EXCEPTION 'Initial listing quantity evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_publication_initial_stock_immutable
  BEFORE UPDATE ON inventory.quantity_publication_attempts
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_initial_listing_quantity_evidence();
