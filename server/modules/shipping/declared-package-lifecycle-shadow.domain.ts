import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import {
  normalizeTrackingNumber,
  SHIPSTATION_LABEL_OBSERVATION_SOURCE,
} from "./carrier-tracking.domain";
import {
  projectDeclaredPackageLifecycle,
  type DeclaredPackageBusinessStatus,
  type DeclaredPackageCarrierStatus,
  type DeclaredPackageContentsEvidenceStatus,
  type DeclaredPackageContentsStatus,
  type DeclaredPackageCorrectionStatus,
  type DeclaredPackageDisposition,
  type DeclaredPackageLabelStatus,
  type DeclaredPackageLifecycleEvent,
  type DeclaredPackageLifecycleInput,
  type DeclaredPackageLifecycleProjection,
  type DeclaredPackageReconciliationStatus,
  type DeclaredPackageReviewReason,
} from "./declared-package-lifecycle.domain";

const MAX_PERSISTED_EVENTS_PER_PACKAGE = 5_000;
const MAX_DECLARED_CONTENT_LINES = 500;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

const positiveSafeIntegerSchema = z.number()
  .refine(Number.isSafeInteger, "must be a safe integer")
  .refine((value) => value > 0, "must be positive");
const nonNegativeSafeIntegerSchema = z.number()
  .refine(Number.isSafeInteger, "must be a safe integer")
  .refine((value) => value >= 0, "must be non-negative");
const persistedTimestampSchema = z.union([z.date(), z.string()]);
const nullablePersistedTimestampSchema = persistedTimestampSchema.nullable();
const boundedIdentifierSchema = (maximum: number) => z.string().trim().min(1).max(maximum);
const boundedProviderDateSchema = z.string().min(1).max(80).nullable().optional();

const persistedLabelEventRowSchema = z.object({
  id: positiveSafeIntegerSchema,
  shippingProviderLabelId: positiveSafeIntegerSchema,
  eventHash: z.string().regex(/^[0-9a-f]{64}$/),
  eventType: boundedIdentifierSchema(40),
  labelStatus: boundedIdentifierSchema(30),
  trackingNumber: boundedIdentifierSchema(200),
  providerOccurredAt: nullablePersistedTimestampSchema,
  sanitizedPayload: z.unknown(),
  receivedAt: persistedTimestampSchema,
}).strict();

const persistedConfirmedCarrierEvidenceRowSchema = z.object({
  id: positiveSafeIntegerSchema,
  shippingProviderLabelId: positiveSafeIntegerSchema,
  dispatchEvidence: boundedIdentifierSchema(30),
  currentMatchStatus: boundedIdentifierSchema(30),
  eventOccurredAt: nullablePersistedTimestampSchema,
  receivedAt: persistedTimestampSchema,
}).strict();

const persistedPackageEvidenceSchema = z.object({
  shippingProviderLabelId: positiveSafeIntegerSchema,
  provider: boundedIdentifierSchema(40),
  providerPhysicalShipmentId: boundedIdentifierSchema(200),
  currentTrackingNumber: boundedIdentifierSchema(200),
  currentLabelStatus: z.enum(["active", "voided", "superseded", "unknown"]),
  firstObservedAt: persistedTimestampSchema,
  lastObservedAt: persistedTimestampSchema,
  labelDirection: boundedIdentifierSchema(20),
  labelEvents: z.array(persistedLabelEventRowSchema).max(MAX_PERSISTED_EVENTS_PER_PACKAGE),
  confirmedCarrierEvents: z.array(persistedConfirmedCarrierEvidenceRowSchema)
    .max(MAX_PERSISTED_EVENTS_PER_PACKAGE),
}).strict();

const persistedDeclaredLineSchema = z.object({
  lineItemKey: z.string().min(1).max(200),
  quantity: z.number()
    .refine(Number.isSafeInteger, "quantity must be a safe integer")
    .refine(
      (quantity) => quantity > 0 && quantity <= POSTGRES_INTEGER_MAX,
      "quantity must fit a positive PostgreSQL integer",
    ),
}).strict();

const persistedContentsEvidenceSchema = z.object({
  evidenceSchemaVersion: z.literal(1),
  status: z.enum([
    "authoritative",
    "omitted",
    "empty",
    "unrecognized",
    "malformed",
    "mixed",
  ]),
  providerItemCount: nonNegativeSafeIntegerSchema,
  recognizedProviderItemCount: nonNegativeSafeIntegerSchema,
  canonicalLineCount: nonNegativeSafeIntegerSchema,
  malformedItemCount: nonNegativeSafeIntegerSchema,
  unrecognizedItemCount: nonNegativeSafeIntegerSchema,
  duplicateLineItemCount: nonNegativeSafeIntegerSchema,
  rejectedItemCount: nonNegativeSafeIntegerSchema,
  reviewRequired: z.boolean(),
  lines: z.array(persistedDeclaredLineSchema).max(MAX_DECLARED_CONTENT_LINES),
}).strict();

const persistedV2LabelPayloadSchema = z.object({
  payloadSchemaVersion: z.literal(2),
  providerLabelId: boundedIdentifierSchema(200),
  trackingNumber: boundedIdentifierSchema(200),
  observationSource: z.literal(SHIPSTATION_LABEL_OBSERVATION_SOURCE),
  sourceObservationHash: z.string().regex(/^[0-9a-f]{64}$/),
  createDate: boundedProviderDateSchema,
  shipDate: boundedProviderDateSchema,
  voidDate: boundedProviderDateSchema,
  isReturnLabel: z.boolean().optional(),
  declaredContentsEvidence: persistedContentsEvidenceSchema,
}).passthrough();

const persistedV1LabelPayloadSchema = z.object({
  payloadSchemaVersion: z.literal(1).optional(),
  providerLabelId: boundedIdentifierSchema(200).optional(),
  trackingNumber: boundedIdentifierSchema(200).optional(),
  isReturnLabel: z.boolean().optional(),
}).passthrough();


export type PersistedShippingProviderLabelEventRow = Readonly<
  z.infer<typeof persistedLabelEventRowSchema>
>;
export type PersistedConfirmedCarrierEvidenceRow = Readonly<
  z.infer<typeof persistedConfirmedCarrierEvidenceRowSchema>
>;
type ParsedPersistedDeclaredPackageEvidence = z.infer<
  typeof persistedPackageEvidenceSchema
>;
export type PersistedDeclaredPackageEvidence = Readonly<
  Omit<ParsedPersistedDeclaredPackageEvidence, "labelEvents" | "confirmedCarrierEvents"> & {
    labelEvents: readonly PersistedShippingProviderLabelEventRow[];
    confirmedCarrierEvents: readonly PersistedConfirmedCarrierEvidenceRow[];
  }
>;

export type DeclaredPackageLifecycleShadowEvidenceCoverage =
  | "current_flow"
  | "historical_v1_incomplete";

export type DeclaredPackageLifecycleShadowRejectionReason =
  | "invalid_persisted_package"
  | "non_outbound_label"
  | "no_label_events"
  | "invalid_label_linkage"
  | "unsupported_provider"
  | "unsupported_label_payload_schema"
  | "invalid_label_event_hash"
  | "invalid_v1_label_evidence"
  | "invalid_v2_label_evidence"
  | "invalid_persisted_timestamp"
  | "invalid_carrier_evidence"
  | "current_label_projection_mismatch"
  | "projector_rejected";

export interface AdaptedDeclaredPackageLifecycleEvidence {
  outcome: "adapted";
  input: DeclaredPackageLifecycleInput;
  evidenceCoverage: DeclaredPackageLifecycleShadowEvidenceCoverage;
}

export interface RejectedDeclaredPackageLifecycleEvidence {
  outcome: "rejected";
  reason: DeclaredPackageLifecycleShadowRejectionReason;
}

export type DeclaredPackageLifecycleEvidenceAdapterResult =
  | AdaptedDeclaredPackageLifecycleEvidence
  | RejectedDeclaredPackageLifecycleEvidence;

export interface ProjectedDeclaredPackageLifecycleShadowResult {
  outcome: "projected";
  projection: DeclaredPackageLifecycleProjection;
  evidenceCoverage: DeclaredPackageLifecycleShadowEvidenceCoverage;
}

export type DeclaredPackageLifecycleShadowPackageResult =
  | ProjectedDeclaredPackageLifecycleShadowResult
  | RejectedDeclaredPackageLifecycleEvidence;

class ShadowEvidenceError extends Error {
  constructor(readonly reason: DeclaredPackageLifecycleShadowRejectionReason) {
    super(reason);
    this.name = "ShadowEvidenceError";
  }
}

function rejected(
  reason: DeclaredPackageLifecycleShadowRejectionReason,
): RejectedDeclaredPackageLifecycleEvidence {
  return Object.freeze({ outcome: "rejected", reason });
}

function timestamp(value: Date | string): string {
  let parsed: Date;
  if (value instanceof Date) {
    parsed = value;
  } else {
    const timestampValidation = z.string().datetime({ offset: true }).safeParse(value);
    const fractionalSeconds = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
    if (
      !timestampValidation.success
      || (fractionalSeconds !== undefined && fractionalSeconds.length > 3)
    ) {
      throw new ShadowEvidenceError("invalid_persisted_timestamp");
    }
    parsed = new Date(value);
  }
  if (Number.isNaN(parsed.getTime())) {
    throw new ShadowEvidenceError("invalid_persisted_timestamp");
  }
  return parsed.toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertStoredLabelEventHash(
  row: PersistedShippingProviderLabelEventRow,
  payload: Record<string, unknown>,
): void {
  const expectedHash = sha256(canonicalJson({
    provider: "shipstation",
    ...payload,
    labelStatus: row.labelStatus,
  }));
  if (row.eventHash !== expectedHash) {
    throw new ShadowEvidenceError("invalid_label_event_hash");
  }
}

function lineFromPersistedEvidence(line: z.infer<typeof persistedDeclaredLineSchema>) {
  const match = /^wms-item-([1-9][0-9]*)$/.exec(line.lineItemKey);
  const wmsShipmentItemId = match ? Number(match[1]) : Number.NaN;
  if (
    !Number.isSafeInteger(wmsShipmentItemId)
    || wmsShipmentItemId <= 0
    || wmsShipmentItemId > POSTGRES_INTEGER_MAX
  ) {
    throw new ShadowEvidenceError("invalid_v2_label_evidence");
  }
  return Object.freeze({ wmsShipmentItemId, quantity: line.quantity });
}

function assertPersistedContentsEvidenceConsistent(
  evidence: z.infer<typeof persistedContentsEvidenceSchema>,
): void {
  const malformedContainerEvidence = evidence.status === "malformed"
    && evidence.providerItemCount === 0
    && evidence.recognizedProviderItemCount === 0
    && evidence.canonicalLineCount === 0
    && evidence.malformedItemCount === 1
    && evidence.unrecognizedItemCount === 0
    && evidence.duplicateLineItemCount === 0
    && evidence.rejectedItemCount === 1
    && evidence.lines.length === 0;
  const providerCountsMatch = evidence.providerItemCount
    === evidence.recognizedProviderItemCount
      + evidence.malformedItemCount
      + evidence.unrecognizedItemCount;
  const retainedDuplicateCount =
    evidence.recognizedProviderItemCount - evidence.canonicalLineCount;
  const maximumDuplicateCount = retainedDuplicateCount
    + Math.max(0, evidence.malformedItemCount - 1);

  if (
    (!providerCountsMatch && !malformedContainerEvidence)
    || evidence.canonicalLineCount !== evidence.lines.length
    || evidence.rejectedItemCount
      !== evidence.malformedItemCount + evidence.unrecognizedItemCount
    || retainedDuplicateCount < 0
    || evidence.duplicateLineItemCount < retainedDuplicateCount
    || evidence.duplicateLineItemCount > maximumDuplicateCount
    || evidence.reviewRequired !== (evidence.status !== "authoritative")
  ) {
    throw new ShadowEvidenceError("invalid_v2_label_evidence");
  }

  const uniqueKeys = new Set(evidence.lines.map((line) => line.lineItemKey));
  if (uniqueKeys.size !== evidence.lines.length) {
    throw new ShadowEvidenceError("invalid_v2_label_evidence");
  }

  const hasRejectedRows = evidence.malformedItemCount > 0
    || evidence.unrecognizedItemCount > 0;
  switch (evidence.status) {
    case "authoritative":
      if (
        evidence.lines.length === 0
        || hasRejectedRows
        || evidence.duplicateLineItemCount !== 0
      ) {
        throw new ShadowEvidenceError("invalid_v2_label_evidence");
      }
      break;
    case "mixed":
      if (
        evidence.lines.length === 0
        || (!hasRejectedRows && evidence.duplicateLineItemCount === 0)
      ) {
        throw new ShadowEvidenceError("invalid_v2_label_evidence");
      }
      break;
    case "omitted":
    case "empty":
      if (evidence.providerItemCount !== 0 || evidence.lines.length !== 0) {
        throw new ShadowEvidenceError("invalid_v2_label_evidence");
      }
      break;
    case "unrecognized":
      if (
        evidence.lines.length !== 0
        || evidence.recognizedProviderItemCount !== 0
        || evidence.malformedItemCount !== 0
        || evidence.unrecognizedItemCount === 0
      ) {
        throw new ShadowEvidenceError("invalid_v2_label_evidence");
      }
      break;
    case "malformed":
      if (
        evidence.lines.length !== 0
        || evidence.recognizedProviderItemCount !== 0
        || evidence.malformedItemCount === 0
      ) {
        throw new ShadowEvidenceError("invalid_v2_label_evidence");
      }
      break;
  }
}

interface ParsedLabelPayloadEvidence {
  readonly contentsEvidence: Extract<
    DeclaredPackageLifecycleEvent,
    { kind: "outbound_label_observed" }
  >["contentsEvidence"];
  readonly payload: z.infer<typeof persistedV2LabelPayloadSchema> | null;
  readonly evidenceCoverage: DeclaredPackageLifecycleShadowEvidenceCoverage;
}

function contentsEvidenceFromPayload(
  row: PersistedShippingProviderLabelEventRow,
  expectedProviderPhysicalShipmentId: string,
): ParsedLabelPayloadEvidence {
  const payloadRecord = plainRecord(row.sanitizedPayload);
  if (!payloadRecord) {
    throw new ShadowEvidenceError("invalid_persisted_package");
  }
  assertStoredLabelEventHash(row, payloadRecord);

  const rawVersion = payloadRecord.payloadSchemaVersion;
  if (rawVersion === undefined || rawVersion === 1) {
    const parsed = persistedV1LabelPayloadSchema.safeParse(payloadRecord);
    if (
      !parsed.success
      || (
        parsed.data.providerLabelId !== undefined
        && parsed.data.providerLabelId !== expectedProviderPhysicalShipmentId
      )
      || (
        parsed.data.trackingNumber !== undefined
        && parsed.data.trackingNumber !== row.trackingNumber
      )
      || parsed.data.isReturnLabel === true
    ) {
      throw new ShadowEvidenceError("invalid_v1_label_evidence");
    }

    // Historical v1 retained optional package identities but discarded exact
    // quantities. It can prove the label fact only, never item-level authority.
    const contentsEvidence = { status: "omitted" } as const;
    Object.freeze(contentsEvidence);
    return {
      contentsEvidence,
      payload: null,
      evidenceCoverage: "historical_v1_incomplete",
    };
  }
  if (rawVersion !== 2) {
    throw new ShadowEvidenceError("unsupported_label_payload_schema");
  }

  const parsed = persistedV2LabelPayloadSchema.safeParse(payloadRecord);
  if (!parsed.success) {
    throw new ShadowEvidenceError("invalid_v2_label_evidence");
  }
  if (
    parsed.data.providerLabelId !== expectedProviderPhysicalShipmentId
    || parsed.data.trackingNumber !== row.trackingNumber
    || parsed.data.isReturnLabel === true
  ) {
    throw new ShadowEvidenceError("invalid_v2_label_evidence");
  }

  const evidence = parsed.data.declaredContentsEvidence;
  assertPersistedContentsEvidenceConsistent(evidence);
  const lines = evidence.lines
    .map(lineFromPersistedEvidence)
    .sort((left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId);
  Object.freeze(lines);

  let contentsEvidence: ParsedLabelPayloadEvidence["contentsEvidence"];
  switch (evidence.status) {
    case "authoritative":
      contentsEvidence = { status: "authoritative", lines };
      break;
    case "mixed":
      contentsEvidence = { status: "mixed", recognizedLines: lines };
      break;
    default:
      contentsEvidence = { status: evidence.status };
      break;
  }
  Object.freeze(contentsEvidence);
  return {
    contentsEvidence,
    payload: parsed.data,
    evidenceCoverage: "current_flow",
  };
}

interface AdaptedLabelEventResult {
  readonly events: readonly DeclaredPackageLifecycleEvent[];
  readonly evidenceCoverage: DeclaredPackageLifecycleShadowEvidenceCoverage;
}

function adaptLabelEvent(
  row: PersistedShippingProviderLabelEventRow,
  providerPhysicalShipmentId: string,
): AdaptedLabelEventResult {
  const evidence = contentsEvidenceFromPayload(row, providerPhysicalShipmentId);
  const eventKey = `shipping-provider-label-event:${row.id}`;
  const observedAt = timestamp(row.receivedAt);
  const observedEvent: DeclaredPackageLifecycleEvent = {
    kind: "outbound_label_observed",
    eventKey: `${eventKey}:observed`,
    observedAt,
    // Active label rows currently store shipDate in providerOccurredAt.
    // Its issuance semantics are unproven, so it is deliberately ignored.
    providerOccurredAt: null,
    trackingNumber: row.trackingNumber,
    contentsEvidence: evidence.contentsEvidence,
  };
  Object.freeze(observedEvent);

  if (row.eventType === "label_observed") {
    if (row.labelStatus !== "active" || evidence.payload?.voidDate != null) {
      throw new ShadowEvidenceError("invalid_v2_label_evidence");
    }
    const events = [observedEvent];
    Object.freeze(events);
    return { events, evidenceCoverage: evidence.evidenceCoverage };
  }

  if (row.eventType === "label_voided") {
    if (row.labelStatus !== "voided") {
      throw new ShadowEvidenceError("invalid_v2_label_evidence");
    }
    const providerOccurredAt = nullableTimestamp(row.providerOccurredAt);
    if (evidence.payload?.voidDate != null) {
      const payloadVoidAt = timestamp(evidence.payload.voidDate);
      if (providerOccurredAt === null || payloadVoidAt !== providerOccurredAt) {
        throw new ShadowEvidenceError("invalid_v2_label_evidence");
      }
    }
    const voidEvent: DeclaredPackageLifecycleEvent = {
      kind: "outbound_label_voided",
      eventKey: `${eventKey}:voided`,
      observedAt,
      providerOccurredAt,
    };
    Object.freeze(voidEvent);
    const events = [observedEvent, voidEvent];
    Object.freeze(events);
    return { events, evidenceCoverage: evidence.evidenceCoverage };
  }

  // No persisted event currently proves the provider performed a reprint.
  throw new ShadowEvidenceError("invalid_persisted_package");
}

function adaptCarrierEvent(
  row: PersistedConfirmedCarrierEvidenceRow,
): DeclaredPackageLifecycleEvent {
  if (
    row.dispatchEvidence !== "confirmed"
    || !["matched", "voided_label"].includes(row.currentMatchStatus)
  ) {
    throw new ShadowEvidenceError("invalid_carrier_evidence");
  }
  const event: DeclaredPackageLifecycleEvent = {
    kind: "carrier_possession_confirmed",
    eventKey: `carrier-tracking-event:${row.id}`,
    observedAt: timestamp(row.receivedAt),
    providerOccurredAt: nullableTimestamp(row.eventOccurredAt),
    carrierTrackingEventId: row.id,
  };
  Object.freeze(event);
  return event;
}

function compareEvents(left: DeclaredPackageLifecycleEvent, right: DeclaredPackageLifecycleEvent): number {
  return left.observedAt.localeCompare(right.observedAt)
    || left.eventKey.localeCompare(right.eventKey);
}

/**
 * Adapts immutable database evidence into the pure lifecycle contract. It does
 * not read a clock, call a provider, or expose any effect executor.
 */
export function adaptPersistedDeclaredPackageLifecycleEvidence(
  rawInput: PersistedDeclaredPackageEvidence,
): DeclaredPackageLifecycleEvidenceAdapterResult {
  const parsed = persistedPackageEvidenceSchema.safeParse(rawInput);
  if (!parsed.success) return rejected("invalid_persisted_package");
  const input = parsed.data;
  if (input.provider !== "shipstation") return rejected("unsupported_provider");
  if (input.labelDirection !== "outbound") return rejected("non_outbound_label");
  if (input.labelEvents.length === 0) return rejected("no_label_events");
  if (
    [...input.labelEvents, ...input.confirmedCarrierEvents].some(
      (event) => event.shippingProviderLabelId !== input.shippingProviderLabelId,
    )
  ) {
    return rejected("invalid_label_linkage");
  }

  try {
    const adaptedLabelEvents = input.labelEvents
      .slice()
      .sort((left, right) => left.id - right.id)
      .map((event) => adaptLabelEvent(event, input.providerPhysicalShipmentId));
    const evidenceCoverage = adaptedLabelEvents.some(
      (event) => event.evidenceCoverage === "historical_v1_incomplete",
    )
      ? "historical_v1_incomplete"
      : "current_flow";
    const events: DeclaredPackageLifecycleEvent[] = [
      ...adaptedLabelEvents.flatMap((event) => event.events),
      ...input.confirmedCarrierEvents
        .slice()
        .sort((left, right) => left.id - right.id)
        .map(adaptCarrierEvent),
    ].sort(compareEvents);
    Object.freeze(events);
    return Object.freeze({
      outcome: "adapted",
      evidenceCoverage,
      input: Object.freeze({
        provider: input.provider,
        providerPhysicalShipmentId: input.providerPhysicalShipmentId,
        events,
      }),
    });
  } catch (error) {
    return rejected(
      error instanceof ShadowEvidenceError ? error.reason : "invalid_persisted_package",
    );
  }
}

function currentLabelProjectionMatches(
  input: ParsedPersistedDeclaredPackageEvidence,
  projection: DeclaredPackageLifecycleProjection,
): boolean {
  if (
    input.currentLabelStatus !== projection.labelStatus
    || projection.trackingNumber === null
  ) {
    return false;
  }

  let currentTrackingNumber: string;
  let projectedTrackingNumber: string;
  try {
    currentTrackingNumber = normalizeTrackingNumber(input.currentTrackingNumber);
    projectedTrackingNumber = normalizeTrackingNumber(projection.trackingNumber);
  } catch {
    return false;
  }
  if (currentTrackingNumber !== projectedTrackingNumber) return false;

  const currentFirstObservedAt = timestamp(input.firstObservedAt);
  const currentLastObservedAt = timestamp(input.lastObservedAt);
  const latestRetainedLabelEventAt = input.labelEvents
    .map((event) => timestamp(event.receivedAt))
    .sort()
    .at(-1);
  return projection.labelFirstObservedAt === currentFirstObservedAt
    && latestRetainedLabelEventAt !== undefined
    // Carrier evidence is intentionally excluded: this column records provider
    // label observations, not later carrier-tracking observations.
    && currentLastObservedAt >= latestRetainedLabelEventAt;
}

/** Projects one package without throwing raw persisted values to the caller. */
export function projectPersistedDeclaredPackageLifecycleShadow(
  rawInput: PersistedDeclaredPackageEvidence,
): DeclaredPackageLifecycleShadowPackageResult {
  const adapted = adaptPersistedDeclaredPackageLifecycleEvidence(rawInput);
  if (adapted.outcome === "rejected") return adapted;
  try {
    const persisted = persistedPackageEvidenceSchema.parse(rawInput);
    const projection = projectDeclaredPackageLifecycle(adapted.input);
    if (!currentLabelProjectionMatches(persisted, projection)) {
      return rejected("current_label_projection_mismatch");
    }
    return Object.freeze({
      outcome: "projected",
      projection,
      evidenceCoverage: adapted.evidenceCoverage,
    });
  } catch (error) {
    return rejected(
      error instanceof ShadowEvidenceError ? error.reason : "projector_rejected",
    );
  }
}

const LABEL_STATUSES: readonly DeclaredPackageLabelStatus[] = ["unknown", "active", "voided"];
const CONTENTS_STATUSES: readonly DeclaredPackageContentsStatus[] = [
  "unknown",
  "authoritative",
  "conflicting",
];
const BUSINESS_STATUSES: readonly DeclaredPackageBusinessStatus[] = ["not_shipped", "shipped"];
const RECONCILIATION_STATUSES: readonly DeclaredPackageReconciliationStatus[] = ["clear", "review"];
const CORRECTION_STATUSES: readonly DeclaredPackageCorrectionStatus[] = [
  "unavailable",
  "open",
  "awaiting_relabel",
  "carrier_locked",
  "review",
];
const CARRIER_STATUSES: readonly DeclaredPackageCarrierStatus[] = [
  "not_confirmed",
  "possession_confirmed",
];
const DISPOSITIONS: readonly DeclaredPackageDisposition[] = [
  "not_dispatched",
  "outbound",
  "return_to_sender_expected",
  "review",
];
const EVIDENCE_STATUSES: readonly DeclaredPackageContentsEvidenceStatus[] = [
  "authoritative",
  "omitted",
  "empty",
  "unrecognized",
  "malformed",
  "mixed",
];
const EVIDENCE_COVERAGES: readonly DeclaredPackageLifecycleShadowEvidenceCoverage[] = [
  "current_flow",
  "historical_v1_incomplete",
];
const REVIEW_REASONS: readonly DeclaredPackageReviewReason[] = [
  "carrier_possession_without_authoritative_contents",
  "carrier_possession_without_label_observation",
  "conflicting_package_contents",
  "package_contents_empty",
  "package_contents_malformed",
  "package_contents_mixed",
  "package_contents_not_observed",
  "package_contents_omitted",
  "package_contents_unrecognized",
  "provider_void_precedes_provider_label_issuance",
  "reprint_without_label_observation",
  "simultaneous_void_and_carrier_possession",
  "void_after_carrier_possession",
  "void_carrier_order_unproven",
  "void_without_label_observation",
];
const REJECTION_REASONS: readonly DeclaredPackageLifecycleShadowRejectionReason[] = [
  "invalid_persisted_package",
  "non_outbound_label",
  "no_label_events",
  "invalid_label_linkage",
  "unsupported_provider",
  "unsupported_label_payload_schema",
  "invalid_label_event_hash",
  "invalid_v1_label_evidence",
  "invalid_v2_label_evidence",
  "invalid_persisted_timestamp",
  "invalid_carrier_evidence",
  "current_label_projection_mismatch",
  "projector_rejected",
];

function zeroCounts<TKey extends string>(keys: readonly TKey[]): Record<TKey, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<TKey, number>;
}

export interface DeclaredPackageLifecycleShadowSummary {
  readonly contractVersion: 1;
  readonly packageCount: number;
  readonly projectedCount: number;
  readonly rejectedCount: number;
  readonly rejectionReasonCounts: Readonly<Record<DeclaredPackageLifecycleShadowRejectionReason, number>>;
  readonly evidenceCoverageCounts: Readonly<
    Record<DeclaredPackageLifecycleShadowEvidenceCoverage, number>
  >;
  readonly labelStatusCounts: Readonly<Record<DeclaredPackageLabelStatus, number>>;
  readonly contentsStatusCounts: Readonly<Record<DeclaredPackageContentsStatus, number>>;
  readonly businessStatusCounts: Readonly<Record<DeclaredPackageBusinessStatus, number>>;
  readonly reconciliationStatusCounts: Readonly<Record<DeclaredPackageReconciliationStatus, number>>;
  readonly correctionStatusCounts: Readonly<Record<DeclaredPackageCorrectionStatus, number>>;
  readonly carrierStatusCounts: Readonly<Record<DeclaredPackageCarrierStatus, number>>;
  readonly dispositionCounts: Readonly<Record<DeclaredPackageDisposition, number>>;
  readonly observedEvidenceStatusCounts: Readonly<Record<DeclaredPackageContentsEvidenceStatus, number>>;
  readonly reviewReasonCounts: Readonly<Record<DeclaredPackageReviewReason, number>>;
}

/**
 * Aggregate-only shadow service. Per-package identities, tracking, contents,
 * hashes, and every effect-eligibility boolean are deliberately discarded.
 */
export function summarizePersistedDeclaredPackageLifecycleShadow(
  inputs: readonly PersistedDeclaredPackageEvidence[],
): DeclaredPackageLifecycleShadowSummary {
  const rejectionReasonCounts = zeroCounts(REJECTION_REASONS);
  const evidenceCoverageCounts = zeroCounts(EVIDENCE_COVERAGES);
  const labelStatusCounts = zeroCounts(LABEL_STATUSES);
  const contentsStatusCounts = zeroCounts(CONTENTS_STATUSES);
  const businessStatusCounts = zeroCounts(BUSINESS_STATUSES);
  const reconciliationStatusCounts = zeroCounts(RECONCILIATION_STATUSES);
  const correctionStatusCounts = zeroCounts(CORRECTION_STATUSES);
  const carrierStatusCounts = zeroCounts(CARRIER_STATUSES);
  const dispositionCounts = zeroCounts(DISPOSITIONS);
  const observedEvidenceStatusCounts = zeroCounts(EVIDENCE_STATUSES);
  const reviewReasonCounts = zeroCounts(REVIEW_REASONS);
  let projectedCount = 0;
  let rejectedCount = 0;

  for (const input of inputs) {
    const result = projectPersistedDeclaredPackageLifecycleShadow(input);
    if (result.outcome === "rejected") {
      rejectedCount += 1;
      rejectionReasonCounts[result.reason] += 1;
      continue;
    }

    projectedCount += 1;
    evidenceCoverageCounts[result.evidenceCoverage] += 1;
    const projection = result.projection;
    labelStatusCounts[projection.labelStatus] += 1;
    contentsStatusCounts[projection.contentsStatus] += 1;
    businessStatusCounts[projection.businessStatus] += 1;
    reconciliationStatusCounts[projection.reconciliationStatus] += 1;
    correctionStatusCounts[projection.correctionStatus] += 1;
    carrierStatusCounts[projection.carrierStatus] += 1;
    dispositionCounts[projection.disposition] += 1;
    for (const status of projection.observedContentsEvidenceStatuses) {
      observedEvidenceStatusCounts[status] += 1;
    }
    for (const reason of projection.reviewReasons) {
      reviewReasonCounts[reason] += 1;
    }
  }

  return Object.freeze({
    contractVersion: 1,
    packageCount: inputs.length,
    projectedCount,
    rejectedCount,
    rejectionReasonCounts: Object.freeze(rejectionReasonCounts),
    evidenceCoverageCounts: Object.freeze(evidenceCoverageCounts),
    labelStatusCounts: Object.freeze(labelStatusCounts),
    contentsStatusCounts: Object.freeze(contentsStatusCounts),
    businessStatusCounts: Object.freeze(businessStatusCounts),
    reconciliationStatusCounts: Object.freeze(reconciliationStatusCounts),
    correctionStatusCounts: Object.freeze(correctionStatusCounts),
    carrierStatusCounts: Object.freeze(carrierStatusCounts),
    dispositionCounts: Object.freeze(dispositionCounts),
    observedEvidenceStatusCounts: Object.freeze(observedEvidenceStatusCounts),
    reviewReasonCounts: Object.freeze(reviewReasonCounts),
  });
}
