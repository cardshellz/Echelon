-- COGS: add packaging_cost_cents to inventory_lots for cost component breakdown.
-- total_unit_cost_cents = po_unit_cost_cents + packaging_cost_cents + landed_cost_cents

ALTER TABLE inventory.inventory_lots
  ADD COLUMN IF NOT EXISTS packaging_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0;
