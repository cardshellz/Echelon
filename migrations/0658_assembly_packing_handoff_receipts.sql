-- Stock-neutral readiness receipts; never evidence of package close or dispatch.
CREATE TABLE IF NOT EXISTS warehouse.assembly_packing_handoff_receipts (
  command_id uuid PRIMARY KEY,
  work_item_id bigint NOT NULL REFERENCES warehouse.work_items(id) ON DELETE RESTRICT,
  order_id integer NOT NULL REFERENCES wms.orders(id) ON DELETE RESTRICT,
  actor_id varchar(100) NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  before_status varchar(30) NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS assembly_packing_handoff_order_idx
  ON warehouse.assembly_packing_handoff_receipts(order_id, occurred_at);
CREATE OR REPLACE FUNCTION warehouse.reject_assembly_packing_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Assembly packing handoff receipts are immutable' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS assembly_packing_receipt_immutable ON warehouse.assembly_packing_handoff_receipts;
CREATE TRIGGER assembly_packing_receipt_immutable BEFORE UPDATE OR DELETE
  ON warehouse.assembly_packing_handoff_receipts FOR EACH ROW
  EXECUTE FUNCTION warehouse.reject_assembly_packing_receipt_mutation();
