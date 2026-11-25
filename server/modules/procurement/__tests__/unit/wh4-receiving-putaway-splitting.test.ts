import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { ReceivingService } from "../../application/receiving.service";
import { PutawayService } from "../../application/putaway.service";
import { assertReceivingLocations } from "../../domain/receiving-close-integrity.domain";
import { receivingUnitVersion } from "../../application/receiving-unit-contract";

describe("WH-4: Two-Step Receive-to-Dock, Directed Putaway & Uneven Case+Remainder Splitting", () => {
  it("rejects virtual, transit, and quarantine locations during normal receiving validation", () => {
    for (const badType of ["3pl_virtual", "in_transit", "quarantine"]) {
      expect(() =>
        assertReceivingLocations({
          receivingOrderId: 50,
          warehouseId: 1,
          warehouseActive: 1,
          references: [{ receivingLineId: 51, locationId: 99 }],
          locations: [{ id: 99, warehouseId: 1, isActive: 1, locationType: badType }],
        }),
      ).toThrow(/cannot be a virtual, transit, or quarantine/);
    }

    // Active receiving dock, pick, and reserve bins are permitted
    for (const goodType of ["receiving", "pick", "reserve"]) {
      expect(() =>
        assertReceivingLocations({
          receivingOrderId: 50,
          warehouseId: 1,
          warehouseActive: 1,
          references: [{ receivingLineId: 51, locationId: 99 }],
          locations: [{ id: 99, warehouseId: 1, isActive: 1, locationType: goodType }],
        }),
      ).not.toThrow();
    }

    // Quarantine custody intake explicitly permits quarantine holding locations, while still blocking virtual/transit
    expect(() =>
      assertReceivingLocations({
        receivingOrderId: 50,
        warehouseId: 1,
        warehouseActive: 1,
        references: [{ locationId: 99 }],
        locations: [{ id: 99, warehouseId: 1, isActive: 1, locationType: "quarantine" }],
        allowQuarantine: true,
      }),
    ).not.toThrow();
    for (const badHoldingType of ["3pl_virtual", "in_transit"]) {
      expect(() =>
        assertReceivingLocations({
          receivingOrderId: 50,
          warehouseId: 1,
          warehouseActive: 1,
          references: [{ locationId: 99 }],
          locations: [{ id: 99, warehouseId: 1, isActive: 1, locationType: badHoldingType }],
          allowQuarantine: true,
        }),
      ).toThrow(/cannot be a virtual or transit/);
    }
  });

  it("closes unassigned receipt lines onto default RCV-DOCK with putawayComplete = 0, and express Pick/Reserve lines with putawayComplete = 1", async () => {
    const updatedAt = new Date("2026-11-24T17:00:00.000Z");
    const order: any = {
      id: 70,
      receiptNumber: "RCV-20261124-070",
      status: "open",
      sourceType: "blind",
      vendorId: null,
      warehouseId: 1,
      receivingLocationId: null,
      purchaseOrderId: null,
      inboundShipmentId: null,
      updatedAt,
    };
    const lines: any[] = [
      {
        id: 701,
        receivingOrderId: 70,
        productId: 10,
        productVariantId: 201,
        sku: "CARD-C25",
        expectedQty: 4,
        receivedQty: 4,
        damagedQty: 0,
        unitsPerVariantSnapshot: 25,
        putawayLocationId: null, // unassigned -> should auto-resolve to RCV-DOCK (id=5) and keep putawayComplete = 0
        putawayComplete: 0,
        unitCost: 100,
        unitCostMills: 10000,
        updatedAt,
      },
      {
        id: 702,
        receivingOrderId: 70,
        productId: 11,
        productVariantId: 202,
        sku: "CARD-EA",
        expectedQty: 10,
        receivedQty: 10,
        damagedQty: 0,
        unitsPerVariantSnapshot: 1,
        putawayLocationId: 12, // active Pick bin -> 1-step express shortcut -> putawayComplete = 1
        putawayComplete: 0,
        unitCost: 50,
        unitCostMills: 5000,
        updatedAt,
      },
    ];

    const updateLineCalls: Array<{ id: number; updates: any }> = [];
    const receiveInventoryCalls: any[] = [];
    const storage: any = {
      getReceivingOrderById: vi.fn(async () => ({ ...order })),
      getReceivingLines: vi.fn(async () => lines.map((l) => ({ ...l }))),
      updateReceivingOrder: vi.fn(async (_id: number, patch: any) => {
        Object.assign(order, patch);
        return { ...order };
      }),
      updateReceivingLine: vi.fn(async (id: number, patch: any) => {
        updateLineCalls.push({ id, updates: patch });
        const target = lines.find((l) => l.id === id);
        if (target) Object.assign(target, patch);
        return { ...target };
      }),
    };

    const dialect = new PgDialect();
    const execute = vi.fn(async (query: any) => {
      const { sql: sqlText, params } = dialect.sqlToQuery(query);
      if (sqlText.includes("procurement.receiving_custody_fence")) return { rows: [{ singleton: true }] };
      if (sqlText.includes("procurement.receiving_quarantine_")) return { rows: [] };
      if (sqlText.includes("FROM warehouse.warehouses")) return { rows: [{ isActive: 1 }] };
      if (sqlText.includes("location_type = 'receiving'") && sqlText.includes("LIMIT 1")) {
        return { rows: [{ id: 5 }] };
      }
      if (sqlText.includes("FROM warehouse.warehouse_locations")) {
        return {
          rows: [
            { id: 5, warehouseId: 1, isActive: 1, locationType: "receiving" },
            { id: 12, warehouseId: 1, isActive: 1, locationType: "pick" },
          ],
        };
      }
      if (sqlText.includes("FROM catalog.product_variants")) {
        const varId = Number(params[0]);
        return {
          rows: [
            varId === 201
              ? { id: 201, product_id: 10, units_per_variant: 25, is_active: true, sku: "CARD-C25" }
              : { id: 202, product_id: 11, units_per_variant: 1, is_active: true, sku: "CARD-EA" },
          ],
        };
      }
      if (sqlText.includes("procurement.receipt_cost_requests") || sqlText.includes("procurement.receipt_cost_attempts")) {
        return { rows: [] };
      }
      return { rows: [{ id: 70 }] };
    });

    const db: any = {
      execute,
      transaction: vi.fn(async (fn: any) => fn({ execute })),
    };
    const inventoryCore: any = {
      receiveInventory: vi.fn(async (params: any) => {
        receiveInventoryCalls.push(params);
      }),
    };
    const channelSync: any = {
      queueSyncAfterInventoryChange: vi.fn(async () => {}),
    };

    const svc = new ReceivingService(db, inventoryCore, channelSync, storage);
    const res = await svc.close(70, "receiver-1");

    // Line 701 auto-landed on RCV-DOCK (id=5) and stayed putawayComplete = 0
    expect(receiveInventoryCalls.find((c) => c.receivingLineId === 701)?.warehouseLocationId).toBe(5);
    expect(lines.find((l) => l.id === 701)?.putawayComplete).toBe(0);

    // Line 702 landed on Pick bin (id=12) via 1-step express shortcut with putawayComplete = 1
    expect(receiveInventoryCalls.find((c) => c.receivingLineId === 702)?.warehouseLocationId).toBe(12);
    expect(lines.find((l) => l.id === 702)?.putawayComplete).toBe(1);

    expect(res.dockStagedCount).toBe(1);
    expect(res.expressPutawayVariantIds).toEqual([202]);
    expect(res.expressPutawayProductIds).toEqual([11]);
  });

  it("suggests hungry Primary Pick first, then Consolidate Reserve, and executes partial + final Directed Putaway via transferStock with wakeups", async () => {
    const dialect = new PgDialect();
    let alreadyPutAway = 0;
    let dockOnHand = 50;
    let linePutawayComplete = 0;
    let linePutawayLocationId = 5;

    const execute = vi.fn(async (query: any) => {
      const { sql: sqlText } = dialect.sqlToQuery(query);
      if (sqlText.includes("FROM warehouse.product_locations pl")) {
        // Hungry primary pick bin A-01 (currentQty: 0, maxQty: 10)
        return {
          rows: [{ id: 20, code: "A-01", locationType: "pick", zone: "FWD", currentQty: 0, minTrigger: 5, maxQty: 10 }],
        };
      }
      if (sqlText.includes("wl.location_type = 'reserve'") && sqlText.includes("il.variant_qty > 0")) {
        return {
          rows: [{ id: 30, code: "R-01", locationType: "reserve" }],
        };
      }
      if (sqlText.includes("FROM procurement.receiving_lines rl") && sqlText.includes("LIMIT 1")) {
        return {
          rows: [
            {
              id: 801,
              receivingOrderId: 80,
              productId: 10,
              productVariantId: 201,
              receivedQty: 50,
              reversedQty: 0,
              fromLocationId: linePutawayLocationId,
              putawayComplete: linePutawayComplete,
              orderStatus: "closed",
              receiptNumber: "RCV-80",
              warehouseId: 1,
              variantProductId: 10,
              availableOnDockQty: dockOnHand,
              alreadyPutAwayQty: alreadyPutAway,
              isQuarantineAcceptance: false,
            },
          ],
        };
      }
      if (sqlText.includes("FROM warehouse.warehouse_locations") && sqlText.includes("LIMIT 1")) {
        if (query && JSON.stringify(dialect.sqlToQuery(query).params).includes("5")) {
          return { rows: [{ id: 5, code: "RCV-DOCK", warehouseId: 1, isActive: 1, locationType: "receiving", freezeId: null }] };
        }
        const locId = Number(dialect.sqlToQuery(query).params[0]);
        if (locId === 999) {
          return { rows: [{ id: 999, code: "RCV-02", warehouseId: 1, isActive: 1, locationType: "receiving", freezeId: null }] };
        }
        return {
          rows: [
            locId === 20
              ? { id: 20, code: "A-01", warehouseId: 1, isActive: 1, locationType: "pick", freezeId: null }
              : { id: 30, code: "R-01", warehouseId: 1, isActive: 1, locationType: "reserve", freezeId: null },
          ],
        };
      }
      return { rows: [] };
    });

    const db: any = {
      execute,
      transaction: vi.fn(async (fn: any) => fn({ execute })),
    };
    const storage = {
      updateReceivingLine: vi.fn(async (_id: number, patch: any) => {
        if ("putawayComplete" in patch) linePutawayComplete = patch.putawayComplete;
        if ("putawayLocationId" in patch) linePutawayLocationId = patch.putawayLocationId;
        return {};
      }),
    };
    const manualTransfers: any = {
      transfer: vi.fn(async (req: any) => {
        dockOnHand -= req.qty;
        return { transferReceiptId: `XFER-${req.toLocationId}` };
      }),
    };
    const channelSync = { queueSyncAfterInventoryChange: vi.fn(async () => {}) };
    const replenishment = { reevaluateReplenForProduct: vi.fn(async () => ({})) };
    const picking = { wakeShortedExceptionOrdersForVariant: vi.fn(async () => ({})) };

    const putaway = new PutawayService(
      db,
      storage as any,
      manualTransfers,
      channelSync,
      replenishment,
      picking,
    );

    // For 10 units -> fits maxQty=10 in hungry Primary Pick A-01
    const smallSuggestion = await putaway.suggestDestination({
      warehouseId: 1,
      productId: 10,
      productVariantId: 201,
      unitsPerVariant: 1,
      putawayQty: 10,
      excludeLocationId: 5,
    });
    expect(smallSuggestion).toEqual({
      locationId: 20,
      locationCode: "A-01",
      locationType: "pick",
      reason: "primary_pick_hungry",
    });

    // For 50 units -> exceeds maxQty=10 in Primary Pick A-01 -> suggests Consolidate Reserve R-01
    const bulkSuggestion = await putaway.suggestDestination({
      warehouseId: 1,
      productId: 10,
      productVariantId: 201,
      unitsPerVariant: 1,
      putawayQty: 50,
      excludeLocationId: 5,
    });
    expect(bulkSuggestion).toEqual({
      locationId: 30,
      locationCode: "R-01",
      locationType: "reserve",
      reason: "consolidate_reserve",
    });

    // Rejects putting away onto another receiving dock bin
    await expect(
      putaway.executeLinePutaway({
        receivingLineId: 801,
        toLocationId: 999,
        qty: 10,
        userId: "operator-1",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Partial split putaway: 10 units -> A-01
    const firstLeg = await putaway.executeLinePutaway({
      receivingLineId: 801,
      toLocationId: 20,
      qty: 10,
      method: "manual",
      userId: "operator-1",
    });
    alreadyPutAway += 10;
    expect(firstLeg).toMatchObject({
      movedQty: 10,
      remainingQty: 40,
      putawayComplete: 0,
      toLocationCode: "A-01",
    });
    expect(linePutawayComplete).toBe(0);
    expect(manualTransfers.transfer).toHaveBeenCalledTimes(1);
    expect(replenishment.reevaluateReplenForProduct).toHaveBeenCalledWith(10);
    expect(picking.wakeShortedExceptionOrdersForVariant).toHaveBeenCalledWith(201, "putaway");

    // Final putaway: remaining 40 units -> R-01
    const secondLeg = await putaway.executeLinePutaway({
      receivingLineId: 801,
      toLocationId: 30,
      qty: 40,
      method: "scan",
      userId: "operator-1",
    });
    alreadyPutAway += 40;
    expect(secondLeg).toMatchObject({
      movedQty: 40,
      remainingQty: 0,
      putawayComplete: 1,
      toLocationCode: "R-01",
    });
    expect(linePutawayComplete).toBe(1);
    expect(linePutawayLocationId).toBe(30);
  });

  it("splits an uneven 99-piece shipment/PO line into 3 × Case-25 + 24 × Each while preserving exact lineage and costs", async () => {
    const updatedAt = new Date("2026-11-24T17:30:00.000Z");
    const order: any = {
      id: 90,
      receiptNumber: "RCV-90",
      status: "open",
      sourceType: "shipment",
      warehouseId: 1,
      receivingLocationId: 5,
      purchaseOrderId: 300,
      inboundShipmentId: 400,
      vendorId: null,
      updatedAt,
    };
    const originalLine: any = {
      id: 901,
      receivingOrderId: 90,
      productId: 10,
      productVariantId: 202,
      sku: "SLV-EA",
      productName: "Card Sleeves",
      expectedQty: 99,
      receivedQty: 0,
      damagedQty: 0,
      unitsPerVariantSnapshot: 1,
      purchaseOrderLineId: 301,
      inboundShipmentLineId: 401,
      unitCost: 12,
      unitCostMills: 1200,
      costSourceKind: "purchase_order_line",
      costSourceEvidence: null,
      putawayLocationId: 5,
      putawayComplete: 0,
      status: "pending",
      updatedAt,
    };
    const lines: any[] = [originalLine];

    const dialect = new PgDialect();
    const execute = vi.fn(async (query: any) => {
      const { sql: sqlText, params } = dialect.sqlToQuery(query);
      if (sqlText.includes("procurement.receiving_quarantine_")) return { rows: [] };
      if (sqlText.includes("FROM warehouse.warehouses")) return { rows: [{ isActive: 1 }] };
      if (sqlText.includes("FROM warehouse.product_locations")) {
        return { rows: [{ productVariantId: 202, warehouseLocationId: 20 }] };
      }
      if (sqlText.includes("FROM warehouse.warehouse_locations")) {
        return {
          rows: [
            { id: 5, warehouseId: 1, isActive: 1, locationType: "receiving" },
            { id: 20, warehouseId: 1, isActive: 1, locationType: "pick" },
          ],
        };
      }
      if (sqlText.includes("FROM procurement.inbound_shipment_lines")) {
        return {
          rows: [{ inbound_shipment_id: 400, purchase_order_id: 300, purchase_order_line_id: 301, qty_shipped: 99 }],
        };
      }
      if (sqlText.includes("FROM catalog.product_variants")) {
        const varId = Number(params[0]);
        return {
          rows: [
            varId === 201
              ? { id: 201, product_id: 10, units_per_variant: 25, is_active: true, sku: "SLV-C25" }
              : { id: 202, product_id: 10, units_per_variant: 1, is_active: true, sku: "SLV-EA" },
          ],
        };
      }
      return { rows: [{ id: 901, receiving_order_id: 90 }] };
    });

    const storage: any = {
      getReceivingOrderById: vi.fn(async () => ({ ...order })),
      getReceivingLineById: vi.fn(async (id: number) => lines.find((l) => l.id === id) ?? null),
      getReceivingLines: vi.fn(async () => lines.map((l) => ({ ...l }))),
      getPurchaseOrderLineById: vi.fn(async () => ({
        id: 301,
        purchaseOrderId: 300,
        productId: 10,
        lineType: "product",
      })),
      getProductVariantById: vi.fn(async (id: number) =>
        id === 201
          ? { id: 201, sku: "SLV-C25", name: "Case of 25", barcode: "BC-C25" }
          : { id: 202, sku: "SLV-EA", name: "Each", barcode: "BC-EA" },
      ),
      updateReceivingLine: vi.fn(async (id: number, patch: any) => {
        const target = lines.find((l) => l.id === id)!;
        Object.assign(target, patch);
        return { ...target };
      }),
      createReceivingLine: vi.fn(async (row: any) => {
        const created = { id: 902, ...row };
        lines.push(created);
        return created;
      }),
      updateReceivingOrder: vi.fn(async (_id: number, patch: any) => {
        Object.assign(order, patch);
        return { ...order };
      }),
    };

    const svc = new ReceivingService(
      { execute, transaction: vi.fn(async (fn: any) => fn({ execute })) } as any,
      { receiveInventory: vi.fn() } as any,
      { queueSyncAfterInventoryChange: vi.fn(async () => {}) } as any,
      storage,
    );

    const splitRes = await svc.splitLine(
      901,
      {
        packVariantId: 201,
        packCount: 3,
        remainderVariantId: 202,
        remainderReceivedQty: 24,
        expectedUnitVersion: receivingUnitVersion(originalLine),
      },
      "receiver-1",
    );

    expect(splitRes.packLine).toMatchObject({
      id: 901,
      productVariantId: 201,
      sku: "SLV-C25",
      unitsPerVariantSnapshot: 25,
      expectedQty: 3,
      receivedQty: 3,
      purchaseOrderLineId: 301,
      inboundShipmentLineId: 401,
      unitCostMills: 1200,
    });
    expect(splitRes.remainderLine).toMatchObject({
      id: 902,
      productVariantId: 202,
      sku: "SLV-EA",
      unitsPerVariantSnapshot: 1,
      expectedQty: 24,
      receivedQty: 24,
      purchaseOrderLineId: 301,
      inboundShipmentLineId: 401,
      unitCostMills: 1200,
      putawayLocationId: 20, // Primary Pick Bin auto-selected for loose Each!
    });
  });
});
