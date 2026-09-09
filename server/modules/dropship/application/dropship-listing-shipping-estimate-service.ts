import {
  listingShippingEstimateInputSchema,
  listingShippingEstimateResultSchema,
  LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE,
  LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE,
  LISTING_SHIPPING_ESTIMATE_WARNING,
  type ListingShippingEstimateResult,
} from "../../../../shared/dropship/listing-shipping-estimate";
import { evaluateDropshipCatalogExposure } from "../domain/catalog-exposure";
import { DropshipError } from "../domain/errors";
import { normalizeDropshipShippingDestination } from "../domain/shipping-quote";
import { evaluateDropshipVendorCatalogSelection } from "../domain/vendor-selection";
import type { DropshipListingPreviewRepository } from "./dropship-listing-preview-service";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import {
  calculateDropshipShippingQuote,
  type DropshipShippingCalculationDependencies,
} from "./dropship-shipping-quote-service";

export interface ListingShippingEstimateContext {
  vendorId: number;
  storeConnectionId: number;
  vendorStatus: string;
  entitlementStatus: string;
  storeStatus: string;
  defaultWarehouseId: number | null;
  warehouseConfigError: { code: string; message: string } | null;
}

export interface ListingShippingEstimateContextReader {
  loadForMember(memberId: string, storeConnectionId: number): Promise<ListingShippingEstimateContext | null>;
}

export interface DropshipListingShippingEstimateDependencies {
  contexts: ListingShippingEstimateContextReader;
  catalog: Pick<DropshipListingPreviewRepository,
    "listCatalogCandidates" | "listCatalogExposureRules" | "listSelectionRules" | "listVariantOverrides">;
  calculation: DropshipShippingCalculationDependencies;
  clock: DropshipClock;
  logger: DropshipLogger;
}

const UNAVAILABLE_CODES = new Set([
  "DROPSHIP_PACKAGE_PROFILE_REQUIRED",
  "DROPSHIP_CATALOG_PACKAGE_DATA_REQUIRED",
  "DROPSHIP_BOX_CATALOG_REQUIRED",
  "DROPSHIP_PACKAGE_PROFILE_BOX_REQUIRED",
  "DROPSHIP_CARTONIZATION_BLOCKED",
  "DROPSHIP_SHIPPING_MARKUP_POLICY_REQUIRED",
  "DROPSHIP_SHIPPING_INSURANCE_POLICY_REQUIRED",
  "DROPSHIP_SHIPPING_ZONE_REQUIRED",
  "DROPSHIP_SHIPPING_RATE_REQUIRED",
  "DROPSHIP_SHARED_SHIPPING_QUOTE_UNAVAILABLE",
]);

export class DropshipListingShippingEstimateService {
  constructor(private readonly deps: DropshipListingShippingEstimateDependencies) {}

  async estimateForMember(memberId: string, input: unknown): Promise<ListingShippingEstimateResult> {
    const parsed = listingShippingEstimateInputSchema.parse(input);
    if (!memberId.trim()) {
      throw new DropshipError("DROPSHIP_AUTH_REQUIRED", "Dropship authentication is required.");
    }
    const context = await this.deps.contexts.loadForMember(memberId, parsed.storeConnectionId);
    if (!context || context.storeConnectionId !== parsed.storeConnectionId) {
      throw new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Dropship store connection was not found.");
    }
    assertCanEstimate(context);
    const quotedAt = this.deps.clock.now();
    await this.assertVariantSelected(context.vendorId, parsed.productVariantId, quotedAt);
    const scenario = {
      storeConnectionId: parsed.storeConnectionId,
      productVariantId: parsed.productVariantId,
      quantity: parsed.quantity,
      destination: normalizeDropshipShippingDestination(parsed.destination),
      estimatedAt: quotedAt.toISOString(),
    };
    if (context.warehouseConfigError || context.defaultWarehouseId === null
      || !Number.isSafeInteger(context.defaultWarehouseId) || context.defaultWarehouseId <= 0) {
      return this.unavailable(context, scenario, new DropshipError(
        context.warehouseConfigError?.code ?? "DROPSHIP_LISTING_SHIPPING_ORIGIN_REQUIRED",
        context.warehouseConfigError?.message ?? "Listing shipping origin is not configured.",
      ));
    }
    try {
      const result = await calculateDropshipShippingQuote(this.deps.calculation, {
        vendorId: context.vendorId,
        storeConnectionId: context.storeConnectionId,
        warehouseId: context.defaultWarehouseId,
        destination: scenario.destination,
        // Quantity is the number of sellable variants, exactly as in order quotes.
        items: [{ productVariantId: parsed.productVariantId, quantity: parsed.quantity }],
        quotedAt,
      });
      const pricing = result.pricing;
      const hasWarnings = result.cartonization.warnings.length > 0
        || (pricing.source === "shared" && pricing.quote.warnings.length > 0);
      if (hasWarnings) {
        this.deps.logger.warn({
          code: "DROPSHIP_LISTING_SHIPPING_ESTIMATE_WARNINGS",
          message: "Listing shipping estimate has internal calculation warnings.",
          context: {
            vendorId: context.vendorId,
            warehouseId: context.defaultWarehouseId,
            ...scenario,
            packagingWarnings: result.cartonization.warnings,
            rateWarnings: pricing.source === "shared" ? pricing.quote.warnings : [],
          },
        });
      }
      return validateResult({
        ...scenario,
        status: "estimated",
        totalShippingCents: result.totalShippingCents,
        currency: result.currency,
        warnings: hasWarnings ? [LISTING_SHIPPING_ESTIMATE_WARNING] : [],
      });
    } catch (error) {
      if (!(error instanceof DropshipError) || !UNAVAILABLE_CODES.has(error.code)) throw error;
      return this.unavailable(context, scenario, error);
    }
  }

  private unavailable(
    context: ListingShippingEstimateContext,
    scenario: Pick<ListingShippingEstimateResult, "storeConnectionId" | "productVariantId" | "quantity" | "destination" | "estimatedAt">,
    reason: DropshipError,
  ): ListingShippingEstimateResult {
    this.deps.logger.warn({
      code: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE,
      message: "Listing shipping estimate has no usable shipping data.",
      context: { vendorId: context.vendorId, warehouseId: context.defaultWarehouseId, ...scenario,
        reasonCode: reason.code, reasonMessage: reason.message, diagnostic: reason.context },
    });
    return validateResult({ ...scenario, status: "unavailable", code: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE,
      message: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE, warnings: [] });
  }

  private async assertVariantSelected(vendorId: number, productVariantId: number, now: Date): Promise<void> {
    const [candidates, adminRules, rules, overrides] = await Promise.all([
      this.deps.catalog.listCatalogCandidates([productVariantId]),
      this.deps.catalog.listCatalogExposureRules(),
      this.deps.catalog.listSelectionRules(vendorId),
      this.deps.catalog.listVariantOverrides({ vendorId, productVariantIds: [productVariantId] }),
    ]);
    const candidate = candidates.find((row) => row.productVariantId === productVariantId);
    if (candidate) {
      const decision = evaluateDropshipVendorCatalogSelection({
        candidate,
        adminExposureDecision: evaluateDropshipCatalogExposure(candidate, adminRules, now),
        rules,
        override: overrides.find((row) => row.productVariantId === productVariantId) ?? null,
        // Selection does not depend on ATP. An estimate is not an inventory promise.
        rawAtpUnits: 0,
      });
      if (decision.selected) return;
    }
    throw new DropshipError("DROPSHIP_LISTING_SHIPPING_VARIANT_NOT_SELECTED", "Shipping estimates are available only for products exposed by Card Shellz and selected in your catalog.");
  }
}

function assertCanEstimate(context: ListingShippingEstimateContext): void {
  if (context.vendorStatus !== "active" && context.vendorStatus !== "onboarding") {
    throw new DropshipError("DROPSHIP_LISTING_VENDOR_BLOCKED", "Dropship vendor status does not allow listing shipping estimates.");
  }
  if (context.entitlementStatus !== "active") {
    throw new DropshipError("DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "Active dropship entitlement is required for listing shipping estimates.");
  }
  if (context.storeStatus !== "connected") {
    throw new DropshipError("DROPSHIP_LISTING_STORE_BLOCKED", "A connected store is required for listing shipping estimates.");
  }
  // Launch setup and wallet funding gate mutations, not this read-only estimate.
}

function validateResult(result: ListingShippingEstimateResult): ListingShippingEstimateResult {
  const parsed = listingShippingEstimateResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new DropshipError("DROPSHIP_LISTING_SHIPPING_ESTIMATE_INVALID", "Shipping estimate returned invalid data.");
  }
  return parsed.data;
}
