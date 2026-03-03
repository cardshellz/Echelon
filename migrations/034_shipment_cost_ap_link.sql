-- Link shipment costs to AP system (vendor invoices + vendors)
-- All columns nullable — existing data unaffected

ALTER TABLE shipment_costs ADD COLUMN vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL;
ALTER TABLE shipment_costs ADD COLUMN vendor_invoice_id INTEGER REFERENCES vendor_invoices(id) ON DELETE SET NULL;

ALTER TABLE vendor_invoices ADD COLUMN inbound_shipment_id INTEGER REFERENCES inbound_shipments(id) ON DELETE SET NULL;

-- Best-effort backfill: match vendor_name to vendors.name (case-insensitive)
UPDATE shipment_costs sc
SET vendor_id = v.id
FROM vendors v
WHERE sc.vendor_id IS NULL
  AND sc.vendor_name IS NOT NULL
  AND LOWER(TRIM(sc.vendor_name)) = LOWER(TRIM(v.name));
