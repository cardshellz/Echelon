import { describe, expect, it } from "vitest";
import {
  assertOrderEditCodeMinimumKept,
  ORDER_EDIT_CODE_MINIMUM_NOT_MET,
} from "../../domain/order-edit-code-minimum";

const subtotal = (amountCents: number) => ({
  code: "SAVE5",
  minimum: { type: "subtotal" as const, amountCents },
});
const quantity = (required: number) => ({
  code: "BULK",
  minimum: { type: "quantity" as const, quantity: required },
});
const measure = (subtotalCents: number, units: number) => ({
  subtotalCents,
  quantity: units,
});

describe("assertOrderEditCodeMinimumKept", () => {
  it("refuses the #65912 edit: a $35.00 minimum and $19.53 of items left", () => {
    expect(() =>
      assertOrderEditCodeMinimumKept({
        codes: [subtotal(3500)],
        before: measure(3696, 14),
        after: measure(1953, 7),
      }),
    ).toThrow(
      expect.objectContaining({
        code: ORDER_EDIT_CODE_MINIMUM_NOT_MET,
        status: 409,
        message: expect.stringContaining("at least $35.00"),
      }),
    );
  });

  it("names the amount the changes would leave", () => {
    expect(() =>
      assertOrderEditCodeMinimumKept({
        codes: [subtotal(3500)],
        before: measure(3696, 14),
        after: measure(1905, 7),
      }),
    ).toThrow(/would leave \$19\.05/);
  });

  it.each([
    ["exactly at the minimum", measure(3500, 13)],
    ["above the minimum", measure(9000, 30)],
  ])("allows an edit that leaves the order %s", (_label, after) => {
    expect(() =>
      assertOrderEditCodeMinimumKept({
        codes: [subtotal(3500)],
        before: measure(3696, 14),
        after,
      }),
    ).not.toThrow();
  });

  it("refuses one cent under the minimum", () => {
    expect(() =>
      assertOrderEditCodeMinimumKept({
        codes: [subtotal(3500)],
        before: measure(3696, 14),
        after: measure(3499, 13),
      }),
    ).toThrow(expect.objectContaining({ code: ORDER_EDIT_CODE_MINIMUM_NOT_MET }));
  });

  it("allows an order with no minimum-spend code", () => {
    expect(() =>
      assertOrderEditCodeMinimumKept({
        codes: [],
        before: measure(3696, 14),
        after: measure(0, 0),
      }),
    ).not.toThrow();
  });

  it("allows a zero minimum", () => {
    expect(() =>
      assertOrderEditCodeMinimumKept({
        codes: [subtotal(0)],
        before: measure(3696, 14),
        after: measure(0, 0),
      }),
    ).not.toThrow();
  });

  it.each([
    ["adds items", measure(2500, 9)],
    ["leaves the items total unchanged", measure(2000, 7)],
  ])(
    "allows an order already below the minimum when the edit %s",
    (_label, after) => {
      expect(() =>
        assertOrderEditCodeMinimumKept({
          codes: [subtotal(3500)],
          before: measure(2000, 7),
          after,
        }),
      ).not.toThrow();
    },
  );

  it("refuses taking an order already below the minimum further below", () => {
    expect(() =>
      assertOrderEditCodeMinimumKept({
        codes: [subtotal(3500)],
        before: measure(2000, 7),
        after: measure(1999, 7),
      }),
    ).toThrow(expect.objectContaining({ code: ORDER_EDIT_CODE_MINIMUM_NOT_MET }));
  });

  it("measures a quantity minimum in items, not money", () => {
    expect(() =>
      assertOrderEditCodeMinimumKept({
        codes: [quantity(10)],
        before: measure(3696, 14),
        after: measure(9000, 9),
      }),
    ).toThrow(
      expect.objectContaining({
        code: ORDER_EDIT_CODE_MINIMUM_NOT_MET,
        message: expect.stringContaining("at least 10 items"),
      }),
    );
    expect(() =>
      assertOrderEditCodeMinimumKept({
        codes: [quantity(10)],
        before: measure(3696, 14),
        after: measure(100, 10),
      }),
    ).not.toThrow();
  });

  it("refuses when any one of several codes falls below its minimum", () => {
    expect(() =>
      assertOrderEditCodeMinimumKept({
        codes: [subtotal(1000), quantity(10)],
        before: measure(3696, 14),
        after: measure(3000, 9),
      }),
    ).toThrow(expect.objectContaining({ code: ORDER_EDIT_CODE_MINIMUM_NOT_MET }));
  });

  it.each([
    ["a fractional amount", measure(19.53, 7)],
    ["a negative amount", measure(-1, 7)],
    ["a fractional quantity", measure(1953, 6.5)],
  ])("rejects %s instead of comparing it", (_label, after) => {
    expect(() =>
      assertOrderEditCodeMinimumKept({
        codes: [subtotal(3500)],
        before: measure(3696, 14),
        after,
      }),
    ).toThrow();
  });

  it("does not change its input", () => {
    const input = {
      codes: [subtotal(3500)],
      before: measure(3696, 14),
      after: measure(3600, 13),
    };
    const copy = structuredClone(input);
    assertOrderEditCodeMinimumKept(input);
    expect(input).toEqual(copy);
  });
});
