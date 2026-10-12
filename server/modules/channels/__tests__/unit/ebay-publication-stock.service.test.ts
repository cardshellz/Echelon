import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EbayPublicationStockService, type EbayPublicationStockDependencies, type EbayStockPublicationSource } from "../../ebay-publication-stock.service";
import { EbayListingSyncError } from "../../ebay-listing-sync.domain";
import type { InventoryEbayPublicationReadiness } from "@shared/types/ebay-publication-readiness";
import { syncIdentity } from "../fixtures/ebay-listing-sync.fixture";

function fixture() {
  const now = new Date("2026-10-12T12:00:00Z");
  const identity = { ...syncIdentity, variants: syncIdentity.variants.map(member => ({ ...member, listingId: null, externalSku: null, mappingExists: true })) };
  const source: EbayStockPublicationSource = {
    sourceIdentity: identity, targetIdentity: identity, productName: "Blue Hint",
    inventorySource: { channelId: 1, connectionId: 1, productId: 20, accountId: identity.accountId, environment: "production", variants: [{ productVariantId: 101, sku: "P5" }] },
    inspection: { providerAccount: { provider: "ebay", accountNamespace: "production", externalAccountId: identity.accountId,
      identityScheme: "provider_user_id", externalDisplayNameSnapshot: null, evidenceHash: "e".repeat(64) },
      observedAt: now, skus: [], publication: null, publicationIssue: null, groupKey: "PACK", groupSkus: ["P5"] },
  };
  const inventory: InventoryEbayPublicationReadiness = { channelId: 1, connectionId: 1, productId: 20, publicationTargetId: 3,
    targetRevision: "6", reviewHash: "a".repeat(64), ready: true, currentlyReady: false,
    variants: [{ productVariantId: 101, sku: "P5", mappingAction: "promote_draft", membershipAction: "include", desiredQuantity: "17" }], blockers: [], effects: ["Connect this exact SKU."] };
  const deps = {
    channelId: 1, prepare: vi.fn(async () => structuredClone(source)), reviewInventory: vi.fn(async () => structuredClone(inventory)),
    findApplied: vi.fn<EbayPublicationStockDependencies["findApplied"]>(async () => null),
    commit: vi.fn<EbayPublicationStockDependencies["commit"]>(async input => ({ replayed: false,
      receipt: { commandKey: input.command.commandKey, productId: 20, reviewHash: input.command.expectedReviewHash, appliedAt: now.toISOString() },
      job: { id: input.command.commandKey, productId: 20, kind: "sync", operation: "publish", state: "queued", code: null, message: null, nextAttemptAt: now.toISOString(), updatedAt: now.toISOString() } })),
    reject: vi.fn<EbayPublicationStockDependencies["reject"]>(async input => { throw Object.assign(new EbayListingSyncError(input.code, input.message), { definitiveRejected: true }); }),
    now: () => now,
  } satisfies EbayPublicationStockDependencies;
  return { source, inventory, deps, service: new EbayPublicationStockService(deps) };
}
describe("reviewed eBay stock publication application", () => {
  it("shows the exact existing inventory proposal without changing any stock", async () => {
    const f = fixture(); const review = await f.service.review(20);
    expect(review).toMatchObject({ productName: "Blue Hint", canApply: true, inventory: f.inventory });
    expect(f.deps.commit).not.toHaveBeenCalled(); expect(f.deps.reject).not.toHaveBeenCalled();
  });
  it("binds a confirmed command to provider identity and the inventory review", async () => {
    const f = fixture(); const review = await f.service.review(20);
    const command = { expectedReviewHash: review.reviewHash, commandKey: randomUUID() };
    expect(await f.service.apply(20, "operator", command)).toMatchObject({ replayed: false, job: { operation: "publish", state: "queued" } });
    expect(f.deps.commit).toHaveBeenCalledExactlyOnceWith({ source: f.source, inventory: f.inventory, command, actor: "operator", now: f.deps.now() });
  });
  it.each(["target", "stock"])("durably refuses a changed %s before committing", async change => {
    const f = fixture(); const review = await f.service.review(20);
    if (change === "target") f.deps.prepare.mockResolvedValue({ ...f.source, targetIdentity: { ...f.source.targetIdentity, groupKey: "OTHER" } });
    else f.deps.reviewInventory.mockResolvedValue({ ...f.inventory, reviewHash: "b".repeat(64) });
    await expect(f.service.apply(20, "operator", { expectedReviewHash: review.reviewHash, commandKey: randomUUID() }))
      .rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_REVIEW_STALE", definitiveRejected: true });
    expect(f.deps.commit).not.toHaveBeenCalled(); expect(f.deps.reject).toHaveBeenCalledOnce();
  });
  it("retrieves a committed response before any provider or stock reads", async () => {
    const f = fixture(); const command = { expectedReviewHash: (await f.service.review(20)).reviewHash, commandKey: randomUUID() };
    const result = await f.service.apply(20, "operator", command);
    f.deps.findApplied.mockResolvedValue({ ...result, replayed: true });
    f.deps.prepare.mockRejectedValue(new Error("eBay offline")); f.deps.reviewInventory.mockRejectedValue(new Error("stock changed"));
    const calls = f.deps.prepare.mock.calls.length;
    expect(await f.service.apply(20, "operator", command)).toEqual({ ...result, replayed: true });
    expect(f.deps.prepare).toHaveBeenCalledTimes(calls);
  });
  it("does not turn a transport or uncertain commit failure into a final refusal", async () => {
    const f = fixture(); const command = { expectedReviewHash: (await f.service.review(20)).reviewHash, commandKey: randomUUID() };
    f.deps.commit.mockRejectedValue(new Error("connection lost during COMMIT"));
    await expect(f.service.apply(20, "operator", command)).rejects.toThrow("connection lost");
    expect(f.deps.reject).not.toHaveBeenCalled();
  });
  it.each(["EBAY_SYNC_MEMBERSHIP_CHANGED", "EBAY_SYNC_OFFER_IDENTITY_CHANGED", "EBAY_SYNC_ACCOUNT_CHANGED"])("durably refuses proven %s instead of stranding the saved command", async code => {
    const f = fixture(); const command = { expectedReviewHash: (await f.service.review(20)).reviewHash, commandKey: randomUUID() };
    f.deps.prepare.mockRejectedValue(new EbayListingSyncError(code, "The observed provider identity changed."));
    await expect(f.service.apply(20, "operator", command)).rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_SOURCE_CHANGED", definitiveRejected: true });
    expect(f.deps.commit).not.toHaveBeenCalled();
  });
  it("returns an already committed result if a competing apply wins before refusal", async () => {
    const f = fixture(); const command = { expectedReviewHash: (await f.service.review(20)).reviewHash, commandKey: randomUUID() };
    const result = await f.service.apply(20, "operator", command);
    f.deps.prepare.mockResolvedValue({ ...f.source, targetIdentity: { ...f.source.targetIdentity, groupKey: "CHANGED" } });
    f.deps.reject.mockResolvedValue({ ...result, replayed: true });
    expect(await f.service.apply(20, "operator", command)).toEqual({ ...result, replayed: true });
  });
});
