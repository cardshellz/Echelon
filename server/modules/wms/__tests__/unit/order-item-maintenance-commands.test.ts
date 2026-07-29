import { describe, expect, it, vi } from "vitest";

import {
  clearHistoricalOrphanOmsLineReferences,
  closeReopenedFullyPickedWmsOrderItems,
  recoverCompletedWmsOrderItemPickState,
  repairOpenWmsOrderItemBarcode,
} from "../../order-item-maintenance-commands";

function queryExecutor(rowCount = 1) {
  return {
    query: vi.fn().mockResolvedValue({
      rows: Array.from({ length: rowCount }, (_, index) => ({ id: index + 1 })),
      rowCount,
    }),
  };
}

describe("WMS order-item maintenance commands", () => {
  it("rejects an empty repair scope before issuing SQL", async () => {
    const executor = queryExecutor();

    await expect(
      clearHistoricalOrphanOmsLineReferences(executor as any, []),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(executor.query).not.toHaveBeenCalled();
  });

  it("revalidates historical orphan safety in the owner command", async () => {
    const executor = queryExecutor(2);

    await expect(
      clearHistoricalOrphanOmsLineReferences(executor as any, [10, 11]),
    ).resolves.toBe(2);

    const [statement, values] = executor.query.mock.calls[0];
    expect(statement).toContain("NOT EXISTS");
    expect(statement).toContain("FROM oms.oms_order_lines");
    expect(statement).toContain(
      "o.warehouse_status IN ('shipped', 'completed', 'cancelled')",
    );
    expect(values).toEqual([[10, 11]]);
  });

  it("closes only shipping lines that are fully picked and still open", async () => {
    const executor = queryExecutor();

    await closeReopenedFullyPickedWmsOrderItems(executor as any, [12]);

    const [statement] = executor.query.mock.calls[0];
    expect(statement).toContain("COALESCE(oi.requires_shipping, 0) = 1");
    expect(statement).toContain(
      "COALESCE(oi.picked_quantity, 0) >= oi.quantity",
    );
    expect(statement).toContain(
      "COALESCE(oi.status, '') IN ('pending', 'in_progress')",
    );
  });

  it("validates recovered pick state before mutating a line", async () => {
    const executor = queryExecutor();

    await expect(
      recoverCompletedWmsOrderItemPickState(executor as any, {
        itemId: 12,
        locationCode: "A-01",
        zone: "A",
        pickedQuantity: 0,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(executor.query).not.toHaveBeenCalled();
  });

  it("parameterizes the legacy barcode repair and limits it to open orders", async () => {
    const executor = queryExecutor();

    await repairOpenWmsOrderItemBarcode(executor as any, {
      sku: "SKU-1",
      incorrectBarcode: "OLD",
      correctBarcode: "NEW",
    });

    const [statement, values] = executor.query.mock.calls[0];
    expect(statement).toContain("UPDATE wms.order_items");
    expect(statement).toContain(
      "o.warehouse_status IN ('ready', 'picking', 'in_progress')",
    );
    expect(values).toEqual(["NEW", "SKU-1", "OLD"]);
  });
});
