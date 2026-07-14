/**
 * Rate-table import — pure domain functions, no I/O.
 *
 * Two producers feed shipping.rate_tables / rate_table_rows:
 *   1. Hand-transcribed Parcelify grids (CSV pasted/uploaded in the admin UI —
 *      Parcelify's tables are unexportable, so a human keys them in).
 *   2. The ShipStation-v2 calibration job (writes rows programmatically via
 *      the same import route).
 *
 * This module owns CSV parsing, unit conversion, and pre-write validation so
 * the HTTP route stays thin and everything here is unit-testable without a DB.
 * Design: docs/SHIPPING-ENGINE-DESIGN.md ("Rates Engine").
 *
 * Operator CSVs use state plus an optional ZIP prefix. Legacy zone headers
 * remain readable for old calibration files, but are not exposed in the UI.
 *
 * Contract: never throws for bad input — every problem comes back as a
 * row-level error with the 1-based physical line number.
 */

import { normalizeUsPostalRegion } from "./us-geography";

/** Same constant the client UI uses (ShippingSettings.tsx) — keep in sync. */
export const GRAMS_PER_POUND = 453.59237;
export const CENTS_PER_USD = 100;

/** Hard cap on rows per import — matches the import route's zod limit. */
export const MAX_IMPORT_ROWS = 5000;

export type RatePricingMode = "state_zip" | "legacy_zone";

export function stateZipPricingAreaKey(state: string, postalPrefix?: string | null): string {
  const normalizedState = state.trim().toUpperCase();
  const normalizedPrefix = postalPrefix?.trim() || "";
  return normalizedPrefix
    ? `US-${normalizedState}-ZIP-${normalizedPrefix}`
    : `US-${normalizedState}`;
}

export interface RateTableImportRow {
  /** NULL = row applies to any origin warehouse. */
  originWarehouseId: number | null;
  /** Internal routing key. Operators supply state and optional ZIP prefix. */
  destinationZone: string;
  destinationRegion: string | null;
  postalPrefix: string | null;
  minWeightGrams: number;
  maxWeightGrams: number;
  rateCents: number;
}

export interface CsvRowError {
  /** 1-based physical line number in the submitted CSV (header included). */
  line: number;
  message: string;
}

export type RateCsvDialect = "pounds" | "grams";

export interface ParseRateCsvResult {
  /** Null when the header could not be recognized (see errors). */
  dialect: RateCsvDialect | null;
  pricingMode: RatePricingMode | null;
  rows: RateTableImportRow[];
  errors: CsvRowError[];
}

interface HeaderLayout {
  dialect: RateCsvDialect;
  pricingMode: RatePricingMode;
  destinationIdx: number;
  postalPrefixIdx: number;
  minIdx: number;
  maxIdx: number;
  rateIdx: number;
  /** -1 when the optional warehouse_id column is absent. */
  warehouseIdx: number;
}

function splitCsvLine(line: string): string[] {
  return line.split(",").map((cell) => cell.trim());
}

function detectHeader(cells: string[]): HeaderLayout | null {
  const lowered = cells.map((c) => c.toLowerCase());
  const idx = (name: string) => lowered.indexOf(name);

  const stateIdx = idx("state");
  const zoneIdx = idx("zone");
  if (stateIdx === -1 && zoneIdx === -1) return null;
  const pricingMode: RatePricingMode = stateIdx !== -1 ? "state_zip" : "legacy_zone";
  const destinationIdx = stateIdx !== -1 ? stateIdx : zoneIdx;
  const postalPrefixIdx = idx("zip_prefix");
  const warehouseIdx = idx("warehouse_id");

  const poundsCols = { minIdx: idx("min_lb"), maxIdx: idx("max_lb"), rateIdx: idx("rate_usd") };
  if (poundsCols.minIdx !== -1 && poundsCols.maxIdx !== -1 && poundsCols.rateIdx !== -1) {
    return { dialect: "pounds", pricingMode, destinationIdx, postalPrefixIdx, warehouseIdx, ...poundsCols };
  }
  const gramsCols = { minIdx: idx("min_g"), maxIdx: idx("max_g"), rateIdx: idx("rate_cents") };
  if (gramsCols.minIdx !== -1 && gramsCols.maxIdx !== -1 && gramsCols.rateIdx !== -1) {
    return { dialect: "grams", pricingMode, destinationIdx, postalPrefixIdx, warehouseIdx, ...gramsCols };
  }
  return null;
}

function parseFiniteNumber(raw: string): number | null {
  if (raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse a rate-table CSV into storage-unit rows. Pounds→grams uses
 * GRAMS_PER_POUND with round-to-nearest; USD→cents rounds to the nearest cent.
 */
export function parseRateTableCsv(
  csv: string,
  opts: { maxRows?: number } = {},
): ParseRateCsvResult {
  const maxRows = opts.maxRows ?? MAX_IMPORT_ROWS;
  const rows: RateTableImportRow[] = [];
  const errors: CsvRowError[] = [];

  const lines = csv.split(/\r\n|\r|\n/);
  let layout: HeaderLayout | null = null;
  let headerSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (line.trim() === "") continue;

    if (!headerSeen) {
      headerSeen = true;
      layout = detectHeader(splitCsvLine(line));
      if (layout === null) {
        errors.push({
          line: lineNo,
          message:
            "unrecognized header - expected columns state,zip_prefix,min_lb,max_lb,rate_usd or " +
            "state,zip_prefix,min_g,max_g,rate_cents (zip_prefix and warehouse_id are optional)",
        });
        return { dialect: null, pricingMode: null, rows: [], errors };
      }
      continue;
    }

    const row = parseDataLine(splitCsvLine(line), layout!, lineNo, errors);
    if (row !== null) rows.push(row);
    if (rows.length > maxRows) {
      errors.push({ line: lineNo, message: `too many rows — the import limit is ${maxRows}` });
      return { dialect: layout!.dialect, pricingMode: layout!.pricingMode, rows: [], errors };
    }
  }

  if (!headerSeen) {
    errors.push({ line: 1, message: "CSV is empty — a header row is required" });
    return { dialect: null, pricingMode: null, rows: [], errors };
  }
  return { dialect: layout!.dialect, pricingMode: layout!.pricingMode, rows, errors };
}

function parseDataLine(
  cells: string[],
  layout: HeaderLayout,
  lineNo: number,
  errors: CsvRowError[],
): RateTableImportRow | null {
  const fail = (message: string): null => {
    errors.push({ line: lineNo, message });
    return null;
  };

  const destination = (cells[layout.destinationIdx] ?? "").trim();
  let destinationRegion: string | null = null;
  let postalPrefix: string | null = null;
  let destinationZone: string;
  if (layout.pricingMode === "state_zip") {
    destinationRegion = normalizeUsPostalRegion(destination);
    if (destinationRegion === null) {
      return fail(`invalid US state or territory ${JSON.stringify(destination)}`);
    }
    const prefix = layout.postalPrefixIdx === -1
      ? ""
      : (cells[layout.postalPrefixIdx] ?? "").trim();
    if (prefix !== "" && !/^\d{1,5}$/.test(prefix)) {
      return fail("zip_prefix must contain 1 to 5 digits");
    }
    postalPrefix = prefix || null;
    destinationZone = stateZipPricingAreaKey(destinationRegion, postalPrefix);
  } else {
    if (destination === "") return fail("zone is required");
    if (destination.length > 40) return fail("zone must be 40 characters or fewer");
    destinationZone = destination;
  }

  const minRaw = parseFiniteNumber(cells[layout.minIdx] ?? "");
  const maxRaw = parseFiniteNumber(cells[layout.maxIdx] ?? "");
  const rateRaw = parseFiniteNumber(cells[layout.rateIdx] ?? "");
  if (minRaw === null) return fail(`invalid min weight ${JSON.stringify(cells[layout.minIdx] ?? "")}`);
  if (maxRaw === null) return fail(`invalid max weight ${JSON.stringify(cells[layout.maxIdx] ?? "")}`);
  if (rateRaw === null) return fail(`invalid rate ${JSON.stringify(cells[layout.rateIdx] ?? "")}`);

  let minWeightGrams: number;
  let maxWeightGrams: number;
  let rateCents: number;
  if (layout.dialect === "pounds") {
    minWeightGrams = Math.round(minRaw * GRAMS_PER_POUND);
    maxWeightGrams = Math.round(maxRaw * GRAMS_PER_POUND);
    rateCents = Math.round(rateRaw * CENTS_PER_USD);
  } else {
    if (!Number.isInteger(minRaw) || !Number.isInteger(maxRaw) || !Number.isInteger(rateRaw)) {
      return fail("min_g, max_g and rate_cents must be whole numbers");
    }
    minWeightGrams = minRaw;
    maxWeightGrams = maxRaw;
    rateCents = rateRaw;
  }

  if (minWeightGrams < 0) return fail("min weight must be zero or greater");
  if (maxWeightGrams < minWeightGrams) return fail("max weight must be >= min weight");
  if (rateCents < 0) return fail("rate must be zero or greater");

  let originWarehouseId: number | null = null;
  if (layout.warehouseIdx !== -1) {
    const warehouseRaw = (cells[layout.warehouseIdx] ?? "").trim();
    if (warehouseRaw !== "") {
      const parsed = Number(warehouseRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return fail(`invalid warehouse_id ${JSON.stringify(warehouseRaw)}`);
      }
      originWarehouseId = parsed;
    }
  }

  return {
    originWarehouseId,
    destinationZone,
    destinationRegion,
    postalPrefix,
    minWeightGrams,
    maxWeightGrams,
    rateCents,
  };
}

// ---------------------------------------------------------------------------
// Band validation
// ---------------------------------------------------------------------------

/**
 * Detect overlapping weight bands within the same (originWarehouseId,
 * destinationZone) scope. Bands are min/max INCLUSIVE (rate selection treats
 * them that way), so [0,1000] + [1000,2000] overlaps at 1000 while
 * [0,1000] + [1001,2000] is a clean adjacency. Exact duplicates are overlaps.
 * Returns human-readable error strings; empty array = valid.
 */
export function findBandOverlaps(rows: readonly RateTableImportRow[]): string[] {
  const byScope = new Map<string, Array<{ row: RateTableImportRow; index: number }>>();
  rows.forEach((row, index) => {
    const scope = `${row.originWarehouseId ?? "any"}|${row.destinationZone.toUpperCase()}`;
    const list = byScope.get(scope) ?? [];
    list.push({ row, index });
    byScope.set(scope, list);
  });

  const errors: string[] = [];
  for (const entries of byScope.values()) {
    const sorted = [...entries].sort(
      (a, b) => a.row.minWeightGrams - b.row.minWeightGrams || a.row.maxWeightGrams - b.row.maxWeightGrams,
    );
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (curr.row.minWeightGrams <= prev.row.maxWeightGrams) {
        const scopeLabel =
          `zone ${curr.row.destinationZone}` +
          (curr.row.originWarehouseId !== null ? ` (warehouse ${curr.row.originWarehouseId})` : "");
        errors.push(
          `overlapping weight bands in ${scopeLabel}: ` +
            `[${prev.row.minWeightGrams}, ${prev.row.maxWeightGrams}]g (row ${prev.index + 1}) and ` +
            `[${curr.row.minWeightGrams}, ${curr.row.maxWeightGrams}]g (row ${curr.index + 1})`,
        );
      }
    }
  }
  return errors;
}

/** Every ZIP override needs a statewide fallback in the same imported table. */
export function findMissingStateDefaults(rows: readonly RateTableImportRow[]): string[] {
  const statewide = new Set(
    rows
      .filter((row) => row.destinationRegion !== null && row.postalPrefix === null)
      .map((row) => `${row.originWarehouseId ?? "any"}|${row.destinationRegion}`),
  );
  const missing = new Set<string>();
  for (const row of rows) {
    if (row.destinationRegion === null || row.postalPrefix === null) continue;
    const scope = `${row.originWarehouseId ?? "any"}|${row.destinationRegion}`;
    if (!statewide.has(scope)) {
      missing.add(
        `${row.destinationRegion}${row.originWarehouseId === null ? "" : ` at warehouse ${row.originWarehouseId}`}`,
      );
    }
  }
  return [...missing]
    .sort()
    .map((scope) => `${scope} has a ZIP override but no statewide fallback rate`);
}

// ---------------------------------------------------------------------------
// Zone-coverage warnings
// ---------------------------------------------------------------------------

/**
 * Zones referenced by the import that no shipping.zone_rules row can resolve
 * to. WARNINGS, not rejections — the operator may be importing rates ahead of
 * the zone rules. Comparison is case-insensitive.
 */
export function findUnknownZones(
  rows: readonly RateTableImportRow[],
  knownZones: Iterable<string>,
): string[] {
  const known = new Set<string>();
  for (const zone of knownZones) known.add(zone.trim().toUpperCase());

  const unknown = new Set<string>();
  for (const row of rows) {
    const zone = row.destinationZone.trim();
    if (!known.has(zone.toUpperCase())) unknown.add(zone);
  }
  return [...unknown]
    .sort()
    .map((zone) => `zone ${JSON.stringify(zone)} has no matching zone rule — rows for it will never be quoted until one exists`);
}
