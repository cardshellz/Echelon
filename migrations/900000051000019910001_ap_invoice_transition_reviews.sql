-- This ledger retains reviewed AP authority changes, including invoices with no
-- PO link. Command receipts remain the retry owner; this is approval history.
CREATE TABLE procurement.ap_invoice_transition_reviews (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id integer NOT NULL REFERENCES procurement.vendor_invoices(id),
  actor_id varchar NOT NULL REFERENCES identity.users(id),
  actor_name text NOT NULL CHECK (length(btrim(actor_name)) BETWEEN 1 AND 200),
  action text NOT NULL CHECK (action IN ('approve','dispute','void')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  command_key text NOT NULL CHECK (length(command_key)>0),
  preview jsonb NOT NULL CHECK (jsonb_typeof(preview)='object'),
  authority jsonb NOT NULL CHECK (jsonb_typeof(authority)='object'),
  approved_at timestamptz NOT NULL,
  UNIQUE(invoice_id,actor_id,action,command_key),
  CHECK ((preview->>'invoiceId'=invoice_id::text AND preview->>'action'=action AND preview->>'reason'=reason) IS TRUE)
);
CREATE INDEX ap_invoice_transition_history_idx ON procurement.ap_invoice_transition_reviews(invoice_id,id DESC);
CREATE FUNCTION procurement.reject_ap_invoice_transition_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AP invoice transition approval history is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER ap_invoice_transition_history_immutable BEFORE UPDATE OR DELETE ON procurement.ap_invoice_transition_reviews
  FOR EACH ROW EXECUTE FUNCTION procurement.reject_ap_invoice_transition_history_mutation();
CREATE TRIGGER ap_invoice_transition_history_no_truncate BEFORE TRUNCATE ON procurement.ap_invoice_transition_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION procurement.reject_ap_invoice_transition_history_mutation();
