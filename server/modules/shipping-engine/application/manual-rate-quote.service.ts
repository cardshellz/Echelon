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
  quoteShipment,
  type ShipmentQuoteRequest,
  type ShipmentQuoteResult,
} from "./shipment-quote.service";
import { localRateTableShippingRateProvider } from "./shipping-rate-provider";
import { weightOnlyParcelProvider } from "./weight-only-parcel.provider";
import {
  ECHELON_MANAGED_COUNTRY_CODE,
} from "../domain/destination-rate-ownership";
import {
  getShippingChannelProfile,
  type ShippingRatePurpose,
  type ShippingSalesChannel,
} from "../domain/shipping-channel";
import { normalizeUsPostalRegion } from "../domain/us-geography";
import {
  loadCatalogShippingFactsBySku,
  type CatalogShippingFact,
} from "../infrastructure/catalog-weight.repository";

export type ManualRateQuoteOutcome =
  | "quoted"
  | "no_rate"
  | "rate_book_mismatch";

export interface ManualRateQuoteLineInput {
  sku: string;
  quantity: number;
}

export interface ManualRateQuoteInput {
  expectedRateBookId: number;
  pricingChannel: ShippingSalesChannel;
  ratePurpose: ShippingRatePurpose;
  originWarehouseId: number;
  destinationCountry: string;
  destinationRegion: string;
  destinationPostalCode: string;
  billableWeightGrams?: number;
  lines?: readonly ManualRateQuoteLineInput[];
}

export type ManualRateQuoteTestedShipment =
  | {
      basis: "weight";
      billableWeightGrams: number;
      lines: [];
    }
  | {
      basis: "catalog_lines";
      billableWeightGrams: number;
      lines: Array<{
        sku: string;
        productVariantId: number;
        quantity: number;
        unitWeightGrams: number;
      }>;
    };

export interface ManualRateQuoteResult {
  outcome: ManualRateQuoteOutcome;
  testedAt: string;
  rateOwner: "echelon";
  destination: {
    country: string;
    region: string;
    postalCode: string;
  };
  testedShipment: ManualRateQuoteTestedShipment;
  rateBook: RateQuoteResult["rateBook"];
  zone: string | null;
  quotes: RateQuoteLine[];
  warnings: string[];
}

type QuoteManualCartShipment = (
  request: ShipmentQuoteRequest,
) => Promise<ShipmentQuoteResult>;

export interface ManualRateQuoteDependencies {
  quoteShipmentRates: typeof quoteShipmentRates;
  quoteCartShipment: QuoteManualCartShipment;
  loadCatalogShippingFactsBySku: typeof loadCatalogShippingFactsBySku;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: ManualRateQuoteDependencies = {
  quoteShipmentRates,
  quoteCartShipment: (request) => quoteShipment(request, {
    parcelProvider: weightOnlyParcelProvider,
    rateProvider: localRateTableShippingRateProvider,
  }),
  loadCatalogShippingFactsBySku,
  now: () => new Date(),
};

const MAX_MANUAL_RATE_TEST_LINES = 50;
const MAX_MANUAL_LINE_QUANTITY = 10_000;

export async function runManualRateQuote(
  input: ManualRateQuoteInput,
  dependencies: ManualRateQuoteDependencies = DEFAULT_DEPENDENCIES,
): Promise<ManualRateQuoteResult> {
  assertPositiveInteger(input.expectedRateBookId, "expectedRateBookId");
  assertPositiveInteger(input.originWarehouseId, "originWarehouseId");
  assertTestBasis(input);

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
      "A valid United States postal region is required.",
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
  const { quote, testedShipment, parcelWarnings } = input.lines
    ? await quoteCatalogLines({
        input,
        country,
        region,
        postalCode,
        testedAt,
        dependencies,
      })
    : await quoteWeight({
        input,
        country,
        region,
        postalCode,
        testedAt,
        dependencies,
      });

  const warnings = [...parcelWarnings, ...quote.warnings];
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
    testedShipment,
    rateBook: quote.rateBook,
    zone: quote.zone,
    quotes: quote.quotes,
    warnings,
  };
}

async function quoteWeight(input: {
  input: ManualRateQuoteInput;
  country: string;
  region: string;
  postalCode: string;
  testedAt: Date;
  dependencies: ManualRateQuoteDependencies;
}): Promise<{
  quote: RateQuoteResult;
  testedShipment: ManualRateQuoteTestedShipment;
  parcelWarnings: string[];
}> {
  const billableWeightGrams = input.input.billableWeightGrams;
  if (billableWeightGrams === undefined) {
    throw invalidTestBasisError(input.input);
  }
  const quote = await input.dependencies.quoteShipmentRates({
    rateContext: {
      pricingChannel: input.input.pricingChannel,
      purpose: input.input.ratePurpose,
    },
    originWarehouseId: input.input.originWarehouseId,
    destCountry: input.country,
    destRegion: input.region,
    destPostal: input.postalCode,
    parcels: [{ billableWeightGrams }],
  }, {
    quotedAt: input.testedAt,
    persistSnapshot: true,
  });
  return {
    quote,
    testedShipment: {
      basis: "weight",
      billableWeightGrams,
      lines: [],
    },
    parcelWarnings: [],
  };
}

async function quoteCatalogLines(input: {
  input: ManualRateQuoteInput;
  country: string;
  region: string;
  postalCode: string;
  testedAt: Date;
  dependencies: ManualRateQuoteDependencies;
}): Promise<{
  quote: RateQuoteResult;
  testedShipment: ManualRateQuoteTestedShipment;
  parcelWarnings: string[];
}> {
  const requestedLines = input.input.lines;
  if (requestedLines === undefined) {
    throw invalidTestBasisError(input.input);
  }
  const normalizedLines = requestedLines.map((line) => ({
    sku: line.sku.trim(),
    quantity: line.quantity,
  }));
  const factsBySku = await input.dependencies.loadCatalogShippingFactsBySku(
    normalizedLines.map((line) => line.sku),
  );
  assertCatalogFactsComplete(normalizedLines, factsBySku);

  const lines = normalizedLines.map((line) => {
    const fact = factsBySku.get(line.sku)!;
    return {
      sku: line.sku,
      productVariantId: fact.productVariantId,
      quantity: line.quantity,
      unitWeightGrams: fact.weightGrams!,
      weightSource: "echelon_catalog" as const,
      shippingGroupCode: fact.shippingGroupCode,
      shipsInOwnContainer: fact.shipsInOwnContainer,
    };
  });
  const shipmentQuote = await input.dependencies.quoteCartShipment({
    channel: input.input.pricingChannel,
    ratePurpose: input.input.ratePurpose,
    originWarehouseId: input.input.originWarehouseId,
    destination: {
      country: input.country,
      region: input.region,
      postalCode: input.postalCode,
    },
    lines,
    quotedAt: input.testedAt,
    persistSnapshot: true,
  });
  if (!shipmentQuote.ok) {
    throw new ManualRateQuoteError(
      "SHIPPING_RATE_TEST_SHIPMENT_INVALID",
      "The catalog lines could not be rated.",
      {
        reasonCode: shipmentQuote.code,
        errors: shipmentQuote.errors,
      },
    );
  }

  return {
    quote: shipmentQuote.rates,
    testedShipment: {
      basis: "catalog_lines",
      billableWeightGrams: shipmentQuote.parcelPlan.parcels.reduce(
        (sum, parcel) => sum + parcel.billableWeightGrams,
        0,
      ),
      lines: lines.map((line) => ({
        sku: line.sku,
        productVariantId: line.productVariantId,
        quantity: line.quantity,
        unitWeightGrams: line.unitWeightGrams,
      })),
    },
    parcelWarnings: shipmentQuote.parcelPlan.warnings,
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

function assertTestBasis(input: ManualRateQuoteInput): void {
  const hasWeight = input.billableWeightGrams !== undefined;
  const hasLines = input.lines !== undefined;
  if (hasWeight === hasLines) {
    throw invalidTestBasisError(input);
  }
  if (hasWeight) {
    assertPositiveInteger(input.billableWeightGrams!, "billableWeightGrams");
    return;
  }
  const lines = input.lines!;
  if (lines.length === 0 || lines.length > MAX_MANUAL_RATE_TEST_LINES) {
    throw new ManualRateQuoteError(
      "SHIPPING_RATE_TEST_INPUT_INVALID",
      `lines must contain between 1 and ${MAX_MANUAL_RATE_TEST_LINES} items.`,
      { lineCount: lines.length },
    );
  }
  lines.forEach((line, index) => {
    const sku = line.sku.trim();
    if (sku.length === 0 || sku.length > 255) {
      throw new ManualRateQuoteError(
        "SHIPPING_RATE_TEST_INPUT_INVALID",
        "Each test line requires a valid SKU.",
        { line: index + 1, sku: line.sku },
      );
    }
    if (
      !Number.isSafeInteger(line.quantity)
      || line.quantity <= 0
      || line.quantity > MAX_MANUAL_LINE_QUANTITY
    ) {
      throw new ManualRateQuoteError(
        "SHIPPING_RATE_TEST_INPUT_INVALID",
        `Line quantity must be between 1 and ${MAX_MANUAL_LINE_QUANTITY}.`,
        { line: index + 1, quantity: line.quantity },
      );
    }
  });
}

function invalidTestBasisError(input: ManualRateQuoteInput): ManualRateQuoteError {
  return new ManualRateQuoteError(
    "SHIPPING_RATE_TEST_INPUT_INVALID",
    "Provide either one billable shipment weight or catalog lines, but not both.",
    {
      hasBillableWeight: input.billableWeightGrams !== undefined,
      hasLines: input.lines !== undefined,
    },
  );
}

function assertCatalogFactsComplete(
  lines: readonly ManualRateQuoteLineInput[],
  factsBySku: ReadonlyMap<string, CatalogShippingFact>,
): void {
  const unknownSkus = [...new Set(
    lines
      .map((line) => line.sku)
      .filter((sku) => !factsBySku.has(sku)),
  )];
  if (unknownSkus.length > 0) {
    throw new ManualRateQuoteError(
      "SHIPPING_RATE_TEST_SKU_NOT_FOUND",
      "One or more SKUs do not exist in the Echelon catalog.",
      { skus: unknownSkus },
    );
  }
  const missingWeightSkus = [...new Set(
    lines
      .map((line) => line.sku)
      .filter((sku) => {
        const weight = factsBySku.get(sku)?.weightGrams;
        return !Number.isSafeInteger(weight) || (weight ?? 0) <= 0;
      }),
  )];
  if (missingWeightSkus.length > 0) {
    throw new ManualRateQuoteError(
      "SHIPPING_RATE_TEST_SKU_WEIGHT_MISSING",
      "One or more SKUs are missing a valid Echelon catalog weight.",
      { skus: missingWeightSkus },
    );
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
