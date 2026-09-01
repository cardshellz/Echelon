import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import type {
  HistoricalShipStationContentsClient,
  HistoricalShipStationContentsProviderObservation,
} from "./historical-shipstation-contents-audit.client";
import type { HistoricalShipStationContentsReviewReason } from "./historical-shipstation-contents-audit.service";
import {
  buildHistoricalShipStationWmsConfirmationEvidence,
  type HistoricalShipStationContentsRecoveryEvidence,
  type HistoricalShipStationExpectedContentsEvidence,
} from "./historical-shipstation-contents-recovery.domain";

const positiveBigintText = z.string().regex(/^[1-9][0-9]*$/);
const positiveInteger = z.number().int().positive().safe();
const evidenceHash = z.string().regex(/^[0-9a-f]{64}$/);
const reviewIntakeReason = z.enum([
  "provider_empty",
  "provider_evidence_unavailable",
  "wms_lineage_unavailable",
  "ambiguous_wms_match",
  "provider_wms_conflict",
]);

export const HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE =
  "historical_shipstation_contents_review" as const;

export interface HistoricalShipStationContentsReviewCandidate {
  readonly shippingProviderLabelId: string;
  readonly providerShipmentId: number;
  readonly trackingNumber: string;
  readonly labelStatus: "active" | "voided" | "superseded" | "unknown";
  readonly expectedContents: HistoricalShipStationExpectedContentsEvidence;
  readonly shipStationOrderId: string | null;
  readonly wmsOrders: readonly Readonly<{
    readonly wmsOrderId: number;
    readonly orderNumber: string;
  }>[];
  readonly linkedShipments: readonly Readonly<{
    readonly source: "physical_shipment" | "legacy_wms_shipment";
    readonly shipmentId: string;
  }>[];
  readonly linePresentations: readonly Readonly<{
    readonly wmsShipmentItemId: number;
    readonly itemName: string | null;
  }>[];
}

export interface HistoricalShipStationContentsReviewSnapshot {
  readonly exceptionId: string | null;
  readonly candidate: HistoricalShipStationContentsReviewCandidate;
  readonly reason: HistoricalShipStationContentsReviewReason;
  readonly providerObservationHash: string;
  readonly providerRecoveryStatus: string;
  readonly recordedDecision?:
    | "provider_confirmed_pending_inventory_correction"
    | "cannot_prove"
    | null;
}

export interface HistoricalShipStationContentsReviewRecord {
  readonly candidate: HistoricalShipStationContentsReviewCandidate;
  readonly reason: HistoricalShipStationContentsReviewReason;
  readonly providerRecoveryStatus: string;
  readonly providerContentsStatus: string;
  readonly providerObservation: HistoricalShipStationContentsProviderObservation;
}

export interface PersistedHistoricalShipStationContentsReview {
  readonly kind: "created" | "updated" | "already_persisted";
  readonly exceptionId: string;
  readonly shippingProviderLabelId: string;
}

export interface PersistedHistoricalShipStationContentsWmsResolution {
  readonly kind: "created" | "already_persisted";
  readonly exceptionId: string;
  readonly shippingProviderLabelId: string;
  readonly labelEventId: string;
  readonly eventHash: string;
}

export interface HistoricalShipStationContentsReviewRepository {
  loadCandidate(shippingProviderLabelId: string): Promise<HistoricalShipStationContentsReviewCandidate | null>;
  loadOpenReview(exceptionId: string): Promise<HistoricalShipStationContentsReviewSnapshot | null>;
  upsertReview(record: HistoricalShipStationContentsReviewRecord): Promise<PersistedHistoricalShipStationContentsReview>;
  loadWmsResolutionReplay(input: Readonly<{
    readonly exceptionId: string;
    readonly expectedPreviewHash: string;
    readonly actorUserId: string;
    readonly reason: string;
  }>): Promise<PersistedHistoricalShipStationContentsWmsResolution | null>;
  confirmWmsContents(input: Readonly<{
    readonly snapshot: HistoricalShipStationContentsReviewSnapshot;
    readonly recoveryEvidence: HistoricalShipStationContentsRecoveryEvidence;
    readonly expectedPreviewHash: string;
    readonly actorUserId: string;
    readonly reason: string;
  }>): Promise<PersistedHistoricalShipStationContentsWmsResolution>;
  recordDecision(input: Readonly<{
    readonly exceptionId: string;
    readonly expectedPreviewHash: string;
    readonly actorUserId: string;
    readonly decision: "provider_confirmed_pending_inventory_correction" | "cannot_prove";
    readonly reason: string;
  }>): Promise<Readonly<{ readonly exceptionId: string; readonly status: "open" | "acknowledged" }>>;
}

export type HistoricalShipStationContentsReviewServiceErrorCode =
  | "CANDIDATE_CHANGED"
  | "CANDIDATE_NOT_FOUND"
  | "INVALID_COMMAND"
  | "PROVIDER_EVIDENCE_CHANGED"
  | "PROVIDER_SHIPMENT_NOT_FOUND"
  | "REVIEW_NOT_FOUND"
  | "WMS_CONTENTS_UNAVAILABLE";

export class HistoricalShipStationContentsReviewServiceError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsReviewServiceErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = Object.freeze({}),
  ) {
    super(message);
    this.name = "HistoricalShipStationContentsReviewServiceError";
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function exactReason(value: unknown): string {
  const parsed = z.string().min(1).max(500)
    .refine((candidate) => candidate.trim() === candidate)
    .safeParse(value);
  if (!parsed.success) {
    throw new HistoricalShipStationContentsReviewServiceError(
      "INVALID_COMMAND",
      "A review reason of 1 to 500 characters is required without surrounding whitespace",
    );
  }
  return parsed.data;
}

function exactActor(value: unknown): string {
  const parsed = z.string().min(1).max(190)
    .refine((candidate) => candidate.trim() === candidate)
    .safeParse(value);
  if (!parsed.success) {
    throw new HistoricalShipStationContentsReviewServiceError(
      "INVALID_COMMAND",
      "Authenticated actor identity failed validation",
    );
  }
  return parsed.data;
}

function sameCandidate(
  left: HistoricalShipStationContentsReviewCandidate,
  right: HistoricalShipStationContentsReviewCandidate,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export interface HistoricalShipStationContentsResolutionPreview {
  readonly exceptionId: string;
  readonly shippingProviderLabelId: string;
  readonly previewEvidenceHash: string;
  readonly orderNumber: string | null;
  readonly trackingNumber: string;
  readonly providerRecoveryStatus: string;
  readonly recordedDecision:
    | "provider_confirmed_pending_inventory_correction"
    | "cannot_prove"
    | null;
  readonly providerContents: readonly Readonly<{ readonly sku: string; readonly quantity: number }>[] | null;
  readonly wmsContents: readonly Readonly<{
    readonly wmsShipmentItemId: number;
    readonly sku: string;
    readonly itemName: string | null;
    readonly quantity: number;
  }>[] | null;
  readonly allowedDecisions: readonly (
    | "wms_confirmed"
    | "provider_confirmed_pending_inventory_correction"
    | "cannot_prove"
  )[];
}

interface LoadedPreview {
  readonly snapshot: HistoricalShipStationContentsReviewSnapshot;
  readonly preview: HistoricalShipStationContentsResolutionPreview;
  readonly providerObservation: HistoricalShipStationContentsProviderObservation;
}

export class HistoricalShipStationContentsReviewService {
  constructor(
    private readonly repository: HistoricalShipStationContentsReviewRepository,
    private readonly providerClient: HistoricalShipStationContentsClient,
  ) {}

  async intake(input: Readonly<{
    readonly shippingProviderLabelId: string;
    readonly reason: HistoricalShipStationContentsReviewReason;
    readonly expectedEvidenceHash: string;
  }>): Promise<PersistedHistoricalShipStationContentsReview> {
    const parsed = z.object({
      shippingProviderLabelId: positiveBigintText,
      reason: reviewIntakeReason,
      expectedEvidenceHash: evidenceHash,
    }).strict().safeParse(input);
    if (!parsed.success) {
      throw new HistoricalShipStationContentsReviewServiceError(
        "INVALID_COMMAND",
        "Historical contents review intake failed validation",
      );
    }
    const candidate = await this.repository.loadCandidate(parsed.data.shippingProviderLabelId);
    if (candidate === null) {
      throw new HistoricalShipStationContentsReviewServiceError(
        "CANDIDATE_NOT_FOUND",
        "Historical contents review candidate is no longer eligible",
      );
    }
    const provider = await this.providerClient.loadShipmentContents(
      candidate.providerShipmentId,
      candidate.expectedContents,
    );
    if (provider.kind === "not_found") {
      throw new HistoricalShipStationContentsReviewServiceError(
        "PROVIDER_SHIPMENT_NOT_FOUND",
        "Historical contents review provider shipment was not found",
      );
    }
    if (
      provider.providerObservation.evidenceHash !== parsed.data.expectedEvidenceHash
      || provider.evidence.recoveryStatus !== parsed.data.reason
    ) {
      throw new HistoricalShipStationContentsReviewServiceError(
        "PROVIDER_EVIDENCE_CHANGED",
        "Historical contents review evidence changed after the approved preview",
      );
    }
    return this.repository.upsertReview(Object.freeze({
      candidate,
      reason: input.reason,
      providerRecoveryStatus: provider.evidence.recoveryStatus,
      providerContentsStatus: provider.evidence.status,
      providerObservation: provider.providerObservation,
    }));
  }

  async preview(rawExceptionId: string): Promise<HistoricalShipStationContentsResolutionPreview> {
    return (await this.loadPreview(rawExceptionId)).preview;
  }

  async decide(input: Readonly<{
    readonly exceptionId: string;
    readonly expectedPreviewEvidenceHash: string;
    readonly authenticatedActorUserId: string;
    readonly decision:
      | "wms_confirmed"
      | "provider_confirmed_pending_inventory_correction"
      | "cannot_prove";
    readonly reason: string;
  }>): Promise<PersistedHistoricalShipStationContentsWmsResolution | Readonly<{
    readonly exceptionId: string;
    readonly status: "open" | "acknowledged";
  }>> {
    const parsed = z.object({
      exceptionId: positiveBigintText,
      expectedPreviewEvidenceHash: evidenceHash,
      authenticatedActorUserId: z.string(),
      decision: z.enum([
        "wms_confirmed",
        "provider_confirmed_pending_inventory_correction",
        "cannot_prove",
      ]),
      reason: z.string(),
    }).strict().safeParse(input);
    if (!parsed.success) {
      throw new HistoricalShipStationContentsReviewServiceError(
        "INVALID_COMMAND",
        "Historical contents review decision failed validation",
      );
    }
    const actorUserId = exactActor(parsed.data.authenticatedActorUserId);
    const reason = exactReason(parsed.data.reason);
    if (parsed.data.decision === "wms_confirmed") {
      const replay = await this.repository.loadWmsResolutionReplay({
        exceptionId: parsed.data.exceptionId,
        expectedPreviewHash: parsed.data.expectedPreviewEvidenceHash,
        actorUserId,
        reason,
      });
      if (replay !== null) return replay;
    }
    const loaded = await this.loadPreview(parsed.data.exceptionId);
    if (loaded.preview.previewEvidenceHash !== parsed.data.expectedPreviewEvidenceHash) {
      throw new HistoricalShipStationContentsReviewServiceError(
        "PROVIDER_EVIDENCE_CHANGED",
        "Historical contents evidence changed after preview; review the current evidence",
      );
    }

    if (parsed.data.decision !== "wms_confirmed") {
      return this.repository.recordDecision({
        exceptionId: parsed.data.exceptionId,
        expectedPreviewHash: loaded.preview.previewEvidenceHash,
        actorUserId,
        decision: parsed.data.decision,
        reason,
      });
    }

    if (loaded.snapshot.candidate.expectedContents.kind !== "available") {
      throw new HistoricalShipStationContentsReviewServiceError(
        "WMS_CONTENTS_UNAVAILABLE",
        "This review has no single linked WMS package to confirm",
      );
    }
    const recoveryEvidence = buildHistoricalShipStationWmsConfirmationEvidence({
      providerObservationHash: loaded.providerObservation.evidenceHash,
      expectedContents: loaded.snapshot.candidate.expectedContents,
    });
    return this.repository.confirmWmsContents({
      snapshot: loaded.snapshot,
      recoveryEvidence,
      expectedPreviewHash: loaded.preview.previewEvidenceHash,
      actorUserId,
      reason,
    });
  }

  private async loadPreview(rawExceptionId: string): Promise<LoadedPreview> {
    const parsedExceptionId = positiveBigintText.safeParse(rawExceptionId);
    if (!parsedExceptionId.success) {
      throw new HistoricalShipStationContentsReviewServiceError(
        "INVALID_COMMAND",
        "Historical contents review exception identifier failed validation",
      );
    }
    const snapshot = await this.repository.loadOpenReview(parsedExceptionId.data);
    if (snapshot === null) {
      throw new HistoricalShipStationContentsReviewServiceError(
        "REVIEW_NOT_FOUND",
        "Historical contents review is no longer open",
      );
    }
    const currentCandidate = await this.repository.loadCandidate(
      snapshot.candidate.shippingProviderLabelId,
    );
    if (currentCandidate === null || !sameCandidate(snapshot.candidate, currentCandidate)) {
      throw new HistoricalShipStationContentsReviewServiceError(
        "CANDIDATE_CHANGED",
        "Historical contents candidate changed and requires a new intake",
      );
    }
    const provider = await this.providerClient.loadShipmentContents(
      currentCandidate.providerShipmentId,
      currentCandidate.expectedContents,
    );
    if (provider.kind === "not_found") {
      throw new HistoricalShipStationContentsReviewServiceError(
        "PROVIDER_SHIPMENT_NOT_FOUND",
        "Historical contents review provider shipment was not found",
      );
    }
    if (
      provider.providerObservation.evidenceHash !== snapshot.providerObservationHash
      || provider.evidence.recoveryStatus !== snapshot.providerRecoveryStatus
    ) {
      throw new HistoricalShipStationContentsReviewServiceError(
        "PROVIDER_EVIDENCE_CHANGED",
        "Historical contents evidence changed and requires a new intake",
      );
    }
    const names = new Map(currentCandidate.linePresentations.map(
      (line) => [line.wmsShipmentItemId, line.itemName] as const,
    ));
    const wmsContents = currentCandidate.expectedContents.kind === "available"
      ? Object.freeze(currentCandidate.expectedContents.lines.map((line) => Object.freeze({
          ...line,
          itemName: names.get(line.wmsShipmentItemId) ?? null,
        })))
      : null;
    const previewEvidenceHash = sha256(Object.freeze({
      contract: "historical_shipstation_contents_resolution_preview_v1",
      exceptionId: parsedExceptionId.data,
      reason: snapshot.reason,
      providerRecoveryStatus: provider.evidence.recoveryStatus,
      providerObservation: provider.providerObservation,
      candidate: currentCandidate,
    }));
    const preview = Object.freeze({
      exceptionId: parsedExceptionId.data,
      shippingProviderLabelId: currentCandidate.shippingProviderLabelId,
      previewEvidenceHash,
      orderNumber: currentCandidate.wmsOrders.length === 1
        ? currentCandidate.wmsOrders[0].orderNumber
        : null,
      trackingNumber: currentCandidate.trackingNumber,
      providerRecoveryStatus: provider.evidence.recoveryStatus,
      recordedDecision: snapshot.recordedDecision ?? null,
      providerContents: provider.providerObservation.lines,
      wmsContents,
      allowedDecisions: currentCandidate.expectedContents.kind === "available"
        ? Object.freeze([
            "wms_confirmed",
            "provider_confirmed_pending_inventory_correction",
            "cannot_prove",
          ] as const)
        : Object.freeze([
            "provider_confirmed_pending_inventory_correction",
            "cannot_prove",
          ] as const),
    });
    return Object.freeze({
      snapshot,
      preview,
      providerObservation: provider.providerObservation,
    });
  }
}
