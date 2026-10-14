import { describe, expect, it } from "vitest";
import { parseReceivingCloseResult, parseReceivingHeaderResult, receivingCostOutcomeMessage, receivingIssueMessages } from "../../receiving-outcomes";

describe("receipt command outcomes", () => {
  it("does not confirm an HTTP 200 cached error as a completed receipt", () => {
    expect(() => parseReceivingCloseResult({ error: "Source requires review", code: "RECEIVING_SOURCE_UNMATCHED" }, 31)).toThrow("could not be verified");
  });
  it("checks returned receipt identity and closed state without requiring old callers to include a header", () => {
    const result = { success: true, unitsReceived: 0, linesProcessed: 0 };
    expect(parseReceivingCloseResult(result, 31)).toEqual(result);
    expect(() => parseReceivingCloseResult({ ...result, order: { id: 32, status: "closed" } }, 31)).toThrow();
    expect(() => parseReceivingCloseResult({ ...result, order: { id: 31, status: "open" } }, 31)).toThrow();
    expect(() => parseReceivingCloseResult({ ...result, unitsReceived: -1 }, 31)).toThrow();
  });
  it("rejects settings responses for another receipt or missing nullable location evidence", () => {
    const result = { id: 31, warehouseId: 2, receivingLocationId: null };
    expect(parseReceivingHeaderResult(result, 31)).toEqual(result);
    expect(() => parseReceivingHeaderResult(result, 32)).toThrow("could not be verified");
    expect(() => parseReceivingHeaderResult({ id: 31, warehouseId: 2 }, 31)).toThrow();
  });
  it("preserves source/warehouse explanations and supports older missing-link issues", () => {
    expect(receivingIssueMessages([
      { receivingLineId: 7, code: "RECEIVING_SOURCE_AMBIGUOUS", message: "Select the matching PO line." },
      { sku: "CASE", missingLocation: true, missingVariant: true },
      null,
    ])).toEqual(["Line 7: Select the matching PO line.", "CASE: Select the missing product link and location."]);
  });
  it("distinguishes incomplete cost work from a completed physical receipt", () => {
    expect(receivingCostOutcomeMessage({ state: "review_required" })).toContain("Costs require review");
    expect(receivingCostOutcomeMessage({ state: "retry_required" })).toContain("Cost processing is pending");
    expect(receivingCostOutcomeMessage({ state: "applied" })).toBeNull();
    expect(receivingCostOutcomeMessage({ state: "not_applicable" })).toBeNull();
    expect(receivingCostOutcomeMessage(undefined)).toBeNull();
  });
});
