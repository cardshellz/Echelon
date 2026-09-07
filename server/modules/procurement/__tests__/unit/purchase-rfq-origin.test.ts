import { describe, expect, it } from "vitest";
import { readPurchaseRfqOrigins } from "../../purchase-rfq-origin.repository";
import type { Transaction } from "../../purchase-workspace-read";

const source = {
  id: 1, rfqId: 2, rfqNumber: "RFQ-2", rfqLineId: 3, purchaseOrderLineId: 4,
  quoteRevisionId: 5, quoteReference: "VENDOR-5", quotedPieces: 120, currency: "USD",
  linkedAt: new Date("2026-09-07T12:00:00Z"), linkedPurchaseOrderId: 6,
  actualPurchaseOrderId: 6, quoteRfqId: 2, quoteRfqLineId: 3,
};
function transaction(rows: unknown[]): Transaction {
  return { execute: async () => ({ rows }) } as unknown as Transaction;
}

describe("purchase RFQ origin evidence", () => {
  it("returns only the verified public source contract without internal identity checks", async () => {
    const [result] = await readPurchaseRfqOrigins(transaction([source]), 6);
    expect(result).toEqual({ id: 1, rfqId: 2, rfqNumber: "RFQ-2", rfqLineId: 3, purchaseOrderLineId: 4,
      quoteRevisionId: 5, quoteReference: "VENDOR-5", quotedPieces: 120, currency: "USD", linkedAt: "2026-09-07T12:00:00.000Z" });
    expect(source.linkedAt).toBeInstanceOf(Date);
  });
  it.each(["linkedPurchaseOrderId", "actualPurchaseOrderId", "quoteRfqId", "quoteRfqLineId"])(
    "rejects a conflicting %s instead of displaying an unrelated source", async (field) => {
      await expect(readPurchaseRfqOrigins(transaction([{ ...source, [field]: 99 }]), 6))
        .rejects.toMatchObject({ code: "PURCHASE_RFQ_SOURCE_CONFLICT" });
    },
  );
  it("fails explicitly when the bounded source read would omit history", async () => {
    await expect(readPurchaseRfqOrigins(transaction(Array.from({ length: 10_001 }, () => source)), 6))
      .rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_TOO_LARGE" });
  });
  it("rejects missing quote evidence instead of inferring a supplier or price", async () => {
    await expect(readPurchaseRfqOrigins(transaction([{ ...source, currency: null }]), 6)).rejects.toThrow();
  });
});
