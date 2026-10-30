import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryProductSyncProgress, InventoryProductSyncReceipt, InventoryProductSyncReview } from "@shared/types/inventory-product-sync";
import { productSyncProgress, reviewProductSync, syncProductInventory } from "../product-sync-api";
import { productSyncState } from "../product-sync-presentation";

const command = { productId: 20, idempotencyKey: "11111111-1111-4111-8111-111111111111", expectedReviewHash: "a".repeat(64) };
const destination = { publicationTargetId: 1, channelId: 7, channelName: "Test channel", providerKey: "ebay", externalScopeId: "account" };
const row = { ...destination, productVariantId: 101, sku: "PACK-C5", quantity: "0", externalInventoryItemId: "901", status: "ready" as const, blockers: [] };
const receipt: InventoryProductSyncReceipt = { productId: 20, productName: "Packs", sku: "PACK", idempotencyKey: command.idempotencyKey,
  reviewHash: command.expectedReviewHash, requestedAt: "2026-10-29T12:00:00.000Z", requestedBy: "operator",
  targets: [{ ...destination, status: "ready", blockers: [] }], rows: [{ ...row, outboxId: "8", revision: "2" }] };
const review: InventoryProductSyncReview = { productId: 20, productName: "Packs", sku: "PACK", reviewHash: command.expectedReviewHash,
  ready: true, blockers: [], targets: receipt.targets, rows: [row] };
const progressRow: InventoryProductSyncProgress["rows"][number] = { publicationTargetId: 1, productVariantId: 101, outboxId: "8", state: "queued",
  errorCode: null, errorMessage: null, observedQuantity: null, observedAt: null };
const respond = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
afterEach(() => vi.unstubAllGlobals());

describe("product inventory sync transport and evidence", () => {
  it("sends only a product scope, reviewed hash and durable retry key", async () => {
    respond({ receipt, replayed: false });
    expect((await syncProductInventory(command, "operator")).receipt).toEqual(receipt);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/inventory-planning/admin/product-sync/sync");
    expect(options).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(options!.body as string)).toEqual(command);
  });

  it("validates product identity before sending a review request", async () => {
    respond(review);
    await expect(reviewProductSync(0)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(await reviewProductSync(20)).toEqual(review);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ productId: 20 });
  });

  it("rejects another product's valid review and incomplete readiness evidence", async () => {
    respond({ ...review, productId: 21 });
    await expect(reviewProductSync(20)).rejects.toMatchObject({ definitiveRejected: false });
    respond({ ...review, rows: [{ ...row, quantity: null }] });
    await expect(reviewProductSync(20)).rejects.toMatchObject({ definitiveRejected: false });
  });

  for (const [field, value] of [
    ["productId", 21], ["requestedBy", "another-actor"], ["reviewHash", "b".repeat(64)],
    ["idempotencyKey", "22222222-2222-4222-8222-222222222222"],
  ] as const) it(`rejects another ${field} in send and progress receipts`, async () => {
    const wrongReceipt = { ...receipt, [field]: value };
    respond({ receipt: wrongReceipt, replayed: false });
    await expect(syncProductInventory(command, "operator")).rejects.toMatchObject({ definitiveRejected: false });
    respond({ receipt: wrongReceipt, rows: [progressRow] });
    await expect(productSyncProgress(command, "operator")).rejects.toMatchObject({ definitiveRejected: false });
  });

  it("does not accept a different outbox, destination or variant as the receipt's delivery", async () => {
    for (const changed of [{ outboxId: "9" }, { publicationTargetId: 2 }, { productVariantId: 102 }]) {
      respond({ receipt, rows: [{ ...progressRow, ...changed }] });
      await expect(productSyncProgress(command, "operator")).rejects.toMatchObject({ definitiveRejected: false });
    }
  });

  it("keeps uncertain errors retryable and only accepts explicit 4xx definitive refusals", async () => {
    for (const [status, definitiveRejected, expected] of [[503, true, false], [409, false, false], [409, true, true], [401, undefined, false]] as const) {
      respond({ error: { message: "Sync refused", definitiveRejected } }, status);
      await expect(syncProductInventory(command, "operator")).rejects.toMatchObject({ definitiveRejected: expected });
    }
    respond({ broken: true });
    await expect(syncProductInventory(command, "operator")).rejects.toMatchObject({ definitiveRejected: false });
  });

  it("distinguishes exact dated verification from acknowledgement and contradictory evidence", () => {
    expect(productSyncState({ ...progressRow, state: "acknowledged" }, "0").verified).toBe(false);
    expect(productSyncState({ ...progressRow, state: "verified" }, "0").verified).toBe(false);
    expect(productSyncState({ ...progressRow, state: "verified", observedQuantity: "1", observedAt: receipt.requestedAt }, "0").verified).toBe(false);
    expect(productSyncState({ ...progressRow, state: "verified", observedQuantity: "0", observedAt: receipt.requestedAt }, "0")).toEqual({
      label: "Verified at channel", terminal: true, verified: true,
    });
    for (const state of ["queued", "leased", "retryable"] as const) expect(productSyncState({ ...progressRow, state }, "0").terminal).toBe(false);
    for (const state of ["dead_letter", "superseded", "cancelled", "drifted"] as const) expect(productSyncState({ ...progressRow, state }, "0").terminal).toBe(true);
  });
});
