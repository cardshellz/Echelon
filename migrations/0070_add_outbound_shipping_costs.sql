-- Add shipping cost tracking to outbound shipments
-- For dropship vendor invoicing and profitability analysis

ALTER TABLE outbound_shipments 
ADD COLUMN IF NOT EXISTS carrier_cost_cents INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS dunnage_cost_cents INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_shipping_cost_cents INTEGER GENERATED ALWAYS AS (carrier_cost_cents + dunnage_cost_cents) STORED;

COMMENT ON COLUMN outbound_shipments.carrier_cost_cents IS 'Actual cost paid to carrier (FedEx/USPS/UPS)';
COMMENT ON COLUMN outbound_shipments.dunnage_cost_cents IS 'Packaging materials cost (boxes, bubble wrap, tape)';
COMMENT ON COLUMN outbound_shipments.total_shipping_cost_cents IS 'Total outbound shipping cost (carrier + dunnage)';

CREATE INDEX IF NOT EXISTS idx_outbound_shipments_costs ON outbound_shipments(carrier_cost_cents, dunnage_cost_cents);
