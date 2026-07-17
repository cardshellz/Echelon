import {
  findMissingStateDefaults,
  ratePricingAreaKey,
  type RateTableImportRow,
} from "./rate-table-import";
import type { ShippingPricingBasis } from "./rate-selection";
import { US_POSTAL_REGIONS } from "./us-geography";

export type RateTableStatus = "draft" | "active" | "superseded" | "retired";

export interface RateTableLifecycleAnalysis {
  canActivate: boolean;
  errors: string[];
  warnings: string[];
  coverage: {
    rowCount: number;
    stateCount: number;
    zipOverrideCount: number;
    missingRegions: string[];
    minMeasure: number | null;
    maxMeasure: number | null;
  };
}

export function analyzeRateTable(
  rows: readonly RateTableImportRow[],
  pricingBasis: ShippingPricingBasis,
): RateTableLifecycleAnalysis {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (rows.length === 0) {
    errors.push("The table has no rate rows.");
  }

  errors.push(...findBandIssues(rows, pricingBasis));
  errors.push(...findBasisIssues(rows, pricingBasis));

  errors.push(...findMissingStateDefaults(rows));

  const statewideRegions = new Set(
    rows
      .filter((row) => row.destinationCountry === "US" && row.postalPrefix === null)
      .map((row) => row.destinationRegion),
  );
  const missingRegions = US_POSTAL_REGIONS.filter((region) => !statewideRegions.has(region));
  if (missingRegions.length > 0) {
    warnings.push(`No statewide rates are configured for: ${missingRegions.join(", ")}.`);
  }

  return {
    canActivate: errors.length === 0,
    errors,
    warnings,
    coverage: {
      rowCount: rows.length,
      stateCount: statewideRegions.size,
      zipOverrideCount: rows.filter((row) => row.postalPrefix !== null).length,
      missingRegions,
      minMeasure: rows.length > 0 ? Math.min(...rows.map((row) => row.minMeasure)) : null,
      maxMeasure: rows.length > 0 ? Math.max(...rows.map((row) => row.maxMeasure)) : null,
    },
  };
}

export function canDeleteRateTable(status: string): boolean {
  return status === "draft";
}

export function canActivateRateTable(status: string): boolean {
  return status === "draft";
}

export function canRetireRateTable(status: string): boolean {
  return status === "active" || status === "superseded";
}

function findBandIssues(
  rows: readonly RateTableImportRow[],
  pricingBasis: ShippingPricingBasis,
): string[] {
  const groups = new Map<string, RateTableImportRow[]>();
  for (const row of rows) {
    const key = ratePricingAreaKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const errors: string[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(
      (a, b) => a.minMeasure - b.minMeasure || a.maxMeasure - b.maxMeasure,
    );
    const label = pricingAreaLabel(sorted[0]);
    const firstMeasure = pricingBasis === "pallet_count" ? 1 : 0;
    if (sorted[0].minMeasure > firstMeasure) {
      errors.push(
        `${label} has no rate from ${formatMeasure(firstMeasure, pricingBasis)} to ` +
        `${formatMeasure(sorted[0].minMeasure - 1, pricingBasis)}.`,
      );
    }
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (current.minMeasure <= previous.maxMeasure) {
        errors.push(
          `${label} has overlapping bands ` +
          `${formatMeasure(previous.minMeasure, pricingBasis)}-${formatMeasure(previous.maxMeasure, pricingBasis)} and ` +
          `${formatMeasure(current.minMeasure, pricingBasis)}-${formatMeasure(current.maxMeasure, pricingBasis)}.`,
        );
      } else if (current.minMeasure > previous.maxMeasure + 1) {
        errors.push(
          `${label} has no rate from ${formatMeasure(previous.maxMeasure + 1, pricingBasis)} to ` +
          `${formatMeasure(current.minMeasure - 1, pricingBasis)}.`,
        );
      }
    }
  }
  return errors;
}

function findBasisIssues(
  rows: readonly RateTableImportRow[],
  pricingBasis: ShippingPricingBasis,
): string[] {
  if (pricingBasis === "pallet_count") return [];
  return rows
    .filter((row) => row.maxShipmentWeightGrams !== null)
    .map((row) => `${pricingAreaLabel(row)} has a freight weight ceiling on a shipment-weight table.`);
}

function formatMeasure(value: number, pricingBasis: ShippingPricingBasis): string {
  return pricingBasis === "pallet_count"
    ? `${value} pallet${value === 1 ? "" : "s"}`
    : `${value}g`;
}

function pricingAreaLabel(row: RateTableImportRow): string {
  const geography = row.postalPrefix === null
    ? `${row.destinationRegion} statewide`
    : `${row.destinationRegion} ZIP ${row.postalPrefix}*`;
  return row.originWarehouseId === null
    ? geography
    : `${geography} at warehouse ${row.originWarehouseId}`;
}
