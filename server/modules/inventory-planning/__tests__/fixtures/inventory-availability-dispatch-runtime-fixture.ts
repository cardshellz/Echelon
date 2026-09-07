import { dispatchOwnerFixtureSql, dispatchOwnerSeedSql } from "../../../inventory/__tests__/fixtures/canonical-claim-dispatch";

/**
 * Connected real-query prerequisites for WMS source, claim repository and stock
 * owner. Actual migration0662 is applied separately. This deliberately does not
 * pretend to replay all historic core-table migrations or publication triggers.
 */
export const dispatchRuntimeFixtureSql = `${dispatchOwnerFixtureSql}
CREATE SCHEMA catalog;
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY);
ALTER TABLE wms.orders ADD COLUMN warehouse_id integer REFERENCES warehouse.warehouses,
  ADD COLUMN warehouse_status varchar(30) NOT NULL DEFAULT 'ready_to_ship', ADD COLUMN on_hold integer NOT NULL DEFAULT 0,
  ADD COLUMN cancelled_at timestamp;
ALTER TABLE wms.order_items ADD COLUMN product_id integer REFERENCES catalog.product_variants,
  ADD COLUMN status varchar(30) NOT NULL DEFAULT 'completed', ADD COLUMN on_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN requires_shipping integer NOT NULL DEFAULT 1;
ALTER TABLE wms.outbound_shipments ADD COLUMN order_id integer REFERENCES wms.orders,
  ADD COLUMN status varchar(30) NOT NULL DEFAULT 'shipped', ADD COLUMN held boolean NOT NULL DEFAULT false,
  ADD COLUMN requires_review boolean NOT NULL DEFAULT false, ADD COLUMN shipment_purpose varchar(30) NOT NULL DEFAULT 'customer_fulfillment',
  ADD COLUMN replaces_shipment_id integer, ADD COLUMN cancelled_at timestamp, ADD COLUMN voided_at timestamp;
ALTER TABLE wms.outbound_shipment_items ADD COLUMN order_item_id integer REFERENCES wms.order_items,
  ADD COLUMN product_variant_id integer REFERENCES catalog.product_variants, ADD COLUMN qty integer NOT NULL DEFAULT 5,
  ADD COLUMN from_location_id integer REFERENCES warehouse.warehouse_locations,
  ADD COLUMN shipment_item_purpose varchar(30) NOT NULL DEFAULT 'customer_fulfillment',
  ADD COLUMN replacement_for_order_item_id integer, ADD COLUMN correction_for_shipment_item_id integer,
  ADD COLUMN provider_membership_state varchar(30) NOT NULL DEFAULT 'authoritative';
CREATE TABLE wms.physical_shipments(id bigint PRIMARY KEY, status varchar(30) NOT NULL);
CREATE TABLE wms.physical_shipment_items(
  id bigint PRIMARY KEY, physical_shipment_id bigint NOT NULL REFERENCES wms.physical_shipments,
  legacy_wms_shipment_item_id integer REFERENCES wms.outbound_shipment_items,
  wms_order_item_id integer REFERENCES wms.order_items, product_variant_id integer REFERENCES catalog.product_variants,
  quantity_shipped integer NOT NULL, shipment_item_purpose varchar(30) NOT NULL DEFAULT 'customer_fulfillment',
  replacement_for_order_item_id integer, correction_for_physical_shipment_item_id bigint, package_allocation_entry_id bigint
);
CREATE TABLE wms.physical_shipment_item_quantity_adjustments(
  id bigint PRIMARY KEY, physical_shipment_item_id bigint NOT NULL REFERENCES wms.physical_shipment_items
);
CREATE TABLE inventory.availability_runtime_authority(
  singleton_key boolean PRIMARY KEY, authority varchar(20) NOT NULL, activation_run_id bigint, revision bigint NOT NULL
);
CREATE TABLE inventory.availability_claims(
  id bigint PRIMARY KEY, order_id integer NOT NULL REFERENCES wms.orders, status varchar(30) NOT NULL,
  UNIQUE(id,order_id)
);
CREATE TABLE inventory.availability_claim_lines(
  id bigint PRIMARY KEY, claim_id bigint NOT NULL REFERENCES inventory.availability_claims,
  order_item_id integer NOT NULL REFERENCES wms.order_items, target_variant_id integer NOT NULL REFERENCES catalog.product_variants,
  planned_qty bigint NOT NULL, released_target_qty bigint NOT NULL DEFAULT 0,
  consumed_target_qty bigint NOT NULL DEFAULT 0, picked_target_qty bigint NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now(), UNIQUE(id,claim_id), UNIQUE(claim_id,order_item_id)
);
CREATE TABLE inventory.availability_claim_resources(
  id bigint PRIMARY KEY, claim_id bigint NOT NULL REFERENCES inventory.availability_claims,
  claim_line_id bigint NOT NULL REFERENCES inventory.availability_claim_lines,
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses, warehouse_location_id integer NOT NULL REFERENCES warehouse.warehouse_locations,
  inventory_level_id integer NOT NULL REFERENCES inventory.inventory_levels, source_variant_id integer NOT NULL REFERENCES catalog.product_variants,
  consumer_operation_key varchar(300), producer_operation_key varchar(300), claimed_qty bigint NOT NULL,
  released_qty bigint NOT NULL DEFAULT 0, consumed_qty bigint NOT NULL DEFAULT 0, picked_qty bigint NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE inventory.availability_claim_lot_allocations(
  id bigint PRIMARY KEY, claim_id bigint NOT NULL REFERENCES inventory.availability_claims,
  claim_resource_id bigint NOT NULL REFERENCES inventory.availability_claim_resources, inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots,
  claimed_qty bigint NOT NULL, released_qty bigint NOT NULL DEFAULT 0, consumed_qty bigint NOT NULL DEFAULT 0,
  picked_qty bigint NOT NULL DEFAULT 0, updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE inventory.availability_claim_commands(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, claim_id bigint NOT NULL REFERENCES inventory.availability_claims,
  order_id integer NOT NULL REFERENCES wms.orders, command_type varchar(30) NOT NULL, idempotency_key varchar(120) NOT NULL,
  request_hash varchar(64) NOT NULL, result_hash varchar(64) NOT NULL, request_payload jsonb NOT NULL, result_payload jsonb NOT NULL,
  actor varchar(100) NOT NULL, reason text NOT NULL, occurred_at timestamptz NOT NULL,
  UNIQUE(id,claim_id), CONSTRAINT availability_claim_commands_idempotency_uq UNIQUE(idempotency_key),
  CONSTRAINT availability_claim_commands_type_chk CHECK(command_type IN ('pick','unpick'))
);
CREATE TABLE inventory.availability_claim_pick_movements(
  id bigint PRIMARY KEY, claim_id bigint NOT NULL REFERENCES inventory.availability_claims,
  claim_line_id bigint NOT NULL REFERENCES inventory.availability_claim_lines,
  claim_resource_id bigint NOT NULL REFERENCES inventory.availability_claim_resources,
  claim_lot_allocation_id bigint NOT NULL REFERENCES inventory.availability_claim_lot_allocations,
  inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots, order_item_cost_id integer NOT NULL REFERENCES oms.order_item_costs,
  movement_type varchar(20) NOT NULL, quantity bigint NOT NULL, reverses_pick_movement_id bigint,
  UNIQUE(id,claim_id,claim_line_id)
);
CREATE TABLE inventory.availability_claim_events(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, claim_id bigint NOT NULL REFERENCES inventory.availability_claims,
  event_type varchar(50) NOT NULL, from_status varchar(30), to_status varchar(30) NOT NULL, evidence_payload jsonb NOT NULL,
  evidence_hash varchar(64) NOT NULL, actor varchar(100) NOT NULL, reason text NOT NULL, occurred_at timestamptz NOT NULL
);
CREATE FUNCTION inventory.reject_availability_claim_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE=format('%s is append-only',TG_TABLE_NAME);
END; $$;
CREATE TRIGGER original_pick_immutable BEFORE UPDATE OR DELETE ON inventory.availability_claim_pick_movements
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER command_immutable BEFORE UPDATE OR DELETE ON inventory.availability_claim_commands
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
`;

export const dispatchRuntimeTables = [
  "inventory.availability_claim_dispatch_movements", "inventory.availability_claim_dispatch_receipts",
  "inventory.availability_claim_events", "inventory.availability_claim_commands", "inventory.availability_claim_pick_movements",
  "inventory.availability_claim_lot_allocations", "inventory.availability_claim_resources", "inventory.availability_claim_lines",
  "inventory.availability_claims", "inventory.availability_runtime_authority", "inventory.inventory_transactions",
  "oms.order_item_costs", "inventory.inventory_lots", "inventory.inventory_levels",
  "wms.physical_shipment_item_quantity_adjustments", "wms.physical_shipment_items", "wms.physical_shipments",
  "wms.outbound_shipment_items", "wms.outbound_shipments", "wms.order_items", "wms.orders",
  "warehouse.warehouse_locations", "warehouse.warehouses", "catalog.product_variants",
] as const;

export const dispatchRuntimeSeedSql = `
  TRUNCATE ${dispatchRuntimeTables.join(",")} RESTART IDENTITY;
  INSERT INTO catalog.product_variants VALUES(105);
  ${dispatchOwnerSeedSql}
  UPDATE wms.orders SET warehouse_id=1;
  UPDATE wms.order_items SET product_id=105;
  UPDATE wms.outbound_shipments SET order_id=70;
  UPDATE wms.outbound_shipment_items SET order_item_id=71,product_variant_id=105,from_location_id=50;
  INSERT INTO inventory.availability_runtime_authority VALUES(true,'canonical',1,1);
  INSERT INTO inventory.availability_claims VALUES(10,70,'active');
  INSERT INTO inventory.availability_claim_lines(id,claim_id,order_item_id,target_variant_id,planned_qty,picked_target_qty)
    VALUES(20,10,71,105,5,5);
  INSERT INTO inventory.availability_claim_resources(id,claim_id,claim_line_id,warehouse_id,warehouse_location_id,
    inventory_level_id,source_variant_id,claimed_qty,picked_qty) VALUES(30,10,20,1,50,60,105,5,5);
  INSERT INTO inventory.availability_claim_lot_allocations(id,claim_id,claim_resource_id,inventory_lot_id,claimed_qty,picked_qty)
    VALUES(40,10,30,401,3,3),(41,10,30,402,2,2);
  INSERT INTO inventory.availability_claim_pick_movements
    VALUES(50,10,20,30,40,401,301,'pick',3,NULL),(51,10,20,30,41,402,302,'pick',2,NULL);
`;
