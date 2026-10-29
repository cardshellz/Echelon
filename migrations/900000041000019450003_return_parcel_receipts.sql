CREATE TABLE returns.customer_return_parcel_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parcel_id BIGINT NOT NULL REFERENCES returns.customer_return_parcels(id),
  idempotency_key UUID NOT NULL UNIQUE,
  request_hash VARCHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response JSONB NOT NULL CHECK (jsonb_typeof(response)='object'),
  actor VARCHAR(255) NOT NULL CHECK (btrim(actor)<>''),
  notes VARCHAR(2000), received_at TIMESTAMPTZ NOT NULL,
  UNIQUE(id,parcel_id)
);
CREATE TABLE returns.customer_return_parcel_receipt_allocations (
  receipt_id BIGINT NOT NULL,
  parcel_id BIGINT NOT NULL,
  allocation_id BIGINT NOT NULL REFERENCES returns.customer_return_authorization_allocations(id),
  case_item_id BIGINT NOT NULL REFERENCES returns.return_case_items(id),
  quantity INTEGER NOT NULL CHECK (quantity>0),
  PRIMARY KEY(receipt_id,allocation_id),
  FOREIGN KEY(receipt_id,parcel_id) REFERENCES returns.customer_return_parcel_receipts(id,parcel_id)
);
CREATE INDEX customer_return_parcel_receipt_allocations_parcel_idx ON returns.customer_return_parcel_receipt_allocations(parcel_id);
CREATE INDEX customer_return_parcel_receipt_allocations_source_idx ON returns.customer_return_parcel_receipt_allocations(allocation_id);
CREATE INDEX customer_return_succeeded_label_tracking_idx ON returns.customer_return_label_attempts
  ((UPPER(regexp_replace(result_snapshot->>'trackingNumber','[^a-zA-Z0-9]','','g')))) WHERE status='succeeded';

CREATE FUNCTION returns.guard_customer_return_parcel_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt_key BIGINT; root_id BIGINT;
BEGIN
  IF TG_TABLE_NAME='customer_return_parcel_receipts' THEN receipt_key:=NEW.id; ELSE receipt_key:=NEW.receipt_id; END IF;
  SELECT p.authorization_id INTO STRICT root_id FROM returns.customer_return_parcels p
    JOIN returns.customer_return_parcel_receipts r ON r.parcel_id=p.id WHERE r.id=receipt_key;
  IF NOT EXISTS(SELECT 1 FROM returns.customer_return_parcel_receipt_allocations WHERE receipt_id=receipt_key)
    OR NOT EXISTS (SELECT 1 FROM returns.customer_return_parcel_receipts r
      JOIN returns.customer_return_label_attempts label ON label.parcel_id=r.parcel_id AND label.status='succeeded'
      WHERE r.id=receipt_key)
    OR EXISTS (
      SELECT 1 FROM returns.customer_return_parcel_receipt_allocations r
      JOIN returns.customer_return_parcels p ON p.id=r.parcel_id
      JOIN returns.customer_return_authorization_allocations a ON a.id=r.allocation_id
      LEFT JOIN returns.customer_return_parcel_items manifest ON manifest.parcel_id=p.id AND manifest.authorization_line_id=a.authorization_line_id
      LEFT JOIN returns.customer_return_allocation_case_items ci ON ci.authorization_allocation_id=a.id
      WHERE r.receipt_id=receipt_key AND (a.authorization_id<>p.authorization_id OR manifest.parcel_id IS NULL
        OR ci.case_item_id IS DISTINCT FROM r.case_item_id)
    ) OR EXISTS (
      SELECT 1 FROM returns.customer_return_parcel_receipt_allocations r
      JOIN returns.customer_return_authorization_allocations a ON a.id=r.allocation_id
      WHERE a.authorization_id=root_id GROUP BY a.id,a.quantity HAVING sum(r.quantity)>a.quantity
    ) OR EXISTS (
      SELECT 1 FROM returns.customer_return_parcel_receipt_allocations r
      JOIN returns.customer_return_authorization_allocations a ON a.id=r.allocation_id
      JOIN returns.customer_return_parcel_items manifest ON manifest.parcel_id=r.parcel_id AND manifest.authorization_line_id=a.authorization_line_id
      WHERE a.authorization_id=root_id GROUP BY r.parcel_id,a.authorization_line_id,manifest.quantity HAVING sum(r.quantity)>manifest.quantity
    ) OR EXISTS (
      SELECT 1 FROM returns.customer_return_parcel_receipt_allocations r
      JOIN returns.return_case_items ci ON ci.id=r.case_item_id
      JOIN wms.return_items wi ON wi.id=ci.wms_return_item_id
      JOIN returns.customer_return_authorization_allocations a ON a.id=r.allocation_id
      WHERE a.authorization_id=root_id GROUP BY ci.id,wi.received_qty HAVING sum(r.quantity)<>wi.received_qty
    ) THEN
    RAISE EXCEPTION 'Return box receipt provenance or quantity mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER customer_return_parcel_receipts_complete AFTER INSERT ON returns.customer_return_parcel_receipts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_parcel_receipt();
CREATE CONSTRAINT TRIGGER customer_return_parcel_receipt_allocations_complete AFTER INSERT ON returns.customer_return_parcel_receipt_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_parcel_receipt();
CREATE TRIGGER customer_return_parcel_receipts_immutable BEFORE UPDATE OR DELETE ON returns.customer_return_parcel_receipts
FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation();
CREATE TRIGGER customer_return_parcel_receipt_allocations_immutable BEFORE UPDATE OR DELETE ON returns.customer_return_parcel_receipt_allocations
FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation();
