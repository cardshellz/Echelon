import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { DropshipListingTierEligibility } from "../../domain/listing-tiers";
import { resolveListingContent, listingCatalogHash } from "../../application/dropship-listing-content-resolver";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "../../application/dropship-ebay-category-resolver";
import { refreshQueuedListingIntent } from "../../application/dropship-listing-intent-refresh";
import { DEFAULT_DROPSHIP_COST_CHANGE_POLICY } from "../../../../../shared/dropship/cost-change-policy";
import { TOPLOADERS, rulesProfile } from "../fixtures/ebay-category-rules.fixture";
import { noContentProfile } from "../fixtures/listing-content.fixture";
import type { SavedListingPriceRevision } from "../../../../../shared/dropship/listing-price";
import type { ListingRulePrice } from "../../application/dropship-rule-price";
import type { DropshipProductCost, DropshipProductCostReader } from "../../application/dropship-product-cost";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type {
  CatalogVariantPublicationPhotos,
  CatalogVariantPublicationPhotoReader,
} from "../../../catalog/catalog-publication-images.reader";
import {
  DROPSHIP_LISTING_MAX_PHOTOS,
  DropshipListingPreviewService,
  hashListingPushJobRequest,
  type DropshipListingPreviewServiceDependencies,
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
import type {
  DropshipCanonicalListingContent,
  DropshipStoreListingConfig,
} from "../../application/dropship-marketplace-listing-provider";
import type { DropshipEbayListingPolicyOverride } from "../../application/dropship-ebay-listing-policy-override-service";
import type { DropshipEbayReturnPaymentPolicyCheckInput } from "../../application/dropship-ebay-return-payment-policy-check";
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
import { toDropshipVendorListingPreview } from "../../application/dropship-listing-dtos";
import {
  buildListingQueueRequest,
  type DropshipCatalogRow as ClientCatalogRow,
  type DropshipListingPreviewResult as ClientListingPreviewResult,
} from "../../../../../client/src/lib/dropship-ops-surface";
import { registerDropshipListingRoutes } from "../../interfaces/http/dropship-listing.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
// The HTTP tests below exercise the real listing route and the real service.
// Portal sign-in and step-up have their own tests; here they only attach the member.
vi.mock("../../interfaces/http/dropship-auth.routes", () => ({
  requireDropshipAuth: (req: Request, res: Response, next: NextFunction) => {
    const memberId = req.header("X-Test-Member");
    if (!memberId) {
      res.status(401).json({ error: { code: "DROPSHIP_AUTH_REQUIRED", message: "Dropship authentication is required." } });
      return;
    }
    req.session = { dropship: { memberId } } as unknown as Request["session"];
    next();
  },
  requireDropshipSensitiveActionProof: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

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
  /** Ids the fake eBay account no longer lists; empty means every checked id exists. */
  let goneReturnPolicyIds: Set<string>;
  let gonePaymentPolicyIds: Set<string>;
  let returnPaymentPolicyCheckFailure: unknown;
  let checkedReturnPaymentPolicies: DropshipEbayReturnPaymentPolicyCheckInput[];
  let listingTierEligibility: DropshipListingTierEligibility;
  let productCosts: Map<number, DropshipProductCost>;
  let productCostReader: DropshipProductCostReader;
  let serviceDeps: DropshipListingPreviewServiceDependencies;

  beforeEach(() => {
    repository = new FakeListingPreviewRepository();
    logs = [];
    listingTierEligibility = allTiersOnSale();
    productCosts = new Map();
    productCostReader = {
      loadProductCosts: async ({ productVariantIds }) => new Map(productVariantIds.flatMap((id) => {
        const cost = productCosts.get(id);
        return cost ? [[id, cost] as const] : [];
      })),
    };
    ebayPolicyPreflight = {
      compatible: true,
      fulfillmentPolicyId: "fulfillment-policy",
      capabilityEvidenceHash: "capability-hash",
      issues: [],
    };
    evaluatedFulfillmentPolicyIds = [];
    goneReturnPolicyIds = new Set();
    gonePaymentPolicyIds = new Set();
    returnPaymentPolicyCheckFailure = null;
    checkedReturnPaymentPolicies = [];
    serviceDeps = {
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      listingPhotos: { listPublicationPhotos: async ({ productVariantIds }) => new Map(productVariantIds.map(id => [id, {
        photos: repository.candidate.imageUrls.map((url, index) => ({ assetId: index + 1, position:index, url, uploaded: false })), issues: [],
      }])) },
      productCosts: { loadProductCosts: (input) => productCostReader.loadProductCosts(input) },
      atp: new FakeAtpProvider(),
      marketplaceListing: new ConfigDrivenDropshipMarketplaceListingProvider(),
      ebayFulfillmentPolicyGuard: {
        evaluateForStoreConnection: async (input) => {
          evaluatedFulfillmentPolicyIds.push(input.fulfillmentPolicyId);
          return { ...ebayPolicyPreflight, fulfillmentPolicyId: input.fulfillmentPolicyId };
        },
        evaluateWithAccessToken: async () => ebayPolicyPreflight,
      },
      ebayReturnPaymentPolicies: {
        check: async (input) => {
          checkedReturnPaymentPolicies.push(input);
          if (returnPaymentPolicyCheckFailure) throw returnPaymentPolicyCheckFailure;
          return {
            missingReturnPolicyIds: new Set(input.returnPolicyIds.filter((id) => goneReturnPolicyIds.has(id))),
            missingPaymentPolicyIds: new Set(input.paymentPolicyIds.filter((id) => gonePaymentPolicyIds.has(id))),
          };
        },
      },
      listingTiers: { resolveForVendor: async () => ({ eligibility: listingTierEligibility }) },
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    };
    service = new DropshipListingPreviewService(serviceDeps);
  });

  it("reports the tier a SKU sells in and leaves an on-sale tier alone", async () => {
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0].listingTier).toEqual(listingTierEligibility.pack);
    expect(preview.rows[0].blockers.filter((blocker) => blocker.startsWith("listing_tier:"))).toEqual([]);
    expect(preview.rows[0].marketplaceQuantity).toBe(4);
  });

  it("blocks a new listing in a tier that is off sale, and names the reason", async () => {
    repository.candidate.variantUomType = "case";
    listingTierEligibility = { ...allTiersOnSale(), case: caseTierOffSale() };

    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });

    expect(preview.rows[0].previewStatus).toBe("blocked");
    expect(preview.rows[0].blockers).toContain("listing_tier:balance_below_tier");
    expect(preview.rows[0].marketplaceQuantity).toBe(0);
    expect(preview.rows[0].listingTier).toMatchObject({ tier: "case", eligible: false, balanceShortfallCents: 38_000 });
    expect(preview.summary).toMatchObject({ blocked: 1, ready: 0 });
  });

  it("zeroes a listed SKU whose tier went off sale and names the tier as the reason, like a sold-out SKU", async () => {
    repository.candidate.variantUomType = "case";
    listingTierEligibility = { ...allTiersOnSale(), case: caseTierOffSale() };
    repository.existingListings = [{ productVariantId: 101, listingId: 1, status: "active", vendorRetailPriceCents: null,
      quantityCap: null, externalListingId: "ebay-1" }];

    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });

    expect(preview.rows[0].blockers).toEqual(["listing_tier:balance_below_tier", "marketplace_quantity_unavailable"]);
    expect(preview.rows[0].previewStatus).toBe("blocked");
    expect(preview.rows[0].marketplaceQuantity).toBe(0);
    expect(preview.rows[0].currentListingStatus).toBe("active");
  });

  it("uses the exact sanitized description and rejects unreviewed content before queueing", async () => {
    const saved = { revisionId: 1, customText: "My shop description <script>literal</script>",
      catalogHash: listingCatalogHash(repository.candidate), updatedAt: now.toISOString() };
    const content = resolveListingContent({ candidate: repository.candidate, profile: noContentProfile, saved });
    repository.loadListingContents = async () => new Map([[101, content]]);
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0].listingIntent?.description).toBe(content.descriptionHtml);
    expect(preview.rows[0].listingIntent?.description).toBe("<p>My shop description &lt;script&gt;literal&lt;/script&gt;</p>");
    expect(content.facts.length).toBeGreaterThan(0);
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
  it("queues in one step what the server's own preview shows, with no evidence from an earlier preview", async () => {
    // A rule-priced row with resolved content and a saved price revision: every
    // kind of evidence the two-step push would have had to echo.
    const content = resolveListingContent({ candidate: repository.candidate, profile: noContentProfile, saved: null });
    repository.loadListingContents = async () => new Map([[101, content]]);
    repository.rulePrices.set(101, rulePrice());
    repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: null, pricingMode: "rules", updatedAt: now.toISOString() }];

    const result = await service.createListingPushJobForMember("member-1", {
      storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "one-step-001", reviewMode: "current_preview",
    });

    expect(result.job.status).toBe("queued");
    expect(result.idempotentReplay).toBe(false);
    expect(repository.jobs).toHaveLength(1);
    expect(repository.lastCreatedInput?.preview.rows[0]).toMatchObject({
      contentEvidenceHash: content.evidenceHash,
      rulePriceEvidenceHash: "a".repeat(64),
      priceSettingRevisionId: 7,
    });
    expect(repository.lastCreatedInput?.preview.rows[0].listingIntent?.description).toBe(content.descriptionHtml);
  });

  it("replays a one-step push by its key even when stock moved in between", async () => {
    const request = { storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "one-step-replay", reviewMode: "current_preview" as const };
    const first = await service.createListingPushJobForMember("member-1", request);
    // The preview hash covers quantity; a one-step push is identified by what was asked.
    repository.candidate = { ...repository.candidate, title: `${repository.candidate.title} (restocked)` };
    const retry = await service.createListingPushJobForMember("member-1", request);

    expect(retry.idempotentReplay).toBe(true);
    expect(retry.job.jobId).toBe(first.job.jobId);
    expect(repository.jobs).toHaveLength(1);
  });

  it("refuses a one-step push that also carries evidence from an earlier preview", async () => {
    await expect(service.createListingPushJobForMember("member-1", {
      storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "one-step-mixed", reviewMode: "current_preview",
      expectedPriceCentsByVariantId: { "101": 1299 },
    })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_REVIEW_MODE_CONFLICT" });
    expect(repository.jobs).toHaveLength(0);
  });

  it("keeps the two-step push strict: missing evidence is still refused", async () => {
    const content = resolveListingContent({ candidate: repository.candidate, profile: noContentProfile, saved: null });
    repository.loadListingContents = async () => new Map([[101, content]]);
    await expect(service.createListingPushJobForMember("member-1", {
      storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "two-step-missing",
    })).rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    await expect(service.createListingPushJobForMember("member-1", {
      storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "two-step-explicit", reviewMode: "reviewed_preview",
    })).rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    expect(repository.jobs).toHaveLength(0);
  });

  describe("over HTTP, through the real listing route", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
      const app = express();
      app.use(express.json());
      registerDropshipListingRoutes(app, service);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    function post(path: string, body: unknown) {
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test-Member": "member-1" },
        body: JSON.stringify(body),
      });
    }

    function withEvidenceOnEveryKind() {
      const content = resolveListingContent({ candidate: repository.candidate, profile: noContentProfile, saved: null });
      repository.loadListingContents = async () => new Map([[101, content]]);
      repository.rulePrices.set(101, rulePrice());
      repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: null, pricingMode: "rules", updatedAt: now.toISOString() }];
      return content;
    }

    it("queues the vendor page's one-click request", async () => {
      const content = withEvidenceOnEveryKind();
      const selected = { productVariantId: 101, selectionDecision: { selected: true } } as unknown as ClientCatalogRow;
      const body = buildListingQueueRequest({ storeConnectionId: 22, rows: [selected], idempotencyKey: "http-one-step" });

      const response = await post("/api/dropship/listing-push-jobs", body);

      expect(response.status).toBe(201);
      const json = await response.json();
      expect(json.job.status).toBe("queued");
      expect(json.preview.rows[0]).not.toHaveProperty("listingIntent");
      expect(repository.lastCreatedInput?.preview.rows[0].listingIntent?.description).toBe(content.descriptionHtml);
    });

    it("forwards the reviewed evidence of a two-step push, so a fresh preview queues", async () => {
      // Regression: the route once dropped the content and rule evidence, so
      // every two-step push was refused as changed right after its preview.
      const content = withEvidenceOnEveryKind();
      const previewResponse = await post("/api/dropship/listings/preview", { storeConnectionId: 22, productVariantIds: [101] });
      expect(previewResponse.status).toBe(200);
      const { preview } = await previewResponse.json() as { preview: ClientListingPreviewResult };
      const row = preview.rows[0]!;
      expect(row).toMatchObject({ contentEvidenceHash: content.evidenceHash, rulePriceEvidenceHash: "a".repeat(64), priceSettingRevisionId: 7 });

      const response = await post("/api/dropship/listing-push-jobs", {
        storeConnectionId: 22,
        productVariantIds: [101],
        idempotencyKey: "http-two-step",
        expectedPriceRevisionIdsByVariantId: { "101": row.priceSettingRevisionId },
        expectedPriceCentsByVariantId: { "101": row.priceCents },
        expectedRuleEvidenceHashesByVariantId: { "101": row.rulePriceEvidenceHash },
        expectedContentEvidenceHashesByVariantId: { "101": row.contentEvidenceHash },
      });

      expect(response.status).toBe(201);
      expect((await response.json()).job.status).toBe("queued");
    });

    it("answers a mixed request with a 400 that names the conflict", async () => {
      const response = await post("/api/dropship/listing-push-jobs", {
        storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "http-mixed", reviewMode: "current_preview",
        expectedPriceCentsByVariantId: { "101": 1299 },
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatchObject({ code: "DROPSHIP_LISTING_PUSH_REVIEW_MODE_CONFLICT" });
    });
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
  describe("uploaded catalog photos", () => {
    const uploadedUrl = `https://catalog.example.com/api/catalog/images/31/${"c".repeat(64)}.png`;
    const linkedUrl = "https://cdn.example.test/toploader.jpg";
    let photoRequests: Array<{ productVariantIds: readonly number[]; maxPhotosPerVariant: number }>;
    let photos: Map<number, CatalogVariantPublicationPhotos>;

    function withPhotoReader(reader?: CatalogVariantPublicationPhotoReader): DropshipListingPreviewService {
      return new DropshipListingPreviewService({ ...serviceDeps, listingPhotos: reader ?? {
        listPublicationPhotos: async (input) => { photoRequests.push(input); return photos; },
      } });
    }
    function photoLogs() {
      return logs.filter((event) => event.code === "DROPSHIP_LISTING_PHOTO_UNPUBLISHABLE");
    }

    beforeEach(() => {
      photoRequests = [];
      // The eBay store default requires a photo (dropship-listing-config-service.ts).
      repository.config = { ...repository.config!, requiredProductFields: ["description", "brand", "imageUrls"] };
      // Today's catalog read keeps URL photos only: this product's only photo is uploaded.
      repository.candidate.imageUrls = [];
      photos = new Map([[101, { photos: [{ assetId: 31, position:0, url: uploadedUrl, uploaded: true }], issues: [] }]]);
    });

    it("lists a product whose only photo is uploaded, which the URL-only catalog read blocks", async () => {
      const without = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
      expect(without.rows[0].blockers).toContain("missing_product_field:imageUrls");

      const preview = await withPhotoReader().previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });

      expect(preview.rows[0]).toMatchObject({ previewStatus: "ready", blockers: [], warnings: [] });
      expect(preview.rows[0].listingIntent?.imageUrls).toEqual([uploadedUrl]);
      expect(photoRequests).toEqual([{ productVariantIds: [101], maxPhotosPerVariant: DROPSHIP_LISTING_MAX_PHOTOS }]);
      expect(DROPSHIP_LISTING_MAX_PHOTOS).toBe(20);
      expect(photoLogs()).toEqual([]);
    });

    it("publishes the catalog's photo order, uploaded and linked photos together", async () => {
      repository.candidate.imageUrls = [linkedUrl];
      photos.set(101, { photos: [
        { assetId: 31, position:0, url: uploadedUrl, uploaded: true },
        { assetId: 7, position:1, url: linkedUrl, uploaded: false },
      ], issues: [] });

      const preview = await withPhotoReader().previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });

      expect(preview.rows[0].listingIntent?.imageUrls).toEqual([uploadedUrl, linkedUrl]);
      // The preview hash covers the intent, so a changed photo needs a new review.
      const linkedOnly = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
      expect(linkedOnly.rows[0].listingIntent?.imageUrls).toEqual([linkedUrl]);
      expect(preview.rows[0].previewHash).not.toBe(linkedOnly.rows[0].previewHash);
    });

    it("leaves out uploaded photos it cannot publish, warns once per reason, and still queues the listing", async () => {
      photos.set(101, { photos: [{ assetId: 7, position:1, url: linkedUrl, uploaded: false }], issues: [
        { assetId: 31, code: "CATALOG_PUBLIC_URL_REQUIRED", message: "not configured" },
        { assetId: 32, code: "CATALOG_IMAGE_UNAVAILABLE", message: "missing file" },
        { assetId: 33, code: "IMAGE_FORMAT_UNSUPPORTED", message: "mislabeled" },
      ] });
      const photoService = withPhotoReader();

      const preview = await photoService.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });

      expect(preview.rows[0]).toMatchObject({ previewStatus: "warning", blockers: [],
        warnings: ["catalog_photo_public_address_missing", "catalog_photo_unavailable"] });
      expect(preview.rows[0].listingIntent?.imageUrls).toEqual([linkedUrl]);
      expect(photoLogs()).toEqual([expect.objectContaining({ context: {
        vendorId: 10, storeConnectionId: 22, unpublishableCount: 3, truncated: false,
        photos: [
          { productVariantId: 101, assetId: 31, code: "CATALOG_PUBLIC_URL_REQUIRED" },
          { productVariantId: 101, assetId: 32, code: "CATALOG_IMAGE_UNAVAILABLE" },
          { productVariantId: 101, assetId: 33, code: "IMAGE_FORMAT_UNSUPPORTED" },
        ],
      } })]);
      const queued = await photoService.createListingPushJobForMember("member-1", {
        storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "photos-warning-1", reviewMode: "current_preview",
      });
      expect(queued.job.status).toBe("queued");
      expect(repository.lastCreatedInput?.preview.rows[0].listingIntent?.imageUrls).toEqual([linkedUrl]);
    });

    it("blocks a listing only when it is left with no photo at all", async () => {
      photos.set(101, { photos: [], issues: [{ assetId: 31, code: "CATALOG_PUBLIC_URL_REQUIRED", message: "not configured" }] });

      const preview = await withPhotoReader().previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });

      expect(preview.rows[0].previewStatus).toBe("blocked");
      expect(preview.rows[0].blockers).toContain("missing_product_field:imageUrls");
      expect(preview.rows[0].warnings).toContain("catalog_photo_public_address_missing");
    });

    it("pushes the photos the current catalog gives at push time", async () => {
      const photoService = withPhotoReader();
      const intent = await refreshQueuedListingIntent({
        generatePreview: (input) => photoService.generatePreview(input),
        resolveCostChangePolicy: async () => ({ policyId: null, settings: DEFAULT_DROPSHIP_COST_CHANGE_POLICY }),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }, { jobId: 30, jobItemId: 1, vendorId: 10, storeConnectionId: 22, productVariantId: 101, queuedPriceCents: 1199,
        queuedMarketplaceCategory: null });

      expect(intent.imageUrls).toEqual([uploadedUrl]);
    });

    it("fails the preview when the photos cannot be read, rather than publish without uploaded photos", async () => {
      const failure = new Error("catalog read failed");
      const photoService = withPhotoReader({ listPublicationPhotos: async () => { throw failure; } });

      await expect(photoService.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] })).rejects.toBe(failure);
      await expect(photoService.createListingPushJobForMember("member-1", {
        storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "photos-failed-1", reviewMode: "current_preview",
      })).rejects.toBe(failure);
      expect(repository.jobs).toHaveLength(0);
    });

    it("refuses a photo result that leaves a size out", async () => {
      photos = new Map();
      await expect(withPhotoReader().previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] }))
        .rejects.toThrow("Listing photo resolution returned an incomplete catalog result.");
    });

    it("reads no photos for a size the catalog does not expose", async () => {
      repository.candidate.productIsActive = false;

      const preview = await withPhotoReader().previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });

      expect(photoRequests).toEqual([]);
      expect(preview.rows[0].previewStatus).toBe("blocked");
    });

    it("names at most 100 photos it cannot publish in one log line, and says how many there were", async () => {
      photos.set(101, { photos: [{ assetId: 7, position:1, url: linkedUrl, uploaded: false }], issues: Array.from({ length: 101 }, (_, index) => ({
        assetId: 1000 + index, code: "CATALOG_IMAGE_UNAVAILABLE", message: "missing file",
      })) });

      const preview = await withPhotoReader().previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });

      expect(preview.rows[0].warnings).toEqual(["catalog_photo_unavailable"]);
      const [event] = photoLogs();
      expect(event.context).toMatchObject({ unpublishableCount: 101, truncated: true });
      expect((event.context as { photos: unknown[] }).photos).toHaveLength(100);
    });

    it("keeps the catalog's URL photos when no photo reader is configured", async () => {
      repository.candidate.imageUrls = [linkedUrl];
      const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
      expect(preview.rows[0].listingIntent?.imageUrls).toEqual([linkedUrl]);
    });
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
  it("prices an inherit size by the store's rules: rule-owned, with its evidence, never a request-local price", async () => {
    repository.rulePrices.set(101, rulePrice());
    repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101], requestedRetailPriceCents: 1 });
    expect(preview.rows[0]).toMatchObject({ priceCents: 1152, rulePriceEvidenceHash: "a".repeat(64), pricingRuleName: "Store default rule",
      priceSettingRevisionId: 7, followsStorePricing: true });
    expect(preview.rows[0].blockers).not.toContain("pricing_rules_not_configured");
    expect(preview.rows[0].listingIntent).toMatchObject({ priceCents: 1152 });
  });
  it("prices an inherit size without rules at retail, not at the price an earlier push saved", async () => {
    repository.existingListings = [{ productVariantId: 101, listingId: 1, status: "live", vendorRetailPriceCents: 2799,
      quantityCap: null, externalListingId: null }];
    repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0]).toMatchObject({ priceCents: repository.candidate.defaultRetailPriceCents, priceSettingRevisionId: 7 });
    expect(preview.rows[0].rulePriceEvidenceHash).toBeUndefined();
    expect(preview.rows[0].blockers).not.toContain("pricing_rules_not_configured");
  });
  it("never lets a request-local price replace the retail fallback of an inherit size", async () => {
    repository.rulePrices.set(101, { ...rulePrice(), priceCents: null, issue: "pricing_basis_unavailable" });
    repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101], requestedRetailPriceCents: 1 });
    expect(preview.rows[0].priceCents).toBe(repository.candidate.defaultRetailPriceCents);
  });
  it("prices an inherit size its rules can't price at retail, without blocking it (L1)", async () => {
    repository.rulePrices.set(101, { ...rulePrice(), priceCents: null, issue: "pricing_basis_unavailable" });
    repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0]).toMatchObject({ priceCents: repository.candidate.defaultRetailPriceCents });
    expect(preview.rows[0].blockers).not.toContain("pricing_basis_unavailable");
    expect(preview.rows[0].rulePriceEvidenceHash).toBeUndefined();
    // Still the rules' price to move: the push-time review gate reads this marker.
    expect(preview.rows[0].followsStorePricing).toBe(true);
  });
  it("prices an inherit size at retail, unblocked, when a blocking Card Shellz limit refuses its rule price (L1)", async () => {
    // The rule price is $11.52 and the catalog retail $11.99; a $11.75 blocking minimum refuses only the rule price.
    repository.rulePrices.set(101, rulePrice());
    repository.pricingPolicies = [{ id: 31, scopeType: "catalog", productLineId: null, productId: null, productVariantId: null,
      category: null, mode: "block_listing_push", floorPriceCents: 1175, ceilingPriceCents: null }];
    repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0]).toMatchObject({ priceCents: 1199, previewStatus: "ready", followsStorePricing: true });
    expect(preview.rows[0].blockers).toEqual([]);
    expect(preview.rows[0].rulePriceEvidenceHash).toBeUndefined();
    expect(preview.rows[0].listingIntent).toMatchObject({ priceCents: 1199 });
    // A `rules` size keeps the rule price, and the limit blocks it as before.
    repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: null, pricingMode: "rules", updatedAt: now.toISOString() }];
    const rules = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(rules.rows[0]).toMatchObject({ priceCents: 1152, previewStatus: "blocked" });
    expect(rules.rows[0].blockers).toContain("pricing:below_floor:policy_31");
  });
  it("blocks an inherit size when the limit refuses its retail price too", async () => {
    repository.rulePrices.set(101, rulePrice());
    repository.pricingPolicies = [{ id: 32, scopeType: "catalog", productLineId: null, productId: null, productVariantId: null,
      category: null, mode: "block_listing_push", floorPriceCents: 1500, ceilingPriceCents: null }];
    repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0]).toMatchObject({ priceCents: 1199, previewStatus: "blocked", followsStorePricing: true });
    expect(preview.rows[0].blockers).toContain("pricing:below_floor:policy_32");
  });
  it("keeps an inherit size on a rule price that only a warn-only limit flags", async () => {
    repository.rulePrices.set(101, rulePrice());
    repository.pricingPolicies = [{ id: 33, scopeType: "catalog", productLineId: null, productId: null, productVariantId: null,
      category: null, mode: "warn_only", floorPriceCents: 1175, ceilingPriceCents: null }];
    repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0]).toMatchObject({ priceCents: 1152, rulePriceEvidenceHash: "a".repeat(64) });
    expect(preview.rows[0].warnings).toContain("pricing:below_floor:policy_33");
  });
  it("marks only inherit sizes as following the store's pricing", async () => {
    repository.rulePrices.set(101, rulePrice());
    for (const pricingMode of ["rules", "catalog_default", "fixed"] as const) {
      repository.savedPrices = [{ productVariantId: 101, revisionId: 7, overridePriceCents: pricingMode === "fixed" ? 1299 : null,
        pricingMode, updatedAt: now.toISOString() }];
      const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
      expect(preview.rows[0]).not.toHaveProperty("followsStorePricing");
    }
  });
  it("does not request wholesale-derived prices for unavailable catalog candidates", async () => {
    repository.candidate.variantIsActive = false;
    repository.rulePrices.set(101, rulePrice());
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(repository.ruleCandidateIds).toEqual([]);
    expect(preview.rows[0].rulePriceEvidenceHash).toBeUndefined();
  });

  it("lets the store's rules price a listing whose only price was saved by an earlier push", async () => {
    repository.existingListings = [{ productVariantId: 101, listingId: 1, status: "live", vendorRetailPriceCents: 2799,
      quantityCap: null, externalListingId: null }];
    repository.rulePrices.set(101, rulePrice());
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101], requestedRetailPriceCents: 1 });
    expect(preview.rows[0]).toMatchObject({ priceCents: 1152, rulePriceEvidenceHash: "a".repeat(64), pricingRuleName: "Store default rule" });
    expect(preview.rows[0].listingIntent).toMatchObject({ priceCents: 1152 });
  });

  it("warns about a price below the .ops cost without blocking the row, and still queues it", async () => {
    productCosts.set(101, availableCost(1299));
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0]).toMatchObject({ priceCents: 1199, previewStatus: "warning", blockers: [], warnings: ["price_below_product_cost"] });
    expect(preview.summary).toMatchObject({ ready: 0, warning: 1, blocked: 0 });
    const result = await service.createListingPushJobForMember("member-1", { storeConnectionId: 22, productVariantIds: [101],
      expectedPriceRevisionIdsByVariantId: { "101": null }, expectedPriceCentsByVariantId: { "101": 1199 }, idempotencyKey: "below-cost-job" });
    expect(result.job.status).toBe("queued");
    expect(repository.lastCreatedInput!.preview.rows[0]).toMatchObject({ previewStatus: "warning", warnings: ["price_below_product_cost"] });
  });

  it("does not warn at or above the .ops cost", async () => {
    productCosts.set(101, availableCost(1199));
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0]).toMatchObject({ priceCents: 1199, previewStatus: "ready", warnings: [] });
  });

  it("takes the cost of a rule-priced listing from its rule price without a second read", async () => {
    repository.rulePrices.set(101, { ...rulePrice(), priceCents: 700 });
    const reads: number[][] = [];
    productCostReader = { loadProductCosts: async ({ productVariantIds }) => { reads.push([...productVariantIds]); return new Map(); } };
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0]).toMatchObject({ priceCents: 700, previewStatus: "warning", warnings: ["price_below_product_cost"] });
    expect(reads).toEqual([]);
  });

  it("skips the below-cost check and logs it when the cost source is down", async () => {
    productCostReader = { loadProductCosts: async () => { throw new DropshipError("DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE", "Cost source down."); } };
    const preview = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101] });
    expect(preview.rows[0]).toMatchObject({ priceCents: 1199, previewStatus: "ready", warnings: [] });
    expect(logs.find((event) => event.code === "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE")).toMatchObject({
      context: { vendorId: 10, storeConnectionId: 22, productVariantIds: [101], errorCode: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE" },
    });
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

  describe("vendor eBay category rules", () => {
    function useEbayStoreWithRule() {
      repository.context = { ...repository.context, platform: "ebay" };
      repository.config = { ...repository.config!, platform: "ebay", marketplaceConfig: { profileId: "profile-1" } };
      const prepared = prepareEbayCategoryRules(3, rulesProfile({ rules: [{
        id: "rule-1", name: "My toploaders", scope: { type: "product", productId: repository.candidate.productId }, category: TOPLOADERS,
      }] }));
      repository.loadEbayCategories = async ({ candidates }) => new Map(candidates.map((candidate) =>
        [candidate.productVariantId, resolveEbayListingCategory(candidate, prepared)]));
      return resolveEbayListingCategory(repository.candidate, prepared);
    }

    it("publishes the vendor's rule category and says where it came from", async () => {
      useEbayStoreWithRule();

      const result = await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101], requestedRetailPriceCents: 1299 });

      expect(result.rows[0]).toMatchObject({
        previewStatus: "ready",
        marketplaceCategoryId: TOPLOADERS.categoryId,
        marketplaceCategoryName: "Toploaders",
        marketplaceCategorySource: "rule",
        marketplaceCategoryRuleName: "My toploaders",
      });
      expect(result.rows[0].marketplaceCategoryFallback).toBeUndefined();
      expect(result.rows[0].listingIntent).toMatchObject({ marketplaceCategoryId: TOPLOADERS.categoryId, marketplaceCategoryName: "Toploaders" });
      expect(repository.candidate.ebayBrowseCategoryId).toBe("183438");
      expect(toDropshipVendorListingPreview(result).rows[0]).toMatchObject({
        marketplaceCategorySource: "rule", marketplaceCategoryRuleName: "My toploaders",
      });
    });

    it("never refuses a queue because the category changed; it queues the category the rules name now", async () => {
      useEbayStoreWithRule();
      const request = { storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "category-queue", requestedRetailPriceCents: 1299 };

      await service.createListingPushJobForMember("member-1", request);

      expect(repository.jobs).toHaveLength(1);
      expect(repository.lastCreatedInput?.preview.rows[0].listingIntent?.marketplaceCategoryId).toBe(TOPLOADERS.categoryId);
      // The category evidence map is gone from the push contract, so an old client's map is refused as unknown input.
      await expect(service.createListingPushJobForMember("member-1", { ...request, idempotencyKey: "category-queue-2",
        expectedMarketplaceCategoryEvidenceHashesByVariantId: { "101": "b".repeat(64) } })).rejects.toBeInstanceOf(ZodError);
    });

    it("queues in one step with the category the rules choose now", async () => {
      useEbayStoreWithRule();

      const result = await service.createListingPushJobForMember("member-1", {
        storeConnectionId: 22, productVariantIds: [101], idempotencyKey: "category-one-step", reviewMode: "current_preview", requestedRetailPriceCents: 1299,
      });

      expect(result.job.status).toBe("queued");
      expect(repository.lastCreatedInput?.preview.rows[0]).toMatchObject({ marketplaceCategoryId: TOPLOADERS.categoryId, marketplaceCategorySource: "rule" });
    });

    describe("at push time", () => {
      const queued = { "101": { categoryId: "900200", categoryName: "Queued category" } };
      const system = { actorType: "system" as const, actorId: "listing-push-worker" };
      function useEbayStoreWithNoCategory() {
        repository.context = { ...repository.context, platform: "ebay" };
        repository.config = { ...repository.config!, platform: "ebay", marketplaceConfig: { profileId: "profile-1" } };
        repository.candidate = { ...repository.candidate, ebayBrowseCategoryId: null, ebayBrowseCategoryName: null };
        const prepared = prepareEbayCategoryRules(4, null);
        repository.loadEbayCategories = async ({ candidates }) => new Map(candidates.map((candidate) =>
          [candidate.productVariantId, resolveEbayListingCategory(candidate, prepared)]));
      }

      it("keeps the queued category when the rules now give none, instead of failing", async () => {
        useEbayStoreWithNoCategory();

        const withoutQueued = await service.generatePreview({ vendorId: 10, storeConnectionId: 22, productVariantIds: [101], actor: system });
        expect(withoutQueued.rows[0]).toMatchObject({ previewStatus: "blocked", blockers: expect.arrayContaining(["ebay_browse_category_required"]) });

        const result = await service.generatePreview({ vendorId: 10, storeConnectionId: 22, productVariantIds: [101], actor: system,
          queuedEbayCategoriesByVariantId: queued });
        expect(result.rows[0]).toMatchObject({
          marketplaceCategoryId: "900200", marketplaceCategoryName: "Queued category",
          marketplaceCategorySource: "none", marketplaceCategoryFallback: "queued",
        });
        expect(result.rows[0].blockers).not.toContain("ebay_browse_category_required");
        expect(result.rows[0].listingIntent).toMatchObject({ marketplaceCategoryId: "900200", marketplaceCategoryName: "Queued category" });
      });

      it("publishes the queued category through the push-time refresh, end to end", async () => {
        useEbayStoreWithNoCategory();
        const info = vi.fn();

        const intent = await refreshQueuedListingIntent({
          generatePreview: (input) => service.generatePreview(input),
          resolveCostChangePolicy: async () => ({ policyId: null, settings: DEFAULT_DROPSHIP_COST_CHANGE_POLICY }),
          logger: { info, warn: vi.fn(), error: vi.fn() },
        }, { jobId: 30, jobItemId: 1, vendorId: 10, storeConnectionId: 22, productVariantId: 101, queuedPriceCents: 1299,
          queuedMarketplaceCategory: queued["101"] });

        expect(intent).toMatchObject({ marketplaceCategoryId: "900200", marketplaceCategoryName: "Queued category" });
        expect(info).toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_LISTING_PUSH_QUEUED_CATEGORY_KEPT" }));
      });

      it("prefers the category the rules name now over the queued one", async () => {
        useEbayStoreWithRule();

        const result = await service.generatePreview({ vendorId: 10, storeConnectionId: 22, productVariantIds: [101], actor: system,
          queuedEbayCategoriesByVariantId: queued });

        expect(result.rows[0].listingIntent).toMatchObject({ marketplaceCategoryId: TOPLOADERS.categoryId });
        expect(result.rows[0].marketplaceCategoryFallback).toBeUndefined();
      });

      it("is never accepted from a vendor", async () => {
        useEbayStoreWithNoCategory();

        await expect(service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101], requestedRetailPriceCents: 1299,
          queuedEbayCategoriesByVariantId: queued })).rejects.toBeInstanceOf(ZodError);
      });
    });

    it("never resolves categories for a store that is not eBay", async () => {
      const loader = vi.fn(async () => new Map());
      repository.loadEbayCategories = loader;

      await service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101], requestedRetailPriceCents: 1299 });

      expect(loader).not.toHaveBeenCalled();
    });

    it("refuses an incomplete category result instead of publishing the catalog fallback", async () => {
      useEbayStoreWithRule();
      repository.loadEbayCategories = async () => new Map();

      await expect(service.previewForMember("member-1", { storeConnectionId: 22, productVariantIds: [101], requestedRetailPriceCents: 1299 }))
        .rejects.toThrow("incomplete catalog result");
    });
  });

  it("warns, without blocking, when the catalog has no MPN for an eBay listing", async () => {
    repository.context = { ...repository.context, platform: "ebay" };
    repository.config = { ...repository.config!, platform: "ebay", marketplaceConfig: { profileId: "profile-1" } };
    repository.candidate = { ...repository.candidate, mpn: null };

    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(result.rows[0]).toMatchObject({
      previewStatus: "warning",
      blockers: [],
      warnings: expect.arrayContaining(["ebay_mpn_placeholder"]),
    });
    expect(result.rows[0]?.listingIntent).toMatchObject({ mpn: null });
  });

  it("does not warn about the MPN on a store that is not eBay", async () => {
    repository.candidate = { ...repository.candidate, mpn: null };

    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(result.rows[0]?.warnings).not.toContain("ebay_mpn_placeholder");
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

  describe("live eBay return and payment policy check (S1)", () => {
    function ebayStoreWithPolicies(businessPolicies: Record<string, string>, marketplaceId: string | null = "EBAY_US") {
      repository.context = { ...repository.context, platform: "ebay" };
      repository.config = {
        ...repository.config!,
        platform: "ebay",
        marketplaceConfig: {
          profileId: "profile-1",
          ...(marketplaceId ? { marketplaceId } : {}),
          businessPolicies: { fulfillmentPolicyId: "fulfillment-policy", ...businessPolicies },
        },
      };
    }
    const preview = () => service.previewForMember("member-1", {
      storeConnectionId: 22, productVariantIds: [101], requestedRetailPriceCents: 1299,
    });
    const policyBlockers = (blockers: readonly string[]) => blockers.filter((blocker) => (
      blocker.startsWith("ebay_return_policy:") || blocker.startsWith("ebay_payment_policy:")
    ));

    it("checks the store's policy ids once for the preview and passes a listing whose policies exist", async () => {
      ebayStoreWithPolicies({ returnPolicyId: "return-default", paymentPolicyId: "payment-default" });

      const result = await preview();

      expect(checkedReturnPaymentPolicies).toEqual([{
        vendorId: repository.context.vendorId,
        storeConnectionId: 22,
        marketplaceId: "EBAY_US",
        returnPolicyIds: ["return-default"],
        paymentPolicyIds: ["payment-default"],
      }]);
      expect(result.rows[0].previewStatus).toBe("ready");
      expect(policyBlockers(result.rows[0].blockers)).toEqual([]);
    });

    it("blocks a listing whose return or payment policy is no longer on eBay", async () => {
      ebayStoreWithPolicies({ returnPolicyId: "return-default", paymentPolicyId: "payment-default" });
      goneReturnPolicyIds = new Set(["return-default"]);
      gonePaymentPolicyIds = new Set(["payment-default"]);

      const result = await preview();

      expect(result.rows[0].previewStatus).toBe("blocked");
      expect(policyBlockers(result.rows[0].blockers)).toEqual([
        "ebay_return_policy:not_found",
        "ebay_payment_policy:not_found",
      ]);
    });

    it("checks a listing's own policy ids with the defaults, and judges the listing by the ids it sends", async () => {
      ebayStoreWithPolicies({ returnPolicyId: "return-default", paymentPolicyId: "payment-default" });
      repository.listingPolicyOverrides = [{
        productVariantId: 101, revisionId: 3, fulfillmentPolicyId: null,
        returnPolicyId: "return-override", paymentPolicyId: null, updatedAt: now,
      }];
      goneReturnPolicyIds = new Set(["return-default"]);

      const unaffected = await preview();
      expect(checkedReturnPaymentPolicies[0]).toMatchObject({
        returnPolicyIds: ["return-default", "return-override"],
        paymentPolicyIds: ["payment-default"],
      });
      expect(policyBlockers(unaffected.rows[0].blockers)).toEqual([]);

      goneReturnPolicyIds = new Set(["return-override"]);
      const blocked = await preview();
      expect(policyBlockers(blocked.rows[0].blockers)).toEqual(["ebay_return_policy:not_found"]);
    });

    it("blocks the listing as unverified and logs a WARN when eBay can't be read", async () => {
      ebayStoreWithPolicies({ returnPolicyId: "return-default", paymentPolicyId: "payment-default" });
      returnPaymentPolicyCheckFailure = new DropshipError(
        "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", "eBay did not answer.", { retryable: true },
      );

      const result = await preview();

      expect(result.rows[0].previewStatus).toBe("blocked");
      expect(policyBlockers(result.rows[0].blockers)).toEqual([
        "ebay_return_policy:verification_unavailable",
        "ebay_payment_policy:verification_unavailable",
      ]);
      expect(logs).toContainEqual(expect.objectContaining({
        code: "DROPSHIP_EBAY_RETURN_PAYMENT_POLICY_CHECK_UNAVAILABLE",
        context: expect.objectContaining({
          storeConnectionId: 22,
          returnPolicyIds: ["return-default"],
          paymentPolicyIds: ["payment-default"],
          errorCode: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
        }),
      }));
    });

    it("fails the preview on an unexpected error instead of hiding it", async () => {
      ebayStoreWithPolicies({ returnPolicyId: "return-default", paymentPolicyId: "payment-default" });
      returnPaymentPolicyCheckFailure = new Error("database connection lost");

      await expect(preview()).rejects.toThrow("database connection lost");
    });

    it("does not call eBay without a marketplace or without any id to check", async () => {
      ebayStoreWithPolicies({ returnPolicyId: "return-default", paymentPolicyId: "payment-default" }, null);
      await preview();
      ebayStoreWithPolicies({});
      const noIds = await preview();

      expect(checkedReturnPaymentPolicies).toEqual([]);
      // A missing id is the listing config check's to report (missing_config:…), not this one's.
      expect(policyBlockers(noIds.rows[0].blockers)).toEqual([]);
    });

    it("never checks a store that is not on eBay", async () => {
      await preview();

      expect(repository.context.platform).not.toBe("ebay");
      expect(checkedReturnPaymentPolicies).toEqual([]);
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
      message: expect.stringContaining("Update your payment at Card Shellz"),
      context: {
        vendorId: 10,
        entitlementStatus: "grace",
        action: "preview",
        resolution: "update_membership_payment",
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
      message: expect.stringContaining("Finish it on the Onboarding page"),
      context: {
        storeConnectionId: 22,
        setupStatus: "pending",
        storeLaunchReady: false,
        resolution: "finish_store_setup",
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
      message: expect.stringContaining("Finish the steps on the Onboarding page and choose Activate .ops."),
      context: {
        vendorId: 10,
        vendorStatus: "onboarding",
        action: "push",
        resolution: "activate_account",
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

  describe("display-only eBay settings in the store's listing config (PR 6)", () => {
    const listingKeys = {
      profileId: "profile-1",
      marketplaceId: "EBAY_US",
      merchantLocationKey: "cardshellz-dropship-22",
      businessPolicies: {
        fulfillmentPolicyId: "fulfillment-policy",
        returnPolicyId: "return-default",
        paymentPolicyId: "payment-default",
      },
    };
    const shelfDefault = { ids: ["101"], names: ["Toploaders"] };
    function ebayStore(extra: Record<string, unknown>) {
      repository.context = { ...repository.context, platform: "ebay" };
      repository.config = {
        ...repository.config!,
        platform: "ebay",
        marketplaceConfig: { ...structuredClone(listingKeys), ...extra },
      };
    }
    const preview = () => service.previewForMember("member-1", {
      storeConnectionId: 22, productVariantIds: [101], requestedRetailPriceCents: 1299,
    });

    /** Names as the setup save stores them: keyed by policy field, each with the id it names. */
    function storedNames(overrides: Record<string, { id: string; name: string }> = {}) {
      return {
        fulfillmentPolicyId: { id: "fulfillment-policy", name: "Free shipping" },
        returnPolicyId: { id: "return-default", name: "30 day returns" },
        paymentPolicyId: { id: "payment-default", name: "Immediate payment" },
        ...overrides,
      };
    }

    it("keeps policy names and the shelf default out of the listing intent, so an eBay rename leaves the preview as it was", async () => {
      ebayStore({ businessPolicyNames: storedNames(), storeShelfDefault: shelfDefault });
      const named = await preview();
      expect(named.rows[0].previewStatus).toBe("ready");
      expect(named.rows[0].listingIntent?.marketplaceConfig).toEqual(listingKeys);

      ebayStore({
        businessPolicyNames: storedNames({ fulfillmentPolicyId: { id: "fulfillment-policy", name: "Free shipping (renamed)" } }),
        storeShelfDefault: shelfDefault,
      });
      const renamed = await preview();
      ebayStore({ storeShelfDefault: shelfDefault });
      const unnamed = await preview();

      expect(renamed.rows[0].listingIntent?.marketplaceConfig).toEqual(listingKeys);
      expect(renamed.rows[0].previewHash).toBe(named.rows[0].previewHash);
      expect(unnamed.rows[0].previewHash).toBe(named.rows[0].previewHash);
      // The repository's stored config still has both keys.
      expect(repository.config?.marketplaceConfig).toHaveProperty("storeShelfDefault", shelfDefault);
    });

    it("leaves the preview as it was when a stored name is left over from another policy id", async () => {
      // A staff writer can change a policy id without touching the names; the
      // stale entry is display-only and must not reach the listing or its hash.
      ebayStore({ businessPolicyNames: storedNames() });
      const current = await preview();
      ebayStore({
        businessPolicyNames: storedNames({ fulfillmentPolicyId: { id: "fulfillment-old", name: "Old shipping" } }),
      });
      const stale = await preview();

      expect(stale.rows[0].listingIntent?.marketplaceConfig).toEqual(listingKeys);
      expect(stale.rows[0].listingIntent?.marketplaceConfig).not.toHaveProperty("businessPolicyNames");
      expect(stale.rows[0].previewHash).toBe(current.rows[0].previewHash);
    });

    it("leaves the preview as it was when the shelf default changes or is removed", async () => {
      ebayStore({ businessPolicyNames: storedNames(), storeShelfDefault: shelfDefault });
      const first = await preview();
      ebayStore({
        businessPolicyNames: storedNames(),
        storeShelfDefault: { ids: ["202", "101"], names: ["Supplies > Sleeves", "Toploaders"] },
      });
      const changed = await preview();
      ebayStore({ businessPolicyNames: storedNames() });
      const removed = await preview();

      for (const result of [changed, removed]) {
        expect(result.rows[0].listingIntent?.marketplaceConfig).toEqual(listingKeys);
        expect(result.rows[0].listingIntent?.marketplaceConfig).not.toHaveProperty("storeShelfDefault");
        expect(result.rows[0].previewHash).toBe(first.rows[0].previewHash);
      }
    });

    it("still changes the preview when a key the listing does use changes", async () => {
      ebayStore({ businessPolicyNames: storedNames() });
      const before = await preview();
      ebayStore({ businessPolicyNames: storedNames(), merchantLocationKey: "another-location" });
      const after = await preview();

      expect(after.rows[0].listingIntent?.marketplaceConfig).toMatchObject({ merchantLocationKey: "another-location" });
      expect(after.rows[0].previewHash).not.toBe(before.rows[0].previewHash);
    });
  });
});

describe("ConfigDrivenDropshipMarketplaceListingProvider", () => {
  const provider = new ConfigDrivenDropshipMarketplaceListingProvider();
  const listingKeys = {
    marketplaceId: "EBAY_US",
    merchantLocationKey: "cardshellz-dropship-22",
    businessPolicies: {
      fulfillmentPolicyId: "fulfillment-1",
      returnPolicyId: "return-1",
      paymentPolicyId: "payment-1",
    },
    profileId: "profile-1",
  };

  function ebayConfig(marketplaceConfig: Record<string, unknown>): DropshipStoreListingConfig {
    return {
      id: 7,
      storeConnectionId: 22,
      platform: "ebay",
      listingMode: "live",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfig,
      requiredConfigKeys: ["marketplaceId"],
      requiredProductFields: [],
      isActive: true,
    };
  }

  function listingContent(): DropshipCanonicalListingContent {
    const candidate = makeCandidate();
    return {
      productId: candidate.productId,
      productVariantId: candidate.productVariantId,
      sku: candidate.sku,
      productName: candidate.productName,
      variantName: candidate.variantName,
      title: candidate.title,
      description: candidate.description,
      category: candidate.category,
      ebayBrowseCategoryId: candidate.ebayBrowseCategoryId,
      ebayBrowseCategoryName: candidate.ebayBrowseCategoryName,
      brand: candidate.brand,
      gtin: candidate.gtin,
      mpn: candidate.mpn,
      condition: candidate.condition,
      itemSpecifics: candidate.itemSpecifics,
      imageUrls: candidate.imageUrls,
      weightGrams: candidate.weightGrams,
    };
  }

  function build(config: DropshipStoreListingConfig) {
    return provider.buildListingIntent({
      config,
      content: listingContent(),
      priceCents: 1299,
      quantity: 4,
      storeCategoryNames: ["Toploaders"],
    });
  }

  it("builds the intent's marketplace config without the policy names and the shelf default, keeping every other key", () => {
    const result = build(ebayConfig({
      ...structuredClone(listingKeys),
      businessPolicyNames: {
        fulfillmentPolicyId: { id: "fulfillment-1", name: "Free shipping" },
        returnPolicyId: { id: "return-1", name: "30 day returns" },
      },
      storeShelfDefault: { ids: ["101", "202"], names: ["Toploaders", "Sleeves"] },
    }));

    expect(result.blockers).toEqual([]);
    expect(result.intent?.marketplaceConfig).toEqual(listingKeys);
    // The listing's own shelves still reach the intent, as storeCategoryNames.
    expect(result.intent?.storeCategoryNames).toEqual(["Toploaders"]);
  });

  it("does not change the store's config while building the intent", () => {
    const marketplaceConfig = Object.freeze({
      ...structuredClone(listingKeys),
      businessPolicyNames: Object.freeze({
        fulfillmentPolicyId: Object.freeze({ id: "fulfillment-1", name: "Free shipping" }),
      }),
      storeShelfDefault: Object.freeze({ ids: Object.freeze(["101"]), names: Object.freeze(["Toploaders"]) }),
    });
    const config = Object.freeze(ebayConfig(marketplaceConfig));
    const before = structuredClone(config);

    const result = build(config);

    expect(config).toEqual(before);
    expect(config.marketplaceConfig).toHaveProperty("businessPolicyNames");
    expect(config.marketplaceConfig).toHaveProperty("storeShelfDefault");
    expect(result.intent?.marketplaceConfig).not.toBe(config.marketplaceConfig);
    expect(result.intent?.marketplaceConfig).toEqual(listingKeys);
  });

  it("gives the same intent whatever names or shelf default are stored", () => {
    const plain = build(ebayConfig(structuredClone(listingKeys)));
    const named = build(ebayConfig({
      ...structuredClone(listingKeys),
      businessPolicyNames: { paymentPolicyId: { id: "payment-1", name: "Immediate payment" } },
      storeShelfDefault: { ids: ["101"], names: ["Toploaders"] },
    }));

    expect(JSON.stringify(named.intent)).toBe(JSON.stringify(plain.intent));
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
  async getVariantAtp() {
    return { authority: "legacy" as const, quantities: new Map([[101, 4]]) };
  }
}

class FakeListingPreviewRepository implements DropshipListingPreviewRepository {
  loadListingContents?: DropshipListingPreviewRepository["loadListingContents"];
  loadEbayCategories?: DropshipListingPreviewRepository["loadEbayCategories"];
  rulePrices = new Map<number, ListingRulePrice>();
  ruleCandidateIds: number[] = [];
  async loadRulePrices(input: { candidates: readonly DropshipListingCatalogCandidate[] }): Promise<Map<number, ListingRulePrice>> {
    this.ruleCandidateIds = input.candidates.map((row) => row.productVariantId);
    return new Map([...this.rulePrices].filter(([id]) => this.ruleCandidateIds.includes(id)));
  }
  savedPrices: SavedListingPriceRevision[] = [];
  existingListings: DropshipExistingVendorListing[] = [];
  pricingPolicies: DropshipPricingPolicyRecord[] = [];
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
    return this.pricingPolicies;
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

function availableCost(unitCostCents: number): DropshipProductCost {
  return { status: "available", unitCostCents, planId: "ops", source: "variant_fixed_price", overrideId: "fixed", issue: null, retailPriceCents: null, discountBps: null };
}
function rulePrice(): ListingRulePrice {
  return { priceCents: 1152, ruleName: "Store default rule", ruleId: null, issue: null, profileRevisionId: 1,
    evidenceHash: "a".repeat(64), productCost: { status: "available", unitCostCents: 809, planId: "ops", source: "variant_fixed_price", overrideId: "fixed", issue: null, retailPriceCents: null, discountBps: null } };
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
    variantUomType: "pack",
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
    standingReason: null,
    pausedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function allTiersOnSale(): DropshipListingTierEligibility {
  return {
    pack: {
      tier: "pack", eligible: true, reason: null, policyMinimumCents: 10_000, minimumCents: 10_000, alreadyOn: true,
      reserveShortfallCents: 0, balanceShortfallCents: 0, upcoming: null,
    },
    case: {
      tier: "case", eligible: true, reason: null, policyMinimumCents: 50_000, minimumCents: 50_000, alreadyOn: true,
      reserveShortfallCents: 0, balanceShortfallCents: 0, upcoming: null,
    },
  };
}

/** A $500 reserve with $120 in the wallet, never on: the case tier waits for the balance. */
function caseTierOffSale(): DropshipListingTierEligibility["case"] {
  return {
    tier: "case", eligible: false, reason: "balance_below_tier", policyMinimumCents: 50_000, minimumCents: 50_000, alreadyOn: false,
    reserveShortfallCents: 0, balanceShortfallCents: 38_000, upcoming: null,
  };
}
