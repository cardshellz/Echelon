-- Empty, append-only audit storage. Applying this migration retires no work and
-- changes no stock, order, shipment, provider or runtime-authority record.
-- Deliberately NO triggers on OMS/WMS/inventory movement tables. Existing
-- owners consult exact retired identities at their processing boundaries.
CREATE TABLE inventory.cutover_history_batches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  authority_revision bigint NOT NULL CHECK (authority_revision > 0),
  configuration_run_id bigint REFERENCES inventory.availability_activation_runs(id),
  review_hash varchar(64) NOT NULL CHECK (review_hash ~ '^[a-f0-9]{64}$'),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result_hash varchar(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  source_payload jsonb NOT NULL,
  facts_payload jsonb NOT NULL,
  review_payload jsonb NOT NULL,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  idempotency_key varchar(120) NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  actor varchar(100) NOT NULL CHECK (btrim(actor) <> ''),
  reason varchar(1000) NOT NULL CHECK (btrim(reason) <> ''),
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);

CREATE TABLE inventory.cutover_history_retirements (
  batch_id bigint NOT NULL REFERENCES inventory.cutover_history_batches(id),
  kind text NOT NULL CHECK (kind IN ('receipt','shipment')),
  receipt_id bigint UNIQUE REFERENCES oms.channel_fulfillment_receipts(id),
  shipment_id integer UNIQUE REFERENCES wms.outbound_shipments(id),
  source_id bigint GENERATED ALWAYS AS (COALESCE(receipt_id,shipment_id::bigint)) STORED,
  decision_payload jsonb NOT NULL,
  source_items_hash varchar(64) NOT NULL CHECK (source_items_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (kind,source_id),
  CHECK ((kind='receipt' AND receipt_id IS NOT NULL AND shipment_id IS NULL)
      OR (kind='shipment' AND shipment_id IS NOT NULL AND receipt_id IS NULL))
);
CREATE INDEX cutover_history_retirements_batch_idx ON inventory.cutover_history_retirements(batch_id);
CREATE INDEX cutover_history_retirements_sources_idx ON inventory.cutover_history_retirements
  USING gin (decision_payload jsonb_path_ops);

-- These guards protect ONLY the two new audit tables. They do not freeze or
-- forbid later corrections to an original order, package, label or stock row.
CREATE FUNCTION inventory.guard_cutover_history_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch inventory.cutover_history_batches%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'CUTOVER_HISTORY_AUDIT_IMMUTABLE'; END IF;
  PERFORM inventory.assert_cutover_admission_fence_owner();
  IF TG_TABLE_NAME='cutover_history_batches' THEN
    IF NEW.created_xid <> pg_current_xact_id() OR NEW.occurred_at <> transaction_timestamp() THEN
      RAISE EXCEPTION 'CUTOVER_HISTORY_AUDIT_TRANSACTION_MISMATCH';
    END IF;
  ELSE
    SELECT * INTO STRICT batch FROM inventory.cutover_history_batches WHERE id=NEW.batch_id;
    IF batch.created_xid <> pg_current_xact_id()
      OR NEW.decision_payload->>'kind' IS DISTINCT FROM NEW.kind
      OR NEW.decision_payload->>'id' IS DISTINCT FROM COALESCE(NEW.receipt_id,NEW.shipment_id::bigint)::text
      OR NOT (batch.review_payload->'decisions' @> jsonb_build_array(NEW.decision_payload)) THEN
      RAISE EXCEPTION 'CUTOVER_HISTORY_AUDIT_MEMBERSHIP_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cutover_history_batch_audit BEFORE INSERT OR UPDATE OR DELETE ON inventory.cutover_history_batches
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_history_audit();
CREATE TRIGGER cutover_history_batch_truncate BEFORE TRUNCATE ON inventory.cutover_history_batches
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_cutover_history_audit();
CREATE TRIGGER cutover_history_retirement_audit BEFORE INSERT OR UPDATE OR DELETE ON inventory.cutover_history_retirements
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_history_audit();
CREATE TRIGGER cutover_history_retirement_truncate BEFORE TRUNCATE ON inventory.cutover_history_retirements
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_cutover_history_audit();

CREATE FUNCTION inventory.check_cutover_history_batch_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW.review_payload->'decisions') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.review_payload->'decisions')=0
    OR (SELECT count(*) FROM inventory.cutover_history_retirements WHERE batch_id=NEW.id)
        <> jsonb_array_length(NEW.review_payload->'decisions') THEN
    RAISE EXCEPTION 'CUTOVER_HISTORY_AUDIT_INCOMPLETE';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER cutover_history_batch_complete AFTER INSERT ON inventory.cutover_history_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory.check_cutover_history_batch_complete();
