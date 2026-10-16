-- Financial reconciliation is distinct from stock-history acknowledgement.
-- The migration runner owns this transaction. No historical data is rewritten.
CREATE TABLE inventory.cost_reconciliation_approvals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inbound_shipment_line_id integer NOT NULL REFERENCES procurement.inbound_shipment_lines(id) ON DELETE RESTRICT,
  source_revision_id bigint NOT NULL,
  application_id bigint NOT NULL,
  evidence_fingerprint text NOT NULL CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  destination text NOT NULL CHECK (destination IN ('historical_cogs','inventory_variance')),
  actor_id text NOT NULL CHECK (length(btrim(actor_id)) BETWEEN 1 AND 200),
  actor_name text NOT NULL CHECK (length(btrim(actor_name)) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  recorded_at timestamptz NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  UNIQUE(id,inbound_shipment_line_id),
  FOREIGN KEY(source_revision_id,inbound_shipment_line_id) REFERENCES procurement.cost_source_revisions(id,inbound_shipment_line_id) ON DELETE RESTRICT,
  FOREIGN KEY(application_id,source_revision_id) REFERENCES inventory.cost_applications(id,source_revision_id) ON DELETE RESTRICT
);
CREATE INDEX cost_reconciliation_approval_latest ON inventory.cost_reconciliation_approvals(inbound_shipment_line_id,id DESC);

-- This is the historical cost subledger, not an acknowledgement table. Each
-- signed posting transfers an exact amount from unassigned shipment cost to
-- its approved expense destination. The opposite entry is stored explicitly.
CREATE TABLE inventory.cost_reconciliation_postings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inbound_shipment_line_id integer NOT NULL,
  approval_id bigint NOT NULL,
  source_revision_id bigint NOT NULL,
  application_id bigint NOT NULL,
  previous_posting_id bigint,
  destination text NOT NULL CHECK(destination IN ('historical_cogs','inventory_variance')),
  currency text NOT NULL CHECK(currency='USD'),
  before_mills bigint NOT NULL CHECK(before_mills BETWEEN 0 AND 9007199254740991),
  after_mills bigint NOT NULL CHECK(after_mills BETWEEN 0 AND 9007199254740991),
  delta_mills bigint NOT NULL CHECK(delta_mills BETWEEN -9007199254740991 AND 9007199254740991),
  unassigned_delta_mills bigint NOT NULL,
  actor_id text NOT NULL CHECK(length(btrim(actor_id)) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL,
  UNIQUE(id,inbound_shipment_line_id,destination),
  UNIQUE(application_id,destination),
  FOREIGN KEY(approval_id,inbound_shipment_line_id) REFERENCES inventory.cost_reconciliation_approvals(id,inbound_shipment_line_id) ON DELETE RESTRICT,
  FOREIGN KEY(source_revision_id,inbound_shipment_line_id) REFERENCES procurement.cost_source_revisions(id,inbound_shipment_line_id) ON DELETE RESTRICT,
  FOREIGN KEY(application_id,source_revision_id) REFERENCES inventory.cost_applications(id,source_revision_id) ON DELETE RESTRICT,
  FOREIGN KEY(previous_posting_id,inbound_shipment_line_id,destination) REFERENCES inventory.cost_reconciliation_postings(id,inbound_shipment_line_id,destination) ON DELETE RESTRICT,
  CHECK(after_mills::numeric-before_mills::numeric=delta_mills::numeric),
  CHECK(delta_mills::numeric+unassigned_delta_mills::numeric=0),
  CHECK(previous_posting_id IS NULL OR previous_posting_id<id)
);
CREATE UNIQUE INDEX cost_reconciliation_posting_chain ON inventory.cost_reconciliation_postings(inbound_shipment_line_id,destination,COALESCE(previous_posting_id,0));
CREATE INDEX cost_reconciliation_posting_latest ON inventory.cost_reconciliation_postings(inbound_shipment_line_id,destination,id DESC);
-- The unique predecessor index also rejects concurrent forks of the balance.
CREATE FUNCTION inventory.validate_cost_reconciliation_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_after bigint;
BEGIN
  IF NEW.previous_posting_id IS NULL THEN
    IF NEW.before_mills<>0 THEN RAISE EXCEPTION 'Initial reconciliation balance must be zero'; END IF;
  ELSE
    SELECT after_mills INTO STRICT prior_after FROM inventory.cost_reconciliation_postings
      WHERE id=NEW.previous_posting_id AND inbound_shipment_line_id=NEW.inbound_shipment_line_id AND destination=NEW.destination;
    IF NEW.before_mills<>prior_after THEN RAISE EXCEPTION 'Reconciliation balance does not continue its predecessor'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cost_reconciliation_posting_balance BEFORE INSERT ON inventory.cost_reconciliation_postings
  FOR EACH ROW EXECUTE FUNCTION inventory.validate_cost_reconciliation_posting();
CREATE TRIGGER cost_reconciliation_approval_immutable BEFORE UPDATE OR DELETE ON inventory.cost_reconciliation_approvals
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();
CREATE TRIGGER cost_reconciliation_posting_immutable BEFORE UPDATE OR DELETE ON inventory.cost_reconciliation_postings
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();
CREATE TRIGGER cost_reconciliation_approval_no_truncate BEFORE TRUNCATE ON inventory.cost_reconciliation_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();
CREATE TRIGGER cost_reconciliation_posting_no_truncate BEFORE TRUNCATE ON inventory.cost_reconciliation_postings
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();
