/**
 * Reduced columns used by the shipment-quantity reader. This proves real query
 * execution, not the production dispatch migration's constraints or triggers.
 */
export const shipmentQuantityEvidenceFixtureSql = `
  CREATE TABLE inventory.availability_claim_dispatch_receipts (
    id bigint PRIMARY KEY,
    inventory_transaction_id integer NOT NULL UNIQUE,
    claim_id bigint NOT NULL,
    claim_line_id bigint NOT NULL,
    quantity bigint NOT NULL,
    order_id integer NOT NULL,
    order_item_id integer NOT NULL,
    outbound_shipment_id integer NOT NULL,
    source_shipment_item_id integer NOT NULL,
    product_variant_id integer NOT NULL,
    warehouse_location_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    physical_shipment_id bigint,
    physical_shipment_item_id bigint
  );
  CREATE TABLE inventory.availability_claim_pick_movements (
    id bigint PRIMARY KEY,
    claim_id bigint NOT NULL,
    claim_line_id bigint NOT NULL,
    quantity bigint NOT NULL,
    movement_type varchar(30) NOT NULL
  );
  CREATE TABLE inventory.availability_claim_dispatch_movements (
    id bigint PRIMARY KEY,
    receipt_id bigint NOT NULL,
    pick_movement_id bigint NOT NULL,
    claim_id bigint NOT NULL,
    claim_line_id bigint NOT NULL,
    quantity bigint NOT NULL
  );
`;
