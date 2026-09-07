import { describe, expect, it, vi } from "vitest";
import { retainedPurchaseOrderHistoryKinds } from "../../purchase-order-history.policy";
import { isPurchaseOrderHistoryConstraintViolation, readPurchaseOrderHistoryPresence } from "../../purchase-order-history.repository";

describe("purchase order retained history boundary", () => {
  it("names all retained history kinds without mutating the record", () => {
    const history = Object.freeze({ hasEvents: true, hasStatusHistory: true, hasRevisions: true });
    expect(retainedPurchaseOrderHistoryKinds(history)).toEqual(["events", "status_history", "revisions"]);
    expect(retainedPurchaseOrderHistoryKinds({ hasEvents: false, hasStatusHistory: false, hasRevisions: false })).toEqual([]);
  });

  it.each([0, -1, 1.5, 2147483648, Number.NaN])("rejects invalid purchase ID %s before any query", async (id) => {
    const execute = vi.fn();
    await expect(readPurchaseOrderHistoryPresence({ execute }, id)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not treat a missing or malformed history query result as absence of history", async () => {
    await expect(readPurchaseOrderHistoryPresence({ execute: async () => ({ rows: [] }) }, 1)).rejects.toThrow();
    await expect(readPurchaseOrderHistoryPresence({ execute: async () => ({ rows: [{ hasEvents: "false", hasStatusHistory: false, hasRevisions: false }] }) }, 1)).rejects.toThrow();
  });

  it("classifies only the exact history guard constraints, including the Drizzle wrapper", () => {
    for (const constraint of ["po_event_history_immutable", "purchase_order_history_retention"]) {
      expect(isPurchaseOrderHistoryConstraintViolation({ code: "23514", constraint })).toBe(true);
      expect(isPurchaseOrderHistoryConstraintViolation({ cause: { code: "23514", constraint } })).toBe(true);
    }
    for (const error of [null, "history", {}, { code: "23505", constraint: "purchase_order_history_retention" },
      { code: "23514", constraint: "another_money_constraint" }, { cause: { code: "23514", constraint: "other" } }]) {
      expect(isPurchaseOrderHistoryConstraintViolation(error)).toBe(false);
    }
  });
});