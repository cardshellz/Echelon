import { describe, expect, it, vi } from "vitest";
import { applyBulkAttributeCellInput } from "../ListingBulkAttributeCell";
import type { BulkAttributeColumn } from "../bulk-attribute-columns";

const column: BulkAttributeColumn = {
  key: '["Orderable","weight"]',
  path: ["Orderable", "weight"],
  label: "Weight",
  pathLabel: "Shipping › Weight",
  group: "Shipping",
  type: "number",
  schema: { type: "number", minimum: 0 },
  required: false,
  requiredForSome: false,
  appliesToAll: true,
};

describe("bulk cell owner acknowledgement", () => {
  it("reports rejected valid input as invalid instead of accepting the last saved value", () => {
    const commit = vi.fn(() => false);
    expect(applyBulkAttributeCellInput(column, "12.5", commit)).toEqual({
      value: undefined,
      error:
        "This change could not be applied. Discard this edit or correct it.",
    });
    expect(commit).toHaveBeenCalledExactlyOnceWith(12.5);
  });
  it("retains explicit clears and zero only after owner acceptance, including legacy void callbacks", () => {
    expect(applyBulkAttributeCellInput(column, "0", () => true)).toEqual({
      value: 0,
      error: null,
    });
    expect(applyBulkAttributeCellInput(column, "", () => undefined)).toEqual({
      value: undefined,
      error: null,
    });
    expect(
      applyBulkAttributeCellInput(column, "", () => false).error,
    ).not.toBeNull();
  });
  it("does not invoke the owner for invalid input and reports unexpected owner failure", () => {
    const commit = vi.fn();
    expect(
      applyBulkAttributeCellInput(column, "-", commit).error,
    ).not.toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(
      applyBulkAttributeCellInput(column, "1", () => {
        throw new Error("Draft limit");
      }).error,
    ).toContain("could not be applied");
  });
});
