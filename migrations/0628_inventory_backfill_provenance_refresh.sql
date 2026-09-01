-- Preserve stale deterministic Phase 3 drafts as immutable history while allowing
-- an audited replacement draft to carry current input and result provenance.
--
-- This migration changes master-data draft lifecycle only. It does not activate a
-- model or alter ATP, inventory, reservations, builds, channel policy, provider
-- quantities, or publication behavior.

ALTER TABLE inventory.transformation_model_versions
  ADD COLUMN superseded_by VARCHAR(100),
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD COLUMN supersession_reason VARCHAR(1000);

ALTER TABLE inventory.transformation_model_versions
  DROP CONSTRAINT transformation_model_versions_status_chk,
  ADD CONSTRAINT transformation_model_versions_status_chk CHECK (
    lifecycle_status IN ('draft', 'sealed', 'retired', 'superseded')
  ),
  DROP CONSTRAINT transformation_model_versions_lifecycle_chk,
  ADD CONSTRAINT transformation_model_versions_lifecycle_chk CHECK (
    (lifecycle_status = 'draft'
      AND sealed_by IS NULL AND sealed_at IS NULL
      AND retired_by IS NULL AND retired_at IS NULL
      AND superseded_by IS NULL AND superseded_at IS NULL
      AND supersession_reason IS NULL)
    OR (lifecycle_status = 'sealed'
      AND validation_state = 'valid'
      AND sealed_by IS NOT NULL AND btrim(sealed_by) <> ''
      AND sealed_at IS NOT NULL
      AND retired_by IS NULL AND retired_at IS NULL
      AND superseded_by IS NULL AND superseded_at IS NULL
      AND supersession_reason IS NULL)
    OR (lifecycle_status = 'retired'
      AND sealed_by IS NOT NULL AND btrim(sealed_by) <> ''
      AND sealed_at IS NOT NULL
      AND retired_by IS NOT NULL AND btrim(retired_by) <> ''
      AND retired_at IS NOT NULL AND retired_at >= sealed_at
      AND superseded_by IS NULL AND superseded_at IS NULL
      AND supersession_reason IS NULL)
    OR (lifecycle_status = 'superseded'
      AND sealed_by IS NULL AND sealed_at IS NULL
      AND retired_by IS NULL AND retired_at IS NULL
      AND superseded_by IS NOT NULL AND btrim(superseded_by) <> ''
      AND superseded_at IS NOT NULL AND superseded_at >= created_at
      AND char_length(btrim(supersession_reason)) BETWEEN 1 AND 1000)
  );

CREATE OR REPLACE FUNCTION inventory.guard_transformation_model_supersession()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(918422, OLD.product_id);

  IF OLD.origin <> 'phase3_backfill' THEN
    RAISE EXCEPTION 'only Phase 3 backfill drafts may be superseded';
  END IF;

  IF (
    to_jsonb(NEW) - ARRAY[
      'lifecycle_status',
      'superseded_by',
      'superseded_at',
      'supersession_reason',
      'updated_at'
    ]
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY[
      'lifecycle_status',
      'superseded_by',
      'superseded_at',
      'supersession_reason',
      'updated_at'
    ]
  ) THEN
    RAISE EXCEPTION 'transformation model definition fields cannot change while superseding';
  END IF;

  IF NEW.superseded_by IS NULL OR btrim(NEW.superseded_by) = ''
     OR NEW.superseded_at IS NULL
     OR NEW.superseded_at < OLD.created_at
     OR NEW.supersession_reason IS NULL
     OR char_length(btrim(NEW.supersession_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'transformation model supersession evidence is incomplete';
  END IF;

  PERFORM 1
  FROM inventory.transformation_model_heads
  WHERE product_id = OLD.product_id
    AND draft_model_id = OLD.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only the current transformation model draft may be superseded';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER transformation_model_versions_lifecycle_guard
  ON inventory.transformation_model_versions;

CREATE TRIGGER transformation_model_versions_lifecycle_write_guard
BEFORE INSERT OR DELETE ON inventory.transformation_model_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_versioned_definition_update();

CREATE TRIGGER transformation_model_versions_lifecycle_update_guard
BEFORE UPDATE ON inventory.transformation_model_versions
FOR EACH ROW
WHEN (NOT (OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status = 'superseded'))
EXECUTE FUNCTION inventory.guard_versioned_definition_update();

CREATE TRIGGER transformation_model_versions_supersession_guard
BEFORE UPDATE ON inventory.transformation_model_versions
FOR EACH ROW
WHEN (OLD.lifecycle_status = 'draft' AND NEW.lifecycle_status = 'superseded')
EXECUTE FUNCTION inventory.guard_transformation_model_supersession();

CREATE OR REPLACE FUNCTION inventory.assert_transformation_model_supersession_coherence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.lifecycle_status = 'superseded' AND OLD.lifecycle_status = 'draft'
     AND NOT EXISTS (
       SELECT 1
       FROM inventory.transformation_model_versions AS successor
       JOIN inventory.transformation_model_heads AS head
         ON head.product_id = successor.product_id
        AND head.draft_model_id = successor.id
       WHERE successor.supersedes_model_id = NEW.id
         AND successor.product_id = NEW.product_id
         AND successor.version = NEW.version + 1
         AND successor.lifecycle_status = 'draft'
         AND successor.origin = 'phase3_backfill'
         AND successor.created_at >= NEW.superseded_at
     ) THEN
    RAISE EXCEPTION
      'superseded Phase 3 draft % requires a current Phase 3 successor',
      NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER transformation_model_supersession_coherence_guard
AFTER UPDATE ON inventory.transformation_model_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.assert_transformation_model_supersession_coherence();

COMMENT ON COLUMN inventory.transformation_model_versions.superseded_by IS
  'Operator who immutably closed a stale Phase 3 draft before creating its successor.';
COMMENT ON COLUMN inventory.transformation_model_versions.superseded_at IS
  'Time at which a stale Phase 3 draft was immutably superseded.';
COMMENT ON COLUMN inventory.transformation_model_versions.supersession_reason IS
  'Audited reason for replacing a stale Phase 3 draft; grants no runtime authority.';
