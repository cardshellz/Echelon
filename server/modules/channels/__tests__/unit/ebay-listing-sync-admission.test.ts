import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitEbayListingSyncProducts,
  type EbayListingSyncAdmissionDependencies,
  type EbayListingSyncAdmissionProduct,
} from "../../ebay-listing-sync-admission";
import { captureExistingEbayListingIdentity } from "../../ebay-existing-listing-identity";
import { EbayListingSyncError, storedEbayListingSyncJobSchema } from "../../ebay-listing-sync.domain";
import { ebayListingSyncJobSchema } from "@shared/types/ebay-listing-sync";

const now = "2026-10-09T20:00:00.000Z";
const context = { channelId: 67, connectionId: 12, accountId: "seller", marketplaceId: "EBAY_US" };
function product(productId: number, invalid = false): EbayListingSyncAdmissionProduct {
  return {
    productId, productName: `Product ${productId}`, variants: [{ variantId: productId * 10, sku: `CATALOG-${productId}` }],
    captureIdentity: () => captureExistingEbayListingIdentity([{ product_id: productId, variant_id: productId * 10,
      variant_sku: invalid ? null : `CATALOG-${productId}`, external_sku: `EBAY-${productId}`,
      external_variant_id: `offer-${productId}`, external_product_id: `listing-${productId}` }], context),
  };
}
function fixture() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let next = 0;
  const uuid = vi.fn(() => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`);
  const enqueue: EbayListingSyncAdmissionDependencies["enqueue"] = vi.fn(async (identity, actor, commandKey) => storedEbayListingSyncJobSchema.parse({
    id: commandKey, productId: identity.productId, kind: "sync", state: "queued", code: null, message: null,
    nextAttemptAt: now, updatedAt: now, identity, revision: "1", claimedRevision: null, ownerToken: null, attempts: 0,
    result: null, verificationIntentHash: null, verificationRevision: null,
  }));
  const recordFailure: EbayListingSyncAdmissionDependencies["recordFailure"] = vi.fn(async failure => ebayListingSyncJobSchema.parse({
    id: failure.commandKey, kind: "admission", productId: failure.productId, state: "needs_attention", code: failure.code,
    message: failure.message, nextAttemptAt: now, updatedAt: now,
  }));
  return { enqueue, recordFailure, uuid };
}
afterEach(() => vi.restoreAllMocks());

describe("product-scoped eBay sync admission", () => {
  it("admits valid/invalid/valid products independently and returns exact persisted rejection alongside saved jobs", async () => {
    const dependencies = fixture();
    const result = await admitEbayListingSyncProducts([product(3), product(20, true), product(86)], { channelId: 67, actor: "operator" }, dependencies);
    expect(result).toMatchObject({ synced: 0, errors: 1, pending: 2 });
    expect(result.jobs.map(job => [job.productId, job.state])).toEqual([[3, "queued"], [20, "needs_attention"], [86, "queued"]]);
    expect(result.details).toEqual([expect.objectContaining({ productId: 20, productName: "Product 20", variantId: 200,
      variantSku: "CATALOG-20", code: "EBAY_SYNC_MAPPING_INVALID", success: false })]);
    expect(dependencies.enqueue).toHaveBeenCalledTimes(2);
    expect(dependencies.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ productId: 20, variantIds: [200], actor: "operator" }));
  });

  it("isolates an enqueue replay/ownership conflict as a durable product failure", async () => {
    const dependencies = fixture();
    vi.mocked(dependencies.enqueue).mockRejectedValueOnce(new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "Existing work targets another saved listing."));
    const result = await admitEbayListingSyncProducts([product(3), product(86)], { channelId: 67, actor: "operator" }, dependencies);
    expect(result.jobs.map(job => job.state)).toEqual(["needs_attention", "queued"]);
    expect(result.details[0]).toMatchObject({ productId: 3, code: "EBAY_SYNC_IDENTITY_CHANGED" });
    expect(result.pending).toBe(1);
  });

  it("never claims a rejection was saved if its persistence failed, and continues healthy products", async () => {
    const dependencies = fixture();
    vi.mocked(dependencies.recordFailure).mockRejectedValueOnce(new Error("Database unavailable"));
    const result = await admitEbayListingSyncProducts([product(3, true), product(86)], { channelId: 67, actor: "operator" }, dependencies);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].productId).toBe(86);
    expect(result.details[0]).toMatchObject({ productId: 3, code: "EBAY_SYNC_ADMISSION_UNSAVED" });
    expect(result.details[0].error).toContain("could not be saved");
  });

  it("reuses the caller's exact single-product command key for both success and recorded failure", async () => {
    const dependencies = fixture();
    const commandKey = "e640217c-260b-4f65-920e-a42bc4c7e176";
    await admitEbayListingSyncProducts([product(3)], { channelId: 67, actor: "operator", commandKey }, dependencies);
    expect(dependencies.enqueue).toHaveBeenCalledWith(expect.anything(), "operator", commandKey);
    await admitEbayListingSyncProducts([product(3, true)], { channelId: 67, actor: "operator", commandKey }, dependencies);
    expect(dependencies.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ commandKey }));
    expect(dependencies.uuid).not.toHaveBeenCalled();
  });

  it("rejects a single command key for multiple products before accepting anything", async () => {
    const dependencies = fixture();
    await expect(admitEbayListingSyncProducts([product(3), product(86)], { channelId: 67, actor: "operator", commandKey: "e640217c-260b-4f65-920e-a42bc4c7e176" }, dependencies))
      .rejects.toMatchObject({ code: "EBAY_SYNC_COMMAND_SCOPE_INVALID" });
    expect(dependencies.enqueue).not.toHaveBeenCalled();
    expect(dependencies.recordFailure).not.toHaveBeenCalled();
  });
});
