import type { CanonicalClaimDispatchPlan } from "../../../../../shared/types/inventory-availability-dispatch";
import { canonicalClaimDispatchCommandHash } from "../../../inventory-planning/domain/inventory-availability-dispatch";

export const DISPATCH_TIME = new Date("2026-09-07T18:00:00.000Z");

export function dispatchPlan(): CanonicalClaimDispatchPlan {
  const command = { claimId: "10", orderId: 70, orderItemId: 71, warehouseId: 1,
    warehouseLocationId: 50, productVariantId: 105, outboundShipmentId: 90, sourceShipmentItemId: 101,
    physicalShipmentId: null, physicalShipmentItemId: null, quantity: "5",
    idempotencyKey: "dispatch:90:101", actor: "shipping-worker", reason: "Confirmed source dispatch" };
  return {
    contractVersion: "canonical_claim_dispatch_plan_v1", command, commandHash: canonicalClaimDispatchCommandHash(command),
    claimLineId: "20", quantity: "5", pickedTargetQtyBefore: "5", pickedTargetQtyAfter: "0",
    consumedTargetQtyBefore: "0", consumedTargetQtyAfter: "5", sourceRemainingQuantity: "0",
    sourceDispositionAfter: "fully_dispatched", physicalOnHandDelta: "0", reservedQuantityDelta: "0",
    createsPick: false, createsCogs: false,
    resources: [{ claimResourceId: "30", warehouseId: 1, warehouseLocationId: 50, inventoryLevelId: 60,
      sourceVariantId: 105, quantity: "5", pickedQtyBefore: "5", pickedQtyAfter: "0", consumedQtyBefore: "0", consumedQtyAfter: "5",
      lots: [
        { claimLotAllocationId: "40", inventoryLotId: 401, quantity: "3", pickedQtyBefore: "3", pickedQtyAfter: "0", consumedQtyBefore: "0", consumedQtyAfter: "3",
          picks: [{ pickMovementId: "50", orderItemCostId: 301, quantity: "3", unitCostMills: "100" }] },
        { claimLotAllocationId: "41", inventoryLotId: 402, quantity: "2", pickedQtyBefore: "2", pickedQtyAfter: "0", consumedQtyBefore: "0", consumedQtyAfter: "2",
          picks: [{ pickMovementId: "51", orderItemCostId: 302, quantity: "2", unitCostMills: "200" }] },
      ] }],
  };
}

export function dispatchCosts() {
  return [
    { id: 301, orderId: 70, orderItemId: 71, productVariantId: 105, inventoryLotId: 401, quantity: "3", unitCostMills: "100", totalCostMills: "300" },
    { id: 302, orderId: 70, orderItemId: 71, productVariantId: 105, inventoryLotId: 402, quantity: "2", unitCostMills: "200", totalCostMills: "400" },
  ];
}

/** Reduced real-column owner fixture; not a proof of every production migration or publication trigger. */
export const dispatchOwnerFixtureSql = `
  CREATE SCHEMA inventory; CREATE SCHEMA oms; CREATE SCHEMA wms; CREATE SCHEMA warehouse;
  CREATE TABLE warehouse.warehouses(id integer PRIMARY KEY);
  CREATE TABLE warehouse.warehouse_locations(id integer PRIMARY KEY, warehouse_id integer NOT NULL REFERENCES warehouse.warehouses);
  CREATE TABLE wms.orders(id integer PRIMARY KEY);
  CREATE TABLE wms.order_items(id integer PRIMARY KEY, order_id integer NOT NULL REFERENCES wms.orders);
  CREATE TABLE wms.outbound_shipments(id integer PRIMARY KEY);
  CREATE TABLE wms.outbound_shipment_items(id integer PRIMARY KEY, shipment_id integer NOT NULL REFERENCES wms.outbound_shipments);
  CREATE TABLE inventory.inventory_levels (
    id integer PRIMARY KEY, warehouse_location_id integer NOT NULL, product_variant_id integer NOT NULL,
    variant_qty integer NOT NULL CHECK(variant_qty>=0), reserved_qty integer NOT NULL CHECK(reserved_qty>=0 AND reserved_qty<=variant_qty),
    picked_qty integer NOT NULL CHECK(picked_qty>=0), packed_qty integer NOT NULL DEFAULT 0,
    backorder_qty integer NOT NULL DEFAULT 0, updated_at timestamp NOT NULL,
    UNIQUE(product_variant_id,warehouse_location_id)
  );
  CREATE TABLE inventory.inventory_lots (
    id integer PRIMARY KEY, warehouse_location_id integer NOT NULL, product_variant_id integer NOT NULL,
    qty_on_hand integer NOT NULL CHECK(qty_on_hand>=0), qty_reserved integer NOT NULL CHECK(qty_reserved>=0 AND qty_reserved<=qty_on_hand),
    qty_picked integer NOT NULL CHECK(qty_picked>=0), qty_consumed integer NOT NULL DEFAULT 0,
    status varchar(20) NOT NULL, received_at timestamp NOT NULL,
    unit_cost_mills bigint NOT NULL, total_unit_cost_mills bigint NOT NULL
  );
  CREATE TABLE oms.order_item_costs (
    id integer PRIMARY KEY, order_id integer NOT NULL REFERENCES wms.orders,
    order_item_id integer NOT NULL REFERENCES wms.order_items,
    product_variant_id integer NOT NULL, inventory_lot_id integer NOT NULL,
    qty integer NOT NULL, unit_cost_cents bigint NOT NULL, total_cost_cents bigint NOT NULL,
    unit_cost_mills bigint NOT NULL, total_cost_mills bigint NOT NULL, created_at timestamp NOT NULL
  );
  CREATE TABLE inventory.inventory_transactions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_variant_id integer, from_location_id integer, to_location_id integer,
    transaction_type varchar(30) NOT NULL, variant_qty_delta integer NOT NULL DEFAULT 0,
    variant_qty_before integer, variant_qty_after integer, reserved_qty_delta integer,
    source_state varchar(20), target_state varchar(20), unit_cost_cents bigint,
    unit_cost_mills bigint, total_cost_mills bigint, inventory_lot_id integer REFERENCES inventory.inventory_lots,
    order_id integer REFERENCES wms.orders, order_item_id integer REFERENCES wms.order_items,
    shipment_id integer REFERENCES wms.outbound_shipments, shipment_item_id integer REFERENCES wms.outbound_shipment_items,
    reference_type varchar(30), reference_id varchar(100), notes text, user_id varchar(100), created_at timestamp NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX uq_inventory_transactions_ship_dedup
    ON inventory.inventory_transactions(shipment_id,order_item_id)
    WHERE transaction_type='ship' AND shipment_id IS NOT NULL AND order_item_id IS NOT NULL;
  CREATE UNIQUE INDEX uq_inventory_transactions_ship_item_dedup
    ON inventory.inventory_transactions(shipment_id,shipment_item_id)
    WHERE transaction_type='ship' AND shipment_id IS NOT NULL AND shipment_item_id IS NOT NULL;
`;

export const dispatchOwnerSeedSql = `
  INSERT INTO warehouse.warehouses VALUES(1);
  INSERT INTO warehouse.warehouse_locations VALUES(50,1);
  INSERT INTO wms.orders VALUES(70);
  INSERT INTO wms.order_items VALUES(71,70);
  INSERT INTO wms.outbound_shipments VALUES(90),(91);
  INSERT INTO wms.outbound_shipment_items VALUES(101,90),(102,91);
  INSERT INTO inventory.inventory_levels VALUES(60,50,105,10,4,8,2,1,'2026-09-07T12:00:00Z');
  INSERT INTO inventory.inventory_lots VALUES
    (401,50,105,4,1,4,7,'active','2026-09-01T00:00:00Z',999,999),
    (402,50,105,6,3,2,8,'active','2026-09-02T00:00:00Z',888,888),
    (403,50,105,0,0,2,9,'active','2026-08-01T00:00:00Z',777,777);
  INSERT INTO oms.order_item_costs VALUES
    (301,70,71,105,401,3,1,3,100,300,'2026-09-07T12:00:00Z'),
    (302,70,71,105,402,2,2,4,200,400,'2026-09-07T12:00:00Z');
`;
