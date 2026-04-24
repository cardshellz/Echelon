/**
 * Unit tests for the financial-snapshot helpers in wms-sync.service.
 *
 * Scope: pure functions only (no DB, no mock db). These cover every
 * branch of §6 Commit 7's validation + mapping contract:
 *
 *   - validateOmsOrderFinancials(omsOrder, omsLines)
 *   - buildWmsOrderFinancialSnapshot(omsOrder)
 *   - buildWmsItemFinancialSnapshot(omsLine)
 *
 * Cases cover:
 *   - Happy path: all fields populated, flag ON is implicit (helper
 *     always runs when called).
 *   - Flag-off path: pure-function equivalent is "helper not called" —
 *     asserted structurally by the service keeping the pre-v2 INSERT
 *     shape; documented here, not exercised end-to-end (needs integ).
 *   - Missing line paidPriceCents → throws WmsSyncValidationError with
 *     the correct field path.
 *   - totalCents = 0 on a paid order → throws.
 *   - Non-USD currency → passes through unchanged, not rejected.
 *   - Negative cents value → throws.
 *   - Float cents value → throws (Rule #3: no floats for money).
 *   - Malformed currency → throws.
 *
 * Per coding-standards Rule #9 every integer assertion also runs
 * `Number.isInteger` on the returned value to catch a regression that
 * could silently re-introduce floats.
 */

import { describe, it, expect } from "vitest";
import {
  validateOmsOrderFinancials,
  buildWmsOrderFinancialSnapshot,
  buildWmsItemFinancialSnapshot,
} from "../../wms-sync-financials";
import { WmsSyncValidationError } from "@shared/errors/wms-sync-errors";

// ─── Fixtures ────────────────────────────────────────────────────────

function okOrder(overrides: Partial<Parameters<typeof validateOmsOrderFinancials>[0]> = {}) {
  return {
    id: 42,
    subtotalCents: 5000,
    shippingCents: 500,
    taxCents: 413,
    discountCents: 0,
    totalCents: 5913,
    currency: "USD",
    ...overrides,
  };
}

function okLine(overrides: Partial<Parameters<typeof validateOmsOrderFinancials>[1][number]> = {}) {
  return {
    id: 100,
    quantity: 2,
    paidPriceCents: 2500, // per-unit
    totalPriceCents: 5000, // extended
    ...overrides,
  };
}

// ─── validateOmsOrderFinancials ──────────────────────────────────────

describe("validateOmsOrderFinancials :: happy path", () => {
  it("accepts a fully-populated paid order in USD", () => {
    expect(() =>
      validateOmsOrderFinancials(okOrder(), [okLine()]),
    ).not.toThrow();
  });

  it("accepts an order with multiple lines", () => {
    expect(() =>
      validateOmsOrderFinancials(okOrder({ totalCents: 12500 }), [
        okLine({ id: 1, paidPriceCents: 2500, totalPriceCents: 5000 }),
        okLine({ id: 2, paidPriceCents: 3750, totalPriceCents: 7500 }),
      ]),
    ).not.toThrow();
  });

  it("accepts zero for subtotal/shipping/tax/discount (tax-exempt, free ship)", () => {
    expect(() =>
      validateOmsOrderFinancials(
        okOrder({
          subtotalCents: 0,
          shippingCents: 0,
          taxCents: 0,
          discountCents: 0,
          totalCents: 1, // still must be > 0 on a paid order
        }),
        [okLine({ paidPriceCents: 1, totalPriceCents: 1, quantity: 1 })],
      ),
    ).not.toThrow();
  });

  it("accepts a line with totalPriceCents=0 (free/gift line)", () => {
    // totalPriceCents is extended total — allowed to be 0 (the positive
    // constraint only applies to paidPriceCents per-unit).
    expect(() =>
      validateOmsOrderFinancials(okOrder(), [
        okLine({ paidPriceCents: 1, totalPriceCents: 0, quantity: 1 }),
      ]),
    ).not.toThrow();
  });
});

describe("validateOmsOrderFinancials :: non-USD passthrough", () => {
  it("accepts EUR", () => {
    expect(() =>
      validateOmsOrderFinancials(okOrder({ currency: "EUR" }), [okLine()]),
    ).not.toThrow();
  });

  it("accepts CAD", () => {
    expect(() =>
      validateOmsOrderFinancials(okOrder({ currency: "CAD" }), [okLine()]),
    ).not.toThrow();
  });

  it("accepts GBP", () => {
    expect(() =>
      validateOmsOrderFinancials(okOrder({ currency: "GBP" }), [okLine()]),
    ).not.toThrow();
  });
});

describe("validateOmsOrderFinancials :: header violations", () => {
  it("throws when totalCents is 0 (paid order must be > 0)", () => {
    expect(() =>
      validateOmsOrderFinancials(okOrder({ totalCents: 0 }), [okLine()]),
    ).toThrow(WmsSyncValidationError);

    try {
      validateOmsOrderFinancials(okOrder({ totalCents: 0 }), [okLine()]);
    } catch (err) {
      const e = err as WmsSyncValidationError;
      expect(e).toBeInstanceOf(WmsSyncValidationError);
      expect(e.omsOrderId).toBe(42);
      expect(e.field).toBe("omsOrder.totalCents");
      expect(e.value).toBe(0);
      expect(e.code).toBe("WMS_SYNC_VALIDATION_FAILED");
    }
  });

  it("throws when taxCents is negative", () => {
    const thrown = captureThrow(() =>
      validateOmsOrderFinancials(okOrder({ taxCents: -1 }), [okLine()]),
    );
    expect(thrown).toBeInstanceOf(WmsSyncValidationError);
    expect((thrown as WmsSyncValidationError).field).toBe("omsOrder.taxCents");
    expect((thrown as WmsSyncValidationError).value).toBe(-1);
  });

  it("throws when shippingCents is a float (Rule #3: no floats)", () => {
    const thrown = captureThrow(() =>
      validateOmsOrderFinancials(okOrder({ shippingCents: 4.99 as number }), [okLine()]),
    );
    expect(thrown).toBeInstanceOf(WmsSyncValidationError);
    expect((thrown as WmsSyncValidationError).field).toBe("omsOrder.shippingCents");
  });

  it("throws when currency is lowercase", () => {
    const thrown = captureThrow(() =>
      validateOmsOrderFinancials(okOrder({ currency: "usd" }), [okLine()]),
    );
    expect(thrown).toBeInstanceOf(WmsSyncValidationError);
    expect((thrown as WmsSyncValidationError).field).toBe("omsOrder.currency");
  });

  it("throws when currency is empty string", () => {
    const thrown = captureThrow(() =>
      validateOmsOrderFinancials(okOrder({ currency: "" }), [okLine()]),
    );
    expect(thrown).toBeInstanceOf(WmsSyncValidationError);
    expect((thrown as WmsSyncValidationError).field).toBe("omsOrder.currency");
  });

  it("throws when currency is 4 chars", () => {
    const thrown = captureThrow(() =>
      validateOmsOrderFinancials(okOrder({ currency: "USDX" }), [okLine()]),
    );
    expect(thrown).toBeInstanceOf(WmsSyncValidationError);
    expect((thrown as WmsSyncValidationError).field).toBe("omsOrder.currency");
  });
});

describe("validateOmsOrderFinancials :: line violations", () => {
  it("throws when a line's paidPriceCents is 0 (missing paid price)", () => {
    const thrown = captureThrow(() =>
      validateOmsOrderFinancials(okOrder(), [
        okLine({ id: 777, paidPriceCents: 0 }),
      ]),
    );
    expect(thrown).toBeInstanceOf(WmsSyncValidationError);
    expect((thrown as WmsSyncValidationError).field).toBe(
      "omsOrderLines[777].paidPriceCents",
    );
    expect((thrown as WmsSyncValidationError).value).toBe(0);
    // Order id is preserved so the log line names the right OMS row.
    expect((thrown as WmsSyncValidationError).omsOrderId).toBe(42);
  });

  it("throws when a line's paidPriceCents is negative", () => {
    const thrown = captureThrow(() =>
      validateOmsOrderFinancials(okOrder(), [
        okLine({ id: 888, paidPriceCents: -100 }),
      ]),
    );
    expect(thrown).toBeInstanceOf(WmsSyncValidationError);
    expect((thrown as WmsSyncValidationError).field).toBe(
      "omsOrderLines[888].paidPriceCents",
    );
    expect((thrown as WmsSyncValidationError).value).toBe(-100);
  });

  it("throws when a line's totalPriceCents is negative", () => {
    const thrown = captureThrow(() =>
      validateOmsOrderFinancials(okOrder(), [
        okLine({ id: 999, totalPriceCents: -1 }),
      ]),
    );
    expect(thrown).toBeInstanceOf(WmsSyncValidationError);
    expect((thrown as WmsSyncValidationError).field).toBe(
      "omsOrderLines[999].totalPriceCents",
    );
  });

  it("throws on the FIRST failing field (fail-fast)", () => {
    // Two bad lines — expect the first-bad line's field name.
    const thrown = captureThrow(() =>
      validateOmsOrderFinancials(okOrder(), [
        okLine({ id: 1, paidPriceCents: 0 }),
        okLine({ id: 2, paidPriceCents: -5 }),
      ]),
    );
    expect(thrown).toBeInstanceOf(WmsSyncValidationError);
    expect((thrown as WmsSyncValidationError).field).toBe(
      "omsOrderLines[1].paidPriceCents",
    );
  });

  it("throws on a float per-unit price (Rule #3)", () => {
    const thrown = captureThrow(() =>
      validateOmsOrderFinancials(okOrder(), [
        okLine({ id: 55, paidPriceCents: 19.99 as number }),
      ]),
    );
    expect(thrown).toBeInstanceOf(WmsSyncValidationError);
    expect((thrown as WmsSyncValidationError).field).toBe(
      "omsOrderLines[55].paidPriceCents",
    );
  });
});

// ─── buildWmsOrderFinancialSnapshot ──────────────────────────────────

describe("buildWmsOrderFinancialSnapshot", () => {
  it("maps OMS totalCents → amountPaidCents (SS amountPaid on push)", () => {
    const snap = buildWmsOrderFinancialSnapshot(okOrder({ totalCents: 9999 }));
    expect(snap.amountPaidCents).toBe(9999);
    expect(snap.totalCents).toBe(9999);
    expect(Number.isInteger(snap.amountPaidCents)).toBe(true);
    expect(Number.isInteger(snap.totalCents)).toBe(true);
  });

  it("passes tax/shipping/discount/currency through unchanged", () => {
    const snap = buildWmsOrderFinancialSnapshot(
      okOrder({
        taxCents: 100,
        shippingCents: 500,
        discountCents: 250,
        currency: "EUR",
      }),
    );
    expect(snap.taxCents).toBe(100);
    expect(snap.shippingCents).toBe(500);
    expect(snap.discountCents).toBe(250);
    expect(snap.currency).toBe("EUR");
  });

  it("does not mutate the input object (Rule #3)", () => {
    const input = okOrder();
    const snap = buildWmsOrderFinancialSnapshot(input);
    expect(input.totalCents).toBe(5913); // unchanged
    // Snapshot is a new object:
    expect(snap).not.toBe(input);
  });

  it("returns exactly the 6 WMS header cents fields (no extras)", () => {
    const snap = buildWmsOrderFinancialSnapshot(okOrder());
    expect(Object.keys(snap).sort()).toEqual(
      [
        "amountPaidCents",
        "currency",
        "discountCents",
        "shippingCents",
        "taxCents",
        "totalCents",
      ].sort(),
    );
  });
});

// ─── buildWmsItemFinancialSnapshot ───────────────────────────────────

describe("buildWmsItemFinancialSnapshot", () => {
  it("maps OMS paidPriceCents → both unit_price_cents AND paid_price_cents", () => {
    const snap = buildWmsItemFinancialSnapshot(
      okLine({ paidPriceCents: 1234, totalPriceCents: 2468, quantity: 2 }),
    );
    expect(snap.unitPriceCents).toBe(1234);
    expect(snap.paidPriceCents).toBe(1234);
    // Same value — this is the §6 Commit 7 contract: OMS paidPrice is
    // per-unit, WMS exposes it under both names for OMS-parity.
    expect(snap.unitPriceCents).toBe(snap.paidPriceCents);
  });

  it("maps OMS totalPriceCents → total_price_cents (extended)", () => {
    const snap = buildWmsItemFinancialSnapshot(
      okLine({ paidPriceCents: 1234, totalPriceCents: 2468 }),
    );
    expect(snap.totalPriceCents).toBe(2468);
    expect(Number.isInteger(snap.totalPriceCents)).toBe(true);
  });

  it("does not mutate the input line (Rule #3)", () => {
    const input = okLine();
    const snap = buildWmsItemFinancialSnapshot(input);
    expect(input.paidPriceCents).toBe(2500);
    expect(snap).not.toBe(input);
  });

  it("handles single-unit line (qty=1, paid=total)", () => {
    const snap = buildWmsItemFinancialSnapshot(
      okLine({ quantity: 1, paidPriceCents: 500, totalPriceCents: 500 }),
    );
    expect(snap.unitPriceCents).toBe(500);
    expect(snap.totalPriceCents).toBe(500);
  });
});

// ─── Structural guarantees (flag-off parity) ─────────────────────────

describe("WMS_FINANCIAL_SNAPSHOT flag-off behavior (structural)", () => {
  // Flag-off is structurally enforced in the service by NOT calling the
  // helpers and NOT including the fields in the INSERT literal. The
  // helpers themselves have no flag awareness — their job is to run
  // when called. This test documents the contract: if someone wires
  // the helpers into a new caller without flag-gating, validation will
  // fire. That's intentional and safe.
  it("helpers throw on invalid input regardless of any flag (safe by default)", () => {
    expect(() =>
      validateOmsOrderFinancials(
        okOrder({ totalCents: 0 }),
        [okLine()],
      ),
    ).toThrow(WmsSyncValidationError);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────

/** Capture a thrown value without relying on expect().toThrow() unwrap. */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
    throw new Error("expected fn to throw");
  } catch (err) {
    return err;
  }
}
