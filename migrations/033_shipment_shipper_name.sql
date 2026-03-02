-- Migration 033: Add shipper_name to inbound_shipments
-- The origin factory/supplier. Auto-populated from PO vendor when creating from a PO.

ALTER TABLE inbound_shipments
  ADD COLUMN IF NOT EXISTS shipper_name VARCHAR(200);
