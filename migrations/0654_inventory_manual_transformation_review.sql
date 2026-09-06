-- Manual rules retain immutable creation provenance and approvals. Editing creates
-- a new operator-authored draft; it never changes a reviewed definition in place.
-- No active model, runtime authority, inventory, or publication row is changed.
ALTER TABLE inventory.transformation_model_versions
  ADD COLUMN operator_input_hash VARCHAR(64),
  ADD CONSTRAINT transformation_model_versions_operator_input_chk CHECK (
    operator_input_hash IS NULL OR
    (origin = 'operator' AND operator_input_hash ~ '^[0-9a-f]{64}$')
  );

CREATE FUNCTION inventory.guard_transformation_operator_input_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.operator_input_hash IS DISTINCT FROM OLD.operator_input_hash THEN
    RAISE EXCEPTION 'operator transformation source evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transformation_model_operator_input_guard
BEFORE UPDATE ON inventory.transformation_model_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_transformation_operator_input_update();

CREATE OR REPLACE FUNCTION inventory.guard_transformation_model_supersession()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(918422, OLD.product_id);
  IF OLD.lifecycle_status <> 'draft' OR NEW.lifecycle_status <> 'superseded' THEN
    RAISE EXCEPTION 'only drafts may be superseded';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['lifecycle_status', 'superseded_by', 'superseded_at',
      'supersession_reason', 'updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['lifecycle_status', 'superseded_by', 'superseded_at',
      'supersession_reason', 'updated_at']) THEN
    RAISE EXCEPTION 'transformation model definition fields cannot change while superseding';
  END IF;
  IF NEW.superseded_by IS NULL OR btrim(NEW.superseded_by) = ''
     OR NEW.superseded_at IS NULL OR NEW.superseded_at < OLD.created_at
     OR NEW.supersession_reason IS NULL
     OR char_length(btrim(NEW.supersession_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'transformation model supersession evidence is incomplete';
  END IF;
  PERFORM 1 FROM inventory.transformation_model_heads
  WHERE product_id = OLD.product_id AND draft_model_id = OLD.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only the current transformation model draft may be superseded';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION inventory.assert_transformation_model_supersession_coherence()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.lifecycle_status = 'superseded' AND OLD.lifecycle_status = 'draft'
     AND NOT EXISTS (
       SELECT 1 FROM inventory.transformation_model_versions successor
       JOIN inventory.transformation_model_heads head
         ON head.product_id = successor.product_id AND head.draft_model_id = successor.id
       WHERE successor.supersedes_model_id = NEW.id
         AND successor.product_id = NEW.product_id AND successor.version = NEW.version + 1
         AND successor.lifecycle_status = 'draft'
         AND successor.created_at >= NEW.superseded_at
         -- Generated refresh must never replace an operator-authored definition.
         AND (OLD.origin = 'phase3_backfill' OR successor.origin = 'operator')
         AND (successor.origin <> 'operator' OR successor.operator_input_hash IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'superseded draft % requires a current, source-bound successor', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN inventory.transformation_model_versions.operator_input_hash IS
  'Catalog source fingerprint captured when this operator draft was validated; immutable. Legacy null requires a new reviewed version. Grants no runtime authority.';
