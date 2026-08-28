-- Phase 3 deterministic transformation backfill and review evidence.
--
-- This migration remains inactive by construction. It does not alter runtime ATP,
-- inventory, claims, reservations, builds, channel policy, provider quantities, or
-- publication behavior. Backfill provenance applies only to draft transformation
-- models and review evidence is append-only.

ALTER TABLE inventory.transformation_model_versions
  ADD COLUMN origin VARCHAR(30) NOT NULL DEFAULT 'operator',
  ADD COLUMN origin_input_hash VARCHAR(64),
  ADD COLUMN origin_result_hash VARCHAR(64),
  ADD CONSTRAINT transformation_model_versions_origin_chk CHECK (
    (origin = 'operator'
      AND origin_input_hash IS NULL
      AND origin_result_hash IS NULL)
    OR (origin = 'phase3_backfill'
      AND origin_input_hash IS NOT NULL
      AND origin_result_hash IS NOT NULL
      AND origin_input_hash ~ '^[0-9a-f]{64}$'
      AND origin_result_hash ~ '^[0-9a-f]{64}$')
  );

CREATE OR REPLACE FUNCTION inventory.guard_transformation_model_origin_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.origin_input_hash IS DISTINCT FROM OLD.origin_input_hash
     OR NEW.origin_result_hash IS DISTINCT FROM OLD.origin_result_hash THEN
    RAISE EXCEPTION 'transformation model origin evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transformation_model_versions_origin_guard
BEFORE UPDATE ON inventory.transformation_model_versions
FOR EACH ROW EXECUTE FUNCTION inventory.guard_transformation_model_origin_update();

CREATE UNIQUE INDEX transformation_model_versions_review_evidence_uq
  ON inventory.transformation_model_versions(id, product_id, version, definition_hash);

CREATE TABLE inventory.transformation_model_reviews (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  model_version INTEGER NOT NULL,
  model_definition_hash VARCHAR(64) NOT NULL,
  decision VARCHAR(30) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  reviewed_by VARCHAR(100) NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT transformation_model_reviews_model_fk
    FOREIGN KEY (model_id, product_id, model_version, model_definition_hash)
    REFERENCES inventory.transformation_model_versions(id, product_id, version, definition_hash)
    ON DELETE RESTRICT,
  CONSTRAINT transformation_model_reviews_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT transformation_model_reviews_decision_chk
    CHECK (decision IN ('approved', 'changes_required')),
  CONSTRAINT transformation_model_reviews_hash_chk CHECK (
    model_definition_hash ~ '^[0-9a-f]{64}$'
    AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT transformation_model_reviews_evidence_chk CHECK (
    model_version > 0
    AND char_length(btrim(reason)) BETWEEN 1 AND 1000
    AND char_length(btrim(reviewed_by)) BETWEEN 1 AND 100
    AND char_length(btrim(idempotency_key)) BETWEEN 1 AND 120
  )
);

CREATE INDEX transformation_model_reviews_product_lookup_idx
  ON inventory.transformation_model_reviews(product_id, reviewed_at DESC, id DESC);

CREATE INDEX transformation_model_reviews_definition_lookup_idx
  ON inventory.transformation_model_reviews(model_id, model_definition_hash, reviewed_at DESC, id DESC);

CREATE OR REPLACE FUNCTION inventory.guard_transformation_model_review_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
  FROM inventory.transformation_model_versions AS model
  JOIN inventory.transformation_model_heads AS head
    ON head.product_id = model.product_id
   AND head.draft_model_id = model.id
  WHERE model.id = NEW.model_id
    AND model.product_id = NEW.product_id
    AND model.version = NEW.model_version
    AND model.lifecycle_status = 'draft'
  FOR SHARE OF model, head;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transformation model review must reference the current draft';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transformation_model_reviews_current_draft_guard
BEFORE INSERT ON inventory.transformation_model_reviews
FOR EACH ROW EXECUTE FUNCTION inventory.guard_transformation_model_review_insert();

CREATE OR REPLACE FUNCTION inventory.guard_transformation_model_review_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'transformation model review evidence is append-only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transformation_model_reviews_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.transformation_model_reviews
FOR EACH ROW EXECUTE FUNCTION inventory.guard_transformation_model_review_write();

COMMENT ON TABLE inventory.transformation_model_reviews IS
  'Append-only Phase 3 review evidence bound to one exact draft model definition hash. It grants no runtime authority.';
