/**
 * Boundary validation for slot-assignment commands.
 *
 * Invariants protected:
 *   1. Omitting isPrimary still means primary (every existing caller relies on it).
 *   2. Only the literal integers 0 and 1 are accepted — booleans, strings and
 *      other numbers are rejected up front instead of reaching the database.
 *   3. Ids must be positive integers; numeric strings from URL params are
 *      accepted, anything else is rejected with a structured error.
 */
import { describe, expect, it } from "vitest";

import {
  BinAssignmentValidationError,
  parseBinAssignmentWriteRequest,
  parseSlotPrimaryFlag,
} from "../../bin-assignment-contracts";

describe("parseSlotPrimaryFlag", () => {
  it("defaults an omitted flag to primary", () => {
    expect(parseSlotPrimaryFlag(undefined)).toBe(1);
    expect(parseSlotPrimaryFlag(null)).toBe(1);
  });

  it("accepts the two literal integers", () => {
    expect(parseSlotPrimaryFlag(1)).toBe(1);
    expect(parseSlotPrimaryFlag(0)).toBe(0);
  });

  it.each([true, false, "1", "0", 2, -1, 1.5, "primary", {}])(
    "rejects %j instead of coercing it",
    (value) => {
      expect(() => parseSlotPrimaryFlag(value)).toThrow(BinAssignmentValidationError);
      try {
        parseSlotPrimaryFlag(value);
      } catch (error) {
        expect((error as BinAssignmentValidationError).code).toBe("BIN_ASSIGNMENT_PRIMARY_FLAG_INVALID");
      }
    },
  );
});

describe("parseBinAssignmentWriteRequest", () => {
  it("accepts the Slotting Setup payload and leaves isPrimary undefined", () => {
    expect(parseBinAssignmentWriteRequest({ productVariantId: 59, warehouseLocationId: 12 })).toEqual({
      productVariantId: 59,
      warehouseLocationId: 12,
    });
  });

  it("accepts an explicit 0 or 1 flag and drops unknown keys", () => {
    expect(
      parseBinAssignmentWriteRequest({ productVariantId: 59, warehouseLocationId: 12, isPrimary: 0, locationType: "pick" }),
    ).toEqual({ productVariantId: 59, warehouseLocationId: 12, isPrimary: 0 });
  });

  it("accepts integer strings for ids (URL params) but not other strings", () => {
    expect(parseBinAssignmentWriteRequest({ productVariantId: "59", warehouseLocationId: "12" })).toEqual({
      productVariantId: 59,
      warehouseLocationId: 12,
    });
    expect(() => parseBinAssignmentWriteRequest({ productVariantId: "59a", warehouseLocationId: 12 })).toThrow(
      BinAssignmentValidationError,
    );
  });

  it.each([
    ["missing variant", { warehouseLocationId: 12 }],
    ["missing location", { productVariantId: 59 }],
    ["zero id", { productVariantId: 0, warehouseLocationId: 12 }],
    ["negative id", { productVariantId: 59, warehouseLocationId: -1 }],
    ["fractional id", { productVariantId: 5.5, warehouseLocationId: 12 }],
    ["boolean flag", { productVariantId: 59, warehouseLocationId: 12, isPrimary: false }],
    ["string flag", { productVariantId: 59, warehouseLocationId: 12, isPrimary: "1" }],
    ["out-of-range flag", { productVariantId: 59, warehouseLocationId: 12, isPrimary: 2 }],
    ["no body", undefined],
  ])("rejects %s with a structured error", (_label, body) => {
    try {
      parseBinAssignmentWriteRequest(body);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(BinAssignmentValidationError);
      expect((error as BinAssignmentValidationError).code).toBe("BIN_ASSIGNMENT_REQUEST_INVALID");
      expect((error as Error).message).toMatch(/Invalid bin assignment request/);
    }
  });
});
