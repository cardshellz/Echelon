import { describe, it, expect, vi } from "vitest";
import { ReceivingService } from "../../../../modules/procurement/receiving.service";

function sqlToStr(query: any): string {
  if (Array.isArray(query?.queryChunks)) {
    return query.queryChunks
      .map((chunk: any) => (Array.isArray(chunk.value) ? chunk.value.join("") : ""))
      .join(" ")
      .toLowerCase();
  }
  return String(query?.sql ?? query ?? "").toLowerCase();
}

function makeZeroPostVoidTx(input: {
  order?: any;
  summary?: any;
  po?: any;
}) {
  const order = input.order ?? {
    id: 190,
    receipt_number: "RCV-20260701-001",
    status: "closed",
    purchase_order_id: 117,
  };
  const summary = input.summary ?? {
    line_count: 2,
    expected_qty: 15,
    received_qty: 0,
    po_receipt_count: 0,
    inventory_lot_count: 0,
    inventory_transaction_count: 0,
  };
  const po = input.po ?? { physical_status: "draft", status: "sent" };

  return {
    execute: vi.fn(async (query: any) => {
      const text = sqlToStr(query);
      if (text.includes("from procurement.receiving_orders") && text.includes("for update")) {
        return { rows: order ? [order] : [] };
      }
      if (text.includes("as line_count") && text.includes("po_receipt_count")) {
        return { rows: [summary] };
      }
      if (text.includes("update procurement.receiving_orders")) {
        return { rows: [{ id: order.id, receipt_number: order.receipt_number, status: "cancelled" }] };
      }
      if (text.includes("from procurement.purchase_orders")) {
        return { rows: po ? [po] : [] };
      }
      return { rows: [] };
    }),
  };
}

describe("ReceivingService - completeAllLines semantics", () => {
  it("should preserve existing partial entries and backfill untouched lines with expectedQty", async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
    };
    const lines = [
      { id: 1, expectedQty: 10, receivedQty: 5, status: "pending" },
      { id: 2, expectedQty: 20, receivedQty: 0, status: "pending" },
      { id: 3, expectedQty: 30, receivedQty: null, status: "pending" },
      { id: 4, expectedQty: 40, receivedQty: 40, status: "complete" },
    ];
    // Mock the storage layer
    const mockStorage = {
      getReceivingLines: vi.fn().mockResolvedValue(lines),
      updateReceivingLine: vi.fn().mockResolvedValue({}),
      updateReceivingOrder: vi.fn().mockResolvedValue({}),
      getReceivingOrderById: vi.fn().mockResolvedValue({ id: 1, status: "open", vendorId: null }),
    };
    const db = { transaction: vi.fn(async (fn) => fn(tx)) };

    const service = new ReceivingService(db as any, {} as any, {} as any, mockStorage as any);

    const result = await service.completeAllLines(1);

    // Assert that we correctly skip the completed line
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledTimes(3);

    // Line 1: Was partially received (5). Should retain its manual 5, NOT go to expected 10.
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(1, {
      receivedQty: 5,
      status: "complete",
    }, tx);

    // Line 2: Untouched (0). Should backfill to expected (20).
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(2, {
      receivedQty: 20,
      status: "complete",
    }, tx);

    // Line 3: Untouched (null). Should backfill to expected (30).
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(3, {
      receivedQty: 30,
      status: "complete",
    }, tx);

    expect(result.updated).toBe(3);
  });
});

describe("ReceivingService - mutation integrity", () => {
  it("rejects every mutation command once a receiving order is closed", async () => {
    const tx = {
      execute: vi.fn(async (query: any) => {
        const text = sqlToStr(query);
        if (text.includes("from procurement.receiving_lines") && text.includes("receiving_order_id")) {
          return { rows: [{ receiving_order_id: 41 }] };
        }
        if (text.includes("from procurement.receiving_orders") && text.includes("for update")) {
          return { rows: [{ id: 41 }] };
        }
        return { rows: [] };
      }),
    };
    const storage = {
      getReceivingOrderById: vi.fn().mockResolvedValue({ id: 41, status: "closed" }),
      getReceivingLineById: vi.fn().mockResolvedValue({ id: 9, receivingOrderId: 41 }),
      getReceivingLines: vi.fn().mockResolvedValue([]),
      createReceivingLine: vi.fn(),
      updateReceivingOrder: vi.fn(),
      updateReceivingLine: vi.fn(),
      deleteReceivingLine: vi.fn(),
      deleteReceivingOrder: vi.fn(),
    };
    const db = { transaction: vi.fn(async (fn) => fn(tx)) };
    const service = new ReceivingService(db as any, {} as any, {} as any, storage as any);

    const commands = [
      service.updateOrderDetails(41, { notes: "changed" }),
      service.addLine(41, { sku: "SKU-1", expectedQty: 1 }),
      service.updateLine(9, { receivedQty: 1 }),
      service.deleteLine(9),
      service.deleteOrder(41),
      service.completeAllLines(41),
    ];
    for (const command of commands) {
      await expect(command).rejects.toMatchObject({
        statusCode: 409,
        details: expect.objectContaining({ code: "RECEIVING_ORDER_IMMUTABLE" }),
      });
    }

    expect(storage.createReceivingLine).not.toHaveBeenCalled();
    expect(storage.updateReceivingOrder).not.toHaveBeenCalled();
    expect(storage.updateReceivingLine).not.toHaveBeenCalled();
    expect(storage.deleteReceivingLine).not.toHaveBeenCalled();
    expect(storage.deleteReceivingOrder).not.toHaveBeenCalled();
  });

  it("locks and rechecks draft status before discarding a receipt", async () => {
    const tx = {
      execute: vi.fn(async (query: any) => {
        const text = sqlToStr(query);
        if (text.includes("from procurement.receiving_orders") && text.includes("for update")) {
          return { rows: [{ id: 42 }] };
        }
        return { rows: [] };
      }),
    };
    const storage = {
      getReceivingOrderById: vi.fn().mockResolvedValue({ id: 42, status: "open" }),
      getReceivingLines: vi.fn(),
    };
    const db = { transaction: vi.fn(async (fn) => fn(tx)) };
    const service = new ReceivingService(db as any, {} as any, {} as any, storage as any);

    await expect(service.discardDraftReceivingOrder(42, "user-1")).rejects.toMatchObject({
      statusCode: 409,
    });

    expect(storage.getReceivingOrderById).toHaveBeenCalledWith(42, tx);
    expect(storage.getReceivingLines).not.toHaveBeenCalled();
    const executedSql = tx.execute.mock.calls.map(([query]) => sqlToStr(query)).join("\n");
    expect(executedSql).not.toContain("delete from procurement.receiving_lines");
    expect(executedSql).not.toContain("delete from procurement.receiving_orders");
  });

  it("rejects request-controlled audit fields on receiving lines", async () => {
    const db = { transaction: vi.fn() };
    const service = new ReceivingService(db as any, {} as any, {} as any, {} as any);

    await expect(service.updateLine(9, { receivedBy: "spoofed-user" })).rejects.toMatchObject({
      statusCode: 400,
      details: expect.objectContaining({
        code: "INVALID_RECEIVING_MUTATION_FIELDS",
        rejectedFields: ["receivedBy"],
      }),
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("ReceivingService - close reconciliation semantics", () => {
  it("blocks closing a shipment receipt when all lines have zero received quantity", async () => {
    const order = {
      id: 190,
      status: "open",
      sourceType: "shipment",
      purchaseOrderId: 117,
    };
    const lines = [
      { id: 2648, expectedQty: 10, receivedQty: 0, productVariantId: 472, putawayLocationId: 1387 },
      { id: 2649, expectedQty: 5, receivedQty: 0, productVariantId: 104, putawayLocationId: 1387 },
    ];
    const mockStorage = {
      getReceivingOrderById: vi.fn().mockResolvedValue(order),
      getReceivingLines: vi.fn().mockResolvedValue(lines),
    };
    const db = { transaction: vi.fn() };
    const inventoryCore = { receiveInventory: vi.fn() };
    const service = new ReceivingService(
      db as any,
      inventoryCore as any,
      {} as any,
      mockStorage as any,
    );

    await expect(service.close(190, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({
        code: "ZERO_SHIPMENT_RECEIPT_NOT_CLOSABLE",
        receivingOrderId: 190,
        expectedLineCount: 2,
        expectedTotalUnits: 15,
      }),
    });
    expect(inventoryCore.receiveInventory).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("blocks closing a shipment receipt that over-receives a line unless allowOverReceipt is passed", async () => {
    const order = {
      id: 191,
      status: "open",
      sourceType: "shipment",
      purchaseOrderId: 118,
    };
    const lines = [
      { id: 2700, sku: "SHLZ-MAG-35PT-SLV", expectedQty: 50, receivedQty: 100, productVariantId: 472, putawayLocationId: 1387 },
      { id: 2701, sku: "EG-SLV-THK-P50", expectedQty: 5, receivedQty: 5, productVariantId: 104, putawayLocationId: 1387 },
    ];
    const mockStorage = {
      getReceivingOrderById: vi.fn().mockResolvedValue(order),
      getReceivingLines: vi.fn().mockResolvedValue(lines),
    };
    const db = { transaction: vi.fn().mockRejectedValue(new Error("SENTINEL_PAST_GUARD")) };
    const inventoryCore = { receiveInventory: vi.fn() };
    const service = new ReceivingService(
      db as any,
      inventoryCore as any,
      {} as any,
      mockStorage as any,
    );

    // Without the override: structured 409 naming the offending lines.
    await expect(service.close(191, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({
        code: "SHIPMENT_OVER_RECEIPT_CONFIRMATION_REQUIRED",
        receivingOrderId: 191,
        overLines: [
          { lineId: 2700, sku: "SHLZ-MAG-35PT-SLV", expectedQty: 50, receivedQty: 100 },
        ],
      }),
    });
    expect(db.transaction).not.toHaveBeenCalled();

    // With the override: the guard steps aside and close proceeds into the
    // posting transaction (the sentinel proves we got past the guard).
    await expect(service.close(191, "user-1", { allowOverReceipt: true })).rejects.toThrow("SENTINEL_PAST_GUARD");
    expect(db.transaction).toHaveBeenCalled();
  });

  it("does not apply the over-receipt guard to non-shipment receipts", async () => {
    const order = {
      id: 192,
      status: "open",
      sourceType: "po",
      purchaseOrderId: 119,
    };
    const lines = [
      { id: 2710, sku: "SHLZ-TOP-35PT", expectedQty: 10, receivedQty: 25, productVariantId: 472, putawayLocationId: 1387 },
    ];
    const mockStorage = {
      getReceivingOrderById: vi.fn().mockResolvedValue(order),
      getReceivingLines: vi.fn().mockResolvedValue(lines),
    };
    const db = { transaction: vi.fn().mockRejectedValue(new Error("SENTINEL_PAST_GUARD")) };
    const inventoryCore = { receiveInventory: vi.fn() };
    const service = new ReceivingService(
      db as any,
      inventoryCore as any,
      {} as any,
      mockStorage as any,
    );

    await expect(service.close(192, "user-1")).rejects.toThrow("SENTINEL_PAST_GUARD");
    expect(db.transaction).toHaveBeenCalled();
  });

  it("treats a concurrent close as a replay without reposting inventory", async () => {
    const updatedAt = new Date("2026-07-20T12:00:00.000Z");
    const openOrder = {
      id: 193,
      status: "open",
      sourceType: "po",
      receiptNumber: "RCV-193",
      updatedAt,
    };
    const closedOrder = {
      ...openOrder,
      status: "closed",
      receivedLineCount: 1,
      receivedTotalUnits: 2,
    };
    const lines = [
      {
        id: 2720,
        expectedQty: 2,
        receivedQty: 2,
        productVariantId: 5,
        putawayLocationId: 12,
        updatedAt,
      },
    ];
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 193 }] }),
    };
    const storage = {
      getReceivingOrderById: vi.fn()
        .mockResolvedValueOnce(openOrder)
        .mockResolvedValueOnce(openOrder)
        .mockResolvedValueOnce(closedOrder),
      getReceivingLines: vi.fn()
        .mockResolvedValueOnce(lines)
        .mockResolvedValueOnce(lines)
        .mockResolvedValueOnce(lines),
    };
    const db = { transaction: vi.fn(async (fn) => fn(tx)) };
    const inventoryCore = { receiveInventory: vi.fn() };
    const channelSync = { queueSyncAfterInventoryChange: vi.fn() };
    const service = new ReceivingService(
      db as any,
      inventoryCore as any,
      channelSync as any,
      storage as any,
    );

    const result = await service.close(193, "user-1");

    expect(inventoryCore.receiveInventory).not.toHaveBeenCalled();
    expect(channelSync.queueSyncAfterInventoryChange).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      order: { id: 193, status: "closed" },
      linesProcessed: 1,
      unitsReceived: 2,
    });
  });

  it("retries PO reconciliation for an already closed receipt without reposting inventory", async () => {
    const lines = [
      {
        id: 501,
        purchaseOrderLineId: 100,
        receivedQty: 3,
        damagedQty: 0,
        unitCost: 500,
        putawayLocationId: 12,
      },
    ];
    const mockStorage = {
      getReceivingOrderById: vi.fn().mockResolvedValue({
        id: 9,
        status: "closed",
        purchaseOrderId: 1,
        receivedLineCount: 1,
        receivedTotalUnits: 3,
      }),
      getReceivingLines: vi.fn().mockResolvedValue(lines),
    };
    const inventoryCore = { receiveInventory: vi.fn() };
    const purchasing = {
      onReceivingOrderClosed: vi.fn().mockResolvedValue({
        purchaseOrderId: 1,
        appliedLines: 1,
        existingReceiptLines: 0,
        skippedLines: 0,
        autoMatchedLines: 0,
        issues: [],
      }),
    };
    const service = new ReceivingService(
      {} as any,
      inventoryCore as any,
      {} as any,
      mockStorage as any,
      purchasing as any,
    );

    const result = await service.close(9, "user-1");

    expect(inventoryCore.receiveInventory).not.toHaveBeenCalled();
    expect(purchasing.onReceivingOrderClosed).toHaveBeenCalledWith(
      9,
      [expect.objectContaining({
        receivingLineId: 501,
        purchaseOrderLineId: 100,
        receivedQty: 3,
        damagedQty: 0,
        unitCost: 500,
      })],
      "user-1",
    );
    expect(result).toMatchObject({
      success: true,
      linesProcessed: 1,
      unitsReceived: 3,
      putawayLocationIds: [12],
    });
  });

  it("surfaces PO reconciliation failures after inventory posting", async () => {
    const updatedAt = new Date("2026-07-20T12:00:00.000Z");
    const order = {
      id: 10,
      status: "open",
      sourceType: "po",
      poNumber: "PO-10",
      purchaseOrderId: 1,
      updatedAt,
    };
    const lines = [
      {
        id: 601,
        productVariantId: 5,
        purchaseOrderLineId: 100,
        receivedQty: 2,
        damagedQty: 0,
        unitCost: 500,
        putawayLocationId: 12,
        updatedAt,
      },
    ];
    const tx = {
      execute: vi.fn(async (query: any) => {
        const text = sqlToStr(query);
        if (text.includes("from procurement.receiving_orders") && text.includes("for update")) {
          return { rows: [{ id: order.id }] };
        }
        if (text.includes("units_per_variant")) {
          return { rows: [{ units_per_variant: 1 }] };
        }
        return { rows: [] };
      }),
    };
    const mockStorage = {
      getReceivingOrderById: vi.fn().mockResolvedValue(order),
      getReceivingLines: vi.fn().mockResolvedValue(lines),
      getProductVariantById: vi.fn().mockResolvedValue({ id: 5, hierarchyLevel: 1 }),
      getProductVariantsByProductId: vi.fn().mockResolvedValue([]),
      updateReceivingLine: vi.fn().mockResolvedValue({}),
      updateReceivingOrder: vi.fn().mockResolvedValue({
        ...order,
        status: "closed",
        receivedLineCount: 1,
        receivedTotalUnits: 2,
      }),
    };
    const db = {
      transaction: vi.fn(async (fn) => fn(tx)),
    };
    const inventoryCore = { receiveInventory: vi.fn().mockResolvedValue(undefined) };
    const channelSync = { queueSyncAfterInventoryChange: vi.fn().mockResolvedValue(undefined) };
    const purchasing = {
      onReceivingOrderClosed: vi.fn().mockRejectedValue(new Error("PO reconcile failed")),
    };
    const reconciliationFailureReporter = vi.fn().mockResolvedValue(undefined);
    const service = new ReceivingService(
      db as any,
      inventoryCore as any,
      channelSync as any,
      mockStorage as any,
      purchasing as any,
      null,
      reconciliationFailureReporter,
    );

    await expect(service.close(10, "user-1")).rejects.toThrow("PO reconcile failed");
    expect(inventoryCore.receiveInventory).toHaveBeenCalledOnce();
    expect(purchasing.onReceivingOrderClosed).toHaveBeenCalledOnce();
    expect(reconciliationFailureReporter).toHaveBeenCalledWith(expect.objectContaining({
      purchaseOrderId: 1,
      receivingOrderId: 10,
      userId: "user-1",
      message: "PO reconcile failed",
    }));
  });

  it("finalizes shipment receipt line statuses from received quantity on close", async () => {
    const events: string[] = [];
    const updatedAt = new Date("2026-07-20T12:00:00.000Z");
    const order = {
      id: 11,
      status: "open",
      sourceType: "shipment",
      receiptNumber: "RCV-11",
      inboundShipmentId: 84,
      updatedAt,
    };
    const lines = [
      { id: 701, expectedQty: 10, receivedQty: 4, productVariantId: 5, putawayLocationId: 12, status: "partial", updatedAt },
      { id: 702, expectedQty: 5, receivedQty: 0, productVariantId: 6, putawayLocationId: 13, status: "pending", updatedAt },
      { id: 703, expectedQty: 3, receivedQty: 3, productVariantId: 7, putawayLocationId: 14, status: "complete", updatedAt },
    ];
    const tx = {
      execute: vi.fn(async (query: any) => {
        const text = sqlToStr(query);
        if (text.includes("from procurement.receiving_orders") && text.includes("for update")) {
          return { rows: [{ id: order.id }] };
        }
        return { rows: [{ units_per_variant: 1 }] };
      }),
    };
    const mockStorage = {
      getReceivingOrderById: vi.fn().mockResolvedValue(order),
      getReceivingLines: vi.fn()
        .mockResolvedValueOnce(lines)
        .mockResolvedValueOnce(lines)
        .mockResolvedValueOnce(lines)
        .mockResolvedValueOnce([
          { ...lines[0], status: "short" },
          { ...lines[1], status: "short" },
          { ...lines[2], status: "complete" },
        ]),
      updateReceivingLine: vi.fn().mockResolvedValue({}),
      updateReceivingOrder: vi.fn().mockResolvedValue({
        ...order,
        status: "closed",
        receivedLineCount: 2,
        receivedTotalUnits: 7,
      }),
    };
    const db = {
      transaction: vi.fn(async (fn) => {
        events.push("transaction-start");
        const result = await fn(tx);
        events.push("transaction-committed");
        return result;
      }),
    };
    const inventoryCore = { receiveInventory: vi.fn().mockResolvedValue(undefined) };
    const channelSync = {
      queueSyncAfterInventoryChange: vi.fn().mockImplementation(async () => {
        events.push("channel-sync-enqueued");
      }),
    };
    const service = new ReceivingService(
      db as any,
      inventoryCore as any,
      channelSync as any,
      mockStorage as any,
    );

    const result = await service.close(11, "user-1");

    expect(inventoryCore.receiveInventory).toHaveBeenCalledTimes(2);
    expect(inventoryCore.receiveInventory).toHaveBeenCalledWith(
      expect.objectContaining({ receivingLineId: 701 }),
      tx,
    );
    expect(events.indexOf("transaction-committed")).toBeLessThan(
      events.indexOf("channel-sync-enqueued"),
    );
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(701, expect.objectContaining({ status: "short" }), tx);
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(702, { status: "short" }, tx);
    expect(mockStorage.updateReceivingLine).toHaveBeenCalledWith(703, expect.objectContaining({ status: "complete" }), tx);
    expect(result).toMatchObject({
      success: true,
      linesProcessed: 2,
      unitsReceived: 7,
    });
  });
});

describe("ReceivingService - zero-post closed receipt recovery", () => {
  it("voids a closed receipt only when no inventory or PO receipt rows were posted", async () => {
    const tx = makeZeroPostVoidTx({});
    const db = {
      transaction: vi.fn(async (fn) => fn(tx)),
      execute: vi.fn(),
    };
    const service = new ReceivingService(db as any, {} as any, {} as any, {} as any);

    const result = await service.voidZeroPostClosedReceivingOrder(190, "user-1");

    expect(result).toMatchObject({
      success: true,
      receivingOrderId: 190,
      receiptNumber: "RCV-20260701-001",
      previousStatus: "closed",
      status: "cancelled",
      lineCount: 2,
      expectedQty: 15,
    });
    const executedSql = tx.execute.mock.calls.map(([query]) => sqlToStr(query)).join("\n");
    expect(executedSql).toContain("update procurement.receiving_lines");
    expect(executedSql).toContain("set status = 'cancelled'");
    expect(executedSql).toContain("insert into procurement.po_status_history");
  });

  it("refuses zero-post recovery when ledger or inventory side effects exist", async () => {
    const tx = makeZeroPostVoidTx({
      summary: {
        line_count: 2,
        expected_qty: 15,
        received_qty: 0,
        po_receipt_count: 1,
        inventory_lot_count: 0,
        inventory_transaction_count: 0,
      },
    });
    const db = {
      transaction: vi.fn(async (fn) => fn(tx)),
      execute: vi.fn(),
    };
    const service = new ReceivingService(db as any, {} as any, {} as any, {} as any);

    await expect(service.voidZeroPostClosedReceivingOrder(190, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({
        code: "RECEIPT_HAS_POSTED_EFFECTS",
        receivingOrderId: 190,
      }),
    });
    const executedSql = tx.execute.mock.calls.map(([query]) => sqlToStr(query)).join("\n");
    expect(executedSql).not.toContain("update procurement.receiving_orders");
  });
});
