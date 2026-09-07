import type { InventoryCutoverPreflightFacts } from "../../domain/inventory-cutover-preflight";

export function cutoverPreflightFacts(): InventoryCutoverPreflightFacts {
  return {
    capturedAt: "2026-09-07T18:00:00.000Z", runtimeAuthority: "legacy", authorityRevision: "1",
    demand: {
      schemaVersion: "wms_inventory_cutover_demand_v1", scope: "nonterminal_wms_orders",
      capturedAt: "2026-09-07T18:00:00.000Z", excludedTerminalOrderCount: "24",
      orders: [{ id: 1, warehouseId: 1, status: "ready", onHold: 0, channelId: 36, source: "shopify",
        externalOrderId: "example-1", omsFulfillmentOrderId: "fo-1", fulfillmentPartitionKey: "default" }],
      items: [{ id: 11, orderId: 1, omsOrderLineId: "9007199254740993", sourceItemId: "source-11",
        sku: "P5", productId: 101, quantity: 4, pickedQuantity: 0, fulfilledQuantity: 0,
        status: "pending", onHold: false, requiresShipping: 1, location: "PICK-1", shortReason: null }],
      sourceItems: [], physicalItems: [],
    },
    encumbrance: {
      schemaVersion: "inventory_cutover_encumbrance_v1", canonicalTablesStatus: "captured",
      inventoryLevels: [{ inventoryLevelId: 10, warehouseLocationId: 100, productVariantId: 101,
        variantQty: "20", reservedQty: "0", pickedQty: "0", packedQty: "0" }],
      buildReservations: [], canonicalResources: [],
      totals: { quantitySemantics: "mixed_sku_units_not_atp", inventoryLevelCount: "1",
        variantQty: "20", reservedQty: "0", pickedQty: "0", packedQty: "0" },
      attributionCaveats: ["legacy_order_reservation_attribution_not_captured", "picked_packed_custody_not_attributed",
        "build_claim_hold_overlap_requires_deduplication", "unexplained_reserved_balance_is_not_free_supply"],
    },
    variants: [{ id: 101, productId: 20, sku: "P5", isActive: true, requiresShipping: true,
      trackInventory: true, salesEligibility: "sellable" }],
  };
}

export function standaloneBuildReservation() {
  return { reservationId: 1, buildOrderComponentId: 2, buildOrderId: 3, buildOrderStatus: "reserved",
    warehouseId: 1, componentVariantId: 101, sourceLocationId: 100, inventoryLotId: 4,
    lotVariantId: 101, lotLocationId: 100, lotQtyReserved: "3", reservedQty: "5", consumedQty: "1", releasedQty: "1",
    reservationOwner: "build_order", availabilityClaimId: null, availabilityClaimLotAllocationId: null,
    claimLotResourceId: null, claimLotInventoryLotId: null, claimLotOpenQty: null };
}

export function canonicalResource() {
  return { claimResourceId: "1", claimId: "2", claimStatus: "active", orderId: 1, claimLineId: "3", orderItemId: 11,
    targetVariantId: 101, warehouseId: 1, warehouseLocationId: 100, inventoryLevelId: 10, sourceVariantId: 101,
    claimedQty: "10", releasedQty: "2", consumedQty: "3", pickedQty: "1" };
}
