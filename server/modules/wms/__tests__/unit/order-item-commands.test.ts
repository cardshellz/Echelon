import { describe, expect, it, vi } from "vitest";

import {
  applyRefundAuthorityToWmsOrderItem,
  insertWmsOrderItems,
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
});
