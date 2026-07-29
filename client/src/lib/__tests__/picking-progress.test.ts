import { describe, expect, it } from "vitest";

import { derivePickerLineProgress } from "../picking-progress";

describe("derivePickerLineProgress", () => {
  it("does not reopen a fully picked line when only part of it has shipped", () => {
    expect(derivePickerLineProgress({
      quantity: 2,
      pickedQuantity: 2,
      fulfilledQuantity: 1,
      status: "in_progress",
    })).toEqual({
      targetQuantity: 2,
      pickedQuantity: 2,
      status: "completed",
    });
  });

  it("keeps cumulative progress for a genuinely partial pick", () => {
    expect(derivePickerLineProgress({
      quantity: 2,
      pickedQuantity: 1,
      fulfilledQuantity: 1,
      status: "in_progress",
    })).toEqual({
      targetQuantity: 2,
      pickedQuantity: 1,
      status: "in_progress",
    });
  });

  it("treats shipped quantity as the minimum proven picked quantity", () => {
    expect(derivePickerLineProgress({
      quantity: 2,
      pickedQuantity: 0,
      fulfilledQuantity: 1,
      status: "in_progress",
    })).toEqual({
      targetQuantity: 2,
      pickedQuantity: 1,
      status: "in_progress",
    });
  });

  it("preserves explicit short status", () => {
    expect(derivePickerLineProgress({
      quantity: 3,
      pickedQuantity: 1,
      fulfilledQuantity: 0,
      status: "short",
    })).toEqual({
      targetQuantity: 3,
      pickedQuantity: 1,
      status: "short",
    });
  });
});
