-- Migration 068: Add freight_cost_id FK to vendor_invoice_lines
-- Links invoice lines back to specific shipment cost rows for reconciliation.
-- Idempotent: uses IF NOT EXISTS guards.
-- Naming convention: follows 067_* sequence for the 0XX series.

ALTER TABLE procurement.vendor_invoice_lines
  ADD COLUMN IF NOT EXISTS freight_cost_id integer
    REFERENCES procurement.inbound_freight_costs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS vendor_invoice_lines_freight_cost_id_idx
  ON procurement.vendor_invoice_lines(freight_cost_id)
  WHERE freight_cost_id IS NOT NULL;
