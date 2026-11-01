-- Explicit tax policy. No historical amount, source, approval or tax eligibility
-- is inferred or backfilled. The ordinary cost owners apply approved changes.
CREATE TABLE procurement.purchase_tax_types (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code varchar(40) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name varchar(100) NOT NULL CHECK (length(btrim(name)) > 0),
  treatment varchar(20) NOT NULL CHECK (treatment IN ('inventory','recoverable')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  updated_by varchar NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT
);
ALTER TABLE procurement.purchase_orders ADD COLUMN tax_type_id integer REFERENCES procurement.purchase_tax_types(id) ON DELETE RESTRICT;
ALTER TABLE procurement.purchase_order_lines ADD COLUMN tax_type_id integer REFERENCES procurement.purchase_tax_types(id) ON DELETE RESTRICT;
ALTER TABLE procurement.inbound_freight_costs ADD COLUMN tax_type_id integer REFERENCES procurement.purchase_tax_types(id) ON DELETE RESTRICT;
ALTER TABLE procurement.landed_cost_snapshots ADD COLUMN recoverable_tax_allocated_cents bigint NOT NULL DEFAULT 0
  CHECK (recoverable_tax_allocated_cents >= 0);
CREATE TABLE procurement.vendor_invoice_line_taxes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_invoice_line_id integer NOT NULL REFERENCES procurement.vendor_invoice_lines(id) ON DELETE RESTRICT,
  tax_type_id integer NOT NULL REFERENCES procurement.purchase_tax_types(id) ON DELETE RESTRICT,
  amount_mills bigint NOT NULL CHECK (amount_mills >= 0 AND amount_mills % 100 = 0),
  CONSTRAINT vendor_invoice_line_taxes_source_uq UNIQUE(vendor_invoice_line_id,tax_type_id)
);
CREATE INDEX purchase_orders_tax_type_idx ON procurement.purchase_orders(tax_type_id) WHERE tax_type_id IS NOT NULL;
CREATE INDEX purchase_order_lines_tax_type_idx ON procurement.purchase_order_lines(tax_type_id) WHERE tax_type_id IS NOT NULL;
CREATE INDEX inbound_freight_costs_tax_type_idx ON procurement.inbound_freight_costs(tax_type_id) WHERE tax_type_id IS NOT NULL;
CREATE INDEX vendor_invoice_line_taxes_type_idx ON procurement.vendor_invoice_line_taxes(tax_type_id);
