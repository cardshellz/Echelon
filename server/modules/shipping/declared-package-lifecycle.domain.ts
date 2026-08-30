import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

const boundedIdentifier = (field: string, maxLength: number) => z.string({
  required_error: `${field} is required`,
})
  .trim()
  .min(1, `${field} must not be blank`)
  .max(maxLength, `${field} exceeds ${maxLength} characters`);

const timestampSchema = z.string()
  .datetime({ offset: true })
  .refine((value) => {
    const fractionalSeconds = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
    return fractionalSeconds === undefined || fractionalSeconds.length <= 3;
  }, "timestamp precision must not exceed milliseconds")
  .transform((value) => new Date(value).toISOString());

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positivePostgresIntegerSchema = z.number()
  .int()
  .positive()
  .max(POSTGRES_INTEGER_MAX);
const positiveSafeIntegerSchema = z.number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "must be a positive safe integer");

export const declaredPackageLineSchema = z.object({
  wmsShipmentItemId: positivePostgresIntegerSchema,
  quantity: positivePostgresIntegerSchema,
}).strict();

export const declaredPackageContentsEvidenceSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("authoritative"),
    lines: z.array(declaredPackageLineSchema).min(1).max(500),
  }).strict(),
  z.object({ status: z.literal("omitted") }).strict(),
  z.object({ status: z.literal("empty") }).strict(),
  z.object({ status: z.literal("unrecognized") }).strict(),
  z.object({ status: z.literal("malformed") }).strict(),
  z.object({
    status: z.literal("mixed"),
    recognizedLines: z.array(declaredPackageLineSchema).min(1).max(500),
  }).strict(),
]);

const lifecycleEventBaseSchema = z.object({
  eventKey: boundedIdentifier("eventKey", 240),
  observedAt: timestampSchema,
}).strict();

const providerEvidenceEventBaseSchema = lifecycleEventBaseSchema.extend({
  providerOccurredAt: timestampSchema.nullable(),
}).strict();

const outboundLabelObservedEventSchema = providerEvidenceEventBaseSchema.extend({
  kind: z.literal("outbound_label_observed"),
  trackingNumber: boundedIdentifier("trackingNumber", 200),
  contentsEvidence: declaredPackageContentsEvidenceSchema,
}).strict();

const outboundLabelReprintedEventSchema = providerEvidenceEventBaseSchema.extend({
  kind: z.literal("outbound_label_reprinted"),
  trackingNumber: boundedIdentifier("trackingNumber", 200),
}).strict();

const outboundLabelVoidedEventSchema = providerEvidenceEventBaseSchema.extend({
  kind: z.literal("outbound_label_voided"),
}).strict();

const packageContentsAttestedEventSchema = lifecycleEventBaseSchema.extend({
  kind: z.literal("package_contents_attested"),
  authorization: z.enum(["lead_approved", "system_recovered"]),
  actor: boundedIdentifier("actor", 200),
  reason: boundedIdentifier("reason", 500),
  resolvesEventKeys: z.array(boundedIdentifier("resolvesEventKey", 240)).min(1).max(500),
  contents: z.array(declaredPackageLineSchema).min(1).max(500),
}).strict();

const carrierPossessionConfirmedEventSchema = providerEvidenceEventBaseSchema.extend({
  kind: z.literal("carrier_possession_confirmed"),
  carrierTrackingEventId: positiveSafeIntegerSchema,
}).strict();

export const declaredPackageLifecycleEventSchema = z.discriminatedUnion("kind", [
  outboundLabelObservedEventSchema,
  outboundLabelReprintedEventSchema,
  outboundLabelVoidedEventSchema,
  packageContentsAttestedEventSchema,
  carrierPossessionConfirmedEventSchema,
]);

export const declaredPackageLifecycleInputSchema = z.object({
  provider: boundedIdentifier("provider", 40).transform((value) => value.toLowerCase()),
  providerPhysicalShipmentId: boundedIdentifier("providerPhysicalShipmentId", 200),
  events: z.array(declaredPackageLifecycleEventSchema).min(1).max(5_000),
}).strict();

export type DeclaredPackageLine = z.infer<typeof declaredPackageLineSchema>;
export type DeclaredPackageLifecycleEvent = z.infer<typeof declaredPackageLifecycleEventSchema>;
type ParsedDeclaredPackageLifecycleInput = z.input<typeof declaredPackageLifecycleInputSchema>;
export type DeclaredPackageLifecycleInput = Readonly<
  Omit<ParsedDeclaredPackageLifecycleInput, "events"> & {
    events: readonly DeclaredPackageLifecycleEvent[];
  }
>;

export type DeclaredPackageLabelStatus = "unknown" | "active" | "voided";
export type DeclaredPackageContentsEvidenceStatus =
  z.infer<typeof declaredPackageContentsEvidenceSchema>["status"];
export type DeclaredPackageContentsStatus = "unknown" | "authoritative" | "conflicting";
export type DeclaredPackageCorrectionStatus =
  | "unavailable"
  | "open"
  | "awaiting_relabel"
  | "carrier_locked"
  | "review";
export type DeclaredPackageCarrierStatus = "not_confirmed" | "possession_confirmed";
export type DeclaredPackageDisposition =
  | "not_dispatched"
  | "outbound"
  | "return_to_sender_expected"
  | "review";
export type DeclaredPackageBusinessStatus = "not_shipped" | "shipped";
export type DeclaredPackageReconciliationStatus = "clear" | "review";

export type DeclaredPackageReviewReason =
  | "carrier_possession_without_authoritative_contents"
  | "carrier_possession_without_label_observation"
  | "conflicting_package_contents"
  | "package_contents_empty"
  | "package_contents_malformed"
  | "package_contents_mixed"
  | "package_contents_not_observed"
  | "package_contents_omitted"
  | "package_contents_unrecognized"
  | "provider_void_precedes_provider_label_issuance"
  | "reprint_without_label_observation"
  | "simultaneous_void_and_carrier_possession"
  | "void_after_carrier_possession"
  | "void_carrier_order_unproven"
  | "void_without_label_observation";

export interface DeclaredPackageLifecycleProjection {
  readonly contractVersion: 1;
  readonly provider: string;
  readonly providerPhysicalShipmentId: string;
  readonly trackingNumber: string | null;
  readonly labelStatus: DeclaredPackageLabelStatus;
  readonly labelProviderOccurredAt: string | null;
  readonly labelFirstObservedAt: string | null;
  readonly labelVoidedProviderOccurredAt: string | null;
  readonly labelVoidFirstObservedAt: string | null;
  readonly contentsStatus: DeclaredPackageContentsStatus;
  readonly observedContentsEvidenceStatuses: readonly DeclaredPackageContentsEvidenceStatus[];
  readonly activeContentsEvidenceStatuses: readonly DeclaredPackageContentsEvidenceStatus[];
  readonly authoritativeContents: readonly DeclaredPackageLine[] | null;
  readonly contentsAuthorityObservedAt: string | null;
  readonly businessStatus: DeclaredPackageBusinessStatus;
  readonly businessShipmentRecognizedAt: string | null;
  readonly businessShipmentProviderOccurredAt: string | null;
  readonly currentAutomationAuthority: boolean;
  readonly reconciliationStatus: DeclaredPackageReconciliationStatus;
  readonly correctionStatus: DeclaredPackageCorrectionStatus;
  readonly carrierStatus: DeclaredPackageCarrierStatus;
  readonly carrierPossessionProviderOccurredAt: string | null;
  readonly carrierPossessionFirstObservedAt: string | null;
  readonly topologyLockedProviderAt: string | null;
  readonly topologyLockRecognizedAt: string | null;
  readonly disposition: DeclaredPackageDisposition;
  readonly commercialFulfillmentPostingEligible: boolean;
  readonly inventoryPostingEligible: boolean;
  readonly activeTrackingProjectionEligible: boolean;
  readonly voidTrackingProjectionRequired: boolean;
  readonly carrierTrackingProjectionRequired: boolean;
  readonly notificationCandidateEligible: boolean;
  readonly notificationProjectionReconciliationRequired: boolean;
  readonly reviewReasons: readonly DeclaredPackageReviewReason[];
  readonly appliedEventCount: number;
  readonly evidenceHash: string;
  readonly stateHash: string;
}

export type DeclaredPackageLifecycleErrorCode =
  | "CONFLICTING_EVENT_REPLAY"
  | "CONFLICTING_PROVIDER_IDENTITY"
  | "DUPLICATE_PACKAGE_LINE"
  | "INVALID_CONTENT_RESOLUTION"
  | "INVALID_PACKAGE_LIFECYCLE";

export class DeclaredPackageLifecycleError extends Error {
  readonly code: DeclaredPackageLifecycleErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: DeclaredPackageLifecycleErrorCode,
    message: string,
    context: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DeclaredPackageLifecycleError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareObservedAt(
  left: Pick<DeclaredPackageLifecycleEvent, "observedAt" | "eventKey">,
  right: Pick<DeclaredPackageLifecycleEvent, "observedAt" | "eventKey">,
): number {
  return compareText(left.observedAt, right.observedAt)
    || compareText(left.eventKey, right.eventKey);
}

function earliestObservedEvent<T extends DeclaredPackageLifecycleEvent>(
  events: readonly T[],
): T | null {
  return events.length > 0
    ? events.slice().sort(compareObservedAt)[0]
    : null;
}

function normalizeContents(
  contents: readonly DeclaredPackageLine[],
  eventKey: string,
): readonly DeclaredPackageLine[] {
  const seenIds = new Set<number>();
  const normalized = contents.map((line) => {
    if (seenIds.has(line.wmsShipmentItemId)) {
      throw new DeclaredPackageLifecycleError(
        "DUPLICATE_PACKAGE_LINE",
        `Package lifecycle event ${eventKey} repeats WMS shipment item ${line.wmsShipmentItemId}`,
        { eventKey, wmsShipmentItemId: line.wmsShipmentItemId },
      );
    }
    seenIds.add(line.wmsShipmentItemId);
    return Object.freeze({
      wmsShipmentItemId: line.wmsShipmentItemId,
      quantity: line.quantity,
    });
  });

  normalized.sort((left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId);
  return Object.freeze(normalized);
}

function deduplicateEvents(
  events: readonly DeclaredPackageLifecycleEvent[],
): readonly DeclaredPackageLifecycleEvent[] {
  const eventByKey = new Map<string, DeclaredPackageLifecycleEvent>();
  const canonicalByKey = new Map<string, string>();

  for (const event of events) {
    const canonical = canonicalJson(event);
    const priorCanonical = canonicalByKey.get(event.eventKey);
    if (priorCanonical !== undefined && priorCanonical !== canonical) {
      throw new DeclaredPackageLifecycleError(
        "CONFLICTING_EVENT_REPLAY",
        `Package lifecycle event key ${event.eventKey} was replayed with different evidence`,
        { eventKey: event.eventKey },
      );
    }
    if (priorCanonical === undefined) {
      eventByKey.set(event.eventKey, event);
      canonicalByKey.set(event.eventKey, canonical);
    }
  }

  return Object.freeze([...eventByKey.values()].sort(compareObservedAt));
}

function resolveTrackingNumber(
  events: readonly DeclaredPackageLifecycleEvent[],
  provider: string,
  providerPhysicalShipmentId: string,
): string | null {
  const trackingNumbers = new Set(
    events.flatMap((event) => (
      event.kind === "outbound_label_observed" || event.kind === "outbound_label_reprinted"
        ? [event.trackingNumber]
        : []
    )),
  );
  if (trackingNumbers.size > 1) {
    throw new DeclaredPackageLifecycleError(
      "CONFLICTING_PROVIDER_IDENTITY",
      "One provider physical shipment was observed with multiple tracking identities",
      {
        provider,
        providerPhysicalShipmentId,
        trackingNumbers: [...trackingNumbers].sort(),
      },
    );
  }
  return [...trackingNumbers][0] ?? null;
}

interface ContentSnapshot {
  readonly eventKey: string;
  readonly observedAt: string;
  readonly source: "provider" | "operator" | "system";
  readonly evidenceStatus: DeclaredPackageContentsEvidenceStatus;
  readonly contents: readonly DeclaredPackageLine[] | null;
  readonly fingerprint: string | null;
}

interface ContentsTimelineProjection {
  readonly status: DeclaredPackageContentsStatus;
  readonly observedEvidenceStatuses: readonly DeclaredPackageContentsEvidenceStatus[];
  readonly activeEvidenceStatuses: readonly DeclaredPackageContentsEvidenceStatus[];
  readonly contents: readonly DeclaredPackageLine[] | null;
  readonly authorityObservedAt: string | null;

}

function invalidContentResolution(
  attestationEventKey: string,
  resolvesEventKey: string,
  reason:
    | "already_resolved"
    | "authoritative_evidence_not_replaceable"
    | "duplicate_reference"
    | "not_prior_content_evidence",
): never {
  throw new DeclaredPackageLifecycleError(
    "INVALID_CONTENT_RESOLUTION",
    `Contents attestation ${attestationEventKey} cannot resolve ${resolvesEventKey}`,
    { attestationEventKey, resolvesEventKey, reason },
  );
}

function projectContentsTimeline(
  events: readonly DeclaredPackageLifecycleEvent[],
): ContentsTimelineProjection {
  const activeSnapshots = new Map<string, ContentSnapshot>();
  const resolvedEventKeys = new Set<string>();
  const observedEvidenceStatuses = new Set<DeclaredPackageContentsEvidenceStatus>();
  const fingerprintCounts = new Map<string, number>();
  let unresolvedNonAuthoritativeCount = 0;

  const removeActiveSnapshot = (
    snapshot: ContentSnapshot,
  ): void => {
    activeSnapshots.delete(snapshot.eventKey);
    if (snapshot.fingerprint === null) {
      unresolvedNonAuthoritativeCount -= 1;
      return;
    }
    const nextCount = (fingerprintCounts.get(snapshot.fingerprint) ?? 0) - 1;
    if (nextCount <= 0) {
      fingerprintCounts.delete(snapshot.fingerprint);
    } else {
      fingerprintCounts.set(snapshot.fingerprint, nextCount);
    }
  };

  const addActiveSnapshot = (
    snapshot: ContentSnapshot,
  ): void => {
    activeSnapshots.set(snapshot.eventKey, snapshot);
    if (snapshot.fingerprint === null) {
      unresolvedNonAuthoritativeCount += 1;
      return;
    }
    fingerprintCounts.set(
      snapshot.fingerprint,
      (fingerprintCounts.get(snapshot.fingerprint) ?? 0) + 1,
    );
  };

  const currentStatus = (): DeclaredPackageContentsStatus => {
    if (fingerprintCounts.size > 1) return "conflicting";
    if (unresolvedNonAuthoritativeCount > 0) return "unknown";
    if (fingerprintCounts.size === 1) return "authoritative";
    return "unknown";
  };

  for (const event of events) {
    if (event.kind === "outbound_label_observed") {
      observedEvidenceStatuses.add(event.contentsEvidence.status);

      let contents: readonly DeclaredPackageLine[] | null = null;
      if (event.contentsEvidence.status === "authoritative") {
        contents = normalizeContents(event.contentsEvidence.lines, event.eventKey);
      } else if (event.contentsEvidence.status === "mixed") {
        normalizeContents(event.contentsEvidence.recognizedLines, event.eventKey);
      }
      addActiveSnapshot({
        eventKey: event.eventKey,
        observedAt: event.observedAt,
        source: "provider",
        evidenceStatus: event.contentsEvidence.status,
        contents,
        fingerprint: contents === null ? null : sha256(canonicalJson(contents)),
      });
    } else if (event.kind === "package_contents_attested") {
      const uniqueReferences = new Set<string>();
      for (const resolvesEventKey of event.resolvesEventKeys) {
        if (uniqueReferences.has(resolvesEventKey)) {
          invalidContentResolution(
            event.eventKey,
            resolvesEventKey,
            "duplicate_reference",
          );
        }
        uniqueReferences.add(resolvesEventKey);
        if (resolvedEventKeys.has(resolvesEventKey)) {
          invalidContentResolution(
            event.eventKey,
            resolvesEventKey,
            "already_resolved",
          );
        }
        const resolvedSnapshot = activeSnapshots.get(resolvesEventKey);
        if (resolvedSnapshot === undefined
          || compareText(resolvedSnapshot.observedAt, event.observedAt) >= 0) {
          invalidContentResolution(
            event.eventKey,
            resolvesEventKey,
            "not_prior_content_evidence",
          );
        }
        if (resolvedSnapshot.fingerprint !== null) {
          invalidContentResolution(
            event.eventKey,
            resolvesEventKey,
            "authoritative_evidence_not_replaceable",
          );
        }
        removeActiveSnapshot(resolvedSnapshot);
        resolvedEventKeys.add(resolvesEventKey);
      }

      const contents = normalizeContents(event.contents, event.eventKey);
      addActiveSnapshot({
        eventKey: event.eventKey,
        observedAt: event.observedAt,
        source: event.authorization === "system_recovered" ? "system" : "operator",
        evidenceStatus: "authoritative",
        contents,
        fingerprint: sha256(canonicalJson(contents)),
      });
    }
  }

  const active = [...activeSnapshots.values()];
  const status = currentStatus();
  const activeEvidenceStatuses = Object.freeze(
    [...new Set(active
      .filter((snapshot) => snapshot.source === "provider")
      .map((snapshot) => snapshot.evidenceStatus))]
      .sort(),
  );
  const authoritativeSnapshots = active
    .filter((snapshot) => snapshot.fingerprint !== null)
    .sort((left, right) => (
      compareText(left.observedAt, right.observedAt)
      || compareText(left.eventKey, right.eventKey)
    ));
  const authoritativeSnapshot = status === "authoritative"
    ? authoritativeSnapshots[0] ?? null
    : null;

  return {
    status,
    observedEvidenceStatuses: Object.freeze([...observedEvidenceStatuses].sort()),
    activeEvidenceStatuses,
    contents: authoritativeSnapshot?.contents ?? null,
    authorityObservedAt: authoritativeSnapshot?.observedAt ?? null,
  };
}

const CONTENTS_REVIEW_REASON_BY_EVIDENCE_STATUS: Readonly<Record<
  DeclaredPackageContentsEvidenceStatus,
  DeclaredPackageReviewReason | null
>> = Object.freeze({
  authoritative: null,
  omitted: "package_contents_omitted",
  empty: "package_contents_empty",
  unrecognized: "package_contents_unrecognized",
  malformed: "package_contents_malformed",
  mixed: "package_contents_mixed",
});

function resolveUniqueProviderOccurredAt(
  events: readonly {
    eventKey: string;
    providerOccurredAt: string | null;
  }[],
  fact: "label_issuance" | "label_void",
): string | null {
  const values = new Set(events.flatMap((event) => (
    event.providerOccurredAt === null ? [] : [event.providerOccurredAt]
  )));
  if (values.size > 1) {
    throw new DeclaredPackageLifecycleError(
      "CONFLICTING_PROVIDER_IDENTITY",
      `One provider label has conflicting ${fact} occurrence times`,
      {
        fact,
        providerOccurredAtValues: [...values].sort(compareText),
        eventKeys: events.map((event) => event.eventKey).sort(),
      },
    );
  }
  return [...values][0] ?? null;
}

function earliestProviderOccurredAt(
  events: readonly { providerOccurredAt: string | null }[],
): string | null {
  const values = events
    .flatMap((event) => (
      event.providerOccurredAt === null ? [] : [event.providerOccurredAt]
    ))
    .sort(compareText);
  return values[0] ?? null;
}

function compareTimestamps(left: string, right: string): number {
  return compareText(left, right);
}

/**
 * Projects independent business, label, correction, and carrier facts for one
 * provider-declared package. It performs no I/O and reads no clock, allowing
 * webhook replay and out-of-order delivery to produce the same projection.
 *
 * Callers must authenticate provider evidence and authorize content-attestation
 * actors before invoking this projector. The actor string is audit evidence,
 * not an authorization check.
 * Cross-package operations such as relabel transfer, Split Ship allocation,
 * and replacement classification are intentionally outside this aggregate.
 */
export function projectDeclaredPackageLifecycle(
  input: DeclaredPackageLifecycleInput,
): DeclaredPackageLifecycleProjection {
  const parsed = declaredPackageLifecycleInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DeclaredPackageLifecycleError(
      "INVALID_PACKAGE_LIFECYCLE",
      "Declared package lifecycle evidence failed validation",
      { issues: parsed.error.issues },
    );
  }

  const provider = parsed.data.provider;
  const providerPhysicalShipmentId = parsed.data.providerPhysicalShipmentId;
  const events = deduplicateEvents(parsed.data.events);
  const trackingNumber = resolveTrackingNumber(
    events,
    provider,
    providerPhysicalShipmentId,
  );

  const labelObservations = events.filter(
    (event): event is z.infer<typeof outboundLabelObservedEventSchema> => (
      event.kind === "outbound_label_observed"
    ),
  );
  const voids = events.filter(
    (event): event is z.infer<typeof outboundLabelVoidedEventSchema> => (
      event.kind === "outbound_label_voided"
    ),
  );
  const reprints = events.filter(
    (event): event is z.infer<typeof outboundLabelReprintedEventSchema> => (
      event.kind === "outbound_label_reprinted"
    ),
  );
  const carrierEvents = events.filter(
    (event): event is z.infer<typeof carrierPossessionConfirmedEventSchema> => (
      event.kind === "carrier_possession_confirmed"
    ),
  );

  const firstLabelObservation = earliestObservedEvent(labelObservations);
  const firstVoidObservation = earliestObservedEvent(voids);
  const firstCarrierObservation = earliestObservedEvent(carrierEvents);
  const labelProviderOccurredAt = resolveUniqueProviderOccurredAt(
    labelObservations,
    "label_issuance",
  );
  const labelVoidedProviderOccurredAt = resolveUniqueProviderOccurredAt(
    voids,
    "label_void",
  );
  const carrierPossessionProviderOccurredAt = earliestProviderOccurredAt(
    carrierEvents,
  );
  const labelFirstObservedAt = firstLabelObservation?.observedAt ?? null;
  const labelVoidFirstObservedAt = firstVoidObservation?.observedAt ?? null;
  const carrierPossessionFirstObservedAt = firstCarrierObservation?.observedAt ?? null;
  const contents = projectContentsTimeline(events);
  const reviewReasons = new Set<DeclaredPackageReviewReason>();
  const invalidProviderChronology = labelProviderOccurredAt !== null
    && labelVoidedProviderOccurredAt !== null
    && compareTimestamps(
      labelVoidedProviderOccurredAt,
      labelProviderOccurredAt,
    ) < 0;

  let labelStatus: DeclaredPackageLabelStatus = labelFirstObservedAt === null
    ? "unknown"
    : "active";
  if (labelVoidFirstObservedAt !== null) {
    labelStatus = "voided";
    if (labelFirstObservedAt === null) {
      reviewReasons.add("void_without_label_observation");
    }
  }
  if (reprints.length > 0 && labelFirstObservedAt === null) {
    reviewReasons.add("reprint_without_label_observation");
  }
  if (invalidProviderChronology) {
    reviewReasons.add("provider_void_precedes_provider_label_issuance");
  }

  if (
    contents.status === "unknown"
    && (labelFirstObservedAt !== null || carrierPossessionFirstObservedAt !== null)
    && contents.activeEvidenceStatuses.length === 0
  ) {
    reviewReasons.add("package_contents_not_observed");
  }
  for (const evidenceStatus of contents.activeEvidenceStatuses) {
    const reason = CONTENTS_REVIEW_REASON_BY_EVIDENCE_STATUS[evidenceStatus];
    if (reason !== null) {
      reviewReasons.add(reason);
    }
  }
  if (contents.status === "conflicting") {
    reviewReasons.add("conflicting_package_contents");
  }
  if (carrierPossessionFirstObservedAt !== null && labelFirstObservedAt === null) {
    reviewReasons.add("carrier_possession_without_label_observation");
  }
  if (
    carrierPossessionFirstObservedAt !== null
    && contents.status !== "authoritative"
  ) {
    reviewReasons.add("carrier_possession_without_authoritative_contents");
  }

  let disposition: DeclaredPackageDisposition =
    carrierPossessionFirstObservedAt === null ? "not_dispatched" : "outbound";
  if (
    carrierPossessionFirstObservedAt !== null
    && labelVoidFirstObservedAt !== null
  ) {
    if (
      carrierPossessionProviderOccurredAt === null
      || labelVoidedProviderOccurredAt === null
    ) {
      disposition = "review";
      reviewReasons.add("void_carrier_order_unproven");
    } else {
      const order = compareTimestamps(
        labelVoidedProviderOccurredAt,
        carrierPossessionProviderOccurredAt,
      );
      if (order < 0) {
        disposition = "return_to_sender_expected";
      } else if (order === 0) {
        disposition = "review";
        reviewReasons.add("simultaneous_void_and_carrier_possession");
      } else {
        reviewReasons.add("void_after_carrier_possession");
      }
    }
  }

  const businessShipmentRecognizedAt = labelFirstObservedAt;
  const businessStatus: DeclaredPackageBusinessStatus =
    businessShipmentRecognizedAt === null ? "not_shipped" : "shipped";
  const currentAutomationAuthority = labelFirstObservedAt !== null
    && contents.status === "authoritative"
    && !invalidProviderChronology
    && reviewReasons.size === 0;

  let correctionStatus: DeclaredPackageCorrectionStatus = "unavailable";
  if (carrierPossessionFirstObservedAt !== null) {
    correctionStatus = "carrier_locked";
  } else if (
    invalidProviderChronology
    || (labelFirstObservedAt !== null && !currentAutomationAuthority)
  ) {
    correctionStatus = "review";
  } else if (labelStatus === "voided") {
    correctionStatus = currentAutomationAuthority ? "awaiting_relabel" : "review";
  } else if (labelStatus === "active" && currentAutomationAuthority) {
    correctionStatus = "open";
  } else if (labelStatus === "active") {
    correctionStatus = "review";
  }

  const frozenReviewReasons = Object.freeze(
    [...reviewReasons].sort(),
  ) as readonly DeclaredPackageReviewReason[];
  const carrierStatus: DeclaredPackageCarrierStatus =
    carrierPossessionFirstObservedAt === null
      ? "not_confirmed"
      : "possession_confirmed";
  const commandPlanningAuthority = currentAutomationAuthority
    && businessShipmentRecognizedAt !== null;
  const stateProjection = {
    contractVersion: 1 as const,
    provider,
    providerPhysicalShipmentId,
    trackingNumber,
    labelStatus,
    labelProviderOccurredAt,
    labelFirstObservedAt,
    labelVoidedProviderOccurredAt,
    labelVoidFirstObservedAt,
    contentsStatus: contents.status,
    observedContentsEvidenceStatuses: contents.observedEvidenceStatuses,
    activeContentsEvidenceStatuses: contents.activeEvidenceStatuses,
    authoritativeContents: contents.contents,
    contentsAuthorityObservedAt: contents.authorityObservedAt,
    businessStatus,
    businessShipmentRecognizedAt,
    businessShipmentProviderOccurredAt: businessShipmentRecognizedAt === null
      ? null
      : labelProviderOccurredAt,
    currentAutomationAuthority,
    reconciliationStatus: frozenReviewReasons.length === 0
      ? "clear" as const
      : "review" as const,
    correctionStatus,
    carrierStatus,
    carrierPossessionProviderOccurredAt,
    carrierPossessionFirstObservedAt,
    topologyLockedProviderAt: carrierPossessionProviderOccurredAt,
    topologyLockRecognizedAt: carrierPossessionFirstObservedAt,
    disposition,
    commercialFulfillmentPostingEligible: commandPlanningAuthority,
    inventoryPostingEligible: commandPlanningAuthority,
    activeTrackingProjectionEligible: commandPlanningAuthority
      && labelStatus === "active"
      && carrierStatus === "not_confirmed",
    voidTrackingProjectionRequired: trackingNumber !== null
      && labelStatus === "voided"
      && carrierStatus === "not_confirmed",
    carrierTrackingProjectionRequired: trackingNumber !== null
      && carrierStatus === "possession_confirmed",
    notificationCandidateEligible: commandPlanningAuthority
      && labelStatus === "active",
    notificationProjectionReconciliationRequired: businessShipmentRecognizedAt !== null
      && (labelStatus === "voided" || !currentAutomationAuthority),
    reviewReasons: frozenReviewReasons,
  };
  const evidenceHash = sha256(canonicalJson({
    provider,
    providerPhysicalShipmentId,
    events,
  }));

  return Object.freeze({
    ...stateProjection,
    appliedEventCount: events.length,
    evidenceHash,
    stateHash: sha256(canonicalJson(stateProjection)),
  });
}
