import { describe, expect, it } from "vitest";
import { supplierEvidenceCatalogStateFingerprint as fingerprint } from "../../supplier-evidence-catalog-state";

const targets = [{ productId: 10, productVariantId: null, isPreferred: true }];
const stored = { id: 1, vendorId: 7, productId: 10, productVariantId: null, isPreferred: 1, isActive: 1,
  unitCostMills: 12345, updatedAt: new Date("2026-10-17T10:00:00.000Z") };

describe("supplier import affected catalog footprint", () => {
  it("normalizes raw SQL bigint/date evidence and Drizzle evidence consistently", () => {
    expect(fingerprint(7, targets, [stored])).toBe(fingerprint(7, targets, [{
      id: 1, vendor_id: 7, product_id: 10, product_variant_id: null, is_preferred: 1, is_active: 1,
      unit_cost_mills: "12345", updated_at: "2026-10-17 10:00:00",
    }]));
  });
  it.each(["unitCostMills", "unitCostCents", "packSize", "moq", "leadTimeDays", "vendorSku",
    "quoteReference", "quotedAt", "quoteValidUntil", "pricingBasis", "piecesPerPurchaseUom", "isPreferred", "isActive", "updatedAt"])(
    "binds overwritten %s evidence", (key) => {
      expect(fingerprint(7, targets, [{ ...stored, [key]: key === "updatedAt" || key === "quotedAt" ? new Date("2026-10-18T10:00:00Z") : "changed" }]))
        .not.toBe(fingerprint(7, targets, [stored]));
    });
  it("detects a newly preferred competing supplier and creation of a missing target", () => {
    const competing = { ...stored, id: 2, vendorId: 8 };
    expect(fingerprint(7, targets, [stored, competing])).not.toBe(fingerprint(7, targets, [stored]));
    expect(fingerprint(7, targets, [stored])).not.toBe(fingerprint(7, targets, []));
  });
  it("excludes unrelated mapping changes and sorts evidence without mutating inputs", () => {
    const unrelated = { ...stored, id: 2, vendorId: 8, isPreferred: 0 };
    const rows = [unrelated, stored];
    expect(fingerprint(7, targets, rows)).toBe(fingerprint(7, targets, [stored]));
    expect(rows).toEqual([unrelated, stored]);
    expect(fingerprint(7, [{ ...targets[0], isPreferred: false }], [{ ...unrelated, isPreferred: 1 }, stored]))
      .toBe(fingerprint(7, [{ ...targets[0], isPreferred: false }], [stored]));
  });
});
