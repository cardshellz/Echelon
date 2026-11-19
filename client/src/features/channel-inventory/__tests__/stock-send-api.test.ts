import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryStockSendProgress, InventoryStockSendReceipt } from "@shared/types/inventory-stock-send";
import { reviewStockSend, sendStock, stockSendContext, stockSendProgress } from "../stock-send-api";
import { stockSendState } from "../stock-send-presentation";

const command = { productId: 20, publicationTargetId: 1, productVariantIds: [101],
  idempotencyKey: "11111111-1111-4111-8111-111111111111", expectedReviewHash: "a".repeat(64) };
const receipt: InventoryStockSendReceipt = { productId: 20, publicationTargetId: 1, productVariantIds: [101], idempotencyKey: command.idempotencyKey,
  reviewHash: command.expectedReviewHash, requestedAt: "2026-10-29T12:00:00.000Z", requestedBy: "operator", channelId: 7, channelName: "Shopify", location: "123",
  rows: [{ productVariantId: 101, sku: "P5", quantity: "0", externalInventoryItemId: "901", outboxId: "8", revision: "2" }] };
const progressRow: InventoryStockSendProgress["rows"][number] = { productVariantId: 101, outboxId: "8", state: "queued", errorCode: null, errorMessage: null,
  observedQuantity: null, observedAt: null };
const selection = { productId: 20, publicationTargetId: 1, productVariantIds: [101] };
const respond = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
afterEach(() => vi.unstubAllGlobals());

describe("stock send transport and delivery evidence", () => {
  it("sends only the selected scope and reviewed hash, using the exact retained retry key", async () => {
    respond({ receipt, replayed: false });
    expect((await sendStock(command)).receipt).toEqual(receipt);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/inventory-planning/admin/stock-send/send");
    expect(options).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(options!.body as string)).toEqual(command);
  });
  it("refuses a valid-looking receipt for another selected location or command", async () => {
    respond({ receipt: { ...receipt, publicationTargetId: 2 }, replayed: false });
    await expect(sendStock(command)).rejects.toMatchObject({ definitiveRejected: false });
    respond({ receipt: { ...receipt, idempotencyKey: "22222222-2222-4222-8222-222222222222" }, rows: [progressRow] });
    await expect(stockSendProgress(command.idempotencyKey)).rejects.toMatchObject({ definitiveRejected: false });
  });
  it("refuses another variant's quantity review and another channel's destination response", async () => {
    respond({ ...selection, productVariantIds: [102], reviewHash: command.expectedReviewHash, ready: true, blockers: [],
      rows: [{ productVariantId: 102, sku: "OTHER", quantity: "999", externalInventoryItemId: "902" }] });
    await expect(reviewStockSend(selection)).rejects.toThrow("does not match your selection");
    respond({ productId: 20, productName: "Packs", variants: [], blockers: [], targets: [{ id: 1, channelId: 8, channelName: "Another Shopify",
      externalScopeId: "123", label: "Another store", blockers: [] }] });
    await expect(stockSendContext(20, 7)).rejects.toThrow("does not match this product and Shopify channel");
  });
  it("never treats a server failure as a definitive rejection even if its body says so", async () => {
    respond({ error: { message: "Unconfirmed", definitiveRejected: true } }, 503);
    await expect(sendStock(command)).rejects.toMatchObject({ definitiveRejected: false });
    respond({ error: { message: "Review changed", definitiveRejected: true } }, 409);
    await expect(sendStock(command)).rejects.toMatchObject({ definitiveRejected: true });
  });
  it("reports verification only from the exact observed quantity and dated provider evidence", () => {
    expect(stockSendState({ ...progressRow, state: "acknowledged" }, "0").verified).toBe(false);
    expect(stockSendState({ ...progressRow, state: "verified" }, "0").verified).toBe(false);
    expect(stockSendState({ ...progressRow, state: "verified", observedQuantity: "1", observedAt: receipt.requestedAt }, "0").verified).toBe(false);
    expect(stockSendState({ ...progressRow, state: "verified", observedQuantity: "0", observedAt: receipt.requestedAt }, "0")).toEqual({
      label: "Verified at Shopify", terminal: true, verified: true,
    });
    for (const state of ["queued", "leased", "retryable"] as const) expect(stockSendState({ ...progressRow, state }, "0").terminal).toBe(false);
    for (const state of ["dead_letter", "superseded", "cancelled"] as const) expect(stockSendState({ ...progressRow, state }, "0").terminal).toBe(true);
  });
});
