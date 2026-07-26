import {
  DROPSHIP_DEFAULT_SHIPPING_CURRENCY,
  type DropshipCartonizedPackage,
} from "../domain/shipping-quote";
import { DropshipError } from "../domain/errors";
import type { DropshipLogger } from "./dropship-ports";
import type {
  DropshipSharedShippingQuoteProvider,
  DropshipSharedShippingQuoteRequest,
  DropshipSharedShippingQuoteResult,
} from "./dropship-shared-shipping-quote";
import {
  resolveDropshipShippingCutover,
  type DropshipShippingCutoverDecision,
  type DropshipShippingCutoverPolicy,
} from "./dropship-shipping-cutover-policy";
import type {
  DropshipShippingRateMatch,
  DropshipShippingRateProvider,
  DropshipShippingRateResult,
  DropshipShippingZoneMatch,
} from "./dropship-shipping-rate-provider";

export type DropshipShippingPricingResult =
  | {
      source: "legacy";
      decision: Extract<
        DropshipShippingCutoverDecision,
        { source: "legacy" }
      >;
      baseRateCents: number;
      currency: string;
      rateTableId: number | null;
      zone: DropshipShippingZoneMatch;
      rateMatches: DropshipShippingRateMatch[];
      rateProvider: DropshipShippingRateResult["provider"];
    }
  | {
      source: "shared";
      decision: Extract<
        DropshipShippingCutoverDecision,
        { source: "shared" }
      >;
      baseRateCents: number;
      currency: string;
      rateTableId: number;
      quote: Extract<DropshipSharedShippingQuoteResult, { status: "quoted" }>;
    };

export interface DropshipShippingPricingRequest
extends Omit<DropshipSharedShippingQuoteRequest, "packages"> {
  packages: DropshipCartonizedPackage[];
}

export interface DropshipShippingPricingProvider {
  quote(
    input: DropshipShippingPricingRequest,
  ): Promise<DropshipShippingPricingResult>;
}

export interface CutoverDropshipShippingPricingDependencies {
  cutoverPolicy: DropshipShippingCutoverPolicy;
  legacyRateProvider: DropshipShippingRateProvider;
  sharedQuoteProvider: DropshipSharedShippingQuoteProvider;
  logger: DropshipLogger;
}

export class CutoverDropshipShippingPricingProvider
implements DropshipShippingPricingProvider {
  constructor(
    private readonly deps: CutoverDropshipShippingPricingDependencies,
  ) {}

  async quote(
    input: DropshipShippingPricingRequest,
  ): Promise<DropshipShippingPricingResult> {
    const decision = resolveDropshipShippingCutover(
      this.deps.cutoverPolicy,
      input.storeConnectionId,
    );
    if (decision.source === "legacy") {
      return this.quoteLegacy(input, decision);
    }
    return this.quoteShared(input, decision);
  }

  private async quoteLegacy(
    input: DropshipShippingPricingRequest,
    decision: Extract<DropshipShippingCutoverDecision, { source: "legacy" }>,
  ): Promise<Extract<DropshipShippingPricingResult, { source: "legacy" }>> {
    const ratedPackages = await this.deps.legacyRateProvider.quoteRates({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      warehouseId: input.warehouseId,
      destination: input.destination,
      packages: input.packages,
      quotedAt: input.quotedAt,
    });
    assertEveryPackageHasRate(input.packages, ratedPackages.rates);

    return {
      source: "legacy",
      decision,
      baseRateCents: sumCents(
        ratedPackages.rates.map((rate) => rate.rateCents),
      ),
      currency: assertSingleCurrency(ratedPackages.rates),
      rateTableId: resolveSnapshotRateTableId(ratedPackages.rates),
      zone: ratedPackages.zone,
      rateMatches: ratedPackages.rates,
      rateProvider: ratedPackages.provider,
    };
  }

  private async quoteShared(
    input: DropshipShippingPricingRequest,
    decision: Extract<DropshipShippingCutoverDecision, { source: "shared" }>,
  ): Promise<Extract<DropshipShippingPricingResult, { source: "shared" }>> {
    let quote: DropshipSharedShippingQuoteResult;
    try {
      quote = await this.deps.sharedQuoteProvider.quote(input);
    } catch (error) {
      this.deps.logger.error({
        code: "DROPSHIP_SHARED_SHIPPING_QUOTE_FAILED",
        message: "Shared dropship shipping quote failed.",
        context: {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          warehouseId: input.warehouseId,
          cutoverMode: decision.mode,
          cutoverReasonCode: decision.reasonCode,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new DropshipError(
        "DROPSHIP_SHARED_SHIPPING_QUOTE_FAILED",
        "Shared shipping rate could not be calculated.",
        {
          storeConnectionId: input.storeConnectionId,
          cutoverMode: decision.mode,
        },
      );
    }

    if (quote.status === "unavailable") {
      this.deps.logger.warn({
        code: "DROPSHIP_SHARED_SHIPPING_QUOTE_UNAVAILABLE",
        message: "Shared dropship shipping quote returned no usable rate.",
        context: {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          warehouseId: input.warehouseId,
          cutoverMode: decision.mode,
          cutoverReasonCode: decision.reasonCode,
          sharedCode: quote.code,
          warnings: quote.warnings,
          routing: quote.routing,
        },
      });
      throw new DropshipError(
        "DROPSHIP_SHARED_SHIPPING_QUOTE_UNAVAILABLE",
        "No shared shipping rate is available for this shipment.",
        {
          storeConnectionId: input.storeConnectionId,
          sharedCode: quote.code,
        },
      );
    }

    try {
      assertValidSharedQuote(quote);
    } catch (error) {
      this.deps.logger.error({
        code: "DROPSHIP_SHARED_SHIPPING_QUOTE_INVALID",
        message: "Shared dropship shipping quote failed contract validation.",
        context: {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          warehouseId: input.warehouseId,
          cutoverMode: decision.mode,
          cutoverReasonCode: decision.reasonCode,
          rateBookId: quote.rateBookId,
          rateTableId: quote.rateTableId,
          serviceLevelCode: quote.serviceLevelCode,
        },
      });
      throw error;
    }
    return {
      source: "shared",
      decision,
      baseRateCents: quote.baseRateCents,
      currency: quote.currency,
      rateTableId: quote.rateTableId,
      quote,
    };
  }
}

function assertEveryPackageHasRate(
  packages: readonly DropshipCartonizedPackage[],
  rateMatches: readonly DropshipShippingRateMatch[],
): void {
  const ratedSequences = new Set(
    rateMatches.map((rate) => rate.packageSequence),
  );
  const missingPackage = packages.find(
    (carton) => !ratedSequences.has(carton.packageSequence),
  );
  if (missingPackage) {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_RATE_REQUIRED",
      "Active dropship shipping rate data is required before quoting shipping.",
      { packageSequence: missingPackage.packageSequence },
    );
  }
}

function assertSingleCurrency(
  rateMatches: readonly DropshipShippingRateMatch[],
): string {
  const currencies = new Set(rateMatches.map((rate) => rate.currency));
  if (currencies.size !== 1) {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_RATE_CURRENCY_MISMATCH",
      "Dropship shipping quote cannot combine rates with different currencies.",
      { currencies: [...currencies] },
    );
  }
  return rateMatches[0]?.currency ?? DROPSHIP_DEFAULT_SHIPPING_CURRENCY;
}

function sumCents(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (
      !Number.isSafeInteger(value)
      || value < 0
      || !Number.isSafeInteger(total + value)
    ) {
      throw new DropshipError(
        "DROPSHIP_SHIPPING_RATE_INVALID",
        "Dropship shipping rate contains an invalid cent amount.",
      );
    }
    total += value;
  }
  return total;
}

function resolveSnapshotRateTableId(
  rateMatches: readonly DropshipShippingRateMatch[],
): number | null {
  const uniqueRateTableIds = new Set(
    rateMatches.map((rate) => rate.rateTableId),
  );
  return uniqueRateTableIds.size === 1
    ? rateMatches[0]?.rateTableId ?? null
    : null;
}

function assertValidSharedQuote(
  quote: Extract<DropshipSharedShippingQuoteResult, { status: "quoted" }>,
): void {
  if (
    !Number.isSafeInteger(quote.baseRateCents)
    || quote.baseRateCents < 0
    || quote.currency.trim().length === 0
    || !Number.isSafeInteger(quote.rateBookId)
    || quote.rateBookId <= 0
    || !Number.isSafeInteger(quote.rateTableId)
    || quote.rateTableId <= 0
    || quote.selectedRate.totalCents !== quote.baseRateCents
    || quote.selectedRate.currency !== quote.currency
    || quote.selectedRate.serviceLevelCode !== quote.serviceLevelCode
    || quote.selectedRate.rateTableId !== quote.rateTableId
    || quote.rateProvider.name.trim().length === 0
    || quote.rateProvider.version.trim().length === 0
  ) {
    throw new DropshipError(
      "DROPSHIP_SHARED_SHIPPING_QUOTE_INVALID",
      "Shared shipping engine returned an invalid rate result.",
    );
  }
}
