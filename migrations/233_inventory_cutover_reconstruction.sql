BEGIN;

ALTER TABLE inventory.availability_claim_commands DROP CONSTRAINT availability_claim_commands_type_chk;
ALTER TABLE inventory.availability_claim_commands ADD CONSTRAINT availability_claim_commands_type_chk CHECK (
  command_type IN ('claim','replace','release','cancel','execute','handoff_build','execute_build',
    'pick','pick_observation','unpick','dispatch','cutover_adopt')
);

CREATE TABLE inventory.availability_cutover_reconstruction_receipts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activation_run_id bigint NOT NULL UNIQUE REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  evidence_hash varchar(64) NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  impact_hash varchar(64) NOT NULL CHECK (impact_hash ~ '^[0-9a-f]{64}$'),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_hash varchar(64) NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  result_payload jsonb NOT NULL CHECK (jsonb_typeof(result_payload)='object'),
  evidence_payload jsonb NOT NULL CHECK (jsonb_typeof(evidence_payload)='object'),
  actor varchar(100) NOT NULL CHECK (btrim(actor)<>''),
  reason varchar(1000) NOT NULL CHECK (btrim(reason)<>''),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER availability_cutover_reconstruction_receipts_append_only
BEFORE UPDATE OR DELETE ON inventory.availability_cutover_reconstruction_receipts
FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

CREATE TABLE inventory.availability_cutover_pick_sources (
  order_item_cost_id integer PRIMARY KEY REFERENCES oms.order_item_costs(id) ON DELETE RESTRICT,
  pick_movement_id bigint NOT NULL UNIQUE REFERENCES inventory.availability_claim_pick_movements(id) ON DELETE RESTRICT,
  activation_run_id bigint NOT NULL REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  evidence_hash varchar(64) NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  original_cost_payload jsonb NOT NULL CHECK (jsonb_typeof(original_cost_payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER availability_cutover_pick_sources_append_only
BEFORE UPDATE OR DELETE ON inventory.availability_cutover_pick_sources
FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

COMMENT ON TABLE inventory.availability_cutover_pick_sources IS
  'One-time reviewed adoption of extant original pick COGS. Does not create a physical movement, change stock, or rewrite historical COGS.';

COMMIT;
