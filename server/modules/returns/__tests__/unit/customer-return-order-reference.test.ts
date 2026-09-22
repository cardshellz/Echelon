import { describe, expect, it } from "vitest";
import {
  buildCustomerReturnOrderNumberAliases,
  CustomerReturnOrderReferenceError,
  MAX_CUSTOMER_RETURN_ORDER_REFERENCE_INPUT_LENGTH,
  normalizeCustomerReturnOrderReference,
} from "../../domain/customer-return-order-reference";

describe("customer return order references", () => {
  it.each(["63210", "#63210", " 63210 ", " # 63210 ", "\t# 63210\t"])(
    "normalizes only surrounding and display-prefix whitespace: %j", (input) => {
      expect(normalizeCustomerReturnOrderReference(input)).toBe("63210");
    },
  );

  it.each([
    ["#00063210", "00063210"],
    ["#9999999999999999999999999999999999999999", "9999999999999999999999999999999999999999"],
    [" CS-00063210-A ", "CS-00063210-A"],
    ["#CS 00063210 A", "CS 00063210 A"],
    ["web#0012-A", "web#0012-A"],
    ["cs-63210", "cs-63210"],
    ["CS_%63210", "CS_%63210"],
  ])("preserves the exact identity in %j", (input, expected) => {
    expect(normalizeCustomerReturnOrderReference(input)).toBe(expected);
    expect(normalizeCustomerReturnOrderReference(expected)).toBe(expected);
  });

  it("produces a finite exact alias set without substrings or numeric conversion", () => {
    expect(buildCustomerReturnOrderNumberAliases("  # 00063210 ")).toEqual([
      "00063210", "#00063210", "# 00063210",
    ]);
    expect(buildCustomerReturnOrderNumberAliases(" CS-00063210-A ")).toEqual([
      "CS-00063210-A", "#CS-00063210-A",
    ]);
    expect(buildCustomerReturnOrderNumberAliases("#63210")).toEqual(["63210", "#63210"]);
    expect(Object.isFrozen(buildCustomerReturnOrderNumberAliases("63210"))).toBe(true);
  });

  it("supports the stored reference length without spending it on surrounding spaces", () => {
    const reference = "9".repeat(50);
    expect(normalizeCustomerReturnOrderReference(` # ${reference} `)).toBe(reference);
  });

  it.each([
    undefined, null, 63210, 0, {}, [], "", "   ", "#", "#   ", "##63210", "# #63210",
    "632\n10", "632\u000010", "632\u007f10", "9".repeat(51),
    " ".repeat(MAX_CUSTOMER_RETURN_ORDER_REFERENCE_INPUT_LENGTH) + "63210",
  ])("rejects malformed input without echoing it: %j", (input) => {
    expect(() => normalizeCustomerReturnOrderReference(input)).toThrow(CustomerReturnOrderReferenceError);
    expect(() => normalizeCustomerReturnOrderReference(input)).toThrow("Enter a valid order reference.");
  });
});
