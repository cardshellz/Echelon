import { describe, expect, it } from "vitest";
import {
  mergeVariantOptions,
  resolveRulePricing,
  ruleDialogInitialSelection,
  sameVariantMembership,
  visibleManualVariantOptions,
} from "../pricing-programs/DestinationProductPolicies";

const EMPTY_PRICING = {
  rateUsd: "",
  perPoundUsd: "",
  perAdditionalUnitUsd: "",
  thresholdUsd: "",
  bands: [],
};

describe("shipping product-rule form pricing", () => {
  it("builds a price-free restriction even when the hidden behavior defaults to fixed", () => {
    expect(resolveRulePricing("restriction", "fixed", EMPTY_PRICING)).toEqual({
      ok: true,
      rateCents: null,
      perStartedPoundCents: null,
      perAdditionalUnitCents: null,
      thresholdCents: null,
      bands: [],
    });
  });

  it("still requires an amount for a fixed-charge exception", () => {
    expect(resolveRulePricing("exception", "fixed", EMPTY_PRICING)).toEqual({
      ok: false,
      message: "Enter a valid shipping amount.",
    });
  });

  it("builds an integer-cent base plus additional-unit exception", () => {
    expect(resolveRulePricing("exception", "base_plus_per_additional_unit", {
      ...EMPTY_PRICING,
      rateUsd: "12.00",
      perAdditionalUnitUsd: "6.00",
    })).toEqual({
      ok: true,
      rateCents: 1_200,
      perStartedPoundCents: null,
      perAdditionalUnitCents: 600,
      thresholdCents: null,
      bands: [],
    });
  });

  it("requires both amounts for base plus additional-unit pricing", () => {
    expect(resolveRulePricing("exception", "base_plus_per_additional_unit", EMPTY_PRICING))
      .toEqual({
        ok: false,
        message: "Enter valid first-unit and additional-unit amounts.",
      });
  });
});

describe("shipping product-rule edit selection", () => {
  it("opens a persisted saved-set snapshot as editable exact variants", () => {
    expect(ruleDialogInitialSelection({
      id: 91,
      sourceProductSetId: 33,
      productSetName: "Storage Box Cases",
      name: "Storage Box Cases",
      kind: "restriction",
      action: "block",
      measurementScope: "matched_items",
      destinationScope: { country: "US", regions: ["AK", "HI"], postalPrefixes: [] },
      rateCents: null,
      perStartedPoundCents: null,
      perAdditionalUnitCents: null,
      thresholdCents: null,
      memberVariantIds: [44, 45],
      bands: [],
      isActive: true,
    })).toEqual({
      selectorKind: "manual",
      selectorRef: "",
      selectedVariantIds: [44, 45],
    });
  });

  it("keeps selected variants visible ahead of catalog search results", () => {
    const variants = mergeVariantOptions(
      [{
        id: 44,
        sku: "TUFF-BOX-GRD-C25",
        name: "Case of 25",
        productName: "Tough Box",
        isActive: true,
      }],
      [{
        id: 12,
        sku: "NEW-SKU",
        name: "Pack",
        productName: "New Product",
        isActive: true,
      }],
    );

    expect(visibleManualVariantOptions(variants, [44], "").options.map((item) => item.id))
      .toEqual([44, 12]);
  });

  it("recognizes unchanged membership regardless of selection order", () => {
    expect(sameVariantMembership([45, 44], [44, 45])).toBe(true);
    expect(sameVariantMembership([44, 46], [44, 45])).toBe(false);
  });
});
