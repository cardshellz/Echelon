import { describe, expect, it } from "vitest";
import { stockPublicationSelectionSchema } from "@shared/types/stock-publication-selection";
import { resolveChannelStockSelection, type ChannelStockSelectionFacts } from "../../channel-stock-selection.domain";

function facts(): ChannelStockSelectionFacts {
  return { channelId: 1, channelConnectionId: 2, provider: "ebay", productId: 10, productVariantIds: [101],
    productIsListed: null, typeListingEnabled: true, latestJob: null, reviewedAdditionVariantIds: [],
    catalog: { product: { id: 10, isActive: true, status: "active", productType: "holder", category: null,
      ebayListingExcluded: false, productLineIds: [] }, variants: [{ id: 101, productId: 10, sku: "PACK", uomType: "pack",
      isActive: true, requiresShipping: true, trackInventory: true, salesEligibility: "sellable", ebayListingExcluded: false }] },
    variants: [{ productVariantId: 101, variantIsListed: null, feed: null,
      listing: { status: "synced", externalProductId: "listing", externalVariantId: "offer", externalSku: "PACK" } }] };
}
const action = (input: ChannelStockSelectionFacts) => resolveChannelStockSelection(input).variants[0].action;
const member = { variantId: 101, sku: "PACK", offerId: "offer", listingId: "listing" };
describe("Channels stock publication selection", () => {
  it("uses existing eBay selection for a retained destination", () => expect(action(facts())).toBe("publish"));
  it.each(["product mirror", "variant mirror", "product override", "variant override", "type", "product inactive", "variant inactive", "internal", "digital", "untracked"])("keeps a clearing duty after %s deselection", reason => {
    const input = facts();
    if (reason === "product mirror") input.catalog.product!.ebayListingExcluded = true;
    if (reason === "variant mirror") input.catalog.variants[0].ebayListingExcluded = true;
    if (reason === "product override") input.productIsListed = 0;
    if (reason === "variant override") input.variants = [{ ...input.variants[0], variantIsListed: 0 }];
    if (reason === "type") input.typeListingEnabled = false;
    if (reason === "product inactive") input.catalog.product!.isActive = false;
    if (reason === "variant inactive") input.catalog.variants[0].isActive = false;
    if (reason === "internal") input.catalog.variants[0].salesEligibility = "internal_only";
    if (reason === "digital") input.catalog.variants[0].requiresShipping = false;
    if (reason === "untracked") input.catalog.variants[0].trackInventory = false;
    expect(action(input)).toBe(reason === "product inactive" || reason === "variant inactive" ? "none" : "zero");
  });
  it("does not invent a clearing target for an excluded unmapped variant", () => {
    const input = facts(); input.productIsListed = 0; input.variants = [];
    expect(action(input)).toBe("none");
  });
  it("never enrolls an arbitrary active catalog candidate or empty projection", () => {
    const input = facts(); input.variants = [];
    expect(action(input)).toBe("read_only");
    input.variants = [{ productVariantId: 101, variantIsListed: null, feed: null,
      listing: { status: "pending", externalProductId: null, externalVariantId: null, externalSku: null } }];
    expect(action(input)).toBe("read_only");
  });
  it("recognizes durable unpublished intent without requiring a fabricated saved mapping", () => {
    const input = facts(); input.variants = [];
    input.latestJob = { id: "job", operation: "publish", state: "queued", members: [{ ...member, offerId: null, listingId: null }], verifiedMembers: [] };
    expect(action(input)).toBe("publish");
  });
  it("selects a size a reviewed listing change is adding, before it has any saved eBay identity", () => {
    const input = facts();
    input.variants = [{ productVariantId: 101, variantIsListed: null, feed: null,
      listing: { status: "error", externalProductId: null, externalVariantId: null, externalSku: null } }];
    expect(action(input)).toBe("read_only");
    input.reviewedAdditionVariantIds = [101];
    expect(resolveChannelStockSelection(input).variants[0]).toMatchObject({ action: "publish", blockers: [],
      reason: "A reviewed listing change is adding this size to its eBay listing." });
    // No listing row at all is the same case.
    input.variants = [];
    expect(action(input)).toBe("publish");
    // The record is for exact sizes: another size of the product is not selected by it.
    input.reviewedAdditionVariantIds = [102];
    expect(action(input)).toBe("read_only");
  });
  it("never lets a reviewed addition override a listing rule, a quarantine or another channel's rules", () => {
    const base = () => { const input = facts(); input.variants = []; input.reviewedAdditionVariantIds = [101]; return input; };
    let input = base(); input.catalog.variants[0].ebayListingExcluded = true;
    expect(action(input)).toBe("none");
    input = base(); input.productIsListed = 0;
    expect(action(input)).toBe("none");
    input = base(); input.typeListingEnabled = false;
    expect(action(input)).toBe("none");
    input = base(); input.catalog.variants[0].trackInventory = false;
    expect(action(input)).toBe("none");
    input = base(); input.catalog.variants[0].isActive = false;
    expect(action(input)).toBe("none");
    input = base(); input.variants = [{ productVariantId: 101, variantIsListed: null,
      feed: { active: true, quarantined: true, externalVariantId: null, externalInventoryItemId: null, externalSku: null }, listing: null }];
    expect(resolveChannelStockSelection(input).variants[0].blockers).toMatchObject([{ code: "CHANNEL_SELECTION_MAPPING_QUARANTINED" }]);
    // The record is an eBay listing fact; Shopify and Walmart still need their own feed.
    input = base(); input.provider = "shopify";
    expect(action(input)).toBe("read_only");
  });
  it("re-adds a size whose earlier listing ended once a reviewed change adds it, and binds the record into the fingerprint", () => {
    const input = facts(); input.variants = [{ ...input.variants[0], listing: { ...input.variants[0].listing!, status: "ended" } }];
    expect(action(input)).toBe("read_only");
    const before = resolveChannelStockSelection(input).fingerprint;
    input.reviewedAdditionVariantIds = [101];
    const after = resolveChannelStockSelection(input);
    expect(after.variants[0].action).toBe("publish");
    expect(after.fingerprint).not.toBe(before);
  });
  it("keeps a pending withdrawal ahead of a reviewed addition", () => {
    const input = facts(); input.reviewedAdditionVariantIds = [101];
    input.latestJob = { id: "job", operation: "withdraw", state: "needs_attention", members: [member], verifiedMembers: [member] };
    expect(action(input)).toBe("zero");
  });
  it.each(["shopify", "walmart"] as const)("requires existing %s feed intent and ignores eBay-only toggles", provider => {
    const input = facts(); input.provider = provider; input.catalog.product!.ebayListingExcluded = true; input.typeListingEnabled = false;
    expect(action(input)).toBe("read_only");
    input.variants = [{ ...input.variants[0], feed: { active: true, quarantined: false, externalVariantId: "remote", externalInventoryItemId: "stock", externalSku: "PACK" } }];
    expect(action(input)).toBe("publish");
    input.variants = [{ ...input.variants[0], feed: { ...input.variants[0].feed!, active: false } }];
    expect(action(input)).toBe("zero");
  });
  it("retains quarantine as a blocker even when stock clearing is requested", () => {
    const input = facts(); input.productIsListed = 0;
    input.variants = [{ ...input.variants[0], feed: { active: false, quarantined: true, externalVariantId: "remote", externalInventoryItemId: null, externalSku: "PACK" } }];
    expect(resolveChannelStockSelection(input).variants[0]).toMatchObject({ action: "zero", blockers: [{ code: "CHANNEL_SELECTION_MAPPING_QUARANTINED" }] });
  });
  it("retains withdrawal duty until the exact ended identity was verified", () => {
    const input = facts(); input.latestJob = { id: "job", operation: "withdraw", state: "needs_attention", members: [member], verifiedMembers: [member] };
    expect(action(input)).toBe("zero");
    input.productIsListed = 0; input.latestJob.state = "completed";
    expect(action(input)).toBe("zero");
    input.variants = [{ ...input.variants[0], listing: { ...input.variants[0].listing!, status: "ended" } }];
    expect(action(input)).toBe("none");
    input.variants = [{ ...input.variants[0], listing: { ...input.variants[0].listing!, externalProductId: "new-listing" } }];
    expect(action(input)).toBe("zero");
  });
  it("does not restore an ended listing by merely re-including it", () => {
    const input = facts(); input.variants = [{ ...input.variants[0], listing: { ...input.variants[0].listing!, status: "ended" } }];
    expect(action(input)).toBe("read_only");
    input.latestJob = { id: "job", operation: "publish", state: "queued", members: [member], verifiedMembers: [] };
    expect(action(input)).toBe("publish");
  });
  it("exposes exact retirement evidence only after a completed matching withdrawal", () => {
    const input = facts(); input.productIsListed = 0;
    input.latestJob = { id: "00000000-0000-4000-8000-000000000001", accountId: "seller-1", operation: "withdraw",
      state: "completed", members: [member], verifiedMembers: [member] };
    input.variants = [{ ...input.variants[0], listing: { ...input.variants[0].listing!, status: "ended" } }];
    expect(resolveChannelStockSelection(input).variants[0]).toMatchObject({ action: "none", retirementEvidence: {
      operationId: input.latestJob.id, externalAccountId: "seller-1", externalSku: "PACK",
      externalOfferId: "offer", externalListingId: "listing",
    } });
    input.latestJob.state = "awaiting_evidence";
    expect(resolveChannelStockSelection(input).variants[0].retirementEvidence).toBeUndefined();
    input.latestJob.state = "completed"; input.latestJob.verifiedMembers = [{ ...member, offerId: "another-offer" }];
    expect(resolveChannelStockSelection(input).variants[0].retirementEvidence).toBeUndefined();
  });
  it("blocks missing or wrong-product catalog identity", () => {
    const input = facts(); input.catalog.variants = [];
    expect(resolveChannelStockSelection(input).variants[0]).toMatchObject({ action: "none", blockers: [{ code: "CHANNEL_SELECTION_CATALOG_IDENTITY_MISSING" }] });
  });
  it("hashes canonical selection facts without mutating input", () => {
    const input = facts(); input.productVariantIds = [102, 101]; input.catalog.variants.push({ ...input.catalog.variants[0], id: 102 });
    const before = structuredClone(input); const first = resolveChannelStockSelection(input);
    expect(input).toEqual(before);
    input.productVariantIds = [101, 102]; input.catalog.variants.reverse();
    expect(resolveChannelStockSelection(input).fingerprint).toBe(first.fingerprint);
    input.productIsListed = 0;
    expect(resolveChannelStockSelection(input).fingerprint).not.toBe(first.fingerprint);
  });
  it("rejects duplicate variant results", () => {
    const result = resolveChannelStockSelection(facts());
    expect(stockPublicationSelectionSchema.safeParse({ ...result, variants: [...result.variants, ...result.variants] }).success).toBe(false);
  });
});
