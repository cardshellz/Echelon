import type { ShipStationShipmentContentsEvidenceStatus } from "./carrier-tracking.domain";
import type { HistoricalShipStationContentsClient } from "./historical-shipstation-contents-audit.client";
import type { HistoricalShipStationContentsCandidateBatch } from "./historical-shipstation-contents-audit.repository";
import {
  HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_STATUSES,
  type HistoricalShipStationContentsRecoveryStatus,
  type HistoricalShipStationExpectedContentsEvidence,
} from "./historical-shipstation-contents-recovery.domain";

const CONTENT_STATUSES: readonly ShipStationShipmentContentsEvidenceStatus[] = Object.freeze([
  "authoritative",
  "omitted",
  "empty",
  "unrecognized",
  "malformed",
  "mixed",
]);
const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const EXPECTED_CONTENTS_UNAVAILABLE_REASONS = new Set([
  "no_linked_package",
  "ambiguous_linked_package",
  "linked_package_contents_unavailable",
]);

type RecoverableStatus =
  | "provider_line_keys_authoritative"
  | "exact_unique_wms_match";

export type HistoricalShipStationContentsReviewReason =
  | Exclude<HistoricalShipStationContentsRecoveryStatus, RecoverableStatus>
  | "provider_shipment_not_found"
  | "provider_request_failed";

export type HistoricalShipStationExpectedContentsSummary =
  | Readonly<{
      readonly kind: "available";
      readonly source: "physical_shipment" | "legacy_wms_shipment";
      readonly lineCount: number;
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly reason:
        | "no_linked_package"
        | "ambiguous_linked_package"
        | "linked_package_contents_unavailable";
    }>;

export interface HistoricalShipStationContentsReviewCase {
  readonly shippingProviderLabelId: string;
  readonly reason: HistoricalShipStationContentsReviewReason;
  readonly providerContentsStatus: ShipStationShipmentContentsEvidenceStatus | null;
  readonly providerItemCount: number | null;
  readonly canonicalLineCount: number | null;
  readonly expectedContents: HistoricalShipStationExpectedContentsSummary;
}

export interface HistoricalShipStationContentsAuditReport {
  readonly mode: "read_only_historical_shipstation_contents_audit";
  readonly candidateLimit: number;
  readonly beforeLabelId: string | null;
  readonly nextBeforeLabelId: string | null;
  readonly batchLimitReached: boolean;
  readonly selectedCandidateCount: number;
  readonly providerRequestCount: number;
  readonly providerShipmentFoundCount: number;
  readonly providerShipmentNotFoundCount: number;
  readonly providerRequestFailureCount: number;
  readonly contentsStatusCounts: Readonly<Record<ShipStationShipmentContentsEvidenceStatus, number>>;
  readonly recoveryStatusCounts: Readonly<Record<HistoricalShipStationContentsRecoveryStatus, number>>;
  readonly providerAuthoritativeCount: number;
  readonly recoverableProviderEvidenceCount: number;
  readonly reviewRequiredByCurrentEvidenceCount: number;
  readonly reviewCases: readonly HistoricalShipStationContentsReviewCase[];
  readonly requiresLeadAttestationCount: number;
  readonly safeToAutoResolveCount: 0;
  readonly databaseTemporaryPrivilege: boolean;
}

function validExpectedContents(
  evidence: unknown,
): evidence is HistoricalShipStationExpectedContentsEvidence {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    return false;
  }
  const record = evidence as Record<string, unknown>;
  if (record.kind === "unavailable") {
    return typeof record.reason === "string"
      && EXPECTED_CONTENTS_UNAVAILABLE_REASONS.has(record.reason);
  }
  if (
    record.kind !== "available"
    || (record.source !== "physical_shipment" && record.source !== "legacy_wms_shipment")
    || !Array.isArray(record.lines)
    || record.lines.length === 0
    || record.lines.length > 500
  ) {
    return false;
  }
  const sourceIds = new Set<number>();
  return record.lines.every((rawLine) => {
    if (rawLine === null || typeof rawLine !== "object" || Array.isArray(rawLine)) {
      return false;
    }
    const line = rawLine as Record<string, unknown>;
    if (
      !Number.isInteger(line.wmsShipmentItemId)
      || (line.wmsShipmentItemId as number) <= 0
      || (line.wmsShipmentItemId as number) > POSTGRES_INTEGER_MAX
      || !Number.isInteger(line.quantity)
      || (line.quantity as number) <= 0
      || (line.quantity as number) > POSTGRES_INTEGER_MAX
      || typeof line.sku !== "string"
      || line.sku.length === 0
      || line.sku.length > 100
      || line.sku.trim() !== line.sku
      || sourceIds.has(line.wmsShipmentItemId as number)
    ) {
      return false;
    }
    sourceIds.add(line.wmsShipmentItemId as number);
    return true;
  });
}

function validPositiveBigintString(value: unknown): value is string {
  return typeof value === "string"
    && /^[1-9][0-9]*$/.test(value)
    && BigInt(value) <= POSTGRES_BIGINT_MAX;
}

function isRecoverableStatus(
  status: HistoricalShipStationContentsRecoveryStatus,
): status is RecoverableStatus {
  return status === "provider_line_keys_authoritative"
    || status === "exact_unique_wms_match";
}

function expectedContentsSummary(
  evidence: HistoricalShipStationExpectedContentsEvidence,
): HistoricalShipStationExpectedContentsSummary {
  if (evidence.kind === "unavailable") {
    return Object.freeze({ kind: evidence.kind, reason: evidence.reason });
  }
  return Object.freeze({
    kind: evidence.kind,
    source: evidence.source,
    lineCount: evidence.lines.length,
  });
}

export async function auditHistoricalShipStationContents(
  batch: HistoricalShipStationContentsCandidateBatch,
  client: HistoricalShipStationContentsClient,
): Promise<HistoricalShipStationContentsAuditReport> {
  if (
    !Number.isSafeInteger(batch.candidateLimit)
    || batch.candidateLimit < 1
    || batch.candidates.length > batch.candidateLimit
    || typeof batch.batchLimitReached !== "boolean"
    || typeof batch.databaseTemporaryPrivilege !== "boolean"
    || (batch.beforeLabelId !== null && !validPositiveBigintString(batch.beforeLabelId))
    || (batch.nextBeforeLabelId !== null && !validPositiveBigintString(batch.nextBeforeLabelId))
  ) {
    throw new TypeError("Historical ShipStation contents candidate batch is invalid");
  }

  const labelIds = new Set<string>();
  const providerIds = new Set<number>();
  let previousLabelId = batch.beforeLabelId;
  for (const candidate of batch.candidates) {
    if (
      !validPositiveBigintString(candidate.shippingProviderLabelId)
      || !Number.isSafeInteger(candidate.providerShipmentId)
      || candidate.providerShipmentId <= 0
      || !validExpectedContents(candidate.expectedContents)
      || labelIds.has(candidate.shippingProviderLabelId)
      || providerIds.has(candidate.providerShipmentId)
    ) {
      throw new TypeError("Historical ShipStation contents candidate evidence is invalid or duplicated");
    }
    if (
      previousLabelId !== null
      && BigInt(candidate.shippingProviderLabelId) >= BigInt(previousLabelId)
    ) {
      throw new TypeError("Historical ShipStation contents candidates are not in strict descending label-id order");
    }
    labelIds.add(candidate.shippingProviderLabelId);
    providerIds.add(candidate.providerShipmentId);
    previousLabelId = candidate.shippingProviderLabelId;
  }

  const expectedNextBeforeLabelId = batch.batchLimitReached
    ? batch.candidates.at(-1)?.shippingProviderLabelId ?? null
    : null;
  if (
    (expectedNextBeforeLabelId === null && batch.batchLimitReached)
    || batch.nextBeforeLabelId !== expectedNextBeforeLabelId
  ) {
    throw new TypeError("Historical ShipStation contents pagination evidence is invalid");
  }

  const contentsStatusCounts: Record<ShipStationShipmentContentsEvidenceStatus, number> = {
    authoritative: 0,
    omitted: 0,
    empty: 0,
    unrecognized: 0,
    malformed: 0,
    mixed: 0,
  };
  const recoveryStatusCounts = Object.fromEntries(
    HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_STATUSES.map((status) => [status, 0]),
  ) as Record<HistoricalShipStationContentsRecoveryStatus, number>;
  let providerShipmentFoundCount = 0;
  let providerShipmentNotFoundCount = 0;
  let providerRequestFailureCount = 0;
  const reviewCases: HistoricalShipStationContentsReviewCase[] = [];
  const addReviewCase = (
    candidate: HistoricalShipStationContentsCandidateBatch["candidates"][number],
    reason: HistoricalShipStationContentsReviewReason,
    evidence: Readonly<{
      readonly status: ShipStationShipmentContentsEvidenceStatus;
      readonly providerItemCount: number;
      readonly canonicalLineCount: number;
    }> | null = null,
  ): void => {
    reviewCases.push(Object.freeze({
      shippingProviderLabelId: candidate.shippingProviderLabelId,
      reason,
      providerContentsStatus: evidence?.status ?? null,
      providerItemCount: evidence?.providerItemCount ?? null,
      canonicalLineCount: evidence?.canonicalLineCount ?? null,
      expectedContents: expectedContentsSummary(candidate.expectedContents),
    }));
  };

  for (const candidate of batch.candidates) {
    try {
      const result = await client.loadShipmentContents(
        candidate.providerShipmentId,
        candidate.expectedContents,
      );
      if (result.kind === "not_found") {
        providerShipmentNotFoundCount += 1;
        addReviewCase(candidate, "provider_shipment_not_found");
        continue;
      }
      providerShipmentFoundCount += 1;
      contentsStatusCounts[result.evidence.status] += 1;
      recoveryStatusCounts[result.evidence.recoveryStatus] += 1;
      if (!isRecoverableStatus(result.evidence.recoveryStatus)) {
        addReviewCase(candidate, result.evidence.recoveryStatus, result.evidence);
      }
    } catch {
      providerRequestFailureCount += 1;
      addReviewCase(candidate, "provider_request_failed");
    }
  }

  const frozenStatusCounts = Object.freeze(
    Object.fromEntries(CONTENT_STATUSES.map((status) => [status, contentsStatusCounts[status]])),
  ) as Readonly<Record<ShipStationShipmentContentsEvidenceStatus, number>>;
  const frozenRecoveryStatusCounts = Object.freeze(
    Object.fromEntries(
      HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_STATUSES.map(
        (status) => [status, recoveryStatusCounts[status]],
      ),
    ),
  ) as Readonly<Record<HistoricalShipStationContentsRecoveryStatus, number>>;
  const recoverableProviderEvidenceCount =
    frozenRecoveryStatusCounts.provider_line_keys_authoritative
    + frozenRecoveryStatusCounts.exact_unique_wms_match;
  const frozenReviewCases = Object.freeze(reviewCases);
  return Object.freeze({
    mode: "read_only_historical_shipstation_contents_audit",
    candidateLimit: batch.candidateLimit,
    beforeLabelId: batch.beforeLabelId,
    nextBeforeLabelId: batch.nextBeforeLabelId,
    batchLimitReached: batch.batchLimitReached,
    selectedCandidateCount: batch.candidates.length,
    providerRequestCount: batch.candidates.length,
    providerShipmentFoundCount,
    providerShipmentNotFoundCount,
    providerRequestFailureCount,
    contentsStatusCounts: frozenStatusCounts,
    recoveryStatusCounts: frozenRecoveryStatusCounts,
    providerAuthoritativeCount: frozenStatusCounts.authoritative,
    recoverableProviderEvidenceCount,
    reviewRequiredByCurrentEvidenceCount: frozenReviewCases.length,
    reviewCases: frozenReviewCases,
    // Recovery evidence is preview-only. A later audited write path must decide
    // whether and how to attest historical V1 omissions.
    requiresLeadAttestationCount: batch.candidates.length,
    safeToAutoResolveCount: 0,
    databaseTemporaryPrivilege: batch.databaseTemporaryPrivilege,
  });
}
