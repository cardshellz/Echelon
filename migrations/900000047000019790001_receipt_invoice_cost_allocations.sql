-- Explicit admin-reviewed financial coverage. No historical mapping is inferred.
ALTER TABLE procurement.purchase_order_lines
  ADD COLUMN receipt_costing_enabled integer NOT NULL DEFAULT 0 CHECK (receipt_costing_enabled IN (0,1));
CREATE TABLE procurement.receipt_invoice_cost_allocations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_order_line_id integer NOT NULL REFERENCES procurement.purchase_order_lines(id),
  receiving_line_id integer NOT NULL REFERENCES procurement.receiving_lines(id),
  invoice_line_id integer NOT NULL REFERENCES procurement.vendor_invoice_lines(id),
  receipt_start_piece bigint NOT NULL CHECK (receipt_start_piece >= 0),
  invoice_start_piece bigint NOT NULL CHECK (invoice_start_piece >= 0),
  pieces bigint NOT NULL CHECK (pieces > 0 AND pieces <= 9007199254740991),
  approved_by varchar NOT NULL REFERENCES identity.users(id),
  approved_at timestamptz NOT NULL,
  CONSTRAINT receipt_invoice_cost_receipt_interval_uidx UNIQUE(receiving_line_id,receipt_start_piece),
  CONSTRAINT receipt_invoice_cost_invoice_interval_uidx UNIQUE(invoice_line_id,invoice_start_piece),
  CHECK (receipt_start_piece + pieces <= 9007199254740991 AND invoice_start_piece + pieces <= 9007199254740991)
);
CREATE INDEX receipt_invoice_cost_purchase_idx ON procurement.receipt_invoice_cost_allocations(purchase_order_line_id);

-- Native range GiST operators avoid requiring an additional extension. These
-- constraints backstop the domain checks for concurrent/direct SQL writers.
ALTER TABLE procurement.receipt_invoice_cost_allocations ADD CONSTRAINT receipt_invoice_receipt_overlap_excl
  EXCLUDE USING gist (int8range(receiving_line_id::bigint,receiving_line_id::bigint+1,'[)') WITH &&,
    int8range(receipt_start_piece,receipt_start_piece+pieces,'[)') WITH &&);
ALTER TABLE procurement.receipt_invoice_cost_allocations ADD CONSTRAINT receipt_invoice_invoice_overlap_excl
  EXCLUDE USING gist (int8range(invoice_line_id::bigint,invoice_line_id::bigint+1,'[)') WITH &&,
    int8range(invoice_start_piece,invoice_start_piece+pieces,'[)') WITH &&);
