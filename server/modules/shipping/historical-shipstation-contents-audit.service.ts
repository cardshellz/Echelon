import type { ShipStationShipmentContentsEvidenceStatus } from "./carrier-tracking.domain";
import type { HistoricalShipStationContentsClient } from "./historical-shipstation-contents-audit.client";
import type { HistoricalShipStationContentsCandidateBatch } from "./historical-shipstation-contents-audit.repository";

const CONTENT_STATUSES: readonly ShipStationShipmentContentsEvidenceStatus[] = Object.freeze([
  "authoritative",
  "omitted",
  "empty",
  "unrecognized",
  "malformed",
  "mixed",
]);

export interface HistoricalShipStationContentsAuditReport {
  readonly mode: "read_only_historical_shipstation_contents_audit";
  readonly candidateLimit: number;
  readonly batchLimitReached: boolean;
  readonly selectedCandidateCount: number;
  readonly providerRequestCount: number;
  readonly providerShipmentFoundCount: number;
  readonly providerShipmentNotFoundCount: number;
  readonly providerRequestFailureCount: number;
  readonly contentsStatusCounts: Readonly<Record<ShipStationShipmentContentsEvidenceStatus, number>>;
  readonly providerAuthoritativeCount: number;
  readonly requiresLeadAttestationCount: number;
  readonly safeToAutoResolveCount: 0;
  readonly databaseTemporaryPrivilege: boolean;
}

export async function auditHistoricalShipStationContents(
  batch: HistoricalShipStationContentsCandidateBatch,
  client: HistoricalShipStationContentsClient,
): Promise<HistoricalShipStationContentsAuditReport> {
  if (
    !Number.isSafeInteger(batch.candidateLimit)
    || batch.candidateLimit < 1
    || batch.candidates.length > batch.candidateLimit
  ) {
    throw new TypeError("Historical ShipStation contents candidate batch is invalid");
  }

  const labelIds = new Set<string>();
  const providerIds = new Set<number>();
  for (const candidate of batch.candidates) {
    if (
      typeof candidate.shippingProviderLabelId !== "string"
      || !/^[1-9][0-9]*$/.test(candidate.shippingProviderLabelId)
      || !Number.isSafeInteger(candidate.providerShipmentId)
      || candidate.providerShipmentId <= 0
      || labelIds.has(candidate.shippingProviderLabelId)
      || providerIds.has(candidate.providerShipmentId)
    ) {
      throw new TypeError("Historical ShipStation contents candidate identity is invalid or duplicated");
    }
    labelIds.add(candidate.shippingProviderLabelId);
    providerIds.add(candidate.providerShipmentId);
  }

  const contentsStatusCounts: Record<ShipStationShipmentContentsEvidenceStatus, number> = {
    authoritative: 0,
    omitted: 0,
    empty: 0,
    unrecognized: 0,
    malformed: 0,
    mixed: 0,
  };
  let providerShipmentFoundCount = 0;
  let providerShipmentNotFoundCount = 0;
  let providerRequestFailureCount = 0;

  for (const candidate of batch.candidates) {
    try {
      const result = await client.loadShipmentContents(candidate.providerShipmentId);
      if (result.kind === "not_found") {
        providerShipmentNotFoundCount += 1;
        continue;
      }
      providerShipmentFoundCount += 1;
      contentsStatusCounts[result.evidence.status] += 1;
    } catch {
      providerRequestFailureCount += 1;
    }
  }

  const frozenStatusCounts = Object.freeze(
    Object.fromEntries(CONTENT_STATUSES.map((status) => [status, contentsStatusCounts[status]])),
  ) as Readonly<Record<ShipStationShipmentContentsEvidenceStatus, number>>;
  return Object.freeze({
    mode: "read_only_historical_shipstation_contents_audit",
    candidateLimit: batch.candidateLimit,
    batchLimitReached: batch.batchLimitReached,
    selectedCandidateCount: batch.candidates.length,
    providerRequestCount: batch.candidates.length,
    providerShipmentFoundCount,
    providerShipmentNotFoundCount,
    providerRequestFailureCount,
    contentsStatusCounts: frozenStatusCounts,
    providerAuthoritativeCount: frozenStatusCounts.authoritative,
    // A current provider response can support a later audited lead attestation,
    // but it cannot erase or silently override the historical V1 omission.
    requiresLeadAttestationCount: batch.candidates.length,
    safeToAutoResolveCount: 0,
    databaseTemporaryPrivilege: batch.databaseTemporaryPrivilege,
  });
}
