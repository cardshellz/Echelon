-- Durable, target-scoped readiness evidence for resuming a previously stopped
-- canonical inventory publication target. This does not activate a target.

CREATE TABLE inventory.inventory_publication_target_resume_reviews (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_target_id INTEGER NOT NULL
    REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  publication_target_revision BIGINT NOT NULL,
  authority_revision BIGINT NOT NULL,
  activation_run_id BIGINT NOT NULL
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  state VARCHAR(20) NOT NULL,
  configuration_hash VARCHAR(64) NOT NULL,
  readiness_hash VARCHAR(64) NOT NULL,
  evidence_hash VARCHAR(64) NOT NULL,
  evidence_payload JSONB NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  requested_by VARCHAR(100) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT inventory_publication_target_resume_reviews_idempotency_uq
    UNIQUE (idempotency_key),
  CONSTRAINT inventory_publication_target_resume_reviews_state_chk
    CHECK (state IN ('blocked', 'ready')),
  CONSTRAINT inventory_publication_target_resume_reviews_revision_chk
    CHECK (publication_target_revision > 0 AND authority_revision > 0),
  CONSTRAINT inventory_publication_target_resume_reviews_hash_chk
    CHECK (configuration_hash ~ '^[0-9a-f]{64}$'
      AND readiness_hash ~ '^[0-9a-f]{64}$'
      AND evidence_hash ~ '^[0-9a-f]{64}$'
      AND request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT inventory_publication_target_resume_reviews_payload_chk
    CHECK (jsonb_typeof(evidence_payload) = 'object'),
  CONSTRAINT inventory_publication_target_resume_reviews_idempotency_chk
    CHECK (idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''),
  CONSTRAINT inventory_publication_target_resume_reviews_actor_chk
    CHECK (requested_by = btrim(requested_by)
      AND char_length(requested_by) BETWEEN 1 AND 100
      AND reason = btrim(reason)
      AND char_length(reason) BETWEEN 1 AND 1000)
);

CREATE INDEX inventory_publication_target_resume_reviews_target_idx
  ON inventory.inventory_publication_target_resume_reviews(
    publication_target_id, publication_target_revision, captured_at DESC, id DESC
  );

CREATE TRIGGER inventory_publication_target_resume_reviews_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.inventory_publication_target_resume_reviews
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

COMMENT ON TABLE inventory.inventory_publication_target_resume_reviews IS
  'Append-only, exact-target canonical readiness evidence. A separate role-gated command must revalidate it before preview-to-live resume.';
