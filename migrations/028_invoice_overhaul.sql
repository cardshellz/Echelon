-- 028_invoice_overhaul.sql
-- Vendor invoice system overhaul: line items, attachments, remove draft status, duplicate detection

-- 1. New table: vendor_invoice_lines
CREATE TABLE IF NOT EXISTS vendor_invoice_lines (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_invoice_id INTEGER NOT NULL REFERENCES vendor_invoices(id) ON DELETE CASCADE,
  purchase_order_line_id INTEGER REFERENCES purchase_order_lines(id) ON DELETE SET NULL,
  product_variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,
  line_number INTEGER NOT NULL,
  sku VARCHAR(100),
  product_name TEXT,
  description TEXT,
  qty_invoiced INTEGER NOT NULL,
  qty_ordered INTEGER,
  qty_received INTEGER,
  unit_cost_cents DOUBLE PRECISION NOT NULL,
  line_total_cents DOUBLE PRECISION NOT NULL,
  match_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- 2. New table: vendor_invoice_attachments (metadata only — files stored on disk)
CREATE TABLE IF NOT EXISTS vendor_invoice_attachments (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_invoice_id INTEGER NOT NULL REFERENCES vendor_invoices(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(100),
  file_size_bytes INTEGER,
  file_path TEXT NOT NULL,
  uploaded_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMP DEFAULT NOW() NOT NULL,
  notes TEXT
);

-- 3. Alter vendor_invoices: change default status from 'draft' to 'received'
ALTER TABLE vendor_invoices ALTER COLUMN status SET DEFAULT 'received';

-- 4. Update any existing 'draft' invoices to 'received'
UPDATE vendor_invoices SET status = 'received', received_date = COALESCE(received_date, created_at) WHERE status = 'draft';

-- 5. Add unique constraint: prevent duplicate invoice numbers per vendor
CREATE UNIQUE INDEX IF NOT EXISTS vendor_invoices_vendor_number_idx ON vendor_invoices(vendor_id, invoice_number);
