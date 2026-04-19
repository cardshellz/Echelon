-- Require unique (vendor_id, invoice_number) to prevent duplicates and AP double-payments
CREATE UNIQUE INDEX IF NOT EXISTS vendor_invoices_vendor_invoice_idx 
ON procurement.vendor_invoices (vendor_id, invoice_number);
