import { describe, expect, it } from "vitest";

import type { DropshipProductCost } from "../../application/dropship-product-cost";
import {
  ACCEPTANCE_COST_AUTHORITY,
  buildAcceptanceCostEvidenceHash,
  resolveAcceptanceUnitCost,
} from "../../domain/order-acceptance-cost";

function available(overrides: Partial<DropshipProductCost> = {}): DropshipProductCost {
  return {
    status: "available",
    unitCostCents: 809,
    planId: "plan-ops",
    source: "variant_fixed_price",
    overrideId: "override-1",
    issue: null,
    ...overrides,
  };
}

describe("resolveAcceptanceUnitCost", () => {
  it("accepts an available positive .ops cost and carries its provenance", () => {
    expect(resolveAcceptanceUnitCost(available())).toEqual({
      ok: true,
      unitCostCents: 809,
      evidence: { source: "variant_fixed_price", planId: "plan-ops", overrideId: "override-1" },
    });
    expect(resolveAcceptanceUnitCost(available({ source: "retail", overrideId: null, unitCostCents: 899 })))
      .toMatchObject({ ok: true, unitCostCents: 899, evidence: { source: "retail", overrideId: null } });
  });

  it("blocks acceptance when no cost was resolved for the variant", () => {
    expect(resolveAcceptanceUnitCost(undefined)).toMatchObject({
      ok: false,
      code: "DROPSHIP_ORDER_PRODUCT_COST_UNAVAILABLE",
      retryable: false,
      issue: "variant_unmapped",
    });
  });

  it("blocks acceptance on every unavailable issue and marks only a failed source read retryable", () => {
    const permanentIssues = [
      "vendor_unavailable", "plan_unavailable", "entitlement_inactive", "variant_unmapped",
      "variant_ambiguous", "variant_identity_mismatch", "override_ambiguous", "override_invalid",
      "retail_unavailable", "pricing_configuration_invalid",
    ] as const;
    for (const issue of permanentIssues) {
      expect(resolveAcceptanceUnitCost({
        status: "unavailable", unitCostCents: null, planId: "plan-ops", source: null, overrideId: null, issue,
      })).toMatchObject({ ok: false, code: "DROPSHIP_ORDER_PRODUCT_COST_UNAVAILABLE", retryable: false, issue });
    }
    expect(resolveAcceptanceUnitCost({
      status: "unavailable", unitCostCents: null, planId: null, source: null, overrideId: null, issue: "source_read_failed",
    })).toMatchObject({ ok: false, code: "DROPSHIP_ORDER_PRODUCT_COST_UNAVAILABLE", retryable: true });
  });

  it("refuses a zero cost instead of debiting nothing for goods", () => {
    expect(resolveAcceptanceUnitCost(available({ unitCostCents: 0 }))).toMatchObject({
      ok: false,
      code: "DROPSHIP_ORDER_PRODUCT_COST_ZERO",
      retryable: false,
    });
  });

  it("refuses costs without valid cents or provenance", () => {
    expect(resolveAcceptanceUnitCost(available({ unitCostCents: 8.09 })))
      .toMatchObject({ ok: false, code: "DROPSHIP_ORDER_PRODUCT_COST_INVALID" });
    expect(resolveAcceptanceUnitCost(available({ unitCostCents: -1 })))
      .toMatchObject({ ok: false, code: "DROPSHIP_ORDER_PRODUCT_COST_INVALID" });
    expect(resolveAcceptanceUnitCost(available({ unitCostCents: null })))
      .toMatchObject({ ok: false, code: "DROPSHIP_ORDER_PRODUCT_COST_INVALID" });
    expect(resolveAcceptanceUnitCost(available({ planId: null })))
      .toMatchObject({ ok: false, code: "DROPSHIP_ORDER_PRODUCT_COST_INVALID" });
    expect(resolveAcceptanceUnitCost(available({ source: null })))
      .toMatchObject({ ok: false, code: "DROPSHIP_ORDER_PRODUCT_COST_INVALID" });
  });
});

describe("buildAcceptanceCostEvidenceHash", () => {
  const line = (productVariantId: number, unitCostCents: number) => ({
    productVariantId,
    quantity: 2,
    catalogRetailPriceCents: 899,
    wholesaleUnitCostCents: unitCostCents,
    productCostEvidence: { source: "variant_fixed_price" as const, planId: "plan-ops", overrideId: "override-1" },
  });

  it("is deterministic, order independent, and names the authority", () => {
    const forward = buildAcceptanceCostEvidenceHash({ vendorId: 10, lines: [line(101, 809), line(102, 500)] });
    const reversed = buildAcceptanceCostEvidenceHash({ vendorId: 10, lines: [line(102, 500), line(101, 809)] });
    expect(forward).toMatch(/^[0-9a-f]{64}$/);
    expect(forward).toBe(reversed);
    expect(ACCEPTANCE_COST_AUTHORITY).toBe("shellz_club_ops_product_cost");
  });

  it("changes when any cost input changes", () => {
    const base = buildAcceptanceCostEvidenceHash({ vendorId: 10, lines: [line(101, 809)] });
    expect(buildAcceptanceCostEvidenceHash({ vendorId: 10, lines: [line(101, 810)] })).not.toBe(base);
    expect(buildAcceptanceCostEvidenceHash({ vendorId: 11, lines: [line(101, 809)] })).not.toBe(base);
    expect(buildAcceptanceCostEvidenceHash({
      vendorId: 10,
      lines: [{ ...line(101, 809), productCostEvidence: { source: "plan_percent", planId: "plan-ops", overrideId: null } }],
    })).not.toBe(base);
  });
});
