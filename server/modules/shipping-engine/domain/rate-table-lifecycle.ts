import { findMissingStateDefaults, type RateTableImportRow } from "./rate-table-import";
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
    minWeightGrams: number | null;
    maxWeightGrams: number | null;
  };
}

export function analyzeRateTable(
  rows: readonly RateTableImportRow[],
  pricingMode: "state_zip" | "legacy_zone",
): RateTableLifecycleAnalysis {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (rows.length === 0) {
    errors.push("The table has no rate rows.");
  }

  errors.push(...findWeightBandIssues(rows));

  if (pricingMode === "state_zip") {
    const unmappedRows = rows.filter((row) => row.destinationRegion === null);
    if (unmappedRows.length > 0) {
      errors.push(
        `${unmappedRows.length} rate row${unmappedRows.length === 1 ? " is" : "s are"} not mapped to a state or ZIP area.`,
      );
    }
    errors.push(...findMissingStateDefaults(rows));
  }

  const statewideRegions = new Set(
    rows
      .filter((row) => row.destinationRegion !== null && row.postalPrefix === null)
      .map((row) => row.destinationRegion!),
  );
  const missingRegions = pricingMode === "state_zip"
    ? US_POSTAL_REGIONS.filter((region) => !statewideRegions.has(region))
    : [];
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
      minWeightGrams: rows.length > 0 ? Math.min(...rows.map((row) => row.minWeightGrams)) : null,
      maxWeightGrams: rows.length > 0 ? Math.max(...rows.map((row) => row.maxWeightGrams)) : null,
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

function findWeightBandIssues(rows: readonly RateTableImportRow[]): string[] {
  const groups = new Map<string, RateTableImportRow[]>();
  for (const row of rows) {
    const key = `${row.originWarehouseId ?? "any"}|${row.destinationZone.toUpperCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const errors: string[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(
      (a, b) => a.minWeightGrams - b.minWeightGrams || a.maxWeightGrams - b.maxWeightGrams,
    );
    const label = pricingAreaLabel(sorted[0]);
    if (sorted[0].minWeightGrams > 0) {
      errors.push(`${label} has no rate from 0g to ${sorted[0].minWeightGrams - 1}g.`);
    }
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (current.minWeightGrams <= previous.maxWeightGrams) {
        errors.push(
          `${label} has overlapping weight bands ` +
          `${previous.minWeightGrams}-${previous.maxWeightGrams}g and ` +
          `${current.minWeightGrams}-${current.maxWeightGrams}g.`,
        );
      } else if (current.minWeightGrams > previous.maxWeightGrams + 1) {
        errors.push(
          `${label} has no rate from ${previous.maxWeightGrams + 1}g to ${current.minWeightGrams - 1}g.`,
        );
      }
    }
  }
  return errors;
}

function pricingAreaLabel(row: RateTableImportRow): string {
  const geography = row.destinationRegion === null
    ? row.destinationZone
    : row.postalPrefix === null
      ? `${row.destinationRegion} statewide`
      : `${row.destinationRegion} ZIP ${row.postalPrefix}*`;
  return row.originWarehouseId === null
    ? geography
    : `${geography} at warehouse ${row.originWarehouseId}`;
}
