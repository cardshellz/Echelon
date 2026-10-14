-- Exact shipment allocation evidence. Existing numeric basis and unit-cost
-- columns remain compatibility/display mirrors; no historic allocation or
-- inventory valuation is rewritten by this migration.
ALTER TABLE procurement.inbound_freight_allocations
  ADD COLUMN IF NOT EXISTS basis_evidence jsonb;
ALTER TABLE procurement.landed_cost_snapshots
  ADD COLUMN IF NOT EXISTS product_value_evidence jsonb;

ALTER TABLE procurement.inbound_freight_allocations
  ADD CONSTRAINT inbound_freight_allocation_basis_evidence_v2
  CHECK (basis_evidence IS NULL OR COALESCE(
    jsonb_typeof(basis_evidence) = 'object'
    AND basis_evidence->'version' = '2'::jsonb,
    false));
ALTER TABLE procurement.landed_cost_snapshots
  ADD CONSTRAINT landed_cost_snapshot_product_value_evidence_v2
  CHECK (product_value_evidence IS NULL OR COALESCE(
    jsonb_typeof(product_value_evidence) = 'object'
    AND product_value_evidence->'version' = '2'::jsonb,
    false));
