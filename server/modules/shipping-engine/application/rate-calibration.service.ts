/**
 * ShipStation-v2 rate calibration — application layer.
 *
 * Turns REAL v2 rate quotes into shipping.rate_table rows: samples one
 * representative parcel per weight band against representative destination
 * ZIPs per zone, quotes each (band, destination) through the v2 adapter, and
 * writes one calibrated table per (carrier, serviceCode) via the SAME import
 * service the admin CSV route uses — so band/zone validation is shared and
 * the writer-ratchet keeps all rate_table writes inside this module.
 *
 * Runtime-gated on SHIPSTATION_V2_API_KEY: when the adapter reports
 * { configured: false } the run no-ops with a clear report (never throws).
 * Design: docs/SHIPPING-ENGINE-DESIGN.md ("Rates Engine" / "Carrier
 * Adapters").
 *
 * Safety rails:
 *  - dryRun defaults to TRUE — the would-be tables/rows come back in the
 *    report and nothing is written.
 *  - A hand-imported active table (metadata.source !== 'calibration') is
 *    NEVER superseded unless overwriteManual === true.
 *  - Conservative pricing: per (carrier, service, zone, band) the stored rate
 *    is the MAX quote across that zone's sample destinations — never
 *    undercharge because one sample ZIP happened to be cheap.
 *  - Rate-limit friendly: strictly sequential quoting with a ~250ms gap;
 *    3 CONSECUTIVE adapter errors abort the whole run (no writes).
 */

import { and, desc, eq } from "drizzle-orm";
import { shippingRateTables, warehouses } from "@shared/schema";
import { db } from "../../../db";
import {
  createShipStationV2RatingAdapter,
  type ShipStationV2RatingAdapter,
  type V2Address,
} from "../infrastructure/shipstation-v2-rating.adapter";
import type { RateTableImportRow } from "../domain/rate-table-import";
import {
  importRateTable,
  type RateTableImportInput,
  type RateTableImportOutcome,
} from "./rate-table-import.service";

/** Bumped when the sampling/aggregation logic changes; stored in provenance. */
export const CALIBRATION_ADAPTER_VERSION = "shipstation-v2-calibration/1";

/** Origin used when the caller does not name one (primary warehouse). */
const DEFAULT_ORIGIN_WAREHOUSE_ID = 1;

/** Gap between sequential quote calls so we stay friendly to the v2 API. */
const QUOTE_GAP_MS = 250;

/** Consecutive adapter failures that abort the whole run. */
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Sample weights (band midpoints) and the band ceilings they calibrate,
 * mapped 1:1 by index: sample[i] prices band
 * [ceiling[i-1] + 1 .. ceiling[i]] grams (band 0 starts at 0). 4oz → 50lb.
 *
 *   sample 113g → band [0, 170]         sample 2268g  → band [1702, 2722]
 *   sample 227g → band [171, 340]       sample 4536g  → band [2723, 5443]
 *   sample 454g → band [341, 567]       sample 9072g  → band [5444, 10886]
 *   sample 907g → band [568, 1134]      sample 13608g → band [10887, 16329]
 *   sample 1361g → band [1135, 1701]    sample 22680g → band [16330, 27216]
 */
export const CALIBRATION_SAMPLE_WEIGHTS_GRAMS =
  [113, 227, 454, 907, 1361, 2268, 4536, 9072, 13608, 22680] as const;
export const CALIBRATION_BAND_CEILINGS_GRAMS =
  [170, 340, 567, 1134, 1701, 2722, 5443, 10886, 16329, 27216] as const;

/**
 * Quoting parcel: a standard 12x10x4in box (305x254x102mm). Dims refine later
 * via the box catalog (per-box calibration); weight dominates parcel pricing
 * at these sizes so one representative box is acceptable for v1.
 */
export const CALIBRATION_BOX_DIMS_MM = { lengthMm: 305, widthMm: 254, heightMm: 102 } as const;

export interface CalibrationDestination {
  zone: string;
  postalCode: string;
  /** Optional; helps some carriers rate more precisely. */
  state?: string;
}

/**
 * One representative ZIP per zone: US-48 gets a mid-country ZIP (66044,
 * Lawrence KS) plus the origin warehouse's own ZIP (near-origin sample) so
 * the MAX aggregation brackets the zone; US-HIPRAK samples HI + AK + PR.
 */
export function defaultDestinations(originPostalCode: string | null): CalibrationDestination[] {
  const us48: CalibrationDestination[] = [{ zone: "US-48", postalCode: "66044", state: "KS" }];
  if (originPostalCode && originPostalCode.trim() !== "" && originPostalCode.trim() !== "66044") {
    us48.push({ zone: "US-48", postalCode: originPostalCode.trim() });
  }
  return [
    ...us48,
    { zone: "US-HIPRAK", postalCode: "96813", state: "HI" },
    { zone: "US-HIPRAK", postalCode: "99501", state: "AK" },
    { zone: "US-HIPRAK", postalCode: "00907", state: "PR" },
  ];
}

export interface RunCalibrationOptions {
  originWarehouseId?: number;
  /** Sample weights (band midpoints); must align 1:1 with default ceilings when overridden. */
  weightBandsGrams?: readonly number[];
  destinations?: readonly CalibrationDestination[];
  /** Default TRUE: report only, write nothing. */
  dryRun?: boolean;
  /** Allow superseding an active table whose metadata.source !== 'calibration'. */
  overwriteManual?: boolean;
}

export interface CalibratedCarrierTable {
  carrier: string;
  serviceCode: string;
  currency: string;
  zones: string[];
  /** Number of weight bands with a rate (across all zones = rows.length). */
  bands: number;
  minRateCents: number;
  maxRateCents: number;
  /** The would-be rate_table_rows (also what dryRun=false writes). */
  rows: RateTableImportRow[];
}

export interface CalibrationReport {
  configured: boolean;
  message?: string;
  dryRun: boolean;
  aborted: boolean;
  carriers: CalibratedCarrierTable[];
  /** Tables written (dryRun=false only). */
  written: Array<{ carrier: string; serviceCode: string; rateTableId: number }>;
  /** Active manual tables left untouched (overwriteManual not set). */
  skippedManualTables: Array<{ carrier: string; serviceCode: string; source: string }>;
  warnings: string[];
  errors: string[];
}

/** Everything with I/O is injectable so unit tests never touch network/DB. */
export interface CalibrationDeps {
  adapter: ShipStationV2RatingAdapter;
  importTable: (input: RateTableImportInput) => Promise<RateTableImportOutcome>;
  loadOriginWarehouse: (warehouseId: number) => Promise<CalibrationOrigin | null>;
  getActiveTable: (carrier: string, serviceCode: string) => Promise<ActiveTableSummary | null>;
  clock: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export interface CalibrationOrigin {
  warehouseId: number;
  postalCode: string | null;
  state: string | null;
  country: string;
}

export interface ActiveTableSummary {
  id: number;
  metadata: unknown;
}

function defaultDeps(): CalibrationDeps {
  return {
    adapter: createShipStationV2RatingAdapter(),
    importTable: importRateTable,
    loadOriginWarehouse: async (warehouseId) => {
      const [row] = await db
        .select({
          id: warehouses.id,
          postalCode: warehouses.postalCode,
          state: warehouses.state,
          country: warehouses.country,
        })
        .from(warehouses)
        .where(eq(warehouses.id, warehouseId))
        .limit(1);
      if (!row) return null;
      return {
        warehouseId: row.id,
        postalCode: row.postalCode,
        state: row.state,
        country: row.country ?? "US",
      };
    },
    getActiveTable: async (carrier, serviceCode) => {
      const [row] = await db
        .select({ id: shippingRateTables.id, metadata: shippingRateTables.metadata })
        .from(shippingRateTables)
        .where(and(
          eq(shippingRateTables.carrier, carrier),
          eq(shippingRateTables.serviceCode, serviceCode),
          eq(shippingRateTables.status, "active"),
        ))
        .orderBy(desc(shippingRateTables.effectiveFrom), desc(shippingRateTables.id))
        .limit(1);
      return row ?? null;
    },
    clock: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** metadata.source of an active table, or null when absent/unreadable. */
function tableSource(metadata: unknown): string | null {
  const source = (metadata as { source?: unknown } | null)?.source;
  return typeof source === "string" ? source : null;
}

interface ZoneBandRate {
  /** MAX amountCents seen across the zone's sample destinations. */
  rateCents: number;
  currency: string;
}

export async function runCalibration(
  opts: RunCalibrationOptions = {},
  deps: CalibrationDeps = defaultDeps(),
): Promise<CalibrationReport> {
  const dryRun = opts.dryRun ?? true;
  const report: CalibrationReport = {
    configured: false,
    dryRun,
    aborted: false,
    carriers: [],
    written: [],
    skippedManualTables: [],
    warnings: [],
    errors: [],
  };

  if (!deps.adapter.isConfigured()) {
    report.message =
      "ShipStation v2 is not configured (SHIPSTATION_V2_API_KEY is unset) — calibration skipped.";
    return report;
  }
  report.configured = true;

  const originWarehouseId = opts.originWarehouseId ?? DEFAULT_ORIGIN_WAREHOUSE_ID;
  const origin = await deps.loadOriginWarehouse(originWarehouseId);
  if (origin === null) {
    report.errors.push(`origin warehouse ${originWarehouseId} not found — nothing quoted`);
    return report;
  }
  if (!origin.postalCode || origin.postalCode.trim() === "") {
    report.errors.push(
      `origin warehouse ${originWarehouseId} has no postal code — cannot build the ship-from address`,
    );
    return report;
  }

  const sampleWeights = opts.weightBandsGrams ?? CALIBRATION_SAMPLE_WEIGHTS_GRAMS;
  if (sampleWeights.length !== CALIBRATION_BAND_CEILINGS_GRAMS.length) {
    report.errors.push(
      `weightBandsGrams must have exactly ${CALIBRATION_BAND_CEILINGS_GRAMS.length} entries `
      + `(1:1 with the band ceilings); got ${sampleWeights.length}`,
    );
    return report;
  }
  const destinations = opts.destinations ?? defaultDestinations(origin.postalCode);

  const from: V2Address = {
    postalCode: origin.postalCode.trim(),
    countryCode: origin.country.trim().toUpperCase().slice(0, 2) || "US",
    ...(origin.state ? { state: origin.state } : {}),
  };

  // -------------------------------------------------------------------------
  // Quote every (band, destination) sequentially; aggregate MAX per zone.
  // -------------------------------------------------------------------------
  // combo key `${carrier} ${serviceCode}` → zone → bandIndex → rate
  const aggregated = new Map<string, Map<string, Map<number, ZoneBandRate>>>();
  const comboMeta = new Map<string, { carrier: string; serviceCode: string }>();
  let consecutiveErrors = 0;
  let firstCall = true;

  outer:
  for (let bandIndex = 0; bandIndex < sampleWeights.length; bandIndex++) {
    for (const destination of destinations) {
      if (!firstCall) await deps.sleep(QUOTE_GAP_MS);
      firstCall = false;

      try {
        const result = await deps.adapter.getRates({
          from,
          to: {
            postalCode: destination.postalCode,
            countryCode: "US",
            ...(destination.state ? { state: destination.state } : {}),
          },
          parcels: [{ weightGrams: sampleWeights[bandIndex], ...CALIBRATION_BOX_DIMS_MM }],
        });
        consecutiveErrors = 0;
        if (!result.configured) {
          // Defensive: isConfigured() said yes above; treat as a hard stop.
          report.errors.push("adapter reported not-configured mid-run — aborting");
          report.aborted = true;
          break outer;
        }
        if (result.rates.length === 0) {
          report.warnings.push(
            `no quotes for ${sampleWeights[bandIndex]}g to ${destination.postalCode} (${destination.zone})`,
          );
        }
        for (const rate of result.rates) {
          const key = `${rate.carrier} ${rate.serviceCode}`;
          comboMeta.set(key, { carrier: rate.carrier, serviceCode: rate.serviceCode });
          const zones = aggregated.get(key) ?? new Map<string, Map<number, ZoneBandRate>>();
          aggregated.set(key, zones);
          const bands = zones.get(destination.zone) ?? new Map<number, ZoneBandRate>();
          zones.set(destination.zone, bands);
          const existing = bands.get(bandIndex);
          // Conservative: MAX across the zone's sample destinations.
          if (!existing || rate.amountCents > existing.rateCents) {
            bands.set(bandIndex, { rateCents: rate.amountCents, currency: rate.currency });
          }
        }
      } catch (error) {
        consecutiveErrors += 1;
        report.errors.push(
          `quote failed (${sampleWeights[bandIndex]}g → ${destination.postalCode}): `
          + (error instanceof Error ? error.message : String(error)),
        );
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          report.errors.push(
            `aborted: ${MAX_CONSECUTIVE_ERRORS} consecutive adapter errors — nothing written`,
          );
          report.aborted = true;
          break outer;
        }
      }
    }
  }

  if (report.aborted) {
    // Partial samples are not trustworthy rate tables; report errors only.
    return report;
  }

  // -------------------------------------------------------------------------
  // Build per-(carrier, service) tables from the aggregation.
  // -------------------------------------------------------------------------
  for (const [key, zones] of aggregated) {
    const { carrier, serviceCode } = comboMeta.get(key)!;
    const rows: RateTableImportRow[] = [];
    const currencies = new Set<string>();

    for (const [zone, bands] of zones) {
      for (let bandIndex = 0; bandIndex < CALIBRATION_BAND_CEILINGS_GRAMS.length; bandIndex++) {
        const rate = bands.get(bandIndex);
        if (!rate) {
          report.warnings.push(
            `${carrier} ${serviceCode} zone ${zone}: no quote for band ending `
            + `${CALIBRATION_BAND_CEILINGS_GRAMS[bandIndex]}g — band omitted`,
          );
          continue;
        }
        currencies.add(rate.currency.toUpperCase());
        rows.push({
          // Rates were sampled FROM this origin; scope the rows to it.
          originWarehouseId: origin.warehouseId,
          destinationZone: zone,
          minWeightGrams: bandIndex === 0 ? 0 : CALIBRATION_BAND_CEILINGS_GRAMS[bandIndex - 1] + 1,
          maxWeightGrams: CALIBRATION_BAND_CEILINGS_GRAMS[bandIndex],
          rateCents: rate.rateCents,
        });
      }
    }
    if (rows.length === 0) continue;
    if (currencies.size > 1) {
      report.warnings.push(
        `${carrier} ${serviceCode} skipped: mixed currencies across quotes (${[...currencies].join(", ")})`,
      );
      continue;
    }

    report.carriers.push({
      carrier,
      serviceCode,
      currency: [...currencies][0] ?? "USD",
      zones: [...zones.keys()].sort(),
      bands: rows.length,
      minRateCents: Math.min(...rows.map((r) => r.rateCents)),
      maxRateCents: Math.max(...rows.map((r) => r.rateCents)),
      rows,
    });
  }
  report.carriers.sort((a, b) =>
    a.carrier.localeCompare(b.carrier) || a.serviceCode.localeCompare(b.serviceCode));

  if (dryRun) return report;

  // -------------------------------------------------------------------------
  // Write via the shared import service (same validation the CSV path gets).
  // -------------------------------------------------------------------------
  const sampledAt = deps.clock();
  for (const table of report.carriers) {
    const active = await deps.getActiveTable(table.carrier, table.serviceCode);
    const source = active ? tableSource(active.metadata) : null;
    if (active && source !== "calibration" && opts.overwriteManual !== true) {
      report.skippedManualTables.push({
        carrier: table.carrier,
        serviceCode: table.serviceCode,
        source: source ?? "unknown",
      });
      continue;
    }

    const outcome = await deps.importTable({
      carrier: table.carrier,
      serviceCode: table.serviceCode,
      currency: table.currency,
      replaceExisting: true,
      rows: table.rows,
      metadata: {
        source: "calibration",
        sampledAt: sampledAt.toISOString(),
        bands: [...CALIBRATION_BAND_CEILINGS_GRAMS],
        destinations: destinations.map((d) => ({ zone: d.zone, postalCode: d.postalCode })),
        adapterVersion: CALIBRATION_ADAPTER_VERSION,
        originWarehouseId: origin.warehouseId,
      },
    });
    if (!outcome.ok) {
      report.errors.push(
        `${table.carrier} ${table.serviceCode}: import rejected — ${outcome.bandErrors.join("; ")}`,
      );
      continue;
    }
    report.warnings.push(...outcome.warnings);
    report.written.push({
      carrier: table.carrier,
      serviceCode: table.serviceCode,
      rateTableId: outcome.rateTable.id,
    });
  }

  return report;
}
