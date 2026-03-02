-- Migration 030: Add shipment-level gross fields (from BOL/carrier docs)
-- Net weight/volume are computed from lines; gross weight/volume/pallets are user-entered at shipment level.

ALTER TABLE inbound_shipments
  ADD COLUMN IF NOT EXISTS gross_weight_kg NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS pallet_count INTEGER;
