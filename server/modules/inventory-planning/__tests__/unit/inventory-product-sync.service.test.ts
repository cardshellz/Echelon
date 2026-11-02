import { describe, expect, it, vi } from "vitest";
import { inventoryProductSyncReviewSchema, inventoryProductSyncProgressSchema,
  type InventoryProductSyncReceipt } from "@shared/types/inventory-product-sync";
import { InventoryProductSyncService, type InventoryProductSyncStore } from "../../application/inventory-product-sync.service";

const key = "11111111-1111-4111-8111-111111111111";
const row = { publicationTargetId: 1, channelId: 35, channelName: "Shopify", providerKey: "shopify", externalScopeId: "123",
  productVariantId: 101, sku: "SKU-P1", quantity: "0", externalInventoryItemId: "901", status: "ready" as const, blockers: [] };
const target = { publicationTargetId: row.publicationTargetId, channelId: row.channelId, channelName: row.channelName,
  providerKey: row.providerKey, externalScopeId: row.externalScopeId, status: "ready" as const, blockers: [] };
const review = { productId: 20, productName: "Product", sku: "SKU", reviewHash: "a".repeat(64), ready: true,
  blockers: [], rows: [row], targets: [target] };
const command = { productId: 20, expectedReviewHash: review.reviewHash, idempotencyKey: key };
const receipt: InventoryProductSyncReceipt = { productId: 20, productName: "Product", sku: "SKU", idempotencyKey: key,
  reviewHash: review.reviewHash, requestedAt: "2026-10-30T12:00:00.000Z", requestedBy: "operator", targets: [target],
  rows: [{ ...row, outboxId: "8", revision: "2" }] };
const progressRow = { publicationTargetId: 1, productVariantId: 101, outboxId: "8", state: "queued" as const,
  errorCode: null, errorMessage: null, observedQuantity: null, observedAt: null };
function fixture() {
  const store: InventoryProductSyncStore = { review: vi.fn(async () => review),
    sync: vi.fn(async (_command, actor) => ({ receipt: { ...receipt, requestedBy: actor }, replayed: false })),
    progress: vi.fn(async () => ({ receipt, rows: [progressRow] })) };
  const clock = vi.fn(() => new Date(receipt.requestedAt));
  return { store, clock, service: new InventoryProductSyncService(store, clock) };
}

describe("product ATP sync application contract", () => {
  it.each([{ productId: 0 }, { productId: -1 }, { productId: 1.5 }, { productId: 2_147_483_648 },
    { quantity: 999 }, { channelId: 35 }, { publicationTargetId: 1 }, { productVariantIds: [101] }, { actor: "spoofed" },
    { idempotencyKey: "not-a-uuid" }, { expectedReviewHash: "wrong" }])("refuses invalid or caller-controlled scope %j", async override => {
    const { service, store } = fixture();
    await expect(service.sync({ ...command, ...override }, "operator")).rejects.toThrow();
    expect(store.sync).not.toHaveBeenCalled();
  });
  it("requires a session actor and binds it, the review and product to retry identity", async () => {
    const { service, store, clock } = fixture();
    await expect(service.sync(command, " ")).rejects.toThrow();
    const immutable = Object.freeze({ ...command });
    await service.sync(immutable, "operator");
    const first = vi.mocked(store.sync).mock.calls[0];
    expect(first[0]).toEqual(command); expect(first[1]).toBe("operator"); expect(first[3]).toEqual(clock());
    await service.sync(command, "operator");
    expect(vi.mocked(store.sync).mock.calls[1][2]).toBe(first[2]);
    await service.sync(command, "other");
    expect(vi.mocked(store.sync).mock.calls[2][2]).not.toBe(first[2]);
  });
  it("rejects a review, receipt or progress for another product or command", async () => {
    const { service, store } = fixture();
    vi.mocked(store.review).mockResolvedValue({ ...review, productId: 21 });
    await expect(service.review({ productId: 20 })).rejects.toMatchObject({ code: "PRODUCT_SYNC_REVIEW_INVALID" });
    vi.mocked(store.sync).mockResolvedValue({ receipt: { ...receipt, productId: 21 }, replayed: false });
    await expect(service.sync(command, "operator")).rejects.toMatchObject({ code: "PRODUCT_SYNC_RECEIPT_INVALID" });
    vi.mocked(store.progress).mockResolvedValue({ receipt: { ...receipt, idempotencyKey: "22222222-2222-4222-8222-222222222222" }, rows: [progressRow] });
    await expect(service.progress(key)).rejects.toMatchObject({ code: "PRODUCT_SYNC_EVIDENCE_INVALID" });
  });
  it("treats damaged saved evidence as uncertain, preserving the retry key", async () => {
    const { service, store } = fixture();
    vi.mocked(store.sync).mockResolvedValue({ receipt: { ...receipt, rows: [] }, replayed: false });
    await expect(service.sync(command, "operator")).rejects.toMatchObject({ code: "PRODUCT_SYNC_EVIDENCE_INVALID", status: 500 });
  });
  it("supports partial destination readiness and explicit zero without inventing missing quantity", () => {
    const blockedTarget = { ...target, publicationTargetId: 2, status: "blocked", blockers: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"] };
    const blockedRow = { ...row, publicationTargetId: 2, quantity: null, externalInventoryItemId: null,
      status: "blocked", blockers: blockedTarget.blockers };
    expect(inventoryProductSyncReviewSchema.safeParse({ ...review, targets: [target, blockedTarget], rows: [row, blockedRow] }).success).toBe(true);
    expect(inventoryProductSyncReviewSchema.safeParse({ ...review, rows: [{ ...row, quantity: null }] }).success).toBe(false);
    expect(inventoryProductSyncReviewSchema.safeParse({ ...review, rows: [] }).success).toBe(false);
    expect(inventoryProductSyncReviewSchema.safeParse({ ...review, blockers: ["Paused"] }).success).toBe(false);
    expect(inventoryProductSyncReviewSchema.safeParse({ ...review, rows: [row, row] }).success).toBe(false);
  });
  it.each([{ publicationTargetId: 2 }, { productVariantId: 102 }, { outboxId: "9" }])("requires exact destination and variant receipt evidence %j", override => {
    expect(inventoryProductSyncProgressSchema.safeParse({ receipt, rows: [{ ...progressRow, ...override }] }).success).toBe(false);
    expect(inventoryProductSyncProgressSchema.safeParse({ receipt, rows: [] }).success).toBe(false);
  });
});
