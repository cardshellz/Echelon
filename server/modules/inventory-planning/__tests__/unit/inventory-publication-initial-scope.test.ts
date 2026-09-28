import { describe, expect, it, vi } from "vitest";
import { reviewInitialPublicationScope, type InitialPublicationScopeFacts } from "../../domain/inventory-publication-initial-scope";
import { InventoryPublicationInitialScopeService, initialScopeCommandHash } from "../../application/inventory-publication-initial-scope.service";

const input = { publicationTargetId: 1, expectedTargetRevision: "2" };
const hash = "a".repeat(64);
function facts(): InitialPublicationScopeFacts {
  return { authority: "legacy", authorityRevision: "1", frozen: false,
    target: { id: 1, revision: "2", state: "preview", mode: "whole_product", authority: "echelon",
      destinationKind: "channel_connection", channelId: 36, channelConnectionId: 4, dropshipStoreConnectionId: null,
      provider: "shopify", providerScopeType: "location", externalScopeId: "location-one" },
    existingMemberCount: 0, ownerIssues: [], ownerEvidenceHashes: [],
    listings: [{ sourceKey: "feed:1", productVariantId: 101, active: true, uncertain: false, quarantined: false,
      externalInventoryItemId: "item-one", externalSku: "P5" }],
    variants: [{ id: 101, productId: 20, productActive: true, variantActive: true, requiresShipping: true,
      inventoryTrackingDefault: true, inventoryTrackingOverride: null, salesEligibility: "sellable",
      mapping: { id: 1, version: 1, definitionHash: hash, externalInventoryItemId: "item-one", externalSku: "P5" } }],
  };
}
describe("initial publication scope policy", () => {
  it("seals an explicitly reviewed bundle exclusion without commissioning or changing its inventory", () => {
    const source = facts();
    const before = structuredClone(source);
    const excludedVariants = [{ productVariantId: 101, reason: "unsupported_bundle" as const }];
    const review = reviewInitialPublicationScope({ ...input, excludedVariants }, source);
    expect(review).toMatchObject({ ready: true, includedVariantIds: [], excludedVariants, blockers: [],
      runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false });
    expect(review.reviewHash).not.toBe(reviewInitialPublicationScope(input, source).reviewHash);
    expect(source).toEqual(before);
  });
  it("rejects an exclusion for an unknown or unlisted identity", () => {
    const review = reviewInitialPublicationScope({ ...input,
      excludedVariants: [{ productVariantId: 999, reason: "unsupported_bundle" }] }, facts());
    expect(review.blockers.map(row => row.code)).toContain("INITIAL_SCOPE_EXCLUSION_IDENTITY_MISSING");
  });
  it.each(["uncertain", "quarantined"] as const)("does not use a bundle exclusion to hide %s listing evidence", kind => {
    const source = facts(); source.listings[0]![kind] = true;
    expect(reviewInitialPublicationScope({ ...input,
      excludedVariants: [{ productVariantId: 101, reason: "unsupported_bundle" }] }, source).ready).toBe(false);
  });
  it("uses listed identities only, produces a deterministic review and never mutates facts", () => {
    const source = facts();
    const before = structuredClone(source);
    const review = reviewInitialPublicationScope(input, source);
    expect(review).toMatchObject({ ready: true, includedVariantIds: [101], blockers: [], runtimeAuthorityChanged: false,
      providerWriteAttempted: false, outboxEnqueued: false });
    expect(reviewInitialPublicationScope(input, source)).toEqual(review);
    expect(source).toEqual(before);
  });
  it.each([false, true])("excludes explicit non-stock catalog policy (digital=%s)", digital => {
    const source = facts();
    source.variants[0]!.requiresShipping = !digital;
    source.variants[0]!.inventoryTrackingOverride = false;
    source.variants[0]!.mapping = null;
    expect(reviewInitialPublicationScope(input, source)).toMatchObject({ ready: true, includedVariantIds: [], excludedNonStockVariantIds: [101] });
  });
  it("allows a verified empty census, not an incomplete one", () => {
    const source = facts(); source.listings = []; source.variants = [];
    expect(reviewInitialPublicationScope(input, source)).toMatchObject({ ready: true, includedVariantIds: [] });
    source.ownerIssues = ["MISSING_PROVIDER_ACCOUNT"];
    expect(reviewInitialPublicationScope(input, source).ready).toBe(false);
  });
  const cases: Array<[string, (value: InitialPublicationScopeFacts) => void, string]> = [
    ["canonical authority", value => { value.authority = "canonical"; }, "INITIAL_SCOPE_AUTHORITY_UNAVAILABLE"],
    ["open freeze", value => { value.frozen = true; }, "INITIAL_SCOPE_AUTHORITY_UNAVAILABLE"],
    ["external control", value => { value.target.authority = "external_provider"; }, "INITIAL_SCOPE_NOT_PRISTINE"],
    ["manual control", value => { value.target.authority = "manual"; }, "INITIAL_SCOPE_NOT_PRISTINE"],
    ["live target", value => { value.target.state = "live"; }, "INITIAL_SCOPE_NOT_PRISTINE"],
    ["disabled target", value => { value.target.state = "disabled"; }, "INITIAL_SCOPE_NOT_PRISTINE"],
    ["explicit target", value => { value.target.mode = "explicit"; }, "INITIAL_SCOPE_NOT_PRISTINE"],
    ["existing versions", value => { value.existingMemberCount = 1; }, "INITIAL_SCOPE_NOT_PRISTINE"],
    ["unimplemented provider census", value => { value.target.provider = "walmart"; }, "INITIAL_SCOPE_PROVIDER_UNSUPPORTED"],
    ["changed revision", value => { value.target.revision = "3"; }, "INITIAL_SCOPE_TARGET_CHANGED"],
    ["changed target", value => { value.target.id = 2; }, "INITIAL_SCOPE_TARGET_CHANGED"],
    ["quarantine", value => { value.listings[0]!.quarantined = true; }, "INITIAL_SCOPE_LISTING_QUARANTINED"],
    ["ambiguous outcome", value => { value.listings[0]!.uncertain = true; }, "INITIAL_SCOPE_LISTING_UNCERTAIN"],
    ["missing variant", value => { value.variants = []; }, "INITIAL_SCOPE_CATALOG_IDENTITY_MISSING"],
    ["inactive variant", value => { value.variants[0]!.variantActive = false; }, "INITIAL_SCOPE_LISTED_SKU_INELIGIBLE"],
    ["inactive product", value => { value.variants[0]!.productActive = false; }, "INITIAL_SCOPE_LISTED_SKU_INELIGIBLE"],
    ["internal-only SKU", value => { value.variants[0]!.salesEligibility = "internal_only"; }, "INITIAL_SCOPE_LISTED_SKU_INELIGIBLE"],
    ["missing mapping", value => { value.variants[0]!.mapping = null; }, "INITIAL_SCOPE_MAPPING_UNVERIFIED"],
    ["different item", value => { value.listings[0]!.externalInventoryItemId = "wrong"; }, "INITIAL_SCOPE_MAPPING_UNVERIFIED"],
    ["different SKU", value => { value.listings[0]!.externalSku = "wrong"; }, "INITIAL_SCOPE_MAPPING_UNVERIFIED"],
    ["duplicate evidence", value => { value.listings.push({ ...value.listings[0]! }); }, "INITIAL_SCOPE_DUPLICATE_EVIDENCE"],
    ["duplicate variants", value => { value.variants.push({ ...value.variants[0]! }); }, "INITIAL_SCOPE_DUPLICATE_EVIDENCE"],
  ];
  it.each(cases)("blocks %s", (_name, change, code) => {
    const source = facts(); change(source);
    const result = reviewInitialPublicationScope(input, source);
    expect(result.ready).toBe(false);
    expect(result.blockers.map(row => row.code)).toContain(code);
  });
  it("deduplicates a listed SKU across owners without losing conflicting evidence", () => {
    const source = facts(); source.listings.push({ ...source.listings[0]!, sourceKey: "registered:1" });
    const review = reviewInitialPublicationScope(input, source);
    expect(review.includedVariantIds).toEqual([101]); expect(review.ready).toBe(true);
    expect(reviewInitialPublicationScope(input, { ...source, listings: [...source.listings].reverse() })).toEqual(review);
    source.listings[1]!.externalInventoryItemId = "wrong";
    const changed = reviewInitialPublicationScope(input, source);
    expect(changed.ready).toBe(false); expect(changed.reviewHash).not.toBe(review.reviewHash);
  });
});

describe("initial publication scope service boundaries", () => {
  const now = new Date("2026-09-28T15:00:00.000Z");
  const command = { ...input, expectedReviewHash: hash, idempotencyKey: "prepare-one" };
  const receipt = { publicationTargetId: 1, previousRevision: "2", revision: "3", reviewHash: hash, includedVariantIds: [101],
    preparedBy: "operator", preparedAt: now.toISOString(), alreadyApplied: false, runtimeAuthorityChanged: false as const,
    providerWriteAttempted: false as const, outboxEnqueued: false as const };
  it("hashes the exact selection and authenticated actor, with a supplied clock", async () => {
    const store = { review: vi.fn(), prepare: vi.fn(async () => receipt) };
    expect(await new InventoryPublicationInitialScopeService(store, { now: () => now }).prepare(command, "operator")).toEqual(receipt);
    expect(store.prepare).toHaveBeenCalledWith(command, "operator", initialScopeCommandHash(command, "operator"), now);
  });
  it.each([{ publicationTargetId: 0 }, { includedVariantIds: [] }, { expectedReviewHash: "invalid" }, { actor: "spoofed" }, { idempotencyKey: "" }])(
    "rejects invalid or unreviewed caller overrides %j", async patch => {
      const store = { review: vi.fn(), prepare: vi.fn() };
      await expect(new InventoryPublicationInitialScopeService(store).prepare({ ...command, ...patch }, "operator")).rejects.toThrow();
      expect(store.prepare).not.toHaveBeenCalled();
    },
  );
  it.each([
    [{ productVariantId: 101, reason: "api_failed" }],
    [{ productVariantId: 101, reason: "unsupported_bundle" }, { productVariantId: 101, reason: "unsupported_bundle" }],
  ].map(excludedVariants => ({ excludedVariants })))("rejects an invalid exclusion $excludedVariants", async ({ excludedVariants }) => {
    const store = { review: vi.fn(), prepare: vi.fn() };
    await expect(new InventoryPublicationInitialScopeService(store).prepare({ ...command, excludedVariants }, "operator")).rejects.toThrow();
    expect(store.prepare).not.toHaveBeenCalled();
  });
  it("rejects missing actor, invalid clock and a lying result contract", async () => {
    const store = { review: vi.fn(), prepare: vi.fn(async () => ({ ...receipt, providerWriteAttempted: true })) };
    await expect(new InventoryPublicationInitialScopeService(store as never).prepare(command, undefined)).rejects.toThrow();
    await expect(new InventoryPublicationInitialScopeService(store as never, { now: () => new Date("invalid") }).prepare(command, "operator")).rejects.toThrow();
    expect(store.prepare).not.toHaveBeenCalled();
    await expect(new InventoryPublicationInitialScopeService(store as never).prepare(command, "operator")).rejects.toThrow();
  });
});
