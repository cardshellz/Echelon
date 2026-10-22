import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const f = vi.hoisted(() => ({
  select: vi.fn(), product: vi.fn(), destination: vi.fn(), update: vi.fn(), source: vi.fn(),
  receipt: vi.fn(), statuses: vi.fn(), block: vi.fn(), publish: vi.fn(),
}));
vi.mock("../../../../db", () => ({ pool: {} }));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({ EBAY_CHANNEL_ID: 67 }));
vi.mock("../../infrastructure/ebay-sync-selection.reader", () => ({
  EbaySyncSelectionReader: class { read = f.select; product = f.product; },
}));
vi.mock("../../infrastructure/ebay-active-listing-sync", async () => {
  const { z } = await import("zod");
  return {
    readEbaySyncDestination: f.destination, syncActiveListings: f.update,
    syncFilterSchema: z.object({ productIds: z.array(z.number().int().positive()).optional() }).nullable(),
    ebayListingSyncService: { getByCommand: f.receipt, recordAdmissionFailure: f.block },
    ebayListingSyncRepository: { readCommandStatuses: f.statuses },
  };
});
vi.mock("../../infrastructure/ebay-listing-push", () => ({ readEbayPublicationSource: f.source }));
vi.mock("../../ebay-publication-admission.service", () => ({ admitEbayPublication: f.publish }));
import { syncChannelListings } from "../../infrastructure/ebay-channel-listing-sync";

const destination = { channelId: 67, provider: "ebay", connectionId: 34, accountId: "seller-1", environment: "production" as const, marketplaceId: "EBAY_US" };
const state = { active: true, included: true, includedVariantCount: 1, hasPublishedIdentity: false };
const job = (productId: number) => ({ id: randomUUID(), productId, operation: "publish" as const, kind: "sync" as const,
  state: "queued" as const, code: null, message: null, nextAttemptAt: "2026-10-22T12:00:00Z", updatedAt: "2026-10-22T12:00:00Z" });
const result = { synced: 0, priceChanges: 0, qtyChanges: 0, policyChanges: 0, pending: 1, errors: 0, details: [], jobs: [job(1)] };
describe("unified eBay Sync composition", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    f.destination.mockResolvedValue(destination);
    f.receipt.mockResolvedValue(null); f.statuses.mockResolvedValue([]);
    f.product.mockImplementation(async productId => ({ productId, state }));
    f.select.mockResolvedValue([{ productId: 1, name: "Product 1", sku: "SKU-1", state }]);
    f.source.mockImplementation(async productId => ({ ...destination, productId }));
    f.publish.mockImplementation(async (command, dependencies) => {
      await dependencies.readSource(command.productId);
      return { success: false, status: "queued", job: job(command.productId) };
    });
    f.update.mockResolvedValue(result);
  });
  it("recovers the exact receipt before reading changed or unavailable product data", async () => {
    const saved = { ...job(1), identity: destination };
    f.receipt.mockResolvedValue(saved);
    f.product.mockRejectedValue(new Error("catalog unavailable"));
    const key = randomUUID();
    expect((await syncChannelListings({ productIds: [1] }, "operator", key)).jobs[0].id).toBe(saved.id);
    expect(f.receipt).toHaveBeenCalledWith(key, 67, "operator");
    expect(f.product).not.toHaveBeenCalled(); expect(f.select).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });
  it("uses verified creation for included products without a saved listing", async () => {
    const key = randomUUID();
    const response = await syncChannelListings({ productIds: [1] }, "operator", key);
    expect(response.pending).toBe(1); expect(response.errors).toBe(0);
    expect(f.publish).toHaveBeenCalledWith({ productId: 1, actor: "operator", commandKey: key }, expect.any(Object));
    expect(f.update).not.toHaveBeenCalled();
  });
  it("hands retained identities to existing verification rather than filtering ended projections out", async () => {
    f.product.mockResolvedValue({ productId: 1, state: { ...state, hasPublishedIdentity: true } });
    const key = randomUUID();
    await syncChannelListings({ productIds: [1] }, "operator", key);
    expect(f.update).toHaveBeenCalledWith({ productIds: [1] }, "operator", key,
      { connectionId: 34, accountId: "seller-1", environment: "production", marketplaceId: "EBAY_US" },
      undefined, { inspectRetainedIdentity: true });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("does not admit a creation source captured from another account", async () => {
    f.source.mockResolvedValue({ ...destination, productId: 1, accountId: "different-seller" });
    const response = await syncChannelListings({ productIds: [1] }, "operator", randomUUID());
    expect(response.details[0].code).toBe("EBAY_SYNC_IDENTITY_CHANGED");
    expect(response.jobs).toEqual([]); expect(f.block).not.toHaveBeenCalled();
  });
  it("does not treat a failed read as absence and continues unrelated product requests", async () => {
    f.product.mockImplementation(async productId => {
      if (productId === 1) throw new Error("connection lost");
      return { productId, state };
    });
    const keys = new Map([[1, randomUUID()], [2, randomUUID()]]);
    const response = await syncChannelListings({ productIds: [1, 2] }, "operator", undefined, undefined, keys);
    expect(response).toMatchObject({ pending: 1, errors: 1 });
    expect(response.details[0].code).toBe("EBAY_SYNC_ADMISSION_UNSAVED");
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.publish.mock.calls[0][0].productId).toBe(2);
    expect(f.block).not.toHaveBeenCalled();
  });
  it("returns verified completion without exposing internal worker fields", async () => {
    f.receipt.mockResolvedValue({ ...job(1), identity: destination, state: "completed", ownerToken: "private-worker-lease",
      result: { ...result, synced: 1, pending: 0, jobs: [] } });
    const response = await syncChannelListings({ productIds: [1] }, "operator", randomUUID());
    expect(response).toMatchObject({ synced: 1, pending: 0, errors: 0 });
    expect(response.jobs[0]).not.toHaveProperty("ownerToken");
    expect(response.jobs[0]).not.toHaveProperty("identity");
  });
  it("preserves a verified publication completed during admission", async () => {
    f.publish.mockResolvedValue({ success: true, status: "success", variantCount: 2, listingId: "verified-listing",
      job: { ...job(1), state: "completed" } });
    expect(await syncChannelListings({ productIds: [1] }, "operator", randomUUID()))
      .toMatchObject({ synced: 2, pending: 0, errors: 0, jobs: [{ state: "completed" }] });
  });
  it("rejects an exact receipt for another product without scheduling replacement work", async () => {
    f.receipt.mockResolvedValue({ ...job(2), identity: destination });
    const response = await syncChannelListings({ productIds: [1] }, "operator", randomUUID());
    expect(response.details[0].code).toBe("EBAY_SYNC_REPLAY_CONFLICT");
    expect(f.product).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  });
});
