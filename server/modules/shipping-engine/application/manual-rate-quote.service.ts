/**
 * Operator-initiated shipping-rate verification.
 *
 * This exercises the same active assignment and rate-table selection used by
 * runtime quotes, then persists the quote as a manual snapshot. Draft tables
 * are intentionally excluded: an operator must activate a revision before it
 * can pass this production-path test.
 */

import {
  quoteShipmentRates,
  type RateQuoteLine,
  type RateQuoteResult,
} from "./rate-quote.service";
import {
  ECHELON_MANAGED_COUNTRY_CODE,
} from "../domain/destination-rate-ownership";
import {
  getShippingChannelProfile,
  type ShippingRatePurpose,
  type ShippingSalesChannel,
} from "../domain/shipping-channel";
import { normalizeUsPostalRegion } from "../domain/us-geography";

export type ManualRateQuoteOutcome =
  | "quoted"
  | "no_rate"
  | "rate_book_mismatch";

export interface ManualRateQuoteInput {
  expectedRateBookId: number;
  pricingChannel: ShippingSalesChannel;
  ratePurpose: ShippingRatePurpose;
  originWarehouseId: number;
  destinationCountry: string;
  destinationRegion: string;
  destinationPostalCode: string;
  billableWeightGrams: number;
}

export interface ManualRateQuoteResult {
  outcome: ManualRateQuoteOutcome;
  testedAt: string;
  rateOwner: "echelon";
  destination: {
    country: string;
    region: string;
    postalCode: string;
  };
  rateBook: RateQuoteResult["rateBook"];
  zone: string | null;
  quotes: RateQuoteLine[];
  warnings: string[];
}

export interface ManualRateQuoteDependencies {
  quoteShipmentRates: typeof quoteShipmentRates;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: ManualRateQuoteDependencies = {
  quoteShipmentRates,
  now: () => new Date(),
};

export async function runManualRateQuote(
  input: ManualRateQuoteInput,
  dependencies: ManualRateQuoteDependencies = DEFAULT_DEPENDENCIES,
): Promise<ManualRateQuoteResult> {
  assertPositiveInteger(input.expectedRateBookId, "expectedRateBookId");
  assertPositiveInteger(input.originWarehouseId, "originWarehouseId");
  assertPositiveInteger(input.billableWeightGrams, "billableWeightGrams");

  const country = input.destinationCountry.trim().toUpperCase();
  if (country !== ECHELON_MANAGED_COUNTRY_CODE) {
    throw new ManualRateQuoteError(
      "SHIPPING_RATE_TEST_US_ONLY",
      "Echelon currently owns United States rates only. Test international rates in Shopify/Global-e.",
      { destinationCountry: country },
    );
  }

  const region = normalizeUsPostalRegion(input.destinationRegion);
  if (region === null) {
    throw new ManualRateQuoteError(
      "SHIPPING_RATE_TEST_REGION_INVALID",
      "A valid United States state or territory is required.",
      { destinationRegion: input.destinationRegion },
    );
  }

  const postalCode = normalizeUsPostalCode(input.destinationPostalCode);
  if (postalCode === null) {
    throw new ManualRateQuoteError(
      "SHIPPING_RATE_TEST_POSTAL_INVALID",
      "A valid five-digit United States ZIP code is required.",
      { destinationPostalCode: input.destinationPostalCode },
    );
  }

  const profile = getShippingChannelProfile(input.pricingChannel);
  if (profile.quoteMode !== "runtime_quote") {
    throw new ManualRateQuoteError(
      "SHIPPING_RATE_TEST_CHANNEL_EXTERNAL",
      `${input.pricingChannel} uses marketplace-owned checkout rates and cannot be tested here.`,
      { pricingChannel: input.pricingChannel },
    );
  }
  if (profile.ratePurpose !== input.ratePurpose) {
    throw new ManualRateQuoteError(
      "SHIPPING_RATE_TEST_CONTEXT_INVALID",
      "The selected pricing channel and purpose are not a valid runtime quote context.",
      {
        pricingChannel: input.pricingChannel,
        suppliedPurpose: input.ratePurpose,
        expectedPurpose: profile.ratePurpose,
      },
    );
  }

  const testedAt = dependencies.now();
  const quote = await dependencies.quoteShipmentRates({
    rateContext: {
      pricingChannel: input.pricingChannel,
      purpose: input.ratePurpose,
    },
    originWarehouseId: input.originWarehouseId,
    destCountry: country,
    destRegion: region,
    destPostal: postalCode,
    parcels: [{ billableWeightGrams: input.billableWeightGrams }],
  }, {
    quotedAt: testedAt,
    persistSnapshot: true,
  });

  const warnings = [...quote.warnings];
  let outcome: ManualRateQuoteOutcome;
  if (quote.rateBook !== null && quote.rateBook.id !== input.expectedRateBookId) {
    outcome = "rate_book_mismatch";
    warnings.push(
      `Runtime assignment selected rate book ${quote.rateBook.id}, not expected rate book ${input.expectedRateBookId}.`,
    );
  } else if (quote.rateBook === null || quote.quotes.length === 0) {
    outcome = "no_rate";
  } else {
    outcome = "quoted";
  }

  return {
    outcome,
    testedAt: testedAt.toISOString(),
    rateOwner: "echelon",
    destination: { country, region, postalCode },
    rateBook: quote.rateBook,
    zone: quote.zone,
    quotes: quote.quotes,
    warnings,
  };
}

export class ManualRateQuoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown>,
  ) {
    super(message);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ManualRateQuoteError(
      "SHIPPING_RATE_TEST_INPUT_INVALID",
      `${field} must be a positive whole number.`,
      { field, value },
    );
  }
}

function normalizeUsPostalCode(value: string): string | null {
  const postalCode = value.trim();
  const match = /^(\d{5})(?:-\d{4})?$/.exec(postalCode);
  return match?.[1] ?? null;
}
