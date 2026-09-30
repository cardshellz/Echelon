import { describe, expect, it } from "vitest";
import {
  ebayCategoryIdSchema,
  ebayCategoryRulesDraftSchema,
  ebayCategoryRulesProfileSchema,
  ebayCategorySearchQuerySchema,
  MAX_EBAY_CATEGORY_RULES,
  saveEbayCategoryRulesInputSchema,
} from "../ebay-category-rules";

const category = { categoryId: "900101", categoryName: "Toploaders", path: ["Collectibles", "Toploaders"] };

describe("eBay category rules contract", () => {
  it("accepts a store default with ordered rules", () => {
    const parsed = ebayCategoryRulesProfileSchema.parse({
      version: 1,
      defaultCategory: category,
      rules: [
        { id: "env", name: "Envelopes", scope: { type: "category", category: "Envelopes" }, category },
        { id: "picked", name: "Picked listings", scope: { type: "listings", productVariantIds: [3, 1] }, category },
      ],
    });
    expect(parsed.rules.map((rule) => rule.id)).toEqual(["env", "picked"]);
  });

  it("accepts eBay category numbers only", () => {
    expect(ebayCategoryIdSchema.safeParse("183438").success).toBe(true);
    for (const value of ["0", "0183438", "18a", "", " 183438", "1".repeat(21)]) {
      expect(ebayCategoryIdSchema.safeParse(value).success).toBe(false);
    }
  });

  it("refuses duplicate rule identities and two rules on the same group", () => {
    const rule = { name: "Rule", categoryId: "900101", scope: { type: "product", productId: 7 } };
    expect(ebayCategoryRulesDraftSchema.safeParse({ defaultCategoryId: null, rules: [{ ...rule, id: "a" }, { ...rule, id: "a", scope: { type: "product", productId: 8 } }] }).success).toBe(false);
    const sameGroup = ebayCategoryRulesDraftSchema.safeParse({ defaultCategoryId: null, rules: [{ ...rule, id: "a" }, { ...rule, id: "b" }] });
    expect(sameGroup.success).toBe(false);
    expect(JSON.stringify(sameGroup.error?.issues)).toContain("Two rules cannot target the same group");
  });

  it("allows overlapping named-listing rules, where the first one wins", () => {
    const parsed = ebayCategoryRulesDraftSchema.safeParse({ defaultCategoryId: null, rules: [
      { id: "a", name: "A", categoryId: "900101", scope: { type: "listings", productVariantIds: [1, 2] } },
      { id: "b", name: "B", categoryId: "900102", scope: { type: "listings", productVariantIds: [2, 3] } },
    ] });
    expect(parsed.success).toBe(true);
  });

  it("caps rules at 100 and named listings at 10,000 across all rules", () => {
    const many = Array.from({ length: MAX_EBAY_CATEGORY_RULES + 1 }, (_, index) => ({
      id: `r${index}`, name: `Rule ${index}`, categoryId: "900101", scope: { type: "product", productId: index + 1 },
    }));
    expect(ebayCategoryRulesDraftSchema.safeParse({ defaultCategoryId: null, rules: many }).success).toBe(false);
    const ids = (start: number, count: number) => Array.from({ length: count }, (_, index) => start + index);
    const overBudget = ebayCategoryRulesDraftSchema.safeParse({ defaultCategoryId: null, rules: [
      { id: "a", name: "A", categoryId: "900101", scope: { type: "listings", productVariantIds: ids(1, 6_000) } },
      { id: "b", name: "B", categoryId: "900102", scope: { type: "listings", productVariantIds: ids(6_001, 4_001) } },
    ] });
    expect(overBudget.success).toBe(false);
    expect(JSON.stringify(overBudget.error?.issues)).toContain("10,000 named-listing");
  });

  it("never lets the client submit a category name or path", () => {
    const withName = saveEbayCategoryRulesInputSchema.safeParse({
      expectedRevisionId: null, idempotencyKey: "category-rules:1",
      draft: { defaultCategoryId: "900101", rules: [{ id: "a", name: "A", categoryId: "900101", categoryName: "Forged", scope: { type: "product", productId: 1 } }] },
    });
    expect(withName.success).toBe(false);
  });

  it("trims search queries and refuses short, long and control-character input", () => {
    expect(ebayCategorySearchQuerySchema.parse("  toploader  ")).toBe("toploader");
    for (const value of ["a", " b ", "x".repeat(101), "top\u0000loader"]) {
      expect(ebayCategorySearchQuerySchema.safeParse(value).success).toBe(false);
    }
  });
});
