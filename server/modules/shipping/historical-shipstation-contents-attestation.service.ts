import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import type {
  HistoricalShipStationContentsClient,
  HistoricalShipStationContentsEvidenceSummary,
} from "./historical-shipstation-contents-audit.client";
import type { HistoricalShipStationContentsCandidate } from "./historical-shipstation-contents-audit.repository";
import {
  historicalShipStationRecoverableCaseEvidenceHash,
  type HistoricalShipStationContentsRecoveryEvidence,
} from "./historical-shipstation-contents-recovery.domain";
import type {
  HistoricalShipStationContentsAttestationRepository,
  HistoricalShipStationContentsAttestationRecord,
  PersistedHistoricalShipStationContentsAttestation,
} from "./historical-shipstation-contents-attestation.repository";

const POSTGRES_BIGINT_MAX_TEXT = "9223372036854775807";

const positivePostgresBigintTextSchema = z.string().regex(/^[1-9][0-9]*$/).refine(
  (value) => value.length < POSTGRES_BIGINT_MAX_TEXT.length
    || (value.length === POSTGRES_BIGINT_MAX_TEXT.length && value <= POSTGRES_BIGINT_MAX_TEXT),
  "must fit a positive PostgreSQL bigint",
);

export const historicalShipStationContentsAttestationCommandSchema = z.object({
  shippingProviderLabelId: positivePostgresBigintTextSchema,
  expectedPreviewEvidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  authenticatedActorUserId: z.string().min(1).max(190)
    .refine((value) => value.trim() === value, "must not contain surrounding whitespace"),
  reason: z.string().min(1).max(500)
    .refine((value) => value.trim() === value, "must not contain surrounding whitespace"),
}).strict();

export type HistoricalShipStationContentsAttestationCommand = z.infer<
  typeof historicalShipStationContentsAttestationCommandSchema
>;

export interface HistoricalShipStationContentsAttestationPreview {
  readonly shippingProviderLabelId: string;
  readonly providerShipmentId: number;
  readonly providerContentsStatus: HistoricalShipStationContentsEvidenceSummary["status"];
  readonly recoveryStatus: HistoricalShipStationContentsRecoveryEvidence["recoveryStatus"];
  readonly previewEvidenceHash: string;
  readonly providerEvidenceHash: string;
  readonly expectedContents: HistoricalShipStationContentsCandidate["expectedContents"];
  readonly attestedContents: HistoricalShipStationContentsRecoveryEvidence["attestedContents"];
}

interface LoadedHistoricalShipStationContentsAttestationPreview {
  readonly candidate: HistoricalShipStationContentsCandidate;
  readonly recoveryEvidence: HistoricalShipStationContentsRecoveryEvidence;
  readonly preview: HistoricalShipStationContentsAttestationPreview;
}

export type HistoricalShipStationContentsAttestationServiceErrorCode =
  | "CANDIDATE_CHANGED"
  | "CANDIDATE_NOT_FOUND"
  | "INVALID_COMMAND"
  | "LEAD_AUTHORIZATION_REQUIRED"
  | "NO_RESOLVABLE_EVENTS"
  | "PREVIEW_EVIDENCE_MISMATCH"
  | "PROVIDER_EVIDENCE_NOT_RECOVERABLE"
  | "PROVIDER_SHIPMENT_NOT_FOUND";

export class HistoricalShipStationContentsAttestationServiceError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsAttestationServiceErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = Object.freeze({}),
  ) {
    super(message);
    this.name = "HistoricalShipStationContentsAttestationServiceError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameCandidate(
  left: HistoricalShipStationContentsCandidate,
  right: HistoricalShipStationContentsCandidate,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validRecoveryEvidence(
  evidence: HistoricalShipStationContentsRecoveryEvidence,
  summary: Readonly<{
    readonly recoveryStatus: string;
    readonly recoveryEvidence: Readonly<{
      readonly contractVersion: number;
      readonly evidenceHash: string;
      readonly attestedLineCount: number;
    }> | null;
  }>,
): boolean {
  if (
    evidence.contractVersion !== 1
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
function attestationHash(record: Readonly<{
  readonly candidate: HistoricalShipStationContentsCandidate;
  readonly recoveryEvidence: HistoricalShipStationContentsRecoveryEvidence;
  readonly previewEvidenceHash: string;
  readonly actorUserId: string;
  readonly actorRole: "admin" | "lead";
  readonly reason: string;
  readonly resolvedLabelEventIds: readonly string[];
}>): string {
  return sha256(canonicalJson(Object.freeze({
    contract: "historical_shipstation_contents_lead_attestation_v1",
    contractVersion: 1,
    shippingProviderLabelId: record.candidate.shippingProviderLabelId,
    providerShipmentId: record.candidate.providerShipmentId,
    recoveryEvidence: record.recoveryEvidence,
    previewEvidenceHash: record.previewEvidenceHash,
    actorUserId: record.actorUserId,
    actorRole: record.actorRole,
    reason: record.reason,
    resolvedLabelEventIds: record.resolvedLabelEventIds,
  })));
}

export class HistoricalShipStationContentsAttestationService {
  constructor(
    private readonly repository: HistoricalShipStationContentsAttestationRepository,
    private readonly providerClient: HistoricalShipStationContentsClient,
  ) {}

  async preview(
    rawShippingProviderLabelId: string,
  ): Promise<HistoricalShipStationContentsAttestationPreview> {
    const parsedLabelId = positivePostgresBigintTextSchema.safeParse(rawShippingProviderLabelId);
    if (!parsedLabelId.success) {
      throw new HistoricalShipStationContentsAttestationServiceError(
        "INVALID_COMMAND",
        "Historical contents attestation preview identifier failed validation",
        Object.freeze({
          issues: parsedLabelId.error.issues.map((issue) => Object.freeze({
            code: issue.code,
            path: ["shippingProviderLabelId"],
            message: issue.message,
          })),
        }),
      );
    }
    const loaded = await this.loadPreview(parsedLabelId.data);
    return loaded.preview;
  }

  async attest(
    rawCommand: HistoricalShipStationContentsAttestationCommand,
  ): Promise<PersistedHistoricalShipStationContentsAttestation> {
    const parsed = historicalShipStationContentsAttestationCommandSchema.safeParse(rawCommand);
    if (!parsed.success) {
      throw new HistoricalShipStationContentsAttestationServiceError(
        "INVALID_COMMAND",
        "Historical contents attestation command failed validation",
        Object.freeze({
          issues: parsed.error.issues.map((issue) => Object.freeze({
            code: issue.code,
            path: issue.path.map(String),
            message: issue.message,
          })),
        }),
      );
    }
    const command = parsed.data;
    const loaded = await this.loadPreview(command.shippingProviderLabelId);
    const { candidate, recoveryEvidence, preview } = loaded;
    const previewEvidenceHash = preview.previewEvidenceHash;
    if (previewEvidenceHash !== command.expectedPreviewEvidenceHash) {
      throw new HistoricalShipStationContentsAttestationServiceError(
        "PREVIEW_EVIDENCE_MISMATCH",
        "Historical contents evidence changed after preview and requires a new review",
        Object.freeze({ shippingProviderLabelId: command.shippingProviderLabelId }),
      );
    }

    return this.repository.withSerializableTransaction(async (transaction) => {
      const actor = await transaction.lockAuthorizedActor(command.authenticatedActorUserId);
      if (actor === null) {
        throw new HistoricalShipStationContentsAttestationServiceError(
          "LEAD_AUTHORIZATION_REQUIRED",
          "Historical contents attestation requires an active lead or administrator account",
        );
      }
      const lockedCandidate = await transaction.loadCandidateForUpdate(
        command.shippingProviderLabelId,
      );
      if (lockedCandidate === null || !sameCandidate(candidate, lockedCandidate)) {
        throw new HistoricalShipStationContentsAttestationServiceError(
          "CANDIDATE_CHANGED",
          "Historical contents candidate changed while the attestation was being authorized",
          Object.freeze({ shippingProviderLabelId: command.shippingProviderLabelId }),
        );
      }
      const resolvedLabelEventIds = await transaction.loadResolvableLabelEventIds(
        command.shippingProviderLabelId,
      );
      if (resolvedLabelEventIds.length === 0) {
        throw new HistoricalShipStationContentsAttestationServiceError(
          "NO_RESOLVABLE_EVENTS",
          "Historical contents attestation found no named non-authoritative provider evidence",
          Object.freeze({ shippingProviderLabelId: command.shippingProviderLabelId }),
        );
      }
      const hash = attestationHash({
        candidate: lockedCandidate,
        recoveryEvidence,
        previewEvidenceHash,
        actorUserId: actor.userId,
        actorRole: actor.role,
        reason: command.reason,
        resolvedLabelEventIds,
      });
      const record: HistoricalShipStationContentsAttestationRecord = Object.freeze({
        shippingProviderLabelId: lockedCandidate.shippingProviderLabelId,
        recoveryEvidence,
        previewEvidenceHash,
        actor,
        reason: command.reason,
        attestationHash: hash,
        resolvedLabelEventIds,
      });
      return transaction.appendExactAttestation(record);
    });
  }

  private async loadPreview(
    shippingProviderLabelId: string,
  ): Promise<LoadedHistoricalShipStationContentsAttestationPreview> {
    const candidate = await this.repository.loadCandidateSnapshot(shippingProviderLabelId);
    if (candidate === null) {
      throw new HistoricalShipStationContentsAttestationServiceError(
        "CANDIDATE_NOT_FOUND",
        "Historical contents attestation candidate is no longer eligible",
        Object.freeze({ shippingProviderLabelId }),
      );
    }

    const providerResult = await this.providerClient.loadShipmentContents(
      candidate.providerShipmentId,
      candidate.expectedContents,
    );
    if (providerResult.kind === "not_found") {
      throw new HistoricalShipStationContentsAttestationServiceError(
        "PROVIDER_SHIPMENT_NOT_FOUND",
        "Historical contents attestation provider shipment was not found",
        Object.freeze({ shippingProviderLabelId }),
      );
    }
    const recoveryEvidence = providerResult.recoveryEvidenceDetails ?? null;
    if (
      recoveryEvidence === null
      || !validRecoveryEvidence(recoveryEvidence, providerResult.evidence)
    ) {
      throw new HistoricalShipStationContentsAttestationServiceError(
        "PROVIDER_EVIDENCE_NOT_RECOVERABLE",
        "Historical contents attestation provider evidence is not recoverable",
        Object.freeze({
          shippingProviderLabelId,
          recoveryStatus: providerResult.evidence.recoveryStatus,
        }),
      );
    }
    const previewEvidenceHash = historicalShipStationRecoverableCaseEvidenceHash({
      shippingProviderLabelId: candidate.shippingProviderLabelId,
      recoveryStatus: recoveryEvidence.recoveryStatus,
      providerEvidenceHash: recoveryEvidence.evidenceHash,
    });
    const preview: HistoricalShipStationContentsAttestationPreview = Object.freeze({
      shippingProviderLabelId: candidate.shippingProviderLabelId,
      providerShipmentId: candidate.providerShipmentId,
      providerContentsStatus: providerResult.evidence.status,
      recoveryStatus: recoveryEvidence.recoveryStatus,
      previewEvidenceHash,
      providerEvidenceHash: recoveryEvidence.evidenceHash,
      expectedContents: candidate.expectedContents,
      attestedContents: recoveryEvidence.attestedContents,
    });
    return Object.freeze({ candidate, recoveryEvidence, preview });
  }
}
