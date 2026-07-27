import { describe, expect, it, vi } from "vitest";
import {
  appendUncoveredItemsToShipment,
  movePendingShipmentItemsToLateEditResidual,
} from "../../late-order-shipment-coverage";
import {
  PROVIDER_MEMBERSHIP_PENDING_APPEND,
} from "../../create-shipment";

function scriptedDb(results: Array<{ rows: any[] }>) {
  const remaining = [...results];
  const execute = vi.fn(async () => {
    const next = remaining.shift();
    if (!next) {
      throw new Error("unexpected database query");
    }
    return next;
  });
  return {
    db: {
      execute,
      insert: vi.fn(),
    },
    execute,
    remaining,
  };
}

describe("appendUncoveredItemsToShipment", () => {
  it("adds only uncovered quantity and records pending provider membership", async () => {
    const mock = scriptedDb([
      { rows: [{}] }, // advisory transaction lock
      { rows: [{ id: 300 }] }, // target shipment
      {
        rows: [
          {
            id: 11,
            quantity: 5,
            fulfilled_quantity: 1,
            product_id: 77,
          },
        ],
      },
      { rows: [{ order_item_id: 11, covered_qty: 2 }] },
      { rows: [{ product_variant_id: 77, from_location_id: 88 }] },
      { rows: [{ id: 901 }] },
    ]);

    const result = await appendUncoveredItemsToShipment(
      mock.db as any,
      200,
      300,
      [11],
      {
        providerMembershipState: PROVIDER_MEMBERSHIP_PENDING_APPEND,
        useXactLock: true,
      },
    );

    expect(result).toEqual({
      shipmentId: 300,
      shipmentItemIds: [901],
      addedQuantity: 3,
    });
    expect(mock.remaining).toHaveLength(0);
  });

  it("does not create duplicate coverage when active packages already cover demand", async () => {
    const mock = scriptedDb([
      { rows: [{}] },
      { rows: [{ id: 300 }] },
      {
        rows: [
          {
            id: 11,
            quantity: 5,
            fulfilled_quantity: 0,
            product_id: 77,
          },
        ],
      },
      { rows: [{ order_item_id: 11, covered_qty: 5 }] },
    ]);

    const result = await appendUncoveredItemsToShipment(
      mock.db as any,
      200,
      300,
      [11],
      {
        providerMembershipState: PROVIDER_MEMBERSHIP_PENDING_APPEND,
        useXactLock: true,
      },
    );

    expect(result).toEqual({
      shipmentId: 300,
      shipmentItemIds: [],
      addedQuantity: 0,
    });
    expect(mock.remaining).toHaveLength(0);
  });
});

describe("movePendingShipmentItemsToLateEditResidual", () => {
  it("moves exact pending rows into one residual package instead of copying them", async () => {
    const mock = scriptedDb([
      { rows: [{ order_id: 200, channel_id: 36 }] },
      { rows: [{}] }, // advisory transaction lock
      {
        rows: [
          {
            id: 901,
            shipment_id: 300,
            qty: 2,
            provider_membership_state: "pending_append",
            source: "echelon_sync",
          },
        ],
      },
      { rows: [] }, // no existing residual
      { rows: [{ id: 700 }] }, // create residual
      { rows: [{ id: 901 }] }, // update/move exact row
    ]);

    const result = await movePendingShipmentItemsToLateEditResidual(
      mock.db as any,
      300,
      [901],
      { useXactLock: true },
    );

    expect(result).toEqual({
      sourceShipmentId: 300,
      residualShipmentId: 700,
      shipmentItemIds: [901],
      movedQuantity: 2,
      alreadyMoved: false,
      nextAction: "push",
    });
    expect(mock.remaining).toHaveLength(0);
  });

  it("is idempotent when the exact rows were already moved by an earlier retry", async () => {
    const mock = scriptedDb([
      { rows: [{ order_id: 200, channel_id: 36 }] },
      { rows: [{}] },
      {
        rows: [
          {
            id: 901,
            shipment_id: 700,
            qty: 2,
            provider_membership_state: "authoritative",
            source: "late_order_edit",
          },
        ],
      },
    ]);

    const result = await movePendingShipmentItemsToLateEditResidual(
      mock.db as any,
      300,
      [901],
      { useXactLock: true },
    );

    expect(result).toEqual({
      sourceShipmentId: 300,
      residualShipmentId: 700,
      shipmentItemIds: [901],
      movedQuantity: 2,
      alreadyMoved: true,
      nextAction: "none",
    });
    expect(mock.remaining).toHaveLength(0);
  });

  it("reuses a queued residual and requests an in-place provider amendment", async () => {
    const mock = scriptedDb([
      { rows: [{ order_id: 200, channel_id: 36 }] },
      { rows: [{}] },
      {
        rows: [
          {
            id: 901,
            shipment_id: 300,
            qty: 2,
            provider_membership_state: "pending_append",
            source: "echelon_sync",
            status: "shipped",
          },
        ],
      },
      { rows: [{ id: 700, status: "queued" }] },
      { rows: [{ id: 901 }] },
    ]);

    const result = await movePendingShipmentItemsToLateEditResidual(
      mock.db as any,
      300,
      [901],
      { useXactLock: true },
    );

    expect(result).toEqual({
      sourceShipmentId: 300,
      residualShipmentId: 700,
      shipmentItemIds: [901],
      movedQuantity: 2,
      alreadyMoved: false,
      nextAction: "amend",
    });
    expect(mock.remaining).toHaveLength(0);
  });
  it("rejects rows that are no longer pending on the expected source package", async () => {
    const mock = scriptedDb([
      { rows: [{ order_id: 200, channel_id: 36 }] },
      { rows: [{}] },
      {
        rows: [
          {
            id: 901,
            shipment_id: 301,
            qty: 2,
            provider_membership_state: "authoritative",
            source: "echelon_sync",
          },
        ],
      },
    ]);

    await expect(
      movePendingShipmentItemsToLateEditResidual(
        mock.db as any,
        300,
        [901],
        { useXactLock: true },
      ),
    ).rejects.toThrow(/not pending append on source shipment 300/);
  });
});
