import { describe, expect, it, vi } from "vitest";

import {
  applyRefundAuthorityToWmsOrderItem,
  insertWmsOrderItems,
  persistCanonicalWmsPickProgress,
  persistWmsOrderItemPickProgress,
  reconcileWmsOrderItemAuthority,
  replaceUnstartedWmsOrderItemsForRepair,
} from "../../order-item-commands";

function updateExecutor(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });

  return {
    executor: {
      execute: vi.fn(),
      insert: vi.fn(),
      update,
      delete: vi.fn(),
      select: vi.fn(),
    },
    set,
    update,
  };
}

describe("WMS order-item command boundary", () => {
  it("rejects a materialized line whose picked quantity exceeds its authority", async () => {
    const insert = vi.fn();

    await expect(
      insertWmsOrderItems(
        {
          execute: vi.fn(),
          insert,
          update: vi.fn(),
          delete: vi.fn(),
          select: vi.fn(),
        },
        [
          {
            orderId: 42,
            sku: "SKU-1",
            name: "Item",
            quantity: 1,
            pickedQuantity: 2,
          } as any,
        ],
      ),
    ).rejects.toMatchObject({
      code: "PICKED_QUANTITY_EXCEEDS_LINE_QUANTITY",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects channel authority below already picked physical progress", async () => {
    const { executor, update } = updateExecutor([]);
    executor.execute.mockResolvedValue({
      rows: [
        {
          id: 77,
          order_id: 42,
          quantity: 3,
          picked_quantity: 2,
          fulfilled_quantity: 1,
          status: "in_progress",
        },
      ],
    });

    await expect(
      reconcileWmsOrderItemAuthority(executor as any, {
        itemId: 77,
        orderId: 42,
        authorityQuantity: 1,
      }),
    ).rejects.toMatchObject({
      code: "AUTHORITY_BELOW_PHYSICAL_PROGRESS",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("does not reopen a fully picked line when shipped quantity trails picked quantity", async () => {
    const returned = {
      id: 77,
      orderId: 42,
      quantity: 2,
      pickedQuantity: 2,
      fulfilledQuantity: 1,
      status: "completed",
    };
    const { executor, set } = updateExecutor([returned]);
    executor.execute.mockResolvedValue({
      rows: [
        {
          id: 77,
          order_id: 42,
          quantity: 2,
          picked_quantity: 2,
          fulfilled_quantity: 1,
          status: "completed",
        },
      ],
    });

    const result = await reconcileWmsOrderItemAuthority(executor as any, {
      itemId: 77,
      orderId: 42,
      authorityQuantity: 2,
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 2, status: "completed" }),
    );
    expect(result).toEqual(returned);
  });

  it("blocks destructive line replacement after pick or shipment progress", async () => {
    const deleteRows = vi.fn();
    const insert = vi.fn();
    const executor = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 77,
            picked_quantity: 0,
            fulfilled_quantity: 0,
            has_shipment_link: true,
          },
        ],
      }),
      insert,
      update: vi.fn(),
      delete: deleteRows,
      select: vi.fn(),
    };

    await expect(
      replaceUnstartedWmsOrderItemsForRepair(executor as any, {
        orderId: 42,
        items: [
          {
            orderId: 42,
            sku: "SKU-1",
            name: "Item",
            quantity: 1,
          } as any,
        ],
      }),
    ).rejects.toMatchObject({
      code: "DESTRUCTIVE_REPAIR_BLOCKED",
      context: expect.objectContaining({ hasShipmentLink: true }),
    });
    expect(deleteRows).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("uses the caller's locked refund snapshot without re-reading the row", async () => {
    const { executor, update } = updateExecutor([]);
    executor.execute.mockResolvedValue({ rows: [] });

    const result = await applyRefundAuthorityToWmsOrderItem(executor as any, {
      current: {
        id: 77,
        orderId: 42,
        quantity: 3,
        pickedQuantity: 0,
        fulfilledQuantity: 0,
        status: "pending",
        shortReason: null,
        onHold: false,
      },
      authorityFulfillableQuantity: 2,
      restockPolicy: "no_restock",
    });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const query = JSON.stringify(executor.execute.mock.calls[0][0]);
    expect(query).toContain("UPDATE wms.order_items");
    expect(query).not.toContain("SELECT");
    expect(result).toMatchObject({
      changed: true,
      item: { id: 77, quantity: 2, status: "pending" },
    });
  });

  it("preserves physical progress and flags a refund received after picking", async () => {
    const { executor, update } = updateExecutor([]);
    executor.execute.mockResolvedValue({ rows: [] });

    const result = await applyRefundAuthorityToWmsOrderItem(executor as any, {
      current: {
        id: 78,
        orderId: 42,
        quantity: 3,
        pickedQuantity: 3,
        fulfilledQuantity: 1,
        status: "completed",
        shortReason: null,
        onHold: false,
      },
      authorityFulfillableQuantity: 1,
      restockPolicy: "no_restock",
    });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const query = JSON.stringify(executor.execute.mock.calls[0][0]);
    expect(query).toContain("refund_after_pick");
    expect(query).toContain("short");
    expect(result).toMatchObject({
      changed: true,
      manualReviewReason: "refund_after_pick",
      item: {
        quantity: 3,
        pickedQuantity: 3,
        fulfilledQuantity: 1,
        status: "short",
      },
    });
  });

  it("rejects invalid pick progress before issuing a database write", async () => {
    const { executor, update } = updateExecutor([]);

    await expect(
      persistWmsOrderItemPickProgress(executor as any, {
        itemId: 77,
        status: "pending",
        pickedQuantity: -1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(update).not.toHaveBeenCalled();
  });

  it("writes a canonical partial-short reason in the same guarded progress update", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 77 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await persistCanonicalWmsPickProgress({ query }, {
      movementType: "pick",
      movementQuantity: 2,
      orderId: 42,
      orderItemId: 77,
      targetVariantId: 105,
      warehouseLocationId: 9,
      occurredAt: new Date("2026-09-11T12:00:00Z"),
      progress: {
        expectedStatus: "pending",
        expectedPickedQuantity: 0,
        targetStatus: "short",
        targetPickedQuantity: 2,
        targetShortReason: "partial",
      },
    });

    expect(query.mock.calls[0]?.[0]).toContain("short_reason = CASE WHEN $8::boolean THEN $9::text");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "short",
      2,
      new Date("2026-09-11T12:00:00Z"),
      77,
      42,
      "pending",
      0,
      true,
      "partial",
    ]);
  });

  it("rejects a short reason attached to non-short canonical progress", async () => {
    const query = vi.fn();

    await expect(persistCanonicalWmsPickProgress({ query }, {
      movementType: "pick",
      movementQuantity: 1,
      orderId: 42,
      orderItemId: 77,
      targetVariantId: 105,
      warehouseLocationId: 9,
      occurredAt: new Date("2026-09-11T12:00:00Z"),
      progress: {
        expectedStatus: "pending",
        expectedPickedQuantity: 0,
        targetStatus: "in_progress",
        targetPickedQuantity: 1,
        targetShortReason: "partial",
      },
    })).rejects.toMatchObject({ code: "INVALID_WMS_PICK_PROGRESS" });
    expect(query).not.toHaveBeenCalled();
  });

  it("reverses canonical short progress and clears the obsolete short reason", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 77 }], rowCount: 1 });

    await persistCanonicalWmsPickProgress({ query }, {
      movementType: "unpick",
      movementQuantity: 1,
      orderId: 42,
      orderItemId: 77,
      occurredAt: new Date("2026-09-11T12:00:00Z"),
      progress: {
        expectedStatus: "short",
        expectedPickedQuantity: 2,
        targetStatus: "in_progress",
        targetPickedQuantity: 1,
      },
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("short_reason = CASE WHEN $5 = 'short' THEN NULL");
    expect(query.mock.calls[0]?.[1]).toEqual(["in_progress", 1, 77, 42, "short", 2]);
  });
});
