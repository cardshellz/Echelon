import { describe, expect, it } from "vitest";
import { deriveReconciledWmsOrderItemStatus } from "../../wms-line-reconciliation";

describe("deriveReconciledWmsOrderItemStatus", () => {
  it("reopens a previously fulfilled line when channel authority increases", () => {
    expect(
      deriveReconciledWmsOrderItemStatus({
        authorityQuantity: 2,
        pickedQuantity: 1,
        fulfilledQuantity: 1,
      }),
    ).toBe("in_progress");
  });

  it("keeps a line completed when the full authoritative quantity is picked", () => {
    expect(
      deriveReconciledWmsOrderItemStatus({
        authorityQuantity: 2,
        pickedQuantity: 2,
        fulfilledQuantity: 0,
      }),
    ).toBe("completed");
  });

  it("returns pending when no authoritative units have been picked", () => {
    expect(
      deriveReconciledWmsOrderItemStatus({
        authorityQuantity: 3,
        pickedQuantity: 0,
        fulfilledQuantity: 0,
      }),
    ).toBe("pending");
  });

  it("cancels a zero-authority unpicked line", () => {
    expect(
      deriveReconciledWmsOrderItemStatus({
        authorityQuantity: 0,
        pickedQuantity: 0,
        fulfilledQuantity: 0,
      }),
    ).toBe("cancelled");
  });

  it("rejects malformed progress instead of deriving an unsafe status", () => {
    expect(() =>
      deriveReconciledWmsOrderItemStatus({
        authorityQuantity: 1.5,
        pickedQuantity: 0,
        fulfilledQuantity: 0,
      }),
    ).toThrow("authorityQuantity must be a non-negative integer");
  });
});
