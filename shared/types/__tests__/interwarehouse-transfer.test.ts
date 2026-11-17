import { describe, expect, it } from "vitest";

import {
  createInterwarehouseTransferSchema,
  deriveInterwarehouseTransferStatus,
  receiveInterwarehouseTransferSchema,
} from "../interwarehouse-transfer";

describe("inter-warehouse transfer contract", () => {
  it("accepts a dispatch intent and rejects same-location or fractional quantities", () => {
    const valid = { commandKey: "inventory:test:1", fromLocationId: 1, toLocationId: 2, variantId: 3, quantity: 50 };
    expect(createInterwarehouseTransferSchema.parse(valid)).toEqual(valid);
    expect(createInterwarehouseTransferSchema.safeParse({ ...valid, toLocationId: 1 }).success).toBe(false);
    expect(createInterwarehouseTransferSchema.safeParse({ ...valid, quantity: 1.5 }).success).toBe(false);
  });

  it("requires damage notes and at least one accounted unit", () => {
    expect(receiveInterwarehouseTransferSchema.safeParse({ commandKey: "inventory:test:2", quantity: 0, damagedQuantity: 0 }).success).toBe(false);
    expect(receiveInterwarehouseTransferSchema.safeParse({ commandKey: "inventory:test:2", quantity: 0, damagedQuantity: 2 }).success).toBe(false);
    expect(receiveInterwarehouseTransferSchema.parse({ commandKey: "inventory:test:2", quantity: 0, damagedQuantity: 2, notes: "Crushed" }))
      .toMatchObject({ quantity: 0, damagedQuantity: 2 });
  });

  it("derives lifecycle status from conserved custody counters", () => {
    const base = { requestedQuantity: 10, dispatchedQuantity: 10, receivedQuantity: 0, damagedQuantity: 0, lostQuantity: 0, cancelledQuantity: 0 };
    expect(deriveInterwarehouseTransferStatus(base)).toBe("in_transit");
    expect(deriveInterwarehouseTransferStatus({ ...base, receivedQuantity: 4 })).toBe("partially_received");
    expect(deriveInterwarehouseTransferStatus({ ...base, receivedQuantity: 10 })).toBe("completed");
    expect(deriveInterwarehouseTransferStatus({ ...base, receivedQuantity: 9, damagedQuantity: 1 })).toBe("closed_with_variance");
    expect(deriveInterwarehouseTransferStatus({ ...base, receivedQuantity: 9, lostQuantity: 1 })).toBe("closed_with_variance");
  });
});
