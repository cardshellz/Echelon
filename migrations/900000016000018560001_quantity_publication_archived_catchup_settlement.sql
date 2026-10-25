-- Local archive disposition, not provider delivery or remote listing retirement.
-- Preserve one immutable receipt per settled catch-up revision, even when a
-- later source event reuses that catch-up row with a newer revision.
CREATE TABLE inventory.quantity_publication_catchup_settlements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catchup_id bigint NOT NULL REFERENCES inventory.quantity_publication_catchup(id),
  revision bigint NOT NULL CHECK (revision > 0),
  attempt_boundary_id bigint NOT NULL CHECK (attempt_boundary_id >= 0),
  scope_key text NOT NULL CHECK (scope_key ~ '^[a-f0-9]{64}$'),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope)='object'),
  basis text NOT NULL CHECK (basis='catalog_archived'),
  actor text NOT NULL CHECK (length(trim(actor)) BETWEEN 1 AND 200),
  selection_fingerprint text NOT NULL CHECK (selection_fingerprint ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state)='object'),
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state)='object'),
  occurred_at timestamptz NOT NULL,
  UNIQUE(catchup_id,revision),
  CHECK (((before_state->>'id')::bigint=catchup_id AND (after_state->>'id')::bigint=catchup_id
    AND (before_state->>'revision')::bigint=revision AND (after_state->>'revision')::bigint=revision
    AND (before_state->>'completed_revision')::bigint<revision AND (after_state->>'completed_revision')::bigint=revision
    AND (before_state->>'attempt_boundary_id')::bigint=attempt_boundary_id
    AND (after_state->>'attempt_boundary_id')::bigint=attempt_boundary_id
    AND before_state->>'scope_key'=scope_key AND after_state->>'scope_key'=scope_key
    AND before_state->'scope'=scope AND after_state->'scope'=scope) IS TRUE)
);
CREATE FUNCTION inventory.guard_quantity_catchup_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'QUANTITY_CATCHUP_SETTLEMENT_IMMUTABLE' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER quantity_catchup_settlement_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON inventory.quantity_publication_catchup_settlements FOR EACH STATEMENT
  EXECUTE FUNCTION inventory.guard_quantity_catchup_settlement();
