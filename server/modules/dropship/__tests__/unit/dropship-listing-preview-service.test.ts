import { beforeEach, describe, expect, it } from "vitest";
import { resolveListingContent, listingCatalogHash } from "../../application/dropship-listing-content-resolver";
import { noContentProfile } from "../fixtures/listing-content.fixture";
import type { SavedListingPriceRevision } from "../../../../../shared/dropship/listing-price";
import type { ListingRulePrice } from "../../application/dropship-rule-price";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipListingPreviewService,
  hashListingPushJobRequest,
  type CreateDropshipListingPushJobRepositoryInput,
  type CreateDropshipListingPushJobRepositoryResult,
  type DropshipExistingVendorListing,
  type DropshipListingCatalogCandidate,
  type DropshipListingPackageReadiness,
  type DropshipListingPreviewRepository,
  type DropshipListingStoreContext,
  type DropshipListingPushJobItemRecord,
  type DropshipListingPushJobRecord,
  type DropshipPricingPolicyRecord,
} from "../../application/dropship-listing-preview-service";
import type {
  DropshipAtpProvider,
} from "../../application/dropship-selection-atp-service";
import type { DropshipStoreListingConfig } from "../../application/dropship-marketplace-listing-provider";
import type { DropshipEbayListingPolicyOverride } from "../../application/dropship-ebay-listing-policy-override-service";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";
import type { DropshipCatalogExposureRule } from "../../domain/catalog-exposure";
import type {
  DropshipVendorSelectionRule,
  DropshipVendorVariantOverride,
} from "../../domain/vendor-selection";
import { ConfigDrivenDropshipMarketplaceListingProvider } from "../../infrastructure/dropship-config-driven-marketplace-listing.provider";

const now = new Date("2026-05-01T17:30:00.000Z");

describe("DropshipListingPreviewService", () => {
  let repository: FakeListingPreviewRepository;
  let logs: DropshipLogEvent[];
  let service: DropshipListingPreviewService;
  let ebayPolicyPreflight: {
    compatible: boolean;
    fulfillmentPolicyId: string;
    capabilityEvidenceHash: string;
    issues: Array<{ code: string; message: string }>;
  };
  let evaluatedFulfillmentPolicyIds: string[];

  beforeEach(() => {
    repository = new FakeListingPreviewRepository();
    logs = [];
    ebayPolicyPreflight = {
      compatible: true,
      fulfillmentPolicyId: "fulfillment-policy",
      capabilityEvidenceHash: "capability-hash",
      issues: [],
    };
    evaluatedFulfillmentPolicyIds = [];
    service = new DropshipListingPreviewService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      atp: new FakeAtpProvider(),
      marketplaceListing: new ConfigDrivenDropshipMarketplaceListingProvider(),
      ebayFulfillmentPolicyGuard: {
        evaluateForStoreConnection: async (input) => {
          evaluatedFulfillmentPolicyIds.push(input.fulfillmentPolicyId);
          return { ...ebayPolicyPreflight, fulfillmentPolicyId: input.fulfillmentPolicyId };
        },
        evaluateWithAccessToken: async () => ebayPolicyPreflight,
      },
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });
  });

  it("uses the exact sanitized description and rejects unreviewed content before queueing", async () => {
    const saved = { revisionId: 1, customText: "My shop description <script>literal</script>",
      catalogHash: listingCatalogHash(repository.candidate), updatedAt: now.toISOString() };
    const content = resolveListingContent({ candidate: repository.candidate, profile: noContentProfile, saved });
    repository.loadListingContents = async () => new Map([[101, content]]);
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0].listingIntent?.description).toBe(content.descriptionHtml);
    expect(preview.rows[0].contentEvidenceHash).toBe(content.evidenceHash);
    const request = { storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "content-queue" };
    await expect(service.createListingPushJobForMember("member-1", request)).rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    await expect(service.createListingPushJobForMember("member-1", { ...request, expectedContentEvidenceHashesByVariantId: { "101": "a".repeat(64) } }))
      .rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    expect(repository.jobs).toHaveLength(0);
    await service.createListingPushJobForMember("member-1", { ...request, expectedContentEvidenceHashesByVariantId: { "101": content.evidenceHash } });
    expect(repository.lastCreatedInput?.preview.rows[0].listingIntent?.description).toBe(content.descriptionHtml);
    expect(repository.candidate.description).not.toBe(content.descriptionHtml);
  });
  it("blocks a custom description when its catalog facts changed", async () => {
    const content = resolveListingContent({ candidate: repository.candidate, profile: noContentProfile,
      saved: { revisionId: 1, customText: "Preserved copy", catalogHash: "a".repeat(64), updatedAt: now.toISOString() } });
    repository.loadListingContents = async () => new Map([[101, content]]);
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0].blockers).toContain("listing_content_catalog_review_required");
    expect(preview.rows[0].previewStatus).toBe("blocked");
  });
  it("does not fall back to unsanitized catalog when the content reader returns an incomplete result", async () => {
    repository.loadListingContents = async () => new Map();
    await expect(service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] })).rejects.toThrow("incomplete catalog result");
  });
  it("builds a ready listing preview from store connection listing config", async () => {
    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(result.summary).toEqual({ total: 1, ready: 1, blocked: 0, warning: 0 });
    expect(result.rows[0]).toMatchObject({
      productVariantId: 101,
      platform: "shopify",
      listingMode: "live",
      previewStatus: "ready",
      priceCents: 1299,
      marketplaceQuantity: 4,
      blockers: [],
      warnings: [],
    });
    expect(result.rows[0]?.listingIntent).toMatchObject({
      platform: "shopify",
      listingMode: "live",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      productVariantId: 101,
      priceCents: 1299,
      quantity: 4,
      weightGrams: 100,
    });
  });

  it("uses adopted rule prices in the actual marketplace intent, not a request-local override", async () => {
    repository.rulePrices.set(101, rulePrice());
    repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: null, pricingMode: "rules", updatedAt: now.toISOString() }];
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101], requestedRetailPriceCents: 1 });
    expect(preview.rows[0]).toMatchObject({ priceCents: 1152, rulePriceEvidenceHash: "a".repeat(64), pricingRuleName: "Store default rule" });
    expect(preview.rows[0].listingIntent).toMatchObject({ priceCents: 1152 });
  });
  it("requires exact reviewed rule/cost evidence even when the final cents have not changed", async () => {
    repository.rulePrices.set(101, rulePrice());
    const input = { storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "rule-job-test",
      expectedPriceCentsByVariantId: { "101": 1152 } };
    await expect(service.createListingPushJobForMember("member-1", input)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT" });
    await expect(service.createListingPushJobForMember("member-1", { ...input, expectedRuleEvidenceHashesByVariantId: { "101": "b".repeat(64) } }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT" });
    expect(repository.jobs).toHaveLength(0);
    const result = await service.createListingPushJobForMember("member-1", { ...input, expectedRuleEvidenceHashesByVariantId: { "101": "a".repeat(64) } });
    expect(result.job.status).toBe("queued");
  });
  it("blocks an inherited price when its cost is missing", async () => {
    repository.rulePrices.set(101, { ...rulePrice(), priceCents: null, issue: "pricing_basis_unavailable" });
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0].priceCents).toBeNull(); expect(preview.rows[0].blockers).toContain("pricing_basis_unavailable");
  });
  it("does not request wholesale-derived prices for unavailable catalog candidates", async () => {
    repository.candidate.variantIsActive = false;
    repository.rulePrices.set(101, rulePrice());
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(repository.ruleCandidateIds).toEqual([]);
    expect(preview.rows[0].rulePriceEvidenceHash).toBeUndefined();
  });

  it("uses saved draft prices in both preview and the immutable queued listing intent", async () => {
    repository.savedPrices = [{ productVariantId: 101, revisionId: 8, overridePriceCents: 1899, updatedAt: now.toISOString() }];
    const result = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(result.rows[0]).toMatchObject({ priceCents: 1899, priceSettingRevisionId: 8, listingIntent: { priceCents: 1899 } });
    await service.createListingPushJobForMember("member-1", { storeConnectionId: 22, productVariantIds: [101],
      expectedPriceRevisionIdsByVariantId: { "101": 8 }, idempotencyKey: "saved-price-job" });
    const snapshot = repository.lastCreatedInput!.preview.rows[0].listingIntent;
    expect(snapshot?.priceCents).toBe(1899);
    repository.savedPrices = [{ ...repository.savedPrices[0], revisionId: 9, overridePriceCents: 1999 }];
    expect(snapshot?.priceCents).toBe(1899);
  });

  it("retains legacy listing fallback until an explicit reset selects catalog default", async () => {
    repository.existingListings = [{ productVariantId: 101, listingId: 1, status: "live", vendorRetailPriceCents: 2799,
      quantityCap: null, externalListingId: null }];
    const request = { storeConnectionId: 22, productVariantIds: [101] };
    expect((await service.previewForMember("member-1", request)).rows[0].priceCents).toBe(2799);
    repository.savedPrices = [{ productVariantId: 101, revisionId: 8, overridePriceCents: null, updatedAt: now.toISOString() }];
    expect((await service.previewForMember("member-1", request)).rows[0].priceCents).toBe(repository.candidate.defaultRetailPriceCents);
    repository.candidate.defaultRetailPriceCents = null;
    expect((await service.previewForMember("member-1", request)).rows[0].priceCents).toBeNull();
  });

  it("keeps explicit API request prices backward compatible above saved draft prices", async () => {
    repository.savedPrices = [{ productVariantId: 101, revisionId: 8, overridePriceCents: 1899, updatedAt: now.toISOString() }];
    expect((await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101],
      requestedRetailPricesByVariantId: { "101": 2099 } })).rows[0].priceCents).toBe(2099);
  });

  it("rejects another tab's price change instead of queueing an unreviewed price", async () => {
    repository.savedPrices = [{ productVariantId: 101, revisionId: 8, overridePriceCents: 1899, updatedAt: now.toISOString() }];
    await expect(service.createListingPushJobForMember("member-1", { storeConnectionId: 22, productVariantIds: [101],
      expectedPriceRevisionIdsByVariantId: { "101": null }, idempotencyKey: "stale-price-job" }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT" });
    expect(repository.lastCreatedInput).toBeNull();
  });

  it("rejects changed catalog default even when no saved setting revision changed", async () => {
    const reviewedPrice = repository.candidate.defaultRetailPriceCents;
    repository.candidate.defaultRetailPriceCents = 4499;
    await expect(service.createListingPushJobForMember("member-1", { storeConnectionId: 22, productVariantIds: [101],
      expectedPriceRevisionIdsByVariantId: { "101": null }, expectedPriceCentsByVariantId: { "101": reviewedPrice },
      idempotencyKey: "changed-default-price" })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT" });
    expect(repository.lastCreatedInput).toBeNull();
  });

  it("rejects partial revision maps and hashes a reset even if its effective price stays the same", async () => {
    const request = { storeConnectionId: 22, productVariantIds: [101] };
    const initial = await service.previewForMember("member-1", request);
    repository.savedPrices = [{ productVariantId: 101, revisionId: 8, overridePriceCents: null, updatedAt: now.toISOString() }];
    const reset = await service.previewForMember("member-1", request);
    expect(reset.rows[0].priceCents).toBe(initial.rows[0].priceCents);
    expect(reset.rows[0].previewHash).not.toBe(initial.rows[0].previewHash);
    await expect(service.createListingPushJobForMember("member-1", { ...request,
      expectedPriceRevisionIdsByVariantId: {}, idempotencyKey: "partial-price-job" }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_OVERRIDE_INVALID" });
  });

  it("carries the catalog product eBay category into preview and listing intent", async () => {
    repository.context = {
      ...repository.context,
      platform: "ebay",
    };
    repository.config = {
      ...repository.config!,
      platform: "ebay",
      marketplaceConfig: { profileId: "profile-1" },
    };
    repository.storeCategoryAssignments = [{
      productVariantId: 101,
      storeCategoryNames: ["Supplies:Toploaders"],
    }];

    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(result.rows[0]).toMatchObject({
      previewStatus: "ready",
      marketplaceCategoryId: "183438",
      marketplaceCategoryName: "Card Toploaders & Holders",
      storeCategoryNames: ["Supplies:Toploaders"],
    });
    expect(result.rows[0]?.listingIntent).toMatchObject({
      marketplaceCategoryId: "183438",
      marketplaceCategoryName: "Card Toploaders & Holders",
      storeCategoryNames: ["Supplies:Toploaders"],
    });
  });

  it("blocks eBay preview when the catalog product has no browse category", async () => {
    repository.context = {
      ...repository.context,
      platform: "ebay",
    };
    repository.config = {
      ...repository.config!,
      platform: "ebay",
      marketplaceConfig: { profileId: "profile-1", categoryId: "183454" },
      requiredProductFields: [
        ...repository.config!.requiredProductFields,
        "ebayBrowseCategoryId",
      ],
    };
    repository.candidate = {
      ...repository.candidate,
      ebayBrowseCategoryId: null,
      ebayBrowseCategoryName: null,
    };

    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(result.rows[0]).toMatchObject({
      previewStatus: "blocked",
      marketplaceCategoryId: null,
      blockers: expect.arrayContaining(["ebay_browse_category_required"]),
      listingIntent: null,
    });
    expect(result.rows[0]?.blockers.filter((blocker) => (
      blocker === "ebay_browse_category_required"
      || blocker === "missing_product_field:ebayBrowseCategoryId"
    ))).toEqual(["ebay_browse_category_required"]);
  });

  it("blocks preview when the selected eBay fulfillment policy exceeds current capabilities", async () => {
    repository.context = { ...repository.context, platform: "ebay" };
    repository.config = {
      ...repository.config!,
      platform: "ebay",
      marketplaceConfig: {
        profileId: "profile-1",
        marketplaceId: "EBAY_US",
        businessPolicies: { fulfillmentPolicyId: "fulfillment-policy" },
      },
    };
    ebayPolicyPreflight = {
      compatible: false,
      fulfillmentPolicyId: "fulfillment-policy",
      capabilityEvidenceHash: "capability-hash-2",
      issues: [{
        code: "shipping_service_unsupported:VendorCourier",
        message: "VendorCourier is unsupported.",
      }],
    };

    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(result.rows[0]).toMatchObject({
      previewStatus: "blocked",
      blockers: expect.arrayContaining([
        "ebay_fulfillment_policy:shipping_service_unsupported:VendorCourier",
      ]),
    });
  });

  it("applies store-and-variant policy overrides and validates the effective fulfillment policy", async () => {
    repository.context = { ...repository.context, platform: "ebay" };
    repository.config = {
      ...repository.config!,
      platform: "ebay",
      marketplaceConfig: {
        profileId: "profile-1",
        marketplaceId: "EBAY_US",
        businessPolicies: {
          fulfillmentPolicyId: "fulfillment-default",
          returnPolicyId: "return-default",
          paymentPolicyId: "payment-default",
        },
      },
    };
    repository.listingPolicyOverrides = [{
      productVariantId: 101,
      fulfillmentPolicyId: "fulfillment-override",
      returnPolicyId: "return-override",
      paymentPolicyId: null,
      updatedAt: now,
    }];

    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(evaluatedFulfillmentPolicyIds).toEqual([
      "fulfillment-default",
      "fulfillment-override",
    ]);
    expect(result.rows[0]).toMatchObject({
      previewStatus: "ready",
      businessPolicySelection: {
        fulfillmentPolicyId: "fulfillment-override",
        returnPolicyId: "return-override",
        paymentPolicyId: "payment-default",
        overriddenFields: ["fulfillmentPolicyId", "returnPolicyId"],
      },
      listingIntent: {
        marketplaceConfig: {
          businessPolicies: {
            fulfillmentPolicyId: "fulfillment-override",
            returnPolicyId: "return-override",
            paymentPolicyId: "payment-default",
          },
        },
      },
    });
  });

  it("allows an onboarding vendor to preview a launch-ready selected listing", async () => {
    repository.context = {
      ...repository.context,
      vendorStatus: "onboarding",
    };

    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(result.summary).toEqual({ total: 1, ready: 1, blocked: 0, warning: 0 });
    expect(result.rows[0]).toMatchObject({
      productVariantId: 101,
      previewStatus: "ready",
      priceCents: 1299,
    });
    expect(repository.lastCreatedInput).toBeNull();
  });

  it("uses explicit listing policies when store policy defaults are missing", async () => {
    repository.context = { ...repository.context, platform: "ebay" };
    repository.config = {
      ...repository.config!, platform: "ebay",
      marketplaceConfig: { profileId: "profile-1", marketplaceId: "EBAY_US", businessPolicies: {} },
    };
    repository.listingPolicyOverrides = [{
      productVariantId: 101, revisionId: 9, fulfillmentPolicyId: "listing-shipping",
      returnPolicyId: "listing-returns", paymentPolicyId: "listing-payment", updatedAt: now,
    }];

    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22, productVariantIds: [101], requestedRetailPriceCents: 1299,
    });
    expect(result.rows[0]).toMatchObject({
      previewStatus: "ready",
      businessPolicySelection: {
        fulfillmentPolicyId: "listing-shipping", returnPolicyId: "listing-returns", paymentPolicyId: "listing-payment",
      },
    });
    expect(evaluatedFulfillmentPolicyIds).toContain("listing-shipping");
  });

  it.each(["paused", "lapsed", "suspended", "closed"] as const)(
    "blocks a %s vendor from listing preview",
    async (vendorStatus) => {
      repository.context = {
        ...repository.context,
        vendorStatus,
      };

      await expect(service.previewForMember("member-1", {
        storeConnectionId: 22,
        productVariantIds: [101],
        requestedRetailPriceCents: 1299,
      })).rejects.toMatchObject({
        code: "DROPSHIP_LISTING_VENDOR_BLOCKED",
        context: {
          vendorId: 10,
          vendorStatus,
          action: "preview",
        },
      });
      expect(repository.lastCreatedInput).toBeNull();
    },
  );

  it("applies per-variant retail price overrides to listing previews", async () => {
    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPricesByVariantId: {
        "101": 1399,
      },
    });

    expect(result.rows[0]).toMatchObject({
      productVariantId: 101,
      priceCents: 1399,
      previewStatus: "ready",
    });
    expect(result.rows[0]?.listingIntent).toMatchObject({
      productVariantId: 101,
      priceCents: 1399,
    });
  });

  it("blocks from missing connection listing config instead of hardcoded marketplace rules", async () => {
    repository.config = null;

    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(result.rows[0]?.previewStatus).toBe("blocked");
    expect(result.rows[0]?.blockers).toContain("listing_config_required");
    expect(result.rows[0]?.blockers).not.toContain("platform_not_supported");
  });

  it("blocks listing push when canonical catalog package data is incomplete", async () => {
    repository.packageReadiness.set(101, {
      hasCatalogPackageData: false,
      hasActiveBox: true,
      hasActiveRateTable: true,
    });

    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(result.rows[0]?.previewStatus).toBe("blocked");
    expect(result.rows[0]?.blockers).toContain("catalog_package_data_required");
    expect(result.rows[0]?.blockers).not.toContain("package_profile_required");
  });

  it("blocks listing preview when vendor entitlement is not active", async () => {
    repository.context = {
      ...repository.context,
      entitlementStatus: "grace",
    };

    await expect(service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED",
      context: {
        vendorId: 10,
        entitlementStatus: "grace",
      },
    });
  });

  it("blocks listing preview when the store connection is not launch-ready", async () => {
    repository.context = {
      ...repository.context,
      setupStatus: "pending",
      storeLaunchReady: false,
    };

    await expect(service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_STORE_BLOCKED",
      context: {
        storeConnectionId: 22,
        setupStatus: "pending",
        storeLaunchReady: false,
      },
    });
  });

  it("rejects retail price overrides for variants outside the listing request", async () => {
    await expect(service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPricesByVariantId: {
        "999": 1299,
      },
    })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_OVERRIDE_INVALID" });
  });

  it("blocks an onboarding vendor from creating a listing push job", async () => {
    repository.context = {
      ...repository.context,
      vendorStatus: "onboarding",
    };

    await expect(service.createListingPushJobForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPricesByVariantId: {
        "101": 1399,
      },
      idempotencyKey: "onboarding-listing-job",
    })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_VENDOR_BLOCKED",
      context: {
        vendorId: 10,
        vendorStatus: "onboarding",
        action: "push",
      },
    });
    expect(repository.lastCreatedInput).toBeNull();
    expect(repository.jobs).toEqual([]);
  });

  it("creates listing push jobs idempotently and rejects request drift", async () => {
    const input = {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPricesByVariantId: {
        "101": 1399,
      },
      idempotencyKey: "listing-job-001",
    };

    const first = await service.createListingPushJobForMember("member-1", input);
    const second = await service.createListingPushJobForMember("member-1", input);

    expect(first.job.status).toBe("queued");
    expect(first.idempotentReplay).toBe(false);
    expect(second.job.jobId).toBe(first.job.jobId);
    expect(second.idempotentReplay).toBe(true);
    expect(repository.jobs[0]?.requestHash).toBe(hashListingPushJobRequest({
      vendorId: 10,
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: null,
      requestedRetailPricesByVariantId: {
        "101": 1399,
      },
      previewHashesByVariantId: {
        "101": first.preview.rows[0]!.previewHash,
      },
    }));
    expect(repository.lastCreatedInput?.requestedRetailPricesByVariantId).toEqual({
      "101": 1399,
    });
    expect(logs.map((event) => event.code)).toEqual([
      "DROPSHIP_LISTING_PUSH_JOB_CREATED",
      "DROPSHIP_LISTING_PUSH_JOB_REPLAYED",
    ]);

    await expect(service.createListingPushJobForMember("member-1", {
      ...input,
      requestedRetailPricesByVariantId: {
        "101": 1499,
      },
    })).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
  });

  it("replays unchanged reviewed prices and rejects changes to a retry's review contract", async () => {
    const request = { storeConnectionId: 22, productVariantIds: [101],
      expectedPriceRevisionIdsByVariantId: { "101": null },
      expectedPriceCentsByVariantId: { "101": repository.candidate.defaultRetailPriceCents }, idempotencyKey: "reviewed-retry" };
    const first = await service.createListingPushJobForMember("member-1", request);
    const replay = await service.createListingPushJobForMember("member-1", request);
    expect(replay.job.jobId).toBe(first.job.jobId); expect(replay.idempotentReplay).toBe(true);
    await expect(service.createListingPushJobForMember("member-1", { ...request, expectedPriceCentsByVariantId: undefined }))
      .rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
  });
});

class FakeVendorProvisioningService {
  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return {
      vendor: makeVendor({ memberId }),
      created: false,
      changedFields: [],
    };
  }
}

class FakeAtpProvider implements DropshipAtpProvider {
  async getVariantAtp(): Promise<Map<number, number>> {
    return new Map([[101, 4]]);
  }
}

class FakeListingPreviewRepository implements DropshipListingPreviewRepository {
  loadListingContents?: DropshipListingPreviewRepository["loadListingContents"];
  rulePrices = new Map<number, ListingRulePrice>();
  ruleCandidateIds: number[] = [];
  async loadRulePrices(input: { candidates: readonly DropshipListingCatalogCandidate[] }): Promise<Map<number, ListingRulePrice>> {
    this.ruleCandidateIds = input.candidates.map((row) => row.productVariantId);
    return new Map([...this.rulePrices].filter(([id]) => this.ruleCandidateIds.includes(id)));
  }
  savedPrices: SavedListingPriceRevision[] = [];
  existingListings: DropshipExistingVendorListing[] = [];
  async listSavedListingPrices(): Promise<SavedListingPriceRevision[]> { return this.savedPrices; }
  candidate = makeCandidate();
  storeCategoryAssignments: Array<{
    productVariantId: number;
    storeCategoryNames: string[];
  }> = [];
  listingPolicyOverrides: DropshipEbayListingPolicyOverride[] = [];
  context: DropshipListingStoreContext = {
    vendorId: 10,
    vendorStatus: "active",
    entitlementStatus: "active",
    storeConnectionId: 22,
    storeStatus: "connected",
    setupStatus: "ready",
    platform: "shopify",
    storeLaunchReady: true,
  };
  config: DropshipStoreListingConfig | null = {
    id: 7,
    storeConnectionId: 22,
    platform: "shopify",
    listingMode: "live",
    inventoryMode: "managed_quantity_sync",
    priceMode: "vendor_defined",
    marketplaceConfig: { profileId: "profile-1" },
    requiredConfigKeys: ["profileId"],
    requiredProductFields: ["description", "brand"],
    isActive: true,
  };
  jobs: DropshipListingPushJobRecord[] = [];
  packageReadiness = new Map<number, DropshipListingPackageReadiness>([[101, {
    hasCatalogPackageData: true,
    hasActiveBox: true,
    hasActiveRateTable: true,
  }]]);
  lastCreatedInput: CreateDropshipListingPushJobRepositoryInput | null = null;

  async loadStoreContext(): Promise<DropshipListingStoreContext | null> {
    return this.context;
  }

  async getStoreListingConfig(): Promise<DropshipStoreListingConfig | null> {
    return this.config;
  }

  async listCatalogExposureRules(): Promise<DropshipCatalogExposureRule[]> {
    return [{ id: 1, scopeType: "catalog", action: "include" }];
  }

  async listSelectionRules(): Promise<DropshipVendorSelectionRule[]> {
    return [{
      id: 2,
      scopeType: "catalog",
      action: "include",
      autoConnectNewSkus: true,
      autoListNewSkus: true,
      isActive: true,
    }];
  }

  async listCatalogCandidates(): Promise<DropshipListingCatalogCandidate[]> {
    return [this.candidate];
  }

  async listVariantOverrides(): Promise<DropshipVendorVariantOverride[]> {
    return [{ productVariantId: 101, marketplaceQuantityCap: 4 }];
  }

  async listExistingListings(): Promise<DropshipExistingVendorListing[]> {
    return this.existingListings;
  }

  async listPricingPolicies(): Promise<DropshipPricingPolicyRecord[]> {
    return [];
  }

  async listEbayStoreCategoryAssignments(): Promise<Array<{
    productVariantId: number;
    storeCategoryNames: string[];
  }>> {
    return this.storeCategoryAssignments;
  }

  async listEbayListingPolicyOverrides(): Promise<DropshipEbayListingPolicyOverride[]> {
    return this.listingPolicyOverrides;
  }

  async getPackageReadiness(): Promise<Map<number, DropshipListingPackageReadiness>> {
    return this.packageReadiness;
  }

  async createListingPushJob(
    input: CreateDropshipListingPushJobRepositoryInput,
  ): Promise<CreateDropshipListingPushJobRepositoryResult> {
    this.lastCreatedInput = input;
    const existingJob = this.jobs.find((job) => job.idempotencyKey === input.idempotencyKey);
    if (existingJob) {
      if (existingJob.requestHash !== input.requestHash) {
        throw new DropshipError(
          "DROPSHIP_IDEMPOTENCY_CONFLICT",
          "Dropship listing push job idempotency key was reused with a different request.",
        );
      }
      return {
        job: existingJob,
        items: [makeJobItem(existingJob.jobId, input.preview.rows[0]?.previewHash ?? null)],
        idempotentReplay: true,
      };
    }

    const job: DropshipListingPushJobRecord = {
      jobId: this.jobs.length + 1,
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      status: input.preview.summary.ready + input.preview.summary.warning > 0 ? "queued" : "failed",
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.jobs.push(job);
    return {
      job,
      items: [makeJobItem(job.jobId, input.preview.rows[0]?.previewHash ?? null)],
      idempotentReplay: false,
    };
  }
}

function rulePrice(): ListingRulePrice {
  return { priceCents: 1152, ruleName: "Store default rule", ruleId: null, issue: null, profileRevisionId: 1,
    evidenceHash: "a".repeat(64), productCost: { status: "available", unitCostCents: 809, planId: "ops", source: "variant_fixed_price", overrideId: "fixed", issue: null } };
}
function makeCandidate(): DropshipListingCatalogCandidate {
  return {
    productId: 501,
    productVariantId: 101,
    productLineIds: [9],
    category: "Protectors",
    ebayBrowseCategoryId: "183438",
    ebayBrowseCategoryName: "Card Toploaders & Holders",
    productIsActive: true,
    variantIsActive: true,
    unitsPerVariant: 3,
    defaultRetailPriceCents: 1199,
    sku: "CS-TOPLOADER-35PT",
    productName: "Toploader",
    variantName: "35pt",
    title: "Card Shellz Toploader 35pt",
    description: "Rigid card protection for standard trading cards.",
    brand: "Card Shellz",
    gtin: "000000000101",
    mpn: "TL35",
    condition: "new",
    itemSpecifics: { size: "35pt" },
    imageUrls: ["https://cdn.example.test/toploader.jpg"],
    weightGrams: 100,
  };
}

function makeJobItem(jobId: number, previewHash: string | null): DropshipListingPushJobItemRecord {
  return {
    itemId: 1,
    jobId,
    listingId: 100,
    productVariantId: 101,
    status: "queued",
    previewHash,
    errorCode: null,
    errorMessage: null,
  };
}

function makeVendor(input: { memberId: string }): DropshipProvisionedVendorProfile {
  return {
    vendorId: 10,
    memberId: input.memberId,
    currentSubscriptionId: "sub-1",
    currentPlanId: "ops",
    businessName: "Vendor LLC",
    contactName: "Vendor User",
    email: "vendor@cardshellz.com",
    phone: null,
    status: "active",
    entitlementStatus: "active",
    entitlementCheckedAt: now,
    membershipGraceEndsAt: null,
    includedStoreConnections: 1,
    createdAt: now,
    updatedAt: now,
  };
}
