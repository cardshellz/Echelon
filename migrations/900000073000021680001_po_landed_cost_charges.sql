-- Support PO-scoped landed cost charges (freight, customs duty, tariff,
-- brokerage, insurance, drayage, etc.) so operators who receive a Purchase
-- Order directly without an upfront Inbound Shipment container can attach
-- carrier or customs bills before or weeks after dock receipt and automatically
-- revalue FIFO inventory lots, descendant package lots, and order COGS.

-- 1. Relax procurement.cost_source_revisions check constraint so component = 'landed'
--    is valid on BOTH shipment_line scope (inbound_shipment_line_id IS NOT NULL)
--    AND purchase_order_line scope (inbound_shipment_line_id IS NULL), while
--    still enforcing that shipment_line scope only records 'landed'.
DO $$
DECLARE
  existing_constraint record;
BEGIN
  FOR existing_constraint IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'procurement.cost_source_revisions'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%inbound_shipment_line_id%'
  LOOP
    EXECUTE format(
      'ALTER TABLE procurement.cost_source_revisions DROP CONSTRAINT IF EXISTS %I',
      existing_constraint.conname
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cost_source_revisions_scope_component_check'
      AND conrelid = 'procurement.cost_source_revisions'::regclass
  ) THEN
    ALTER TABLE procurement.cost_source_revisions
      ADD CONSTRAINT cost_source_revisions_scope_component_check
      CHECK ((inbound_shipment_line_id IS NULL) OR ((component)::text = 'landed'::text));
  END IF;
END $$;

-- 2. Create procurement.po_landed_costs for PO-direct freight, duty, tariff,
--    brokerage, insurance, and drayage charges.
CREATE TABLE IF NOT EXISTS procurement.po_landed_costs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_order_id integer NOT NULL REFERENCES procurement.purchase_orders(id) ON DELETE CASCADE,
  cost_type varchar(30) NOT NULL CHECK (
    cost_type IN (
      'freight',
      'duty',
      'tariff',
      'tax',
      'insurance',
      'brokerage',
      'platform_fee',
      'port_handling',
      'drayage',
      'warehousing',
      'inspection',
      'other'
    )
  ),
  description text,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency varchar(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  allocation_method varchar(30) NOT NULL DEFAULT 'by_value' CHECK (
    allocation_method IN ('by_value', 'by_quantity', 'by_line_count')
  ),
  vendor_id integer REFERENCES procurement.vendors(id) ON DELETE SET NULL,
  vendor_invoice_id integer REFERENCES procurement.vendor_invoices(id) ON DELETE SET NULL,
  invoice_number varchar(100),
  cost_date timestamptz,
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS po_landed_costs_po_idx
  ON procurement.po_landed_costs(purchase_order_id);

CREATE INDEX IF NOT EXISTS po_landed_costs_vendor_idx
  ON procurement.po_landed_costs(vendor_id);
