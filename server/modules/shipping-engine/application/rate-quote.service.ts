/**
 * Rate quote orchestration — application layer, thin over drizzle.
 *
 * Loads active zone rules + effective-dated rate tables/rows ONCE, resolves
 * the zone and rates each parcel with the pure domain functions, then sums
 * per (carrier, serviceCode) across parcels. A (carrier, serviceCode) is only
 * offered when EVERY parcel priced under it — a parcel with no matching band
 * adds a warning and drops the combo (caller decides how to fall back).
 *
 * Design: docs/SHIPPING-ENGINE-DESIGN.md ("Rates Engine"). This is the local
 * deterministic rates core behind the runtime rate-provider adapter and shadow runs.
 *
 * Contract: never throws for data problems (no zone, no bands, bad postal) —
 * those degrade to { quotes: [], warnings }. Infrastructure failures (DB down)
 * still reject, except the optional snapshot write which only warns.
 */

import { createHash } from "crypto";
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import {
  shippingQuoteSnapshots,
  shippingRateTableRows,
  shippingRateTables,
  shippingZoneRules,
} from "@shared/schema";
import { db } from "../../../db";
import {
  rateComboKey,
  selectParcelRates,
  type RateCandidateRow,
  type SelectedRateQuote,
} from "../domain/rate-selection";
import { selectRateBookAssignment } from "../domain/rate-book";
import type { ShippingRateContext } from "../domain/shipping-channel";
import { resolveZone, type ZoneRule } from "../domain/zones";
import { loadActiveRateBookAssignments } from "../infrastructure/rate-book.repository";

export const RATE_QUOTE_ENGINE = { name: "cardshellz-rates", version: "1.1.0" } as const;

export interface RateQuoteParcel {
  billableWeightGrams: number;
}

export interface RateQuoteRequest {
  rateContext: ShippingRateContext;
  originWarehouseId: number;
  destCountry: string;
  destRegion?: string | null;
  destPostal: string;
  parcels: RateQuoteParcel[];
}

export interface RateQuoteOptions {
  /** Injected clock for effective-dating; defaults to now. */
  quotedAt?: Date;
  /** Persist a shipping.quote_snapshots row (source 'manual'). Default OFF. */
  persistSnapshot?: boolean;
}

export interface RateQuoteLine {
  carrier: string;
  serviceCode: string;
  totalCents: number;
  currency: string;
  /** Winning rate per parcel, aligned with the request's parcels order. */
  perParcelCents: number[];
}

export interface RateQuoteResult {
  rateBook: { id: number; code: string } | null;
  zone: string | null;
  quotes: RateQuoteLine[];
  warnings: string[];
}

export async function quoteParcels(
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
  if (destPostal === "") {
    warnings.push("destination postal code is required to resolve a zone");
    return { rateBook: null, zone: null, quotes: [], warnings };
  }
  if (request.parcels.length === 0) {
    warnings.push("no parcels to rate");
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

  const zone = await resolveZoneForOrigin(
    selection.assignment.zoneSetId,
    request.originWarehouseId,
    destCountry,
    destPostal,
    destRegion,
  );
  if (zone === null) {
    warnings.push(
      `no active pricing area in ${rateBook.code} matches ${destCountry} ${destRegion ?? "unknown-state"} ${destPostal} for warehouse ${request.originWarehouseId}`,
    );
    await maybePersistSnapshot({
      request, destCountry, destPostal, rateBook, zone: null,
      quotes: [], quotedAt, warnings, opts,
    });
    return { rateBook, zone: null, quotes: [], warnings };
  }

  const candidateRows = await loadCandidateRows(
    rateBook.id,
    request.originWarehouseId,
    zone,
    quotedAt,
  );
  const quotes = rateAllParcels(request, zone, candidateRows, warnings);

  await maybePersistSnapshot({ request, destCountry, destPostal, rateBook, zone, quotes, quotedAt, warnings, opts });
  return { rateBook, zone, quotes, warnings };
}

// ---------------------------------------------------------------------------
// Orchestration steps
// ---------------------------------------------------------------------------

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
  zone: string,
  quotedAt: Date,
): Promise<RateCandidateRow[]> {
  return db
    .select({
      rateTableId: shippingRateTableRows.rateTableId,
      carrier: shippingRateTables.carrier,
      serviceCode: shippingRateTables.serviceCode,
      currency: shippingRateTables.currency,
      originWarehouseId: shippingRateTableRows.originWarehouseId,
      destinationZone: shippingRateTableRows.destinationZone,
      minWeightGrams: shippingRateTableRows.minWeightGrams,
      maxWeightGrams: shippingRateTableRows.maxWeightGrams,
      rateCents: shippingRateTableRows.rateCents,
    })
    .from(shippingRateTableRows)
    .innerJoin(shippingRateTables, eq(shippingRateTableRows.rateTableId, shippingRateTables.id))
    .where(and(
      eq(shippingRateTables.rateBookId, rateBookId),
      eq(shippingRateTables.status, "active"),
      lte(shippingRateTables.effectiveFrom, quotedAt),
      or(isNull(shippingRateTables.effectiveTo), gt(shippingRateTables.effectiveTo, quotedAt)),
      eq(shippingRateTableRows.destinationZone, zone),
      or(
        isNull(shippingRateTableRows.originWarehouseId),
        eq(shippingRateTableRows.originWarehouseId, originWarehouseId),
      ),
    ));
}

/**
 * Rate each parcel with the pure selector, then intersect: only combos that
 * priced EVERY parcel survive; everything else drops with a warning.
 */
function rateAllParcels(
  request: RateQuoteRequest,
  zone: string,
  candidateRows: RateCandidateRow[],
  warnings: string[],
): RateQuoteLine[] {
  const perParcel: Array<Map<string, SelectedRateQuote>> = [];
  const representative = new Map<string, SelectedRateQuote>();

  request.parcels.forEach((parcel, index) => {
    const selected = selectParcelRates(candidateRows, {
      zone,
      billableWeightGrams: parcel.billableWeightGrams,
      originWarehouseId: request.originWarehouseId,
    });
    if (selected === null) {
      warnings.push(
        `parcel ${index + 1} (${parcel.billableWeightGrams}g): no rate band covers this weight in zone ${zone}`,
      );
      perParcel.push(new Map());
      return;
    }
    const byCombo = new Map<string, SelectedRateQuote>();
    for (const quote of selected) {
      const key = rateComboKey(quote.carrier, quote.serviceCode);
      byCombo.set(key, quote);
      if (!representative.has(key)) representative.set(key, quote);
    }
    perParcel.push(byCombo);
  });

  const lines: RateQuoteLine[] = [];
  for (const [key, sample] of representative) {
    const perParcelCents: number[] = [];
    const missingParcels: number[] = [];
    const currencies = new Set<string>();

    perParcel.forEach((byCombo, index) => {
      const quote = byCombo.get(key);
      if (!quote) {
        // Fully unmatched parcels already warned above; only call out gaps
        // in parcels that DID price other services.
        if (byCombo.size > 0) missingParcels.push(index + 1);
        return;
      }
      perParcelCents.push(quote.rateCents);
      currencies.add(quote.currency.toUpperCase());
    });

    if (perParcelCents.length !== perParcel.length) {
      if (missingParcels.length > 0) {
        warnings.push(
          `${sample.carrier} ${sample.serviceCode} dropped: no matching band for parcel(s) ${missingParcels.join(", ")}`,
        );
      }
      continue;
    }
    if (currencies.size > 1) {
      warnings.push(
        `${sample.carrier} ${sample.serviceCode} dropped: mixed currencies across parcels (${[...currencies].join(", ")})`,
      );
      continue;
    }

    lines.push({
      carrier: sample.carrier,
      serviceCode: sample.serviceCode,
      totalCents: perParcelCents.reduce((sum, cents) => sum + cents, 0),
      currency: [...currencies][0] ?? sample.currency.toUpperCase(),
      perParcelCents,
    });
  }

  return lines.sort((a, b) =>
    a.totalCents - b.totalCents
    || a.carrier.localeCompare(b.carrier)
    || a.serviceCode.localeCompare(b.serviceCode));
}

// ---------------------------------------------------------------------------
// Optional snapshot persistence (calibration/observability dataset)
// ---------------------------------------------------------------------------

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
    // The snapshot is observability, not the quote — degrade loudly, not fatally.
    input.warnings.push(
      `quote snapshot persist failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
