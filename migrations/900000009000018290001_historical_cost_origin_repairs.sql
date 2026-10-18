-- Add supplier components to the existing historical-cost subledger. Existing
-- freight approvals/postings are unchanged; the migration runner owns the tx.
ALTER TABLE inventory.cost_reconciliation_approvals
  ALTER COLUMN inbound_shipment_line_id DROP NOT NULL,
  ADD COLUMN purchase_order_line_id integer REFERENCES procurement.purchase_order_lines(id),
  ADD COLUMN component text NOT NULL DEFAULT 'landed';
ALTER TABLE inventory.cost_reconciliation_postings
  ALTER COLUMN inbound_shipment_line_id DROP NOT NULL,
  ADD COLUMN purchase_order_line_id integer REFERENCES procurement.purchase_order_lines(id),
  ADD COLUMN component text NOT NULL DEFAULT 'landed';
ALTER TABLE procurement.cost_source_revisions ADD CONSTRAINT cost_revision_supplier_scope UNIQUE(id,purchase_order_line_id,component);
ALTER TABLE inventory.cost_reconciliation_approvals
  ADD CONSTRAINT reconciliation_approval_scope CHECK (
    (component='landed' AND inbound_shipment_line_id IS NOT NULL AND purchase_order_line_id IS NULL)
    OR (component IN ('product','packaging') AND inbound_shipment_line_id IS NULL AND purchase_order_line_id IS NOT NULL)),
  ADD CONSTRAINT reconciliation_approval_supplier_identity UNIQUE(id,purchase_order_line_id,component),
  ADD CONSTRAINT reconciliation_approval_supplier_source FOREIGN KEY(source_revision_id,purchase_order_line_id,component)
    REFERENCES procurement.cost_source_revisions(id,purchase_order_line_id,component);
ALTER TABLE inventory.cost_reconciliation_postings
  ADD CONSTRAINT reconciliation_posting_scope CHECK (
    (component='landed' AND inbound_shipment_line_id IS NOT NULL AND purchase_order_line_id IS NULL)
    OR (component IN ('product','packaging') AND inbound_shipment_line_id IS NULL AND purchase_order_line_id IS NOT NULL)),
  ADD CONSTRAINT reconciliation_posting_supplier_identity UNIQUE(id,purchase_order_line_id,component,destination),
  ADD CONSTRAINT reconciliation_posting_supplier_approval FOREIGN KEY(approval_id,purchase_order_line_id,component)
    REFERENCES inventory.cost_reconciliation_approvals(id,purchase_order_line_id,component),
  ADD CONSTRAINT reconciliation_posting_supplier_source FOREIGN KEY(source_revision_id,purchase_order_line_id,component)
    REFERENCES procurement.cost_source_revisions(id,purchase_order_line_id,component),
  ADD CONSTRAINT reconciliation_posting_supplier_predecessor FOREIGN KEY(previous_posting_id,purchase_order_line_id,component,destination)
    REFERENCES inventory.cost_reconciliation_postings(id,purchase_order_line_id,component,destination);
CREATE INDEX reconciliation_supplier_approval_latest ON inventory.cost_reconciliation_approvals(purchase_order_line_id,component,id DESC) WHERE purchase_order_line_id IS NOT NULL;
CREATE UNIQUE INDEX reconciliation_supplier_posting_chain ON inventory.cost_reconciliation_postings(purchase_order_line_id,component,destination,COALESCE(previous_posting_id,0)) WHERE purchase_order_line_id IS NOT NULL;
CREATE OR REPLACE FUNCTION inventory.validate_cost_reconciliation_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_after bigint;
BEGIN
  IF NEW.previous_posting_id IS NULL THEN
    IF NEW.before_mills<>0 THEN RAISE EXCEPTION 'Initial reconciliation balance must be zero'; END IF;
  ELSE
    SELECT after_mills INTO STRICT prior_after FROM inventory.cost_reconciliation_postings
    WHERE id=NEW.previous_posting_id AND destination=NEW.destination AND component=NEW.component
      AND inbound_shipment_line_id IS NOT DISTINCT FROM NEW.inbound_shipment_line_id
      AND purchase_order_line_id IS NOT DISTINCT FROM NEW.purchase_order_line_id;
    IF NEW.before_mills<>prior_after THEN RAISE EXCEPTION 'Reconciliation balance does not continue its predecessor'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- A repair is an explicit administrator reconstruction, not an assertion that
-- missing fields were captured at receipt time. Preserve all original evidence.
CREATE TABLE inventory.cost_origin_repairs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventory_lot_id integer NOT NULL UNIQUE REFERENCES inventory.inventory_lots(id),
  receiving_line_id integer NOT NULL REFERENCES procurement.receiving_lines(id),
  purchase_order_line_id integer NOT NULL REFERENCES procurement.purchase_order_lines(id),
  source_version text NOT NULL CHECK(source_version ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL CHECK(length(btrim(actor_id)) BETWEEN 1 AND 200),
  actor_name text NOT NULL CHECK(length(btrim(actor_name)) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
  recorded_at timestamptz NOT NULL,
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object')
);
CREATE TRIGGER cost_origin_repair_immutable BEFORE UPDATE OR DELETE ON inventory.cost_origin_repairs
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();
CREATE TRIGGER cost_origin_repair_no_truncate BEFORE TRUNCATE ON inventory.cost_origin_repairs
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();
