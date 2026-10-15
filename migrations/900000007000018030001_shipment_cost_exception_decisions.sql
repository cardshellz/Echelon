-- Administrator review decisions are separate from immutable cost applications.
-- The release executor owns this transaction. No historical backfill is made.
CREATE UNIQUE INDEX IF NOT EXISTS shipment_exception_line_identity_idx
  ON procurement.inbound_shipment_lines(id,inbound_shipment_id);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_exception_source_identity_idx
  ON procurement.cost_source_revisions(id,inbound_shipment_line_id);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_exception_application_identity_idx
  ON inventory.cost_applications(id,source_revision_id);

CREATE TABLE procurement.shipment_cost_exception_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inbound_shipment_id integer NOT NULL,
  inbound_shipment_line_id integer NOT NULL,
  source_revision_id bigint NOT NULL,
  application_id bigint NOT NULL,
  previous_decision_id bigint,
  exception_fingerprint varchar(64) NOT NULL CHECK (exception_fingerprint ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('accept','reopen')),
  amount_mills bigint NOT NULL CHECK (amount_mills BETWEEN 0 AND 9007199254740991),
  currency varchar(3) NOT NULL CHECK (currency = 'USD'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  actor_id text NOT NULL CHECK (length(btrim(actor_id)) BETWEEN 1 AND 200),
  actor_name text NOT NULL CHECK (length(btrim(actor_name)) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  UNIQUE (id,inbound_shipment_line_id),
  FOREIGN KEY (inbound_shipment_line_id,inbound_shipment_id)
    REFERENCES procurement.inbound_shipment_lines(id,inbound_shipment_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_revision_id,inbound_shipment_line_id)
    REFERENCES procurement.cost_source_revisions(id,inbound_shipment_line_id) ON DELETE RESTRICT,
  FOREIGN KEY (application_id,source_revision_id)
    REFERENCES inventory.cost_applications(id,source_revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (previous_decision_id,inbound_shipment_line_id)
    REFERENCES procurement.shipment_cost_exception_decisions(id,inbound_shipment_line_id) ON DELETE RESTRICT,
  CHECK (previous_decision_id IS NULL OR previous_decision_id < id),
  CHECK (action <> 'reopen' OR previous_decision_id IS NOT NULL)
);
-- A line has one append-only chain: even two independent request keys cannot
-- accept the same reviewed state concurrently or fork an earlier decision.
CREATE UNIQUE INDEX shipment_cost_exception_decision_chain_idx
  ON procurement.shipment_cost_exception_decisions(inbound_shipment_line_id,COALESCE(previous_decision_id,0));
CREATE INDEX shipment_cost_exception_latest_idx
  ON procurement.shipment_cost_exception_decisions(inbound_shipment_line_id,id DESC);
CREATE TRIGGER shipment_cost_exception_immutable BEFORE UPDATE OR DELETE
  ON procurement.shipment_cost_exception_decisions FOR EACH ROW
  EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();
