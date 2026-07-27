import { describe, expect, it } from "vitest";
import {
  ProductRatePolicyAdminError,
  validateManualVariantSelection,
} from "../../application/product-rate-policy-admin.service";

describe("product-rate policy manual selection validation", () => {
  it("preserves an existing inactive member while accepting a new active member", () => {
    expect(validateManualVariantSelection(
      [10, 20],
      [
        { id: 10, variantIsActive: false, productIsActive: true },
        { id: 20, variantIsActive: true, productIsActive: true },
      ],
      [10],
    )).toEqual([10, 20]);
  });

  it("rejects a newly selected inactive variant", () => {
    expect(() => validateManualVariantSelection(
      [10],
      [{ id: 10, variantIsActive: false, productIsActive: true }],
      [],
    )).toThrowError(expect.objectContaining({
      code: "SHIPPING_PRODUCT_POLICY_INACTIVE_VARIANT",
      status: 400,
    }) as ProductRatePolicyAdminError);
  });

  it("rejects a selected variant that no longer exists", () => {
    expect(() => validateManualVariantSelection(
      [10, 20],
      [{ id: 10, variantIsActive: true, productIsActive: true }],
      [10],
    )).toThrowError(expect.objectContaining({
      code: "SHIPPING_PRODUCT_POLICY_INVALID_VARIANTS",
      status: 400,
    }) as ProductRatePolicyAdminError);
  });
});
