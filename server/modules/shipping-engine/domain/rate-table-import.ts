/**
 * Shared shipping rate-table CSV parsing and draft validation.
 *
 * Operators price US destinations directly by state/territory, with an
 * optional ZIP prefix override. Internal shipping zones are deliberately not
 * part of this contract.
 */

import { normalizeUsPostalRegion } from "./us-geography";

export const GRAMS_PER_POUND = 453.59237;
export const CENTS_PER_USD = 100;
export const MAX_IMPORT_ROWS = 5000;

export type RatePricingMode = "state_zip";

export interface RateTableImportRow {
  /** NULL = row applies to any origin warehouse. */
  originWarehouseId: number | null;
  destinationCountry: string;
  destinationRegion: string;
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
  dialect: RateCsvDialect | null;
  pricingMode: RatePricingMode | null;
  rows: RateTableImportRow[];
  errors: CsvRowError[];
}

interface HeaderLayout {
  dialect: RateCsvDialect;
  stateIdx: number;
  postalPrefixIdx: number;
  minIdx: number;
  maxIdx: number;
  rateIdx: number;
}

function splitCsvLine(line: string): string[] {
  return line.split(",").map((cell) => cell.trim());
}

function detectHeader(cells: string[]): HeaderLayout | null {
  const lowered = cells.map((cell) => cell.toLowerCase());
  const idx = (name: string) => lowered.indexOf(name);
  const stateIdx = idx("state");
  if (stateIdx === -1) return null;

  const postalPrefixIdx = idx("zip_prefix");
  const pounds = { minIdx: idx("min_lb"), maxIdx: idx("max_lb"), rateIdx: idx("rate_usd") };
  if (pounds.minIdx !== -1 && pounds.maxIdx !== -1 && pounds.rateIdx !== -1) {
    return { dialect: "pounds", stateIdx, postalPrefixIdx, ...pounds };
  }
  const grams = { minIdx: idx("min_g"), maxIdx: idx("max_g"), rateIdx: idx("rate_cents") };
  if (grams.minIdx !== -1 && grams.maxIdx !== -1 && grams.rateIdx !== -1) {
    return { dialect: "grams", stateIdx, postalPrefixIdx, ...grams };
  }
  return null;
}

function parseFiniteNumber(raw: string): number | null {
  if (raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

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

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index];
    if (line.trim() === "") continue;

    if (!headerSeen) {
      headerSeen = true;
      layout = detectHeader(splitCsvLine(line));
      if (layout === null) {
        errors.push({
          line: lineNo,
          message:
            "unrecognized header - expected state,zip_prefix,min_lb,max_lb,rate_usd or " +
            "state,zip_prefix,min_g,max_g,rate_cents (zip_prefix is optional)",
        });
        return { dialect: null, pricingMode: null, rows: [], errors };
      }
      continue;
    }

    const row = parseDataLine(splitCsvLine(line), layout!, lineNo, errors);
    if (row !== null) rows.push(row);
    if (rows.length > maxRows) {
      errors.push({ line: lineNo, message: `too many rows - the import limit is ${maxRows}` });
      return { dialect: layout!.dialect, pricingMode: "state_zip", rows: [], errors };
    }
  }

  if (!headerSeen) {
    errors.push({ line: 1, message: "CSV is empty - a header row is required" });
    return { dialect: null, pricingMode: null, rows: [], errors };
  }
  return { dialect: layout!.dialect, pricingMode: "state_zip", rows, errors };
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

  const destinationRegion = normalizeUsPostalRegion(cells[layout.stateIdx] ?? "");
  if (destinationRegion === null) {
    return fail(`invalid US state or territory ${JSON.stringify(cells[layout.stateIdx] ?? "")}`);
  }
  const prefix = layout.postalPrefixIdx === -1
    ? ""
    : (cells[layout.postalPrefixIdx] ?? "").trim();
  if (prefix !== "" && !/^\d{1,5}$/.test(prefix)) {
    return fail("zip_prefix must contain 1 to 5 digits");
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

  return {
    originWarehouseId: null,
    destinationCountry: "US",
    destinationRegion,
    postalPrefix: prefix || null,
    minWeightGrams,
    maxWeightGrams,
    rateCents,
  };
}

export function ratePricingAreaKey(row: RateTableImportRow): string {
  return [
    row.originWarehouseId ?? "any",
    row.destinationCountry.toUpperCase(),
    row.destinationRegion.toUpperCase(),
    row.postalPrefix ?? "",
  ].join("|");
}

export function findBandOverlaps(rows: readonly RateTableImportRow[]): string[] {
  const byScope = new Map<string, Array<{ row: RateTableImportRow; index: number }>>();
  rows.forEach((row, index) => {
    const list = byScope.get(ratePricingAreaKey(row)) ?? [];
    list.push({ row, index });
    byScope.set(ratePricingAreaKey(row), list);
  });

  const errors: string[] = [];
  for (const entries of byScope.values()) {
    const sorted = [...entries].sort(
      (a, b) => a.row.minWeightGrams - b.row.minWeightGrams || a.row.maxWeightGrams - b.row.maxWeightGrams,
    );
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (current.row.minWeightGrams <= previous.row.maxWeightGrams) {
        errors.push(
          `overlapping weight bands in ${pricingAreaLabel(current.row)}: ` +
          `[${previous.row.minWeightGrams}, ${previous.row.maxWeightGrams}]g (row ${previous.index + 1}) and ` +
          `[${current.row.minWeightGrams}, ${current.row.maxWeightGrams}]g (row ${current.index + 1})`,
        );
      }
    }
  }
  return errors;
}

/** Every ZIP override needs a statewide fallback in the same warehouse scope. */
export function findMissingStateDefaults(rows: readonly RateTableImportRow[]): string[] {
  const statewide = new Set(
    rows
      .filter((row) => row.postalPrefix === null)
      .map((row) => `${row.originWarehouseId ?? "any"}|${row.destinationCountry}|${row.destinationRegion}`),
  );
  const missing = new Set<string>();
  for (const row of rows) {
    if (row.postalPrefix === null) continue;
    const scope = `${row.originWarehouseId ?? "any"}|${row.destinationCountry}|${row.destinationRegion}`;
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

function pricingAreaLabel(row: RateTableImportRow): string {
  const geography = row.postalPrefix === null
    ? `${row.destinationRegion} statewide`
    : `${row.destinationRegion} ZIP ${row.postalPrefix}*`;
  return row.originWarehouseId === null ? geography : `${geography} at warehouse ${row.originWarehouseId}`;
}
