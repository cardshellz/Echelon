import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import type {
  HistoricalShipStationContentsClient,
  HistoricalShipStationContentsEvidenceSummary,
} from "./historical-shipstation-contents-audit.client";
import {
  buildHistoricalShipStationContentsSystemRecoveryEvent,
  HISTORICAL_SHIPSTATION_RECOVERY_EVIDENCE_CONTRACT_VERSION,
  historicalShipStationRecoverableCaseEvidenceHash,
  type HistoricalShipStationContentsRecoveryEvidence,
} from "./historical-shipstation-contents-recovery.domain";
import type {
  HistoricalShipStationContentsSystemRecoveryCandidate,
  HistoricalShipStationContentsSystemRecoveryRepository,
  PersistedHistoricalShipStationContentsSystemRecovery,
} from "./historical-shipstation-contents-system-recovery.repository";

const POSTGRES_BIGINT_MAX_TEXT = "9223372036854775807";

const positivePostgresBigintTextSchema = z.string().regex(/^[1-9][0-9]*$/).refine(
  (value) => value.length < POSTGRES_BIGINT_MAX_TEXT.length
    || (value.length === POSTGRES_BIGINT_MAX_TEXT.length && value <= POSTGRES_BIGINT_MAX_TEXT),
  "must fit a positive PostgreSQL bigint",
);

export type HistoricalShipStationContentsSystemRecoveryServiceErrorCode =
  | "CANDIDATE_CHANGED"
  | "CANDIDATE_NOT_FOUND"
  | "INVALID_LABEL_ID"
  | "INVALID_PREVIEW_EVIDENCE_HASH"
  | "NO_RESOLVABLE_EVENTS"
  | "PROVIDER_EVIDENCE_CHANGED"
  | "PROVIDER_EVIDENCE_NOT_RECOVERABLE"
  | "PROVIDER_SHIPMENT_NOT_FOUND";

export class HistoricalShipStationContentsSystemRecoveryServiceError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsSystemRecoveryServiceErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = Object.freeze({}),
  ) {
    super(message);
    this.name = "HistoricalShipStationContentsSystemRecoveryServiceError";
  }
}

function sameCandidate(
  left: HistoricalShipStationContentsSystemRecoveryCandidate,
  right: HistoricalShipStationContentsSystemRecoveryCandidate,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validRecoveryEvidence(
  evidence: HistoricalShipStationContentsRecoveryEvidence,
  summary: HistoricalShipStationContentsEvidenceSummary,
): boolean {
  const providerLineKeys = evidence.recoveryStatus === "provider_line_keys_authoritative";
  const expectedProviderStatus = providerLineKeys ? "authoritative" : "unrecognized";
  const expectedRecognizedCount = providerLineKeys ? evidence.attestedContents.length : 0;
  const expectedCanonicalLineCount = providerLineKeys ? evidence.attestedContents.length : 0;
  const expectedUnrecognizedCount = providerLineKeys ? 0 : evidence.attestedContents.length;
  if (
    evidence.contractVersion !== HISTORICAL_SHIPSTATION_RECOVERY_EVIDENCE_CONTRACT_VERSION
    || !["provider_line_keys_authoritative", "exact_unique_wms_match"].includes(
      evidence.recoveryStatus,
    )
    || !/^[0-9a-f]{64}$/.test(evidence.evidenceHash)
    || evidence.attestedContents.length < 1
    || evidence.attestedContents.length > 500
    || summary.recoveryStatus !== evidence.recoveryStatus
    || summary.recoveryEvidence?.contractVersion !== evidence.contractVersion
    || summary.recoveryEvidence.evidenceHash !== evidence.evidenceHash
    || summary.recoveryEvidence.attestedLineCount !== evidence.attestedContents.length
    || summary.status !== expectedProviderStatus
    || summary.providerItemCount !== evidence.attestedContents.length
    || summary.recognizedProviderItemCount !== expectedRecognizedCount
    || summary.canonicalLineCount !== expectedCanonicalLineCount
    || summary.malformedItemCount !== 0
    || summary.unrecognizedItemCount !== expectedUnrecognizedCount
    || summary.duplicateLineItemCount !== 0
  ) {
    return false;
  }
  const sourceIds = new Set<number>();
  return evidence.attestedContents.every((line) => {
    if (
      !Number.isSafeInteger(line.wmsShipmentItemId)
      || line.wmsShipmentItemId <= 0
      || line.wmsShipmentItemId > 2_147_483_647
      || !Number.isSafeInteger(line.quantity)
      || line.quantity <= 0
      || line.quantity > 2_147_483_647
      || sourceIds.has(line.wmsShipmentItemId)
    ) {
      return false;
    }
    sourceIds.add(line.wmsShipmentItemId);
    return true;
  });
}

/**
 * Persists one provable historical contents recovery. Provider I/O happens
 * before the serializable transaction; the exact candidate is then reloaded
 * and compared under lock before any immutable evidence is appended.
 */
export class HistoricalShipStationContentsSystemRecoveryService {
  constructor(
    private readonly repository: HistoricalShipStationContentsSystemRecoveryRepository,
    private readonly providerClient: HistoricalShipStationContentsClient,
  ) {}

  async recover(
    rawShippingProviderLabelId: string,
    expectedPreviewEvidenceHash: string,
  ): Promise<PersistedHistoricalShipStationContentsSystemRecovery> {
    const parsedLabelId = positivePostgresBigintTextSchema.safeParse(rawShippingProviderLabelId);
    if (!parsedLabelId.success) {
      throw new HistoricalShipStationContentsSystemRecoveryServiceError(
        "INVALID_LABEL_ID",
        "Historical contents system recovery label identifier failed validation",
        Object.freeze({
          issues: parsedLabelId.error.issues.map((issue) => Object.freeze({
            code: issue.code,
            path: ["shippingProviderLabelId"],
            message: issue.message,
          })),
        }),
      );
    }
    const shippingProviderLabelId = parsedLabelId.data;
    if (!/^[0-9a-f]{64}$/.test(expectedPreviewEvidenceHash)) {
      throw new HistoricalShipStationContentsSystemRecoveryServiceError(
        "INVALID_PREVIEW_EVIDENCE_HASH",
        "Historical contents system recovery preview evidence hash failed validation",
        Object.freeze({ shippingProviderLabelId }),
      );
    }
    const snapshot = await this.repository.loadSnapshot(shippingProviderLabelId);
    if (snapshot === null) {
      throw new HistoricalShipStationContentsSystemRecoveryServiceError(
        "CANDIDATE_NOT_FOUND",
        "Historical contents system recovery candidate is not eligible",
        Object.freeze({ shippingProviderLabelId }),
      );
    }
    const providerResult = await this.providerClient.loadShipmentContents(
      snapshot.candidate.providerShipmentId,
      snapshot.candidate.expectedContents,
    );
    if (providerResult.kind === "not_found") {
      throw new HistoricalShipStationContentsSystemRecoveryServiceError(
        "PROVIDER_SHIPMENT_NOT_FOUND",
        "Historical contents system recovery provider shipment was not found",
        Object.freeze({ shippingProviderLabelId }),
      );
    }
    const recoveryEvidence = providerResult.recoveryEvidenceDetails ?? null;
    if (
      recoveryEvidence === null
      || !validRecoveryEvidence(recoveryEvidence, providerResult.evidence)
    ) {
      throw new HistoricalShipStationContentsSystemRecoveryServiceError(
        "PROVIDER_EVIDENCE_NOT_RECOVERABLE",
        "Historical contents system recovery provider evidence is not provable",
        Object.freeze({
          shippingProviderLabelId,
          recoveryStatus: providerResult.evidence.recoveryStatus,
        }),
      );
    }
    const currentPreviewEvidenceHash = historicalShipStationRecoverableCaseEvidenceHash({
      shippingProviderLabelId,
      recoveryStatus: recoveryEvidence.recoveryStatus,
      providerEvidenceHash: recoveryEvidence.evidenceHash,
    });
    if (currentPreviewEvidenceHash !== expectedPreviewEvidenceHash) {
      throw new HistoricalShipStationContentsSystemRecoveryServiceError(
        "PROVIDER_EVIDENCE_CHANGED",
        "Historical contents provider evidence changed after preview",
        Object.freeze({ shippingProviderLabelId }),
      );
    }

    return this.repository.withSerializableTransaction(async (transaction) => {
      const lockedCandidate = await transaction.loadCandidateForUpdate(shippingProviderLabelId);
      if (lockedCandidate === null || !sameCandidate(snapshot.candidate, lockedCandidate)) {
        throw new HistoricalShipStationContentsSystemRecoveryServiceError(
          "CANDIDATE_CHANGED",
          "Historical contents candidate changed before system recovery could be persisted",
          Object.freeze({ shippingProviderLabelId }),
        );
      }
      const resolvedLabelEventIds = await transaction.loadResolvableLabelEventIds(
        shippingProviderLabelId,
      );
      if (resolvedLabelEventIds.length === 0) {
        throw new HistoricalShipStationContentsSystemRecoveryServiceError(
          "NO_RESOLVABLE_EVENTS",
          "Historical contents system recovery found no named non-authoritative provider evidence",
          Object.freeze({ shippingProviderLabelId }),
        );
      }
      const event = buildHistoricalShipStationContentsSystemRecoveryEvent({
        shippingProviderLabelId,
        providerShipmentId: lockedCandidate.providerShipmentId,
        trackingNumber: lockedCandidate.trackingNumber,
        labelStatus: lockedCandidate.labelStatus,
        recoveryEvidence,
        resolvedLabelEventIds,
      });
      return transaction.appendExactRecovery(shippingProviderLabelId, event);
    });
  }
}
