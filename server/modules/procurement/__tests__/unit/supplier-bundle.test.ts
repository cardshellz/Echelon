import { describe, expect, it } from "vitest";
import { evaluateSupplierBundle } from "@shared/procurement/supplier-bundle";

const terms = { currency: "USD", minimumOrderCents: 100_00, freeFreightThresholdCents: 500_00 };
describe("supplier basket readiness", () => {
  it("checks the whole bundle and exposes freight shortfall without padding quantities", () => {
    expect(evaluateSupplierBundle(terms, [60_00, 40_00])).toMatchObject({ status: "ready", subtotalCents: 100_00, minimumShortfallCents: 0, freeFreightShortfallCents: 400_00 });
    expect(evaluateSupplierBundle(terms, [99_99])).toMatchObject({ status: "below_minimum", minimumShortfallCents: 1 });
    expect(evaluateSupplierBundle(terms, [500_00])).toMatchObject({ status: "ready", freeFreightShortfallCents: 0 });
  });
  it("does not substitute zero for unknown prices or compare unknown currencies", () => {
    expect(evaluateSupplierBundle(terms, [100_00, null]).status).toBe("unpriced");
    expect(evaluateSupplierBundle({ ...terms, currency: null }, [100_00]).status).toBe("invalid_terms");
    expect(evaluateSupplierBundle({ ...terms, minimumOrderCents: "10000" }, [100_00]).status).toBe("invalid_terms");
    expect(evaluateSupplierBundle(terms, [-1]).status).toBe("unpriced");
  });
  it("supports explicit zero terms and bounds exact integer totals", () => {
    expect(evaluateSupplierBundle({ currency: "USD", minimumOrderCents: 0, freeFreightThresholdCents: null }, [0])).toMatchObject({ status: "ready", subtotalCents: 0, freeFreightShortfallCents: null });
    expect(() => evaluateSupplierBundle(terms, [Number.MAX_SAFE_INTEGER, 1])).toThrow(/cents range/);
  });
});
