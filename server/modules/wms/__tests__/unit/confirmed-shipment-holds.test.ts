import { describe, expect, it } from "vitest";
import { confirmedShipmentHoldRelease } from "../../confirmed-shipment-holds";
import { heldShipmentReleaseAction } from "../../line-item-hold";

// 2026-10-02: pre-order lines were held, ShipStation shipped them anyway, and a
// picker's "Yes, it shipped" could never be recorded because every step refused
// held work. These rules retire only the holds the shipment made meaningless.

const facts = (overrides: Partial<Parameters<typeof confirmedShipmentHoldRelease>[0]> = {}) => ({
  lineOnHold: true, lineQuantity: 1, declaredShippedQuantity: 1,
  orderOnHold: false, orderShipped: true, ...overrides,
});

describe("confirmedShipmentHoldRelease", () => {
  it("retires the hold on a fully shipped line", () => {
    expect(confirmedShipmentHoldRelease(facts())).toEqual({ releaseLine: true, releaseOrder: false });
  });

  it("keeps a line hold that still protects units which have not shipped", () => {
    expect(confirmedShipmentHoldRelease(facts({ lineQuantity: 3, declaredShippedQuantity: 2 })).releaseLine).toBe(false);
  });

  it("retires an order hold only once the whole order has shipped", () => {
    expect(confirmedShipmentHoldRelease(facts({ orderOnHold: true })).releaseOrder).toBe(true);
    expect(confirmedShipmentHoldRelease(facts({ orderOnHold: true, orderShipped: false })).releaseOrder).toBe(false);
  });

  it("changes nothing when nothing is held", () => {
    expect(confirmedShipmentHoldRelease(facts({ lineOnHold: false }))).toEqual({ releaseLine: false, releaseOrder: false });
  });

  it("never treats a zero-quantity line as fully shipped", () => {
    expect(confirmedShipmentHoldRelease(facts({ lineQuantity: 0, declaredShippedQuantity: 0 })).releaseLine).toBe(false);
  });

  it("rejects invalid quantities instead of guessing", () => {
    expect(() => confirmedShipmentHoldRelease(facts({ lineQuantity: -1 }))).toThrow("lineQuantity");
    expect(() => confirmedShipmentHoldRelease(facts({ declaredShippedQuantity: 1.5 }))).toThrow("declaredShippedQuantity");
  });
});

describe("heldShipmentReleaseAction", () => {
  it("pushes a released line only while none of it has shipped", () => {
    expect(heldShipmentReleaseAction({ quantity: 2, fulfilledQuantity: 0 })).toBe("push");
  });

  it("cancels the held shipment of a line that already shipped, so ShipStation never gets a second order", () => {
    expect(heldShipmentReleaseAction({ quantity: 2, fulfilledQuantity: 2 })).toBe("cancel_already_shipped");
    expect(heldShipmentReleaseAction({ quantity: 2, fulfilledQuantity: 3 })).toBe("cancel_already_shipped");
  });

  it("sends a partly shipped line to review because its held shipment still covers shipped units", () => {
    expect(heldShipmentReleaseAction({ quantity: 3, fulfilledQuantity: 1 })).toBe("review_partially_shipped");
  });

  it("rejects invalid quantities", () => {
    expect(() => heldShipmentReleaseAction({ quantity: -1, fulfilledQuantity: 0 })).toThrow();
  });
});
