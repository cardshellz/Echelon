-- Rename shipment tables for clear inbound/outbound distinction
-- Part 1: Inbound (procurement/receiving)

ALTER TABLE shipment_cost_allocations RENAME TO inbound_freight_allocations;
ALTER TABLE shipment_costs RENAME TO inbound_freight_costs;

-- Update FK constraint names
ALTER TABLE inbound_freight_allocations 
  RENAME CONSTRAINT shipment_cost_allocations_shipment_cost_id_shipment_costs_id_fk 
  TO inbound_freight_allocations_cost_id_fk;

ALTER TABLE inbound_freight_allocations
  RENAME CONSTRAINT shipment_cost_allocations_inbound_shipment_line_id_inbound_shipme
  TO inbound_freight_allocations_line_id_fk;

-- Update index names
ALTER INDEX idx_shipment_costs_shipment RENAME TO idx_inbound_freight_costs_shipment;
ALTER INDEX idx_shipment_cost_alloc_cost RENAME TO idx_inbound_freight_alloc_cost;
ALTER INDEX idx_shipment_cost_alloc_line RENAME TO idx_inbound_freight_alloc_line;

-- Part 2: Outbound (customer fulfillment)

ALTER TABLE shipment_items RENAME TO outbound_shipment_items;
ALTER TABLE shipments RENAME TO outbound_shipments;

-- Update FK constraint names (shipment_items references shipments)
ALTER TABLE outbound_shipment_items
  RENAME CONSTRAINT shipment_items_shipment_id_shipments_id_fk
  TO outbound_shipment_items_shipment_id_fk;

-- Note: Other FK constraints will be renamed via Drizzle schema updates
