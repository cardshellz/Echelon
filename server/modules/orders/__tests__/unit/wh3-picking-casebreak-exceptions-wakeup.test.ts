import { describe, expect, it, vi } from "vitest";
import { PickingUseCases } from "../../application/picking.use-cases";
import { dispatchShipStationHoldSyncRetry } from "../../../oms/application/webhook-retry.worker";
import {
  formatFollowupRetryError,
  isFollowupReadyForRetry,
  parseFollowupRetryState,
} from "../../../inventory/domain/followup-retry-metadata";

function makeBaseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 500,
    orderId: 900,
    sku: "SKU-EA",
    name: "Single Sleeve Pack",
    quantity: 2,
    pickedQuantity: 0,
    fulfilledQuantity: 0,
    requiresShipping: 1,
    location: "A-01",
    status: "pending",
    shortReason: null,
    onHold: false,
    productId: 100,
    catalogProductId: 10,
    inventoryTracking: true,
    pickedAt: null,
    ...overrides,
  } as any;
}

describe("WH-3: Picking, 1-Click Case-Break, Found-on-Shelf, Short Pick, Exceptions & Wakeup", () => {
  it("threads replenSourceLocationId override into inline pre-pick case-break", async () => {
    const levels = [{ warehouseLocationId: 1, variantQty: 0, reservedQty: 0 }];
    const locations = [
      { id: 1, code: "A-01", warehouseId: 1, isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" },
    ];
    const storage = {
      getProductVariantById: vi.fn(async () => ({ id: 100, sku: "SKU-EA", productId: 10, unitsPerVariant: 1 })),
      getProductVariantBySku: vi.fn(async () => ({ id: 100, sku: "SKU-EA", productId: 10, unitsPerVariant: 1 })),
      getInventoryLevelsByProductVariantId: vi.fn(async () => levels),
      getAllWarehouseLocations: vi.fn(async () => locations),
      getOrderById: vi.fn(async () => ({ id: 900, orderNumber: "#900", warehouseId: 1 })),
    };
    const inventoryCore = {
      adjustInventory: vi.fn(),
      getLevel: vi.fn(async () => ({ ...levels[0], productVariantId: 100 })),
      pickItem: vi.fn(async ({ qty }: { qty: number }) => {
        if (levels[0].variantQty < qty) return false;
        levels[0].variantQty -= qty;
        return true;
      }),
    };
    const replenishment = {
      checkReplenNeeded: vi.fn(async () => ({
        needed: true,
        stockout: false,
        sourceLocationCode: "R-01",
        sourceVariantSku: "SKU-C25",
        sourceVariantName: "Case of 25",
        qtyTargetUnits: 25,
        replenMethod: "case_break",
        executionMode: "inline",
      })),
      createAndExecuteReplen: vi.fn(async () => {
        levels[0].variantQty += 25;
        return { task: { id: 701, status: "completed", replenMethod: "case_break" }, moved: 25 };
      }),
    };

    const service = new PickingUseCases({} as any, inventoryCore as any, replenishment as any, storage as any);
    const item = makeBaseItem({ pickedQuantity: 2 });
    const before = makeBaseItem({ pickedQuantity: 0 });

    const res = await (service as any)._deductInventory(item, before, {
      quantity: 2,
      pickMethod: "manual",
      replenSourceLocationId: 99, // Picker tapped R-02 instead of R-01
      userId: "picker-1",
    });

    expect(res).toMatchObject({
      success: true,
      locationId: 1,
      systemQtyAfter: 23,
    });
    expect(replenishment.createAndExecuteReplen).toHaveBeenCalledWith(
      100,
      1,
      "picker-1",
      expect.objectContaining({
        preferredSourceLocationId: 99,
        forceWhenAtOrBelowZero: true,
        triggeredBy: "pick_shortage_case_break",
      }),
    );
    expect(inventoryCore.adjustInventory).not.toHaveBeenCalled();
  });

  it("requires 1-tap Found-on-Shelf confirmation when confirmFoundOnShelf=false and posts found_at_pick when confirmed (1=A)", async () => {
    const levels = [{ warehouseLocationId: 1, variantQty: 0, reservedQty: 0 }];
    const locations = [
      { id: 1, code: "A-01", warehouseId: 1, isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" },
    ];
    const storage = {
      getProductVariantById: vi.fn(async () => ({ id: 100, sku: "SKU-EA", productId: 10, unitsPerVariant: 1 })),
      getProductVariantBySku: vi.fn(async () => ({ id: 100, sku: "SKU-EA", productId: 10, unitsPerVariant: 1 })),
      getInventoryLevelsByProductVariantId: vi.fn(async () => levels),
      getAllWarehouseLocations: vi.fn(async () => locations),
      getOrderById: vi.fn(async () => ({ id: 900, orderNumber: "#900", warehouseId: 1 })),
    };
    const inventoryCore = {
      adjustInventory: vi.fn(async ({ qtyDelta }: { qtyDelta: number }) => {
        levels[0].variantQty += qtyDelta;
      }),
      getLevel: vi.fn(async () => ({ ...levels[0], productVariantId: 100 })),
      pickItem: vi.fn(async ({ qty }: { qty: number }) => {
        if (levels[0].variantQty < qty) return false;
        levels[0].variantQty -= qty;
        return true;
      }),
    };
    const replenishment = {
      checkReplenNeeded: vi.fn(async () => ({
        needed: true,
        stockout: true,
        sourceLocationCode: null,
        qtyTargetUnits: 0,
        replenMethod: "case_break",
        executionMode: "inline",
      })),
      createAndExecuteReplen: vi.fn(async () => null),
    };

    const service = new PickingUseCases({} as any, inventoryCore as any, replenishment as any, storage as any);
    const item = makeBaseItem({ pickedQuantity: 2 });
    const before = makeBaseItem({ pickedQuantity: 0 });

    const unconfirmed = await (service as any)._deductInventory(item, before, {
      quantity: 2,
      pickMethod: "manual",
      confirmFoundOnShelf: false,
      userId: "picker-1",
    });

    expect(unconfirmed).toMatchObject({
      success: false,
      error: "found_on_shelf_confirmation_required",
      locationCode: "A-01",
      systemQty: 0,
      pickerBlocking: true,
      shipmentBlocking: false,
    });
    expect(inventoryCore.adjustInventory).not.toHaveBeenCalled();
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();

    const confirmed = await (service as any)._deductInventory(item, before, {
      quantity: 2,
      pickMethod: "manual",
      confirmFoundOnShelf: true,
      userId: "picker-1",
    });

    expect(confirmed).toMatchObject({
      success: true,
      systemQtyAfter: 0,
      autoResolved: expect.objectContaining({
        code: "picker_confirmed_bin_shortage",
        adjustment: 2,
        systemQtyBefore: 0,
        pickedQty: 2,
      }),
    });
    expect(inventoryCore.adjustInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        productVariantId: 100,
        warehouseLocationId: 1,
        qtyDelta: 2,
        reason: expect.stringContaining("found_at_pick:"),
      }),
    );
  });

  it("zeroes unreserved phantom stock on Short Pick while respecting other orders' reservations and holds ShipStation (2=A)", async () => {
    const pickLocation = { id: 1, code: "A-01", warehouseId: 1, isPickable: 1, cycleCountFreezeId: null };
    // Bin has 5 phantom units total, 2 of which are reserved by another order -> should zero 3 phantom units!
    const binState = { variantQty: 5, reservedQty: 4 };
    const reservation = {
      releaseOrderReservation: vi.fn(async () => ({ released: 0, failed: [] })),
      releaseOrderItemReservation: vi.fn(async () => {
        // Releasing this shorted item's 2 reserved units leaves 2 reserved for another order
        binState.reservedQty = 2;
        return { released: 2 };
      }),
    };
    const channelSync = {
      queueSyncAfterInventoryChange: vi.fn(async () => {}),
    };
    const insertedRetries: any[] = [];
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: vi.fn(async () => [pickLocation]),
          }),
        }),
      })),
      execute: vi.fn(async () => ({ rows: [] })),
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => {
          insertedRetries.push(val);
          return Promise.resolve();
        }),
      })),
    };
    const inventoryCore = {
      getLevel: vi.fn(async () => ({ productVariantId: 100, warehouseLocationId: 1, ...binState })),
      adjustInventory: vi.fn(async ({ qtyDelta }: { qtyDelta: number }) => {
        binState.variantQty += qtyDelta;
      }),
      pickItem: vi.fn(),
      logTransaction: vi.fn(),
    };
    const storage = {
      getOrderById: vi.fn(async () => ({ id: 900, orderNumber: "#900", warehouseId: 1, assignedPickerId: "picker-1" })),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker" })),
      getProductVariantBySku: vi.fn(async () => ({ id: 100, sku: "SKU-EA" })),
      createPickingLog: vi.fn(async () => ({})),
      getAllWarehouseSettings: vi.fn(async () => [{ warehouseId: 1, postPickStatus: "ready_to_ship" }]),
      updateOrderProgress: vi.fn(async () => ({ id: 900, warehouseStatus: "exception" })),
    };
    const replenishment = {
      ensureQueuedReplenForShortPick: vi.fn(async () => null),
    };

    const service = new PickingUseCases(
      db as any,
      inventoryCore as any,
      replenishment as any,
      storage as any,
      channelSync as any,
      undefined,
      false,
      undefined,
      undefined,
      () => new Date("2026-11-24T16:00:00Z"),
      reservation as any,
    );

    const beforeItem = makeBaseItem({ status: "pending", pickedQuantity: 0, quantity: 2 });
    const shortedItem = makeBaseItem({ status: "short", pickedQuantity: 0, quantity: 2, shortReason: "out_of_stock" });

    const res = await (service as any).finishCommittedPick({
      beforeItem,
      item: shortedItem,
      pickDeductResult: null,
      params: {
        status: "short",
        pickedQuantity: 0,
        shortReason: "out_of_stock",
        pickMethod: "short",
        userId: "picker-1",
      },
    });

    expect(res.success).toBe(true);
    expect(reservation.releaseOrderItemReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 900,
        orderItemId: 500,
        quantity: 2,
      }),
    );
    expect(inventoryCore.adjustInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        productVariantId: 100,
        warehouseLocationId: 1,
        qtyDelta: -3,
        reason: expect.stringContaining("short_pick_zeroed:"),
      }),
    );
    expect(binState.variantQty).toBe(2);
    expect(channelSync.queueSyncAfterInventoryChange).toHaveBeenCalledWith(100);
    expect(insertedRetries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "shipstation_hold_sync",
          payload: { wmsOrderId: 900, requestedMode: "hold" },
        }),
      ]),
    );
  });

  it("dispatchShipStationHoldSyncRetry places a Hold on ShipStation when warehouse_status is exception", async () => {
    const holdSpy = vi.fn(async () => ({}));
    const releaseSpy = vi.fn(async () => ({}));
    const dbMock: any = {
      __shippingEngine: {
        engineName: "shipstation",
        hold: holdSpy,
        releaseHold: releaseSpy,
      },
      execute: vi.fn()
        // 1. SELECT order state -> on_hold=0, warehouse_status='exception'
        .mockResolvedValueOnce({
          rows: [{ id: 900, order_number: "#900", on_hold: 0, order_edit_operation_id: null, warehouse_status: "exception" }],
        })
        // 2. loadOpenShipmentEngineRefs
        .mockResolvedValueOnce({
          rows: [
            {
              shipping_engine: "shipstation",
              engine_order_ref: "SS-900",
              engine_shipment_ref: "echelon-wms-shp-77",
              shipstation_order_id: 9001,
              shipstation_order_key: "echelon-wms-shp-77",
            },
          ],
        })
        // 3. markRowSuccess
        .mockResolvedValue({ rows: [] }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => ({})),
        })),
      })),
    };

    const outcome = await dispatchShipStationHoldSyncRetry(dbMock, {
      id: 1,
      provider: "internal",
      topic: "shipstation_hold_sync",
      payload: { wmsOrderId: 900, requestedMode: "hold" },
      attempts: 0,
    });

    expect(outcome).toBe("success");
    expect(holdSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it("resolveOrderException('ship_partial') transitions to ready_to_ship, amends pre-label shipments, and releases shorted reservations", async () => {
    const retryPayloads: any[] = [];
    const db = {
      execute: vi.fn()
        // amendPreLabelShipmentItemsForShipPartialInWms (delete 0-qty + update partial)
        .mockResolvedValueOnce({ rows: [{ id: 11 }] })
        .mockResolvedValueOnce({ rows: [{ id: 12 }] })
        // finalizePreLabelShipmentsForShipPartialInWms (cancel empty + unhold active)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 77 }] })
        // hasPendingRetryForScope checks + closeResolvedShipmentBlockers
        .mockResolvedValue({ rows: [] }),
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => {
          retryPayloads.push(val);
          return Promise.resolve();
        }),
      })),
    };
    const reservation = {
      releaseOrderReservation: vi.fn(async () => ({ released: 1, failed: [] })),
    };
    const storage = {
      getOrderById: vi.fn(async () => ({ id: 900, orderNumber: "#900", warehouseStatus: "exception" })),
      getOrderItems: vi.fn(async () => [
        makeBaseItem({ id: 501, status: "completed", quantity: 2, pickedQuantity: 2 }),
        makeBaseItem({ id: 502, status: "short", quantity: 1, pickedQuantity: 0, shortReason: "out_of_stock" }),
      ]),
      resolveException: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        warehouseStatus: "ready_to_ship",
        onHold: 0,
      })),
    };

    const service = new PickingUseCases(
      db as any,
      {} as any,
      {} as any,
      storage as any,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      () => new Date("2026-11-24T16:00:00Z"),
      reservation as any,
    );

    const outcome = await service.resolveOrderException(900, {
      resolution: "ship_partial",
      userId: "lead-1",
      notes: "Ship picked items now",
    });

    expect(outcome.order?.warehouseStatus).toBe("ready_to_ship");
    expect(outcome.amendedShipments).toBe(1);
    expect(reservation.releaseOrderReservation).toHaveBeenCalledWith(
      900,
      "exception_ship_partial",
      "lead-1",
      { disposition: "release" },
    );
    expect(retryPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: "shipstation_shipment_push" }),
        expect.objectContaining({
          topic: "shipstation_hold_sync",
          payload: { wmsOrderId: 900, requestedMode: "release" },
        }),
      ]),
    );
  });

  it("resolveOrderException('cancelled') unpicks picked sibling items back to stock, releases claims, and cancels open shipments", async () => {
    const retryPayloads: any[] = [];
    const db = {
      execute: vi.fn()
        // clearWmsOrderAssignedPickerInWms
        .mockResolvedValueOnce({ rows: [] })
        // cancelOpenPreLabelShipmentsForOrderInWms
        .mockResolvedValueOnce({
          rows: [{ id: 88, shipstation_order_id: 55001, engine_order_ref: "55001" }],
        })
        .mockResolvedValue({ rows: [] }),
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => {
          retryPayloads.push(val);
          return Promise.resolve();
        }),
      })),
    };
    const reservation = {
      releaseOrderReservation: vi.fn(async () => ({ released: 2, failed: [] })),
    };
    const storage = {
      getOrderById: vi.fn(async () => ({ id: 900, orderNumber: "#900", warehouseStatus: "exception" })),
      getOrderItems: vi.fn(async () => [
        makeBaseItem({ id: 501, status: "completed", quantity: 3, pickedQuantity: 3, fulfilledQuantity: 0 }),
        makeBaseItem({ id: 502, status: "short", quantity: 1, pickedQuantity: 0, fulfilledQuantity: 0 }),
      ]),
      resolveException: vi.fn(async () => ({
        id: 900,
        orderNumber: "#900",
        warehouseStatus: "cancelled",
      })),
    };

    const service = new PickingUseCases(
      db as any,
      {} as any,
      {} as any,
      storage as any,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      () => new Date("2026-11-24T16:00:00Z"),
      reservation as any,
    );
    const unpickSpy = vi
      .spyOn(service, "unpickItem")
      .mockResolvedValue({ success: true, item: makeBaseItem({ id: 501, pickedQuantity: 0, status: "pending" }), inventory: {} as any });

    const outcome = await service.resolveOrderException(900, {
      resolution: "cancelled",
      userId: "lead-1",
      notes: "Customer requested cancel",
    });

    expect(unpickSpy).toHaveBeenCalledWith(501, {
      qty: 3,
      userId: "lead-1",
      reason: "Order cancelled during exception resolution",
    });
    expect(outcome.unpickedItems).toBe(1);
    expect(outcome.cancelledShipments).toBe(1);
    expect(reservation.releaseOrderReservation).toHaveBeenCalledWith(
      900,
      "exception_cancelled",
      "lead-1",
      { disposition: "cancel" },
    );
    expect(retryPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: "shipstation_shipment_cancel" }),
      ]),
    );
  });

  it("wakeShortedExceptionOrdersForVariant reopens shorted exception orders on Pick/Reserve arrival and releases ShipStation Hold (4=A)", async () => {
    const retryPayloads: any[] = [];
    const tx = {
      execute: vi.fn()
        // FOR UPDATE lock on wms.orders
        .mockResolvedValueOnce({ rows: [{ id: 900, assigned_picker_id: null, order_number: "#900" }] })
        // reopenShortWmsOrderItemsForRepick
        .mockResolvedValueOnce({ rows: [{ id: 502 }] })
        // transitionWmsOrderStatusByMatrixReturningInWms
        .mockResolvedValueOnce({ rows: [{ id: 900, orderNumber: "#900", warehouseStatus: "ready" }] }),
      select: vi.fn(() => ({
        from: () => ({
          where: vi.fn(async () => [
            makeBaseItem({ id: 502, status: "pending", pickedQuantity: 0, quantity: 2 }),
          ]),
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => [{ id: 900, orderNumber: "#900", warehouseStatus: "ready" }]),
          })),
        })),
      })),
    };
    const db = {
      execute: vi.fn()
        // 1. readAvailableWarehouseBaseUnits(null) -> 25 units in Reserve!
        .mockResolvedValueOnce({ rows: [{ free_base_units: 25 }] })
        // 2. candidates query -> order #900
        .mockResolvedValueOnce({ rows: [{ id: 900, warehouse_id: 1, sort_rank: "100" }] })
        // 3. readAvailableWarehouseBaseUnits(1) -> 25 units
        .mockResolvedValueOnce({ rows: [{ free_base_units: 25 }] })
        // 4+. closeResolvedShipmentBlockers + retry scope check
        .mockResolvedValue({ rows: [] }),
      transaction: vi.fn(async (cb: (t: any) => Promise<any>) => cb(tx)),
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => {
          retryPayloads.push(val);
          return Promise.resolve();
        }),
      })),
    };
    const reservation = {
      releaseOrderReservation: vi.fn(),
      reserveOrder: vi.fn(async () => ({ reserved: 1 })),
    };
    const storage = {
      getProductVariantById: vi.fn(async () => ({ id: 200, sku: "SKU-C25", productId: 10, unitsPerVariant: 25, isActive: true })),
      getProductVariantsByProductId: vi.fn(async () => [
        { id: 100, sku: "SKU-EA", productId: 10, unitsPerVariant: 1, isActive: true },
        { id: 200, sku: "SKU-C25", productId: 10, unitsPerVariant: 25, isActive: true },
      ]),
      createPickingLog: vi.fn(async () => ({})),
    };

    const service = new PickingUseCases(
      db as any,
      {} as any,
      {} as any,
      storage as any,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      () => new Date("2026-11-24T16:00:00Z"),
      reservation as any,
    );

    const woken = await service.wakeShortedExceptionOrdersForVariant(200, "transfer");

    expect(woken).toEqual({ checked: 1, wokenOrderIds: [900] });
    expect(reservation.reserveOrder).toHaveBeenCalledWith(900, "system:stock-arrival-wakeup");
    expect(retryPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "shipstation_hold_sync",
          payload: { wmsOrderId: 900, requestedMode: "release" },
        }),
      ]),
    );
  });

  it("isolates post-pick replen errors even when commandKey is present and bounds outbox retries to dead-letter", async () => {
    const db = {
      execute: vi.fn(async () => ({ rows: [{ id: 1 }] })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(async () => ({})),
        })),
      })),
    };
    const storage = {
      getOrderById: vi.fn(async () => ({ id: 900, orderNumber: "#900", warehouseId: 1 })),
      getUser: vi.fn(async () => ({ id: "picker-1", username: "picker" })),
      createPickingLog: vi.fn(async () => ({})),
      getAllWarehouseSettings: vi.fn(async () => [{ warehouseId: 1, postPickStatus: "ready_to_ship" }]),
    };
    const replenishment = {
      createAndExecuteReplen: vi.fn(async () => {
        throw new Error("simulated transient replen failure");
      }),
    };
    const service = new PickingUseCases(db as any, {} as any, replenishment as any, storage as any);

    const res = await (service as any).finishCommittedPick({
      beforeItem: makeBaseItem({ pickedQuantity: 0, status: "pending" }),
      item: makeBaseItem({ pickedQuantity: 2, status: "completed" }),
      pickDeductResult: {
        success: true,
        productVariantId: 100,
        locationId: 1,
        locationCode: "A-01",
        systemQtyAfter: 0,
      },
      params: { status: "completed", pickedQuantity: 2, pickMethod: "scan", userId: "picker-1" },
      commandKey: "wms-pick:11111111-1111-4111-8111-111111111111",
    });

    expect(res).toMatchObject({
      success: true,
      inventory: expect.objectContaining({
        replen: expect.objectContaining({
          triggered: true,
          autoExecutedFailed: true,
        }),
      }),
    });

    // Outbox retry backoff + dead-lettering after 10 attempts
    const t0 = new Date("2026-11-24T16:00:00.000Z");
    let errState: string | null = null;
    for (let i = 1; i <= 9; i++) {
      const next = formatFollowupRetryError(errState, "channel down", t0, 10);
      expect(next.deadLettered).toBe(false);
      expect(next.attempts).toBe(i);
      expect(isFollowupReadyForRetry(next.formattedError, t0)).toBe(false);
      expect(isFollowupReadyForRetry(next.formattedError, new Date(t0.getTime() + 600_000))).toBe(true);
      errState = next.formattedError;
    }
    const tenth = formatFollowupRetryError(errState, "channel down", t0, 10);
    expect(tenth.deadLettered).toBe(true);
    expect(tenth.attempts).toBe(10);
    expect(parseFollowupRetryState(tenth.formattedError).deadLettered).toBe(true);
    expect(isFollowupReadyForRetry(tenth.formattedError, new Date(t0.getTime() + 86_400_000))).toBe(false);
  });
});
