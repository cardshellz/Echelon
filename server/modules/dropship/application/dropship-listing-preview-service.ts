import { createHash } from "crypto";
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
import {
  createListingPushJobForMemberInputSchema,
  generateVendorListingPreviewForMemberInputSchema,
} from "./dropship-listing-dtos";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type {
  DropshipVendorProvisioningService,
} from "./dropship-vendor-provisioning-service";
import {
  createListingPushJobInputSchema,
  generateVendorListingPreviewInputSchema,
  type CreateListingPushJobInput,
  type GenerateVendorListingPreviewInput,
} from "./dropship-use-case-dtos";

export interface DropshipListingStoreContext {
  vendorId: number;
  vendorStatus: DropshipVendorStatus;
  entitlementStatus: string;
  storeConnectionId: number;
  storeStatus: DropshipStoreConnectionStatus;
  setupStatus: string;
  platform: DropshipSourcePlatform;
}

export interface DropshipListingCatalogCandidate extends DropshipCatalogVariantCandidate, DropshipCanonicalListingContent {
  unitsPerVariant: number;
  defaultRetailPriceCents: number | null;
}

export interface DropshipListingPackageReadiness {
  hasPackageProfile: boolean;
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
  previewHash: string;
  adminExposureDecision: DropshipCatalogExposureDecision;
  selectionDecision: DropshipVendorCatalogSelectionDecision;
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
  getPackageReadiness(productVariantIds: readonly number[]): Promise<Map<number, DropshipListingPackageReadiness>>;
  createListingPushJob(
    input: CreateDropshipListingPushJobRepositoryInput,
  ): Promise<CreateDropshipListingPushJobRepositoryResult>;
}

export interface DropshipListingPreviewServiceDependencies {
  vendorProvisioning: DropshipVendorProvisioningService;
  repository: DropshipListingPreviewRepository;
  atp: DropshipAtpProvider;
  marketplaceListing: DropshipMarketplaceListingProvider;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export class DropshipListingPreviewService {
  constructor(private readonly deps: DropshipListingPreviewServiceDependencies) {}

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
    const generatedAt = this.deps.clock.now();
    const context = await this.loadUsableStoreContext(parsed.vendorId, parsed.storeConnectionId);
    const config = await this.deps.repository.getStoreListingConfig(parsed.storeConnectionId);
    const uniqueVariantIds = uniquePositiveIntegers(parsed.productVariantIds);

    const [
      adminRules,
      selectionRules,
      candidates,
      overrides,
      existingListings,
      pricingPolicies,
      packageReadiness,
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
    ]);

    const productIds = uniquePositiveIntegers(candidates.map((candidate) => candidate.productId));
    const atpByProductId = await this.deps.atp.getBaseAtpByProductIds(productIds);
    const candidatesByVariantId = new Map(candidates.map((candidate) => [candidate.productVariantId, candidate]));
    const overridesByVariantId = new Map(overrides.map((override) => [override.productVariantId, override]));
    const listingsByVariantId = new Map(existingListings.map((listing) => [listing.productVariantId, listing]));
    const rows = uniqueVariantIds.map((productVariantId) => {
      const candidate = candidatesByVariantId.get(productVariantId);
      if (!candidate) {
        return missingCatalogPreviewRow({
          productVariantId,
          platform: context.platform,
        });
      }
      const adminExposureDecision = evaluateDropshipCatalogExposure(candidate, adminRules, generatedAt);
      const rawAtpUnits = Math.floor(
        Math.max(0, atpByProductId.get(candidate.productId) ?? 0) / Math.max(1, candidate.unitsPerVariant),
      );
      const selectionDecision = evaluateDropshipVendorCatalogSelection({
        candidate,
        adminExposureDecision,
        rules: selectionRules,
        rawAtpUnits,
        override: overridesByVariantId.get(productVariantId) ?? null,
      });
      const existingListing = listingsByVariantId.get(productVariantId) ?? null;
      return buildListingPreviewRow({
        candidate,
        context,
        config,
        selectionDecision,
        adminExposureDecision,
        packageReadiness: packageReadiness.get(productVariantId) ?? null,
        pricingPolicies,
        existingListing,
        requestedRetailPriceCents: parsed.requestedRetailPriceCents ?? null,
        marketplaceListing: this.deps.marketplaceListing,
        generatedAt,
      });
    });

    return {
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      platform: context.platform,
      generatedAt,
      rows,
      summary: summarizeRows(rows),
    };
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
    const parsed = createListingPushJobInputSchema.extend({
      requestedRetailPriceCents: generateVendorListingPreviewInputSchema.shape.requestedRetailPriceCents,
    }).parse(input);
    const preview = await this.generatePreview({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      productVariantIds: parsed.productVariantIds,
      requestedRetailPriceCents: parsed.requestedRetailPriceCents,
      actor: parsed.requestedBy,
    });
    const requestHash = hashListingPushJobRequest({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      productVariantIds: uniquePositiveIntegers(parsed.productVariantIds),
      requestedRetailPriceCents: parsed.requestedRetailPriceCents ?? null,
    });
    const result = await this.deps.repository.createListingPushJob({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      platform: preview.platform,
      productVariantIds: uniquePositiveIntegers(parsed.productVariantIds),
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

  private async loadUsableStoreContext(
    vendorId: number,
    storeConnectionId: number,
  ): Promise<DropshipListingStoreContext> {
    const context = await this.deps.repository.loadStoreContext({ vendorId, storeConnectionId });
    if (!context) {
      throw new DropshipError(
        "DROPSHIP_STORE_CONNECTION_REQUIRED",
        "Dropship store connection is required before listing preview.",
        { vendorId, storeConnectionId },
      );
    }
    if (["closed", "lapsed", "suspended"].includes(context.vendorStatus)) {
      throw new DropshipError(
        "DROPSHIP_LISTING_VENDOR_BLOCKED",
        "Dropship vendor status does not allow listing preview or push.",
        { vendorId, vendorStatus: context.vendorStatus },
      );
    }
    if (context.storeStatus !== "connected") {
      throw new DropshipError(
        "DROPSHIP_LISTING_STORE_BLOCKED",
        "Dropship store connection is not healthy enough for listing preview or push.",
        { vendorId, storeConnectionId, storeStatus: context.storeStatus },
      );
    }
    return context;
  }
}

export function hashListingPushJobRequest(input: {
  vendorId: number;
  storeConnectionId: number;
  productVariantIds: readonly number[];
  requestedRetailPriceCents: number | null;
}): string {
  return hashJson({
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    productVariantIds: [...input.productVariantIds].sort((left, right) => left - right),
    requestedRetailPriceCents: input.requestedRetailPriceCents,
  });
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
  candidate: DropshipListingCatalogCandidate;
  context: DropshipListingStoreContext;
  config: DropshipStoreListingConfig | null;
  selectionDecision: DropshipVendorCatalogSelectionDecision;
  adminExposureDecision: DropshipCatalogExposureDecision;
  packageReadiness: DropshipListingPackageReadiness | null;
  pricingPolicies: readonly DropshipPricingPolicyRecord[];
  existingListing: DropshipExistingVendorListing | null;
  requestedRetailPriceCents: number | null;
  marketplaceListing: DropshipMarketplaceListingProvider;
  generatedAt: Date;
}): DropshipListingPreviewRow {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!input.selectionDecision.selected) {
    blockers.push(`selection:${input.selectionDecision.reason}`);
  }
  if (!input.config) {
    blockers.push("listing_config_required");
  } else if (input.config.platform !== input.context.platform) {
    blockers.push("listing_config_platform_mismatch");
  }
  const packageReadiness = input.packageReadiness;
  if (!packageReadiness?.hasPackageProfile) {
    blockers.push("package_profile_required");
  }
  if (!packageReadiness?.hasActiveBox) {
    blockers.push("active_box_required");
  }
  if (!packageReadiness?.hasActiveRateTable) {
    blockers.push("active_rate_table_required");
  }

  const priceCents = input.requestedRetailPriceCents
    ?? input.existingListing?.vendorRetailPriceCents
    ?? input.candidate.defaultRetailPriceCents;
  const pricingDecision = evaluateListingPricingPolicy(input.candidate, input.pricingPolicies, priceCents);
  blockers.push(...pricingDecision.blockers);
  warnings.push(...pricingDecision.warnings);

  const marketplaceValidation = input.config
    ? input.marketplaceListing.buildListingIntent({
        config: input.config,
        content: input.candidate,
        priceCents,
        quantity: input.selectionDecision.marketplaceQuantity,
      })
    : { intent: null, blockers: [], warnings: [] };
  blockers.push(...marketplaceValidation.blockers);
  warnings.push(...marketplaceValidation.warnings);

  const previewStatus = blockers.length > 0
    ? "blocked"
    : warnings.length > 0
      ? "warning"
      : "ready";
  const title = input.candidate.title?.trim() || input.candidate.productName;
  const previewHash = hashJson({
    productVariantId: input.candidate.productVariantId,
    storeConnectionId: input.context.storeConnectionId,
    platform: input.context.platform,
    listingMode: input.config?.listingMode ?? null,
    priceCents,
    marketplaceQuantity: input.selectionDecision.marketplaceQuantity,
    blockers,
    warnings,
    intent: marketplaceValidation.intent,
  });

  return {
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
    marketplaceQuantity: input.selectionDecision.marketplaceQuantity,
    priceCents,
    previewHash,
    adminExposureDecision: input.adminExposureDecision,
    selectionDecision: input.selectionDecision,
    listingIntent: marketplaceValidation.intent,
  };
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
    listingIntent: null,
  };
}

function evaluateListingPricingPolicy(
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

function pricingPolicyMatchesCandidate(
  policy: DropshipPricingPolicyRecord,
  candidate: DropshipListingCatalogCandidate,
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
