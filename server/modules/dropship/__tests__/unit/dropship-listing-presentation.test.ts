import { describe, expect, it, vi } from "vitest";
import {
  buildDropshipListingEconomics, buildDropshipListingPresentation, descriptionAsPlainText, enrichDropshipListingRows,
} from "../../application/dropship-listing-presentation";
import { isSafeDropshipPreviewImageUrl, dropshipListingPresentationSchema } from "../../../../../shared/dropship/listing-presentation";
import type { DropshipListingCatalogCandidate, DropshipListingPreviewRepository, DropshipListingPreviewRow } from "../../application/dropship-listing-preview-service";
import { DropshipListingPreviewService } from "../../application/dropship-listing-preview-service";
import type { DropshipMarketplaceListingIntent } from "../../application/dropship-marketplace-listing-provider";
import { resolveDropshipPublicationPreview } from "../../infrastructure/dropship-listing-publication-preview.provider";
import { buildDropshipEbayListingDraft, parseEbayListingConfig } from "../../infrastructure/dropship-ebay-listing-push.provider";
import { EbayListingBuilder } from "../../../channels/adapters/ebay/ebay-listing-builder";
import { toDropshipVendorListingPreview } from "../../application/dropship-listing-dtos";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import { resolveListingContent, listingCatalogHash } from "../../application/dropship-listing-content-resolver";

const productCost: DropshipProductCost = { status: "available", unitCostCents: 809,
  planId: "ops-plan", source: "variant_fixed_price", overrideId: "override-1", issue: null };

const candidate: DropshipListingCatalogCandidate = {
  productId: 5, productVariantId: 7, productLineIds: [], productIsActive: true, variantIsActive: true,
  sku: "PACK-25", productName: "Card protectors", variantName: "25 pack", title: "Card protectors 25 pack",
  description: "<p>Protect <strong>25 cards</strong>.</p>", category: "Protectors", ebayBrowseCategoryId: "183438",
  ebayBrowseCategoryName: "Card Toploaders", brand: "Card Shellz", gtin: "123456789012", mpn: "PACK-25",
  condition: "used", itemSpecifics: { Material: ["Plastic"] }, imageUrls: ["https://images.test/one.jpg"],
  weightGrams: 100, unitsPerVariant: 25, defaultRetailPriceCents: 1299,
};

const intent: DropshipMarketplaceListingIntent = {
  platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync", priceMode: "vendor_defined",
  productVariantId: 7, sku: "PACK-25", title: candidate.title!, description: candidate.description,
  category: candidate.category, marketplaceCategoryId: "183438", marketplaceCategoryName: "Card Toploaders",
  storeCategoryNames: [], brand: candidate.brand, gtin: candidate.gtin, mpn: candidate.mpn,
  condition: candidate.condition, itemSpecifics: candidate.itemSpecifics,
  imageUrls: candidate.imageUrls, weightGrams: 100, priceCents: 2000, quantity: 3,
  marketplaceConfig: { marketplaceId: "EBAY_US", merchantLocationKey: "warehouse",
    businessPolicies: { paymentPolicyId: "pay", returnPolicyId: "return", fulfillmentPolicyId: "ship" } },
};

describe("dropship listing presentation", () => {
  it("sends the authored description to eBay without appending facts or removing structured item specifics", () => {
    const content = resolveListingContent({ candidate, profile: { revisionId: null, profile: null, updatedAt: null },
      saved: { revisionId: 1, customText: "My product description", catalogHash: listingCatalogHash(candidate), updatedAt: "2026-09-08T12:00:00.000Z" } });
    const input = { ...intent, description: content.descriptionHtml };
    const draft = buildDropshipEbayListingDraft({ productVariantId: 7, listingIntent: input, existingExternalOfferId: null },
      parseEbayListingConfig(input.marketplaceConfig, {}), new EbayListingBuilder());
    const product = draft.inventoryItems[0]!.payload.product;
    expect(product.description).toBe("<p>My product description</p>");
    expect(product.aspects.Material).toEqual(["Plastic"]);
    expect(product.aspects.UPC).toEqual([candidate.gtin]);
    expect(content.facts).toContainEqual({ name: "SKU", value: "PACK-25" });
    expect(candidate.description).toBe("<p>Protect <strong>25 cards</strong>.</p>");
  });
  it("uses the exact eBay publication draft, including image cap, condition, specifics and description fallback", () => {
    const input = { ...intent, description: null, imageUrls: Array.from({ length: 14 }, (_, index) => `https://images.test/${index}.jpg`) };
    const draft = buildDropshipEbayListingDraft({ productVariantId: 7, listingIntent: input, existingExternalOfferId: null },
      parseEbayListingConfig(input.marketplaceConfig, {}), new EbayListingBuilder());
    const resolved = resolveDropshipPublicationPreview(input)!;
    expect(resolved).toEqual({
      title: draft.inventoryItems[0]!.payload.product.title,
      description: draft.inventoryItems[0]!.payload.product.description,
      imageUrls: draft.inventoryItems[0]!.payload.product.imageUrls,
      condition: draft.inventoryItems[0]!.payload.condition,
      itemSpecifics: draft.inventoryItems[0]!.payload.product.aspects,
    });
    expect(resolved.description).toBe(input.title);
    expect(resolved.condition).toBe("USED_GOOD");
    expect(resolved.imageUrls).toHaveLength(12);
    expect(input.imageUrls).toHaveLength(14);
    expect(resolved.itemSpecifics.UPC).toEqual([candidate.gtin]);
  });

  it("preserves publish image ordering and marks scoped file images as preview-only", () => {
    const presentation = buildDropshipListingPresentation({ candidate, storeConnectionId: 9,
      publication: { title: "Resolved", description: "<p>Description</p>", condition: "NEW", itemSpecifics: {},
        imageUrls: ["https://images.test/variant.jpg", "https://images.test/product.jpg"] },
      images: [
        { assetId: 1, productVariantId: null, url: "https://images.test/product.jpg", altText: "Product", storageType: "url", hasFile: false },
        { assetId: 2, productVariantId: 7, url: "https://images.test/variant.jpg", altText: "Variant", storageType: "url", hasFile: false },
        { assetId: 3, productVariantId: 7, url: null, altText: "Catalog", storageType: "file", hasFile: true },
      ],
    });
    expect(presentation.images.map((image) => image.assetId)).toEqual([2, 1, 3]);
    expect(presentation.images[2]).toMatchObject({
      url: "/api/dropship/listings/stores/9/variants/7/assets/3/file", source: "catalog_file",
      publicationStatus: "not_included", reason: "authenticated_catalog_image_only",
    });
    expect(presentation.title).toBe("Resolved");
    expect(presentation.descriptionText).toBe("Description");
    expect(presentation.unitsPerVariant).toBe(25);
  });

  it("does not claim catalog fallback images are published and never returns unsafe URLs", () => {
    const presentation = buildDropshipListingPresentation({ candidate, publication: null, storeConnectionId: 9,
      images: [ { assetId: 1, productVariantId: null, url: "javascript:alert(1)", altText: null, storageType: "url", hasFile: false } ],
    });
    expect(presentation.source).toBe("catalog_fallback");
    expect(presentation.images[0]).toMatchObject({ url: null, publicationStatus: "unavailable" });
    expect(presentation.issues).toContain("publication_preview_unavailable");
    expect(dropshipListingPresentationSchema.safeParse({ ...presentation,
      images: [{ ...presentation.images[0], url: "data:image/svg+xml,<svg/>" }] }).success).toBe(false);
  });

  it.each(["javascript:alert(1)", "data:image/svg+xml,test", "//evil.test/img", "https://user:password@images.test/x", "/api/product-assets/3/file", "/api/dropship/listings/stores/9/variants/7/assets/3/file?redirect=x", " https://images.test/x", "https://images.test/has space", "https:images.test/x", "https://images.test/a\\b", "https://images.test/a\tb"])("rejects unsafe image transport %s", (url) => {
    expect(isSafeDropshipPreviewImageUrl(url)).toBe(false);
  });

  it("exposes escaped-text content rather than executable HTML", () => {
    expect(descriptionAsPlainText('<p>Safe &amp; sound</p><script>alert(1)</script><img src=x onerror=alert(1)>')).toBe("Safe & sound");
    expect(descriptionAsPlainText("&lt;script&gt;raw text&lt;/script&gt;")).toBe("<script>raw text</script>");
  });
});

describe("dropship listing product cost", () => {
  it("uses the exact .ops product price per sellable pack, independent of listing price", () => {
    const economics = buildDropshipListingEconomics(candidate, 2000, productCost);
    expect(economics).toMatchObject({ referenceRetailPriceCents: 1299, listingPriceCents: 2000,
      vendorProductCostCents: 809, channelDiscountPercent: null, productCostSource: "variant_fixed_price",
      basis: "one_sellable_variant", unitsPerVariant: 25,
      productCostStatus: "available", issues: [] });
    expect(buildDropshipListingEconomics(candidate, 9000, productCost).vendorProductCostCents).toBe(809);
  });

  it.each([null, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid resolved cost %s without inventing zero", (unitCostCents) => {
    expect(buildDropshipListingEconomics(candidate, 2000, { ...productCost, unitCostCents }))
      .toMatchObject({ vendorProductCostCents: null, productCostStatus: "unavailable" });
  });

  it.each([null, 0, -1, 1.5, Number.NaN])("does not require retail %s for an authoritative fixed product price", (retail) => {
    expect(buildDropshipListingEconomics({ ...candidate, defaultRetailPriceCents: retail }, 2000, productCost).vendorProductCostCents).toBe(809);
  });

  it("honors an explicit free product price and rejects invalid raw pack size", () => {
    expect(buildDropshipListingEconomics(candidate, 2000, { ...productCost, unitCostCents: 0 }).vendorProductCostCents).toBe(0);
    expect(buildDropshipListingEconomics({ ...candidate, catalogUnitsPerVariant: 0 }, 2000, productCost)).toMatchObject({
      vendorProductCostCents: null, unitsPerVariant: null, issues: ["sellable_pack_size_invalid"],
    });
  });

  it("keeps a missing product source unavailable and never substitutes the listing price", () => {
    expect(buildDropshipListingEconomics(candidate, 2000, null)).toMatchObject({ vendorProductCostCents: null,
      productCostSource: null, productCostStatus: "unavailable", issues: ["product_cost_source_unavailable"] });
  });
});

describe("dropship private listing image authorization", () => {
  function setup(overrides: { storeMissing?: boolean; excluded?: boolean; assetMissing?: boolean } = {}) {
    const readImageFile = vi.fn(async () => overrides.assetMissing ? null : { data: Buffer.from("image"), mimeType: "image/png" });
    const repository = {
      findVendorIdByMemberId: vi.fn(async () => 10),
      loadStoreContext: vi.fn(async () => overrides.storeMissing ? null : { vendorId: 10, vendorStatus: "active", entitlementStatus: "active",
        storeConnectionId: 9, storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true }),
      listCatalogCandidates: vi.fn(async () => [candidate]),
      listCatalogExposureRules: vi.fn(async () => [{ scopeType: "catalog", action: overrides.excluded ? "exclude" : "include" }]),
      listSelectionRules: vi.fn(async () => [{ id: 2, scopeType: "catalog", action: "include", autoConnectNewSkus: false, autoListNewSkus: false, isActive: true }]),
      listVariantOverrides: vi.fn(async () => []),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new DropshipListingPreviewService({ repository: repository as unknown as DropshipListingPreviewRepository,
      presentation: { media: { listImages: async () => new Map(), readImageFile }, productCosts: { loadProductCosts: async () => new Map([[7, productCost]]) },
        resolvePublication: () => null, logger },
      clock: { now: () => new Date("2026-09-06T12:00:00Z") }, logger,
    } as ConstructorParameters<typeof DropshipListingPreviewService>[0]);
    return { service, repository, readImageFile };
  }

  it("authorizes a selected exposed variant before asking catalog for its scoped image", async () => {
    const { service, repository, readImageFile } = setup();
    await expect(service.imageForMember("member-1", { storeConnectionId: 9, productVariantId: 7, assetId: 3 })).resolves.toMatchObject({ mimeType: "image/png" });
    expect(repository.loadStoreContext).toHaveBeenCalledWith({ vendorId: 10, storeConnectionId: 9 });
    expect(readImageFile).toHaveBeenCalledWith({ storeConnectionId: 9, productVariantId: 7, assetId: 3 });
  });
  it("does not read blobs for another vendor's store", async () => {
    const { service, readImageFile } = setup({ storeMissing: true });
    await expect(service.imageForMember("member-1", { storeConnectionId: 999, productVariantId: 7, assetId: 3 })).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(readImageFile).not.toHaveBeenCalled();
  });
  it("does not read excluded catalog images", async () => {
    const { service, readImageFile } = setup({ excluded: true });
    await expect(service.imageForMember("member-1", { storeConnectionId: 9, productVariantId: 7, assetId: 3 })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_IMAGE_NOT_FOUND" });
    expect(readImageFile).not.toHaveBeenCalled();
  });
  it("returns not found when catalog rejects a mismatched variant asset", async () => {
    const { service } = setup({ assetMissing: true });
    await expect(service.imageForMember("member-1", { storeConnectionId: 9, productVariantId: 7, assetId: 99 })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_IMAGE_NOT_FOUND" });
  });
  it("rejects invalid identifiers before loading identity or blobs", async () => {
    const { service, repository, readImageFile } = setup();
    await expect(service.imageForMember("member-1", { storeConnectionId: 9, productVariantId: 0, assetId: 3 })).rejects.toThrow();
    expect(repository.findVendorIdByMemberId).not.toHaveBeenCalled();
    expect(readImageFile).not.toHaveBeenCalled();
  });
});

describe("vendor presentation transport and failure isolation", () => {
  const row: DropshipListingPreviewRow = {
    productVariantId: 7, productId: 5, sku: "PACK-25", title: "Card protectors", platform: "ebay",
    listingMode: "live", currentListingStatus: "not_listed", previewStatus: "ready", blockers: [], warnings: [],
    marketplaceQuantity: 3, priceCents: 2000, marketplaceCategoryId: "183438", marketplaceCategoryName: "Card Toploaders",
    storeCategoryNames: [], businessPolicySelection: null, previewHash: "same-publication-hash", listingIntent: intent,
    adminExposureDecision: { exposed: true, reason: "exposed", includeRuleIds: [1], excludeRuleIds: [] },
    selectionDecision: { selected: true, reason: "selected", adminExposureReason: "exposed", includeRuleIds: [2], excludeRuleIds: [],
      autoConnectNewSkus: true, autoListNewSkus: false, marketplaceQuantity: 3, quantityCapApplied: false },
  };

  it("keeps worker intent intact while the vendor DTO excludes internal config and intent", () => {
    const preview = { vendorId: 10, storeConnectionId: 9, platform: "ebay" as const,
      generatedAt: new Date("2026-09-06T12:00:00Z"), rows: [row], summary: { total: 1, ready: 1, warning: 0, blocked: 0 } };
    const transport = toDropshipVendorListingPreview(preview);
    expect(transport.rows[0]).not.toHaveProperty("listingIntent");
    expect(JSON.stringify(transport)).not.toContain("marketplaceConfig");
    expect(preview.rows[0].listingIntent).toBe(intent);
  });

  it("does not change eligibility or payload hashes when advisory media or product pricing fails", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const rows = await enrichDropshipListingRows({ rows: [row], candidates: [candidate], vendorId: 10, storeConnectionId: 9,
      deps: { media: { listImages: async () => { throw new Error("database unavailable"); }, readImageFile: async () => null },
        productCosts: { loadProductCosts: async () => { throw new Error("pricing unavailable"); } },
        resolvePublication: resolveDropshipPublicationPreview, logger } });
    expect(rows[0]).toMatchObject({ previewHash: row.previewHash, previewStatus: "ready", blockers: [], warnings: [], priceCents: 2000 });
    expect(rows[0].listingIntent).toBe(intent);
    expect(rows[0].economics).toMatchObject({ productCostStatus: "unavailable", vendorProductCostCents: null });
    expect(rows[0].presentation?.issues).toContain("catalog_media_unavailable");
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("batches costs for the authorized vendor and exposed variants only", async () => {
    const loadProductCosts = vi.fn(async () => new Map([[7, productCost]]));
    const hidden = { ...row, productVariantId: 8, adminExposureDecision: { ...row.adminExposureDecision, exposed: false } };
    const rows = await enrichDropshipListingRows({ rows: [row, hidden], candidates: [candidate], vendorId: 10, storeConnectionId: 9,
      deps: { media: { listImages: async () => new Map(), readImageFile: async () => null },
        productCosts: { loadProductCosts }, resolvePublication: resolveDropshipPublicationPreview,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } });
    expect(loadProductCosts).toHaveBeenCalledWith({ vendorId: 10, productVariantIds: [7] });
    expect(rows[0].economics).toMatchObject({ vendorProductCostCents: 809, productCostSource: "variant_fixed_price" });
    expect(rows[1]).toBe(hidden);
  });
});
