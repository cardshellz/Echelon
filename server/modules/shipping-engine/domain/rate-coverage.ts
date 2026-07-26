import type { ShippingRateCoverageAvailability } from "@shared/schema";
import type { RateTableImportRow } from "./rate-table-import";

export interface RateCoverageDestination {
  destinationCountry: string;
  destinationRegion: string | null;
  postalPrefix: string | null;
}

export interface RateCoverageCandidate {
  destinationGroupId: number | null;
  destinationGroupLockVersion: number | null;
  name: string;
  originWarehouseId: number | null;
  availability: ShippingRateCoverageAvailability;
  destinations: readonly RateCoverageDestination[];
}

export interface RateCoverageAnalysis {
  errors: string[];
  offeredCount: number;
  notOfferedCount: number;
}

export interface CurrentRateCoverageDestinationGroup {
  id: number;
  name: string;
  status: "active" | "retired";
  lockVersion: number;
}

/**
 * Validates the frozen destination/service manifest against expanded rate
 * rows. The manifest records intent; rate rows remain the amount authority.
 */
export function analyzeRateCoverage(
  coverages: readonly RateCoverageCandidate[],
  rows: readonly RateTableImportRow[],
): RateCoverageAnalysis {
  const errors: string[] = [];
  const exactDestinationOwners = new Map<string, string>();

  for (const coverage of coverages) {
    const name = coverage.name.trim();
    const label = name === "" ? "Unnamed destination group" : name;
    if (name === "") {
      errors.push("Every destination group needs a name.");
    }
    if (coverage.destinations.length === 0) {
      errors.push(`${label} has no destinations.`);
      continue;
    }

    for (const destination of coverage.destinations) {
      const destinationError = validateDestination(destination);
      if (destinationError !== null) {
        errors.push(`${label}: ${destinationError}`);
        continue;
      }
      const key = destinationKey(coverage.originWarehouseId, destination);
      const existingOwner = exactDestinationOwners.get(key);
      if (existingOwner !== undefined) {
        errors.push(
          `${formatDestination(destination)} is assigned to both ${existingOwner} and ${label}`
          + " for the same warehouse scope.",
        );
      } else {
        exactDestinationOwners.set(key, label);
      }

      const matchingRows = rows.filter((row) =>
        rowMatchesDestination(row, coverage.originWarehouseId, destination));
      if (coverage.availability === "offered" && matchingRows.length === 0) {
        errors.push(`${label} is offered but has no rates for ${formatDestination(destination)}.`);
      }
      if (coverage.availability === "not_offered" && matchingRows.length > 0) {
        errors.push(`${label} is not offered but still has rates for ${formatDestination(destination)}.`);
      }
    }
  }

  return {
    errors: [...new Set(errors)],
    offeredCount: coverages.filter((coverage) => coverage.availability === "offered").length,
    notOfferedCount: coverages.filter((coverage) => coverage.availability === "not_offered").length,
  };
}

/**
 * Prevents a draft from activating after its reusable destination definition
 * changed. Active revisions remain valid frozen history; only draft activation
 * must explicitly adopt the current program geography.
 */
export function findStaleDraftCoverageErrors(
  coverages: readonly Pick<
    RateCoverageCandidate,
    "destinationGroupId" | "destinationGroupLockVersion" | "name"
  >[],
  currentGroups: readonly CurrentRateCoverageDestinationGroup[],
): string[] {
  const currentById = new Map(
    currentGroups.map((group) => [group.id, group]),
  );
  const checked = new Set<number>();
  const errors: string[] = [];

  for (const coverage of coverages) {
    if (coverage.destinationGroupId === null) {
      errors.push(
        `${coverage.name} has no reusable destination-group identity. Save the draft again.`,
      );
      continue;
    }
    if (checked.has(coverage.destinationGroupId)) continue;
    checked.add(coverage.destinationGroupId);

    const current = currentById.get(coverage.destinationGroupId);
    if (current === undefined || current.status !== "active") {
      errors.push(
        `${coverage.name} is no longer an active destination group. Refresh the draft.`,
      );
      continue;
    }
    if (coverage.destinationGroupLockVersion !== current.lockVersion) {
      errors.push(
        `${coverage.name} uses an older destination definition. Use the current destinations and save the draft.`,
      );
    }
  }

  return errors;
}

export function rowMatchesDestination(
  row: Pick<
    RateTableImportRow,
    "originWarehouseId" | "destinationCountry" | "destinationRegion" | "postalPrefix"
  >,
  originWarehouseId: number | null,
  destination: RateCoverageDestination,
): boolean {
  return (row.originWarehouseId ?? null) === originWarehouseId
    && row.destinationCountry === destination.destinationCountry
    && row.destinationRegion === destination.destinationRegion
    && (row.postalPrefix ?? null) === destination.postalPrefix;
}

function validateDestination(destination: RateCoverageDestination): string | null {
  if (!/^[A-Z]{2}$/.test(destination.destinationCountry)) {
    return "destination country must be a two-letter uppercase code.";
  }
  if (
    destination.destinationRegion !== null
    && !/^[A-Z0-9][A-Z0-9-]{0,9}$/.test(destination.destinationRegion)
  ) {
    return "destination region is invalid.";
  }
  if (
    destination.postalPrefix !== null
    && !/^[A-Z0-9][A-Z0-9 -]{0,19}$/.test(destination.postalPrefix)
  ) {
    return "postal prefix is invalid.";
  }
  if (destination.destinationRegion === null && destination.postalPrefix !== null) {
    return "a postal-prefix destination also requires a region.";
  }
  return null;
}

function destinationKey(
  originWarehouseId: number | null,
  destination: RateCoverageDestination,
): string {
  return [
    originWarehouseId ?? 0,
    destination.destinationCountry,
    destination.destinationRegion ?? "",
    destination.postalPrefix ?? "",
  ].join("|");
}

function formatDestination(destination: RateCoverageDestination): string {
  const geography = [
    destination.destinationCountry,
    destination.destinationRegion,
  ].filter(Boolean).join(" ");
  return destination.postalPrefix === null
    ? geography
    : `${geography} postal ${destination.postalPrefix}*`;
}
