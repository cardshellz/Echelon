import { describe, expect, it, vi } from "vitest";
import { inventoryStockSendProgressSchema, inventoryStockSendReviewSchema, type InventoryStockSendReceipt, type InventoryStockSendRequest } from "@shared/types/inventory-stock-send";
import { InventoryStockSendService, type InventoryStockSendStore } from "../../application/inventory-stock-send.service";

const key = "11111111-1111-4111-8111-111111111111";
const selection = { productId: 20, publicationTargetId: 1, productVariantIds: [101] };
const review = { ...selection, reviewHash: "a".repeat(64), ready: true, blockers: [],
  rows: [{ productVariantId: 101, sku: "P5", quantity: "0", externalInventoryItemId: "901" }] };
const command = { ...selection, expectedReviewHash: review.reviewHash, idempotencyKey: key };
const receipt: InventoryStockSendReceipt = { ...selection, idempotencyKey: key, reviewHash: review.reviewHash,
  requestedAt: "2026-10-29T12:00:00.000Z", requestedBy: "operator", channelId: 35, channelName: "Shopify", location: "123",
  rows: [{ ...review.rows[0], outboxId: "8", revision: "2" }] };
const progressRow = { productVariantId: 101, outboxId: "8", state: "queued" as const, errorCode: null, errorMessage: null,
  observedQuantity: null, observedAt: null };

function fixture() {
  const store: InventoryStockSendStore = { context: vi.fn(), review: vi.fn(async () => review),
    send: vi.fn(async (command: InventoryStockSendRequest, actor: string) => ({ receipt: { ...receipt, productId: command.productId,
      publicationTargetId: command.publicationTargetId, productVariantIds: command.productVariantIds, idempotencyKey: command.idempotencyKey,
      requestedBy: actor, rows: command.productVariantIds.map((id, index) => ({ ...receipt.rows[0], productVariantId: id, outboxId: String(index + 8) })) }, replayed: false })),
    progress: vi.fn(async () => ({ receipt, rows: [progressRow] })) };
  const clock = vi.fn(() => new Date(receipt.requestedAt));
  return { store, clock, service: new InventoryStockSendService(store, clock) };
}
describe("selected stock-send contracts and application boundary", () => {
  it.each([[], [0], [-1], [1.5], [101, 101], Array.from({ length: 251 }, (_, index) => index + 1)].map(ids => ({ ids })))("refuses invalid variant selections $ids", async ({ ids }) => {
    const { service, store } = fixture();
    await expect(service.send({ ...command, productVariantIds: ids }, "operator")).rejects.toThrow();
    expect(store.send).not.toHaveBeenCalled();
  });
  it.each([{ productId: 0 }, { productId: 2_147_483_648 }, { publicationTargetId: -1 }, { quantity: 999 }, { actor: "spoofed" },
    { idempotencyKey: "not-a-uuid" }, { expectedReviewHash: "wrong" }])("refuses invalid or extra command fields %j", async override => {
    const { service, store } = fixture();
    await expect(service.send({ ...command, ...override }, "operator")).rejects.toThrow();
    expect(store.send).not.toHaveBeenCalled();
  });
  it("normalizes selection order without mutating input and binds the session actor into command identity", async () => {
    const { service, store, clock } = fixture();
    const input = Object.freeze({ ...command, productVariantIds: Object.freeze([102, 101]) });
    await service.send(input, "operator");
    const first = vi.mocked(store.send).mock.calls[0];
    expect(first[0].productVariantIds).toEqual([101, 102]);
    expect(input.productVariantIds).toEqual([102, 101]);
    expect(first[1]).toBe("operator"); expect(first[3]).toEqual(new Date(receipt.requestedAt));
    await service.send({ ...command, productVariantIds: [101, 102] }, "operator");
    expect(vi.mocked(store.send).mock.calls[1][2]).toBe(first[2]);
    await service.send({ ...command, productVariantIds: [101, 102] }, "another-operator");
    expect(vi.mocked(store.send).mock.calls[2][2]).not.toBe(first[2]);
    expect(clock).toHaveBeenCalledTimes(3);
  });
  it("requires the authenticated actor and validates outbound receipts", async () => {
    const { service, store } = fixture();
    await expect(service.send(command, " ")).rejects.toThrow();
    vi.mocked(store.send).mockResolvedValue({ receipt: { ...receipt, rows: [] }, replayed: false });
    await expect(service.send(command, "operator")).rejects.toMatchObject({ code: "STOCK_SEND_EVIDENCE_INVALID", status: 500 });
  });
  it("refuses a coherent receipt or progress belonging to a different command", async () => {
    const { service, store } = fixture();
    vi.mocked(store.send).mockResolvedValue({ receipt: { ...receipt, publicationTargetId: 9 }, replayed: false });
    await expect(service.send(command, "operator")).rejects.toMatchObject({ code: "STOCK_SEND_RECEIPT_INVALID", status: 500 });
    vi.mocked(store.progress).mockResolvedValue({ receipt: { ...receipt, idempotencyKey: "22222222-2222-4222-8222-222222222222" }, rows: [progressRow] });
    await expect(service.progress(key)).rejects.toMatchObject({ code: "STOCK_SEND_EVIDENCE_INVALID", status: 500 });
  });
  it("never turns missing quantity evidence into zero or an incomplete review into ready", () => {
    expect(inventoryStockSendReviewSchema.safeParse({ ...review, rows: [] }).success).toBe(false);
    expect(inventoryStockSendReviewSchema.safeParse({ ...review, rows: [{ ...review.rows[0], quantity: null }] }).success).toBe(false);
    expect(inventoryStockSendReviewSchema.safeParse({ ...review, rows: [{ ...review.rows[0], quantity: "0" }] }).success).toBe(true);
  });
  it("requires progress to cover the exact receipt, not another variant's successful update", () => {
    expect(inventoryStockSendProgressSchema.safeParse({ receipt, rows: [{ ...progressRow, productVariantId: 102 }] }).success).toBe(false);
    expect(inventoryStockSendProgressSchema.safeParse({ receipt, rows: [{ ...progressRow, outboxId: "99" }] }).success).toBe(false);
    expect(inventoryStockSendProgressSchema.safeParse({ receipt, rows: [] }).success).toBe(false);
  });
});
