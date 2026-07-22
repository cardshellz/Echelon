/**
 * Channel-neutral service-level rating orchestration.
 *
 * Rate books define what a channel charges for Card Shellz-owned shipping
 * options. Carrier methods and purchase cost belong to the later fulfillment
 * selection layer and are deliberately absent from this contract.
 */

import { createHash } from "crypto";
import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";
import {
  shippingQuoteSnapshots,
  shippingRateTableRows,
  shippingRateTables,
  shippingServiceLevels,
  shippingZoneRules,
} from "@shared/schema";
import { db } from "../../../db";
import {
  selectServiceLevelRates,
  type RateCandidateRow,
  type ShippingFulfillmentMode,
  type ShippingPricingBasis,
  type ShippingRateChargeModel,
} from "../domain/rate-selection";
import { selectRateBookAssignment } from "../domain/rate-book";
import type { ShippingRateContext } from "../domain/shipping-channel";
import { resolveZone, type ZoneRule } from "../domain/zones";
import { loadActiveRateBookAssignments } from "../infrastructure/rate-book.repository";

export const RATE_QUOTE_ENGINE = { name: "cardshellz-rates", version: "2.0.0" } as const;

export interface RateQuoteParcel {
  billableWeightGrams: number;
}

export type FreightAccessorial =
  | "appointment"
  | "inside_delivery"
  | "liftgate"
  | "limited_access"
  | "residential";

export interface FreightRatingContext {
  palletCount: number;
  /** Includes pallet/platform weight when known. */
  totalWeightGrams?: number | null;
  freightClass?: string | null;
  accessorials?: readonly FreightAccessorial[];
}

export interface RateQuoteRequest {
  rateContext: ShippingRateContext;
  originWarehouseId: number;
  destCountry: string;
  destRegion?: string | null;
  destPostal: string;
  parcels: RateQuoteParcel[];
  freight?: FreightRatingContext | null;
}

export interface RateQuoteOptions {
  /** Injected clock for effective-dating; defaults to now. */
  quotedAt?: Date;
  /** Persist a shipping.quote_snapshots row (source 'manual'). Default OFF. */
  persistSnapshot?: boolean;
}

export interface RateQuoteLine {
  serviceLevelId: number;
  serviceLevelCode: string;
  displayName: string;
  description: string | null;
  fulfillmentMode: ShippingFulfillmentMode;
  pricingBasis: ShippingPricingBasis;
  totalCents: number;
  currency: string;
  promiseMinBusinessDays: number | null;
  promiseMaxBusinessDays: number | null;
  ratedMeasure: number;
  maxShipmentWeightGrams: number | null;
  chargeModel: RateCandidateRow["chargeModel"];
  perStartedPoundCents: number | null;
  billablePounds: number | null;
}

export interface RateQuoteResult {
  rateBook: { id: number; code: string } | null;
  zone: string | null;
  quotes: RateQuoteLine[];
  warnings: string[];
}

export async function quoteShipmentRates(
  request: RateQuoteRequest,
  opts: RateQuoteOptions = {},
): Promise<RateQuoteResult> {
  const quotedAt = opts.quotedAt ?? new Date();
  const warnings: string[] = [];

  const destCountry = request.destCountry.trim().toUpperCase();
  const destRegion = request.destRegion?.trim().toUpperCase() || null;
  const destPostal = request.destPostal.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(destCountry)) {
    warnings.push(`destination country ${JSON.stringify(request.destCountry)} is not a 2-letter ISO code`);
    return { rateBook: null, zone: null, quotes: [], warnings };
  }
  if (destRegion === null || !/^[A-Z]{2}$/.test(destRegion)) {
    warnings.push("destination state or region is required to select a rate table");
    return { rateBook: null, zone: null, quotes: [], warnings };
  }
  if (request.parcels.length === 0 && !request.freight) {
    warnings.push("no shipment measure to rate");
    return { rateBook: null, zone: null, quotes: [], warnings };
  }
  if (
    request.freight
    && (!Number.isInteger(request.freight.palletCount) || request.freight.palletCount <= 0)
  ) {
    warnings.push("freight pallet count must be a positive whole number");
    return { rateBook: null, zone: null, quotes: [], warnings };
  }
  if (
    request.freight?.totalWeightGrams !== null
    && request.freight?.totalWeightGrams !== undefined
    && (
      !Number.isFinite(request.freight.totalWeightGrams)
      || request.freight.totalWeightGrams < 0
    )
  ) {
    warnings.push("freight total weight must be zero or greater");
    return { rateBook: null, zone: null, quotes: [], warnings };
  }

  const candidates = await loadActiveRateBookAssignments(
    request.rateContext,
    request.originWarehouseId,
  );
  const selection = selectRateBookAssignment(candidates, {
    ...request.rateContext,
    originWarehouseId: request.originWarehouseId,
  });
  if (!selection.ok) {
    warnings.push(selection.message);
    await maybePersistSnapshot({
      request, destCountry, destPostal, rateBook: null, zone: null,
      quotes: [], quotedAt, warnings, opts,
    });
    return { rateBook: null, zone: null, quotes: [], warnings };
  }
  const rateBook = {
    id: selection.assignment.rateBookId,
    code: selection.assignment.rateBookCode,
  };

  // Zones remain useful for transit observability and later carrier-method
  // enforcement, but customer charge selection no longer depends on them.
  const zone = await resolveZoneForOrigin(
    selection.assignment.zoneSetId,
    request.originWarehouseId,
    destCountry,
    destPostal,
    destRegion,
  );
  const candidateRows = await loadCandidateRows(
    rateBook.id,
    request.originWarehouseId,
    destCountry,
    destRegion,
    quotedAt,
  );
  const parcelWeightGrams = request.parcels.reduce(
    (sum, parcel) => sum + Math.max(0, parcel.billableWeightGrams),
    0,
  );
  const shipmentWeightGrams = request.freight?.totalWeightGrams ?? parcelWeightGrams;
  const quotes = selectServiceLevelRates(candidateRows, {
    destinationCountry: destCountry,
    destinationRegion: destRegion,
    destinationPostal: destPostal,
    shipmentWeightGrams,
    palletCount: request.freight?.palletCount ?? null,
    originWarehouseId: request.originWarehouseId,
  }).map((quote) => ({
    serviceLevelId: quote.serviceLevelId,
    serviceLevelCode: quote.serviceLevelCode,
    displayName: quote.displayName,
    description: quote.description,
    fulfillmentMode: quote.fulfillmentMode,
    pricingBasis: quote.pricingBasis,
    totalCents: quote.rateCents,
    currency: quote.currency.toUpperCase(),
    promiseMinBusinessDays: quote.promiseMinBusinessDays,
    promiseMaxBusinessDays: quote.promiseMaxBusinessDays,
    ratedMeasure: quote.ratedMeasure,
    maxShipmentWeightGrams: quote.maxShipmentWeightGrams,
    chargeModel: quote.chargeModel,
    perStartedPoundCents: quote.perStartedPoundCents,
    billablePounds: quote.billablePounds,
  }));

  if (!request.freight && candidateRows.some((row) => row.pricingBasis === "pallet_count")) {
    warnings.push("pallet freight was not quoted because pallet count was not provided");
  }
  if (quotes.length === 0) {
    warnings.push(
      `no active service-level rate covers ${destCountry} ${destRegion} ${destPostal}`,
    );
  }

  await maybePersistSnapshot({ request, destCountry, destPostal, rateBook, zone, quotes, quotedAt, warnings, opts });
  return { rateBook, zone, quotes, warnings };
}

async function resolveZoneForOrigin(
  zoneSetId: number,
  originWarehouseId: number,
  destCountry: string,
  destPostal: string,
  destRegion: string | null,
): Promise<string | null> {
  const rules: ZoneRule[] = await db
    .select({
      id: shippingZoneRules.id,
      destinationCountry: shippingZoneRules.destinationCountry,
      destinationRegion: shippingZoneRules.destinationRegion,
      postalPrefix: shippingZoneRules.postalPrefix,
      zone: shippingZoneRules.zone,
      priority: shippingZoneRules.priority,
      isActive: shippingZoneRules.isActive,
    })
    .from(shippingZoneRules)
    .where(and(
      eq(shippingZoneRules.zoneSetId, zoneSetId),
      eq(shippingZoneRules.originWarehouseId, originWarehouseId),
      eq(shippingZoneRules.isActive, true),
    ));
  return resolveZone(rules, destCountry, destPostal, destRegion);
}

async function loadCandidateRows(
  rateBookId: number,
  originWarehouseId: number,
  destinationCountry: string,
  destinationRegion: string,
  quotedAt: Date,
): Promise<RateCandidateRow[]> {
  const rows = await db
    .select({
      rateTableId: shippingRateTableRows.rateTableId,
      serviceLevelId: shippingServiceLevels.id,
      serviceLevelCode: shippingServiceLevels.code,
      displayName: shippingServiceLevels.displayName,
      description: shippingServiceLevels.description,
      fulfillmentMode: shippingServiceLevels.fulfillmentMode,
      pricingBasis: shippingRateTables.pricingBasis,
      sortOrder: shippingServiceLevels.sortOrder,
      promiseMinBusinessDays: shippingServiceLevels.promiseMinBusinessDays,
      promiseMaxBusinessDays: shippingServiceLevels.promiseMaxBusinessDays,
      currency: shippingRateTables.currency,
      originWarehouseId: shippingRateTableRows.originWarehouseId,
      destinationCountry: shippingRateTableRows.destinationCountry,
      destinationRegion: shippingRateTableRows.destinationRegion,
      postalPrefix: shippingRateTableRows.postalPrefix,
      minMeasure: shippingRateTableRows.minMeasure,
      maxMeasure: shippingRateTableRows.maxMeasure,
      maxShipmentWeightGrams: shippingRateTableRows.maxShipmentWeightGrams,
      chargeModel: shippingRateTableRows.chargeModel,
      rateCents: shippingRateTableRows.rateCents,
      perStartedPoundCents: shippingRateTableRows.perStartedPoundCents,
    })
    .from(shippingRateTableRows)
    .innerJoin(shippingRateTables, eq(shippingRateTableRows.rateTableId, shippingRateTables.id))
    .innerJoin(shippingServiceLevels, eq(shippingRateTables.serviceLevelId, shippingServiceLevels.id))
    .where(and(
      eq(shippingRateTables.rateBookId, rateBookId),
      eq(shippingRateTables.status, "active"),
      eq(shippingServiceLevels.isActive, true),
      lte(shippingRateTables.effectiveFrom, quotedAt),
      or(isNull(shippingRateTables.effectiveTo), gt(shippingRateTables.effectiveTo, quotedAt)),
      eq(shippingRateTableRows.destinationCountry, destinationCountry),
      eq(shippingRateTableRows.destinationRegion, destinationRegion),
      or(
        isNull(shippingRateTableRows.originWarehouseId),
        eq(shippingRateTableRows.originWarehouseId, originWarehouseId),
      ),
    ))
    .orderBy(asc(shippingServiceLevels.sortOrder), asc(shippingServiceLevels.code));
  return rows.map((row) => ({
    ...row,
    fulfillmentMode: row.fulfillmentMode as ShippingFulfillmentMode,
    pricingBasis: row.pricingBasis as ShippingPricingBasis,
    chargeModel: row.chargeModel as ShippingRateChargeModel,
  }));
}

async function maybePersistSnapshot(input: {
  request: RateQuoteRequest;
  destCountry: string;
  destPostal: string;
  rateBook: { id: number; code: string } | null;
  zone: string | null;
  quotes: RateQuoteLine[];
  quotedAt: Date;
  warnings: string[];
  opts: RateQuoteOptions;
}): Promise<void> {
  if (!input.opts.persistSnapshot) return;

  const normalizedRequest = {
    rateContext: input.request.rateContext,
    originWarehouseId: input.request.originWarehouseId,
    destCountry: input.destCountry,
    destRegion: input.request.destRegion?.trim().toUpperCase() || null,
    destPostal: input.destPostal,
    parcels: input.request.parcels.map((p) => ({ billableWeightGrams: p.billableWeightGrams })),
    freight: input.request.freight ?? null,
  };

  try {
    await db.insert(shippingQuoteSnapshots).values({
      source: "manual",
      destinationCountry: input.destCountry,
      destinationPostalCode: input.destPostal,
      resolvedZone: input.zone,
      requestHash: createHash("sha256").update(JSON.stringify(normalizedRequest)).digest("hex"),
      requestPayload: normalizedRequest,
      rates: {
        rateBook: input.rateBook,
        quotes: input.quotes,
      },
      metadata: {
        engine: RATE_QUOTE_ENGINE,
        rateBook: input.rateBook,
        quotedAt: input.quotedAt.toISOString(),
        warnings: input.warnings,
      },
    });
  } catch (error) {
    input.warnings.push(
      `quote snapshot persist failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
