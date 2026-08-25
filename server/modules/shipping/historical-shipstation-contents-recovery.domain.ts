import { canonicalJson } from "@shared/utils/canonical-json";

import type { ShipStationShipmentContentsEvidenceStatus } from "./carrier-tracking.domain";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_PACKAGE_LINES = 500;
const MAX_SKU_LENGTH = 100;

export const HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_STATUSES = Object.freeze([
  "provider_line_keys_authoritative",
  "exact_unique_wms_match",
  "provider_empty",
  "provider_evidence_unavailable",
  "wms_lineage_unavailable",
  "ambiguous_wms_match",
  "provider_wms_conflict",
] as const);

export type HistoricalShipStationContentsRecoveryStatus =
  typeof HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_STATUSES[number];

export interface HistoricalShipStationExpectedContentsLine {
  readonly wmsShipmentItemId: number;
  readonly sku: string;
  readonly quantity: number;
}

export type HistoricalShipStationExpectedContentsEvidence =
  | Readonly<{
      readonly kind: "available";
      readonly source: "physical_shipment" | "legacy_wms_shipment";
      readonly lines: readonly HistoricalShipStationExpectedContentsLine[];
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly reason:
        | "no_linked_package"
        | "ambiguous_linked_package"
        | "linked_package_contents_unavailable";
    }>;

export type HistoricalShipStationContentsRecoveryErrorCode =
  | "INVALID_EXPECTED_CONTENTS_EVIDENCE";

export class HistoricalShipStationContentsRecoveryError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsRecoveryErrorCode,
    message: string,
    readonly context: Readonly<Record<string, number>> = Object.freeze({}),
  ) {
    super(message);
    this.name = "HistoricalShipStationContentsRecoveryError";
  }
}

interface ProviderContentsLine {
  readonly sku: string;
  readonly quantity: number;
}

function isPositivePostgresInteger(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) > 0
    && (value as number) <= POSTGRES_INTEGER_MAX;
}

function exactSku(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SKU_LENGTH) {
    return null;
  }
  return value.trim() === value ? value : null;
}

function providerLines(rawItems: unknown): readonly ProviderContentsLine[] | null {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_PACKAGE_LINES) {
    return null;
  }
  const lines: ProviderContentsLine[] = [];
  for (const rawItem of rawItems) {
    if (rawItem === null || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      return null;
    }
    const item = rawItem as Record<string, unknown>;
    const sku = exactSku(item.sku);
    if (sku === null || !isPositivePostgresInteger(item.quantity)) return null;
    lines.push(Object.freeze({ sku, quantity: item.quantity }));
  }
  return Object.freeze(lines);
}

function validatedExpectedLines(
  evidence: Extract<HistoricalShipStationExpectedContentsEvidence, { kind: "available" }>,
): readonly HistoricalShipStationExpectedContentsLine[] {
  if (evidence.lines.length > MAX_PACKAGE_LINES) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_EXPECTED_CONTENTS_EVIDENCE",
      "Linked WMS package contents exceed the recovery safety bound",
      { observedLineCount: evidence.lines.length, maxLineCount: MAX_PACKAGE_LINES },
    );
  }
  const sourceIds = new Set<number>();
  const lines = evidence.lines.map((line) => {
    const sku = exactSku(line.sku);
    if (
      !isPositivePostgresInteger(line.wmsShipmentItemId)
      || !isPositivePostgresInteger(line.quantity)
      || sku === null
      || sourceIds.has(line.wmsShipmentItemId)
    ) {
      throw new HistoricalShipStationContentsRecoveryError(
        "INVALID_EXPECTED_CONTENTS_EVIDENCE",
        "Linked WMS package contents contain an invalid or duplicate source line",
      );
    }
    sourceIds.add(line.wmsShipmentItemId);
    return Object.freeze({
      wmsShipmentItemId: line.wmsShipmentItemId,
      sku,
      quantity: line.quantity,
    });
  });
  return Object.freeze(lines);
}

function occurrenceCounts(
  lines: readonly Readonly<{ sku: string; quantity: number }>[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = canonicalJson([line.sku, line.quantity]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sameCounts(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, count] of left) {
    if (right.get(key) !== count) return false;
  }
  return true;
}

/**
 * Determines whether a historical provider response with missing WMS line keys
 * can be mapped one-to-one to an already-linked WMS package. This function does
 * not persist evidence or grant automation authority.
 */
export function classifyHistoricalShipStationContentsRecovery(input: Readonly<{
  readonly providerStatus: ShipStationShipmentContentsEvidenceStatus;
  readonly rawProviderItems: unknown;
  readonly expectedContents: HistoricalShipStationExpectedContentsEvidence;
}>): HistoricalShipStationContentsRecoveryStatus {
  if (input.providerStatus === "authoritative") {
    return "provider_line_keys_authoritative";
  }
  if (input.providerStatus === "empty") return "provider_empty";
  if (input.providerStatus !== "unrecognized") return "provider_evidence_unavailable";

  const provider = providerLines(input.rawProviderItems);
  if (provider === null) return "provider_evidence_unavailable";
  if (input.expectedContents.kind === "unavailable") return "wms_lineage_unavailable";

  const expected = validatedExpectedLines(input.expectedContents);
  if (expected.length === 0) return "provider_wms_conflict";
  const providerCounts = occurrenceCounts(provider);
  const expectedCounts = occurrenceCounts(expected);
  if (!sameCounts(providerCounts, expectedCounts)) return "provider_wms_conflict";
  if (
    [...providerCounts.values()].some((count) => count > 1)
    || [...expectedCounts.values()].some((count) => count > 1)
  ) {
    return "ambiguous_wms_match";
  }
  return "exact_unique_wms_match";
}
