import { describe, expect, it } from "vitest";
import { prepareChannelIntent, assertPreparedChannelIntent } from "../../prepared-channel-intent";
import { prepareEbayChannelIntent, ebayIntentAccount, assertEbayPreparedIntent, EBAY_PREPARED_INTENT_CAPABILITY } from "../../../channels/ebay-prepared-intent";
import { syncProviderFixture } from "../../../channels/__tests__/fixtures/ebay-listing-sync.fixture";
import { resolveExplicitPublicationMediaPlan } from "../../../catalog/catalog-publication-media";
import { syncContentIntentHash } from "../../../channels/ebay-listing-sync-content";

async function prepared() {
  const draft = (await syncProviderFixture().prepare()).draft;
  const mediaPlan = resolveExplicitPublicationMediaPlan({ variantIds: [101], urls: ["https://example.com/pack.jpg"], maxPhotosPerVariant: 12 });
  const input = { draft, account: ebayIntentAccount({ channelId: 1, connectionId: 1, accountId: "verified-account",
    environment: "production", marketplaceId: "EBAY_US", merchantLocationKey: "HQ" }), operation: "maintenance" as const,
    mediaPlan, prices: new Map([[101, { priceCents: 1149, basePriceCents: 1149, source: "catalog_variant" as const,
      provenance: { kind: "catalog_variant" as const, variantId: 101 }, appliedRule: null }]]), settings: { policies: "validated-owner-snapshot" } };
  const preparedIntent = prepareEbayChannelIntent(input);
  return { input, draft: { ...draft, preparedIntent }, preparedIntent };
}

describe("common prepared intent contract", () => {
  it("uses the same source and content digest for send/readback while quantity changes remain Inventory-owned", async () => {
    const { draft } = await prepared(), original = structuredClone(draft);
    const before = syncContentIntentHash(draft);
    draft.inventoryItems[0].payload.availability.shipToLocationAvailability.quantity = 0;
    draft.offers[0].payload.availableQuantity = 999;
    expect(syncContentIntentHash(draft)).toBe(before);
    expect(() => assertEbayPreparedIntent(draft)).not.toThrow();
    expect(original.inventoryItems[0].payload.availability.shipToLocationAvailability.quantity).not.toBe(0);
    draft.inventoryItems[0].payload.product.imageUrls = ["https://example.com/changed.jpg"];
    expect(() => assertEbayPreparedIntent(draft)).toThrow();
  });
  it("rejects a provider payload whose images or price differ from the resolved owner input", async () => {
    const { input } = await prepared();
    input.draft.inventoryItems[0].payload.product.imageUrls = ["https://example.com/unreviewed.jpg"];
    expect(() => prepareEbayChannelIntent(input)).toThrow();
    input.draft.inventoryItems[0].payload.product.imageUrls = ["https://example.com/pack.jpg"];
    input.draft.offers[0].payload.pricingSummary.price.value = "11.50";
    expect(() => prepareEbayChannelIntent(input)).toThrow();
  });
  it("binds pricing, policies and account revisions without mutating upstream values", async () => {
    const { input, preparedIntent } = await prepared();
    const original = structuredClone(input.mediaPlan);
    input.settings = { policies: "corrected-owner-snapshot" };
    expect(prepareEbayChannelIntent(input).intentHash).not.toBe(preparedIntent.intentHash);
    expect(input.mediaPlan).toEqual(original);
    expect(preparedIntent.input.capability).toMatchObject({ protocol: "resource_steps", mediaVerification: "resource_content" });
  });
  it("rejects duplicate members, mismatched media/price identities and cross-owner envelopes", async () => {
    const { preparedIntent } = await prepared(), input = structuredClone(preparedIntent.input);
    expect(() => prepareChannelIntent({ ...input, members: [...input.members, ...input.members] })).toThrow();
    expect(() => prepareChannelIntent({ ...input, prices: [{ ...input.prices[0], variantId: 102 }] })).toThrow();
    expect(() => prepareChannelIntent({ ...input, mediaPlan: { ...input.mediaPlan!, variants: [{ ...input.mediaPlan!.variants[0], variantId: 102 }] } })).toThrow();
    expect(() => assertPreparedChannelIntent(preparedIntent, { account: { ...input.account, owner: { kind: "dropship", vendorId: 1, storeId: 1 } },
      capabilityRevision: EBAY_PREPARED_INTENT_CAPABILITY, contentHash: input.contentHash, members: input.members })).toThrow();
  });
});
