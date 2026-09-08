import { describe, expect, it, vi } from "vitest";
import { DropshipQuantityPublicationCatchupProvider, type DropshipQuantityPublicationCatchupDependencies } from "../../infrastructure/dropship-quantity-publication-catchup.provider";
import type { QuantityPublicationCatchup } from "../../../inventory-planning/application/quantity-publication-admission.port";
import type { QuantityPublicationScope } from "../../../inventory-planning/domain/quantity-publication-admission";
import { DropshipListingPushWorkerService, type DropshipListingPushWorkerRepository } from "../../application/dropship-listing-push-worker-service";
import type { DropshipMarketplaceListingIntent } from "../../application/dropship-marketplace-listing-provider";

const scope: QuantityPublicationScope = { destinationKind: "dropship_store_connection", connectionId: 7,
  providerKey: "ebay", providerScopeType: "account", externalScopeId: "account-one", externalInventoryItemId: "P5",
  productId: null, productVariantId: null };
const claim: QuantityPublicationCatchup = { catchupId: "3", revision: "2", attemptBoundaryId: "0", scope };
const listing = { listing_id: 4, vendor_id: 5, product_variant_id: 101, product_id: 20, sku: "P5", status: "active" };
const row = { productId: 20, productVariantId: 101, sku: "P5", previewStatus: "ready", listingIntent: { quantity: 14 },
  contentEvidenceHash: "a".repeat(64), rulePriceEvidenceHash: "b".repeat(64), priceSettingRevisionId: 8, priceCents: 1200 };
const job = { jobId: 9, vendorId: 5, storeConnectionId: 7, status: "queued" };
const item = { listingId: 4, productVariantId: 101, status: "completed" };
function setup() {
  const query = vi.fn().mockResolvedValueOnce({ rows: [listing] }).mockResolvedValueOnce({ rows: [] });
  const generatePreview = vi.fn().mockResolvedValue({ vendorId: 5, storeConnectionId: 7, platform: "ebay", rows: [row] });
  const createListingPushJob = vi.fn().mockResolvedValue({ job, items: [item] });
  const processJob = vi.fn().mockResolvedValue({ job: { ...job, status: "completed" }, items: [item] });
  const retryJob = vi.fn().mockResolvedValue({ status: "queued" });
  const dependencies = { database: { query }, preview: { generatePreview, createListingPushJob },
    worker: { processJob }, operations: { retryJob } } as unknown as DropshipQuantityPublicationCatchupDependencies;
  return { provider: new DropshipQuantityPublicationCatchupProvider(dependencies), dependencies, query, generatePreview,
    createListingPushJob, processJob, retryJob };
}

describe("Dropship current-quantity catch-up owner", () => {
  it("creates one exact current-preview job with content, rule and price evidence, then awaits owner completion", async () => {
    const context = setup();
    await context.provider.refresh(scope, claim);
    expect(context.generatePreview).toHaveBeenCalledWith({ vendorId: 5, storeConnectionId: 7,
      productVariantIds: [101], actor: { actorType: "system", actorId: "inventory_publication_catchup" } });
    expect(context.createListingPushJob).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "inventory-publication-catchup:3:2", productVariantIds: [101],
      expectedContentEvidenceHashesByVariantId: { "101": "a".repeat(64) },
      expectedRuleEvidenceHashesByVariantId: { "101": "b".repeat(64) },
      expectedPriceRevisionIdsByVariantId: { "101": 8 }, expectedPriceCentsByVariantId: { "101": 1200 },
    }));
    expect(context.processJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 9 }));
    expect(context.retryJob).not.toHaveBeenCalled();
    expect(context.query.mock.calls[0][1]).toEqual([7, "ebay", "account-one", null, "P5"]);
  });

  it.each(["failed", "completed"])("replays exact %s job before generating a changed request hash", async status => {
    const context = setup();
    context.query.mockReset().mockResolvedValueOnce({ rows: [listing] }).mockResolvedValueOnce({ rows: [{
      id: 9, vendor_id: 5, store_connection_id: 7, status, item_count: 1, exact_item_count: 1,
    }] });
    await context.provider.refresh(scope, claim);
    expect(context.generatePreview).not.toHaveBeenCalled();
    expect(context.createListingPushJob).not.toHaveBeenCalled();
    expect(context.retryJob).toHaveBeenCalledTimes(status === "failed" ? 1 : 0);
    expect(context.processJob).toHaveBeenCalledTimes(1);
  });

  it("resolves offer publication only through its persisted exact external offer id", async () => {
    const context = setup();
    const offerScope = { ...scope, externalInventoryItemId: "offer:known-offer:publish" };
    await context.provider.refresh(offerScope, { ...claim, scope: offerScope });
    expect(context.query.mock.calls[0][1]).toEqual([7, "ebay", "account-one", "known-offer", "offer:known-offer:publish"]);
  });

  it.each(["group:123", "batch:123", "offer:unknown:invalid"])("fails visible for unsupported %s identity without choosing a SKU", async identity => {
    const context = setup();
    const unsupported = { ...scope, externalInventoryItemId: identity };
    await expect(context.provider.refresh(unsupported, { ...claim, scope: unsupported }))
      .rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_OWNER_UNRESOLVED" });
    expect(context.query).not.toHaveBeenCalled();
  });

  it("rejects a mismatched retained scope before reading or changing anything", async () => {
    const context = setup();
    await expect(context.provider.refresh({ ...scope, connectionId: 8 }, claim))
      .rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_SCOPE_MISMATCH" });
    expect(context.query).not.toHaveBeenCalled();
  });

  it.each([{ rows: [] }, { rows: [listing, { ...listing, listing_id: 6 }] }])("rejects missing or ambiguous persisted listing identity", async ({ rows }) => {
    const context = setup();
    context.query.mockReset().mockResolvedValueOnce({ rows });
    await expect(context.provider.refresh(scope, claim)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_OWNER_UNRESOLVED" });
    expect(context.generatePreview).not.toHaveBeenCalled();
  });

  it("does not resume a paused or ended listing", async () => {
    const context = setup();
    context.query.mockReset().mockResolvedValueOnce({ rows: [{ ...listing, status: "paused" }] });
    await expect(context.provider.refresh(scope, claim)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_LISTING_CHANGED" });
    expect(context.processJob).not.toHaveBeenCalled();
  });

  it("rejects a stored job whose contents include another listing", async () => {
    const context = setup();
    context.query.mockReset().mockResolvedValueOnce({ rows: [listing] }).mockResolvedValueOnce({ rows: [{
      id: 9, vendor_id: 5, store_connection_id: 7, status: "queued", item_count: 2, exact_item_count: 1,
    }] });
    await expect(context.provider.refresh(scope, claim)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_JOB_MISMATCH" });
    expect(context.processJob).not.toHaveBeenCalled();
  });

  it("refuses blocked current preview without queueing a stale job", async () => {
    const context = setup();
    context.generatePreview.mockResolvedValue({ vendorId: 5, storeConnectionId: 7, platform: "ebay", rows: [{ ...row, previewStatus: "blocked" }] });
    await expect(context.provider.refresh(scope, claim)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_PREVIEW_BLOCKED" });
    expect(context.createListingPushJob).not.toHaveBeenCalled();
  });

  it("retries the failed original job through the real worker using current14 rather than persisted99", async () => {
    const context = setup();
    context.query.mockReset().mockResolvedValueOnce({ rows: [listing] }).mockResolvedValueOnce({ rows: [{
      id: 9, vendor_id: 5, store_connection_id: 7, status: "failed", item_count: 1, exact_item_count: 1,
    }] });
    const oldIntent = { platform: "ebay", listingMode: "live", sku: "P5", quantity: 99 } as DropshipMarketplaceListingIntent;
    const freshIntent = { ...oldIntent, quantity: 14 };
    const storedItem = { ...item, itemId: 1, jobId: 9, status: "queued", previewHash: "original-preview",
      result: { listingIntent: oldIntent }, listing: { listingId: 4, productVariantId: 101, status: "queued",
        externalListingId: "external4", externalOfferId: "offer4", lastPreviewHash: "original-preview" } };
    let completedItem = storedItem;
    const pushListing = vi.fn().mockResolvedValue({ status: "updated", externalListingId: "external4", externalOfferId: "offer4", rawResult: {} });
    const completeItem = vi.fn(async (input: { intent: DropshipMarketplaceListingIntent }) => {
      completedItem = { ...storedItem, status: "completed" };
      expect(input.intent.quantity).toBe(14);
      return completedItem;
    });
    const refreshListingIntent = vi.fn().mockResolvedValue(freshIntent);
    const worker = new DropshipListingPushWorkerService({
      repository: { claimJob: vi.fn().mockResolvedValue({ claimed: true, job: { ...job, platform: "ebay" },
        config: { platform: "ebay", isActive: true, listingMode: "live" },
        eligibility: { vendorStatus: "active", entitlementStatus: "active", storeLaunchReady: true }, items: [storedItem] }),
        markItemProcessing: vi.fn().mockResolvedValue(true), completeItem,
        blockItem: vi.fn(), failItem: vi.fn(),
        finalizeJob: vi.fn(async () => ({ job: { ...job, status: completedItem.status }, items: [completedItem],
          summary: { total: 1, completed: 1, failed: 0, blocked: 0, skipped: 0 } })),
      } as unknown as DropshipListingPushWorkerRepository,
      refreshListingIntent, marketplacePush: { pushListing }, clock: { now: () => new Date("2026-09-08T12:00:00Z") },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await new DropshipQuantityPublicationCatchupProvider({ ...context.dependencies, worker }).refresh(scope, claim);
    expect(context.retryJob).toHaveBeenCalledOnce();
    expect(refreshListingIntent).toHaveBeenCalledWith({ vendorId: 5, storeConnectionId: 7, productVariantId: 101 });
    expect(pushListing).toHaveBeenCalledWith(expect.objectContaining({ listingIntent: expect.objectContaining({ quantity: 14 }) }));
    expect(oldIntent.quantity).toBe(99);
    expect(completeItem).toHaveBeenCalledOnce();
    expect(context.createListingPushJob).not.toHaveBeenCalled();
  });

  it("does not treat a resolved failed or in-flight owner call as successful publication", async () => {
    const context = setup();
    context.processJob.mockResolvedValue({ job: { ...job, status: "failed" }, items: [{ ...item, status: "failed" }] });
    await expect(context.provider.refresh(scope, claim)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_JOB_INCOMPLETE" });
  });
});
