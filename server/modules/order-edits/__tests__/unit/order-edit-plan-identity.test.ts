import { describe, expect, it } from "vitest";
import { sameOrderEditPlan } from "../../domain/order-edit-plan-identity";
import type { OrderEditPlan } from "../../application/order-edit-provider";

const plan = (): OrderEditPlan => ({
  changes: [{ lineItemId: "gid://shopify/LineItem/101", quantity: 2 }],
  additions: [{ variantId: "gid://shopify/ProductVariant/201", quantity: 1 }],
  discountCodes: [],
});

describe("order edit plan identity", () => {
  it.each([
    { label: "empty code list", codes: [] },
    { label: "selected codes", codes: ["SAVE10", "HOLIDAY"] },
  ])("accepts reordered object fields with $label", ({ codes }) => {
    const expected = { ...plan(), discountCodes: codes };
    const parsed: OrderEditPlan = {
      discountCodes: [...codes],
      additions: [
        { quantity: 1, variantId: "gid://shopify/ProductVariant/201" },
      ],
      changes: [{ quantity: 2, lineItemId: "gid://shopify/LineItem/101" }],
    };
    expect(sameOrderEditPlan(parsed, expected)).toBe(true);
  });

  it.each([
    "quantity",
    "line identity",
    "variant",
    "addition quantity",
    "codes",
    "code order",
  ])("rejects a changed %s without mutating either plan", (difference) => {
    const expected = { ...plan(), discountCodes: ["SAVE10", "HOLIDAY"] };
    const actual = structuredClone(expected);
    if (difference === "quantity") actual.changes[0].quantity = 3;
    if (difference === "line identity")
      actual.changes[0].lineItemId = "gid://shopify/LineItem/102";
    if (difference === "variant")
      actual.additions[0].variantId = "gid://shopify/ProductVariant/202";
    if (difference === "addition quantity") actual.additions[0].quantity = 2;
    if (difference === "codes") actual.discountCodes = ["DIFFERENT"];
    if (difference === "code order") actual.discountCodes.reverse();
    const before = structuredClone({ actual, expected });
    expect(sameOrderEditPlan(actual, expected)).toBe(false);
    expect({ actual, expected }).toEqual(before);
  });

  it("preserves legacy omission and distinguishes it from an explicit empty list", () => {
    const legacy = { changes: plan().changes, additions: [] };
    expect(
      sameOrderEditPlan(legacy, { additions: [], changes: plan().changes }),
    ).toBe(true);
    expect(sameOrderEditPlan(legacy, { ...legacy, discountCodes: [] })).toBe(
      false,
    );
  });

  it("preserves the requested line sequence", () => {
    const expected = {
      ...plan(),
      changes: [
        ...plan().changes,
        { lineItemId: "gid://shopify/LineItem/102", quantity: 1 },
      ],
    };
    expect(
      sameOrderEditPlan(expected, {
        ...expected,
        changes: [...expected.changes].reverse(),
      }),
    ).toBe(false);
  });
});
