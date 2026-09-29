import { describe, expect, it, vi } from "vitest";
import { readEbayQuantityUpdateResults, sendEbayQuantityUpdates } from "../../adapters/ebay/ebay-quantity-update";

const updates = [{ sku: "A", offerId: "offer-A", quantity: 0 }, { sku: "B", offerId: "offer-B", quantity: 7 }];
describe("shared eBay quantity-only sender", () => {
  it("associates mixed split/combined responses by identity, preserving partial failure details", async () => {
    const send = vi.fn(async () => ({ responses: [
      { sku: "B", offerId: "offer-B", statusCode: 200 },
      { sku: "A", statusCode: 200 },
      { sku: "A", offerId: "offer-A", statusCode: 404, errors: [{ errorId: 25710, message: "Invalid offerId" }] },
    ] }));
    const results = await sendEbayQuantityUpdates(send, updates);
    expect(results).toMatchObject([
      { sku: "A", confirmed: false, statusCode: 404, errors: [{ errorId: 25710 }] },
      { sku: "B", confirmed: true },
    ]);
    expect(send).toHaveBeenCalledExactlyOnceWith({ requests: updates.map(update => ({
      sku: update.sku, shipToLocationAvailability: { quantity: update.quantity },
      offers: [{ offerId: update.offerId, availableQuantity: update.quantity }],
    })) });
  });
  it("does not turn malformed or missing evidence into success", () => {
    for (const response of [undefined, { responses: [] }, { responses: [{ sku: "A", statusCode: 200 }] },
      { responses: [{ sku: "OTHER", offerId: "offer-A", statusCode: 200 }] },
      { responses: [{ sku: "A", offerId: "offer-A", statusCode: 200 }], errors: [{ message: "Batch failed" }] }]) {
      expect(readEbayQuantityUpdateResults(response, updates).every(result => !result.confirmed)).toBe(true);
    }
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid quantity %s before I/O", async quantity => {
    const send = vi.fn();
    await expect(sendEbayQuantityUpdates(send, [{ ...updates[0]!, quantity }])).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects duplicate identities and does not mutate the caller's input", async () => {
    const send = vi.fn();
    const input = updates.map(update => Object.freeze({ ...update }));
    await expect(sendEbayQuantityUpdates(send, [input[0]!, input[0]!])).rejects.toThrow("distinct");
    expect(send).not.toHaveBeenCalled();
    expect(input).toEqual(updates);
  });
  it.each([
    { label: "empty", input: [] },
    { label: "over the batch limit", input: Array.from({ length: 26 }, (_, i) => ({ sku: `SKU-${i}`, offerId: `offer-${i}`, quantity: 0 })) },
    { label: "blank identity", input: [{ ...updates[0]!, sku: " " }] },
    { label: "duplicate SKU", input: [updates[0]!, { ...updates[1]!, sku: "A" }] },
    { label: "duplicate offer", input: [updates[0]!, { ...updates[1]!, offerId: "offer-A" }] },
  ])("rejects $label before I/O", async ({ input }) => {
    const send = vi.fn();
    await expect(sendEbayQuantityUpdates(send, input)).rejects.toMatchObject({ code: "EBAY_QUANTITY_UPDATE_INPUT_INVALID" });
    expect(send).not.toHaveBeenCalled();
  });
  it("accepts the largest batch with separate confirmations for every operation", async () => {
    const input = Array.from({ length: 25 }, (_, i) => ({ sku: `SKU-${i}`, offerId: `offer-${i}`, quantity: i }));
    const send = vi.fn(async () => ({ responses: input.flatMap(row => [
      { sku: row.sku, statusCode: 200 }, { sku: row.sku, offerId: row.offerId, statusCode: 200 },
    ]).reverse() }));
    const result = await sendEbayQuantityUpdates(send, input);
    expect(result).toHaveLength(25);
    expect(result.every(row => row.confirmed)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });
  it("preserves an uncertain network outcome without an automatic second mutation", async () => {
    const failure = new Error("Response lost");
    const send = vi.fn(async () => { throw failure; });
    await expect(sendEbayQuantityUpdates(send, updates)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledOnce();
  });
});
