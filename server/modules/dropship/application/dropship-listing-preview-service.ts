import { EBAY_LISTING_MAX_PHOTOS } from "../../channels/ebay-listing-photos.domain";
import { createHash } from "crypto";
import { listingPriceFollowsRules, resolveListingPrice, type SavedListingPriceRevision } from "../../../../shared/dropship/listing-price";
import { decideDropshipListingAccess } from "../../../../shared/dropship/listing-access";
import type { ListingRulePrice } from "./dropship-rule-price";
import type { ResolvedEbayListingCategory } from "./dropship-ebay-category-resolver";
import type { EbayCategorySource } from "../../../../shared/dropship/ebay-category-rules";
import { z } from "zod";
import type { DropshipListingPresentation, DropshipListingEconomics } from "../../../../shared/dropship/listing-presentation";
import type { CatalogImageFile } from "../../catalog/catalog-media.reader";
import type {
  CatalogVariantPublicationPhotoReader,
  CatalogVariantPublicationPhotos,
} from "../../catalog/catalog-publication-images.reader";
import { enrichDropshipListingRows, type DropshipListingPresentationDependencies } from "./dropship-listing-presentation";
import type {
  DropshipSourcePlatform,
  DropshipStoreConnectionStatus,
  DropshipVendorStatus,
} from "../../../../shared/schema/dropship.schema";
import {
  evaluateDropshipCatalogExposure,
  type DropshipCatalogExposureDecision,
  type DropshipCatalogExposureRule,
  type DropshipCatalogVariantCandidate,
} from "../domain/catalog-exposure";
import { DropshipError } from "../domain/errors";
import { evaluateListingPriceAgainstCost } from "../domain/listing-price-cost";
import { listingPhotoLeftOutReason } from "../domain/listing-photo-reasons";
import {
  listingTierForVariantUomType,
  type DropshipListingTierEligibility,
  type DropshipListingTierStatus,
} from "../domain/listing-tiers";
import {
  evaluateDropshipVendorCatalogSelection,
  type DropshipVendorCatalogSelectionDecision,
  type DropshipVendorSelectionRule,
  type DropshipVendorVariantOverride,
} from "../domain/vendor-selection";
import type {
  DropshipCanonicalListingContent,
  DropshipMarketplaceListingIntent,
  DropshipMarketplaceListingProvider,
  DropshipStoreListingConfig,
} from "./dropship-marketplace-listing-provider";
import type { DropshipAtpProvider } from "./dropship-selection-atp-service";
import type { DropshipProductCost, DropshipProductCostReader } from "./dropship-product-cost";
import {
  createListingPushJobForMemberInputSchema,
  generateVendorListingPreviewForMemberInputSchema,
} from "./dropship-listing-dtos";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type {
  DropshipVendorProvisioningService,
} from "./dropship-vendor-provisioning-service";
import type {
  DropshipEbayFulfillmentPolicyGuard,
  DropshipEbayFulfillmentPolicyPreflight,
} from "./dropship-ebay-fulfillment-policy-guard";
import type {
  DropshipEbayListingPolicyOverride,
} from "./dropship-ebay-listing-policy-override-service";
import type { DropshipEbayReturnPaymentPolicyChecker } from "./dropship-ebay-return-payment-policy-check";
import {
  ebayReturnPaymentPolicyBlockers,
  type DropshipEbayReturnPaymentPolicyCheck,
} from "../domain/ebay-return-payment-policy-blockers";
import {
  createListingPushJobInputSchema,
  type ListingPushReviewMode,
  generateVendorListingPreviewInputSchema,
  type CreateListingPushJobInput,
  type GenerateVendorListingPreviewInput,
  type QueuedEbayCategory,
} from "./dropship-use-case-dtos";

/**
 * Shopify's existing photo limit. eBay uses EBAY_LISTING_MAX_PHOTOS from
 * the shared eBay photo contract. Both limits bound uploaded-file hashing.
 */
export const DROPSHIP_LISTING_MAX_PHOTOS = 20;

/** Uploaded photos that cannot be published are named in one log line, up to this many. */
const MAX_LOGGED_UNPUBLISHABLE_PHOTOS = 100;

const NOT_CHECKED_RETURN_PAYMENT_POLICIES: DropshipEbayReturnPaymentPolicyCheck = { status: "not_checked" };

export interface DropshipListingStoreContext {
  vendorId: number;
  vendorStatus: DropshipVendorStatus;
  entitlementStatus: string;
  storeConnectionId: number;
  storeStatus: DropshipStoreConnectionStatus;
  setupStatus: string;
  platform: DropshipSourcePlatform;
  storeLaunchReady: boolean;
}

export interface DropshipListingCatalogCandidate extends DropshipCatalogVariantCandidate, DropshipCanonicalListingContent {
  unitsPerVariant: number;
  /** Unmodified catalog value for advisory validation; do not change existing quantity semantics. */
  catalogUnitsPerVariant?: number | null;
  defaultRetailPriceCents: number | null;
}

export interface DropshipListingPackageReadiness {
  hasCatalogPackageData: boolean;
  hasActiveBox: boolean;
  hasActiveRateTable: boolean;
}

export interface DropshipExistingVendorListing {
  listingId: number;
  productVariantId: number;
  status: string;
  vendorRetailPriceCents: number | null;
  quantityCap: number | null;
  externalListingId: string | null;
}

export interface DropshipPricingPolicyRecord {
  id: number;
  scopeType: "catalog" | "product_line" | "category" | "product" | "variant";
  productLineId: number | null;
  productId: number | null;
  productVariantId: number | null;
  category: string | null;
  mode: "off" | "warn_only" | "block_listing_push" | "block_order_acceptance";
  floorPriceCents: number | null;
  ceilingPriceCents: number | null;
}

export interface DropshipListingPreviewRow {
  contentEvidenceHash?: string;
  /** eBay rows: whether a vendor rule, the store default or the Card Shellz catalog chose the category. */
  marketplaceCategorySource?: EbayCategorySource;
  marketplaceCategoryRuleName?: string | null;
  /**
   * Push time only: the rules give this listing no category now, so the one it was
   * queued with is published instead (a changed category never fails a push).
   */
  marketplaceCategoryFallback?: "queued";
  rulePriceEvidenceHash?: string | null;
  pricingRuleName?: string | null;
  /**
   * Present (true) only when the size is saved as "follow the store's
   * pricing" (`inherit`). Its price belongs to the rules even while it falls
   * back to the retail price, so the push-time review gate treats it as
   * rule priced. Not part of the preview hash: the saved revision id is.
   */
  followsStorePricing?: true;
  /** Local setting revision used to reject stale queue creation. */
  priceSettingRevisionId?: number | null;
  presentation?: DropshipListingPresentation;
  economics?: DropshipListingEconomics;
  productVariantId: number;
  productId: number;
  sku: string | null;
  title: string;
  platform: DropshipSourcePlatform;
  listingMode: string | null;
  currentListingStatus: string;
  previewStatus: "ready" | "blocked" | "warning";
  blockers: string[];
  warnings: string[];
  marketplaceQuantity: number;
  priceCents: number | null;
  marketplaceCategoryId: string | null;
  marketplaceCategoryName: string | null;
  storeCategoryNames: string[];
  businessPolicySelection: {
    fulfillmentPolicyId: string | null;
    returnPolicyId: string | null;
    paymentPolicyId: string | null;
    overriddenFields: Array<"fulfillmentPolicyId" | "returnPolicyId" | "paymentPolicyId">;
  } | null;
  previewHash: string;
  adminExposureDecision: DropshipCatalogExposureDecision;
  selectionDecision: DropshipVendorCatalogSelectionDecision;
  /**
   * The listing tier this SKU sells in and whether that tier is on sale for
   * the vendor. Off sale blocks a new listing and zeroes the quantity of an
   * existing one; null only when the catalog variant could not be found.
   */
  listingTier: DropshipListingTierStatus | null;
  listingIntent: DropshipMarketplaceListingIntent | null;
}

export interface DropshipListingPreviewResult {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  generatedAt: Date;
  rows: DropshipListingPreviewRow[];
  summary: {
    total: number;
    ready: number;
    blocked: number;
    warning: number;
  };
}

export interface DropshipListingPushJobRecord {
  jobId: number;
  vendorId: number;
  storeConnectionId: number;
  status: string;
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipListingPushJobItemRecord {
  itemId: number;
  jobId: number;
  listingId: number | null;
  productVariantId: number;
  status: string;
  previewHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface CreateDropshipListingPushJobRepositoryInput {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  productVariantIds: number[];
  requestedRetailPricesByVariantId: Record<string, number>;
  idempotencyKey: string;
  requestHash: string;
  requestedBy: CreateListingPushJobInput["requestedBy"];
  preview: DropshipListingPreviewResult;
  now: Date;
}

export interface CreateDropshipListingPushJobRepositoryResult {
  job: DropshipListingPushJobRecord;
  items: DropshipListingPushJobItemRecord[];
  idempotentReplay: boolean;
}

export interface DropshipListingPreviewRepository {
  loadListingContents?(input: { vendorId: number; storeConnectionId: number; candidates: readonly DropshipListingCatalogCandidate[] }): Promise<Map<number, import("../../../../shared/dropship/listing-content").ResolvedListingContent>>;
  loadEbayCategories?(input: { vendorId: number; storeConnectionId: number; candidates: readonly DropshipListingCatalogCandidate[] }): Promise<Map<number, ResolvedEbayListingCategory>>;
  loadRulePrices?(input: { vendorId: number; storeConnectionId: number; candidates: readonly DropshipListingCatalogCandidate[] }): Promise<Map<number, ListingRulePrice>>;
  listSavedListingPrices(input: {
    vendorId: number; storeConnectionId: number; productVariantIds: readonly number[];
  }): Promise<SavedListingPriceRevision[]>;
  findVendorIdByMemberId?(memberId: string): Promise<number | null>;
  loadStoreContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipListingStoreContext | null>;
  getStoreListingConfig(storeConnectionId: number): Promise<DropshipStoreListingConfig | null>;
  listCatalogExposureRules(): Promise<DropshipCatalogExposureRule[]>;
  listSelectionRules(vendorId: number): Promise<DropshipVendorSelectionRule[]>;
  listCatalogCandidates(productVariantIds: readonly number[]): Promise<DropshipListingCatalogCandidate[]>;
  listVariantOverrides(input: {
    vendorId: number;
    productVariantIds: readonly number[];
  }): Promise<DropshipVendorVariantOverride[]>;
  listExistingListings(input: {
    storeConnectionId: number;
    productVariantIds: readonly number[];
  }): Promise<DropshipExistingVendorListing[]>;
  listPricingPolicies(): Promise<DropshipPricingPolicyRecord[]>;
  listEbayStoreCategoryAssignments(input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantIds: readonly number[];
  }): Promise<Array<{ productVariantId: number; storeCategoryNames: string[] }>>;
  listEbayListingPolicyOverrides(input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantIds: readonly number[];
  }): Promise<DropshipEbayListingPolicyOverride[]>;
  getPackageReadiness(productVariantIds: readonly number[]): Promise<Map<number, DropshipListingPackageReadiness>>;
  createListingPushJob(
    input: CreateDropshipListingPushJobRepositoryInput,
  ): Promise<CreateDropshipListingPushJobRepositoryResult>;
}

export interface DropshipListingPreviewServiceDependencies {
  presentation?: DropshipListingPresentationDependencies;
  /**
   * Required Catalog publication photos, uploaded files included.
   * Candidate metadata never supplies a second photo-selection path.
   */
  listingPhotos: CatalogVariantPublicationPhotoReader;
  /**
   * Cost of one sellable pack, for the below-cost warning. Falls back to the
   * presentation reader; with neither, the preview never warns about cost.
   */
  productCosts?: DropshipProductCostReader;
  vendorProvisioning: DropshipVendorProvisioningService;
  repository: DropshipListingPreviewRepository;
  atp: DropshipAtpProvider;
  marketplaceListing: DropshipMarketplaceListingProvider;
  ebayFulfillmentPolicyGuard: DropshipEbayFulfillmentPolicyGuard;
  /** Whether the return and payment policy ids a listing sends still exist on eBay (S1). */
  ebayReturnPaymentPolicies: DropshipEbayReturnPaymentPolicyChecker;
  /** Which of the vendor's listing tiers are on sale (wallet policy + wallet facts). */
  listingTiers: DropshipListingTierGateReader;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export interface DropshipListingTierGateReader {
  resolveForVendor(vendorId: number): Promise<{ eligibility: DropshipListingTierEligibility }>;
}

export class DropshipListingPreviewService {
  constructor(private readonly deps: DropshipListingPreviewServiceDependencies) {}

  async imageForMember(memberId: string, input: unknown): Promise<CatalogImageFile> {
    const parsed = z.object({
      storeConnectionId: z.number().int().positive().safe(),
      productVariantId: z.number().int().positive().safe(),
      assetId: z.number().int().positive().safe(),
    }).strict().parse(input);
    const vendorId = await this.deps.repository.findVendorIdByMemberId?.(memberId);
    if (!vendorId || !this.deps.presentation) {
      throw new DropshipError("DROPSHIP_LISTING_IMAGE_NOT_FOUND", "Listing image is unavailable.");
    }
    await this.loadStoreContextForAction(vendorId, parsed.storeConnectionId, "preview");
    const [candidates, adminRules, selectionRules, overrides] = await Promise.all([
      this.deps.repository.listCatalogCandidates([parsed.productVariantId]),
      this.deps.repository.listCatalogExposureRules(),
      this.deps.repository.listSelectionRules(vendorId),
      this.deps.repository.listVariantOverrides({ vendorId, productVariantIds: [parsed.productVariantId] }),
    ]);
    const candidate = candidates.find((row) => row.productVariantId === parsed.productVariantId);
    if (!candidate) throw new DropshipError("DROPSHIP_LISTING_IMAGE_NOT_FOUND", "Listing image is unavailable.");
    const exposure = evaluateDropshipCatalogExposure(candidate, adminRules, this.deps.clock.now());
    const selection = evaluateDropshipVendorCatalogSelection({
      candidate, adminExposureDecision: exposure, rules: selectionRules, rawAtpUnits: 0,
      override: overrides.find((row) => row.productVariantId === parsed.productVariantId) ?? null,
    });
    if (!exposure.exposed || !selection.selected) {
      throw new DropshipError("DROPSHIP_LISTING_IMAGE_NOT_FOUND", "Listing image is unavailable.");
    }
    const image = await this.deps.presentation.media.readImageFile(parsed);
    if (!image) throw new DropshipError("DROPSHIP_LISTING_IMAGE_NOT_FOUND", "Listing image is unavailable.");
    return image;
  }

  async previewForMember(memberId: string, input: unknown): Promise<DropshipListingPreviewResult> {
    const parsed = generateVendorListingPreviewForMemberInputSchema.parse(input);
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    return this.generatePreview({
      ...parsed,
      vendorId: vendor.vendorId,
      actor: {
        actorType: "vendor",
        actorId: memberId,
      },
    });
  }

  async generatePreview(input: unknown): Promise<DropshipListingPreviewResult> {
    const parsed = generateVendorListingPreviewInputSchema.parse(input);
    const context = await this.loadStoreContextForAction(
      parsed.vendorId,
      parsed.storeConnectionId,
      "preview",
    );
    return this.generatePreviewForContext(parsed, context);
  }

  private async generatePreviewForContext(
    parsed: GenerateVendorListingPreviewInput,
    context: DropshipListingStoreContext,
  ): Promise<DropshipListingPreviewResult> {
    const generatedAt = this.deps.clock.now();
    const config = await this.deps.repository.getStoreListingConfig(parsed.storeConnectionId);
    const listingTiers = (await this.deps.listingTiers.resolveForVendor(parsed.vendorId)).eligibility;
    const uniqueVariantIds = uniquePositiveIntegers(parsed.productVariantIds);
    const requestedRetailPriceByVariantId = normalizeRequestedRetailPricesByVariantId({
      productVariantIds: uniqueVariantIds,
      requestedRetailPricesByVariantId: parsed.requestedRetailPricesByVariantId,
    });

    const [
      adminRules,
      selectionRules,
      candidates,
      overrides,
      existingListings,
      pricingPolicies,
      packageReadiness,
      ebayStoreCategoryAssignments,
      ebayListingPolicyOverrides,
      savedListingPrices,
    ] = await Promise.all([
      this.deps.repository.listCatalogExposureRules(),
      this.deps.repository.listSelectionRules(parsed.vendorId),
      this.deps.repository.listCatalogCandidates(uniqueVariantIds),
      this.deps.repository.listVariantOverrides({
        vendorId: parsed.vendorId,
        productVariantIds: uniqueVariantIds,
      }),
      this.deps.repository.listExistingListings({
        storeConnectionId: parsed.storeConnectionId,
        productVariantIds: uniqueVariantIds,
      }),
      this.deps.repository.listPricingPolicies(),
      this.deps.repository.getPackageReadiness(uniqueVariantIds),
      context.platform === "ebay"
        ? this.deps.repository.listEbayStoreCategoryAssignments({
            vendorId: parsed.vendorId,
            storeConnectionId: parsed.storeConnectionId,
            productVariantIds: uniqueVariantIds,
          })
        : Promise.resolve([]),
      context.platform === "ebay"
        ? this.deps.repository.listEbayListingPolicyOverrides({
            vendorId: parsed.vendorId,
            storeConnectionId: parsed.storeConnectionId,
            productVariantIds: uniqueVariantIds,
          })
        : Promise.resolve([]),
      this.deps.repository.listSavedListingPrices({ vendorId: parsed.vendorId,
        storeConnectionId: parsed.storeConnectionId, productVariantIds: uniqueVariantIds }),
    ]);

    const ruleEligibleCandidates = candidates.filter((candidate) => {
      const exposure = evaluateDropshipCatalogExposure(candidate, adminRules, generatedAt);
      return exposure.exposed && evaluateDropshipVendorCatalogSelection({ candidate, adminExposureDecision: exposure,
        rules: selectionRules, rawAtpUnits: 0, override: overrides.find((row) => row.productVariantId === candidate.productVariantId) ?? null }).selected;
    });
    const rulePrices = await this.deps.repository.loadRulePrices?.({ vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId, candidates: ruleEligibleCandidates }) ?? new Map<number, ListingRulePrice>();
    const contents = await this.deps.repository.loadListingContents?.({ vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId, candidates: ruleEligibleCandidates });
    // Every eBay row resolves its category through the store's current rules. The
    // push-time refresh calls this again, so a push publishes the category the rules
    // name when it is sent; a changed category never refuses a queue or fails a push.
    const ebayCategories = context.platform === "ebay"
      ? await this.deps.repository.loadEbayCategories?.({ vendorId: parsed.vendorId,
        storeConnectionId: parsed.storeConnectionId, candidates })
      : undefined;
    if (ebayCategories && candidates.some((candidate) => !ebayCategories.has(candidate.productVariantId))) {
      throw new Error("eBay category resolution returned an incomplete catalog result.");
    }
    const exposedCandidates = candidates.filter(
      (candidate) => evaluateDropshipCatalogExposure(candidate, adminRules, generatedAt).exposed,
    );
    const productCosts = await this.loadProductCosts({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      candidates: exposedCandidates,
      rulePrices,
    });
    const listingPhotos = await this.loadListingPhotos({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      candidates: exposedCandidates,
      platform: context.platform,
    });
    if (contents && ruleEligibleCandidates.some((candidate) => !contents.has(candidate.productVariantId))) {
      throw new Error("Listing content resolution returned an incomplete catalog result.");
    }
    const [ebayFulfillmentPreflights, ebayReturnPaymentPolicyCheck] = context.platform === "ebay" && config
      ? await Promise.all([
          this.loadEbayFulfillmentPreflights({
            context,
            config,
            policyOverrides: ebayListingPolicyOverrides,
          }),
          this.loadEbayReturnPaymentPolicyCheck({
            context,
            config,
            policyOverrides: ebayListingPolicyOverrides,
          }),
        ])
      : [
          new Map<string, DropshipEbayFulfillmentPolicyPreflight>(),
          NOT_CHECKED_RETURN_PAYMENT_POLICIES,
        ];

    const atp = await this.deps.atp.getVariantAtp(candidates.map((candidate) => ({
      productId: candidate.productId,
      productVariantId: candidate.productVariantId,
    })), { storeConnectionId: parsed.storeConnectionId });
    const atpByVariantId = atp.quantities;
    const candidatesByVariantId = new Map(candidates.map((candidate) => [candidate.productVariantId, candidate]));
    const overridesByVariantId = new Map(overrides.map((override) => [override.productVariantId, override]));
    const listingsByVariantId = new Map(existingListings.map((listing) => [listing.productVariantId, listing]));
    const savedPricesByVariantId = new Map(savedListingPrices.map((setting) => [setting.productVariantId, setting]));
    const storeCategoryNamesByVariantId = new Map(
      ebayStoreCategoryAssignments.map((assignment) => [
        assignment.productVariantId,
        assignment.storeCategoryNames,
      ]),
    );
    const listingPolicyOverridesByVariantId = new Map(
      ebayListingPolicyOverrides.map((override) => [override.productVariantId, override]),
    );
    const rows = uniqueVariantIds.map((productVariantId) => {
      const candidate = candidatesByVariantId.get(productVariantId);
      if (!candidate) {
        return missingCatalogPreviewRow({
          productVariantId,
          platform: context.platform,
        });
      }
      const adminExposureDecision = evaluateDropshipCatalogExposure(candidate, adminRules, generatedAt);
      const rawAtpUnits = atpByVariantId.get(productVariantId) ?? 0;
      const selectionDecision = evaluateDropshipVendorCatalogSelection({
        candidate,
        adminExposureDecision,
        rules: selectionRules,
        rawAtpUnits,
        override: overridesByVariantId.get(productVariantId) ?? null,
        applyMarketplaceQuantityCap: atp.authority === "legacy",
      });
      const existingListing = listingsByVariantId.get(productVariantId) ?? null;
      const listingPolicyOverride = listingPolicyOverridesByVariantId.get(productVariantId) ?? null;
      const effectiveConfig = context.platform === "ebay"
        ? applyEbayListingPolicyOverride(config, listingPolicyOverride)
        : config;
      const effectiveFulfillmentPolicyId = effectiveConfig
        ? readNestedString(
            effectiveConfig.marketplaceConfig,
            "businessPolicies",
            "fulfillmentPolicyId",
          )
        : null;
      return buildListingPreviewRow({
        candidate,
        // Hidden catalog rows are not read; their blocked preview carries no photos.
        listingPhotos: listingPhotos.get(productVariantId) ?? { photos: [], issues: [] },
        resolvedContent: contents?.get(productVariantId),
        resolvedCategory: ebayCategories?.get(productVariantId) ?? null,
        queuedCategory: parsed.queuedEbayCategoriesByVariantId?.[String(productVariantId)] ?? null,
        context,
        config: effectiveConfig,
        selectionDecision,
        adminExposureDecision,
        tierStatus: listingTiers[listingTierForVariantUomType(candidate.variantUomType)],
        packageReadiness: packageReadiness.get(productVariantId) ?? null,
        pricingPolicies,
        existingListing,
        savedListingPrice: savedPricesByVariantId.get(productVariantId) ?? null,
        rulePrice: rulePrices.get(productVariantId) ?? null,
        productCost: productCosts.get(productVariantId) ?? null,
        requestedRetailPriceCents: requestedRetailPriceByVariantId.get(productVariantId)
          ?? parsed.requestedRetailPriceCents
          ?? null,
        marketplaceListing: this.deps.marketplaceListing,
        generatedAt,
        storeCategoryNames: storeCategoryNamesByVariantId.get(productVariantId) ?? [],
        ebayFulfillmentPreflight: effectiveFulfillmentPolicyId
          ? ebayFulfillmentPreflights.get(effectiveFulfillmentPolicyId) ?? null
          : null,
        ebayReturnPaymentPolicyBlockers: ebayReturnPaymentPolicyBlockers({
          returnPolicyId: effectiveConfig
            ? readNestedString(effectiveConfig.marketplaceConfig, "businessPolicies", "returnPolicyId")
            : null,
          paymentPolicyId: effectiveConfig
            ? readNestedString(effectiveConfig.marketplaceConfig, "businessPolicies", "paymentPolicyId")
            : null,
          check: ebayReturnPaymentPolicyCheck,
        }),
        ebayListingPolicyOverride: listingPolicyOverride,
      });
    });

    const presentation = this.deps.presentation;
    const enrichedRows = presentation
      ? await enrichDropshipListingRows({ rows, candidates, listingPhotos, vendorId: parsed.vendorId,
          storeConnectionId: parsed.storeConnectionId, deps: { ...presentation,
            // The costs were read once above for the warning; the economics reuse them.
            productCosts: { loadProductCosts: async (input) => new Map(input.productVariantIds.flatMap((id) => {
              const cost = productCosts.get(id);
              return cost ? [[id, cost] as const] : [];
            })) },
          } })
      : rows;
    return {
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      platform: context.platform,
      generatedAt,
      rows: enrichedRows,
      summary: summarizeRows(rows),
    };
  }

  /**
   * The photos each exposed size publishes, or null without a photo reader.
   * A failed read fails the preview, like the other catalog reads: a push
   * built without it would drop uploaded photos from a live listing. A photo
   * that cannot be published is left out, logged, and warned about on its row;
   * it never blocks a listing that has other photos, so a broken upload
   * cannot stop a live listing's stock updates.
   */
  private async loadListingPhotos(input: {
    vendorId: number;
    storeConnectionId: number;
    candidates: readonly DropshipListingCatalogCandidate[];
    platform: DropshipSourcePlatform;
  }): Promise<ReadonlyMap<number, CatalogVariantPublicationPhotos>> {
    const reader = this.deps.listingPhotos;
    if (input.candidates.length === 0) return new Map();
    const photos = await reader.listPublicationPhotos({
      productVariantIds: input.candidates.map((candidate) => candidate.productVariantId),
      maxPhotosPerVariant: input.platform === "ebay" ? EBAY_LISTING_MAX_PHOTOS : DROPSHIP_LISTING_MAX_PHOTOS,
    });
    if (input.candidates.some((candidate) => !photos.has(candidate.productVariantId))) {
      throw new Error("Listing photo resolution returned an incomplete catalog result.");
    }
    const unpublishable = input.candidates.flatMap((candidate) => (photos.get(candidate.productVariantId)?.issues ?? [])
      .map((issue) => ({ productVariantId: candidate.productVariantId, assetId: issue.assetId, code: issue.code })));
    if (unpublishable.length > 0) {
      this.deps.logger.warn({
        code: "DROPSHIP_LISTING_PHOTO_UNPUBLISHABLE",
        message: "Uploaded catalog photos were left out of listings because they cannot be published.",
        context: {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          unpublishableCount: unpublishable.length,
          photos: unpublishable.slice(0, MAX_LOGGED_UNPUBLISHABLE_PHOTOS),
          truncated: unpublishable.length > MAX_LOGGED_UNPUBLISHABLE_PHOTOS,
        },
      });
    }
    return photos;
  }

  /**
   * One cost read per preview: the rule prices already carry the cost of the
   * listings they priced, the reader supplies the rest. The cost only feeds an
   * advisory warning and the economics panel, so a source outage is logged
   * and the preview goes on without it; the economics then say the cost is
   * unavailable.
   */
  private async loadProductCosts(input: {
    vendorId: number;
    storeConnectionId: number;
    candidates: readonly DropshipListingCatalogCandidate[];
    rulePrices: ReadonlyMap<number, ListingRulePrice>;
  }): Promise<ReadonlyMap<number, DropshipProductCost>> {
    const costs = new Map<number, DropshipProductCost>();
    for (const candidate of input.candidates) {
      const cost = input.rulePrices.get(candidate.productVariantId)?.productCost;
      if (cost) costs.set(candidate.productVariantId, cost);
    }
    const reader = this.deps.productCosts ?? this.deps.presentation?.productCosts;
    const remainingIds = input.candidates.map((candidate) => candidate.productVariantId).filter((id) => !costs.has(id));
    if (!reader || remainingIds.length === 0) return costs;
    try {
      for (const [id, cost] of await reader.loadProductCosts({ vendorId: input.vendorId, productVariantIds: remainingIds })) {
        costs.set(id, cost);
      }
    } catch (error) {
      this.deps.logger.warn({
        code: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE",
        message: "Product costs could not be read for the listing preview; the below-cost check was skipped.",
        context: { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, productVariantIds: remainingIds,
          errorCode: error instanceof DropshipError ? error.code : "UNEXPECTED_ERROR" },
      });
    }
    return costs;
  }

  private async loadEbayFulfillmentPreflights(input: {
    context: DropshipListingStoreContext;
    config: DropshipStoreListingConfig;
    policyOverrides: readonly DropshipEbayListingPolicyOverride[];
  }): Promise<Map<string, DropshipEbayFulfillmentPolicyPreflight>> {
    const marketplaceId = readNestedString(
      input.config.marketplaceConfig,
      "marketplaceId",
    );
    const defaultFulfillmentPolicyId = readNestedString(
      input.config.marketplaceConfig,
      "businessPolicies",
      "fulfillmentPolicyId",
    );
    if (!marketplaceId) return new Map();
    const fulfillmentPolicyIds = Array.from(new Set([
      defaultFulfillmentPolicyId,
      ...input.policyOverrides.map((override) => override.fulfillmentPolicyId),
    ].filter((value): value is string => Boolean(value))));
    const preflights = await Promise.all(fulfillmentPolicyIds.map(async (fulfillmentPolicyId) => [
      fulfillmentPolicyId,
      await this.loadEbayFulfillmentPreflight({
        context: input.context,
        marketplaceId,
        fulfillmentPolicyId,
      }),
    ] as const));
    return new Map(preflights);
  }

  private async loadEbayFulfillmentPreflight(input: {
    context: DropshipListingStoreContext;
    marketplaceId: string;
    fulfillmentPolicyId: string;
  }): Promise<DropshipEbayFulfillmentPolicyPreflight> {
    try {
      return await this.deps.ebayFulfillmentPolicyGuard.evaluateForStoreConnection({
        vendorId: input.context.vendorId,
        storeConnectionId: input.context.storeConnectionId,
        marketplaceId: input.marketplaceId,
        fulfillmentPolicyId: input.fulfillmentPolicyId,
      });
    } catch (error) {
      if (!(error instanceof DropshipError)) throw error;
      this.deps.logger.warn({
        code: "DROPSHIP_EBAY_FULFILLMENT_POLICY_PREFLIGHT_UNAVAILABLE",
        message: "eBay fulfillment policy compatibility could not be verified for listing preview.",
        context: {
          vendorId: input.context.vendorId,
          storeConnectionId: input.context.storeConnectionId,
          fulfillmentPolicyId: input.fulfillmentPolicyId,
          errorCode: error.code,
        },
      });
      return {
        compatible: false,
        fulfillmentPolicyId: input.fulfillmentPolicyId,
        capabilityEvidenceHash: "unavailable",
        originWarehouseId: null,
        issues: [{
          code: "verification_unavailable",
          message: "Fulfillment policy compatibility could not be verified. Refresh the setup before pushing.",
        }],
      };
    }
  }

  /**
   * Checks the store default and the requested listings' own return and
   * payment policy ids against eBay, the same scope as the fulfillment check.
   * Like that check, an eBay failure blocks the listings it would affect
   * (`verification_unavailable`) instead of failing the preview.
   */
  private async loadEbayReturnPaymentPolicyCheck(input: {
    context: DropshipListingStoreContext;
    config: DropshipStoreListingConfig;
    policyOverrides: readonly DropshipEbayListingPolicyOverride[];
  }): Promise<DropshipEbayReturnPaymentPolicyCheck> {
    const marketplaceId = readNestedString(input.config.marketplaceConfig, "marketplaceId");
    if (!marketplaceId) return NOT_CHECKED_RETURN_PAYMENT_POLICIES;
    const returnPolicyIds = distinctPolicyIds([
      readNestedString(input.config.marketplaceConfig, "businessPolicies", "returnPolicyId"),
      ...input.policyOverrides.map((override) => override.returnPolicyId),
    ]);
    const paymentPolicyIds = distinctPolicyIds([
      readNestedString(input.config.marketplaceConfig, "businessPolicies", "paymentPolicyId"),
      ...input.policyOverrides.map((override) => override.paymentPolicyId),
    ]);
    if (returnPolicyIds.length === 0 && paymentPolicyIds.length === 0) return NOT_CHECKED_RETURN_PAYMENT_POLICIES;
    try {
      const result = await this.deps.ebayReturnPaymentPolicies.check({
        vendorId: input.context.vendorId,
        storeConnectionId: input.context.storeConnectionId,
        marketplaceId,
        returnPolicyIds,
        paymentPolicyIds,
      });
      return { status: "checked", ...result };
    } catch (error) {
      if (!(error instanceof DropshipError)) throw error;
      this.deps.logger.warn({
        code: "DROPSHIP_EBAY_RETURN_PAYMENT_POLICY_CHECK_UNAVAILABLE",
        message: "eBay return and payment policies could not be verified for the listing preview.",
        context: {
          vendorId: input.context.vendorId,
          storeConnectionId: input.context.storeConnectionId,
          returnPolicyIds,
          paymentPolicyIds,
          errorCode: error.code,
        },
      });
      return { status: "unavailable" };
    }
  }

  async createListingPushJobForMember(memberId: string, input: unknown): Promise<{
    job: DropshipListingPushJobRecord;
    items: DropshipListingPushJobItemRecord[];
    preview: DropshipListingPreviewResult;
    idempotentReplay: boolean;
  }> {
    const parsed = createListingPushJobForMemberInputSchema.parse(input);
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    return this.createListingPushJob({
      ...parsed,
      vendorId: vendor.vendorId,
      requestedBy: {
        actorType: "vendor",
        actorId: memberId,
      },
    });
  }

  async createListingPushJob(input: unknown): Promise<{
    job: DropshipListingPushJobRecord;
    items: DropshipListingPushJobItemRecord[];
    preview: DropshipListingPreviewResult;
    idempotentReplay: boolean;
  }> {
    const parsed = createListingPushJobInputSchema.parse(input);
    const reviewMode: ListingPushReviewMode = parsed.reviewMode ?? "reviewed_preview";
    if (reviewMode === "current_preview" && carriesReviewedPreviewEvidence(parsed)) {
      // A one-step push queues what the server's own preview shows. Evidence from
      // an earlier preview would be silently ignored, so it is refused instead.
      throw new DropshipError("DROPSHIP_LISTING_PUSH_REVIEW_MODE_CONFLICT",
        "A one-step listing push cannot carry evidence from an earlier preview.",
        { vendorId: parsed.vendorId, storeConnectionId: parsed.storeConnectionId, classification: "permanent" });
    }
    const uniqueVariantIds = uniquePositiveIntegers(parsed.productVariantIds);
    const requestedRetailPricesByVariantId = normalizeRequestedRetailPricesByVariantId({
      productVariantIds: uniqueVariantIds,
      requestedRetailPricesByVariantId: parsed.requestedRetailPricesByVariantId,
    });
    const serializedRequestedRetailPricesByVariantId = serializeRequestedRetailPricesByVariantId(
      requestedRetailPricesByVariantId,
    );
    const context = await this.loadStoreContextForAction(
      parsed.vendorId,
      parsed.storeConnectionId,
      "push",
    );
    const previewInput: GenerateVendorListingPreviewInput = {
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      productVariantIds: uniqueVariantIds,
      requestedRetailPriceCents: parsed.requestedRetailPriceCents,
      requestedRetailPricesByVariantId: serializedRequestedRetailPricesByVariantId,
      actor: parsed.requestedBy,
    };
    const preview = await this.generatePreviewForContext(previewInput, context);
    if (reviewMode === "reviewed_preview") {
      assertPreviewMatchesReviewedEvidence(preview, parsed, uniqueVariantIds);
    }
    const requestHash = hashListingPushJobRequest({
      reviewMode,
      expectedContentEvidenceHashesByVariantId: parsed.expectedContentEvidenceHashesByVariantId,
      expectedRuleEvidenceHashesByVariantId: parsed.expectedRuleEvidenceHashesByVariantId,
      expectedPriceRevisionIdsByVariantId: parsed.expectedPriceRevisionIdsByVariantId,
      expectedPriceCentsByVariantId: parsed.expectedPriceCentsByVariantId,
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      productVariantIds: uniqueVariantIds,
      requestedRetailPriceCents: parsed.requestedRetailPriceCents ?? null,
      requestedRetailPricesByVariantId: serializedRequestedRetailPricesByVariantId,
      previewHashesByVariantId: Object.fromEntries(
        preview.rows
          .map((row) => [String(row.productVariantId), row.previewHash] as const)
          .sort(([left], [right]) => Number(left) - Number(right)),
      ),
    });
    const result = await this.deps.repository.createListingPushJob({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      platform: preview.platform,
      productVariantIds: uniqueVariantIds,
      requestedRetailPricesByVariantId: serializedRequestedRetailPricesByVariantId,
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
      requestedBy: parsed.requestedBy,
      preview,
      now: this.deps.clock.now(),
    });

    this.deps.logger.info({
      code: result.idempotentReplay ? "DROPSHIP_LISTING_PUSH_JOB_REPLAYED" : "DROPSHIP_LISTING_PUSH_JOB_CREATED",
      message: result.idempotentReplay
        ? "Dropship listing push job replayed by idempotency key."
        : "Dropship listing push job created.",
      context: {
        vendorId: parsed.vendorId,
        storeConnectionId: parsed.storeConnectionId,
        jobId: result.job.jobId,
        reviewMode,
        itemCount: result.items.length,
        readyCount: preview.summary.ready,
        blockedCount: preview.summary.blocked,
      },
    });

    return {
      ...result,
      preview,
    };
  }

  private async loadStoreContextForAction(
    vendorId: number,
    storeConnectionId: number,
    action: "preview" | "push",
  ): Promise<DropshipListingStoreContext> {
    const context = await this.deps.repository.loadStoreContext({ vendorId, storeConnectionId });
    if (!context) {
      throw new DropshipError(
        "DROPSHIP_STORE_CONNECTION_REQUIRED",
        `Dropship store connection is required before listing ${action}.`,
        { vendorId, storeConnectionId, action },
      );
    }
    // The shared rule is the one the vendor pages use to explain a block before
    // the vendor clicks, so the server and the page cannot disagree. Codes are
    // unchanged; the message says what to do and `resolution` names the step the
    // portal links to.
    const access = decideDropshipListingAccess({
      action,
      vendorStatus: context.vendorStatus,
      entitlementStatus: context.entitlementStatus,
      store: { status: context.storeStatus, launchReady: context.storeLaunchReady },
    });
    if (!access.allowed) {
      throw new DropshipError(access.code, access.message, {
        vendorId,
        storeConnectionId,
        vendorStatus: context.vendorStatus,
        entitlementStatus: context.entitlementStatus,
        storeStatus: context.storeStatus,
        setupStatus: context.setupStatus,
        platform: context.platform,
        storeLaunchReady: context.storeLaunchReady,
        action,
        resolution: access.resolution,
      });
    }
    return context;
  }
}

export function hashListingPushJobRequest(input: {
  reviewMode?: ListingPushReviewMode;
  expectedContentEvidenceHashesByVariantId?: Readonly<Record<string, string>>;
  expectedRuleEvidenceHashesByVariantId?: Readonly<Record<string, string>>;
  expectedPriceRevisionIdsByVariantId?: Readonly<Record<string, number | null>>;
  expectedPriceCentsByVariantId?: Readonly<Record<string, number | null>>;
  vendorId: number;
  storeConnectionId: number;
  productVariantIds: readonly number[];
  requestedRetailPriceCents: number | null;
  requestedRetailPricesByVariantId?: Readonly<Record<string, number>>;
  previewHashesByVariantId?: Readonly<Record<string, string>>;
}): string {
  const requestedRetailPricesByVariantId = canonicalRequestedRetailPriceRecord(input.requestedRetailPricesByVariantId);
  const payload: Record<string, unknown> = {
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    productVariantIds: [...input.productVariantIds].sort((left, right) => left - right),
    requestedRetailPriceCents: input.requestedRetailPriceCents,
  };
  for (const key of ["expectedPriceRevisionIdsByVariantId", "expectedPriceCentsByVariantId", "expectedRuleEvidenceHashesByVariantId", "expectedContentEvidenceHashesByVariantId"] as const) {
    if (input[key] !== undefined) payload[key] = Object.fromEntries(Object.entries(input[key]).sort(([left], [right]) => Number(left) - Number(right)));
  }
  if (Object.keys(requestedRetailPricesByVariantId).length > 0) {
    payload.requestedRetailPricesByVariantId = requestedRetailPricesByVariantId;
  }
  if (input.reviewMode === "current_preview") {
    // A one-step push is identified by what was asked for, not by what the
    // preview returned: stock and prices move between a request and its retry,
    // and a retry of the same request has to replay the job it created. The
    // reviewed payload below is left exactly as it was so existing keys replay.
    payload.reviewMode = input.reviewMode;
    return hashJson(payload);
  }
  const previewHashesByVariantId = Object.fromEntries(
    Object.entries(input.previewHashesByVariantId ?? {})
      .sort(([left], [right]) => Number(left) - Number(right)),
  );
  if (Object.keys(previewHashesByVariantId).length > 0) {
    payload.previewHashesByVariantId = previewHashesByVariantId;
  }
  return hashJson(payload);
}

/** True when the request echoes anything from an earlier preview. */
function carriesReviewedPreviewEvidence(input: {
  expectedContentEvidenceHashesByVariantId?: Readonly<Record<string, string>>;
  expectedRuleEvidenceHashesByVariantId?: Readonly<Record<string, string>>;
  expectedPriceRevisionIdsByVariantId?: Readonly<Record<string, number | null>>;
  expectedPriceCentsByVariantId?: Readonly<Record<string, number | null>>;
}): boolean {
  return input.expectedContentEvidenceHashesByVariantId !== undefined
    || input.expectedRuleEvidenceHashesByVariantId !== undefined
    || input.expectedPriceRevisionIdsByVariantId !== undefined
    || input.expectedPriceCentsByVariantId !== undefined;
}

/**
 * Two-step push: the fresh preview must match what the caller reviewed. Every
 * refusal names what changed so the caller can preview again.
 */
function assertPreviewMatchesReviewedEvidence(
  preview: DropshipListingPreviewResult,
  parsed: {
    expectedContentEvidenceHashesByVariantId?: Readonly<Record<string, string>>;
    expectedRuleEvidenceHashesByVariantId?: Readonly<Record<string, string>>;
    expectedPriceRevisionIdsByVariantId?: Readonly<Record<string, number | null>>;
    expectedPriceCentsByVariantId?: Readonly<Record<string, number | null>>;
  },
  uniqueVariantIds: readonly number[],
): void {
  if (preview.rows.some((row) => row.contentEvidenceHash
    && parsed.expectedContentEvidenceHashesByVariantId?.[String(row.productVariantId)] !== row.contentEvidenceHash)) {
    throw new DropshipError("DROPSHIP_CONTENT_VERSION_CONFLICT", "Descriptions, catalog facts, or templates changed. Generate and review a new preview before queueing.");
  }
  const ruleRows = preview.rows.filter((row) => row.rulePriceEvidenceHash);
  if (ruleRows.some((row) => parsed.expectedRuleEvidenceHashesByVariantId?.[String(row.productVariantId)] !== row.rulePriceEvidenceHash)) {
    throw new DropshipError("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT",
      "Review the current pricing rules and costs before queueing these listings.");
  }
  if (parsed.expectedPriceRevisionIdsByVariantId !== undefined) {
    const expected = parsed.expectedPriceRevisionIdsByVariantId;
    const keys = Object.keys(expected);
    if (keys.length !== uniqueVariantIds.length || keys.some((key) => !uniqueVariantIds.includes(Number(key)))) {
      throw new DropshipError("DROPSHIP_LISTING_PRICE_OVERRIDE_INVALID", "Price revision checks must match every requested listing.");
    }
    if (preview.rows.some((row) => expected[String(row.productVariantId)] !== (row.priceSettingRevisionId ?? null))) {
      throw new DropshipError("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT",
        "A listing price changed since your preview. Generate a new preview before queueing.");
    }
  }
  if (parsed.expectedPriceCentsByVariantId !== undefined) {
    const expected = parsed.expectedPriceCentsByVariantId;
    const keys = Object.keys(expected);
    if (keys.length !== uniqueVariantIds.length || keys.some((key) => !uniqueVariantIds.includes(Number(key)))) {
      throw new DropshipError("DROPSHIP_LISTING_PRICE_OVERRIDE_INVALID", "Reviewed prices must match every requested listing.");
    }
    if (preview.rows.some((row) => expected[String(row.productVariantId)] !== row.priceCents)) {
      throw new DropshipError("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT",
        "A listing's effective price changed since your preview. Generate a new preview before queueing.");
    }
  }
}

function normalizeRequestedRetailPricesByVariantId(input: {
  productVariantIds: readonly number[];
  requestedRetailPricesByVariantId?: Readonly<Record<string, number>>;
}): Map<number, number> {
  const result = new Map<number, number>();
  const rawOverrides = input.requestedRetailPricesByVariantId ?? {};
  const allowedVariantIds = new Set(input.productVariantIds);

  for (const [rawProductVariantId, priceCents] of Object.entries(rawOverrides)) {
    const productVariantId = Number(rawProductVariantId);
    if (!Number.isInteger(productVariantId) || productVariantId <= 0) {
      throw new DropshipError(
        "DROPSHIP_LISTING_PRICE_OVERRIDE_INVALID",
        "Retail price override variant id must be a positive integer.",
        { productVariantId: rawProductVariantId },
      );
    }
    if (!allowedVariantIds.has(productVariantId)) {
      throw new DropshipError(
        "DROPSHIP_LISTING_PRICE_OVERRIDE_INVALID",
        "Retail price override must target a requested product variant.",
        { productVariantId },
      );
    }
    if (!Number.isInteger(priceCents) || priceCents < 0) {
      throw new DropshipError(
        "DROPSHIP_LISTING_PRICE_OVERRIDE_INVALID",
        "Retail price override must be integer cents.",
        { productVariantId, priceCents },
      );
    }
    result.set(productVariantId, priceCents);
  }

  return result;
}

function serializeRequestedRetailPricesByVariantId(input: ReadonlyMap<number, number>): Record<string, number> {
  return Object.fromEntries(
    [...input.entries()]
      .sort(([left], [right]) => left - right)
      .map(([productVariantId, priceCents]) => [String(productVariantId), priceCents]),
  );
}

function canonicalRequestedRetailPriceRecord(input?: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input ?? {})
      .sort(([left], [right]) => Number(left) - Number(right)),
  );
}

export function makeDropshipListingPreviewLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipListingEvent("info", event),
    warn: (event) => logDropshipListingEvent("warn", event),
    error: (event) => logDropshipListingEvent("error", event),
  };
}

export const systemDropshipListingPreviewClock: DropshipClock = {
  now: () => new Date(),
};

function buildListingPreviewRow(input: {
  /** The size's resolved Catalog photos; hidden/blocked sizes carry an empty gallery. */
  listingPhotos: CatalogVariantPublicationPhotos;
  resolvedContent?: import("../../../../shared/dropship/listing-content").ResolvedListingContent;
  resolvedCategory?: ResolvedEbayListingCategory | null;
  /** Push time only: the category the listing was queued with. */
  queuedCategory?: QueuedEbayCategory | null;
  candidate: DropshipListingCatalogCandidate;
  context: DropshipListingStoreContext;
  config: DropshipStoreListingConfig | null;
  selectionDecision: DropshipVendorCatalogSelectionDecision;
  adminExposureDecision: DropshipCatalogExposureDecision;
  tierStatus: DropshipListingTierStatus;
  packageReadiness: DropshipListingPackageReadiness | null;
  pricingPolicies: readonly DropshipPricingPolicyRecord[];
  existingListing: DropshipExistingVendorListing | null;
  savedListingPrice: SavedListingPriceRevision | null;
  rulePrice: ListingRulePrice | null;
  /** Cost of one sellable pack, when the source could supply it. */
  productCost: DropshipProductCost | null;
  requestedRetailPriceCents: number | null;
  marketplaceListing: DropshipMarketplaceListingProvider;
  generatedAt: Date;
  storeCategoryNames: readonly string[];
  ebayFulfillmentPreflight: DropshipEbayFulfillmentPolicyPreflight | null;
  /** From the live check of the listing's effective return and payment policy ids. */
  ebayReturnPaymentPolicyBlockers: readonly string[];
  ebayListingPolicyOverride: DropshipEbayListingPolicyOverride | null;
}): DropshipListingPreviewRow {
  const blockers: string[] = [...(input.resolvedContent?.issues ?? [])];
  const warnings: string[] = [];

  if (!input.selectionDecision.selected) {
    blockers.push(`selection:${input.selectionDecision.reason}`);
  }
  // A tier that is off sale blocks the row and zeroes its quantity: a new
  // listing cannot be created, and a SKU already on the marketplace publishes
  // zero, which inventory planning holds and any push here writes the same.
  // The marketplace validation then also reports the zero quantity, exactly
  // as it does for a sold-out SKU; the tier blocker says why.
  const tierOffSale = !input.tierStatus.eligible;
  if (tierOffSale) {
    blockers.push(`listing_tier:${input.tierStatus.reason}`);
  }
  const marketplaceQuantity = tierOffSale ? 0 : input.selectionDecision.marketplaceQuantity;
  if (!input.config) {
    blockers.push("listing_config_required");
  } else if (input.config.platform !== input.context.platform) {
    blockers.push("listing_config_platform_mismatch");
  }
  const packageReadiness = input.packageReadiness;
  if (!packageReadiness?.hasCatalogPackageData) {
    blockers.push("catalog_package_data_required");
  }
  if (!packageReadiness?.hasActiveBox) {
    blockers.push("active_box_required");
  }
  if (!packageReadiness?.hasActiveRateTable) {
    blockers.push("active_rate_table_required");
  }

  const ruleOwned = listingPriceFollowsRules({ saved: input.savedListingPrice, rulePrice: input.rulePrice });
  const resolvedPrice = resolveListingPrice({
    saved: input.savedListingPrice,
    existingListingPriceCents: input.existingListing?.vendorRetailPriceCents ?? null,
    defaultPriceCents: input.candidate.defaultRetailPriceCents,
    rulePrice: input.rulePrice,
  }).effectivePriceCents;
  // Request-local legacy prices cannot silently override adopted pricing rules.
  // An exception must be saved explicitly as a fixed listing price.
  const priceCents = ruleOwned ? resolvedPrice : input.requestedRetailPriceCents ?? resolvedPrice;
  if (ruleOwned && input.rulePrice?.issue) blockers.push(input.rulePrice.issue);
  if (ruleOwned && !input.rulePrice) blockers.push("pricing_rules_not_configured");
  const pricingDecision = evaluateListingPricingPolicy(input.candidate, input.pricingPolicies, priceCents);
  blockers.push(...pricingDecision.blockers);
  warnings.push(...pricingDecision.warnings);
  warnings.push(...evaluateListingPriceAgainstCost({
    priceCents,
    unitCostCents: input.productCost?.status === "available" ? input.productCost.unitCostCents : null,
  }).warnings);

  const publishedCategory = publishedEbayCategory(input.resolvedCategory, input.queuedCategory);
  const marketplaceValidation = input.config
    ? input.marketplaceListing.buildListingIntent({
        config: input.config,
        content: listingIntentContent(input.candidate, input.resolvedContent, publishedCategory, input.listingPhotos),
        priceCents,
        quantity: marketplaceQuantity,
        storeCategoryNames: input.storeCategoryNames,
      })
    : { intent: null, blockers: [], warnings: [] };
  blockers.push(...marketplaceValidation.blockers);
  warnings.push(...marketplaceValidation.warnings);
  warnings.push(...unpublishablePhotoWarnings(input.listingPhotos));
  if (input.ebayFulfillmentPreflight?.compatible === false) {
    blockers.push(...input.ebayFulfillmentPreflight.issues.map(
      (issue) => `ebay_fulfillment_policy:${issue.code}`,
    ));
  }
  blockers.push(...input.ebayReturnPaymentPolicyBlockers);

  const previewStatus = blockers.length > 0
    ? "blocked"
    : warnings.length > 0
      ? "warning"
      : "ready";
  const title = input.candidate.title?.trim() || input.candidate.productName;
  const businessPolicySelection = input.context.platform === "ebay"
    ? buildBusinessPolicySelection(input.config, input.ebayListingPolicyOverride)
    : null;
  // A blocked row has no intent; it still shows the category it would publish.
  const fallbackCategory = publishedCategory
    ?? { categoryId: input.candidate.ebayBrowseCategoryId, categoryName: input.candidate.ebayBrowseCategoryName };
  const previewHash = hashJson({
    ...(input.resolvedContent ? { contentEvidenceHash: input.resolvedContent.evidenceHash } : {}),
    ...(ruleOwned ? { rulePriceEvidenceHash: input.rulePrice?.evidenceHash ?? null } : {}),
    priceSettingRevisionId: input.savedListingPrice?.revisionId ?? null,
    productVariantId: input.candidate.productVariantId,
    storeConnectionId: input.context.storeConnectionId,
    platform: input.context.platform,
    listingMode: input.config?.listingMode ?? null,
    priceCents,
    marketplaceCategoryId: marketplaceValidation.intent?.marketplaceCategoryId ?? fallbackCategory.categoryId,
    marketplaceCategoryName: marketplaceValidation.intent?.marketplaceCategoryName ?? fallbackCategory.categoryName,
    storeCategoryNames: marketplaceValidation.intent?.storeCategoryNames ?? [],
    marketplaceQuantity,
    listingTier: { tier: input.tierStatus.tier, eligible: input.tierStatus.eligible, reason: input.tierStatus.reason },
    blockers,
    warnings,
    intent: marketplaceValidation.intent,
    businessPolicySelection,
    ebayFulfillmentCapabilityEvidenceHash:
      input.ebayFulfillmentPreflight?.capabilityEvidenceHash ?? null,
  });

  return {
    priceSettingRevisionId: input.savedListingPrice?.revisionId ?? null,
    ...(input.resolvedContent ? { contentEvidenceHash: input.resolvedContent.evidenceHash } : {}),
    ...(input.resolvedCategory ? {
      marketplaceCategorySource: input.resolvedCategory.source,
      marketplaceCategoryRuleName: input.resolvedCategory.ruleName,
    } : {}),
    ...(publishedCategory?.fromQueue ? { marketplaceCategoryFallback: "queued" as const } : {}),
    ...(ruleOwned ? { rulePriceEvidenceHash: input.rulePrice?.evidenceHash ?? null, pricingRuleName: input.rulePrice?.ruleName ?? null } : {}),
    ...(input.savedListingPrice?.pricingMode === "inherit" ? { followsStorePricing: true as const } : {}),
    productVariantId: input.candidate.productVariantId,
    productId: input.candidate.productId,
    sku: input.candidate.sku,
    title,
    platform: input.context.platform,
    listingMode: input.config?.listingMode ?? null,
    currentListingStatus: input.existingListing?.status ?? "not_listed",
    previewStatus,
    blockers,
    warnings,
    marketplaceQuantity,
    priceCents,
    marketplaceCategoryId: marketplaceValidation.intent?.marketplaceCategoryId ?? fallbackCategory.categoryId,
    marketplaceCategoryName: marketplaceValidation.intent?.marketplaceCategoryName ?? fallbackCategory.categoryName,
    storeCategoryNames: marketplaceValidation.intent?.storeCategoryNames ?? [],
    businessPolicySelection,
    previewHash,
    adminExposureDecision: input.adminExposureDecision,
    selectionDecision: input.selectionDecision,
    listingTier: input.tierStatus,
    listingIntent: marketplaceValidation.intent,
  };
}

/**
 * The candidate as the marketplace sees it: the resolved description, the
 * eBay category and the photos to publish.
 */
function listingIntentContent(
  candidate: DropshipListingCatalogCandidate,
  resolvedContent: import("../../../../shared/dropship/listing-content").ResolvedListingContent | undefined,
  category: PublishedEbayCategory | null,
  photos: CatalogVariantPublicationPhotos,
): DropshipListingCatalogCandidate {
  return {
    ...candidate,
    ...(resolvedContent ? { description: resolvedContent.descriptionHtml } : {}),
    ...(category ? { ebayBrowseCategoryId: category.categoryId, ebayBrowseCategoryName: category.categoryName } : {}),
    imageUrls: photos.photos.map((photo) => photo.url),
  };
}

/** One warning per reason an uploaded photo is left out, in a stable order. */
function unpublishablePhotoWarnings(photos: CatalogVariantPublicationPhotos | null): string[] {
  return [...new Set((photos?.issues ?? []).map((issue) => listingPhotoLeftOutReason(issue.code)))].sort();
}

interface PublishedEbayCategory {
  categoryId: string | null;
  categoryName: string | null;
  fromQueue: boolean;
}

/**
 * The eBay category a row publishes: the one the rules name now; when they name
 * none, the one the listing was queued with (push time only). Null keeps the
 * candidate's own catalog fields, for rows the rules did not resolve.
 */
function publishedEbayCategory(
  resolved: ResolvedEbayListingCategory | null | undefined,
  queued: QueuedEbayCategory | null | undefined,
): PublishedEbayCategory | null {
  if (!resolved) return null;
  if (resolved.categoryId === null && queued) {
    return { categoryId: queued.categoryId, categoryName: queued.categoryName, fromQueue: true };
  }
  return { categoryId: resolved.categoryId, categoryName: resolved.categoryName, fromQueue: false };
}

function missingCatalogPreviewRow(input: {
  productVariantId: number;
  platform: DropshipSourcePlatform;
}): DropshipListingPreviewRow {
  const blockers = ["catalog_variant_not_found"];
  const previewHash = hashJson({
    productVariantId: input.productVariantId,
    blockers,
  });
  return {
    productVariantId: input.productVariantId,
    productId: 0,
    sku: null,
    title: "Unknown variant",
    platform: input.platform,
    listingMode: null,
    currentListingStatus: "not_listed",
    previewStatus: "blocked",
    blockers,
    warnings: [],
    marketplaceQuantity: 0,
    priceCents: null,
    marketplaceCategoryId: null,
    marketplaceCategoryName: null,
    storeCategoryNames: [],
    businessPolicySelection: null,
    previewHash,
    adminExposureDecision: {
      exposed: false,
      reason: "inactive_product_or_variant",
      includeRuleIds: [],
      excludeRuleIds: [],
    },
    selectionDecision: {
      selected: false,
      reason: "not_exposed_by_admin",
      adminExposureReason: "inactive_product_or_variant",
      includeRuleIds: [],
      excludeRuleIds: [],
      autoConnectNewSkus: false,
      autoListNewSkus: false,
      marketplaceQuantity: 0,
      quantityCapApplied: false,
    },
    listingTier: null,
    listingIntent: null,
  };
}

export function evaluateListingPricingPolicy(
  candidate: DropshipListingCatalogCandidate,
  policies: readonly DropshipPricingPolicyRecord[],
  priceCents: number | null,
): { blockers: string[]; warnings: string[] } {
  if (priceCents === null) {
    return { blockers: ["vendor_retail_price_required"], warnings: [] };
  }
  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const policy of policies.filter((row) => pricingPolicyMatchesCandidate(row, candidate))) {
    if (policy.mode === "off") {
      continue;
    }
    const violations = [
      policy.floorPriceCents !== null && priceCents < policy.floorPriceCents ? "below_floor" : null,
      policy.ceilingPriceCents !== null && priceCents > policy.ceilingPriceCents ? "above_ceiling" : null,
    ].filter((value): value is string => Boolean(value));
    if (violations.length === 0) {
      continue;
    }
    const codes = violations.map((violation) => `pricing:${violation}:policy_${policy.id}`);
    if (policy.mode === "block_listing_push") {
      blockers.push(...codes);
    } else {
      warnings.push(...codes);
    }
  }
  return { blockers, warnings };
}

/** Whether a Card Shellz price limit covers this size. The listing settings views list the same limits. */
export function pricingPolicyMatchesCandidate(
  policy: DropshipPricingPolicyRecord,
  candidate: Pick<DropshipListingCatalogCandidate, "productLineIds" | "category" | "productId" | "productVariantId">,
): boolean {
  switch (policy.scopeType) {
    case "catalog":
      return true;
    case "product_line":
      return typeof policy.productLineId === "number" && candidate.productLineIds.includes(policy.productLineId);
    case "category":
      return normalizeString(policy.category) !== null && normalizeString(policy.category) === normalizeString(candidate.category);
    case "product":
      return policy.productId === candidate.productId;
    case "variant":
      return policy.productVariantId === candidate.productVariantId;
    default:
      return false;
  }
}

function summarizeRows(rows: readonly DropshipListingPreviewRow[]) {
  return {
    total: rows.length,
    ready: rows.filter((row) => row.previewStatus === "ready").length,
    blocked: rows.filter((row) => row.previewStatus === "blocked").length,
    warning: rows.filter((row) => row.previewStatus === "warning").length,
  };
}

function uniquePositiveIntegers(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => Math.floor(value)).filter((value) => value > 0))];
}

function normalizeString(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function applyEbayListingPolicyOverride(
  config: DropshipStoreListingConfig | null,
  override: DropshipEbayListingPolicyOverride | null,
): DropshipStoreListingConfig | null {
  if (!config || !override) return config;
  const currentBusinessPolicies = isPlainRecord(config.marketplaceConfig.businessPolicies)
    ? config.marketplaceConfig.businessPolicies
    : {};
  return {
    ...config,
    marketplaceConfig: {
      ...config.marketplaceConfig,
      businessPolicies: {
        ...currentBusinessPolicies,
        ...(override.fulfillmentPolicyId !== null
          ? { fulfillmentPolicyId: override.fulfillmentPolicyId }
          : {}),
        ...(override.returnPolicyId !== null
          ? { returnPolicyId: override.returnPolicyId }
          : {}),
        ...(override.paymentPolicyId !== null
          ? { paymentPolicyId: override.paymentPolicyId }
          : {}),
      },
    },
  };
}

function buildBusinessPolicySelection(
  config: DropshipStoreListingConfig | null,
  override: DropshipEbayListingPolicyOverride | null,
): DropshipListingPreviewRow["businessPolicySelection"] {
  if (!config) return null;
  const overriddenFields: NonNullable<
    DropshipListingPreviewRow["businessPolicySelection"]
  >["overriddenFields"] = [];
  if (override?.fulfillmentPolicyId !== null && override?.fulfillmentPolicyId !== undefined) {
    overriddenFields.push("fulfillmentPolicyId");
  }
  if (override?.returnPolicyId !== null && override?.returnPolicyId !== undefined) {
    overriddenFields.push("returnPolicyId");
  }
  if (override?.paymentPolicyId !== null && override?.paymentPolicyId !== undefined) {
    overriddenFields.push("paymentPolicyId");
  }
  return {
    fulfillmentPolicyId: readNestedString(
      config.marketplaceConfig,
      "businessPolicies",
      "fulfillmentPolicyId",
    ),
    returnPolicyId: readNestedString(
      config.marketplaceConfig,
      "businessPolicies",
      "returnPolicyId",
    ),
    paymentPolicyId: readNestedString(
      config.marketplaceConfig,
      "businessPolicies",
      "paymentPolicyId",
    ),
    overriddenFields,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNestedString(
  record: Record<string, unknown>,
  ...path: string[]
): string | null {
  const value = path.reduce<unknown>((current, key) => (
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)[key]
      : undefined
  ), record);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Trimmed, non-empty and distinct, read the same way as `readNestedString`. */
function distinctPolicyIds(values: ReadonlyArray<string | null>): string[] {
  return [...new Set(values.flatMap((value) => {
    const trimmed = value?.trim();
    return trimmed ? [trimmed] : [];
  }))];
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJsonValue(value))).digest("hex");
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
        return sorted;
      }, {});
  }
  return value;
}

function logDropshipListingEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}
