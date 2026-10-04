import { describe, expect, it } from "vitest";
import { resolveReplenishmentAutoExecution } from "../../domain/replenishment-auto-execution";
import { classifyReplenishmentExecutionFailure } from "../../infrastructure/replenishment-execution-failure";

describe("rule-owned automatic replenishment", () => {
  it.each(["full_case", "case_break", "package_conversion"])(
    "inherits warehouse Inline for %s",
    (method) => {
      expect(
        resolveReplenishmentAutoExecution(
          0,
          0,
          { replenMode: "inline", inlineReplenMaxUnits: 50 },
          1000,
          method,
        ),
      ).toEqual({ shouldAutoExecute: true, executionMode: "inline" });
    },
  );
  it.each(["full_case", "case_break"])(
    "preserves the SKU and tier queue overrides for %s",
    (method) => {
      expect(
        resolveReplenishmentAutoExecution(
          2,
          1,
          { replenMode: "inline", inlineReplenMaxUnits: 50 },
          10,
          method,
        ).executionMode,
      ).toBe("queue");
      expect(
        resolveReplenishmentAutoExecution(
          0,
          2,
          { replenMode: "inline", inlineReplenMaxUnits: 50 },
          10,
          method,
        ).executionMode,
      ).toBe("queue");
      expect(
        resolveReplenishmentAutoExecution(1, 2, null, 10, method).executionMode,
      ).toBe("inline");
    },
  );
  it("applies the existing hybrid BASE-unit limit to same-SKU transfers", () => {
    expect(
      resolveReplenishmentAutoExecution(
        0,
        0,
        { replenMode: "hybrid", inlineReplenMaxUnits: 50 },
        50,
        "full_case",
      ).executionMode,
    ).toBe("inline");
    expect(
      resolveReplenishmentAutoExecution(
        0,
        0,
        { replenMode: "hybrid", inlineReplenMaxUnits: 50 },
        51,
        "full_case",
      ).executionMode,
    ).toBe("queue");
  });
  it.each(["pallet_drop", "build", "unknown"])(
    "retains the separate execution contract for %s",
    (method) => {
      expect(
        resolveReplenishmentAutoExecution(
          1,
          1,
          { replenMode: "inline", inlineReplenMaxUnits: 50 },
          10,
          method,
        ).executionMode,
      ).toBe("queue");
    },
  );
});
describe("replenishment failure classification", () => {
  it.each([
    "40001",
    "40P01",
    "55P03",
    "57014",
    "08006",
    "57P01",
    "ECONNRESET",
    "ETIMEDOUT",
  ])("retains %s for durable retry", (code) => {
    expect(
      classifyReplenishmentExecutionFailure(
        new Error("query failed", { cause: { code } }),
      ),
    ).toEqual({ retryable: true, code });
  });
  it.each([
    "23514",
    "COST_EVIDENCE_MISSING",
    "CANONICAL_REPLENISHMENT_TASK_INVALID",
    "DATA_INTEGRITY_VIOLATION",
  ])("requires review for %s", (code) => {
    expect(
      classifyReplenishmentExecutionFailure({ code, cause: { code: "40001" } }),
    ).toEqual({ retryable: false, code });
  });
  it("requires review for unknown errors and handles cyclic cause chains", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(classifyReplenishmentExecutionFailure(error)).toEqual({
      retryable: false,
      code: "REPLENISHMENT_EXECUTION_UNCLASSIFIED",
    });
    expect(
      classifyReplenishmentExecutionFailure(new Error("insufficient stock")),
    ).toMatchObject({ retryable: false });
  });
});
