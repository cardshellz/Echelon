import { describe, expect, it } from "vitest";
import { deriveWmsShippingProgress, WmsShippingProgressError, type WmsShippingProgressLine } from "../wms-shipping-progress";
import type { WmsWarehouseStatus } from "../enums/order-status";

const line = (overrides: Partial<WmsShippingProgressLine> = {}): WmsShippingProgressLine => ({
  id: 1, requiresShipping: true, cancelled: false, quantity: 2, authorizedQuantity: 2,
  pickedQuantity: 0, shippedQuantity: 0, ...overrides,
});

describe("physical order line shipping progress", () => {
  it.each(["ready", "shipped", "partially_shipped", "ready_to_ship"] as const)(
    "donation-only fulfillment leaves four unshipped physical lines ready from %s", status => {
      const lines = [line({ requiresShipping: false, shippedQuantity: 1, pickedQuantity: 1 }),
        ...[2, 3, 4, 5].map(id => line({ id, quantity: 1, authorizedQuantity: 1 }))];
      expect(deriveWmsShippingProgress(status, lines)).toBe("ready");
    },
  );
  it("requires coverage on each line, not order-wide unit totals", () => {
    expect(deriveWmsShippingProgress("pending", [line()])).toBe("ready");
    expect(deriveWmsShippingProgress("pending", [line({ shippedQuantity: 2 })])).toBe("shipped");
    expect(deriveWmsShippingProgress("ready", [line({ shippedQuantity: 4 }), line({ id: 2 })]))
      .toBe("partially_shipped");
  });
  it("accepts split package quantities only up to their own order line", () => {
    expect(deriveWmsShippingProgress("ready", [line({ shippedQuantity: 2 })])).toBe("shipped");
    expect(deriveWmsShippingProgress("ready", [line({ shippedQuantity: 1 })])).toBe("partially_shipped");
  });
  it("keeps a backordered/short line outstanding until cancellation or shipment", () => {
    expect(deriveWmsShippingProgress("exception", [line({ shippedQuantity: 2 }), line({ id: 2 })]))
      .toBe("partially_shipped");
    expect(deriveWmsShippingProgress("exception", [line({ shippedQuantity: 2 }), line({ id: 2, cancelled: true })]))
      .toBe("shipped");
    expect(deriveWmsShippingProgress("ready", [line({ shippedQuantity: 1, authorizedQuantity: 1 })])).toBe("shipped");
  });
  it.each(["on_hold", "exception", "awaiting_3pl", "picking"] as const)("preserves %s without shipping evidence", status => {
    expect(deriveWmsShippingProgress(status, [line()])).toBe(status);
  });
  it.each(["picked", "packing", "packed", "completed", "ready_to_ship"] as const)("preserves proven pick progress in %s", status => {
    expect(deriveWmsShippingProgress(status, [line({ pickedQuantity: 2 })])).toBe(status);
    expect(deriveWmsShippingProgress(status, [line()])).toBe("ready");
  });
  it("does not cancel the order because every shipment was cancelled", () => {
    expect(deriveWmsShippingProgress("ready", [line()])).toBe("ready");
    expect(deriveWmsShippingProgress("cancelled", [line()])).toBe("cancelled");
    expect(deriveWmsShippingProgress("cancelled", [line({ shippedQuantity: 2 })])).toBe("shipped");
  });
  it("preserves explicitly nonshipping/no-demand lifecycle without inventing shipment", () => {
    expect(deriveWmsShippingProgress("ready", [line({ requiresShipping: false, shippedQuantity: 2 })])).toBe("ready");
    expect(deriveWmsShippingProgress("completed", [])).toBe("completed");
    expect(deriveWmsShippingProgress("ready", [line({ quantity: 0, authorizedQuantity: 0 })])).toBe("ready");
  });
  it("derives partial picks and safely accepts the largest supported integer", () => {
    expect(deriveWmsShippingProgress("ready", [line({ pickedQuantity: 1 })])).toBe("in_progress");
    expect(deriveWmsShippingProgress("ready", [line({ pickedQuantity: 2 })])).toBe("in_progress");
    expect(deriveWmsShippingProgress("ready", [line({ quantity: Number.MAX_SAFE_INTEGER,
      authorizedQuantity: null, shippedQuantity: Number.MAX_SAFE_INTEGER })])).toBe("shipped");
  });
  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid quantity %s", shippedQuantity => {
    expect(() => deriveWmsShippingProgress("ready", [line({ shippedQuantity })])).toThrow(WmsShippingProgressError);
  });
  it("rejects duplicate identities/unknown states and never mutates input", () => {
    expect(() => deriveWmsShippingProgress("ready", [line(), line()])).toThrow("Duplicate");
    expect(() => deriveWmsShippingProgress("unknown" as WmsWarehouseStatus, [line()])).toThrow();
    const input = Object.freeze([Object.freeze(line({ shippedQuantity: 2 }))]);
    expect(deriveWmsShippingProgress("ready", input)).toBe("shipped");
    expect(input[0]).toEqual(line({ shippedQuantity: 2 }));
  });
});
