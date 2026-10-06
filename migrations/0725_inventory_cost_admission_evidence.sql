-- Metadata only: do not infer provenance or rewrite historical prices/quantities.
-- The release executor owns the transaction, including its migration record.

ALTER TABLE inventory.inventory_lots
  ADD COLUMN IF NOT EXISTS cost_precision_version integer NOT NULL DEFAULT 0
    CHECK (cost_precision_version IN (0,1));

CREATE TABLE inventory.lot_cost_follow_ups (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  related_lot_id integer REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  operation_key text NOT NULL CHECK (btrim(operation_key) <> ''),
  issue_code text NOT NULL CHECK (btrim(issue_code) <> ''),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  fingerprint varchar(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX lot_cost_follow_up_identity ON inventory.lot_cost_follow_ups
  (operation_key,inventory_lot_id,COALESCE(related_lot_id,0),issue_code);
CREATE INDEX lot_cost_follow_up_lot ON inventory.lot_cost_follow_ups(inventory_lot_id,id);

CREATE TABLE inventory.lot_cost_follow_up_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  follow_up_id bigint NOT NULL REFERENCES inventory.lot_cost_follow_ups(id) ON DELETE RESTRICT,
  application_id bigint NOT NULL REFERENCES inventory.cost_applications(id) ON DELETE RESTRICT,
  state varchar(20) NOT NULL CHECK (state IN ('resolved','review_required','retry_required')),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL,
  UNIQUE(follow_up_id,application_id)
);

CREATE TRIGGER cost_evidence_immutable BEFORE UPDATE OR DELETE ON inventory.lot_cost_follow_ups
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();
CREATE TRIGGER cost_evidence_immutable BEFORE UPDATE OR DELETE ON inventory.lot_cost_follow_up_attempts
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();
